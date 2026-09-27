import { describe, expect, it } from 'vitest';
import {
  type Multivector,
  bladeByName,
  bladeSign,
  conjugate,
  dual,
  geometric,
  gradePart,
  innerMv,
  inverse,
  mvExp,
  mvNode,
  mvOfNode,
  mvPower,
  mvText,
  outerMv,
  quaternion,
  quaternionParts,
  reverse,
  sandwichMatrix,
  slerp,
  vectorMv,
} from './clifford.ts';
import { evaluate, type Expr } from './expr.ts';

const num = (value: number): Expr => ({ kind: 'num', value });
const vals = (m: Multivector, env: Record<string, number> = {}) => m.data.map(c => evaluate(c, env) + 0);
const blade = (name: string) => bladeByName(name)!;
const v3 = (...xs: number[]) => vectorMv(xs.map(num));
const text = (m: Multivector, env: Record<string, number> = {}) =>
  mvText(m, vals(m, env), v => String(Math.round(v * 1e9) / 1e9));

describe('blades', () => {
  it('spells the bivectors cyclically and signs a reordering', () => {
    expect(vals(blade('e_xy'))).toEqual([0, 0, 0, 1, 0, 0, 0, 0]);
    expect(vals(blade('e_yx'))).toEqual([0, 0, 0, -1, 0, 0, 0, 0]);
    expect(text(blade('e_zx'))).toBe('e_zx');
    expect(text(blade('e_xz'))).toBe('-e_zx');
    expect(text(blade('e_zyx'))).toBe('-e_xyz');
    expect(bladeByName('e_xx')).toBeNull();
    expect(bladeByName('e_x')).toBeNull();
  });
  it('orders products by swaps', () => {
    expect(bladeSign(2, 1)).toBe(-1); // e_y e_x = −e_xy
    expect(bladeSign(1, 2)).toBe(1);
    expect(bladeSign(3, 3)).toBe(-1); // e_xy² = −1
  });
});

describe('products', () => {
  it('the geometric product of vectors is their dot plus their wedge', () => {
    const a = v3(1, 2, 3);
    const b = v3(4, 5, 6);
    const ab = geometric(a, b);
    expect(vals(gradePart(ab, 0))[0]).toBe(32);
    expect(vals(gradePart(ab, 2))).toEqual(vals(outerMv(a, b)));
    expect(text(ab)).toBe('32 - 3 e_xy - 3 e_yz + 6 e_zx');
  });
  it('left contraction lowers the grade', () => {
    expect(text(innerMv(v3(1, 0, 0), blade('e_xy')))).toBe('e_y');
  });
  it('reversion and conjugation', () => {
    const m = geometric(v3(1, 2, 0), blade('e_xy'));
    expect(vals(geometric(m, reverse(m)))[0]).toBeCloseTo(5);
    expect(text(conjugate(v3(1, 0, 0)))).toBe('-e_x');
  });
  it('the dual of a plane is its normal', () => {
    expect(text(dual(blade('e_xy')))).toBe('e_z');
  });
  it('inverts every invertible multivector of space', () => {
    const m = { dim: 3 as const, data: [1, 2, -1, 0.5, 3, 0, 1, 2].map(num) };
    expect(vals(geometric(m, inverse(m))).map(v => Math.round(v * 1e9) / 1e9 + 0)).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(vals(mvPower(m, -1))).toEqual(vals(inverse(m)));
  });
});

describe('rotors and quaternions', () => {
  it('e^(−θ/2 e_xy) turns a vector by θ', () => {
    const r = mvExp({ dim: 3, data: [0, 0, 0, -Math.PI / 4, 0, 0, 0, 0].map(num) });
    const turned = geometric(geometric(r, v3(1, 0, 0)), reverse(r));
    expect(vals(turned).map(v => Math.round(v * 1e9) / 1e9)).toEqual([0, 0, 1, 0, 0, 0, 0, 0]);
  });
  it('exponentiates a bivector with several parts through its magnitude', () => {
    const b = outerMv(v3(1, 0, 0), v3(0, 1, 1)); // e_xy + e_xz, |B| = √2
    const r = mvExp(b);
    expect(vals(r)[0]).toBeCloseTo(Math.cos(Math.SQRT2));
    expect(vals(geometric(r, reverse(r)))[0]).toBeCloseTo(1);
  });
  it('i² = j² = k² = ijk = −1', () => {
    const i = quaternion(num(0), num(1), num(0), num(0));
    const j = quaternion(num(0), num(0), num(1), num(0));
    const k = quaternion(num(0), num(0), num(0), num(1));
    for (const q of [i, j, k]) expect(text(geometric(q, q))).toBe('-1');
    expect(text(geometric(geometric(i, j), k))).toBe('-1');
    expect(text(geometric(i, j))).toBe('k');
    expect(geometric(i, j).quat).toBe(true);
  });
  it('a unit quaternion turns about its axis, as its matrix does', () => {
    const h = Math.PI / 4;
    const q = quaternion(num(Math.cos(h)), num(0), num(0), num(Math.sin(h))); // 90° about z
    const m = sandwichMatrix(q, 3).map(row => row.map(e => Math.round(evaluate(e, {}) * 1e9) / 1e9));
    expect(m).toEqual([
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ]);
    expect(quaternionParts(q).map(e => evaluate(e, {}))).toEqual([Math.cos(h), 0, 0, Math.sin(h)]);
  });
  it('slerp runs the shorter arc at constant speed', () => {
    const a = quaternion(num(1), num(0), num(0), num(0));
    const b = quaternion(num(0), num(0), num(0), num(1)); // 180° about z
    const mid = slerp(a, b, { kind: 'var', name: 'u' });
    const [w, , , z] = quaternionParts(mid).map(e => evaluate(e, { u: 0.5 }));
    expect(w).toBeCloseTo(Math.SQRT1_2);
    expect(z).toBeCloseTo(Math.SQRT1_2);
    // The same rotation written −b takes the same path.
    const flipped = slerp(a, { ...b, data: b.data.map(c => ({ kind: 'neg', a: c }) as Expr) }, num(0.5));
    expect(quaternionParts(flipped).map(e => evaluate(e, {}))[0]).toBeCloseTo(Math.SQRT1_2);
    expect(quaternionParts(slerp(a, a, num(0.3))).map(e => evaluate(e, {}))).toEqual([1, 0, 0, 0]);
  });
});

describe('readout', () => {
  it('reads quaternions in i, j, k', () => {
    expect(text(quaternion(num(1), num(2), num(-3), num(1)))).toBe('1 + 2i - 3j + k');
    expect(text(quaternion(num(0), num(0), num(0), num(0)))).toBe('0');
  });
  it('round-trips the internal node', () => {
    const q = quaternion(num(1), num(2), num(3), num(4));
    expect(mvOfNode(mvNode(q))).toEqual(q);
  });
});
