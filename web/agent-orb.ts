/**
 * The agent's on-screen presence, shared by every conversation mode (web
 * Realtime voice, desktop voice and the desktop text agent): the orb, its
 * pointing, and the screenshot animation. Presentation only; no transport.
 */
import type { GraphHost } from '../packages/agent/src/host.ts';

export type OrbState = 'listening' | 'thinking' | 'speaking';

/**
 * The assistant's on-screen presence: an orb at the bottom centre that breathes with
 * the microphone while listening, shimmers while thinking, and ripples
 * outward with its own voice while speaking. It is also its pointer:
 * point_at flies it to a math coordinate, where it stays pinned through pans
 * and zooms until it is sent home.
 */
export class Orb {
  private el = document.createElement('div');
  private frame: number | null = null;
  private mic?: AnalyserNode;
  private out?: AnalyserNode;
  private buf = new Float32Array(512);
  private level = 0;
  private state: OrbState = 'listening';
  private target: { x: number; y: number; z?: number; until: number } | null = null;

  constructor(
    private host: Pick<GraphHost, 'toClient'>,
    onTap: () => void,
  ) {
    this.el.className = 'voice-orb';
    this.el.setAttribute('aria-hidden', 'true');
    this.el.title = 'Tap (or press Esc) to interrupt';
    this.el.append(document.createElement('span'));
    // Clickable only while speaking (style.css): voices don't interrupt it.
    this.el.addEventListener('click', onTap);
  }

  /** Without analysers (speech the page can't hear, e.g. the OS's) it breathes on its own while speaking. */
  show(mic?: AnalyserNode, out?: AnalyserNode) {
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
    const heard = this.state === 'speaking' ? this.out : this.mic;
    const raw = heard ? this.rms(heard) : this.state === 'speaking' ? 0.04 + 0.03 * Math.sin(now / 160) : 0;
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

/** Voice mode's way in: a resting orb at the bottom centre ("Talk to your graph"). */
export function idleOrb(): HTMLButtonElement {
  const start = document.createElement('button');
  start.type = 'button';
  start.className = 'voice-start';
  start.title = 'Voice mode: describe a graph out loud';
  const orb = document.createElement('span');
  orb.className = 'voice-start-orb';
  orb.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'voice-start-label';
  label.textContent = 'Talk to your graph';
  start.append(orb, label);
  document.body.append(start);
  return start;
}
