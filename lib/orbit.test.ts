import { describe, expect, it } from 'vitest';
import { analyzeRows, prepareDocument } from './analysis.ts';
import { evaluate } from './expr.ts';
import { orbitInput, traceOrbit } from './orbit.ts';
import { advanceState, initialState } from './state.ts';

const ROSSLER = ['a = 0.2', 'b = 0.2', 'c = 5.7', "p' = (-p_2 - p_3, p_1 + a p_2, b + p_3 (p_1 - c))"];

/** Integrate a document's states to `to` seconds, frame by frame as the app does. */
function integrate(rows: string[], to: number) {
  const document = prepareDocument(rows);
  const sys = document.stateSystem!;
  const values = initialState(document.defs, sys);
  let now = 0;
  for (let f = 1; f <= Math.round(to * 60); f++) now = advanceState(document.defs, sys, values, now, f / 60);
  return { document, sys, values };
}

/** The orbit a row draws, integrated as the worker would. */
function orbitOf(rows: string[], row: number) {
  const analysis = analyzeRows(rows);
  const { object } = analysis.rows[row].cls!;
  if (object.kind !== 'orbit') throw new Error(`row ${row} is ${object.kind}`);
  const env = analysis.constEnv;
  const input = orbitInput(
    prepareDocument(rows).defs,
    object.paths,
    object.series,
    evaluate(object.from, env),
    evaluate(object.to, env),
    env,
  );
  return { input, pts: traceOrbit(input) };
}

describe('state families', () => {
  it('runs the system once per starting value instead of collapsing the list to 0', () => {
    const { sys, document } = integrate([...ROSSLER, 'p(0) = ([1..4]/4, 0, 0)'], 0);
    expect(sys.names).toHaveLength(12);
    const starts = initialState(document.defs, sys);
    const firsts = sys.names.filter(n => n.includes('p_1')).map(n => starts[n]);
    expect(firsts).toEqual([0.25, 0.5, 0.75, 1]);
  });

  it('integrates each run exactly as a system of its own', () => {
    const family = integrate([...ROSSLER, 'p(0) = ([1, 2], 0, 0)'], 2).values;
    const solo = integrate([...ROSSLER, 'p(0) = (2, 0, 0)'], 2).values;
    const second = Object.entries(family)
      .filter(([n]) => n.endsWith('_1'))
      .map(([, v]) => v);
    expect(second).toEqual([solo.p_1, solo.p_2, solo.p_3]);
  });

  it('draws the family as points and reads single runs and reductions', () => {
    const rows = [...ROSSLER, 'p(0) = ([1..4]/4, 0, 0)', 'p', 'p[2]', 'mean(p_1)', 'x_0 = p_1[4]'];
    const analysis = analyzeRows(rows);
    expect(analysis.rows[5].cls?.object.kind).toBe('list');
    expect(analysis.rows[6].cls?.object.kind).toBe('point');
    expect(analysis.rows[7].info).toBe('= 0.625');
    expect(analysis.rows[8].error).toBeUndefined();
  });

  it('carries coupled states along with the family, through constants and matrices', () => {
    const rows = [
      'g = 9.8',
      'M = ((2, cos(th_1 - th_2)), (cos(th_1 - th_2), 1))',
      'f = (-om_2^2 sin(th_1 - th_2) - 2g sin(th_1), om_1^2 sin(th_1 - th_2) - g sin(th_2))',
      "th' = om",
      "om' = solve(M, f)",
      'th(0) = (2.5 + [0..2]/100, 2.4)',
      'b1 = (sin(th_1), -cos(th_1))',
      'segment((0, 0), b1)',
    ];
    const { sys, values } = integrate(rows, 5);
    expect(sys.names).toHaveLength(12); // th and om, 2 components, 3 runs
    const angles = sys.names.filter(n => n.includes('th_1')).map(n => values[n]);
    expect(new Set(angles).size).toBe(3); // chaos: nearby starts have parted
    const analysis = analyzeRows(rows);
    expect(analysis.rows.every(r => !r.error)).toBe(true);
    expect(analysis.rows[7].cls?.object.kind).toBe('family');
  });

  it('refuses coupled families of different sizes', () => {
    const analysis = analyzeRows(["r' = s", "s' = -r", 'r(0) = [1, 2]', 's(0) = [1, 2, 3]']);
    expect(analysis.rows[3].error).toMatch(/starts 3 runs, but r\(0\).*starts 2/);
  });
});

describe('orbits', () => {
  it('classifies value(from..to) and refuses moving or foreign ranges', () => {
    const rows = [...ROSSLER, 'p(0) = (1, 0, 0)', 'p(0..20)', 'p(t..5)', 'x(0..2)', 'p(5..1)'];
    const analysis = analyzeRows(rows);
    expect(analysis.rows[5].cls?.object.kind).toBe('orbit');
    expect(analysis.rows[5].cls?.needs3D).toBe(true);
    expect(analysis.rows[6].error).toMatch(/must hold still \(found t\)/);
    expect(analysis.rows[7].error).toMatch(/found x/);
    expect(() => orbitOf(rows, 8)).toThrow(/runs forward in time/);
    expect(analyzeRows(['(1..3)']).rows[0].error).toMatch(/ranges only appear/);
  });

  it('plots a scalar state against t', () => {
    const { pts } = orbitOf(["q' = -q", 'q(0) = 1', 'q(0..3)'], 2);
    const end = pts[pts.length - 2];
    expect(end[0]).toBeCloseTo(3, 12);
    expect(end[1]).toBeCloseTo(Math.exp(-3), 10);
    expect(pts[pts.length - 1].every(Number.isNaN)).toBe(true);
  });

  it('ends where the live simulation arrives, integrating only the run it draws', () => {
    const rows = [...ROSSLER, 'p(0) = ([1, 2, 3], 0, 0)', 'p[2](0..4)'];
    const { input, pts } = orbitOf(rows, 5);
    expect(input.names).toHaveLength(3);
    const live = integrate(rows, 4);
    const run = live.sys.names.filter(n => n.endsWith('_1')).map(n => live.values[n]);
    expect(pts[pts.length - 2]).toEqual(run);
  });

  it('draws anything built from states, such as a pendulum bob', () => {
    const rows = ["th' = om", "om' = -sin(th)", 'th(0) = 1', 'bob = (sin(th), -cos(th))', 'bob(0..6)'];
    const { input, pts } = orbitOf(rows, 4);
    expect(input.names.sort()).toEqual(['om', 'th']);
    const live = integrate(rows, 6).values;
    expect(pts[pts.length - 2]).toEqual([Math.sin(live.th), -Math.cos(live.th)]);
  });

  it('draws one path per run of a family and keeps the drawing bounded', () => {
    const { pts } = orbitOf([...ROSSLER, 'p(0) = ([1..3], 0, 0)', 'p(10..20)'], 5);
    expect(pts.filter(p => p.every(Number.isNaN))).toHaveLength(3);
    const long = [...ROSSLER, 'p(0) = ([1..300]/30, 0, 0)', 'p(0..400)'];
    expect(() => orbitOf(long, 5)).toThrow(/for 300 runs .*p\[1\]\(0\.\.400\)/);
  });
});
