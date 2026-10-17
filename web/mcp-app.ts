import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import { encodePayload, linkRows } from '../lib/link.ts';
import { setHostTheme } from './theme.ts';

interface GraphEditor {
  getRows(): string[];
  setRows(rows: string[]): void;
  /** Replace the graph as one undoable step. */
  openRows(rows: string[]): void;
  onChange(callback: (rows: string[]) => void): void;
  onEdit(callback: () => void): void;
  setVisible(visible: boolean): void;
  /** Bring the equation editor out from its chip. */
  showPanel(): void;
  /** A fresh frame of the graph, longest edge at most maxEdge pixels. */
  still(maxEdge: number): HTMLCanvasElement;
  /** Resolves once background curve traces have landed. */
  traced(): Promise<void>;
  flush(): void;
  dispose(): void;
}

interface WidgetState {
  privateContent?: { source?: string; equations?: unknown };
}

// Matches voice mode's look_at_graph: enough to read labels and shapes.
const SNAPSHOT_EDGE = 1280;
// The picture follows the equations once edits pause: a slider drag sends
// rows on every save tick, but encoding a frame each time would stutter it.
const SNAPSHOT_DELAY_MS = 600;
// A trace that never lands must not hold the picture back for good.
const TRACE_WAIT_MS = 3000;

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(row => typeof row === 'string');

/** The app-relative URL a ChatGPT deep link opened the app at, if any. */
const deepLinkUrl = (context: McpUiHostContext): string | undefined => {
  const link = (context as Record<string, unknown>)['openai/deepLink'];
  return link && typeof link === 'object' && typeof (link as { url?: unknown }).url === 'string'
    ? (link as { url: string }).url
    : undefined;
};

// SDK validation can materialize omitted optional keys as undefined. They
// are not resets: host-context notifications contain only changed fields.
function mergeDefined<T extends object>(previous: T | undefined, update: T | undefined): T | undefined {
  if (!update) return previous;
  return Object.assign(
    {},
    previous,
    Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)),
  ) as T;
}

export async function connectGraphApp(editor: GraphEditor) {
  const app = new App(
    { name: 'equation.io', version: '1.0.0' },
    { availableDisplayModes: ['inline', 'fullscreen'] },
    { autoResize: false },
  );
  const status = document.getElementById('app-status')!;
  const open = document.getElementById('app-open') as HTMLAnchorElement;
  const expand = document.getElementById('app-expand') as HTMLButtonElement;
  const reset = document.getElementById('app-reset') as HTMLButtonElement;
  const configuredOrigin = document.querySelector<HTMLMetaElement>('meta[name="equation-origin"]')!.content;
  const origin = configuredOrigin === '__EQUATION_ORIGIN__' ? location.origin : new URL(configuredOrigin).origin;
  // Optional ChatGPT persistence; all communication uses the standard bridge.
  const openai = (
    window as Window & {
      openai?: {
        widgetState?: WidgetState;
        setWidgetState?: (state: WidgetState) => void;
      };
    }
  ).openai;
  const restored = openai?.widgetState?.privateContent;
  let source = '';
  let connected = false;
  let hasResult = false;
  let inputSource: string | undefined;
  let previewSource: string | undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingPreview: string[] | undefined;
  let context: McpUiHostContext = {};
  let closing = false;
  // Opened from ChatGPT's sidebar or a conversation panel (an empty tool
  // result), rather than to show a graph the model made.
  let launched = false;
  let appliedDeepLink: string | undefined;
  // The rows the model already knows, as the JSON of their non-blank text:
  // its own tool result, or [] for a blank calculator. undefined for a graph
  // it has never seen, such as a deep link. Only a graph that differs needs
  // a picture.
  let seen: string | undefined;
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  let published: string[] = [];
  let changingMode = false;
  let teardown: Promise<{}> | undefined;
  const events = new AbortController();
  let intersecting = true;
  const visibility = () => editor.setVisible(intersecting && !document.hidden);
  const observer = new IntersectionObserver(entries => {
    intersecting = entries.some(entry => entry.isIntersecting);
    visibility();
  });
  observer.observe(document.getElementById('gl')!);
  document.addEventListener('visibilitychange', visibility, { signal: events.signal });
  visibility();
  const toolbar = document.getElementById('app-toolbar')!;
  const toolbarSize = new ResizeObserver(() => {
    document.documentElement.style.setProperty('--app-toolbar-height', `${toolbar.getBoundingClientRect().height}px`);
  });
  toolbarSize.observe(toolbar);
  const fonts = document.createElement('style');
  fonts.id = 'equation-host-fonts';
  document.head.append(fonts);

  function link(rows: string[]) {
    const payload = encodePayload(rows);
    open.href = payload ? `${origin}/g/${payload}` : `${origin}/`;
  }

  function originalRows(): string[] | undefined {
    if (!hasResult || !source) return;
    try {
      const rows = JSON.parse(source);
      return strings(rows) ? rows : undefined;
    } catch {
      return;
    }
  }

  function syncReset() {
    const original = originalRows();
    // A blank calculator has nothing to go back to.
    reset.hidden = !original?.length || JSON.stringify(editor.getRows()) === source;
  }

  function resetGraph() {
    const rows = originalRows();
    if (closing || !rows) return;
    // Always rebuild so pan, zoom, and the animation clock return with the rows.
    editor.setRows(rows);
    link(rows);
    syncReset();
    void publish(rows);
  }

  const wantsPicture = (rows: string[]) =>
    !!app.getHostCapabilities()?.updateModelContext?.image &&
    JSON.stringify(rows.map(row => row.trim()).filter(Boolean)) !== seen;

  // The graph as the user left it, for hosts that take images as model
  // context: the model can then see the picture, not just the equations.
  // ChatGPT shows each block as a removable attachment under this title.
  // Not while off-screen: drawing a frame would undo the render pause, and
  // the equations still describe the graph. Teardown draws its last frame
  // regardless; the renderer is released straight after.
  function snapshot(): { type: 'image'; data: string; mimeType: string; _meta: Record<string, unknown> } | undefined {
    if (!closing && (!intersecting || document.hidden)) return;
    try {
      const url = editor.still(SNAPSHOT_EDGE).toDataURL('image/jpeg', 0.85);
      const data = url.slice(url.indexOf(',') + 1);
      if (!data) return;
      const title = seen === undefined ? 'Graph' : 'Edited graph';
      return { type: 'image', data, mimeType: 'image/jpeg', _meta: { 'openai/title': title } };
    } catch {
      return; // The equations and share link still describe the graph.
    }
  }

  // Each update replaces the last, so the picture goes out again with the
  // rows it shows, after edits pause and background traces have landed.
  function schedulePicture() {
    clearTimeout(snapshotTimer);
    snapshotTimer = undefined;
    if (!wantsPicture(published)) return;
    const rows = published;
    snapshotTimer = setTimeout(async () => {
      await Promise.race([editor.traced(), new Promise(resolve => setTimeout(resolve, TRACE_WAIT_MS))]);
      if (closing || rows !== published) return;
      const image = snapshot();
      if (image) void publish(rows, image);
    }, SNAPSHOT_DELAY_MS);
  }

  async function publish(rows: string[], image?: ReturnType<typeof snapshot>) {
    link(rows);
    if (!connected || !hasResult) return;
    if (!image) {
      published = rows;
      if (!closing) schedulePicture();
    }
    const publishedSource = source;
    try {
      openai?.setWidgetState?.({ privateContent: { source, equations: rows } });
    } catch {
      /* Persistence may be unavailable; the live graph still works. */
    }
    // A message shown while this was in flight, such as a bad deep link, is
    // newer than this update and stays.
    const shown = status.textContent;
    const reports = () => !closing && hasResult && source === publishedSource && status.textContent === shown;
    try {
      await app.updateModelContext({
        ...(image && { content: [image] }),
        structuredContent: { equations: rows, share_url: open.href },
      });
      if (reports()) status.textContent = '';
    } catch {
      if (reports()) status.textContent = 'Edits could not sync';
    }
  }

  function hostContext(update: McpUiHostContext) {
    if (closing) return;
    const styles = update.styles
      ? {
          ...mergeDefined(context.styles, update.styles),
          variables: mergeDefined(context.styles?.variables, update.styles.variables),
          css: mergeDefined(context.styles?.css, update.styles.css),
        }
      : context.styles;
    context = mergeDefined(context, update)!;
    context.styles = styles;
    if (context.theme) {
      applyDocumentTheme(context.theme);
      setHostTheme(context.theme);
    }
    const root = document.documentElement;
    if (styles?.variables) {
      applyHostStyleVariables(styles.variables);
      for (const [name, value] of Object.entries(styles.variables)) {
        if (value === undefined) root.style.removeProperty(name);
      }
      const mapped: Record<string, string> = {
        '--page-bg': '--color-background-primary',
        '--panel-bg': '--color-background-secondary',
        '--text': '--color-text-primary',
        '--muted': '--color-text-secondary',
        '--summary': '--color-text-secondary',
        '--info': '--color-text-secondary',
        '--panel-border': '--color-border-primary',
        '--accent': '--color-text-info',
      };
      for (const [local, host] of Object.entries(mapped)) {
        const value = styles.variables[host as keyof typeof styles.variables];
        if (value !== undefined) root.style.setProperty(local, `var(${host})`);
        else root.style.removeProperty(local);
      }
    }
    if (styles?.css?.fonts !== undefined) fonts.textContent = styles.css.fonts;
    if (launched) openDeepLink(false);
    for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
      const inset = context.safeAreaInsets?.[edge];
      root.style.setProperty(`--host-safe-${edge}`, `${Number.isFinite(inset) ? Math.max(0, inset!) : 0}px`);
    }
    const nextMode = context.displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
    expand.hidden = !context.availableDisplayModes?.includes(nextMode);
    expand.textContent = context.displayMode === 'fullscreen' ? 'Collapse' : 'Expand';
    if (connected && context.displayMode !== 'fullscreen') {
      const dims = context.containerDimensions;
      const height = dims && 'height' in dims ? dims.height : Math.min(520, dims?.maxHeight ?? 520);
      void app.sendSizeChanged({ height }).catch(() => {});
    }
  }

  app.onhostcontextchanged = hostContext;
  // A deep link names the graph to open, and becomes the original that Reset
  // returns to. The model has not seen it, so it is published right away.
  // At launch it replaces the empty page, and edits saved in widget state for
  // it come back; once open it replaces the user's graph, which undo restores.
  // A link to a page with no graph opens a blank calculator.
  function openDeepLink(atLaunch: boolean): boolean {
    const url = deepLinkUrl(context);
    if (url === undefined || url === appliedDeepLink) return false;
    appliedDeepLink = url;
    const rows = linkRows(url);
    if (!rows) {
      status.textContent = 'Could not open that graph link.';
      return false;
    }
    status.textContent = '';
    if (!rows.length) {
      openBlank(atLaunch);
      return true;
    }
    source = JSON.stringify(rows);
    seen = undefined;
    const wanted = atLaunch && restored?.source === source && strings(restored.equations) ? restored.equations : rows;
    if (atLaunch) showRows(wanted);
    else editor.openRows(wanted);
    link(wanted);
    syncReset();
    void publish(wanted);
    return true;
  }

  /** An empty calculator with a line to type on, or the edits widget state
   *  kept for it. */
  function openBlank(atLaunch: boolean) {
    source = seen = '[]';
    const saved = atLaunch && restored?.source === source && strings(restored.equations) ? restored.equations : [];
    if (atLaunch) showRows(saved.length ? saved : ['']); // The line shows its hint.
    else editor.openRows([]);
    link(saved);
    syncReset();
    // A blank graph tells the model nothing new, unless it replaced one.
    if (saved.length || !atLaunch) void publish(saved);
  }
  function cancelPreview() {
    clearTimeout(previewTimer);
    previewTimer = undefined;
    pendingPreview = undefined;
  }
  function inputRows(args: Record<string, unknown> | undefined) {
    return strings(args?.equations) ? args.equations.map(row => row.trim()).filter(Boolean) : undefined;
  }
  function showRows(rows: string[]) {
    if (JSON.stringify(editor.getRows()) !== JSON.stringify(rows)) editor.setRows(rows);
    link(rows);
  }
  app.ontoolinputpartial = params => {
    if (closing) return;
    const rows = inputRows(params.arguments);
    if (!rows?.length) return;
    hasResult = false; // Streamed previews must not be persisted as confirmed results.
    inputSource = undefined;
    pendingPreview = rows;
    syncReset();
    status.textContent = 'Drawing graph…';
    // Coalesce token bursts. The editor already tolerates unfinished equations.
    if (previewTimer !== undefined) return;
    previewTimer = setTimeout(() => {
      const latest = pendingPreview!;
      cancelPreview();
      const key = JSON.stringify(latest);
      if (key !== previewSource) showRows(latest);
      previewSource = key;
    }, 32);
  };
  app.ontoolinput = params => {
    if (closing) return;
    cancelPreview();
    const rows = inputRows(params.arguments);
    if (!rows) return;
    const key = JSON.stringify(rows);
    // Hosts can replay complete input after its result. Keep confirmation,
    // validation feedback, and any user edits for that same graph.
    if (hasResult && key === source) return;
    hasResult = false;
    syncReset();
    if (key !== inputSource) {
      const wanted = restored?.source === key && strings(restored.equations) ? restored.equations : rows;
      showRows(wanted);
    }
    inputSource = key;
    previewSource = undefined;
    // Rendering is ready now. Result delivery is host-controlled and may
    // never happen, so it must not leave a permanent progress indicator.
    status.textContent = '';
  };
  app.ontoolresult = result => {
    if (closing) return;
    cancelPreview();
    previewSource = undefined;
    hasResult = false;
    if (result.isError) {
      // The rendered rows were only a preview of the failed input; leaving
      // them live would invite edits that never publish (hasResult stays false).
      showRows([]);
      inputSource = undefined;
      syncReset();
      status.textContent = 'Could not load this graph. Ask to try again.';
      return;
    }
    const data = result.structuredContent as Record<string, unknown> | undefined;
    const rows = Array.isArray(data?.rows)
      ? data.rows.map((row: unknown) => (row && typeof row === 'object' && 'text' in row ? row.text : null))
      : null;
    if (!strings(rows)) {
      inputSource = undefined;
      syncReset();
      status.textContent = 'No graph equations received.';
      return;
    }
    if (!rows.length) {
      // An entrypoint launch: an empty calculator, ready to type in.
      launched = true;
      inputSource = undefined;
      hasResult = true;
      status.textContent = '';
      editor.showPanel();
      if (!openDeepLink(true)) openBlank(true);
      return;
    }
    launched = false;
    source = seen = JSON.stringify(rows);
    // Matching results confirm the already-rendered graph without resetting
    // animation, undo history, or slider edits made while validation ran.
    const wanted =
      inputSource === source
        ? editor.getRows()
        : restored?.source === source && strings(restored.equations)
          ? restored.equations
          : rows;
    showRows(wanted);
    inputSource = undefined;
    hasResult = true;
    syncReset();
    link(wanted);
    status.textContent = data?.valid === false ? 'Check the highlighted equations' : '';
    if (JSON.stringify(wanted) !== source) void publish(wanted);
  };
  app.ontoolcancelled = () => {
    if (closing) return;
    cancelPreview();
    hasResult = false;
    inputSource = previewSource = undefined;
    syncReset();
    status.textContent = 'Graph request cancelled.';
  };
  editor.onEdit(() => {
    if (!closing) syncReset();
  });
  editor.onChange(rows => {
    if (!closing) void publish(rows);
  });

  reset.addEventListener('click', resetGraph, { signal: events.signal });
  open.addEventListener(
    'click',
    event => {
      link(editor.getRows()); // Include edits still waiting for the throttled callback.
      if (connected && app.getHostCapabilities()?.openLinks) {
        event.preventDefault();
        void app.openLink({ url: open.href }).catch(() => {
          status.textContent = 'Could not open the link. Try again.';
        });
      }
    },
    { signal: events.signal },
  );
  async function requestMode(mode: 'inline' | 'fullscreen') {
    if (closing || !connected || changingMode || !context.availableDisplayModes?.includes(mode)) return;
    changingMode = true;
    expand.disabled = true;
    try {
      const result = await app.requestDisplayMode({ mode });
      hostContext({ displayMode: result.mode });
    } catch {
      status.textContent = 'Could not change display size.';
    } finally {
      changingMode = false;
      expand.disabled = false;
    }
  }
  expand.addEventListener(
    'click',
    () => {
      void requestMode(context.displayMode === 'fullscreen' ? 'inline' : 'fullscreen');
    },
    { signal: events.signal },
  );
  document.addEventListener(
    'keydown',
    event => {
      if (event.key === 'Escape' && context.displayMode === 'fullscreen') {
        void requestMode('inline');
      }
    },
    { signal: events.signal },
  );
  app.onteardown = () =>
    (teardown ??= (async () => {
      closing = true;
      cancelPreview();
      events.abort();
      observer.disconnect();
      toolbarSize.disconnect();
      editor.onChange(() => {});
      try {
        editor.flush();
        const rows = editor.getRows();
        clearTimeout(snapshotTimer);
        // Take the picture while the renderer still exists, and only of a
        // graph the model hasn't seen: an untouched one needs none.
        const image = connected && hasResult && wantsPicture(rows) ? snapshot() : undefined;
        editor.dispose();
        await publish(rows, image);
      } finally {
        editor.dispose();
        connected = false;
      }
      return {};
    })());
  await app.connect();
  connected = true;
  hostContext(app.getHostContext() ?? {});
}
