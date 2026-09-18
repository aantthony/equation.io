/**
 * The shaded area of a definite-integral row (`int[0..1] x^2 dx`): the region
 * between the integrand and the axis over [a, b], as CPU-sampled polygons.
 * The row still denotes the number — this is the picture of that number, the
 * same way `P(X < b)` is a readout that shades (prob.shade, lib/dist.ts).
 *
 * The integration variable runs along the horizontal axis whatever it is
 * called: `int[0..1] u^2 du` shades under the curve y = u² drawn over the
 * x-axis, exactly as if it had been written in x.
 */
import type { Expr } from './expr.ts';
import { evaluate } from './expr.ts';

/** What a `value` row carries when it is exactly one definite integral. */
export interface IntShade {
  /** The integrand, with the d<v> measure stripped. */
  body: Expr;
  /** The integration variable. */
  v: string;
  /** Bounds as written (resolved); ±inf stays the `inf` name — see boundValue. */
  lo: Expr;
  hi: Expr;
}

/**
 * Signed areas as closed polygons [x0, y0, x1, y1, …] in graph coordinates.
 * `pos` adds to the integral's VALUE and `neg` subtracts from it — so with
 * reversed bounds (`int[1..0]`, which negates the integral) the region above
 * the axis is `neg`. The tints follow the number the row reads out, not the
 * side of the axis.
 */
export interface ShadeAreas {
  pos: number[][];
  neg: number[][];
}

export interface ShadeWindow {
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
}

type RGB = [number, number, number];

/**
 * The tint for areas that subtract from the value: the row color's
 * complement, as signed scalar fields shade. A near-grey row color (the
 * palette's black / light slot) has a complement that IS the background, so
 * it takes a fixed red instead — legible on both themes.
 */
export function minusTint([r, g, b]: RGB): RGB {
  if (Math.max(r, g, b) - Math.min(r, g, b) < 0.2) return [0.85, 0.35, 0.3];
  return [1 - r, 1 - g, 1 - b];
}

/** Samples across the visible part of [a, b]. */
export const SHADE_SAMPLES = 400;
/** Bisection steps per zero crossing or domain edge: 2^-20 of a sample gap. */
const REFINE_STEPS = 20;
/**
 * Hard cap on integrand evaluations per call, refinements included. A wildly
 * oscillating integrand (`sin(1000 x)`) crosses zero between most samples;
 * once the refinement budget is spent the remaining crossings fall back to
 * the chord's zero, so an animated bound stays a bounded per-frame cost.
 */
export const SHADE_MAX_EVALS = 8 * SHADE_SAMPLES;

/** A bound's value: ±Infinity for ±inf, else evaluated (NaN when it cannot be). */
export function boundValue(e: Expr, env: Record<string, number>): number {
  if (e.kind === 'var' && e.name === 'inf') return Infinity;
  if (e.kind === 'neg' && e.a.kind === 'var' && e.a.name === 'inf') return -Infinity;
  try { return evaluate(e, env); } catch { return NaN; }
}

/**
 * Sample the region between f and the axis over [lo, hi], clipped to the
 * window: bounds at infinity or far off-screen cost nothing and resolution
 * stays per-pixel when zoomed in. Polygons break — never bridge — where f is
 * undefined (a pole's NaN, outside a no-default piecewise, sqrt of a
 * negative), and split exactly at sign changes, each refined by bisection.
 * y is clamped to one window-height beyond the window, which cannot change
 * the visible fill but keeps a pole's spike (and a far-off axis) drawable.
 */
export function integralAreas(
  f: (x: number) => number, lo: number, hi: number, win: ShadeWindow, n = SHADE_SAMPLES,
): ShadeAreas {
  const out: ShadeAreas = { pos: [], neg: [] };
  // NaN bounds compare false everywhere below and fall out here; lo == hi is
  // an empty region (and a zero integral).
  if (!(lo !== hi) || Number.isNaN(lo) || Number.isNaN(hi)) return out;
  const reversed = hi < lo;
  const a = Math.max(Math.min(lo, hi), win.xmin);
  const b = Math.min(Math.max(lo, hi), win.xmax);
  if (!(b > a) || !(win.ymax > win.ymin)) return out;
  const pad = win.ymax - win.ymin;
  const clampY = (y: number) => Math.min(Math.max(y, win.ymin - pad), win.ymax + pad);
  const base = clampY(0);

  let refineLeft = SHADE_MAX_EVALS - (n + 1);
  const at = (x: number): number => {
    let y: number;
    try { y = f(x); } catch { return NaN; }
    // ±Infinity is a pole sampled dead on: undefined there, like NaN.
    return Number.isFinite(y) ? y : NaN;
  };
  /** Claim one refinement's worth of evaluations, while the budget lasts. */
  const canRefine = (): boolean => {
    if (refineLeft < REFINE_STEPS) return false;
    refineLeft -= REFINE_STEPS;
    return true;
  };

  let cur: number[] | null = null;
  let curSign = 0;
  const open = (x: number, y: number) => {
    cur = [x, base, x, clampY(y)];
    curSign = Math.sign(y);
  };
  const push = (x: number, y: number) => {
    cur!.push(x, clampY(y));
    if (curSign === 0) curSign = Math.sign(y);
  };
  const close = () => {
    if (!cur) return;
    const x = cur[cur.length - 2];
    cur.push(x, base);
    // A run that never left the axis encloses nothing.
    if (curSign !== 0 && cur.length >= 8) (curSign > 0 !== reversed ? out.pos : out.neg).push(cur);
    cur = null;
    curSign = 0;
  };

  /** The last defined x toward xBad, starting from a defined xOk. */
  const edge = (xOk: number, yOk: number, xBad: number): [number, number] => {
    if (!canRefine()) return [xOk, yOk];
    for (let k = 0; k < REFINE_STEPS; k++) {
      const xm = (xOk + xBad) / 2;
      const ym = at(xm);
      if (Number.isNaN(ym)) xBad = xm;
      else { xOk = xm; yOk = ym; }
    }
    return [xOk, yOk];
  };

  let px = a;
  let py = at(a);
  if (!Number.isNaN(py)) open(px, py);
  for (let k = 1; k <= n; k++) {
    const x = k === n ? b : a + ((b - a) * k) / n;
    const y = at(x);
    const was = !Number.isNaN(py);
    const is = !Number.isNaN(y);
    if (was && !is) {
      const [ex, ey] = edge(px, py, x);
      if (ex !== px) push(ex, ey);
      close();
    } else if (!was && is) {
      const [ex, ey] = edge(x, y, px);
      open(ex, ey);
      if (ex !== x) push(x, y);
    } else if (was && is) {
      if (py * y < 0) {
        // A sign change: shrink the bracket to [xa, xb] and end one tint at
        // xa, start the other at xb. A continuous crossing has f ≈ 0 at both,
        // so the polygons meet on the axis; a jump (or a pole) keeps its two
        // one-sided values, and an undefined point inside splits the run.
        let xa = px, ya = py, xb = x, yb = y;
        if (canRefine()) {
          let xz = NaN; // an exact zero, or an undefined point, inside the bracket
          let hole = false;
          for (let s = 0; s < REFINE_STEPS; s++) {
            const xm = (xa + xb) / 2;
            const ym = at(xm);
            if (Number.isNaN(ym) || ym === 0) { xz = xm; hole = ym !== 0; break; }
            if (ym * ya > 0) { xa = xm; ya = ym; } else { xb = xm; yb = ym; }
          }
          if (hole) {
            [xa, ya] = edge(xa, ya, xz);
            [xb, yb] = edge(xb, yb, xz);
          } else if (!Number.isNaN(xz)) {
            xa = xb = xz;
            ya = yb = 0;
          }
          if (xa !== px) push(xa, ya);
          close();
          open(xb, yb);
          if (xb !== x) push(x, y);
        } else {
          const xc = px + ((x - px) * py) / (py - y);
          push(xc, 0);
          close();
          open(xc, 0);
          push(x, y);
        }
      } else {
        push(x, y);
        // A sample landing exactly on the axis ends the run, so the next one
        // takes its own sign (x^3 sampled at 0 must not span both tints).
        if (y === 0) { close(); open(x, 0); }
      }
    }
    px = x;
    py = y;
  }
  close();
  return out;
}

/** integralAreas for a row's shade under env (the integration variable is
 *  bound per sample, shadowing any constant or `t` of the same name). */
export function shadeAreas(shade: IntShade, env: Record<string, number>, win: ShadeWindow): ShadeAreas {
  const scope = { ...env };
  return integralAreas(
    x => { scope[shade.v] = x; return evaluate(shade.body, scope); },
    boundValue(shade.lo, env), boundValue(shade.hi, env), win,
  );
}
