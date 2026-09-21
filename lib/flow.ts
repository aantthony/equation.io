/** Bounded, dimension-independent RK4 streamlines. Time is held fixed: these
 * are integral curves of a field, not time-integrated simulation states. */
import { type Expr, freeVars } from './expr.ts';
import { compileProg, run, type Prog } from './vm.ts';
import { exceedsNodes } from './size.ts';

export const FLOW_SEEDS = 32;
export const FLOW_STEPS = 256;
export const FLOW_NODE_LIMIT = 8192;
/** Arrow glyphs per axis; a 3-vector field is an N×N×N lattice. */
export const FLOW_GLYPH_N = 9;

const EVAL_STACK = new Float64Array(32768);

export function fieldEvaluator(comps: Expr[], env: Record<string, number> = {}) {
  if (comps.some(c => exceedsNodes(c, FLOW_NODE_LIMIT))) throw new Error('This field is too large to trace (8192 nodes per component).');
  const names = new Set(comps.flatMap(c => [...freeVars(c)]));
  for (const axis of ['x', 'y', 'z']) names.add(axis);
  const slots = new Map([...names].map((n, k) => [n, k]));
  const values = new Float64Array(slots.size);
  for (const [n, i] of slots) values[i] = env[n] ?? 0;
  const programs: Prog[] = comps.map(c => compileProg(c, slots));
  const axes = ['x', 'y', 'z'].map(n => slots.get(n)!);
  return (p: number[]): number[] => {
    for (let k = 0; k < p.length; k++) values[axes[k]] = p[k];
    return programs.map(prog => run(prog, values, EVAL_STACK));
  };
}

export function streamline(f: (p: number[]) => number[], seed: number[], step: number,
  lo: number[], hi: number[], steps = FLOW_STEPS, metric = seed.map(() => 1)): number[][] {
  if (!seed.every(Number.isFinite) || !(step > 0)) return [];
  const direction = (p: number[]) => {
    const v = f(p), n = Math.hypot(...v.map((c, k) => c * metric[k]));
    return Number.isFinite(n) && n > 1e-12 ? v.map(c => c / n) : null;
  };
  const side = (sign: number) => {
    const path: number[][] = [];
    let p = seed.slice();
    const h = sign * step;
    const at = (v: number[], scale: number) => p.map((c, k) => c + h * scale * v[k]);
    for (let i = 0; i < Math.min(steps, 2048); i++) {
      const a = direction(p); if (!a) break;
      const b = direction(at(a, .5)); if (!b) break;
      const c = direction(at(b, .5)); if (!c) break;
      const d = direction(at(c, 1)); if (!d) break;
      const next = p.map((v, k) => v + h / 6 * (a[k] + 2 * b[k] + 2 * c[k] + d[k]));
      if (!next.every((v, k) => Number.isFinite(v) && v >= lo[k] && v <= hi[k])) break;
      if (Math.hypot(...next.map((v, k) => v - p[k])) < step * 1e-6) break;
      p = next; path.push(p);
    }
    return path;
  };
  return [...side(-1).reverse(), seed, ...side(1)];
}

/** Deterministic seeds, fixed work cap independent of the size of the view. */
export function traceField(comps: Expr[], lo: number[], hi: number[], env: Record<string, number> = {}, glyphs = false): number[][][] {
  const f = fieldEvaluator(comps, env);
  const span = Math.min(...hi.map((v, k) => v - lo[k]));
  if (!(span > 0) || !Number.isFinite(span)) return [];
  const paths: number[][][] = [];
  if (glyphs) {
    const n = FLOW_GLYPH_N;
    const count = n ** comps.length;
    const glyphLen = span * .28 / n;
    for (let i = 0; i < count; i++) {
      const seed = lo.map((v, k) => v + (hi[k] - v) * ((Math.floor(i / n ** k) % n + .5) / n));
      const v = f(seed), len = Math.hypot(...v);
      if (len > 1e-12 && Number.isFinite(len)) paths.push([seed, seed.map((c, k) => c + glyphLen * v[k] / len)]);
    }
  } else {
    let hash = 0x12345678;
    const random = () => { hash ^= hash << 13; hash ^= hash >>> 17; hash ^= hash << 5; return (hash >>> 0) / 4294967296; };
    for (let i = 0; i < FLOW_SEEDS; i++) {
      const seed = lo.map((v, k) => v + (hi[k] - v) * (.1 + .8 * random()));
      paths.push(streamline(f, seed, span / 180, lo, hi));
    }
  }
  return paths;
}
