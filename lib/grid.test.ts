import { describe, expect, it } from 'vitest';
import { type Definition, buildDefs, pointComponentNames } from './defs.ts';
import { evaluate } from './expr.ts';
import { angularSpacing, buildGridField, planarField, sampleGradMag } from './grid.ts';

const consts = (...pairs: Array<[string, string]>): Definition[] =>
  pairs.map(([name, rhs]) => ({ kind: 'const', name, rhs }));

describe('coordinate fields in buildDefs', () => {
  it('moves x/y-dependent definitions from consts to fields', () => {
    const { defs, errors } = buildDefs(consts(['a', '2'], ['r', 'sqrt(x^2 + y^2)'], ['theta', 'atan2(y, x)']));
    expect(errors.size).toBe(0);
    expect([...defs.consts.keys()]).toEqual(['a']);
    expect([...defs.fields.keys()]).toEqual(['r', 'theta']);
    expect(evaluate(defs.fields.get('r')!, { x: 3, y: 4 })).toBe(5);
  });

  it('resolves fields defined in terms of other fields', () => {
    const { defs, errors } = buildDefs(consts(['r', 'sqrt(x^2 + y^2)'], ['s', 'r^2']));
    expect(errors.size).toBe(0);
    expect(evaluate(defs.fields.get('s')!, { x: 3, y: 4 })).toBe(25);
  });

  it('keeps constants referenced by fields symbolic', () => {
    const { defs, errors } = buildDefs(consts(['a', '2'], ['s', 'x / a']));
    expect(errors.size).toBe(0);
    expect([...defs.consts.keys()]).toEqual(['a']);
    expect(evaluate(defs.fields.get('s')!, { x: 6, a: 2 })).toBe(3);
  });

  it('rejects field cycles', () => {
    const { defs, errors } = buildDefs(consts(['r', 's + x'], ['s', 'r + y']));
    expect(defs.fields.size).toBe(0);
    expect(errors.get('r')).toMatch(/defined in terms of itself/);
    expect(errors.get('s')).toMatch(/defined in terms of itself/);
  });

  it('rejects fields using variables beyond x, y, z, t, constants', () => {
    const { defs, errors } = buildDefs(consts(['q', 'x + w']));
    expect(defs.fields.size).toBe(0);
    expect(errors.get('q')).toMatch(/found w/);
    // z is a coordinate of space, so a field may use it.
    expect(buildDefs(consts(['q', 'x + z'])).defs.fields.has('q')).toBe(true);
  });

  it('rejects fields with non-evaluable calls', () => {
    const { defs, errors } = buildDefs(consts(['q', 're(x)']));
    expect(defs.fields.size).toBe(0);
    expect(errors.has('q')).toBe(true);
  });

  it('allows time-dependent fields', () => {
    const { defs, errors } = buildDefs(consts(['theta', 'atan2(y, x) + t']));
    expect(errors.size).toBe(0);
    expect(defs.fields.has('theta')).toBe(true);
  });
});

describe('buildGridField', () => {
  const polar = () => buildDefs(consts(['r', 'sqrt(x^2 + y^2)'], ['theta', 'atan2(y, x)'])).defs.fields;

  it('compiles GLSL and a symbolic gradient', () => {
    const f = buildGridField('r', polar().get('r')!, new Set());
    expect(f.glsl).toContain('sqrt');
    expect(f.gradGlsl).toBeDefined();
    expect(f.angular).toBe(false);
    // ∇r at (3,4) is the unit vector (0.6, 0.8).
    expect(evaluate(f.grad![0], { x: 3, y: 4 })).toBeCloseTo(0.6);
    expect(evaluate(f.grad![1], { x: 3, y: 4 })).toBeCloseTo(0.8);
  });

  it('marks atan2-based fields angular', () => {
    const f = buildGridField('theta', polar().get('theta')!, new Set());
    expect(f.angular).toBe(true);
  });

  it('maps constants to u_ uniforms in GLSL only', () => {
    const { defs } = buildDefs(consts(['a', '2'], ['s', 'x / a']));
    const f = buildGridField('s', defs.fields.get('s')!, new Set(defs.consts.keys()));
    expect(f.params).toEqual(['a']);
    expect(f.glsl).toContain('u_a');
    expect(evaluate(f.grad![0], { x: 1, y: 0, a: 2 })).toBe(0.5);
  });

  it('omits the gradient for non-smooth fields', () => {
    const { defs } = buildDefs(consts(['s', 'floor(x) + y']));
    const f = buildGridField('s', defs.fields.get('s')!, new Set());
    expect(f.grad).toBeUndefined();
    expect(f.gradGlsl).toBeUndefined();
  });
});

describe('angularSpacing', () => {
  it('snaps to divisors of 2π', () => {
    expect(angularSpacing(0.0001, 90).major).toBeCloseTo(Math.PI / 96);
    expect(angularSpacing(0.01, 90).major).toBeCloseTo(Math.PI / 2);
    expect(angularSpacing(1, 90).major).toBeCloseTo(2 * Math.PI);
  });
});

describe('sampleGradMag', () => {
  const polar = buildDefs(consts(['r', 'sqrt(x^2 + y^2)'], ['theta', 'atan2(y, x)'])).defs.fields;

  it('is 1 everywhere for polar r', () => {
    const f = buildGridField('r', polar.get('r')!, new Set());
    expect(
      sampleGradMag(
        f,
        [
          [1, 1],
          [5, 0],
          [0, -3],
        ],
        {},
        0.01,
      ),
    ).toBeCloseTo(1);
  });

  it('skips singular samples (θ at the origin)', () => {
    const f = buildGridField('theta', polar.get('theta')!, new Set());
    // |∇θ| = 1/ρ: median over ρ = {∞(skipped), 2, 2} is 1/2.
    expect(
      sampleGradMag(
        f,
        [
          [0, 0],
          [2, 0],
          [0, 2],
        ],
        {},
        0.01,
      ),
    ).toBeCloseTo(0.5);
  });

  it('falls back to finite differences without a symbolic gradient', () => {
    const { defs } = buildDefs(consts(['s', 'floor(x) + 2y']));
    const f = buildGridField('s', defs.fields.get('s')!, new Set());
    // Away from integer x, ∇(floor(x)+2y) ≈ (0, 2).
    expect(sampleGradMag(f, [[0.5, 0]], {}, 0.05)).toBeCloseTo(2);
  });
});

describe('planarField', () => {
  it('draws a grid family for fields over the plane only', () => {
    const { defs } = buildDefs(consts(['r', 'sqrt(x^2 + y^2)'], ['rho', 'sqrt(r^2 + z^2)'], ['theta', 'atan2(y, x)']));
    expect([...defs.fields].filter(([, e]) => planarField(e)).map(([name]) => name)).toEqual(['r', 'theta']);
  });

  it('does not treat a named vector field as a grid family', () => {
    const { defs, errors } = buildDefs(consts(['s', '(x, y)'], ['r', 'sqrt(x^2 + y^2)']));
    expect(errors.size).toBe(0);
    const skip = pointComponentNames(defs);
    expect([...skip].sort()).toEqual(['s_x', 's_y']);
    expect([...defs.fields].filter(([name, e]) => !skip.has(name) && planarField(e)).map(([name]) => name)).toEqual([
      'r',
    ]);
  });
});
