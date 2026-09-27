/**
 * grad, div, curl and laplacian, their ∇ spellings, `·`/`×` between vectors,
 * and equations that hold everywhere (lib/defs.ts, lib/geom.ts, lib/plot.ts).
 */
import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { evaluate, type Expr } from './expr.ts';

/** The last row: its object kind, readout and error. */
function last(rows: string[]) {
  const a = analyzeRows(rows, { readouts: true });
  const row = a.rows[a.rows.length - 1];
  return { kind: row.cls?.object.kind, info: row.info, error: row.error, object: row.cls?.object };
}

/** The last row's value at a point: a scalar field, value or scalar over
 *  space as [v], a vector as its components. A bare scalar over space draws
 *  nothing, so it is read as the first component of the field (…, 0, 0). */
function at(rows: string[], env: Record<string, number>): number[] {
  let a = analyzeRows(rows);
  if (a.rows.at(-1)!.error?.includes('field in space')) {
    a = analyzeRows([...rows.slice(0, -1), `(${rows.at(-1)}, 0, 0)`]);
    const field = a.rows.at(-1)!.cls?.object;
    if (field?.kind === 'vector-field') return [evaluate(field.components[0], { t: 0, ...a.constEnv, ...env })];
  }
  const row = a.rows[a.rows.length - 1];
  if (row.error) throw new Error(row.error);
  const object = row.cls?.object;
  const exprs: readonly Expr[] =
    object?.kind === 'vector-field'
      ? object.components
      : object?.kind === 'scalar-field' || object?.kind === 'value'
        ? [object.expr]
        : object?.kind === 'surface' && object.form === 'implicit'
          ? [object.residual]
          : object?.kind === 'point' && object.source.representation === 'real'
            ? object.source.coordinates
            : [];
  if (!exprs.length) throw new Error(`unexpected ${object?.kind}`);
  return exprs.map(e => evaluate(e, { t: 0, ...a.constEnv, ...env }));
}

const P = { x: 0.7, y: -1.3, z: 0.4 };

describe('vector calculus operators', () => {
  it('grad is the tuple of partial derivatives, in 2D and 3D', () => {
    const { x, y, z } = P;
    expect(at(['grad(x^2 y)'], P)).toEqual([2 * x * y, x * x].map(v => expect.closeTo(v)));
    expect(at(['grad(x y z + z^2)'], P)).toEqual([y * z, x * z, x * y + 2 * z].map(v => expect.closeTo(v)));
    expect(last(['grad(x y z)']).kind).toBe('vector-field');
  });

  it('div sums the diagonal partials', () => {
    const { x, y, z } = P;
    expect(at(['div((x y, y^2))'], P)).toEqual([expect.closeTo(y + 2 * y)]);
    expect(at(['div((x^2, y z, sin(z)))'], P)).toEqual([expect.closeTo(2 * x + z + Math.cos(z))]);
    expect(last(['div((x y, y^2))']).kind).toBe('scalar-field');
  });

  it('curl is a scalar in the plane and a vector field in space', () => {
    const { x, y, z } = P;
    expect(last(['curl((-y, x))']).info).toBe('= 2');
    expect(at(['curl((x^2 y, x y^2))'], P)).toEqual([expect.closeTo(y * y - x * x)]);
    // (y z, -x z, x y): (∂R/∂y − ∂Q/∂z, ∂P/∂z − ∂R/∂x, ∂Q/∂x − ∂P/∂y)
    expect(at(['curl((y z, -x z, x y))'], P)).toEqual([x + x, y - y, -z - z].map(v => expect.closeTo(v)));
    expect(last(['curl((y z, -x z, x y))']).kind).toBe('vector-field');
  });

  it('laplacian sums the second partials of a scalar', () => {
    const { x, y, z } = P;
    expect(last(['laplacian(x^2 + y^2)']).info).toBe('= 4');
    expect(at(['laplacian(x^3 y + z^4)'], P)).toEqual([expect.closeTo(6 * x * y + 12 * z * z)]);
    // 1/ρ is harmonic away from the origin.
    expect(at(['laplacian(1/sqrt(x^2 + y^2 + z^2))'], P)[0]).toBeCloseTo(0, 9);
  });

  it('moves with sliders and t', () => {
    expect(at(['a = 3', 'grad(a x^2)'], P)).toEqual([expect.closeTo(6 * P.x), 0]);
    expect(at(['div((y sin(x - t), 0))'], { ...P, t: 0.5 })).toEqual([expect.closeTo(P.y * Math.cos(P.x - 0.5))]);
  });

  it('differentiates through named functions, fields and vectors', () => {
    const { x, y } = P;
    const f = ['f(x, y) = x^2 y'];
    for (const row of ['grad(f)', '∇f', 'grad(f(x, y))']) {
      expect(at([...f, row], P), row).toEqual([2 * x * y, x * x].map(v => expect.closeTo(v)));
    }
    const r = Math.hypot(x, y);
    expect(at(['r = sqrt(x^2 + y^2)', 'grad(1/r)'], P)).toEqual([-x / r ** 3, -y / r ** 3].map(v => expect.closeTo(v)));
    expect(at(['r = sqrt(x^2 + y^2)', 'd/dx r'], P)).toEqual([expect.closeTo(x / r)]);
    expect(at(['g = x^2 + y^2', 'h = 3g', 'laplacian(h)'], P)).toEqual([expect.closeTo(12)]);
    expect(last(['F = (-y, x)', 'curl(F)']).info).toBe('= 2');
    expect(at(['s = (x, y)', 'div(s/|s|^2)'], P)[0]).toBeCloseTo(0, 9);
    // In a definition too: E = -∇φ is a field, and its divergence is -∇²φ.
    expect(last(['phi = x^2 + y^2', 'E = -∇phi', 'div(E)']).info).toBe('= -4');
  });

  it('reports what cannot be done instead of drawing 0', () => {
    expect(last(['F = (y, -x)', 'grad(F)']).error).toMatch(/div\(F\).*curl\(F\)/);
    expect(last(['grad((x, y))']).error).toMatch(/grad takes a scalar field/);
    expect(last(['curl(x y)']).error).toMatch(/curl takes a vector field/);
    expect(last(['div(x y)']).error).toMatch(/div takes a vector field/);
    expect(last(['laplacian((x, y))']).error).toMatch(/not supported/);
    expect(last(['grad(f)']).error).toMatch(/f is not defined/);
    expect(last(['∇f']).error).toMatch(/f is not defined/);
    expect(last(['f(a, b) = a b', 'grad(f)']).error).toMatch(/grad\(f\(x, y\)\)/);
    // A 3D gradient against a 2D direction.
    expect(last(['grad(x^2 + z^2) · (1, 0)']).error).toMatch(/same number of components/);
  });
});

describe('∇ notation', () => {
  it('means the same as each function form', () => {
    const pairs: Array<[string[], string, string]> = [
      [[], '∇(x^2 y)', 'grad(x^2 y)'],
      [[], '∇ x^2 y', 'grad(x^2 y)'],
      [['f(x, y) = sin(x) y'], '∇f(x, y)', 'grad(f(x, y))'],
      [['F = (x y, y^2 z, x z)'], '∇·F', 'div(F)'],
      [['F = (x y, y^2 z, x z)'], '∇⋅F', 'div(F)'],
      [['F = (x y, y^2 z, x z)'], '∇×F', 'curl(F)'],
      [[], '∇·(x y, y^2)', 'div((x y, y^2))'],
      [['f(x, y) = x^3 y'], '∇^2 f', 'laplacian(f)'],
      [['f(x, y) = x^3 y'], '∇²f', 'laplacian(f)'],
      [[], '2∇(x^2)', '2grad(x^2)'],
      [[], '-∇(x^2 y)', '-grad(x^2 y)'],
    ];
    for (const [defs, nabla, fn] of pairs) {
      expect(at([...defs, nabla], P), nabla).toEqual(at([...defs, fn], P).map(v => expect.closeTo(v)));
    }
  });

  it('stops at a written · or ×, so ∇f · v is a directional derivative', () => {
    const { x, y } = P;
    const f = ['f(x, y) = x^2 - y^2'];
    expect(at([...f, '∇f · (1, 1)/sqrt(2)'], P)).toEqual([expect.closeTo((2 * x - 2 * y) / Math.SQRT2)]);
    expect(at([...f, 'dir = (0, 1)', '∇f · dir'], P)).toEqual([expect.closeTo(-2 * y)]);
  });

  it('leaves a graph that defines its own grad alone', () => {
    expect(last(['grad = 3', 'y = grad x']).kind).toBe('curve');
  });
});

describe('· and × between vectors', () => {
  it('are dot(A, B) and cross(A, B)', () => {
    const pts = ['A = (1, 2, 3)', 'B = (-2, 0.5, 4)'];
    expect(last([...pts, 'A · B']).info).toBe(last([...pts, 'dot(A, B)']).info);
    expect(last([...pts, 'A ⋅ B']).info).toBe(last([...pts, 'dot(A, B)']).info);
    expect(at([...pts, 'A × B'], {})).toEqual(at([...pts, 'cross(A, B)'], {}));
    expect(last(['A = (1, 2)', 'B = (3, 4)', 'A × B']).info).toBe('= -2');
    // Over vector fields too.
    expect(at(['(x, y) · (y, 1)'], P)).toEqual([expect.closeTo(P.x * P.y + P.y)]);
  });

  it('stay multiplication between numbers', () => {
    expect(last(['x · y']).kind).toBe('scalar-field');
    expect(at(['x · y'], P)).toEqual([expect.closeTo(P.x * P.y)]);
    expect(last(['2×3']).info).toBe('= 6');
    expect(last(['a = 2', 'b = 5', 'a × b']).info).toBe('= 10');
    expect(last(['2 · (1, 2)']).kind).toBe('point');
  });

  it('keep * between vectors an error, pointing at · and ×', () => {
    expect(last(['A = (1, 2)', 'B = (3, 4)', 'A * B']).error).toMatch(/A · B or A × B/);
  });
});

describe('equations that hold everywhere', () => {
  it('read as holding instead of drawing a curve', () => {
    for (const rows of [
      ['sin(x)^2 + cos(x)^2 = 1'],
      ['c = 1', 'g(s) = exp(-s^2)', 'f(x, t) = (g(x - c t) + g(x + c t))/2', 'd^2/dt^2 f(x, t) = c^2 ∇^2 f(x, t)'],
      ['h = sin(x) sin(y) cos(sqrt(2) t)', 'd^2/dt^2 h = ∇^2 h'],
      ['rho = sqrt(x^2 + y^2 + z^2)', 'd^2/dt^2 (sin(rho - t)/rho) = ∇^2 (sin(rho - t)/rho)'],
      ['curl((-y, x)) = 2 + 0x'],
    ]) {
      const { kind, info } = last(rows);
      expect(kind, rows.at(-1)).toBe('note');
      expect(info).toBe('Holds everywhere (checked numerically)');
    }
  });

  it('leaves near misses and ordinary curves alone', () => {
    expect(last(['sin(x)^2 + cos(x)^2 = 1.0001']).kind).toBe('curve');
    expect(last(['x^2 + y^2 = 1']).kind).toBe('curve');
    expect(last(['min(x, 10) = x']).kind).toBe('curve');
    expect(last(['abs(x) = x']).kind).toBe('curve');
    expect(last(['y = x']).kind).toBe('curve');
    // A wave speed that does not match the solution's.
    expect(last(['h = sin(x - 2t)', 'd^2/dt^2 h = ∇^2 h']).kind).not.toBe('note');
  });
});
