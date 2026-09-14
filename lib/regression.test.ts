import { describe, expect, it } from 'vitest';
import { analyze } from '../worker/graph.ts';
import { buildDefs, evalConstEnv, scanDefinition, type Definition } from './defs.ts';
import { parseCsv } from './csv.ts';
import { scanRegressions } from './regression.ts';

function fit(rows: string[]) {
  const regs = scanRegressions(rows);
  return buildDefs(rows.map((r, i) => regs.get(i) ?? scanDefinition(r)).filter((d): d is Definition => !!d));
}

describe('equation-native regression', () => {
  it('fits a line and exposes coefficients to curves, functions and residual lists', () => {
    const result = analyze(['X = [0,1,2,3]', 'Y = [1,3,5,7]', 'Y ~ m X + b', 'f(x) = m x + b', 'y = f(x)', 'R = Y - f(X)', '(X,R)']);
    expect(result.rows.map(r => r.error)).toEqual(Array(7).fill(undefined));
    expect(result.constEnv.m).toBeCloseTo(2, 10);
    expect(result.constEnv.b).toBeCloseTo(1, 10);
    expect(result.rows[2].info).toContain('R² ≈ 1');
    expect(result.rows[4].cls?.plot.type).toBe('implicit2d');
  });
  it('fits a polynomial and fixed constants are not refitted', () => {
    const b = fit(['X = [-2,-1,0,1,2]', 'Y = [9,2,1,6,17]', 'c = 1', 'Y ~ a X^2 + b X + c']);
    expect([...b.errors]).toEqual([]);
    const env = evalConstEnv(b.defs, 0);
    expect(env.a).toBeCloseTo(3, 10);
    expect(env.b).toBeCloseTo(2, 10);
    expect(env.c).toBe(1);
  });
  it('fits nonlinear exponential models deterministically', () => {
    const rows = ['X = [0,0.5,1,1.5,2]', 'Y = 2 exp(0.7 X)', 'Y ~ a exp(b X)'];
    const one = fit(rows), two = fit(rows);
    expect([...one.errors]).toEqual([]);
    expect(evalConstEnv(one.defs, 0).a).toBeCloseTo(2, 5);
    expect(evalConstEnv(one.defs, 0).b).toBeCloseTo(0.7, 5);
    expect([...one.fits]).toEqual([...two.fits]);
  });
  it('handles CSV missing pairs with an explicit skipped count', () => {
    const rows = ['data = open("a.csv")', 'data.y ~ m data.x + b'];
    const reg = scanRegressions(rows).get(1)!;
    const b = buildDefs([scanDefinition(rows[0])!, reg], () => parseCsv('x,y\n0,1\n1,3\n,4\n3,7\n'));
    expect([...b.errors]).toEqual([]);
    expect(b.fits.get(reg.name)?.skipped).toBe(1);
    expect(evalConstEnv(b.defs, 0).m).toBeCloseTo(2, 10);
  });
  it('keeps missing CSV fits and dependent curves device-local in server analysis', () => {
    const r = analyze(['data = open("a.csv")', 'data.y ~ m data.x + b', 'y = m x + b']);
    expect(r.rows.map(r => r.error)).toEqual([undefined, undefined, undefined]);
    expect(r.rows[1].dataLocal).toContain('a.csv');
    expect(r.rows[2].dataLocal).toContain('a.csv');
  });
  it('does not silently omit CSV observations outside the model domain', () => {
    const rows = ['data = open("a.csv")', 'data.y ~ a ln(data.x)'];
    const reg = scanRegressions(rows).get(1)!;
    const b = buildDefs([scanDefinition(rows[0])!, reg], () => parseCsv('x,y\n-1,2\n1,0\n2,1'));
    expect(b.errors.get(reg.name)).toContain('undefined');
    expect(b.fits.size).toBe(0);
  });
  it('fits an exponential without an amplitude and allows derivative models', () => {
    const b = fit(['X=[0,1,2]', 'Y=exp(0.5 X)', 'Y ~ exp(a X)']);
    expect([...b.errors]).toEqual([]);
    expect(evalConstEnv(b.defs, 0).a).toBeCloseTo(0.5, 5);
    expect(scanRegressions(['X=[1,2]', 'Y=[2,4]', "Y ~ a f'(X)"]).size).toBe(1);
    expect(scanRegressions(['# Y ~ a X', 'L=["~"]']).size).toBe(0);
  });
  it('does not reinterpret distribution rows', () => {
    expect(scanRegressions(['X ~ Normal(0,1)', 'Y ~ Uniform', 'Z ~ Exponential(2)']).size).toBe(0);
    const r = analyze(['X ~ Normal(0,1)', 'Y = X^2']);
    expect(r.rows.map(r => r.error)).toEqual([undefined, undefined]);
  });
  it.each([
    [['X=[1,2]', 'Y=[1,2,3]', 'Y ~ a X'], /same length|different lengths|length/i],
    [['X=[1,1,1]', 'Y=[1,2,3]', 'Y ~ a X + b'], /rank deficient/],
    [['X=[1,2,3]', 'Y=[2,4,6]', 'Y ~ a b X'], /rank deficient/],
    [['X=[1,2]', 'Y=[1,2]', 'Y ~ a X^2 + b X + c'], /observations/],
    [['X=[1,2]', 'Y=[1,2]', 'Y ~ a X + t'], /static/],
    [['X=[1,2]', 'Y=[1,2]', 'a=1', 'Y ~ a X'], /unbound coefficient/],
    [['X=[-2,-1]', 'Y=[1,2]', 'Y ~ a ln(X)'], /undefined/],
  ])('rejects invalid or underdetermined fits: %j', (rows, message) => {
    expect([...fit(rows).errors.values()].join(' ')).toMatch(message);
  });
});
