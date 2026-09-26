/**
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
