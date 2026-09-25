/** Outward-rounded interval arithmetic and a bounded Krawczyk certificate.
 * Proofs cover the supplied closed box, for real arithmetic on the expression's
 * binary64 literals/parameters. Unsupported functions remain unresolved.
 * No numeric solver result is promoted to a certificate by residual size. */
import type { Expr } from './expr.ts';
import { solveLinear, solveSystem } from './solve.ts';
import { exceedsNodes } from './size.ts';
export type Interval = [number, number];
const whole = (): Interval => [-Infinity, Infinity];
const bits = new DataView(new ArrayBuffer(8));
export function nextFloat(x: number, up: boolean): number {
  if (Number.isNaN(x) || x === (up ? Infinity : -Infinity)) return x;
  if (x === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
  bits.setFloat64(0, x);
  bits.setBigUint64(0, bits.getBigUint64(0) + (x > 0 === up ? 1n : -1n));
  return bits.getFloat64(0);
}
const point = (v: number): Interval => (Number.isFinite(v) ? [v, v] : whole());
const outward = (lo: number, hi: number): Interval =>
  Number.isNaN(lo) || Number.isNaN(hi) ? whole() : [nextFloat(lo, false), nextFloat(hi, true)];
export const iadd = (a: Interval, b: Interval): Interval => outward(a[0] + b[0], a[1] + b[1]);
export const ineg = (a: Interval): Interval => [-a[1], -a[0]];
export const isub = (a: Interval, b: Interval): Interval => iadd(a, ineg(b));
export const imul = (a: Interval, b: Interval): Interval => {
  if ((a[0] === 0 && a[1] === 0) || (b[0] === 0 && b[1] === 0)) return [0, 0];
  const v = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]];
  return outward(Math.min(...v), Math.max(...v));
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
