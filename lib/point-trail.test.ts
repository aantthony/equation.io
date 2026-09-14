import { describe, expect, it } from 'vitest';
import { PointTrail } from './point-trail.ts';
import { analyze } from '../worker/graph.ts';
import { canRenderOg, previewGap } from '../worker/og.ts';

describe('trace(point)', () => {
  it('accepts literals, named point arithmetic, and 3D state vectors', () => {
    for (const [text, dim] of [
      ['trace((cos(t), sin(t)))', 2],
      ['A = (cos(t), sin(t)); trace(2A)', 2],
      ["p(0) = (1, 0, 0); p' = (-p_2, p_1, 1); trace(p)", 3],
    ] as const) {
      const graph = analyze(text.split(';').map(s => s.trim()));
      expect(graph.rows.map(r => r.error)).toEqual(graph.rows.map(() => undefined));
      expect(graph.rows.at(-1)?.cls).toMatchObject({ plot: { type: 'trail', dim }, needs3D: dim === 3 });
    }
  });

  it('preserves matrix trace, including within arithmetic', () => {
    const graph = analyze(['M = [(1, 2), (3, 4)]', 'a = trace(M) + 1']);
    expect(graph.rows.map(r => r.error)).toEqual([undefined, undefined]);
    expect(graph.constEnv.a).toBe(6);
  });

  it('rejects scalar, spatial, parametric, and nested trail expressions', () => {
    for (const text of ['trace(1)', 'trace(x, y)', 'trace(u, u)', '1 + trace(1, 2)', 'trace(i, 1)']) {
      expect(analyze([text]).rows[0].error, text).toBeTruthy();
    }
  });

  it('reports live history honestly to static preview consumers', () => {
    const graph = analyze(['trace(cos(t), sin(t), t)']);
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
