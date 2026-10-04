import { describe, expect, it } from 'vitest';
import { PointTrail } from './point-trail.ts';
import { analyze } from '../worker/graph.ts';
import { canRenderOg, previewGap } from '../worker/og.ts';

describe('trail(point)', () => {
  it('accepts literals, named point arithmetic, and 3D state vectors', () => {
    for (const [text, dim] of [
      ['trail((cos(t), sin(t)))', 2],
      ['TRAIL(cos(t), sin(t))', 2],
      ['A = (cos(t), sin(t)); trail(2A)', 2],
      ["p(0) = (1, 0, 0); p' = (-p_2, p_1, 1); trail(p)", 3],
    ] as const) {
      const graph = analyze(text.split(';').map(s => s.trim()));
      expect(graph.rows.map(r => r.error)).toEqual(graph.rows.map(() => undefined));
      expect(graph.rows.at(-1)?.cpu).toMatchObject({ type: 'trail', dim });
      expect(graph.rows.at(-1)?.cls?.needs3D).toBe(dim === 3);
    }
  });

  it('preserves matrix trace, including within arithmetic', () => {
    const graph = analyze(['M = ((1, 2), (3, 4))', 'a = trace(M) + 1']);
    expect(graph.rows.map(r => r.error)).toEqual([undefined, undefined]);
    expect(graph.constEnv.a).toBe(6);
  });

  it('keeps point trails and matrix trace distinct', () => {
    expect(analyze(['A = (1, 2)', 'trace(A)']).rows[1].error).toContain('takes a matrix');
    expect(analyze(['M = ((1, 2), (3, 4))', 'trail(M)']).rows[1].error).toBeTruthy();
  });

  it('rejects scalar, spatial, parametric, and nested trail expressions', () => {
    for (const text of ['trail(1)', 'trail(x, y)', 'trail(u, u)', '1 + trail(1, 2)', 'trail(i, 1)']) {
      expect(analyze([text]).rows[0].error, text).toBeTruthy();
    }
  });

  it.each([
    'a = trail(1, 2)',
    'a = 1 + trail(1, 2)',
    'A = (trail(1, 2), 3)',
    'L = [trail(1, 2), 3]',
    'f(x) = trail(x, 2)',
    "q' = trail(1, 2)",
    'q(0) = trail(1, 2)',
  ])('rejects trail in definitions without disrupting other rows: %s', text => {
    const graph = analyze(['b = 7', text, 'y = b x', ...(text.startsWith('q(0)') ? ["q' = 0"] : [])]);
    expect(graph.rows[1].error).toBe('trail(…) must be a whole row, not part of a definition.');
    expect(graph.rows[0].error).toBeUndefined();
    expect(graph.rows[2].error).toBeUndefined();
    expect(graph.constEnv.b).toBe(7);
    expect(graph.defs.consts.has('a')).toBe(false);
    expect(graph.defs.fns.has('f')).toBe(false);
  });

  it('reports live history honestly to static preview consumers', () => {
    const graph = analyze(['trail(cos(t), sin(t), t)']);
    expect(canRenderOg(graph)).toBe(false);
    expect(previewGap(graph.rows[0], true)).toContain('live motion history');
  });
});

describe('PointTrail', () => {
  it('keeps observed values, limits sampling rate, and lifts 2D trails into 3D', () => {
    const trail = new PointTrail(2);
    const p = [1, 2];
    trail.sample(0, p);
    p[0] = 9;
    trail.sample(0.001, [3, 4]);
    trail.sample(0.02, [5, 6]);
    expect(trail.coordinates()).toEqual([1, 2, 5, 6]);
    expect(trail.coordinates(3)).toEqual([1, 2, 0, 5, 6, 0]);
  });

  it('preserves invalid positions observed between accepted samples', () => {
    const trail = new PointTrail(2);
    trail.sample(0, [1, 2]);
    trail.sample(0.001, [NaN, 2]);
    expect(trail.head).toBeNull();
    trail.sample(0.002, [2, 3]);
    expect(trail.head).toEqual([2, 3]);
    expect(trail.coordinates()).toEqual([1, 2]);
    trail.sample(0.02, [3, 4]);
    trail.sample(0.04, [5, 6]);
    expect(trail.coordinates()).toEqual([1, 2, NaN, NaN, 3, 4, 5, 6]);
  });

  it('clears a pending break when time restarts', () => {
    const trail = new PointTrail(2);
    trail.sample(1, [1, 2]);
    trail.sample(1.001, [NaN, 2]);
    trail.sample(0, [3, 4]);
    trail.sample(0.02, [5, 6]);
    expect(trail.coordinates()).toEqual([3, 4, 5, 6]);
  });

  it('bounds age and count and resets when time moves backwards', () => {
    const trail = new PointTrail(2, 1, 10);
    for (let i = 0; i < 100; i++) trail.sample(i / 10, [i, i]);
    expect(trail.coordinates().length).toBe(20);
    trail.sample(20, [20, 20]);
    expect(trail.coordinates().filter(Number.isFinite)).toEqual([20, 20]);
    trail.sample(0, [0, 0]);
    expect(trail.coordinates()).toEqual([0, 0]);
  });

  it('breaks at invalid positions and suspended frames', () => {
    const trail = new PointTrail(3);
    trail.sample(0, [1, 2, 3]);
    trail.sample(0.1, [NaN, 2, 3]);
    expect(trail.head).toBeNull();
    trail.sample(0.2, [4, 5, 6]);
    trail.sample(2, [7, 8, 9]);
    expect(trail.coordinates()).toEqual([1, 2, 3, NaN, NaN, NaN, 4, 5, 6, NaN, NaN, NaN, 7, 8, 9]);
  });
});
