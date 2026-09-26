/** Outward-rounded interval arithmetic and a bounded Krawczyk certificate.
 * Proofs cover the supplied closed box, for real arithmetic on the expression's
 * binary64 literals/parameters. Unsupported functions remain unresolved.
 * No numeric solver result is promoted to a certificate by residual size. */
import type { Expr } from './expr.ts';
import { solveLinear, solveSystem } from './solve.ts';
import { exceedsNodes } from './size.ts';
export type Interval = [number, number];
const whole = (): Interval => [-Infinity, Infinity];
// The float's bits as two 32-bit words (low word first on little-endian
// hosts): stepping them is one ulp, without BigInt.
const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
const LOW = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 0 : 1;
/** |x|·STEP lies strictly between half an ulp of x and a whole one, so
 *  x ± |x|·STEP rounds to the neighbouring float (normal x). */
const STEP = 2 ** -53 + 2 ** -105;
export function nextFloat(x: number, up: boolean): number {
  if (Number.isNaN(x) || x === (up ? Infinity : -Infinity)) return x;
  if (x === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const a = Math.abs(x);
  if (a > 2 ** -1000 && a < Infinity) {
    const y = up ? x + a * STEP : x - a * STEP;
    if (y !== x) return y;
  }
  return stepBits(x, up);
}
function stepBits(x: number, up: boolean): number {
  f64[0] = x;
  if (x > 0 === up) {
    u32[LOW] = (u32[LOW] + 1) >>> 0;
    if (u32[LOW] === 0) u32[1 - LOW]++;
  } else {
    if (u32[LOW] === 0) u32[1 - LOW]--;
    u32[LOW] = (u32[LOW] - 1) >>> 0;
  }
  return f64[0];
}
const point = (v: number): Interval => (Number.isFinite(v) ? [v, v] : whole());
const outward = (lo: number, hi: number): Interval =>
  Number.isNaN(lo) || Number.isNaN(hi) ? whole() : [nextFloat(lo, false), nextFloat(hi, true)];
/** Adding exactly 0 is exact: no widening (x^2 − 0 < 0 stays provably false). */
export const iadd = (a: Interval, b: Interval): Interval =>
  b[0] === 0 && b[1] === 0 ? a : a[0] === 0 && a[1] === 0 ? b : outward(a[0] + b[0], a[1] + b[1]);
export const ineg = (a: Interval): Interval => [-a[1], -a[0]];
export const isub = (a: Interval, b: Interval): Interval => iadd(a, ineg(b));
/** An endpoint product, with 0·∞ = 0: an interval holds reals, so an
 *  infinite end is a limit, and 0 times any real is 0. */
const endMul = (p: number, q: number): number => (p === 0 || q === 0 ? 0 : p * q);
export const imul = (a: Interval, b: Interval): Interval => {
  if ((a[0] === 0 && a[1] === 0) || (b[0] === 0 && b[1] === 0)) return [0, 0];
  const p = endMul(a[0], b[0]);
  const q = endMul(a[0], b[1]);
  const r = endMul(a[1], b[0]);
  const t = endMul(a[1], b[1]);
  return outward(Math.min(p, q, r, t), Math.max(p, q, r, t));
};
const idiv = (a: Interval, b: Interval): Interval =>
  b[0] <= 0 && b[1] >= 0 ? whole() : imul(a, outward(1 / b[1], 1 / b[0]));
const excludesZero = (v: Interval) => v[0] > 0 || v[1] < 0;
interface AD {
  valid: boolean;
  value: Interval;
  jac: Interval[];
}

/** Interval automatic differentiation keeps rounding in the derivative proof
 * too; a symbolic simplifier's rounded coefficients cannot weaken enclosure. */
function intervalAD(e: Expr, names: string[], box: Interval[], env: Record<string, number>): AD {
  const scalar = (value: Interval): AD => ({ valid: true, value, jac: names.map(() => [0, 0]) });
  const bad = (): AD => ({ valid: false, value: whole(), jac: names.map(whole) });
  const multiply = (a: AD, b: AD): AD =>
    !a.valid || !b.valid
      ? bad()
      : {
          valid: true,
          value: imul(a.value, b.value),
          jac: a.jac.map((v, k) => iadd(imul(v, b.value), imul(a.value, b.jac[k]))),
        };
  const rec = (e: Expr) => intervalAD(e, names, box, env);
  switch (e.kind) {
    case 'num':
      return Number.isFinite(e.value) ? scalar(point(e.value)) : bad();
    case 'var': {
      const k = names.indexOf(e.name);
      if (k < 0) return Number.isFinite(env[e.name]) ? scalar(point(env[e.name])) : bad();
      const a = scalar(box[k]);
      a.jac[k] = [1, 1];
      return a;
    }
    case 'neg': {
      const a = rec(e.a);
      return { valid: a.valid, value: ineg(a.value), jac: a.jac.map(ineg) };
    }
    case 'eq': {
      const a = rec(e.l),
        b = rec(e.r);
      return { valid: a.valid && b.valid, value: isub(a.value, b.value), jac: a.jac.map((v, k) => isub(v, b.jac[k])) };
    }
    case 'bin': {
      const a = rec(e.a);
      if (!a.valid) return bad();
      if (e.op === '^') {
        if (e.b.kind !== 'num' || !Number.isInteger(e.b.value) || Math.abs(e.b.value) > 32) return bad();
        let p = scalar([1, 1]);
        for (let i = 0; i < Math.abs(e.b.value); i++) p = multiply(p, a);
        if (e.b.value >= 0) return p;
        if (!excludesZero(p.value)) return bad();
        return {
          valid: true,
          value: idiv([1, 1], p.value),
          jac: p.jac.map(v => ineg(idiv(v, imul(p.value, p.value)))),
        };
      }
      const b = rec(e.b);
      if (!b.valid) return bad();
      if (e.op === '*') return multiply(a, b);
      if (e.op === '+' || e.op === '-') {
        const op = e.op === '+' ? iadd : isub;
        return { valid: true, value: op(a.value, b.value), jac: a.jac.map((v, k) => op(v, b.jac[k])) };
      }
      if (!excludesZero(b.value)) return bad();
      return {
        valid: true,
        value: idiv(a.value, b.value),
        jac: a.jac.map((v, k) => idiv(isub(imul(v, b.value), imul(a.value, b.jac[k])), imul(b.value, b.value))),
      };
    }
    default:
      return bad();
  }
}
/** x^n for a whole n ≥ 0: even powers of an interval that holds 0 start at 0,
 *  which repeated multiplication (x·x over [-1, 1] is [-1, 1]) loses. */
function ipow(a: Interval, n: number): Interval {
  if (n === 0) return [1, 1];
  let p: Interval = a;
  for (let i = 1; i < n; i++) p = imul(p, a);
  if (n % 2 === 0 && a[0] < 0 && a[1] > 0) return [0, p[1]];
  if (n % 2 === 0 && a[1] <= 0) return [p[0] < 0 ? 0 : p[0], p[1]];
  return p;
}

/** f over [a, b] for an increasing f, rounded outward. */
const rising = (f: (x: number) => number, a: Interval): Interval => outward(f(a[0]), f(a[1]));

/** sin over [a, b]: the ends, and ±1 wherever a peak or trough falls inside. */
function isin(a: Interval, shift = 0): Interval {
  const lo = a[0] + shift;
  const hi = a[1] + shift;
  if (!(hi - lo < 2 * Math.PI)) return [-1, 1];
  let min = Math.min(Math.sin(lo), Math.sin(hi));
  let max = Math.max(Math.sin(lo), Math.sin(hi));
  // Peaks at π/2 + 2πk, troughs at 3π/2 + 2πk.
  if (Math.ceil((lo - Math.PI / 2) / (2 * Math.PI)) <= Math.floor((hi - Math.PI / 2) / (2 * Math.PI))) max = 1;
  if (Math.ceil((lo - 1.5 * Math.PI) / (2 * Math.PI)) <= Math.floor((hi - 1.5 * Math.PI) / (2 * Math.PI))) min = -1;
  return [Math.max(-1, nextFloat(min, false)), Math.min(1, nextFloat(max, true))];
}

/**
 * The values `e` takes over a box, without derivatives: the enclosure a
 * quadtree prunes by (lib/measure.ts). Wider than intervalAD's set of forms —
 * the elementary functions a filter is usually written with — and a form it
 * does not know encloses as the whole line, which only costs subdivision.
 * Infinite box sides are allowed, so a strip out to ∞ can be tested too.
 */
export function intervalValue(
  e: Expr,
  names: readonly string[],
  box: readonly Interval[],
  env: Record<string, number>,
): Interval {
  return intervalFn(e, names, env)(box);
}

type IFn = (box: readonly Interval[]) => Interval;

/** intervalValue compiled once for many boxes (a quadtree's cells). */
export function intervalFn(e: Expr, names: readonly string[], env: Record<string, number>): IFn {
  const rec = (x: Expr) => intervalFn(x, names, env);
  switch (e.kind) {
    case 'num': {
      const v = point(e.value);
      return () => v;
    }
    case 'var': {
      const k = names.indexOf(e.name);
      if (k >= 0) return box => box[k];
      const v = Object.hasOwn(env, e.name) ? point(env[e.name]) : whole();
      return () => v;
    }
    case 'neg': {
      const a = rec(e.a);
      return box => ineg(a(box));
    }
    case 'bin': {
      const fa = rec(e.a);
      if (e.op === '^') {
        const q = e.b.kind === 'num' ? e.b.value : NaN;
        if (Number.isInteger(q) && Math.abs(q) <= 64) {
          return box => {
            const p = ipow(fa(box), Math.abs(q));
            return q >= 0 ? p : idiv([1, 1], p);
          };
        }
        const fb = rec(e.b);
        return box => {
          const a = fa(box);
          // A fixed real power of a non-negative base rises (or falls) with it.
          if (!Number.isNaN(q) && a[0] >= 0) {
            const ends = [a[0] ** q, a[1] ** q];
            return outward(Math.min(...ends), Math.max(...ends));
          }
          const b = fb(box);
          // A constant positive base, as in 2^x: rising or falling in the power.
          if (a[0] > 0 && a[0] === a[1] && Number.isFinite(b[0]) && Number.isFinite(b[1])) {
            const ends = [a[0] ** b[0], a[0] ** b[1]];
            return outward(Math.min(...ends), Math.max(...ends));
          }
          return whole();
        };
      }
      const fb = rec(e.b);
      const op = e.op === '+' ? iadd : e.op === '-' ? isub : e.op === '*' ? imul : idiv;
      return box => op(fa(box), fb(box));
    }
    case 'call': {
      const args = e.args.map(rec);
      if ((e.name === 'min' || e.name === 'max') && args.length >= 2) {
        const pick = e.name === 'min' ? Math.min : Math.max;
        return box => {
          const vs = args.map(f => f(box));
          return [pick(...vs.map(v => v[0])), pick(...vs.map(v => v[1]))];
        };
      }
      const one = args.length === 1 ? unary(e.name) : null;
      if (!one) return () => whole();
      const [fa] = args;
      return box => one(fa(box));
    }
    default:
      return () => whole();
  }
}

/** A one-argument function over an interval, or null when not known. */
function unary(name: string): ((a: Interval) => Interval) | null {
  switch (name) {
    case 'sqrt':
      return a => (a[1] < 0 ? whole() : rising(Math.sqrt, [Math.max(0, a[0]), a[1]]));
    case 'exp':
      return a => rising(Math.exp, a);
    case 'ln':
    case 'log': {
      const base = name === 'log' ? Math.LN10 : 1;
      return a => (a[1] <= 0 ? whole() : rising(x => Math.log(x) / base, [Math.max(0, a[0]), a[1]]));
    }
    case 'atan':
      return a => rising(Math.atan, a);
    // Steps rise too, and exactly: no rounding to widen.
    case 'floor':
      return a => [Math.floor(a[0]), Math.floor(a[1])];
    case 'ceil':
      return a => [Math.ceil(a[0]), Math.ceil(a[1])];
    case 'round':
      return a => [Math.round(a[0]), Math.round(a[1])];
    case 'sign':
      return a => [Math.sign(a[0]), Math.sign(a[1])];
    case 'tanh':
      return a => rising(Math.tanh, a);
    case 'sinh':
      return a => rising(Math.sinh, a);
    case 'abs':
      return a => (a[0] >= 0 ? a : a[1] <= 0 ? ineg(a) : [0, Math.max(-a[0], a[1])]);
    case 'cosh':
      return a => {
        const ends = [Math.cosh(a[0]), Math.cosh(a[1])];
        return outward(a[0] < 0 && a[1] > 0 ? 1 : Math.min(...ends), Math.max(...ends));
      };
    case 'sin':
      return a => isin(a);
    case 'cos':
      return a => isin(a, Math.PI / 2);
    case 'tan':
      return a => {
        // Rising between poles; a pole inside (or too wide to tell) is the whole line.
        const k = Math.floor(a[0] / Math.PI + 0.5);
        if (!(a[1] - a[0] < Math.PI) || Math.floor(a[1] / Math.PI + 0.5) !== k) return whole();
        const lo = Math.tan(a[0]);
        const hi = Math.tan(a[1]);
        return lo <= hi ? outward(lo, hi) : whole();
      };
    case 'asin':
    case 'acos':
      return a => {
        if (a[1] < -1 || a[0] > 1) return whole();
        const c: Interval = [Math.max(-1, a[0]), Math.min(1, a[1])];
        return name === 'asin' ? rising(Math.asin, c) : outward(Math.acos(c[1]), Math.acos(c[0]));
      };
    default:
      return null;
  }
}

/** Calls intervalValue encloses (anything else is the whole line). */
const KNOWN_CALLS = new Set([
  'sqrt',
  'exp',
  'ln',
  'log',
  'atan',
  'floor',
  'ceil',
  'round',
  'sign',
  'tanh',
  'sinh',
  'abs',
  'cosh',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
]);

/** Whether intervalValue encloses `e` tightly enough to decide anything: an
 *  unknown function makes every enclosure the whole line, which proves
 *  nothing (so a measure built on it could never be certified). */
export function intervalKnows(e: Expr): boolean {
  switch (e.kind) {
    case 'num':
    case 'var':
      return true;
    case 'neg':
      return intervalKnows(e.a);
    case 'bin':
      return intervalKnows(e.a) && intervalKnows(e.b);
    case 'call':
      return (
        ((KNOWN_CALLS.has(e.name) && e.args.length === 1) ||
          ((e.name === 'min' || e.name === 'max') && e.args.length >= 2)) &&
        e.args.every(intervalKnows)
      );
    default:
      return false;
  }
}

function determinant(m: Interval[][]): Interval {
  if (m.length === 2) return isub(imul(m[0][0], m[1][1]), imul(m[0][1], m[1][0]));
  return m[0].reduce(
    (sum, v, k) => {
      const minor = m.slice(1).map(row => row.filter((_, c) => c !== k));
      return iadd(sum, imul(k % 2 ? ineg(v) : v, determinant(minor)));
    },
    [0, 0] as Interval,
  );
}
export interface Certification {
  roots: number[][];
  /** Each enclosure has an existence and uniqueness proof. */
  enclosures: Interval[][];
  complete: boolean;
  unresolved: number;
  visited: number;
}

type Krawczyk = { kind: 'none' } | { kind: 'root'; enclosure: Interval[] } | { kind: 'unknown' };

/** The Krawczyk test on one box: no zero there, exactly one (inside the
 *  returned enclosure), or undecided. */
function krawczyk(residuals: Expr[], names: string[], box: Interval[], env: Record<string, number>): Krawczyk {
  const n = names.length;
  const f = residuals.map(e => intervalAD(e, names, box, env));
  if (f.some(a => a.valid && excludesZero(a.value))) return { kind: 'none' };
  const mid = box.map(([a, b]) => a / 2 + b / 2);
  const atMid = residuals.map(e => intervalAD(e, names, mid.map(point), env));
  const jm = atMid.map(a => a.jac.map(([a, b]) => a / 2 + b / 2));
  const cols = Array.from({ length: n }, (_, k) =>
    solveLinear(
      jm,
      names.map((_, j) => +(k === j)),
      n,
    ),
  );
  if (!f.every(a => a.valid) || !atMid.every(a => a.valid) || !cols.every(c => c && c.every(Number.isFinite))) {
    return { kind: 'unknown' };
  }
  const c = names.map((_, i) => cols.map(col => point(col![i])));
  if (!excludesZero(determinant(c))) return { kind: 'unknown' };
  const r = names.map((_, i) =>
    names.map((_, j) =>
      isub(
        point(+(i === j)),
        c[i].reduce((sum, v, k) => iadd(sum, imul(v, f[k].jac[j])), [0, 0] as Interval),
      ),
    ),
  );
  const kraw = mid.map((m, i) => {
    const center = isub(
      point(m),
      c[i].reduce((sum, v, j) => iadd(sum, imul(v, atMid[j].value)), [0, 0] as Interval),
    );
    return r[i].reduce((sum, v, j) => iadd(sum, imul(v, isub(box[j], point(mid[j])))), center);
  });
  // K disjoint from X excludes a zero; strict containment and a
  // contraction prove one unique zero of the original equations.
  if (kraw.some((v, i) => v[0] > box[i][1] || v[1] < box[i][0])) return { kind: 'none' };
  const contraction = r.every(
    row => row.reduce((sum, v) => nextFloat(sum + Math.max(Math.abs(v[0]), Math.abs(v[1])), true), 0) < 1,
  );
  if (contraction && kraw.every((v, i) => v[0] > box[i][0] && v[1] < box[i][1])) {
    return { kind: 'root', enclosure: kraw };
  }
  return { kind: 'unknown' };
}

const within = (inner: Interval[], outer: Interval[]): boolean =>
  inner.every((v, k) => v[0] >= outer[k][0] && v[1] <= outer[k][1]);

/** Widths of the boxes tried around a seed, relative to max(1, |seed|). */
const SEED_RADII = [1e-9, 1e-7, 1e-5, 1e-4, 1e-3, 1e-2, 0.03, 0.1, 0.3];

/**
 * Prove roots of a square system in the box [lo, hi]. `seeds` are approximate
 * roots (from the numeric solver): each only chooses a small box around it to
 * test, widened while the test still proves a unique root there, so a root
 * the subdivision would only reach after exhausting its budget elsewhere is
 * still certified. Subdivision then skips boxes inside those proven regions.
 */
export function certifySystem(
  residuals: Expr[],
  names: string[],
  lo: number[],
  hi: number[],
  env: Record<string, number> = {},
  maxBoxes = 2048,
  seeds: readonly number[][] = [],
): Certification {
  const n = names.length;
  const result: Certification = { roots: [], enclosures: [], complete: false, unresolved: 0, visited: 0 };
  if (
    residuals.length !== n ||
    (n !== 2 && n !== 3) ||
    lo.length !== n ||
    hi.length !== n ||
    lo.some((v, k) => !Number.isFinite(v) || !Number.isFinite(hi[k]) || !(v < hi[k]))
  )
    throw new Error('Certification needs a finite box and a square 2D or 3D system.');
  if (residuals.some(e => exceedsNodes(e, 2048)))
    throw new Error('Certification accepts at most 2048 expression nodes per equation.');
  // Boxes each proven to hold exactly one root: result.roots[k] is in unique[k].
  const unique: Interval[][] = [];
  const record = (box: Interval[], enclosure: Interval[], guess: number[]): void => {
    // The same root proven twice: its enclosure lies in the other's box.
    if (unique.some((u, k) => within(enclosure, u) || within(result.enclosures[k], box))) return;
    const numeric = solveSystem(
      residuals,
      names,
      box.map(v => v[0]),
      box.map(v => v[1]),
      { env, seeds: [guess], lattice: false, margin: 0 },
    );
    result.roots.push(numeric[0] ?? enclosure.map(([a, b]) => a / 2 + b / 2));
    result.enclosures.push(enclosure);
    unique.push(box);
  };
  for (const seed of seeds) {
    if (seed.length !== n || !seed.every((v, k) => v >= lo[k] && v <= hi[k])) continue;
    if (unique.some(u => within(seed.map(point), u))) continue;
    const scale = Math.max(1, ...seed.map(Math.abs));
    let proven: { box: Interval[]; enclosure: Interval[] } | null = null;
    for (const radius of SEED_RADII) {
      const box = seed.map((v, k): Interval => [
        Math.max(lo[k], v - radius * scale),
        Math.min(hi[k], v + radius * scale),
      ]);
      const test = krawczyk(residuals, names, box, env);
      if (test.kind !== 'root') {
        if (proven) break;
        continue;
      }
      proven = { box, enclosure: test.enclosure };
    }
    if (proven) record(proven.box, proven.enclosure, seed);
  }
  const pending: Array<{ box: Interval[]; depth: number }> = [{ box: lo.map((v, k) => [v, hi[k]]), depth: 0 }];
  while (pending.length && result.visited < Math.min(8192, Math.max(1, maxBoxes))) {
    const { box, depth } = pending.pop()!;
    result.visited++;
    if (unique.some(u => within(box, u))) continue;
    const test = krawczyk(residuals, names, box, env);
    if (test.kind === 'none') continue;
    if (test.kind === 'root') {
      record(
        box,
        test.enclosure,
        box.map(([a, b]) => a / 2 + b / 2),
      );
      continue;
    }
    const widths = box.map(([a, b], k) => (b - a) / (hi[k] - lo[k]));
    const axis = widths.indexOf(Math.max(...widths));
    const split = box[axis][0] + 0.493 * (box[axis][1] - box[axis][0]);
    if (depth >= 36 || split <= box[axis][0] || split >= box[axis][1]) {
      result.unresolved++;
      continue;
    }
    const a = box.map(v => [...v] as Interval),
      b = box.map(v => [...v] as Interval);
    a[axis][1] = split;
    b[axis][0] = split;
    pending.push({ box: a, depth: depth + 1 }, { box: b, depth: depth + 1 });
  }
  result.unresolved += pending.length;
  result.complete = result.unresolved === 0;
  return result;
}
