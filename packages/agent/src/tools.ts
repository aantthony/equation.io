/**
 * The tools the Equation.io agent can call, whichever model and transport
 * carries the conversation: the Realtime voice session (worker/voice-call.ts)
 * and the Responses API agent (responses.ts) offer the same set, and
 * host.ts runTool executes them against the live app.
 */
import type { ObjectSchema } from '../../../lib/json-schema.ts';

/** A function the model can call; host.ts runTool implements each. */
export interface FunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: ObjectSchema;
}

export const TOOLS: FunctionTool[] = [
  {
    type: 'function',
    name: 'get_graph',
    description:
      'Read the graph: the visible window (2D) or camera (3D), and for every row its text, status, kind, color, readout value, and (2D curves) axis intercepts in view.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'set_graph',
    description:
      'Replace the whole graph. Pass every row that should be on screen, including unchanged ones. Returns the new graph as get_graph does; rows with status "error" are not drawn.',
    parameters: {
      type: 'object',
      properties: {
        equations: {
          type: 'array',
          items: { type: 'string' },
          description: 'One equation or definition per entry, e.g. ["a = 2", "y = a sin(x)"].',
        },
      },
      required: ['equations'],
    },
  },
  {
    type: 'function',
    name: 'look_at_graph',
    description:
      'Take a screenshot of the graph as the student sees it. It arrives as an image right after this call, with a legend of the rows and their colors.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'read_syntax',
    description:
      'Look up equation.io syntax in its reference manual. Returns the matching entries with examples. Use it before writing any form not in your instructions, and after any row error.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'A few words naming what you want to write, e.g. "parametric surface", "vector field", "normal distribution".',
        },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'point_at',
    description:
      'Move your on-screen presence (a glowing orb) to a point on the graph, to show the user what you are talking about. It follows the point as the user pans and returns home after `seconds` or when the user speaks.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        z: { type: 'number', description: '3D graphs only.' },
        seconds: { type: 'number', description: 'How long to stay there. Default 6.' },
      },
      required: ['x', 'y'],
    },
  },
  {
    type: 'function',
    name: 'animate_slider',
    description:
      'Glide a slider (a constant row like "a = 2") to a new value at a steady rate, so the user can watch the graph change. The final value is saved in the row.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The slider name, e.g. "a".' },
        to: { type: 'number' },
        from: { type: 'number', description: 'Jump here first. Default: the current value.' },
        seconds: { type: 'number', description: 'Default 3.' },
      },
      required: ['name', 'to'],
    },
  },
  {
    type: 'function',
    name: 'move_view',
    description:
      'Smoothly pan and zoom to a new framing. In 2D give x and/or y ranges. In 3D give any of theta (azimuth), phi (elevation), radius (distance), target (the point looked at), and spin to keep the camera orbiting once it arrives.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'array', items: { type: 'number' }, description: '2D: [low, high].' },
        y: { type: 'array', items: { type: 'number' }, description: '2D: [low, high].' },
        theta: { type: 'number', description: '3D: radians.' },
        phi: { type: 'number', description: '3D: radians, -pi/2..pi/2.' },
        radius: { type: 'number', description: '3D.' },
        target: { type: 'array', items: { type: 'number' }, description: '3D: [x, y, z].' },
        spin: {
          type: 'number',
          description:
            '3D: after arriving, keep orbiting horizontally at this many radians per second (0.2 is a slow turntable, 1 is fast; negative turns the other way; 0 stops). Saved in the graph, so it keeps spinning when shared.',
        },
        seconds: { type: 'number', description: 'Default 1.5.' },
      },
    },
  },
];

/** Longest screenshot legend the Worker adds to the conversation (worker/voice-call.ts). */
export const MAX_LEGEND_CHARS = 8000;
/** A row's text in the legend: enough to recognise it, not a whole inline data list. */
const MAX_LEGEND_ROW_CHARS = 200;

/** The part of a get_graph result a screenshot legend reads. */
export interface LegendGraph {
  window?: { x: [number, number]; y: [number, number] };
  rows: { text: string; status: 'ok' | 'error'; error?: string; kind?: string; color?: string }[];
}

/**
 * The legend that goes with each screenshot: every row's text, color and
 * kind, and the window. Long rows are cut, and rows past the Worker's limit
 * are counted rather than listed, so a large graph can still be looked at.
 */
export function screenshotLegend(graph: LegendGraph): string {
  const view = graph.window
    ? `Visible window: x from ${graph.window.x[0]} to ${graph.window.x[1]}, y from ${graph.window.y[0]} to ${graph.window.y[1]}.`
    : 'The graph is a 3D view.';
  const head = 'Rows in the graph, whether or not they are visible in the screenshot (text, color, kind):';
  const rows = graph.rows.filter(r => r.text.trim());
  const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  const lines: string[] = [];
  // Room for the head, the view, and a line saying how many rows were left out.
  let budget = MAX_LEGEND_CHARS - head.length - view.length - 64;
  for (const r of rows) {
    const bits = [r.color, r.kind, r.status === 'error' ? `not drawn: ${cut(r.error ?? '', 200)}` : undefined].filter(
      Boolean,
    );
    const line = `- ${cut(r.text, MAX_LEGEND_ROW_CHARS)}${bits.length ? ` (${bits.join(', ')})` : ''}`;
    if (line.length + 1 > budget) break;
    budget -= line.length + 1;
    lines.push(line);
  }
  if (lines.length < rows.length) lines.push(`- … and ${rows.length - lines.length} more rows`);
  return `${head}\n${lines.join('\n')}\n${view}`;
}
