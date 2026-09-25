/**
 * Voice mode: talk to an OpenAI Realtime model and it edits the graph.
 *
 * Audio goes over WebRTC between the browser and OpenAI. The page never holds
 * an OpenAI credential: it opens a control WebSocket to the Worker and sends
 * its offer with a credit key, and the Worker creates the call, meters it, and
 * hangs up when the key's credit runs out or the socket closes
 * (worker/voice-call.ts). Events and tool calls travel over the call's data
 * channel; screenshots over the control socket.
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
 * The feature needs a credit key (scripts/voice-key.ts). A browser is unlocked
 * by visiting any page with `?voice=<key>` once: the key is kept in
 * localStorage and sent with each request, and the mic button stays hidden
 * everywhere else.
 */
import type { PublicKind } from '../lib/math-object.ts';
import { type SyntaxEntry, searchSyntax, syntaxEntries } from '../lib/syntax-search.ts';

const STORE_KEY = 'voiceKey';
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
      await ctx.attach(image, screenshotContext(host.graph()));
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

function readKey(): string | null {
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

function forgetKey() {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    // Storage blocked: nothing was remembered.
  }
}

/** A balance in micro-dollars, for people: "$4.21". */
export const dollars = (micros: number) => `$${(Math.max(0, micros) / 1e6).toFixed(2)}`;

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

  constructor(
    private host: VoiceHost,
    onTap: () => void,
  ) {
    this.el.className = 'voice-orb';
    this.el.setAttribute('aria-hidden', 'true');
    this.el.title = 'Tap to interrupt';
    this.el.append(document.createElement('span'));
    // Clickable only while speaking (style.css): voices don't interrupt it.
    this.el.addEventListener('click', onTap);
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
  private pc?: RTCPeerConnection;
  private dc?: RTCDataChannel;
  private ctx?: AudioContext;
  private mic?: MediaStream;
  private speaker = new Audio();
  /** The Worker's control socket: the call lives exactly as long as it does (worker/voice-call.ts). */
  private control?: WebSocket;
  /** Why the Worker ended the call, once it says. */
  private endReason?: string;
  /** Screenshots on their way into the conversation, by id. */
  private images = new Map<string, (error?: string) => void>();
  /** Tool calls of the current response, still running. */
  private pendingTools: Promise<void>[] = [];
  private transcript = '';
  private orb: Orb;
  /** Tool calls still running, across responses: the orb thinks until they finish. */
  private running = 0;
  /** The model's audio is playing: set by the server's output_audio_buffer events. */
  private speaking = false;
  closed = false;

  constructor(
    private host: VoiceHost,
    private key: string,
    private onState: (state: 'connecting' | 'live' | 'idle', reason?: string) => void,
  ) {
    this.orb = new Orb(host, () => this.interrupt());
    this.speaker.autoplay = true;
  }

  async start() {
    this.onState('connecting');
    try {
      // Both need the click's user activation, so ask before any await on the network.
      this.ctx = new AudioContext();
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      // Stopped while the permission prompt was up: stop() ran before there was a mic to release.
      if (this.closed) return this.release();

      const pc = new RTCPeerConnection();
      this.pc = pc;
      const micLevel = this.ctx.createAnalyser();
      this.ctx.createMediaStreamSource(this.mic).connect(micLevel);
      const out = this.ctx.createAnalyser();
      pc.ontrack = e => {
        // The <audio> element plays it; the analyser only lets the orb pulse with it.
        this.speaker.srcObject = e.streams[0];
        this.ctx?.createMediaStreamSource(e.streams[0]).connect(out);
      };
      pc.addTrack(this.mic.getTracks()[0], this.mic);
      const dc = pc.createDataChannel('oai-events');
      this.dc = dc;
      dc.onmessage = e => this.onEvent(JSON.parse(e.data as string));
      dc.onopen = () => {
        this.onState('live');
        this.orb.show(micLevel, out);
      };
      dc.onclose = () => this.stop(this.reasonText());
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.stop(this.reasonText());
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const answer = await this.connect(offer.sdp!);
      if (this.closed) return this.release();
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    } catch (e) {
      const denied = e instanceof DOMException && e.name === 'NotAllowedError';
      this.stop(denied ? 'Microphone access is needed for voice mode.' : e instanceof Error ? e.message : String(e));
    }
  }

  /** Opens the control socket and trades the offer (and key) for the call's answer. */
  private connect(sdp: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const control = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/api/voice/connect`);
      this.control = control;
      let answered = false;
      control.onopen = () => control.send(JSON.stringify({ type: 'start', key: this.key, sdp }));
      control.onmessage = e => {
        const message = JSON.parse(e.data as string) as { type: string; [k: string]: any };
        if (message.type === 'answer') {
          answered = true;
          resolve(message.sdp);
        } else if (message.type === 'refused') {
          reject(new Error(this.refusal(message.error, message.balance_micros)));
        } else if (message.type === 'image.done') {
          this.images.get(message.id)?.(message.error);
        } else if (message.type === 'ended') {
          this.endReason = message.reason;
        }
      };
      control.onclose = () => {
        if (!answered) reject(new Error('Could not start a voice session.'));
        else this.stop(this.reasonText());
      };
    });
  }

  /** Why the Worker would not start a call, in words. */
  private refusal(error: string, balance?: number): string {
    if (error === 'forbidden') {
      forgetKey();
      return 'Voice key not recognised.';
    }
    if (error === 'no_credit') {
      return `Voice credit used up${balance === undefined ? '' : ` (${dollars(balance)} left)`}.`;
    }
    if (error === 'too_many_calls') return 'Voice mode is already running elsewhere with this key.';
    return 'Could not start a voice session.';
  }

  /** Why the call ended, when it wasn't the student's doing. */
  private reasonText(): string | undefined {
    if (this.endReason === 'out of credit') return 'Voice credit used up.';
    if (this.endReason === 'time limit') return 'Voice calls end after 30 minutes.';
    return undefined;
  }

  private send(event: object) {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(event));
  }

  private onEvent(event: { type: string; [k: string]: any }) {
    switch (event.type) {
      case 'output_audio_buffer.started':
        this.speaking = true;
        this.orb.setState('speaking');
        break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        this.speaking = false;
        if (!this.running) this.orb.setState('listening');
        break;
      case 'input_audio_buffer.speech_started':
        // Speech doesn't interrupt a reply (lib/voice-agent.ts): while the
        // model talks, it may be anyone in the room.
        if (this.speaking) break;
        // A new question means the old pointing is stale.
        this.orb.home();
        this.orb.setState('listening');
        break;
      case 'input_audio_buffer.speech_stopped':
        if (!this.speaking) this.orb.setState('thinking');
        break;
      case 'response.output_audio_transcript.delta':
        this.transcript += event.delta;
        this.host.notice(this.transcript);
        break;
      case 'response.function_call_arguments.done': {
        const { call_id, name } = event;
        this.orb.setState('thinking');
        this.running++;
        const run = runTool(this.host, name, event.arguments ?? '{}', {
          attach: (image, legend) => this.attach(image, legend),
          readSyntax: async query => searchSyntax(await this.syntax(), query),
          captured: (canvas, rect) => this.orb.absorb(canvas, rect),
          pointAt: (x, y, z, seconds) => this.orb.pointAt(x, y, z, seconds),
        }).then(output => {
          this.running--;
          if (this.closed) return;
          this.send({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id, output: JSON.stringify(output) },
          });
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
        // A turn that ended without speech is back to listening.
        if (!pending.length && !this.running && !this.speaking) this.orb.setState('listening');
        if (pending.length) {
          void Promise.all(pending).then(() => {
            if (!this.closed) this.send({ type: 'response.create' });
          });
        }
        break;
      }
      case 'error':
        console.warn('[voice]', event.error ?? event);
        break;
    }
  }

  /** The student tapped the orb: stop talking, and drop what was still to be said. */
  private interrupt() {
    if (!this.speaking) return;
    this.send({ type: 'response.cancel' });
    this.send({ type: 'output_audio_buffer.clear' });
    this.orb.home();
  }

  /** Screenshots go through the Worker's sideband: too large for a data channel message in every browser. */
  private attach(image: string, legend: string): Promise<void> {
    const control = this.control;
    if (control?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('the call has ended'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.images.set(id, error => {
        this.images.delete(id);
        if (error) reject(new Error(error));
        else resolve();
      });
      control.send(JSON.stringify({ type: 'image', id, image, legend }));
    });
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

  stop(reason?: string) {
    this.release();
    if (this.closed) return;
    this.closed = true;
    this.onState('idle', reason);
  }

  /** Frees whatever has been acquired so far; safe to call repeatedly. */
  private release() {
    this.orb.hide();
    if (this.dc) this.dc.onopen = this.dc.onclose = this.dc.onmessage = null;
    if (this.pc) {
      this.pc.ontrack = this.pc.onconnectionstatechange = null;
      this.pc.close();
    }
    if (this.control) {
      this.control.onopen = this.control.onmessage = this.control.onclose = null;
      // The Worker hangs the call up and settles its charges when this closes.
      this.control.close();
    }
    for (const settle of this.images.values()) settle('the call has ended');
    this.speaker.srcObject = null;
    this.mic?.getTracks().forEach(t => t.stop());
    if (this.ctx && this.ctx.state !== 'closed') void this.ctx.close();
  }
}

/** Shows the mic button on unlocked browsers and wires it to a session. */
export function initVoice(button: HTMLButtonElement, host: VoiceHost) {
  let key = readKey();
  if (!key || !navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') return;
  button.hidden = false;
  let session: Session | null = null;

  const setState = (state: 'connecting' | 'live' | 'idle', reason?: string) => {
    button.classList.toggle('connecting', state === 'connecting');
    button.classList.toggle('live', state === 'live');
    button.setAttribute('aria-pressed', state === 'idle' ? 'false' : 'true');
    button.title = state === 'idle' ? 'Voice mode: describe a graph out loud' : 'Stop voice mode';
    if (state === 'idle') session = null;
    if (reason) host.notice(reason);
    key = readKey();
    if (!key) button.hidden = true;
  };

  button.addEventListener('click', () => {
    if (session) return session.stop();
    if (!key) return;
    session = new Session(host, key, setState);
    void session.start();
  });
  addEventListener('pagehide', () => session?.stop());
}
