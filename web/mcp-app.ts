import { App, applyDocumentTheme, applyHostStyleVariables, type McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { encodePayload } from '../lib/link.ts';
import { setHostTheme } from './theme.ts';

interface GraphEditor {
  getRows(): string[];
  setRows(rows: string[]): void;
  onChange(callback: (rows: string[]) => void): void;
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
  return Object.assign({}, previous, Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined))) as T;
}

export async function connectGraphApp(editor: GraphEditor) {
  const app = new App({ name: 'equation.io', version: '1.0.0' },
    { availableDisplayModes: ['inline', 'fullscreen'] }, { autoResize: false });
  const status = document.getElementById('app-status')!;
  const open = document.getElementById('app-open') as HTMLAnchorElement;
  const expand = document.getElementById('app-expand') as HTMLButtonElement;
  const configuredOrigin = document.querySelector<HTMLMetaElement>('meta[name="equation-origin"]')!.content;
  const origin = configuredOrigin === '__EQUATION_ORIGIN__' ? location.origin : new URL(configuredOrigin).origin;
  // Optional ChatGPT persistence; all communication uses the standard bridge.
  const openai = (window as Window & { openai?: {
    widgetState?: WidgetState;
    setWidgetState?: (state: WidgetState) => void;
  } }).openai;
  const restored = openai?.widgetState?.privateContent;
  let source = '';
  let connected = false;
  let hasResult = false;
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

  async function publish(rows: string[]) {
    link(rows);
    if (!connected || !hasResult) return;
    try {
      openai?.setWidgetState?.({ privateContent: { source, equations: rows } });
    } catch { /* Persistence may be unavailable; the live graph still works. */ }
    try {
      await app.updateModelContext({ structuredContent: { equations: rows, share_url: open.href } });
      status.textContent = 'Graph ready';
    } catch {
      status.textContent = 'Graph ready · edits could not sync';
    }
  }

  function hostContext(update: McpUiHostContext) {
    if (closing) return;
    const styles = update.styles ? {
      ...mergeDefined(context.styles, update.styles),
      variables: mergeDefined(context.styles?.variables, update.styles.variables),
      css: mergeDefined(context.styles?.css, update.styles.css),
    } : context.styles;
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
        '--page-bg': '--color-background-primary', '--panel-bg': '--color-background-secondary',
        '--text': '--color-text-primary', '--muted': '--color-text-secondary',
        '--summary': '--color-text-secondary', '--info': '--color-text-secondary',
        '--panel-border': '--color-border-primary', '--accent': '--color-text-info',
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
  app.ontoolresult = result => {
    if (closing) return;
    if (result.isError) {
      status.textContent = 'Could not load this graph. Ask to try again.';
      return;
    }
    const data = result.structuredContent as Record<string, unknown> | undefined;
    const rows = Array.isArray(data?.rows)
      ? data.rows.map((row: unknown) => row && typeof row === 'object' && 'text' in row ? row.text : null)
      : null;
    if (!strings(rows)) {
      status.textContent = 'No graph equations received.';
      return;
    }
    source = JSON.stringify(rows);
    const wanted = restored?.source === source && strings(restored.equations) ? restored.equations : rows;
    editor.setRows(wanted);
    hasResult = true;
    link(wanted);
    status.textContent = data?.valid === false ? 'Check the highlighted equations' : 'Graph ready';
    if (wanted !== rows) void publish(wanted);
  };
  app.ontoolcancelled = () => { if (!closing) status.textContent = 'Graph request cancelled.'; };
  editor.onChange(rows => { if (!closing) void publish(rows); });

  open.addEventListener('click', event => {
    link(editor.getRows()); // Include edits still waiting for the throttled callback.
    if (connected && app.getHostCapabilities()?.openLinks) {
      event.preventDefault();
      void app.openLink({ url: open.href }).catch(() => {
        status.textContent = 'Could not open the link. Try again.';
      });
    }
  }, { signal: events.signal });
  expand.addEventListener('click', async () => {
    const mode = context.displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
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
  }, { signal: events.signal });
  app.onteardown = () => teardown ??= (async () => {
    closing = true;
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
  })();
  await app.connect();
  connected = true;
  hostContext(app.getHostContext() ?? {});
}
