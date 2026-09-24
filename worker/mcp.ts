/**
 * Stateless MCP server (Streamable HTTP, JSON responses) at /mcp.
 *
 * encode_graph_url builds a shareable link from equation rows,
 * validates every row through the app's own parser; decode_graph_url decodes an existing link
 * back into rows so an assistant can edit a user's graph. show_graph adds
 * the interactive MCP Apps UI to the same validation/link result. The full syntax
 * manual is the "syntax" resource — served from the same /llms.txt asset the
 * site publishes — because a manual inlined in the tool description gets
 * truncated by clients, and truncation cuts exactly the advanced material
 * (domain(), iter(), ODEs) that makes the grapher worth knowing.
 * No sessions, no SSE — each POST is a complete JSON-RPC exchange, which is
 * all these tools need and keeps the Worker stateless.
 */
import { dragAxes } from '../lib/drag.ts';
import { sliderForm } from '../lib/slider.ts';
import { definitionDependencies } from '../lib/defs.ts';
import { freeVars } from '../lib/expr.ts';
import { decodePayload, encodePayload } from '../lib/link.ts';
import { publicKind } from '../lib/plot.ts';
import { splitStatements } from '../lib/statements.ts';
import { analyze } from './graph.ts';
import { MAX_PLOTS, previewGap } from './og.ts';
import { GRAPH_UI_URI, graphResource, graphResourceContents } from './mcp-app.ts';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// Kept deliberately short: a client is known to truncate long tool
// descriptions (the old inline syntax manual was cut mid-sentence), so this
// names every capability and defers the actual syntax to the resource below.
const TOOLS = [
  {
    name: 'encode_graph_url',
    title: 'Create a graph link',
    annotations: { title: 'Create a graph link', readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    description: `Build an equation.io graph link, validating every row with the app's parser. Pass the COMPLETE graph in "equations": a flat array of strings, one equation or definition per string, in display order — when editing an existing graph (see decode_graph_url), include unchanged rows too.

Rows can be: equations and inequalities in x,y (curves, regions; z makes it 3D), bare expressions (scalar fields; complex plots via w), points (rows report "draggable"), parametric tuples in u,v — and definitions: "a = 2" (a draggable slider), "f(x) = x^3 - a x", coordinate fields like "r = sqrt(x^2+y^2)" for polar. t animates. Also derivatives d/dx, integrals int[a..b] f dx, sums sum[n=1..N], domain()/conformal()/iter() for complex plots, rgb()/hsl()/oklch() color fields, y' = … slope fields, random variables "X ~ Normal(m, s)"/"P(0<X<2)"/"E(X^2)", and "view(x = -5..5, y = -2..2)"/"camera(theta, phi)" framing rows. That is a menu, not the syntax: before your first non-trivial graph, read the "syntax" MCP resource (also at https://equation.io/llms.txt).

The result returns text and structured data only. "rows" gives each equation's validation result: status "ok" with its kind, or "error" with the parser message. The link is usable only once every row is "ok". Give users the share_url (it unfurls to a preview card in chat apps); url is the equivalent #-fragment form. "preview" and "preview_omits" describe the share link's simplified static preview (t = 0, 3D as wireframes), which draws less than the interactive app. No image is attached to the tool response.`,
    inputSchema: {
      type: 'object',
      properties: {
        equations: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Every equation in the graph, in display order. One equation or definition per string — do not join rows with ";" (inside quoted text a ";" is data, and kept).',
        },
      },
      required: ['equations'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        valid: { type: 'boolean' },
        url: { type: 'string', description: 'Graph URL using a #-fragment.' },
        share_url: { type: 'string', description: 'Shareable /g/ graph URL.' },
        preview: { type: 'string', description: 'Static preview availability and limitations.' },
        preview_omits: {
          type: 'array',
          items: {
            type: 'object',
            properties: { row: { type: 'string' }, why: { type: 'string' } },
            required: ['row', 'why'],
            additionalProperties: false,
          },
        },
        rows: {
          type: 'array',
          items: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  status: { type: 'string', enum: ['ok'] },
                  kind: { type: 'string' },
                  animated: { type: 'boolean' },
                  value: { type: 'string' },
                  note: { type: 'string' },
                  draggable: { type: 'boolean' },
                },
                required: ['text', 'status', 'kind'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  status: { type: 'string', enum: ['error'] },
                  error: { type: 'string' },
                },
                required: ['text', 'status', 'error'],
                additionalProperties: false,
              },
            ],
          },
        },
      },
      required: ['valid', 'url', 'share_url', 'preview', 'rows'],
      additionalProperties: false,
    },
  },
  {
    name: 'decode_graph_url',
    title: 'Read a graph link',
    annotations: { title: 'Read a graph link', readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    description:
      'Decode an equation.io link (either the #-fragment form or the /g/ share form) into its list of equation rows, so you can edit them and build a new link with encode_graph_url. The rows use the equation.io syntax documented in the "syntax" MCP resource (also at https://equation.io/llms.txt).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'An equation.io graph URL.' },
      },
      required: ['url'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        equations: { type: 'array', items: { type: 'string' } },
      },
      required: ['equations'],
      additionalProperties: false,
    },
  },
];

// Keep validation/link-only calls separate from rendering a new chat widget.
// Static share-card fields (`preview`, `preview_omits`) stay on encode_graph_url:
// the widget is the picture, and "not attached" reads as a missing graph.
const showGraphOutputProperties = Object.fromEntries(
  Object.entries(TOOLS[0].outputSchema.properties).filter(([key]) => key !== 'preview' && key !== 'preview_omits'),
);
const SHOW_GRAPH_TOOL = {
  ...TOOLS[0],
  name: 'show_graph',
  title: 'Show an interactive graph',
  annotations: { title: 'Show an interactive graph', readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  description:
    'Display an interactive equation.io graph inside the conversation, with editable equations, sliders, pan/zoom, and 3D rotation. Use when the user asks to see or explore a graph. Pass the COMPLETE graph as "equations", one equation or definition per string, preserving unchanged rows when editing. For a slider use "a = 2" then "y = a sin(x)". For advanced syntax read the "syntax" resource (https://equation.io/llms.txt). Returns per-row validation and share links; a row with status "error" is not drawn until its text is corrected and the graph resubmitted. Use encode_graph_url for validation or link-only requests (including share-link preview notes). In clients without UI support, provide share_url.',
  outputSchema: {
    ...TOOLS[0].outputSchema,
    properties: showGraphOutputProperties,
    required: ['valid', 'url', 'share_url', 'rows'],
  },
  _meta: { ui: { resourceUri: GRAPH_UI_URI } },
};

/**
 * The syntax manual as an MCP resource. Its uri is the real /llms.txt URL on
 * this origin, so even a client with no resource support can plainly fetch
 * it, and resources/read serves the same asset byte-for-byte — one document,
 * no drift.
 */
const syntaxResource = (origin: string) => ({
  uri: `${origin}/llms.txt`,
  name: 'syntax',
  title: 'Equation syntax reference',
  description:
    'The full equation language: operators and functions, every row type (curves, regions, scalar and vector fields, complex plots incl. domain coloring, conformal maps and fractals, ODEs, parametrics, 3D surfaces), definitions and sliders, polar coordinates, sums, derivatives — with paste-ready examples.',
  mimeType: 'text/markdown',
});

async function encodeGraphUrl(origin: string, args: Record<string, unknown>) {
  const equations = args.equations;
  if (!Array.isArray(equations) || !equations.every(e => typeof e === 'string')) {
    // Name what arrived, so a caller that guessed wrong fixes it in one retry
    // rather than probing. "rows" is the guess to expect: it reads naturally
    // and it is what this tool calls the per-equation results it returns.
    const got = Object.keys(args).filter(k => k !== 'equations');
    const hint = got.length ? ` Received ${got.map(k => `"${k}"`).join(', ')} instead.` : '';
    throw new Error(
      `encode_graph_url takes "equations": a flat array of strings, one per equation, e.g. ` +
        `{"equations": ["y = x^2", "y = sin(x)"]}.${hint}`,
    );
  }
  const texts = (equations as string[]).map(t => t.trim()).filter(Boolean);
  // Two equations in one string is a mistake worth naming — but a `;` inside
  // quoted text (`p[p.city == "a;b"]`, a file named `sales;2026.csv`) is data,
  // and the splitter is what tells them apart. It is also what the app and the
  // link codec use, so all three agree on where a row ends. It splits on line
  // breaks too, so the message names what a row holds rather than a character
  // that may not be in it.
  const bad = texts.find(t => splitStatements(t).length > 1);
  if (bad) {
    throw new Error(
      `Row ${JSON.stringify(bad)} holds more than one equation` +
        " (';' and line breaks each separate rows) — send each as its own array item.",
    );
  }
  const analysis = analyze(texts);
  const plotRows = analysis.rows.filter(r => r.cls);
  const needs3D = plotRows.some(r => r.cls!.needs3D);

  // Mirror the app's drag test (web/main.ts pointWriter/defPointWriter) so
  // "draggable" reports what the app will actually let the user grab: 2D
  // graphs only, and only coordinates that are plain numbers or slider names.
  const sliderRow = (name: string) =>
    analysis.rows.find(
      r =>
        r.def?.kind === 'const' && r.def.name === name && !r.error && sliderForm(r.def.rhs, analysis.document.fnNames),
    );
  const draggable = (row: (typeof analysis.rows)[number]): boolean | undefined => {
    const coordinates = row.cpu?.type === 'system' ? row.cpu.coordinates : undefined;
    const pair = coordinates
      ? row.text.slice(row.text.indexOf('=') + 1)
      : row.cpu?.type === 'point'
        ? row.text
        : row.def?.kind === 'const' && analysis.defs.points.has(row.def.name)
          ? row.def.rhs
          : null;
    if (pair === null) return undefined;
    const pinned = coordinates
      ? definitionDependencies(
          coordinates.flatMap(c => [...freeVars(c)]),
          analysis.defs,
        )
      : undefined;
    return !needs3D && dragAxes(pair, sliderRow, pinned) !== null;
  };

  const rows = analysis.rows.map(row => {
    const drag = row.error ? undefined : draggable(row);
    return {
      text: row.text,
      ...(row.error
        ? { status: 'error' as const, error: row.error }
        : {
            status: 'ok' as const,
            kind: row.comment
              ? 'comment (group heading)'
              : row.def
                ? // `adults = person[…]` scans as a constant, but what it
                  // defines is another data file.
                  `definition (${
                    row.def.kind === 'const' && analysis.defs.tables.has(row.def.name) ? 'filtered data' : row.def.kind
                  })`
                : row.view
                  ? `viewport (${row.view.kind})`
                  : row.dist === 'density'
                    ? 'random variable (density curve)'
                    : row.dist === 'pmf'
                      ? 'discrete random variable (pmf stems)'
                      : row.dist === 'probability'
                        ? 'probability (shaded area)'
                        : row.dist === 'expectation'
                          ? 'expectation (mean readout)'
                          : row.dataLocal
                            ? "data (reads a file on the author's device)"
                            : publicKind(row.cls!.object),
            ...(row.cls?.animated ? { animated: true } : {}),
            ...(row.info ? { value: row.info } : {}),
            ...(row.dataLocal ? { note: row.dataLocal } : {}),
            ...(drag === undefined ? {} : { draggable: drag }),
          }),
    };
  });
  const payload = encodePayload(texts);

  // Describe limitations of the share-link preview without rendering an image.
  const omitted = plotRows
    .map(r => ({ row: r.text, why: previewGap(r, needs3D) }))
    .filter((g): g is { row: string; why: string } => g.why !== null);
  // Rows reading a dropped CSV never reach the preview at all: the bytes are
  // on the author's device, not in the link. Disclose them the same way.
  const dataLocalRows = analysis.rows.filter(r => r.dataLocal);
  const dataOmits = dataLocalRows.map(r => ({ row: r.text, why: r.dataLocal! }));
  // A row that would have drawn something if the bytes were here — as opposed
  // to a definition it feeds, which draws nothing anywhere.
  const dataWouldPlot = dataLocalRows.some(r => !r.def && !r.comment && !r.view);
  let preview: string;
  if (!plotRows.length) {
    // A row reading a local CSV never classifies, so it is not in plotRows —
    // "no plot rows to draw" would tell the caller their graph is empty when
    // it is only unrenderable HERE, and preview_omits says otherwise two
    // lines down. Only a would-be plot row earns that reassurance though: a
    // document of definitions alone (`ages = person.age / 2` and nothing
    // that draws) genuinely has nothing to plot on any device, and saying
    // "the graph itself is fine" would send the caller away satisfied with a
    // blank graph.
    // …and the reassurance is about the ROWS, so it may only be given when
    // every row is in fact fine: a document with a device-local plot AND a
    // broken row is not "fine", and "rows" — which says so — is the verdict.
    preview = dataWouldPlot
      ? rows.every(r => r.status === 'ok')
        ? "none — every plot row reads a data file on the author's device (see preview_omits; the graph itself is fine)"
        : "none — every plot row reads a data file on the author's device (see preview_omits), and other rows have errors (see rows)"
      : 'none — no plot rows to draw';
  } else if (omitted.length === plotRows.length) {
    preview =
      'none — the static preview cannot draw any of these rows (see preview_omits; this says nothing about whether the graph works)';
  } else {
    const notes = [
      analysis.rows.some(r => r.cls?.animated) ? 'at t = 0; the live graph animates' : '',
      omitted.length
        ? `${omitted.length} of ${plotRows.length} plot rows missing from the share-link preview — see preview_omits`
        : '',
      plotRows.length > MAX_PLOTS ? `first ${MAX_PLOTS} plot rows only` : '',
    ].filter(Boolean);
    preview = 'not attached — available via share link' + (notes.length ? ` (${notes.join('; ')})` : '');
  }

  return {
    value: {
      valid: rows.every(row => row.status === 'ok'),
      url: `${origin}/#${payload}`,
      share_url: `${origin}/g/${payload}`,
      preview,
      ...(omitted.length || dataOmits.length ? { preview_omits: [...omitted, ...dataOmits] } : {}),
      rows,
    },
  };
}

function decodeGraphUrl(args: Record<string, unknown>) {
  if (typeof args.url !== 'string') throw new Error('url must be a string');
  const url = new URL(args.url);
  const payload = url.hash.length > 1 ? url.hash.slice(1) : url.pathname.startsWith('/g/') ? url.pathname.slice(3) : '';
  if (!payload) throw new Error('No equations found in that URL (expected /#... or /g/... form).');
  return { equations: decodePayload(payload) };
}

// --- JSON-RPC plumbing ---

interface RpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface RpcContext {
  origin: string;
  /** Reads the /llms.txt asset backing the "syntax" resource. */
  syntaxText: () => Promise<string>;
  graphHtml: () => Promise<string>;
}

async function handleRpc(req: RpcRequest, ctx: RpcContext): Promise<object | null> {
  const { id, method, params = {} } = req;
  const { origin } = ctx;
  const result = (r: object) => ({ jsonrpc: '2.0', id, result: r });
  const error = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

  // A notification is a request with NO id member (JSON-RPC 2.0). `id: null`
  // is a valid (if discouraged) request id and must still get a response.
  if (id === undefined) return null;

  switch (method) {
    case 'initialize': {
      const requested = (params as { protocolVersion?: string }).protocolVersion;
      return result({
        protocolVersion: PROTOCOL_VERSIONS.includes(requested ?? '') ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'equation', title: 'equation.io grapher', version: '1.0.0' },
        instructions:
          'Graphing calculator whose entire state lives in the URL. show_graph displays an interactive graph in the conversation. encode_graph_url validates equations and creates a share link without displaying a widget. decode_graph_url decodes a link the user shares so you can edit their graph. Before writing non-trivial equations, read the "syntax" resource: the full language reference, also served at ' +
          origin +
          '/llms.txt',
      });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: [...TOOLS, SHOW_GRAPH_TOOL] });
    case 'resources/list':
      return result({ resources: [syntaxResource(origin), graphResource] });
    case 'resources/templates/list':
      return result({ resourceTemplates: [] });
    case 'resources/read': {
      const uri = (params as { uri?: string }).uri;
      if (uri === GRAPH_UI_URI) {
        try {
          return result({ contents: [graphResourceContents(await ctx.graphHtml(), origin)] });
        } catch (e) {
          return error(-32603, e instanceof Error ? e.message : String(e));
        }
      }
      const expected = syntaxResource(origin).uri;
      if (uri !== expected)
        return error(-32002, `Unknown resource: ${uri}. Available resources: ${expected}, ${GRAPH_UI_URI}.`);
      try {
        return result({ contents: [{ uri: expected, mimeType: 'text/markdown', text: await ctx.syntaxText() }] });
      } catch (e) {
        return error(-32603, e instanceof Error ? e.message : String(e));
      }
    }
    case 'tools/call': {
      const { name, arguments: args = {} } = params as { name?: string; arguments?: Record<string, unknown> };
      try {
        let value: object;
        const content: object[] = [];
        // Accept former names for clients with cached tool definitions.
        if (name === 'encode_graph_url' || name === 'create_graph' || name === 'show_graph') {
          const made = await encodeGraphUrl(origin, args);
          if (name === 'show_graph') {
            const { preview: _preview, preview_omits: _omits, ...shown } = made.value;
            value = shown;
          } else {
            value = made.value;
          }
          content.push({ type: 'text', text: JSON.stringify(value, null, 2) });
        } else if (name === 'decode_graph_url' || name === 'read_graph') {
          value = decodeGraphUrl(args);
          content.push({ type: 'text', text: JSON.stringify(value, null, 2) });
        } else return error(-32602, `Unknown tool: ${name}`);
        return result({ content, structuredContent: value });
      } catch (e) {
        return result({
          content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
          isError: true,
        });
      }
    }
    default:
      return error(-32601, `Method not found: ${method}`);
  }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  // GET and DELETE return 405 today, but the MCP Streamable HTTP transport
  // uses them (GET opens a server-initiated SSE stream, DELETE ends a
  // session). Browsers cache preflight results per URL, so advertising the
  // full transport method set now means an already-cached preflight stays
  // valid if we ever add sessions — old clients won't need a cache expiry to
  // reach the new methods.
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
};

export async function handleMcp(request: Request, url: URL, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      // Our CORS policy is static and permissive, so let browsers cache the
      // preflight as long as they will (Chromium clamps to 2h, Firefox 24h).
      headers: { ...CORS_HEADERS, 'Access-Control-Max-Age': '86400' },
    });
  }
  if (request.method !== 'POST') {
    // No server-initiated streams (GET) and no sessions to delete.
    return new Response(
      'Equation.io MCP server\n\n' +
        'To create and edit graphs with an AI assistant, add https://equation.io/mcp ' +
        'to your MCP client using Streamable HTTP. No API key is required.\n\n' +
        'For the graphing calculator, visit https://equation.io/\n' +
        'Expression syntax: https://equation.io/llms.txt\n\n' +
        'MCP requests use HTTP POST. This endpoint does not offer a GET event stream.\n',
      {
        status: 405,
        headers: { ...CORS_HEADERS, Allow: 'POST, OPTIONS', 'Content-Type': 'text/plain; charset=utf-8' },
      },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const ctx: RpcContext = {
    origin: url.origin,
    graphHtml: async () => {
      const res = await env.ASSETS.fetch(new Request(new URL('/mcp-app/', url)));
      const html = await res.text();
      if (!res.ok || !html.includes('data-mcp-app')) throw new Error('Graph UI unavailable; rebuild the web assets.');
      return html;
    },
    syntaxText: async () => {
      const res = await env.ASSETS.fetch(new Request(new URL('/llms.txt', url)));
      if (!res.ok) throw new Error(`syntax reference unavailable (${res.status})`);
      return res.text();
    },
  };
  const responses = (
    await Promise.all((Array.isArray(body) ? body : [body]).map(r => handleRpc(r as RpcRequest, ctx)))
  ).filter((r): r is object => r !== null);

  if (!responses.length) return new Response(null, { status: 202, headers: CORS_HEADERS });
  const payload = Array.isArray(body) ? responses : responses[0];
  return Response.json(payload, { headers: CORS_HEADERS });
}
