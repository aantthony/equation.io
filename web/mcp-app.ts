import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import { encodePayload } from '../lib/link.ts';
import { setHostTheme } from './theme.ts';

interface GraphEditor {
  getRows(): string[];
  setRows(rows: string[]): void;
  onChange(callback: (rows: string[]) => void): void;
  onEdit(callback: () => void): void;
  setVisible(visible: boolean): void;
  flush(): void;
  dispose(): void;
}

interface WidgetState {
  privateContent?: { source?: string; equations?: unknown };
}

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(row => typeof row === 'string');

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
    open.href = `${origin}/g/${encodePayload(rows)}`;
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
    reset.hidden = !original || JSON.stringify(editor.getRows()) === source;
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

  async function publish(rows: string[]) {
    link(rows);
    if (!connected || !hasResult) return;
    const publishedSource = source;
    try {
      openai?.setWidgetState?.({ privateContent: { source, equations: rows } });
    } catch {
      /* Persistence may be unavailable; the live graph still works. */
    }
    try {
      await app.updateModelContext({ structuredContent: { equations: rows, share_url: open.href } });
      if (!closing && hasResult && source === publishedSource) status.textContent = '';
    } catch {
      if (!closing && hasResult && source === publishedSource) status.textContent = 'Edits could not sync';
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
    source = JSON.stringify(rows);
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
        editor.dispose();
        await publish(rows);
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
