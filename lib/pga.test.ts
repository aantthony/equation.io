import { describe, expect, it } from 'vitest';
import { type Expr, evaluate } from './expr.ts';
import {
  type Pga,
  addPga,
  complement,
  e0Bit,
  expPga,
  geometricPga,
  hyperplane,
  idealPointPga,
  lineDirection,
  logMotor,
  motorAxis,
  motorOf,
  motorPga,
  moveFlat,
  movePoint,
  outerPga,
  pointCoords,
  pointPga,
  pointParts,
  popcount,
  project,
  reflect,
  regressivePga,
  sandwich,
  scalePga,
  slerpMotor,
  uncomplement,
  unitMotor,
  weight,
} from './pga.ts';

/**
 * The projective algebra on its own (docs/pga.md, phase 1): the classical
 * identities, checked numerically.
 */
const n = (v: number): Expr => ({ kind: 'num', value: v });
const val = (e: Expr, env: Record<string, number> = {}): number => evaluate(e, env);
const nums = (a: Pga, env: Record<string, number> = {}): number[] => a.data.map(c => val(c, env));
const pt = (...c: number[]) => pointPga(c.map(n));
const plane = (a: number, b: number, c: number, d: number) => hyperplane([n(a), n(b), n(c)], n(d));
const line2 = (a: number, b: number, c: number) => hyperplane([n(a), n(b)], n(c));
const coords = (p: Pga, env: Record<string, number> = {}) => pointCoords(p).map(c => val(c, env));
const close = (got: number[], want: number[]) => {
  expect(got.length).toBe(want.length);
  got.forEach((g, k) => expect(g).toBeCloseTo(want[k], 9));
};
const isNull = (a: Pga) => nums(a).every(v => Math.abs(v) < 1e-12);
/** Whether a point lies on a hyperplane: p ∧ P = 0. */
const on = (p: Pga, point: Pga) => isNull(outerPga(p, point));

describe('the complement', () => {
  it('is undone by its inverse, and squares to ± the identity', () => {
    for (const dim of [2, 3] as const) {
      const a: Pga = { dim, data: Array.from({ length: 1 << (dim + 1) }, (_, k) => n(k + 1)) };
      expect(nums(uncomplement(complement(a)))).toEqual(nums(a));
      const twice = nums(complement(complement(a)));
      twice.forEach((v, k) => expect(Math.abs(v)).toBe(k + 1));
    }
  });
  it('makes a point that lies on exactly the hyperplanes through it', () => {
    const p = plane(1, 2, 3, -6); // x + 2y + 3z = 6
    expect(on(p, pt(1, 1, 1))).toBe(true);
    expect(on(p, pt(6, 0, 0))).toBe(true);
    expect(on(p, pt(1, 1, 2))).toBe(false);
    expect(on(line2(1, -1, 0), pt(2, 2))).toBe(true);
  });
  it('reads a point back as its coordinates, and an ideal point as weight 0', () => {
    close(coords(pt(1, -2, 3)), [1, -2, 3]);
    close(coords(scalePga(pt(4, 5), n(3))), [4, 5]);
    expect(val(weight(idealPointPga([n(1), n(2)])))).toBe(0);
  });
});

describe('join', () => {
  it('of two points of the plane is the line through both', () => {
    const l = regressivePga(pt(0, 1), pt(1, 3)); // y = 2x + 1
    expect(on(l, pt(0, 1))).toBe(true);
    expect(on(l, pt(1, 3))).toBe(true);
    expect(on(l, pt(2, 5))).toBe(true);
    expect(on(l, pt(2, 4))).toBe(false);
    expect(nums(l).filter((_, k) => popcount(k) !== 1)).toEqual([0, 0, 0, 0, 0]);
  });
  it('of two points of space is a line containing both, of three the plane', () => {
    const [a, b, c] = [pt(1, 0, 0), pt(0, 1, 0), pt(0, 0, 1)];
    const l = regressivePga(a, b);
    // A point lies on a line of space when their join (a plane) vanishes.
    expect(isNull(regressivePga(l, a))).toBe(true);
    expect(isNull(regressivePga(l, b))).toBe(true);
    expect(isNull(regressivePga(l, pt(0.5, 0.5, 0)))).toBe(true);
    expect(isNull(regressivePga(l, c))).toBe(false);
    const p = regressivePga(l, c); // x + y + z = 1
    for (const q of [a, b, c, pt(1 / 3, 1 / 3, 1 / 3)]) expect(on(p, q)).toBe(true);
    expect(on(p, pt(1, 1, 1))).toBe(false);
  });
  it('runs from A to B', () => {
    close(
      lineDirection(regressivePga(pt(1, 1), pt(4, 3))).map(c => val(c)),
      [3, 2],
    );
    close(
      lineDirection(regressivePga(pt(1, 1, 1), pt(2, 3, 4))).map(c => val(c)),
      [1, 2, 3],
    );
  });
});

describe('meet', () => {
  it('of two lines of the plane is where they cross', () => {
    // y = x and y = 2 − x cross at (1, 1).
    close(coords(outerPga(line2(1, -1, 0), line2(1, 1, -2))), [1, 1]);
  });
  it('of parallel lines is an ideal point in their direction', () => {
    const p = outerPga(regressivePga(pt(0, 0), pt(1, 2)), regressivePga(pt(1, 0), pt(2, 2)));
    const { coords: dir, weight: w } = pointParts(p);
    expect(val(w)).toBe(0);
    const d = dir.map(c => val(c));
    expect(d[1] / d[0]).toBeCloseTo(2, 12);
  });
  it('of two planes lies in both, and of three is their common point', () => {
    const [p, q, r] = [plane(1, 0, 0, -1), plane(0, 1, 0, -2), plane(1, 1, 1, -6)];
    const l = outerPga(p, q);
    const x = outerPga(l, r);
    close(coords(x), [1, 2, 3]);
    for (const h of [p, q, r]) expect(on(h, x)).toBe(true);
    // The line itself is the line x = 1, y = 2: through (1, 2, 0), along z.
    expect(isNull(regressivePga(l, pt(1, 2, -5)))).toBe(true);
    const d = lineDirection(l).map(c => val(c));
    expect(Math.abs(d[2])).toBeGreaterThan(0);
    expect([d[0], d[1]]).toEqual([0, 0]);
  });
  it('of a line and a plane is where the line goes through it', () => {
    const l = regressivePga(pt(0, 0, 0), pt(1, 1, 1));
    close(coords(outerPga(l, plane(0, 0, 1, -2))), [2, 2, 2]);
  });
});

describe('project and reflect', () => {
  it('drop a point onto a line of the plane, a plane, and a line of space', () => {
    close(coords(project(pt(0, 2), regressivePga(pt(0, 0), pt(1, 1)))), [1, 1]);
    close(coords(project(pt(3, 4, 5), plane(0, 0, 1, -1))), [3, 4, 1]);
    close(coords(project(pt(1, 5, 0), regressivePga(pt(0, 0, 0), pt(2, 0, 0)))), [1, 0, 0]);
  });
  it('mirror a point in a line, a plane and a point', () => {
    close(coords(reflect(pt(0, 2), regressivePga(pt(0, 0), pt(1, 1)))), [2, 0]);
    close(coords(reflect(pt(3, 4, 5), plane(0, 0, 1, -1))), [3, 4, -3]);
    close(coords(reflect(pt(3, 4), pt(1, 1))), [-1, -2]);
    close(coords(reflect(pt(1, 2, 3), regressivePga(pt(0, 0, 0), pt(0, 0, 1)))), [-1, -2, 3]);
  });
});

/** e^B summed as its series, to check the closed form against. */
function seriesExp(b: Pga): number[] {
  let term: Pga = { dim: b.dim, data: b.data.map((_, k) => n(k === 0 ? 1 : 0)) };
  const sum = nums(term);
  for (let k = 1; k < 40; k++) {
    term = scalePga(geometricPga(term, b), n(1 / k));
    nums(term).forEach((v, i) => (sum[i] += v));
  }
  return sum;
}

describe('motors', () => {
  const unit = (l: Pga) => {
    const e0 = e0Bit(l.dim);
    const s = Math.sqrt(nums(l).reduce((t, v, k) => (k & e0 ? t : t + v * v), 0));
    return scalePga(l, n(1 / s));
  };
  it('match the series of e^B, for rotations, translations and screws', () => {
    const axis = unit(regressivePga(pt(1, 2, 0), pt(1, 2, 1)));
    const slide = { dim: 3 as const, data: Array.from({ length: 16 }, (_, k) => n(k === (1 | 8) ? 0.7 : 0)) };
    for (const b of [
      scalePga(axis, n(0.8)),
      slide,
      addPga(scalePga(axis, n(1.3)), scalePga(regressivePga(pt(0, 0, 0), pt(1, 1, 1)), n(0.4))),
      scalePga(pt(2, -1), n(0.9)),
    ]) {
      close(nums(expPga(b)), seriesExp(b));
    }
  });
  it('turn by θ about a line, keep its points, and keep distances', () => {
    const th = 1.1;
    const axis = unit(regressivePga(pt(1, 1, 0), pt(1, 1, 1))); // the vertical line through (1, 1)
    const m = expPga(scalePga(axis, n(th / 2)));
    const moved = coords(sandwich(m, pt(2, 1, 5)));
    expect(moved[2]).toBeCloseTo(5, 12);
    const turned = Math.atan2(moved[1] - 1, moved[0] - 1);
    expect(Math.abs(turned)).toBeCloseTo(th, 12);
    close(coords(sandwich(m, pt(1, 1, -3))), [1, 1, -3]);
    const [a, b] = [coords(sandwich(m, pt(0, 3, 2))), coords(sandwich(m, pt(4, -1, 0)))];
    expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeCloseTo(Math.hypot(4, 4, 2), 12);
  });
  it('turn the plane about a point', () => {
    const m = expPga(scalePga(pt(1, 0), n(Math.PI / 4))); // a quarter turn about (1, 0)
    const moved = coords(sandwich(m, pt(2, 0)));
    expect(Math.hypot(moved[0] - 1, moved[1])).toBeCloseTo(1, 12);
    expect(Math.abs(moved[0] - 1)).toBeLessThan(1e-12);
  });
  it('stay symbolic: a slider in the angle flows through', () => {
    const axis = regressivePga(pt(0, 0, 0), pt(0, 0, 1));
    const m = expPga(scalePga(axis, { kind: 'var', name: 'a' }));
    const p = sandwich(m, pt(1, 0, 0));
    for (const a of [0, 0.3, 1]) {
      const c = coords(p, { a });
      expect(Math.hypot(c[0], c[1])).toBeCloseTo(1, 12);
      expect(Math.abs(Math.atan2(c[1], c[0]))).toBeCloseTo(2 * a, 12);
    }
  });
});

describe('motor(L, θ, d) and what it moves', () => {
  const axis = regressivePga(pt(1, 2, 0), pt(1, 2, 1)); // the vertical line through (1, 2), pointing up
  const v = (name: string): Expr => ({ kind: 'var', name });
  const env = { th: 0.9, d: 1.7, px: 0.3, py: -1.2, pz: 2.5 };
  it('turns right-handed about the axis and slides along it', () => {
    const m = motorPga(axis, n(Math.PI / 2), n(3));
    // (2, 2, 0) is 1 along x from the axis: a quarter turn up z takes it to (1, 3), then up 3.
    close(
      movePoint(m, [n(2), n(2), n(0)]).map(c => val(c)),
      [1, 3, 3],
    );
    close(
      movePoint(motorPga(pt(1, 1), n(Math.PI / 2)), [n(2), n(1)]).map(c => val(c)),
      [1, 2],
    );
  });
  it('moves a point and a line as the whole sandwich does, from its two factors', () => {
    const m = motorPga(axis, v('th'), v('d'));
    const whole = motorOf(m);
    const p = [v('px'), v('py'), v('pz')];
    close(
      movePoint(m, p).map(c => val(c, env)),
      pointCoords(sandwich(whole, pointPga(p))).map(c => val(c, env)),
    );
    const line = regressivePga(pt(0, 1, 2), pt(3, -1, 1));
    const a = nums(moveFlat(m, line), env);
    const b = nums(sandwich(whole, line), env);
    const scale = b.find(x => Math.abs(x) > 1e-9)! / a.find(x => Math.abs(x) > 1e-9)!;
    close(
      a.map(x => x * scale),
      b,
    );
  });
  it('has a log that exp undoes, and an axis that is the line it screws about', () => {
    const m = unitMotor(motorOf(motorPga(axis, n(2.2), n(-0.8))));
    close(nums(expPga(logMotor(m))), nums(m));
    const found = motorAxis(motorPga(axis, n(2.2), n(-0.8)));
    expect(isNull(regressivePga(found, pt(1, 2, 7)))).toBe(true);
    expect(isNull(regressivePga(found, pt(2, 2, 0)))).toBe(false);
  });
  it('slerps along the screw: halfway is half the turn and half the slide', () => {
    const still = motorPga(axis, n(0), n(0));
    const half = slerpMotor(still, motorPga(axis, n(1.4), n(2)), n(0.5));
    close(
      movePoint(half, [n(2), n(2), n(0)]).map(c => val(c)),
      movePoint(motorPga(axis, n(0.7), n(1)), [n(2), n(2), n(0)]).map(c => val(c)),
    );
  });
});
