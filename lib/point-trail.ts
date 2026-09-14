/** Observed motion, never a re-evaluation of past state. Limits bound both
 * memory and draw work, even for graphs left animating indefinitely. */
export class PointTrail {
  private samples: { time: number; point: number[] }[] = [];
  private lastTime = -Infinity;
  private pendingBreak = false;
  head: number[] | null = null;

  constructor(readonly dim: 2 | 3, readonly seconds = 30, readonly capacity = 2048) {}

  sample(time: number, point: number[]): void {
    if (!Number.isFinite(time)) return;
    if (time < this.lastTime) {
      this.samples = [];
      this.lastTime = -Infinity;
      this.pendingBreak = false;
    }
    this.head = point.length === this.dim && point.every(Number.isFinite) ? [...point] : null;
    // Remember invalid positions even when this frame is not sampled.
    if (!this.head) this.pendingBreak = true;
    // At most 60 samples/s, regardless of display refresh rate.
    if (time - this.lastTime < 1 / 60) return;
    // A suspended tab or an undefined position breaks the line. Connecting
    // its endpoints would invent a trajectory that was never observed.
    if ((time - this.lastTime > 0.5 || (this.pendingBreak && this.head)) && this.samples.length) {
      this.samples.push({ time, point: Array(this.dim).fill(NaN) });
    }
    this.samples.push({ time, point: this.head ? [...this.head] : Array(this.dim).fill(NaN) });
    this.pendingBreak = false;
    this.lastTime = time;
    while (this.samples.length > this.capacity || (this.samples.length && this.samples[0].time < time - this.seconds)) {
      this.samples.shift();
    }
  }

  coordinates(dim: 2 | 3 = this.dim): number[] {
    return this.samples.flatMap(({ point }) => dim === 3 && this.dim === 2
      ? [point[0], point[1], Number.isFinite(point[0]) ? 0 : NaN]
      : point.slice(0, dim));
  }
}
