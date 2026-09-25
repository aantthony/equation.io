import { scaleViewAt } from './view.ts';
import { describe, expect, it } from 'vitest';
import { fitView2D, formatCameraRow, formatViewRow, parseViewRow } from './view.ts';

const parse = (text: string, env: Record<string, number> = {}) => parseViewRow(text, env);

describe('parseViewRow', () => {
  it('parses both axes, one axis, and constant bounds', () => {
    expect(parse('view(x = -5..5, y = -2..2)')).toEqual({ kind: 'view', x: [-5, 5], y: [-2, 2] });
    expect(parse('view(y = 0..10)')).toEqual({ kind: 'view', y: [0, 10] });
    expect(parse('view(x = -pi..pi)')).toEqual({ kind: 'view', x: [-Math.PI, Math.PI] });
    expect(parse('view(x = -a..a)', { a: 2 })).toEqual({ kind: 'view', x: [-2, 2] });
  });

  it('parses camera angles with optional radius and target in either order', () => {
    expect(parse('camera(-pi/3, 0.6)')).toEqual({ kind: 'camera', theta: -Math.PI / 3, phi: 0.6 });
    expect(parse('camera(0, 1, 7)')).toEqual({ kind: 'camera', theta: 0, phi: 1, radius: 7 });
    expect(parse('camera(0, 1, 7, (1, 0, 2))')).toEqual({
      kind: 'camera',
      theta: 0,
      phi: 1,
      radius: 7,
      target: [1, 0, 2],
    });
    expect(parse('camera(0, 1, (1, 0, 2))')).toEqual({
      kind: 'camera',
      theta: 0,
      phi: 1,
      target: [1, 0, 2],
    });
  });

  it('returns null for rows that are not viewport rows', () => {
    expect(parse('y = x^2')).toBeNull();
    expect(parse('viewer(x = 1..2)')).toBeNull(); // prefix only — no false claim
    expect(parse('a = 2')).toBeNull();
    expect(parse('view(x = 1..2) + 1')).toBeNull(); // not the whole row
  });

  it('gives row-friendly errors for malformed viewport rows', () => {
    expect(() => parse('view()')).toThrow(/Expected view/);
    expect(() => parse('view(z = 1..2)')).toThrow(/x and y/);
    expect(() => parse('view(x = 5..-5)')).toThrow(/lo < hi/);
    expect(() => parse('view(x = 1..2, x = 3..4)')).toThrow(/twice/);
    expect(() => parse('view(x = 1)')).toThrow(/Expected view/);
    expect(() => parse('view(x = q..2)')).toThrow(/lower bound/);
    expect(() => parse('camera(1)')).toThrow(/Expected camera/);
    expect(() => parse('camera(0, 1, -3)')).toThrow(/positive/);
    expect(() => parse('camera(0, 1, (1, 2))')).toThrow(/3 components/);
  });
});

describe('fitView2D', () => {
  it('fits the whole box at uniform scale, centered', () => {
    // A 10×4 box in a 100×100 viewport: x is the binding axis.
    const v = fitView2D({ kind: 'view', x: [0, 10], y: [-2, 2] }, 100, 100);
    expect(v).toEqual({ cx: 5, cy: 0, upp: 0.1 });
    // Same box in a wide viewport: y binds instead.
    const w = fitView2D({ kind: 'view', x: [0, 10], y: [-2, 2] }, 1000, 10);
    expect(w.upp).toBeCloseTo(0.4);
  });

  it('centers a missing axis at 0', () => {
    const v = fitView2D({ kind: 'view', x: [90, 110] }, 200, 100);
    expect(v).toEqual({ cx: 100, cy: 0, upp: 0.1 });
  });
});

describe('writeback round-trip', () => {
  it('view row text survives format -> parse', () => {
    const text = formatViewRow(-4.133333, 5.87, -2.4, 2.4);
    expect(parse(text)).toEqual({ kind: 'view', x: [-4.13333, 5.87], y: [-2.4, 2.4] });
  });

  it('keeps a window zoomed deep at a large offset open', () => {
    // Six significant digits round 99.99995 and 100.00005 to the same number,
    // which the parser rejects; the formatter must add digits until lo < hi.
    const text = formatViewRow(100 - 5e-5, 100 + 5e-5, -3e-6, 3e-6);
    expect(text).toBe('view(x = 99.99995..100.00005, y = -0.000003..0.000003)');
    const spec = parse(text);
    expect(spec).toEqual({ kind: 'view', x: [99.99995, 100.00005], y: [-3e-6, 3e-6] });
    // Ordinary windows still use the six-digit trim.
    expect(formatViewRow(-4.133333, 5.87, -2.4, 2.4)).toBe('view(x = -4.13333..5.87, y = -2.4..2.4)');
    // A genuinely collapsed window is not rescued: the caller sees the error.
    expect(() => parse(formatViewRow(1, 1, 0, 1))).toThrow(/lo < hi/);
  });

  it('camera row text survives format -> parse, dropping an origin target', () => {
    const noTarget = formatCameraRow({ theta: -1.0471975, phi: 0.5711986, radius: 14, target: [0, 0, 0] });
    expect(noTarget).toBe('camera(-1.0472, 0.571199, 14)');
    expect(parse(noTarget)).toEqual({ kind: 'camera', theta: -1.0472, phi: 0.571199, radius: 14 });
    const withTarget = formatCameraRow({ theta: 0, phi: 1, radius: 7, target: [1.25, 0, -2] });
    expect(parse(withTarget)).toEqual({ kind: 'camera', theta: 0, phi: 1, radius: 7, target: [1.25, 0, -2] });
  });

  it('keeps a camera spin through format -> parse, and omits a zero one', () => {
    const spinning = formatCameraRow({ theta: 0, phi: 1, radius: 7, target: [1, 0, 0], spin: -0.3 });
    expect(spinning).toBe('camera(0, 1, 7, (1, 0, 0), spin = -0.3)');
    expect(parse(spinning)).toEqual({ kind: 'camera', theta: 0, phi: 1, radius: 7, target: [1, 0, 0], spin: -0.3 });
    expect(formatCameraRow({ theta: 0, phi: 1, radius: 7, target: [0, 0, 0], spin: 0 })).toBe('camera(0, 1, 7)');
  });

  it('writes the angle a spun camera shows, without float dust', () => {
    expect(formatCameraRow({ theta: 6.66e-16, phi: 1, radius: 7, target: [0, 0, 0] })).toBe('camera(0, 1, 7)');
    expect(formatCameraRow({ theta: 1 + 40 * Math.PI, phi: 1, radius: 7, target: [0, 0, 0] })).toBe('camera(1, 1, 7)');
    expect(formatCameraRow({ theta: -1 - 6 * Math.PI, phi: 1, radius: 7, target: [0, 0, 0] })).toBe('camera(-1, 1, 7)');
  });

  it('reads spin as a trailing named argument after any positional ones', () => {
    expect(parse('camera(0, 1, spin = 0.5)')).toEqual({ kind: 'camera', theta: 0, phi: 1, spin: 0.5 });
    expect(parse('camera(0, 1, spin = pi/10)')).toMatchObject({ spin: Math.PI / 10 });
    expect(parse('camera(0, 1, spin = w)', { w: 2 })).toMatchObject({ spin: 2 });
    expect(parse('camera(0, 1, 7, spin = 0)')).toEqual({ kind: 'camera', theta: 0, phi: 1, radius: 7 });
    expect(() => parse('camera(0, 1, spin =)')).toThrow(/Expected camera/);
    expect(() => parse('camera(spin = 1, 0, 1)')).toThrow();
  });
});

describe('independent axis scaling', () => {
  it('parses positive ratios, including expressions, and rejects invalid settings', () => {
    expect(parse('view(x=-10..10, ratio=a/2)', { a: 10 })).toEqual({ kind: 'view', x: [-10, 10], ratio: 5 });
    for (const value of ['0', '-1', '1/0', 'q']) {
      expect(() => parse(`view(x=-1..1, ratio=${value})`)).toThrow();
    }
    expect(() => parse('view(ratio=2)')).toThrow();
    expect(() => parse('view(x=-1..1, ratio=2, ratio=3)')).toThrow(/twice/);
  });

  it('fits all bounds while preserving the ratio on different screens', () => {
    for (const [w, h] of [
      [800, 400],
      [400, 800],
    ]) {
      const v = fitView2D({ kind: 'view', x: [-10, 10], y: [-1, 1], ratio: 5 }, w, h);
      expect(w * v.upp).toBeGreaterThanOrEqual(20);
      expect((h * v.upp) / v.ratio!).toBeGreaterThanOrEqual(2);
      expect(v.ratio).toBe(5);
      const row = formatViewRow((-w * v.upp) / 2, (w * v.upp) / 2, (-h * v.upp) / 10, (h * v.upp) / 10, v.ratio);
      expect(fitView2D(parse(row) as import('./view.ts').View2DSpec, w, h)).toEqual(v);
    }
  });

  it('anchors independent scaling and preserves proportions for uniform zoom', () => {
    const v = { cx: 3, cy: -2, upp: 0.1, ratio: 5 };
    const scaled = scaleViewAt(v, 100, -50, 2, 0.5);
    expect(scaled.cx + 100 * scaled.upp).toBeCloseTo(13);
    expect(scaled.cy - (50 * scaled.upp) / scaled.ratio).toBeCloseTo(-3);
    expect(scaled.ratio).toBe(20);
    expect(scaleViewAt(v, 0, 0, 2, 2).ratio).toBe(5);
  });
});
