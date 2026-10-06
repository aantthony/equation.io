import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { type Definition, animatedConstNames, buildDefs, scanDefinition } from './defs.ts';
import { evaluate } from './expr.ts';
import { publicKind } from './math-object.ts';
import { plotReadout } from './plot.ts';
import { countNodes } from './size.ts';
import { syntaxHelp } from './syntax-help.ts';

/**
 * Named values whose coefficients are computed once per frame
 * (docs/frame-constants-plan.md): what becomes a hidden constant, what does
 * not, and what that buys.
 */
const defsOf = (...texts: string[]) =>
  buildDefs(texts.map(t => scanDefinition(t)).filter((d): d is Definition => d !== null)).defs;
const hidden = (...texts: string[]) => [...defsOf(...texts).consts.keys()].filter(n => n.includes('#'));
function row(rows: string[]) {
  const analysis = analyzeRows(rows, { readouts: true });
  const r = analysis.rows.at(-1)!;
  if (r.error) throw new Error(r.error);
  return { r, env: { ...analysis.constEnv, t: 0 } };
}
const readout = (rows: string[]) => {
  const { r, env } = row(rows);
  return plotReadout(r.cpu!, env);
};

const SCREW = ['A = (1, 0, 0)', 'B = (1, 1, 1)', 'L = line(A, B)', 'S = motor(L, t, t/4)'];

describe('what becomes a hidden constant', () => {
  it('the coefficients of named lines, motors, multivectors and matrices that move', () => {
    expect(hidden(...SCREW).some(n => n.startsWith('L#'))).toBe(true);
    expect(hidden(...SCREW).some(n => n.startsWith('S#'))).toBe(true);
    expect(hidden('a = 1', 'R = e^(a/2 e_xy)').length).toBeGreaterThan(0);
    expect(hidden('a = 1', 'J = ((0, -1), (1, 0))', 'M = e^(a J)').length).toBeGreaterThan(0);
  });
  it('not numbers, single names, or values over a list', () => {
    expect(hidden('q = quat(-0.2, 0.8, 0, 0)')).toEqual([]);
    expect(hidden('J = ((0, -1), (1, 0))')).toEqual([]);
    expect(hidden('a = 1', 'M = ((a, 0), (0, a))')).toEqual([]);
    expect(hidden('P = [(1, 1), (2, 0)]', 'C = (0, 0)', 'L = join(P, C)')).toEqual([]);
  });
  it('keeps structural zeros, so a slider at 0 does not change what a value is', () => {
    expect(readout(['a = 0', 'R = e^(a/2 e_xy)', 'R'])).toBe('= 1');
    const kind = (a: string) => publicKind(row([`a = ${a}`, 'R = e^(a/2 e_xy)', 'R']).r.cls!.object);
    expect(kind('0')).toBe(kind('1'));
  });
  it('never offers a hidden name in autocomplete', () => {
    const names = syntaxHelp('S', 1, defsOf(...SCREW)).suggestions.map(s => s.name);
    expect(names.some(n => n.includes('#'))).toBe(false);
  });
});

describe('what it buys', () => {
  it('moves a point about a draggable axis in a few hundred nodes, and animates', () => {
    const analysis = analyzeRows([...SCREW, 'rotate((0, 0, 0), S)']);
    const r = analysis.rows.at(-1)!;
    // It animates as a row reading `th = t` does: through a parameter that
    // moves with t (web/main.ts redraws on those), not by naming t itself.
    const moving = animatedConstNames(analysis.defs);
    expect(r.cls!.params.some(p => p.includes('#') && moving.has(p))).toBe(true);
    const o = r.cls!.object;
    expect(countNodes(o)).toBeLessThan(2000);
  });
  it('moves a named line by a motor about a draggable axis', () => {
    expect(readout([...SCREW, 'L2 = rotate(line((0, 0, 0), (1, 0, 0)), S)', 'L2'])).toMatch(/^≈ through \(0, 0, 0\)/);
  });
  it('slerps between named motors about moving axes', () => {
    const rows = [...SCREW, 'N = motor(line(A, (0, 0, 1)), 1, 0.5)', 'K = slerp(N, S, 0.5)'];
    // At t = 0, S is no motion: halfway is half N's screw, about N's axis.
    expect(readout([...rows, 'K'])).toBe(
      '≈ turn 0.5 about the line through (0.5, 0, 0.5), direction (-0.707107, 0, 0.707107), slide 0.25',
    );
    expect(publicKind(row([...rows, 'rotate(hull(([0, 1], [0, 1], [0, 1])), K)']).r.cls!.object)).toBe('polygon');
  });
  it('evaluates hidden constants with the frame: a slider moves them', () => {
    const analysis = analyzeRows(['a = 1', 'J = ((0, -1), (1, 0))', 'M = e^(a J)', 'M (1, 0)']);
    const o = analysis.rows.at(-1)!.cls!.object;
    if (o.kind !== 'point' || o.source.representation !== 'real') throw new Error('expected a point');
    const env = analysis.constEnv;
    const p = o.source.coordinates.map(c => evaluate(c, env));
    expect(p[0]).toBeCloseTo(Math.cos(1), 12);
    expect(p[1]).toBeCloseTo(Math.sin(1), 12);
  });
});
