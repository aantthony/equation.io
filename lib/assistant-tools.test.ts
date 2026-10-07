import { describe, expect, it } from 'vitest';
import { checkRows } from './assistant-tools.ts';

describe('check', () => {
  it('reads each row as set_graph would, without a graph', () => {
    const [slider, curve, unused, wrong] = checkRows(['a = 1', 'y = a sin(x)', 'b = 2', 'surface(x)']);
    expect(slider).toMatchObject({ row: 'a = 1', kind: 'definition (const)', value: '1' });
    expect(slider.meaning).toContain('slider');
    expect(slider.warning).toBeUndefined();
    expect(curve).toMatchObject({ kind: 'implicit2d', meaning: expect.stringContaining('2D curve') });
    expect(unused.warning).toContain('no other row uses it');
    expect(wrong.error).toContain('Unknown variable: surface');
    expect(wrong.hint).toContain('not a built-in function');
  });
  it('says what a 3D scene leaves out', () => {
    const [surface, region] = checkRows(['z = x y', 'y < x']);
    expect(surface.kind).toBe('implicit3d');
    expect(region.warning).toContain('not drawn');
  });
  it('reads a solid cube as a solid, and a helix as a curve in 3D', () => {
    const [cube, helix] = checkRows([
      '(interval(0, 1), interval(0, 1), interval(0, 1))',
      '(cos(6pi u), sin(6pi u), u)',
    ]);
    expect(cube.kind).toBe('solid');
    expect(helix).toMatchObject({ kind: 'pcurve', meaning: expect.stringContaining('(in 3D)') });
  });
});
