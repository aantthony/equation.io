/**
 * Glyphs: values with no position of their own, drawn as the figures that
 * show what they are.
 *
 * The picture of a multivector, grade by grade (docs/clifford.md): its vector
 * an arrow from the origin; its bivector an oriented disc of that area in its
 * plane, with an arrow round the rim for its sense of turn; its trivector a
 * cube of that volume. Each is an ordinary figure, so every renderer that
 * draws figures draws these.
 */
import { add, div, mul, neg, pow } from './diff.ts';
import type { Expr } from './expr.ts';
import { type Multivector, glyphParts } from './clifford.ts';

const num = (value: number): Expr => ({ kind: 'num', value });
const call = (name: string, ...args: Expr[]): Expr => ({ kind: 'call', name, args });
const figure = (form: 'vector' | 'polygon' | 'hull', dimension: 2 | 3, points: Expr[][]): Expr => ({
  kind: 'figure',
  form,
  dimension,
  vertices: points.flat(),
});

/** Vertices round the rim; how far round the arrow of turn goes, and how
 *  far in from the rim it runs, so it reads apart from the outline. */
const RIM = 48;
const TURN = 0.75;
const INSET = 0.6;

/** r (cos θ e1 + sin θ e2) for θ in [0, 2π·share], k steps. */
function arc(r: Expr, e1: Expr[], e2: Expr[], share: number, steps: number, sense: Expr = num(1)): Expr[][] {
  return Array.from({ length: steps + 1 }, (_, k) => {
    const th = (2 * Math.PI * share * k) / steps;
    const c = num(Math.cos(th));
    const s = mul(sense, num(Math.sin(th)));
    return e1.map((a, i) => mul(r, add(mul(c, a), mul(s, e2[i]))));
  });
}

/**
 * A right-handed orthonormal pair spanning the plane normal to the unit
 * vector n, in closed form (Duff et al., "Building an orthonormal basis,
 * revisited", 2017): e1 × e2 = n with no branch but the sign of n_z.
 */
function planeBasis(n: Expr[]): [Expr[], Expr[]] {
  const [x, y, z] = n;
  const s: Expr = {
    kind: 'piecewise',
    cases: [{ cond: { kind: 'ineq', op: '<', l: z, r: num(0) }, value: num(-1) }],
    otherwise: num(1),
  };
  const a = div(num(-1), add(s, z));
  const b = mul(mul(x, y), a);
  return [
    [add(num(1), mul(mul(s, mul(x, x)), a)), mul(s, b), neg(mul(s, x))],
    [b, add(s, mul(mul(y, y), a)), neg(y)],
  ];
}

/**
 * The internal call `action(M)` lowers to: its size, then its entries
 * row-major. Classify draws it with actionGlyphs and reads the matrix out.
 */
export const ACTION_CALL = '[action]';
export const actionNode = (m: readonly (readonly Expr[])[]): Expr => ({
  kind: 'call',
  name: ACTION_CALL,
  args: [num(m.length), ...m.flat()],
});
export function actionOfNode(e: Expr): Expr[][] | null {
  if (e.kind !== 'call' || e.name !== ACTION_CALL) return null;
  const n = e.args[0].kind === 'num' ? e.args[0].value : 0;
  return Array.from({ length: n }, (_, i) => e.args.slice(1 + i * n, 1 + (i + 1) * n));
}

/**
 * What a matrix does, drawn: the image of the unit square (a filled
 * parallelogram, whose signed area is det M) or cube, of the unit circle (an
 * ellipse, its axes the singular vectors), and the arrows M e_x, M e_y
 * (and M e_z) — the columns.
 */
export function actionGlyphs(m: readonly (readonly Expr[])[]): Expr[] {
  const n = m.length as 2 | 3;
  const col = (j: number): Expr[] => m.map(row => row[j]);
  const origin = Array.from({ length: n }, () => num(0));
  const sum = (...vs: Expr[][]): Expr[] => vs.reduce((acc, v) => acc.map((c, i) => add(c, v[i])), origin);
  const out: Expr[] = [];
  if (n === 2) {
    out.push(figure('polygon', 2, [origin, col(0), sum(col(0), col(1)), col(1)]));
    const circle = Array.from({ length: RIM + 1 }, (_, k) => {
      const th = (2 * Math.PI * k) / RIM;
      return m.map(row => add(mul(row[0], num(Math.cos(th))), mul(row[1], num(Math.sin(th)))));
    });
    out.push({ kind: 'figure', form: 'polyline', dimension: 2, vertices: circle.flat() });
  } else {
    const corners: Expr[][] = [];
    for (const a of [0, 1])
      for (const b of [0, 1])
        for (const c of [0, 1]) {
          corners.push(sum(...[a, b, c].flatMap((on, j) => (on ? [col(j)] : []))));
        }
    out.push(figure('hull', 3, corners));
  }
  for (let j = 0; j < n; j++) out.push(figure('vector', n, [origin, col(j)]));
  return out;
}

/** The figures that draw a multivector: at least one for any that is not a
 *  plain number (which never reaches here). */
export function multivectorGlyphs(m: Multivector): Expr[] {
  const { vector, bivector, trivector } = glyphParts(m);
  const dim = m.dim;
  const origin = Array.from({ length: dim }, () => num(0));
  const out: Expr[] = [];
  if (bivector) {
    if ('plane' in bivector) {
      // Area |b|: radius √(|b|/π). The rim arrow turns the way b does.
      const b = bivector.plane;
      const r = call('sqrt', div(call('abs', b), num(Math.PI)));
      const e1 = [num(1), num(0)];
      const e2 = [num(0), num(1)];
      out.push(figure('polygon', 2, arc(r, e1, e2, 1, RIM).slice(0, -1)));
      out.push(figure('vector', 2, arc(mul(num(INSET), r), e1, e2, TURN, Math.round(RIM * TURN), call('sign', b))));
    } else {
      // In space the disc lies across its dual, turning counterclockwise
      // seen from the tip of the normal, which is the bivector's sense.
      const n = bivector.normal;
      const len = call(
        'sqrt',
        n.reduce<Expr>((s, c) => add(s, mul(c, c)), num(0)),
      );
      const [e1, e2] = planeBasis(n.map(c => div(c, len)));
      const r = call('sqrt', div(len, num(Math.PI)));
      out.push(figure('polygon', 3, arc(r, e1, e2, 1, RIM).slice(0, -1)));
      out.push(figure('vector', 3, arc(mul(num(INSET), r), e1, e2, TURN, Math.round(RIM * TURN))));
    }
  }
  if (trivector) {
    // A cube of volume |p|, centred on the origin.
    const h = div(pow(call('abs', trivector), num(1 / 3)), num(2));
    const corners: Expr[][] = [];
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) for (const sz of [-1, 1]) corners.push([sx, sy, sz].map(k => mul(num(k), h)));
    out.push(figure('hull', 3, corners));
  }
  if (vector) out.push(figure('vector', dim, [origin, vector]));
  return out;
}

/**
 * How much a tensor glyph scales the matrix ((a, b), (c, d)): tanh(σ₁)/σ₁,
 * for σ₁ its largest singular value. A small matrix draws at its own size
 * (a glyph of radius σ₁ cells), a large one saturates at a whole cell, so
 * magnitude still reads where it is modest and no glyph overlaps another.
 * (The same formula is written in GLSL in web/render2d.ts tfieldFrag.)
 */
export function glyphScale(a: number, b: number, c: number, d: number): number {
  const s1 = largestSingular(a, b, c, d);
  if (!Number.isFinite(s1)) return NaN;
  return s1 < 1e-9 ? 1 : Math.tanh(s1) / s1;
}

/** σ₁ of ((a, b), (c, d)): the root of the larger eigenvalue of MᵀM. */
export function largestSingular(a: number, b: number, c: number, d: number): number {
  const p = a * a + c * c;
  const q = b * b + d * d;
  const r = a * b + c * d;
  const half = (p + q) / 2;
  return Math.sqrt(half + Math.sqrt(Math.max(0, ((p - q) / 2) ** 2 + r * r)));
}
