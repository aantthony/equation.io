import { describe, expect, it } from 'vitest';
import { analyzePrepared, analyzeRows, prepareDocument } from './analysis.ts';
import { type Definition, animatedConstNames, buildDefs, scanDefinition } from './defs.ts';
import { evaluate, freeVars } from './expr.ts';
import { publicKind } from './math-object.ts';
import { plotReadout } from './plot.ts';
import { runtimeSliderNames } from './runtime-sliders.ts';
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

/**
 * Stage 2: the same pieces written inline in a row — a motor, a line it
 * moves, a slerp between moving motors — become hidden constants of the
 * document (`#id.k`), evaluated with the frame like the named ones.
 */
describe('inline intermediates', () => {
  const MOVING = [
    'A = (1, 0, 0)',
    'B = (1, 1, 1)',
    'S = motor(line(A, B), t, t/4)',
    'N = motor(line(A, (0, 0, 1)), 1, 0.5)',
  ];
  const rowHidden = (analysis: ReturnType<typeof analyzeRows>) =>
    [...analysis.defs.consts.keys()].filter(n => n.startsWith('#'));
  const at = (rows: string[], time: number) => {
    const analysis = analyzePrepared(prepareDocument(rows), { time });
    const r = analysis.rows.at(-1)!;
    if (r.error) throw new Error(r.error);
    return { r, analysis, info: plotReadout(r.cpu!, { ...analysis.constEnv, t: time }) };
  };

  it('slerps between moving motors, as a named slerp does', () => {
    for (const time of [0, 1.3]) {
      const inline = at([...MOVING, 'rotate((0, 0, 0), slerp(N, S, 0.5))'], time);
      expect(inline.info).toBe(at([...MOVING, 'K = slerp(N, S, 0.5)', 'rotate((0, 0, 0), K)'], time).info);
      expect(countNodes(inline.r.cls!.object)).toBeLessThan(200);
    }
  });
  it('moves a line by a motor about a draggable axis', () => {
    const inline = at([...MOVING, 'rotate(line((0, 0, 0), (1, 0, 0)), S)'], 1.3);
    expect(inline.info).toMatch(/^≈ through \(0\.928444, 0\.047552, 0\.412067\)/);
    expect(inline.info).toBe(at([...MOVING, 'L2 = rotate(line((0, 0, 0), (1, 0, 0)), S)', 'L2'], 1.3).info);
    expect(countNodes(inline.r.cls!.object)).toBeLessThan(2000);
  });
  it('applies a motor written straight into rotate(…), and animates through it', () => {
    const rows = [...MOVING, 'rotate(hull(([0, 1], [0, 1], [0, 1])), motor(line(A, B), t, t/4))'];
    const { r, analysis } = at(rows, 0);
    expect(publicKind(r.cls!.object)).toBe('polygon');
    expect(countNodes(r.cls!.object)).toBeLessThan(500);
    const moving = animatedConstNames(analysis.defs);
    expect(r.cls!.params.some(p => p.startsWith('#') && moving.has(p))).toBe(true);
    // One affine map for all eight vertices: a dozen constants, not 8 × 12.
    expect(rowHidden(analysis).length).toBeLessThan(40);
    // Each is computed with the frame, so the preview and readouts have it.
    for (const name of rowHidden(analysis)) expect(Number.isFinite(analysis.constEnv[name])).toBe(true);
    const point = at([...MOVING, 'rotate((0.3, 0.2, 0.1), motor(line(A, B), t, t/4))'], 1.3).info;
    expect(point).toBe(at([...MOVING, 'M = motor(line(A, B), t, t/4)', 'rotate((0.3, 0.2, 0.1), M)'], 1.3).info);
    expect(point).toBe('≈ (0.744617, -0.083752, 0.843372)');
  });
  it('turns by a product of rotors, or a matrix about a slider axis, in a few dozen nodes', () => {
    const R = 'e^(a/2 e_xy) e^(b/2 e_yz) e^(t/2 e_zx)';
    const rows = ['a = 1', 'b = 2', `rotate(hull(([0, 1], [0, 1], [0, 1])), ${R})`];
    expect(countNodes(row(rows).r.cls!.object)).toBeLessThan(100);
    expect(countNodes(row(['a = 1', 'A = (1, 2, a)', 'e^(t cross(A)) (1, 2, 3)']).r.cls!.object)).toBeLessThan(100);
  });
  it('keeps structural zeros, so a slider at 0 does not change what a row is', () => {
    const kind = (a: string) =>
      publicKind(
        row([...MOVING, `a = ${a}`, 'rotate(line((0, 0, 0), (1, 0, 0)), motor(line(A, B), a, 0))']).r.cls!.object,
      );
    expect(kind('0')).toBe(kind('1'));
  });
  it('never hoists anything over a list, a position or a parameter', () => {
    const analysis = analyzeRows([
      ...MOVING,
      'rotate((1, 0, 0), motor(line(A, B), [1, 2, 3]))',
      'rotate((x, y, 0), S)',
    ]);
    for (const name of rowHidden(analysis)) {
      const vars = [...freeVars(analysis.defs.consts.get(name)!)];
      expect(vars.every(v => v === 't' || analysis.defs.consts.has(v))).toBe(true);
    }
  });
  it('drops what no drawn row reads, and leaves nothing behind for the next analysis', () => {
    const failing = analyzeRows([...MOVING, 'rotate(line((0, 0, 0), (1, 0, 0)), S) + 1']);
    expect(failing.rows.at(-1)!.error).toBeDefined();
    expect(rowHidden(failing)).toEqual([]);
    const document = prepareDocument([...MOVING, 'rotate(line((0, 0, 0), (1, 0, 0)), S)']);
    const first = rowHidden(analyzePrepared(document));
    expect(first.length).toBeGreaterThan(0);
    expect(rowHidden(analyzePrepared(document))).toEqual(first);
  });
  it('checks a solid moved by a slider-dependent turn for folds, and keeps its sliders structural', () => {
    const solid = (k: number) => [
      `k = ${k}`,
      'a = 1',
      's = interval(-1, 1)',
      'rotate((s^2 + k s, u, v), a, (1, 2, 3))',
    ];
    expect(analyzeRows(solid(1)).rows.at(-1)!.error).toMatch(/folds over itself/);
    const fine = analyzeRows(solid(3));
    expect(rowHidden(fine).length).toBeGreaterThan(0);
    // The check read k and a, through the turn's hidden entries: a drag re-runs it.
    expect([...runtimeSliderNames(fine)]).toEqual([]);
  });
  it('takes back what a definition that fails had hoisted', () => {
    expect(hidden(...MOVING, 'Q = rotate(line(A, B), S) + 1').filter(n => n.startsWith('Q#'))).toEqual([]);
  });
  it('leaves a row in random variables as it was', () => {
    const analysis = analyzeRows([...MOVING, 'X ~ Normal(0, 1)', '(1, 0, 0) · rotate((X, 1, 0), S)']);
    const r = analysis.rows.at(-1)!;
    expect(r.error).toBeUndefined();
    expect(r.dist).toBe('density');
    expect(rowHidden(analysis)).toEqual([]);
  });
  it('never shows a hidden name in autocomplete or a message', () => {
    const analysis = analyzeRows([...MOVING, 'rotate((0, 0, 0), slerp(N, S, 0.5))', 'rotate(S, S)']);
    expect(rowHidden(analysis).length).toBeGreaterThan(0);
    const names = syntaxHelp('S', 1, analysis.defs).suggestions.map(s => s.name);
    expect(names.some(n => n.includes('#'))).toBe(false);
    for (const r of analysis.rows) expect(r.error ?? '').not.toContain('#');
  });
});
