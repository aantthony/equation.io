import { describe, expect, it } from 'vitest';
import { parseExpr } from './expr.ts';
import { fieldScale } from './volume.ts';

const origin = [0, 0, 0];

describe('fieldScale', () => {
  it('follows the size of the field, so a tiny one and a huge one both show', () => {
    const big = fieldScale(parseExpr('x y z'), {}, origin, 5);
    const small = fieldScale(parseExpr('x y z / 1000'), {}, origin, 5);
    expect(big).toBeGreaterThan(10);
    expect(small).toBeCloseTo(big / 1000, 8);
  });

  it('is not led by a pole: 1/r reads the bulk, not the spike', () => {
    const scale = fieldScale(parseExpr('1/sqrt(x^2 + y^2 + z^2)'), {}, origin, 4);
    expect(scale).toBeGreaterThan(0.2);
    expect(scale).toBeLessThan(2);
  });

  it('samples the ball around its center', () => {
    const scale = fieldScale(parseExpr('x'), {}, [100, 0, 0], 1);
    expect(scale).toBeGreaterThan(99);
    expect(scale).toBeLessThan(101);
  });

  it('reads sliders and t from the env', () => {
    expect(fieldScale(parseExpr('a exp(-(x^2 + y^2 + z^2))'), { a: 3 }, origin, 1)).toBeCloseTo(
      3 * fieldScale(parseExpr('exp(-(x^2 + y^2 + z^2))'), {}, origin, 1),
    );
    expect(fieldScale(parseExpr('t'), { t: 2 }, origin, 1)).toBe(2);
  });

  it('falls back to 1 when the field is zero or undefined throughout', () => {
    expect(fieldScale(parseExpr('0 x'), {}, origin, 1)).toBe(1);
    expect(fieldScale(parseExpr('sqrt(-1 - x^2)'), {}, origin, 1)).toBe(1);
  });
});
