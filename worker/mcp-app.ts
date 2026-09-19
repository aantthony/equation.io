/** Version this URI when the embedded UI contract changes; hosts cache it. */
export const GRAPH_UI_URI = 'ui://equation/graph-v2.html';
export const GRAPH_UI_MIME = 'text/html;profile=mcp-app';
export const graphResource = {
  uri: GRAPH_UI_URI,
  name: 'graph',
  title: 'Interactive equation.io graph',
  mimeType: GRAPH_UI_MIME,
};

/** The iframe has a host-owned origin. Resolve built assets against ours. */
export function graphResourceContents(html: string, origin: string) {
  const escaped = origin.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return {
    ...graphResource,
    text: html
      .replace('__EQUATION_ORIGIN__', escaped)
      .replace(/\b(src|href)="\/(?!\/)/g, `$1="${escaped}/`),
    _meta: {
      ui: {
        prefersBorder: true,
        // Let the host choose its sandbox origin; domain formats are host-specific.
        csp: { resourceDomains: [origin, 'blob:'], connectDomains: [] },
      },
      // ChatGPT's supported alias preserves its unique submission origin
      // without imposing a ChatGPT domain format on Claude's sandbox.
      'openai/widgetDomain': origin,
      'openai/widgetDescription': 'Interactive 2D and 3D graph with editable equations, parameter sliders, pan and zoom. Edits update the conversation context. Open in equation.io to share the current graph.',
    },
  };
}
