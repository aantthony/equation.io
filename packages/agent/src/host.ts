/**
 * The agent's tools, run against the live app. Whichever conversation asked
 * (the Realtime voice session, the desktop Responses agent, native-speech
 * voice), a tool call lands here and acts through GraphHost, so every mode
 * has the same graph semantics.
 *
 * - get_graph: every row as text plus what the app computed for it (kind,
 *   color, readout value, axis intercepts in view) and the visible window.
 *   Exact numbers come from here, never from pixels.
 * - set_graph: replaces the rows and answers with the same readout, including
 *   each row's parse error, so the model can correct itself the way a person
 *   would after seeing a red row.
 * - look_at_graph: a screenshot of the canvas goes into the conversation as
 *   an image, with a legend mapping each row to its color, so the model that
 *   asked is the one that looks.
 */
import { screenshotLegend } from './tools.ts';

/** Longest screenshot edge sent to the model: enough to read axis labels. */
const SCREENSHOT_EDGE = 1280;
export interface RowStatus {
  index: number;
  text: string;
  status: 'ok' | 'error';
  error?: string;
  /** The public kind, e.g. "implicit2d", "definition (const)". */
  kind?: string;
  /** What the row IS, in words: "defines r: a scalar constant …", "2D curve …". */
  meaning?: string;
  /** Drawing color as hex, for rows that draw something. */
  color?: string;
  /** The readout under the row (`= 4`, a probability) or a slider's value. */
  value?: string;
  animated?: boolean;
  /** Axis intercepts within the visible window (2D curves only). */
  points?: string[];
  /** Valid, but probably not what was meant (a definition nothing uses). */
  warning?: string;
  /** For an error: what probably went wrong, when the message alone misleads. */
  hint?: string;
}

export interface GraphState {
  mode: '2d' | '3d';
  /** The visible 2D window; absent in 3D. */
  window?: { x: [number, number]; y: [number, number] };
  /** The 3D orbit camera (radians; spin in radians per second); absent in 2D. */
  camera?: { theta: number; phi: number; radius: number; target: [number, number, number]; spin: number };
  rows: RowStatus[];
}

/** move_view's target: a 2D window, or any part of the 3D orbit camera. */
export interface MoveViewTarget {
  x?: [number, number];
  y?: [number, number];
  theta?: number;
  phi?: number;
  radius?: number;
  target?: [number, number, number];
  /** 3D: keep orbiting about the vertical axis afterwards, radians per second. */
  spin?: number;
}

/**
 * The live Equation.io app, as the agent sees it: what the tools read and
 * change. web/main.ts implements it; every transport shares it.
 */
export interface GraphHost {
  graph(): GraphState;
  /** Replace the document (one undo step) and report the new state. */
  setRows(rows: string[]): GraphState;
  /** Glide a slider to `to` over `seconds`; reports the actual range, or an error. */
  animateSlider(name: string, to: number, seconds: number, from?: number): object;
  /** Ease the 2D window or 3D camera to a new framing; settles once it has arrived. */
  moveView(target: MoveViewTarget, seconds: number): object | Promise<object>;
  /** Where a math point is on the page, or null when it is off-screen. */
  toClient(x: number, y: number, z?: number): { x: number; y: number } | null;
  /** The graph now, longest edge at most maxEdge pixels, and where it sits on the page. */
  screenshot(maxEdge: number): { canvas: HTMLCanvasElement; rect: DOMRect };
  notice(text: string): void;
}

function parseArgs(args: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** What a tool call can reach besides the graph: the conversation and the orb. */
export interface ToolContext {
  /** Adds an image (and its legend) to the conversation. */
  attach(image: string, legend: string): Promise<void>;
  /** Shows the capture happening: a flash, and the picture flying into the orb. */
  captured(canvas: HTMLCanvasElement, rect: DOMRect): void;
  readSyntax(query: string): Promise<string>;
  pointAt(x: number, y: number, z: number | undefined, seconds: number): boolean;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const range = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every(num);
/** Tool durations: long enough to see, short enough that a typo can't lock the view for minutes. */
const seconds = (v: unknown, fallback: number) => (num(v) ? Math.min(30, Math.max(0, v)) : fallback);

/** Runs one tool call; always resolves to a JSON-serializable result. */
export async function runTool(host: GraphHost, name: string, args: string, ctx: ToolContext): Promise<unknown> {
  if (name === 'get_graph') return host.graph();
  const parsed = parseArgs(args);
  if (!parsed) return { error: 'arguments were not valid JSON' };
  if (name === 'set_graph') {
    const eqs = parsed.equations;
    if (!Array.isArray(eqs) || !eqs.every(e => typeof e === 'string')) {
      return { error: 'equations must be an array of strings' };
    }
    return host.setRows(eqs);
  }
  if (name === 'look_at_graph') {
    try {
      const shot = host.screenshot(SCREENSHOT_EDGE);
      // Encode before the canvas goes on screen as the flying card.
      const image = shot.canvas.toDataURL('image/jpeg', 0.85);
      ctx.captured(shot.canvas, shot.rect);
      await ctx.attach(image, screenshotLegend(host.graph()));
      return { screenshot: 'the image just added to the conversation' };
    } catch (e) {
      return { error: `screenshot failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  if (name === 'read_syntax') {
    const query = parsed.query;
    if (typeof query !== 'string' || !query.trim()) return { error: 'query is required' };
    try {
      return { reference: await ctx.readSyntax(query) };
    } catch {
      return { error: 'the syntax reference could not be loaded' };
    }
  }
  if (name === 'point_at') {
    const { x, y, z } = parsed;
    if (!num(x) || !num(y) || (z !== undefined && !num(z))) return { error: 'x and y must be numbers' };
    return ctx.pointAt(x, y, z, seconds(parsed.seconds, 6))
      ? { pointing: true }
      : { error: 'that point is off-screen; call move_view first' };
  }
  if (name === 'animate_slider') {
    const { name: slider, to, from } = parsed;
    if (typeof slider !== 'string' || !num(to) || (from !== undefined && !num(from))) {
      return { error: 'name must be a string, to and from numbers' };
    }
    return host.animateSlider(slider, to, seconds(parsed.seconds, 3), from);
  }
  if (name === 'move_view') {
    const { x, y, theta, phi, radius, target, spin } = parsed;
    if (
      (x !== undefined && !range(x)) ||
      (y !== undefined && !range(y)) ||
      [theta, phi, radius, spin].some(v => v !== undefined && !num(v)) ||
      (spin !== undefined && Math.abs(spin as number) > 10) ||
      (radius !== undefined && !((radius as number) > 0)) ||
      (target !== undefined && !(Array.isArray(target) && target.length === 3 && target.every(num)))
    ) {
      return { error: 'x and y are [low, high]; theta, phi, radius, spin (at most 10) numbers; target [x, y, z]' };
    }
    return host.moveView({ x, y, theta, phi, radius, target, spin } as MoveViewTarget, seconds(parsed.seconds, 1.5));
  }
  return { error: `unknown tool ${name}` };
}
