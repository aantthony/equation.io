import { evaluateFrame } from './env.ts';
import { describe, expect, it } from 'vitest';
import { analyze } from '../worker/graph.ts';
import { buildDefs, scanDefinition, type Definition } from './defs.ts';
import { parseCsv } from './csv.ts';
import { evaluate } from './expr.ts';
import { scanRegressions } from './regression.ts';

function fit(rows: string[]) {
  const regs = scanRegressions(rows);
  return buildDefs(rows.map((r, i) => regs.get(i) ?? scanDefinition(r)).filter((d): d is Definition => !!d));
}

describe('equation-native regression', () => {
  it('fits a line and exposes coefficients to curves, functions and residual lists', () => {
    const result = analyze([
      'X = [0,1,2,3]',
      'Y = [1,3,5,7]',
      'Y ~ m X + b',
      'f(x) = m x + b',
      'y = f(x)',
      'R = Y - f(X)',
      '(X,R)',
    ]);
    expect(result.rows.map(r => r.error)).toEqual(Array(7).fill(undefined));
    expect(result.constEnv.m).toBeCloseTo(2, 10);
    expect(result.constEnv.b).toBeCloseTo(1, 10);
    expect(result.rows[2].info).toContain('R² ≈ 1');
    expect(result.rows[4].cpu?.type).toBe('implicit2d');
  });
  it('fits a polynomial and fixed constants are not refitted', () => {
    const b = fit(['X = [-2,-1,0,1,2]', 'Y = [9,2,1,6,17]', 'c = 1', 'Y ~ a X^2 + b X + c']);
    expect([...b.errors]).toEqual([]);
    const env = evaluateFrame(b.defs, 0);
    expect(env.a).toBeCloseTo(3, 10);
    expect(env.b).toBeCloseTo(2, 10);
    expect(env.c).toBe(1);
  });
  it('fits nonlinear exponential models deterministically', () => {
    const rows = ['X = [0,0.5,1,1.5,2]', 'Y = 2 exp(0.7 X)', 'Y ~ a exp(b X)'];
    const one = fit(rows),
      two = fit(rows);
    expect([...one.errors]).toEqual([]);
    expect(evaluateFrame(one.defs, 0).a).toBeCloseTo(2, 5);
    expect(evaluateFrame(one.defs, 0).b).toBeCloseTo(0.7, 5);
    expect([...one.fits]).toEqual([...two.fits]);
  });
  it('handles CSV missing pairs with an explicit skipped count', () => {
    const rows = ['data = open("a.csv")', 'data.y ~ m data.x + b'];
    const reg = scanRegressions(rows).get(1)!;
    const b = buildDefs([scanDefinition(rows[0])!, reg], () => parseCsv('x,y\n0,1\n1,3\n,4\n3,7\n'));
    expect([...b.errors]).toEqual([]);
    expect(b.fits.get(reg.name)?.skipped).toBe(1);
    expect(evaluateFrame(b.defs, 0).m).toBeCloseTo(2, 10);
  });
  it('zips columns of one CSV so a two-predictor fit pairs rows', () => {
    const rows = ['data = open("a.csv")', 'data.y ~ m data.x + n data.z'];
    const reg = scanRegressions(rows).get(1)!;
    const b = buildDefs([scanDefinition(rows[0])!, reg], () => parseCsv('x,y,z\n0,3,1\n1,2,0\n1,5,1\n2,7,1\n'));
    expect([...b.errors]).toEqual([]);
    expect(evaluateFrame(b.defs, 0).m).toBeCloseTo(2, 10);
    expect(evaluateFrame(b.defs, 0).n).toBeCloseTo(3, 10);
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
    expect(evaluateFrame(b.defs, 0).a).toBeCloseTo(0.5, 5);
    expect(scanRegressions(['X=[1,2]', 'Y=[2,4]', "Y ~ a f'(X)"]).size).toBe(1);
    expect(scanRegressions(['# Y ~ a X', 'L=["~"]']).size).toBe(0);
  });
  it.each(['exp', 'EXP', 'Exp', 'eXp'])('preserves the bare %s distribution alias and name collisions', alias => {
    expect(scanRegressions(['X=2', `X ~ ${alias}`]).size).toBe(0);
    expect(analyze(['X=2', `X ~ ${alias}`]).rows[1].error).toBe('X is already defined.');
    expect(analyze([`X ~ ${alias}`]).rows[0].dist).toBe('density');
    expect(analyze([`X ~ ${alias}(2)`]).rows[0].dist).toBe('density');
  });
  it.each(['exp', 'EXP', 'Exp', 'eXp'])('fits a case-insensitive %s call over declared data', alias => {
    const b = fit(['X=[0,1,2]', 'Y=exp(0.5 X)', `Y ~ ${alias}(a X)`]);
    expect([...b.errors]).toEqual([]);
    expect(evaluateFrame(b.defs, 0).a).toBeCloseTo(0.5, 5);
  });
  it('does not reinterpret distribution rows', () => {
    expect(scanRegressions(['X ~ Normal(0,1)', 'Y ~ Uniform', 'Z ~ Exponential(2)']).size).toBe(0);
    const r = analyze(['X ~ Normal(0,1)', 'Y = X^2']);
    expect(r.rows.map(r => r.error)).toEqual([undefined, undefined]);
  });
  it('keeps the zoo names that are also functions or coefficients as models over data', () => {
    // gamma is a function and beta/T everyday names: like exp, declared data
    // on the left makes the row a model; an undeclared left side declares.
    const rows = [
      'X=[1,2,3]',
      'Y=[2,4,6]',
      'beta=2',
      'Y ~ beta (X - 1) + c',
      'Y ~ gamma(a X)',
      'W ~ Gamma(2, 1)',
      'V ~ T(5)',
    ];
    expect([...scanRegressions(rows).keys()]).toEqual([3, 4]);
    // The unambiguous names declare whatever is on the left.
    expect(scanRegressions(['Y=[1,2]', 'Y ~ Weibull(2, 1)', 'Y ~ chisq(3)', 'Y ~ Cauchy']).size).toBe(0);
    const r = analyze(['X=[1,2,3]', 'W ~ Gamma(2, 1)', 'V ~ T(5)', 'B ~ Beta(2, 3)']);
    expect(r.rows.map(row => row.error)).toEqual([undefined, undefined, undefined, undefined]);
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

describe('fitting a list of points by its coordinates', () => {
  // Two separately written lists are independent and cross, so the examples
  // write their data as points: P.x and P.y pair up point by point.
  const rows = [
    'P = [(-2,9),(-1,2),(0,1),(1,6),(2,17)]',
    'P.y ~ a P.x^2 + b P.x + c',
    'P',
    '(P.x, P.y)',
    '(P.x, P.y - (a P.x^2 + b P.x + c))',
  ];

  it('fits P.y against P.x, one observation per point', () => {
    const r = analyze(rows);
    expect(r.rows.map(row => row.error)).toEqual(rows.map(() => undefined));
    expect(r.constEnv.a).toBeCloseTo(3);
    expect(r.constEnv.b).toBeCloseTo(2);
    expect(r.constEnv.c).toBeCloseTo(1);
    expect(r.rows[1].info).toMatch(/5 observations/);
  });

  it('pairs the coordinate lists rather than crossing them', () => {
    const r = analyze(rows);
    for (const at of [2, 3, 4]) {
      const plan = r.rows[at].cpu!;
      expect(plan.type).toBe('plist');
      if (plan.type === 'plist') expect(plan.pts).toHaveLength(5);
    }
    const residuals = r.rows[4].cpu!;
    if (residuals.type !== 'plist') throw new Error('residuals');
    for (const [, dy] of residuals.pts) expect(Math.abs(evaluate(dy, r.constEnv))).toBeLessThan(1e-9);
  });

  it('names the coordinates a point list has', () => {
    expect(analyze(['P = [(1,2),(3,4)]', 'P.z']).rows[1].error).toMatch(/2D points: its coordinates are P\.x, P\.y/);
    expect(analyze(['L = [1,2]', 'L.x']).rows[1].error).toMatch(/L is a list of numbers/);
  });

  it('reads the rows of a point list that is shaped like a matrix', () => {
    // Two 2D points are a 2×2 matrix as well; P.x still means their x's.
    const r = analyze(['P = [(1,2),(3,5)]', 'P.y ~ m P.x + b', '(P.x, P.y)']);
    expect(r.constEnv.m).toBeCloseTo(1.5);
    const plan = r.rows[2].cpu!;
    expect(plan.type === 'plist' && plan.pts).toHaveLength(2);
  });

  it('filters one coordinate of a matrix-shaped point list by another', () => {
    const row = analyze(['P = [(1,2),(3,5)]', 'P.y[P.x > 2]']).rows[1];
    expect(row.error).toBeUndefined();
    expect(row.cpu).toEqual({ type: 'vlist', values: [{ kind: 'num', value: 5 }] });
  });

  it('keeps two separately written lists independent', () => {
    const plan = analyze(['X = [1,2,3]', 'Y = [4,5,6]', '(X, Y)']).rows[2].cpu!;
    expect(plan.type === 'plist' && plan.pts).toHaveLength(9);
  });
});
