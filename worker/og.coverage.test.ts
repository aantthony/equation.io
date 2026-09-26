/**
 * The og renderer is a second backend for lib/plot.ts, so it drifts: a type
 * added for the GPU app draws nothing here, and a preview of an empty grid
 * reads as a broken graph.
 *
 * Coverage itself is enforced by the compiler — OG_COVERAGE is a total Record
 * over PublicKind, so a new plot family fails `pnpm typecheck` until it is
 * classified. These tests cover what types cannot: that the classification is
 * honest, and that callers act on it.
 */
import { describe, expect, it } from 'vitest';
import { OG_COVERAGE, canRenderOg, previewGap } from './og.ts';
import { analyze } from './graph.ts';

describe('og renderer coverage', () => {
  it('draws the everyday 2D and 3D families', () => {
    for (const t of [
      'implicit2d',
      'ineq2d',
      'scalar2d',
      'point',
      'pcurve',
      'psurface',
      'implicit3d',
      'polygon',
      'plist',
      'cobweb',
      'system',
      'vfield2d',
    ] as const) {
      expect(OG_COVERAGE[t], t).toBe('draws');
    }
  });

  it('falls back for every shader-only family', () => {
    for (const t of ['complex2d', 'domain2d', 'rgb2d', 'hsl2d', 'oklch2d', 'conformal2d', 'fractal2d'] as const) {
      expect(OG_COVERAGE[t], t).toBe('fallback');
    }
  });

  it('falls back for the rest of the sequence family', () => {
    for (const t of ['sequence', 'bifurcation', 'vlist'] as const) {
      expect(OG_COVERAGE[t], t).toBe('fallback');
    }
  });
});

describe('canRenderOg', () => {
  it('accepts graphs built only from drawable rows', () => {
    expect(canRenderOg(['y = sin(x)'])).toBe(true);
    expect(canRenderOg(['x^2 + y^2 = 9', 'y < cos(x)'])).toBe(true);
    expect(canRenderOg(['z = sin(x) cos(y)'])).toBe(true);
    expect(canRenderOg(['(cos(2pi u), sin(2pi u), u)'])).toBe(true);
    expect(canRenderOg(['a = 2', 'y = sin(a x)'])).toBe(true); // definition + plot
    expect(canRenderOg(['A = (0, 0)', 'B = (4, 0)', 'C = (0, 4)', 'polygon(A, B, C)'])).toBe(true);
    // Random-variable rows classify to implicit2d/ineq2d, which both draw.
    expect(canRenderOg(['X ~ Normal(0, 1)', 'P(X < 1)'])).toBe(true);
    // E(…) rows draw as a mean marker.
    expect(canRenderOg(['X ~ Normal(0, 1)', 'E(X)'])).toBe(true);
    // ∫ rows resolve to ordinary expressions (closed form or quadrature sum).
    expect(canRenderOg(['y = int[0..x] exp(-t^2) dt'])).toBe(true);
    expect(canRenderOg(['y = int[0..x] sin(t)/t dt'])).toBe(true);
    // A label's text is left out, in 3D as in 2D, but the rest still draws.
    expect(canRenderOg(['y = x^2', 'label((1, 1), "here")'])).toBe(true);
    expect(canRenderOg(['z = x^2 - y^2', 'label((0, 0, 0), "saddle")'])).toBe(true);
  });

  it('rejects a graph of labels alone, which would preview as a bare grid', () => {
    expect(canRenderOg(['label((1, 2), "peak")'])).toBe(false);
    expect(canRenderOg(['label((0, 0, 1), "top")', 'label((1, 2), "peak")'])).toBe(false);
  });

  it('rejects graphs whose preview would be misleading', () => {
    expect(canRenderOg(['domain((w^3 - 1)/w)'])).toBe(false);
    expect(canRenderOg(['rgb(1, 0, 0)'])).toBe(false);
    expect(canRenderOg(['hsl(2pi/3, 1, 0.5)'])).toBe(false);
    expect(canRenderOg(['oklch(0.7, 0.15, 2pi/3)'])).toBe(false);
    expect(canRenderOg(['iter(z^2 + w)'])).toBe(false);
    expect(canRenderOg(['conformal(w^2/4)'])).toBe(false);
    expect(canRenderOg(['(-y, x)'])).toBe(true);
    expect(canRenderOg(['w^3 = 1', '1+2i'])).toBe(true);
    expect(canRenderOg(['ln(w-2) - ln(w+2)'])).toBe(false);
    // One unsupported row poisons the graph: a partial picture is still wrong.
    expect(canRenderOg(['y = sin(x)', 'iter(z^2 + w)'])).toBe(false);
    // Sequence rows classify without a resolved expr — the gap must still be seen.
    expect(canRenderOg(['a_n = 1/n^2'])).toBe(false);
    // ...but a recurrence with no parameter axis is a cobweb, which draws.
    expect(canRenderOg(['r = 1.9', 'a_{n+1} = r a_n (1 - a_n)'])).toBe(true);
  });

  it('rejects the within-type gaps OG_COVERAGE cannot express', () => {
    // implicit3d is a 'draws' type, but only the z = f(x, y) form draws:
    // a sphere would preview as an EMPTY grid, the worst possible card.
    expect(canRenderOg(['x^2 + y^2 + z^2 = 9'])).toBe(false);
    // revolve(f) IS such a surface, so it takes the same site-card fallback.
    expect(canRenderOg(['revolve(sqrt(x))'])).toBe(false);
    // 2D rows are skipped in a 3D scene, so a mixed graph drops rows.
    expect(canRenderOg(['z = x^2 + y^2', 'y = sin(x)'])).toBe(false);
    expect(canRenderOg(['z = x^2 + y^2', '(2cos(2pi u), 2sin(2pi u))'])).toBe(false);
    // The same rows are fine when the graph they are in stays 2D.
    expect(canRenderOg(['y = sin(x)', '(2cos(2pi u), 2sin(2pi u))'])).toBe(true);
  });

  it('rejects graphs with nothing to draw', () => {
    expect(canRenderOg([])).toBe(false);
    expect(canRenderOg(['a = 2'])).toBe(false); // definitions only
    expect(canRenderOg(['y = ('])).toBe(false); // parse error
    expect(canRenderOg(['view(x = 0..1)'])).toBe(false); // viewport only
  });

  it('treats viewport rows as framing, not plots', () => {
    expect(canRenderOg(['view(x = 0..1)', 'y = sin(x)'])).toBe(true);
    expect(canRenderOg(['camera(0, 1)', 'z = x^2 + y^2'])).toBe(true);
  });
});

describe('previewGap', () => {
  // These strings go to assistants deciding whether the GRAPH works, so each
  // must blame the preview and say what the live app does with the row.
  const gap = (texts: string[], i = 0) => {
    const rows = analyze(texts).rows.filter(r => r.cls);
    return previewGap(
      rows[i],
      rows.some(r => r.cls!.needs3D),
    );
  };

  it('is null for every row the renderer draws', () => {
    expect(gap(['y = sin(x)'])).toBeNull();
    expect(gap(['z = x^2 + y^2'])).toBeNull();
    expect(gap(['(cos(2pi u), sin(2pi u), u)'])).toBeNull();
    expect(gap(['exp(i 2 pi u)'])).toBeNull();
  });

  it('is null for discrete distributions: stems, selected stems and the mean marker all draw', () => {
    const rows = ['X ~ Binomial(10, 0.3)', 'P(X <= 3)', 'E(X)'];
    for (let i = 0; i < rows.length; i++) expect(gap(rows, i)).toBeNull();
    expect(canRenderOg(rows)).toBe(true);
  });

  it('is null for a point list, in the plane or in space', () => {
    expect(gap(['[(1,2),(3,4)]'])).toBeNull();
    expect(gap(['([0,1],[0,1],[0,1])'])).toBeNull();
    expect(gap(['[0,1] e_x + [0,1] e_y'])).toBeNull();
    expect(gap(['z = x^2 + y^2', '[(1,2),(3,4)]'], 1)).toBeNull();
    expect(canRenderOg(['([0,1],[0,1],[0,1])'])).toBe(true);
  });

  it('is null for a cobweb, which now draws', () => {
    expect(gap(['r = 1.9', 'a_{n+1} = r a_n (1 - a_n)'])).toBeNull();
  });

  it('blames the preview, not the row, for an orbit diagram', () => {
    const why = gap(['a_{n+1} = x a_n (1 - a_n)'])!;
    expect(why).toContain('bifurcation');
    expect(why).toContain('live app renders');
  });

  it('explains the sphere without impugning it', () => {
    const why = gap(['x^2 + y^2 + z^2 = 9'])!;
    expect(why).toContain('z = f(x, y)');
    expect(why).toContain('live app renders');
  });

  it('falls back for surfaces and draws points and curves in a spherical chart', () => {
    const chart = ['rho = sqrt(x^2+y^2+z^2)', 'theta = atan2(y,x)', 'phi = acos(z/rho)'];
    for (const row of ['rho = 2', 'phi = pi/4', 'rho = 1 + cos(3 theta)']) {
      expect(gap([...chart, row])).toContain('z = f(x, y)');
      expect(canRenderOg([...chart, row])).toBe(false);
    }
    // `z = 2 rho cos(phi)` has z on both sides once the fields substitute in:
    // an implicit surface, not the heightmap its left side suggests.
    expect(gap([...chart, 'z = 2 rho cos(phi)'])).toContain('z = f(x, y)');
    expect(gap(['z = z^2 + x'])).toContain('z = f(x, y)');
    expect(canRenderOg([...chart, '(rho, theta, phi) = (2, pi/4, pi/3)'])).toBe(true);
    expect(canRenderOg([...chart, '(rho, theta, phi) = (2, 6 pi u, pi u)'])).toBe(true);
    // Definitions alone draw nothing, in space as in the plane.
    expect(canRenderOg(chart)).toBe(false);
  });

  it('explains revolve(f) as the implicit surface it is', () => {
    expect(gap(['revolve(sin(x) + 2)'])).toBe(gap(['y^2 + z^2 = (sin(x) + 2)^2']));
    expect(gap(['revolve(sqrt(y), y)'])).toContain('live app renders');
  });

  it('says what the app does with 2D rows in a 3D scene', () => {
    expect(gap(['z = x^2 + y^2', 'y = sin(x)'], 1)).toContain('vertical sheets');
    expect(gap(['z = x^2 + y^2', '(2, 3)'], 1)).toContain('z = 0 plane');
    // ...except the families the app itself skips in 3D — no false promises.
    expect(gap(['z = x^2 + y^2', 'sin(x)cos(y)'], 1)).toContain('skips them there too');
    expect(gap(['z = x^2 + y^2', 'A = (0, 0)', 'B = (4, 0)', 'C = (0, 4)', 'polygon(A, B, C)'], 1)).toBeNull();
  });
});
