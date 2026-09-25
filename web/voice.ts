/**
 * Voice mode: talk to an OpenAI Realtime model and it edits the graph.
 *
 * The browser streams microphone PCM straight to wss://api.openai.com; the
 * Worker only mints the short-lived client secret that opens the socket
 * (worker/voice.ts), so the API key never reaches the page.
 *
 * The model works the graph through tools, chiefly:
 * - get_graph: every row as text plus what the app computed for it (kind,
 *   color, readout value, intercepts/extrema in view) and the visible window.
 *   Exact numbers come from here, never from pixels.
 * - set_graph: replaces the rows and answers with the same readout, including
 *   each row's parse error, so the model can correct itself the way a person
 *   would after seeing a red row.
 * - look_at_graph: a screenshot of the canvas goes into the conversation as
 *   an image, with a legend mapping each row to its color, so the model that
 *   heard the question is the one that looks.
 *
 * The feature is private. A browser is unlocked by visiting any page with
 * `?voice=<passphrase>` once: the passphrase is kept in localStorage and sent
 * with each request, and the mic button stays hidden everywhere else.
 */
import type { PublicKind } from '../lib/math-object.ts';
import { type SyntaxEntry, searchSyntax, syntaxEntries } from '../lib/syntax-search.ts';
import workletUrl from './voice-worklet.ts?worker&url';

/** Must match the model worker/voice.ts mints the client secret for. */
const MODEL = 'gpt-realtime-2.1';
const VOICE = 'marin';
const RATE = 24000;
const STORE_KEY = 'voicePassphrase';
/** Longest screenshot edge sent to the model: enough to read axis labels. */
const SCREENSHOT_EDGE = 1280;

/** What each drawn row kind looks like, for the voice agent: kind names like
 *  `implicit2d` are the MCP's public vocabulary, not words a model can reason
 *  about. The Record keeps it total — a new kind fails the typecheck here. */
export const KIND_MEANINGS: Record<PublicKind, string> = {
  implicit2d: '2D curve (the set of points satisfying an equation)',
  ineq2d: 'shaded 2D region (an inequality)',
  scalar2d: '2D scalar field, drawn as shading',
  implicit3d: '3D surface (the points satisfying an equation in x, y, z)',
  spacecurve: '3D curve where surfaces intersect',
  pcurve: 'parametric curve, traced as u runs from 0 to 1',
  psurface: 'parametric surface over u and v in 0..1',
  vfield2d: '2D vector field, drawn as flowing streamlines',
  vfield3d: '3D vector field',
  point: 'a point',
  polygon: 'geometric figure (segment, polyline, vector arrow, polygon, circle, …)',
  label: 'text label at a point',
  trail: 'motion trail behind a moving point',
  orbit: 'path of a simulated state over a time range',
  system: 'solutions of a system of equations (points or curves)',
  value: 'number readout under the row; draws nothing on the graph',
  note: 'true/false readout under the row; draws nothing on the graph',
  family: 'one copy of the row per list element',
  complex2d: 'complex function shown on the plane',
  domain2d: 'domain colouring of a complex function',
  conformal2d: 'conformal map: the image of a grid under a complex function',
  fractal2d: 'escape-time fractal',
  rgb2d: 'colour field (RGB), filling the plane',
  hsl2d: 'colour field (HSL), filling the plane',
  oklch2d: 'colour field (OKLCH), filling the plane',
  sequence: 'sequence, drawn as dots at whole numbers n',
  cobweb: 'cobweb diagram of a recurrence',
  bifurcation: 'bifurcation / orbit diagram of a recurrence',
  vlist: 'list of numbers, drawn as dots',
  plist: 'list of points',
  dlist: 'data column, drawn as dots',
  dscatter: 'scatter plot of data',
  histogram: 'histogram',
  automaton: 'cellular automaton grid',
  density: 'probability density curve of a random variable',
  pmf: 'probability mass function (stems) of a discrete random variable',
  prob: 'probability, shaded under the density, with its value as a readout',
  expect: 'expected value readout, marked on the density',
};

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
  /** Intercepts, extrema, … within the visible window (2D curves only). */
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

export interface VoiceHost {
  graph(): GraphState;
  /** Replace the document (one undo step) and report the new state. */
  setRows(rows: string[]): GraphState;
  /** Glide a slider to `to` over `seconds`; reports the actual range, or an error. */
  animateSlider(name: string, to: number, seconds: number, from?: number): object;
  /** Ease the 2D window or 3D camera to a new framing. */
  moveView(target: MoveViewTarget, seconds: number): object;
  /** Where a math point is on the page, or null when it is off-screen. */
  toClient(x: number, y: number, z?: number): { x: number; y: number } | null;
  /** The graph now, longest edge at most maxEdge pixels, and where it sits on the page. */
  screenshot(maxEdge: number): { canvas: HTMLCanvasElement; rect: DOMRect };
  notice(text: string): void;
}

const INSTRUCTIONS = `You are a maths tutor inside equation.io, a graphing calculator. The student talks; you explain out loud and show things on the graph with tools. Teach by showing: draw it, point at it, animate it.

How the graph works:
- The graph is a list of rows, one per line. Each row is an equation, a definition, or a label. Verified forms:
  - Curves and regions: "y = sin(x)", "x^2 + y^2 = 4", "y < x^2" (shaded region), "z = x^2 - y^2" (3D surface).
  - Sliders: "a = 2" makes a slider; then "y = a sin(x)" uses it.
  - Functions: "f(x) = x^3 - x" only DEFINES f and draws nothing; add "y = f(x)" to draw it, and "y = d/dx f(x)" for its derivative.
  - Points: "A = (1, 2)" is a draggable named point.
  - Parametric curves use u, which runs from 0 to 1 (not t): "(2cos(2pi u), 2sin(2pi u))" is a circle of radius 2.
  - Parametric surfaces are a bare triple in u and v (both 0 to 1), with no wrapper function: "(sin(pi v) cos(2pi u), sin(pi v) sin(2pi u), cos(pi v))" is a unit sphere.
  - Polar curves r = f(theta): write them parametrically with theta = 2pi u, so negative r draws correctly. The rose r = sin(4 theta) (8 petals) is "(sin(8pi u) cos(2pi u), sin(8pi u) sin(2pi u))". Never write a bare "r = …" row: that defines a constant named r and draws nothing.
  - t is time in seconds and makes things move: "y = sin(x - t)" is a travelling wave, "(cos(t), sin(t))" a point circling the origin.
- Implicit multiplication works: "2x", "a sin(x)". Use ^ for powers, sqrt(), abs(), ln(), log(), exp(), pi, e.
- Anything beyond these forms (vector fields, complex functions, probability, ODEs, geometry, …): call read_syntax first. Never invent function names; "surface(…)" or "plot(…)" do not exist.
- Labels are rows too: label((2, 4), "they cross here") or label(A, "vertex"). The point can use sliders, so label((a, a^2), "slides along") follows the curve. Keep label text to a few words.
- Colors: end a row with a hex color, e.g. "y = x^2 #e24" or "y = 2x #1f77b4 tangent" (no space after the #). Use color to connect ideas (a curve and its label in the same color) or to contrast (the original in grey #999, the new one bright). Rows without one take the palette.
- The student can also type rows themselves, so call get_graph before relying on what you think is on screen.
- To change the graph call set_graph with the COMPLETE list of rows. Keep every row the student did not ask to change, exactly as it was.
- get_graph and set_graph return each row's status, meaning (what the row actually is, e.g. "2D curve …" or "defines r: a scalar constant …; draws nothing by itself"), color, readout value, and notable points (intercepts, extrema) in the visible window. After set_graph, check every meaning matches what you intended to draw. Use these for exact numbers. If any row has status "error", or a "warning" (for example a definition nothing uses, which draws nothing), fix it and call set_graph again before answering; use read_syntax if you are not sure of the right form. Don't give up on a first error. Never say you drew something the result doesn't show.

Showing, not just telling:
- point_at moves your glowing orb to a spot on the graph. Use it whenever you say "here" or "this point".
- animate_slider glides a slider so the student can watch the effect: to explore "what does a do?", add a slider row, then animate it while you describe what changes. Prefer 3 to 6 seconds.
- move_view zooms or pans to what matters, e.g. zoom into an intersection or out to see end behaviour. For a 3D shape, give it a slow spin (about 0.3) so the student sees it from every side; spin 0 stops it.
- look_at_graph shows you a screenshot of the graph. Use it for visual questions the numbers can't answer: what the graph looks like, whether it matches what the student wanted, overlaps, shapes, 3D views. Describe only what the picture shows: things can be off-screen, and moving points and their trails can leave the window. Say something short like "Let me look" first.

How to tutor:
- Keep replies short: one to three sentences, then let the student respond. Say what you drew, not the syntax: "There's a circle of radius 2", not "x caret 2 plus y caret 2 equals 4".
- Ask the student to predict before you reveal ("What do you think happens if a goes negative?"), then show it.
- Round numbers when speaking unless the student wants precision.
- If a request is ambiguous, draw your best guess and say what you chose.`;

const TOOLS = [
  {
    type: 'function',
    name: 'get_graph',
    description:
      'Read the graph: the visible window, and for every row its text, status, kind, color, readout value, and notable points in view.',
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

/** The legend that goes with each screenshot. */
export function screenshotContext(graph: GraphState): string {
  const lines = graph.rows
    .filter(r => r.text.trim())
    .map(r => {
      const bits = [r.color, r.kind, r.status === 'error' ? `not drawn: ${r.error}` : undefined].filter(Boolean);
      return `- ${r.text}${bits.length ? ` (${bits.join(', ')})` : ''}`;
    });
  const view = graph.window
    ? `Visible window: x from ${graph.window.x[0]} to ${graph.window.x[1]}, y from ${graph.window.y[0]} to ${graph.window.y[1]}.`
    : 'The graph is a 3D view.';
  return `Rows in the graph, whether or not they are visible in the screenshot (text, color, kind):\n${lines.join('\n')}\n${view}\nThe equation panel may cover the top-left corner of the screenshot.`;
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
  /** Adds an image (and its legend) to the conversation, after this call's output. */
  attach(image: string, legend: string): void;
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
export async function runTool(host: VoiceHost, name: string, args: string, ctx: ToolContext): Promise<unknown> {
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
      ctx.attach(image, screenshotContext(host.graph()));
      return { screenshot: 'attached as the next message' };
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

export function float32ToBase64Pcm16(samples: Float32Array): string {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64Pcm16ToFloat32(b64: string): Float32Array {
  const bin = atob(b64);
  const pcm = new Int16Array(bin.length >> 1);
  for (let i = 0; i < pcm.length; i++) pcm[i] = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 0x8000;
  return out;
}

function readPassphrase(): string | null {
  try {
    const params = new URLSearchParams(location.search);
    const given = params.get('voice');
    if (given !== null) {
      if (given) localStorage.setItem(STORE_KEY, given);
      else localStorage.removeItem(STORE_KEY);
      params.delete('voice');
      const search = params.toString();
      history.replaceState(history.state, '', location.pathname + (search ? '?' + search : '') + location.hash);
    }
    return localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}

function forgetPassphrase() {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    // Storage blocked: nothing was remembered.
  }
}

type OrbState = 'listening' | 'thinking' | 'speaking';

/**
 * The assistant's on-screen presence: an orb at the bottom centre that breathes with
 * the microphone while listening, shimmers while thinking, and ripples
 * outward with its own voice while speaking. It is also its pointer:
 * point_at flies it to a math coordinate, where it stays pinned through pans
 * and zooms until it is sent home.
 */
class Orb {
  private el = document.createElement('div');
  private frame: number | null = null;
  private mic?: AnalyserNode;
  private out?: AnalyserNode;
  private buf = new Float32Array(512);
  private level = 0;
  private state: OrbState = 'listening';
  private target: { x: number; y: number; z?: number; until: number } | null = null;

  constructor(private host: VoiceHost) {
    this.el.className = 'voice-orb';
    this.el.setAttribute('aria-hidden', 'true');
    this.el.append(document.createElement('span'));
  }

  show(mic: AnalyserNode, out: AnalyserNode) {
    this.mic = mic;
    this.out = out;
    document.body.append(this.el);
    this.setState('listening');
    this.frame ??= requestAnimationFrame(this.tick);
  }

  hide() {
    this.el.remove();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.target = null;
  }

  setState(state: OrbState) {
    this.state = state;
    for (const s of ['listening', 'thinking', 'speaking']) this.el.classList.toggle(s, s === state);
  }

  /** Pins the orb to a math point; false when the point is off-screen. */
  pointAt(x: number, y: number, z: number | undefined, seconds: number): boolean {
    if (!this.host.toClient(x, y, z)) return false;
    this.target = { x, y, z, until: performance.now() + seconds * 1000 };
    return true;
  }

  home() {
    this.target = null;
  }

  /**
   * The screenshot moment, after the old iOS one: the screen flashes, the
   * picture shrinks a touch into a card, then flies into the orb and shrinks
   * into it — so the student sees the assistant take a look.
   */
  absorb(shot: HTMLCanvasElement, rect: DOMRect) {
    const flash = document.createElement('div');
    flash.className = 'voice-flash';
    document.body.append(flash);
    void flash
      .animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: 450, easing: 'ease-out' })
      .finished.finally(() => flash.remove());
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !this.el.isConnected) return;

    shot.className = 'voice-shot';
    Object.assign(shot.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    document.body.append(shot);
    const orb = this.el.getBoundingClientRect();
    const dx = orb.left + orb.width / 2 - (rect.left + rect.width / 2);
    const dy = orb.top + orb.height / 2 - (rect.top + rect.height / 2);
    // Scale x and y apart so the card lands as a circle the orb's size.
    const sx = orb.width / rect.width;
    const sy = orb.height / rect.height;
    void shot
      .animate(
        [
          { transform: 'none', borderRadius: '0px', opacity: 1, offset: 0 },
          {
            transform: 'scale(0.82)',
            borderRadius: '18px',
            opacity: 1,
            offset: 0.35,
            easing: 'cubic-bezier(0.5, 0, 0.2, 1)',
          },
          {
            transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
            borderRadius: '50%',
            opacity: 0.4,
            offset: 1,
          },
        ],
        { duration: 1000, easing: 'ease-out' },
      )
      .finished.finally(() => {
        shot.remove();
        this.el.classList.remove('absorb');
        void this.el.offsetWidth; // restart the gulp if one is still running
        this.el.classList.add('absorb');
        setTimeout(() => this.el.classList.remove('absorb'), 500);
      });
  }

  private rms(node: AnalyserNode | undefined): number {
    if (!node) return 0;
    node.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (const v of this.buf) sum += v * v;
    return Math.sqrt(sum / this.buf.length);
  }

  private tick = (now: number) => {
    this.frame = requestAnimationFrame(this.tick);
    // Speech RMS rarely passes 0.3; the curve lifts quiet speech into view.
    const raw = this.rms(this.state === 'speaking' ? this.out : this.mic);
    const next = Math.min(1, Math.sqrt(raw * 4));
    // Fast attack, slow release, like a VU meter.
    this.level += (next - this.level) * (next > this.level ? 0.5 : 0.1);
    this.el.style.setProperty('--level', this.level.toFixed(3));

    if (this.target && now > this.target.until) this.target = null;
    const at = this.target && this.host.toClient(this.target.x, this.target.y, this.target.z);
    this.el.classList.toggle('pointing', !!at);
    const pos = at ?? { x: innerWidth / 2, y: innerHeight - 56 };
    this.el.style.setProperty('--x', `${pos.x}px`);
    this.el.style.setProperty('--y', `${pos.y}px`);
  };
}

/** One live conversation: mic in, speaker out, tool calls against the graph. */
class Session {
  private ws?: WebSocket;
  private ctx?: AudioContext;
  private mic?: MediaStream;
  private playhead = 0;
  private playing = new Set<AudioBufferSourceNode>();
  /** Tool calls of the current response, still running. */
  private pendingTools: Promise<void>[] = [];
  private transcript = '';
  private orb: Orb;
  /** Tool calls still running, across responses: the orb thinks until they finish. */
  private running = 0;
  /** Playback goes through this, so the orb can pulse with the model's voice. */
  private out?: AnalyserNode;
  closed = false;

  constructor(
    private host: VoiceHost,
    private passphrase: string,
    private onState: (state: 'connecting' | 'live' | 'idle', reason?: string) => void,
  ) {
    this.orb = new Orb(host);
  }

  async start() {
    this.onState('connecting');
    try {
      // Both need the click's user activation, so ask before any await on the network.
      this.ctx = new AudioContext({ sampleRate: RATE });
      const micPromise = navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      const tokenPromise = fetch('/api/voice/token', {
        method: 'POST',
        headers: { 'X-Voice-Passphrase': this.passphrase },
      });
      this.mic = await micPromise;
      // Stopped while the permission prompt was up: stop() ran before there was a mic to release.
      if (this.closed) return this.release();
      const res = await tokenPromise;
      if (res.status === 403 || res.status === 404) {
        forgetPassphrase();
        throw new Error(res.status === 403 ? 'Voice passphrase rejected.' : 'Voice mode is not configured.');
      }
      if (!res.ok) throw new Error('Could not start a voice session.');
      const { value } = (await res.json()) as { value: string };
      if (this.closed) return this.release();

      await this.ctx.audioWorklet.addModule(workletUrl);
      const tap = new AudioWorkletNode(this.ctx, 'mic-tap');
      tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: float32ToBase64Pcm16(e.data) }));
        }
      };
      const source = this.ctx.createMediaStreamSource(this.mic);
      source.connect(tap);
      const micLevel = this.ctx.createAnalyser();
      source.connect(micLevel);
      this.out = this.ctx.createAnalyser();
      this.out.connect(this.ctx.destination);

      const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, [
        'realtime',
        `openai-insecure-api-key.${value}`,
      ]);
      this.ws = ws;
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              type: 'realtime',
              instructions: INSTRUCTIONS,
              audio: {
                input: { format: { type: 'audio/pcm', rate: RATE }, turn_detection: { type: 'semantic_vad' } },
                output: { format: { type: 'audio/pcm', rate: RATE }, voice: VOICE },
              },
              tools: TOOLS,
              tool_choice: 'auto',
            },
          }),
        );
        this.onState('live');
        this.orb.show(micLevel, this.out!);
      };
      ws.onmessage = e => this.onEvent(JSON.parse(e.data as string));
      let opened = false;
      ws.addEventListener('open', () => (opened = true));
      ws.onerror = () => this.stop('Voice connection failed.');
      ws.onclose = () => this.stop(opened ? undefined : 'Voice connection failed.');
    } catch (e) {
      const denied = e instanceof DOMException && e.name === 'NotAllowedError';
      this.stop(denied ? 'Microphone access is needed for voice mode.' : e instanceof Error ? e.message : String(e));
    }
  }

  private onEvent(event: { type: string; [k: string]: any }) {
    switch (event.type) {
      case 'response.output_audio.delta':
        this.orb.setState('speaking');
        this.play(base64Pcm16ToFloat32(event.delta));
        break;
      case 'input_audio_buffer.speech_started':
        // Barge-in: the user talking over the model cuts its audio off, and a
        // new question means the old pointing is stale.
        this.interrupt();
        this.orb.home();
        this.orb.setState('listening');
        break;
      case 'input_audio_buffer.speech_stopped':
        this.orb.setState('thinking');
        break;
      case 'response.output_audio_transcript.delta':
        this.transcript += event.delta;
        this.host.notice(this.transcript);
        break;
      case 'response.function_call_arguments.done': {
        const { call_id, name } = event;
        this.orb.setState('thinking');
        this.running++;
        const images: { image: string; legend: string }[] = [];
        const run = runTool(this.host, name, event.arguments ?? '{}', {
          attach: (image, legend) => images.push({ image, legend }),
          readSyntax: async query => searchSyntax(await this.syntax(), query),
          captured: (canvas, rect) => this.orb.absorb(canvas, rect),
          pointAt: (x, y, z, seconds) => this.orb.pointAt(x, y, z, seconds),
        }).then(output => {
          this.running--;
          if (this.closed) return;
          this.ws?.send(
            JSON.stringify({
              type: 'conversation.item.create',
              item: { type: 'function_call_output', call_id, output: JSON.stringify(output) },
            }),
          );
          for (const { image, legend } of images) {
            this.ws?.send(
              JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'message',
                  role: 'user',
                  content: [
                    { type: 'input_text', text: legend },
                    { type: 'input_image', image_url: image },
                  ],
                },
              }),
            );
          }
        });
        this.pendingTools.push(run);
        break;
      }
      case 'response.done': {
        this.transcript = '';
        // A response can make several calls, and one can outlive the
        // response that asked for it: ask for the follow-up once, after all
        // of this response's outputs are in.
        const pending = this.pendingTools.splice(0);
        // A turn that ended without speech (or whose audio already played out) is back to listening.
        if (!pending.length && !this.running && !this.playing.size) this.orb.setState('listening');
        if (pending.length) {
          void Promise.all(pending).then(() => {
            if (!this.closed) this.ws?.send(JSON.stringify({ type: 'response.create' }));
          });
        }
        break;
      }
      case 'error':
        console.warn('[voice]', event.error ?? event);
        break;
    }
  }

  private reference?: Promise<SyntaxEntry[]>;
  /** The syntax manual, fetched once per session on first use (it is the site's own /llms.txt). */
  private syntax(): Promise<SyntaxEntry[]> {
    this.reference ??= fetch('/llms.txt')
      .then(res => (res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(syntaxEntries);
    // A failed load may be retried on the next call.
    this.reference.catch(() => (this.reference = undefined));
    return this.reference;
  }

  private play(samples: Float32Array) {
    const ctx = this.ctx;
    if (!ctx || !samples.length) return;
    const buffer = ctx.createBuffer(1, samples.length, RATE);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.out ?? ctx.destination);
    this.playhead = Math.max(this.playhead, ctx.currentTime + 0.02);
    src.start(this.playhead);
    this.playhead += buffer.duration;
    this.playing.add(src);
    src.onended = () => {
      this.playing.delete(src);
      if (!this.playing.size && !this.running) this.orb.setState('listening');
    };
  }

  private interrupt() {
    for (const src of this.playing) src.stop();
    this.playing.clear();
    this.playhead = 0;
  }

  stop(reason?: string) {
    this.release();
    if (this.closed) return;
    this.closed = true;
    this.onState('idle', reason);
  }

  /** Frees whatever has been acquired so far; safe to call repeatedly. */
  private release() {
    this.orb.hide();
    this.interrupt();
    if (this.ws) {
      this.ws.onopen = this.ws.onclose = this.ws.onerror = this.ws.onmessage = null;
      this.ws.close();
    }
    this.mic?.getTracks().forEach(t => t.stop());
    if (this.ctx && this.ctx.state !== 'closed') void this.ctx.close();
  }
}

/** Shows the mic button on unlocked browsers and wires it to a session. */
export function initVoice(button: HTMLButtonElement, host: VoiceHost) {
  let passphrase = readPassphrase();
  if (!passphrase || !navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') return;
  button.hidden = false;
  let session: Session | null = null;

  const setState = (state: 'connecting' | 'live' | 'idle', reason?: string) => {
    button.classList.toggle('connecting', state === 'connecting');
    button.classList.toggle('live', state === 'live');
    button.setAttribute('aria-pressed', state === 'idle' ? 'false' : 'true');
    button.title = state === 'idle' ? 'Voice mode: describe a graph out loud' : 'Stop voice mode';
    if (state === 'idle') session = null;
    if (reason) host.notice(reason);
    passphrase = readPassphrase();
    if (!passphrase) button.hidden = true;
  };

  button.addEventListener('click', () => {
    if (session) return session.stop();
    if (!passphrase) return;
    session = new Session(host, passphrase, setState);
    void session.start();
  });
  addEventListener('pagehide', () => session?.stop());
}
