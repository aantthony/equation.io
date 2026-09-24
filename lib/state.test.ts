import { compileCpu, compileGpu } from './compiler.ts';
import { evaluateFrame } from './env.ts';
import { describe, expect, it } from 'vitest';
import { type Definition, buildDefs, compsOf, scanDefinition } from './defs.ts';
import { parseExpr } from './expr.ts';
import { lowerGeom } from './geom.ts';
import { classify } from './plot.ts';
import { uniformName } from './glsl.ts';
import { type StateSystem, advanceState, buildStateSystem, initialState } from './state.ts';

const rows = (...texts: string[]): Definition[] =>
  texts.map(t => scanDefinition(t)).filter((d): d is Definition => d !== null);

/** Build a graph's definitions and its state system, integrated to `to`. */
function run(texts: string[], to: number) {
  const { defs, errors } = buildDefs(rows(...texts));
  const sys = buildStateSystem(defs)!;
  const values = initialState(defs, sys);
  // One call per 1/60 s frame, carrying the reached time as the loop does.
  let now = 0;
  for (let f = 1; f <= Math.round(to * 60); f++) {
    now = advanceState(defs, sys, values, now, f / 60);
  }
  return { defs, errors, sys, values };
}

describe('scanDefinition', () => {
  it('detects states and initial values', () => {
    expect(scanDefinition("a' = p")).toEqual({ kind: 'state', name: 'a', rhs: ' p' });
    expect(scanDefinition('a(0) = 2.5')).toEqual({ kind: 'init', name: 'a', rhs: ' 2.5' });
  });

  it('leaves the ODE forms alone', () => {
    // y' = f and dy/dx = f are slope fields, not states: the primed names here
    // are the reserved coordinates.
    expect(scanDefinition("y' = x - y")).toBeNull();
    expect(scanDefinition('dy/dx = y')).toBeNull();
    expect(
      compileCpu(classify({ kind: 'eq', l: { kind: 'var', name: "y'" }, r: { kind: 'var', name: 'x' } })),
    ).toMatchObject({ type: 'vfield2d' });
  });
});

describe('integration', () => {
  it('solves a harmonic oscillator', () => {
    // a' = p, p' = -a with a(0) = 1 is (cos t, -sin t).
    const { values } = run(["a' = p", "p' = -a", 'a(0) = 1'], 2);
    expect(values.a).toBeCloseTo(Math.cos(2), 5);
    expect(values.p).toBeCloseTo(-Math.sin(2), 5);
  });

  it('conserves energy over a long run', () => {
    const { values } = run(["a' = p", "p' = -sin(a)", 'a(0) = 3'], 30);
    const energy = 0.5 * values.p ** 2 + (1 - Math.cos(values.a));
    expect(energy).toBeCloseTo(1 - Math.cos(3), 4);
  });

  it('starts states with no initial value at zero', () => {
    const { defs, sys } = run(["a' = 1"], 0);
    expect(initialState(defs, sys)).toEqual({ a: 0 });
  });

  it('reads initial values from constants', () => {
    const { defs, sys } = run(['c = 2', "a' = 0", 'a(0) = c/4'], 0);
    expect(initialState(defs, sys).a).toBe(0.5);
  });

  it('drives a state from t', () => {
    const { values } = run(["a' = cos(t)"], 1); // a(t) = sin t
    expect(values.a).toBeCloseTo(Math.sin(1), 5);
  });

  it('takes the same steps however the frames are chopped up', () => {
    // 250 Hz frames are shorter than one step; the leftover carries instead of
    // shrinking the step, so a fast display and a slow one agree exactly.
    const { defs, sys } = run(["a' = p", "p' = -a", 'a(0) = 1'], 0);
    const oneFrame = initialState(defs, sys);
    expect(advanceState(defs, sys, oneFrame, 0, 0.2)).toBeCloseTo(0.2, 12);
    const many = initialState(defs, sys);
    let now = 0;
    for (let k = 1; k <= 50; k++) now = advanceState(defs, sys, many, now, k / 250);
    expect(now).toBeCloseTo(0.2, 12);
    expect(many.a).toBe(oneFrame.a); // bit-identical, not merely close
    expect(oneFrame.a).toBeCloseTo(Math.cos(0.2), 9);
  });

  it('holds the last good values when a system blows up', () => {
    // a' = a² escapes to infinity at t = 1.
    const { defs, sys } = run(["a' = a^2", 'a(0) = 1'], 0);
    const values = initialState(defs, sys);
    for (let f = 1; f <= 180; f++) advanceState(defs, sys, values, (f - 1) / 60, f / 60);
    expect(isFinite(values.a)).toBe(true);
  });

  it('runs slow rather than freezing on a huge time gap', () => {
    // A backgrounded tab hands back minutes at once; the step cap bounds work.
    const { defs, sys } = run(["a' = 1"], 0);
    const values = initialState(defs, sys);
    expect(advanceState(defs, sys, values, 0, 600)).toBe(600);
    expect(values.a).toBeCloseTo(0.25, 6); // 60 steps of 1/240 s
  });
});

describe('states and constants', () => {
  it('lets constants read a state', () => {
    const { defs, values } = run(['E = a^2 + p^2', "a' = p", "p' = -a", 'a(0) = 1'], 1);
    expect(evaluateFrame(defs, 1, values).E).toBeCloseTo(1, 5);
  });

  it('feeds a constant back into a derivative', () => {
    // k is a formula in the state, so it is re-evaluated at every RK4 stage.
    const { values } = run(['k = -a', "a' = p", "p' = k", 'a(0) = 1'], 2);
    expect(values.a).toBeCloseTo(Math.cos(2), 5);
  });

  it('treats states as uniforms in compiled fields', () => {
    const { defs } = buildDefs(rows("a' = 1"));
    const cls = classify(
      { kind: 'eq', l: { kind: 'var', name: 'y' }, r: { kind: 'var', name: 'a' } },
      new Set(defs.states.keys()),
    );
    expect(cls.params).toEqual(['a']);
    expect((compileGpu(cls) as { field: string }).field).toContain('u_a');
  });
});

describe('errors', () => {
  it('rejects a derivative that depends on the plane', () => {
    const { errors } = buildDefs(rows("a' = x"));
    expect(errors.get('a')).toMatch(/only use t, constants, and other states/);
  });

  it('rejects an initial value that is not constant', () => {
    const { errors } = buildDefs(rows("a' = 1", 'a(0) = x'));
    expect(errors.get('a(0)')).toMatch(/must be constant/);
  });

  it('reports an initial value with no state', () => {
    const { errors } = buildDefs(rows('a(0) = 1'));
    expect(errors.get('a(0)')).toMatch(/a' is not defined/);
  });

  it('keeps a and a(0) as separate rows', () => {
    const { defs } = buildDefs(rows("a' = p", "p' = 0", 'a(0) = 1', 'p(0) = 2'));
    expect([...defs.states.keys()]).toEqual(['a', 'p']);
    expect(initialState(defs, buildStateSystem(defs)!)).toEqual({ a: 1, p: 2 });
  });
});

describe('system identity', () => {
  const key = (...texts: string[]): string => (buildStateSystem(buildDefs(rows(...texts)).defs) as StateSystem).key;

  it('survives edits elsewhere in the graph', () => {
    expect(key("a' = p", "p' = -a", 'c = 1')).toBe(key("a' = p", "p' = -a", 'c = 2'));
  });

  it('changes when the system or its start changes', () => {
    expect(key("a' = p", "p' = -a", 'a(0) = 1')).not.toBe(key("a' = p", "p' = -2a", 'a(0) = 1'));
    expect(key("a' = p", "p' = -a", 'a(0) = 1')).not.toBe(key("a' = p", "p' = -a", 'a(0) = 2'));
  });
});

describe('vector states', () => {
  it('splits a vector derivative into _1/_2 scalar states', () => {
    const { defs, errors } = buildDefs(rows("r' = (r_2, -r_1)", 'r(0) = (1, 0)'));
    expect(errors.size).toBe(0);
    expect(defs.vecStates.get('r')).toBe(2);
    expect([...defs.states.keys()]).toEqual(['r_1', 'r_2']);
  });

  it('integrates a circular orbit written as vectors', () => {
    // r' = perp(r) rotates: r(t) = (cos t, sin t).
    const { values } = run(["r' = perp(r)", 'r(0) = (1, 0)'], 2);
    expect(values.r_1).toBeCloseTo(Math.cos(2), 5);
    expect(values.r_2).toBeCloseTo(Math.sin(2), 5);
  });

  it('integrates gravity in vector form', () => {
    // r'' = -r/|r|^3 on the unit circle at speed 1 stays on the circle.
    // (vel, not v: u and v are the reserved parametric parameters.)
    const { values } = run(["r' = vel", "vel' = -r/|r|^3", 'r(0) = (1, 0)', 'vel(0) = (0, 1)'], 3);
    expect(Math.hypot(values.r_1, values.r_2)).toBeCloseTo(1, 3);
    expect(values.r_1).toBeCloseTo(Math.cos(3), 3);
    expect(values.r_2).toBeCloseTo(Math.sin(3), 3);
  });

  it("propagates dims through th' = om", () => {
    // th's derivative is the bare name om; om's own row makes om a vector,
    // and a second discovery pass makes th one too.
    const { defs, errors } = buildDefs(rows("th' = om", "om' = (-sin(th_1), -sin(th_2))", 'th(0) = (2.5, 2.4)'));
    expect(errors.size).toBe(0);
    expect(defs.vecStates.get('th')).toBe(2);
    expect(defs.vecStates.get('om')).toBe(2);
    expect([...defs.states.keys()].sort()).toEqual(['om_1', 'om_2', 'th_1', 'th_2']);
  });

  it('takes its dimension from the starting value alone', () => {
    // A constant-vector derivative: dim comes from r(0).
    const { defs, errors } = buildDefs(rows("r' = (0, 0, 1)", 'r(0) = (1, 2, 0)'));
    expect(errors.size).toBe(0);
    expect(defs.vecStates.get('r')).toBe(3);
  });

  it('runs a 3-component state (Lorenz)', () => {
    const { defs, values } = run(
      ["r' = (10(r_2 - r_1), r_1(28 - r_3) - r_2, r_1 r_2 - 8 r_3/3)", 'r(0) = (1, 1, 20)'],
      2,
    );
    expect(defs.vecStates.get('r')).toBe(3);
    expect([values.r_1, values.r_2, values.r_3].every(isFinite)).toBe(true);
    // The attractor keeps trajectories in a bounded box.
    expect(Math.abs(values.r_3)).toBeLessThan(60);
  });

  it('reports a dim mismatch between deriv and init on the right rows', () => {
    // The derivative declares the dim first, so the init is the odd row out.
    const a = buildDefs(rows("r' = (1, 2)", 'r(0) = (1, 2, 3)'));
    expect(a.errors.get('r(0)')).toMatch(/2-component state.*r\(0\) has 3 components/);
    const b = buildDefs(rows("a' = 1", 'a(0) = (1, 2)'));
    expect(b.errors.get('a(0)')).toMatch(/2 components, but a is a single number/);
  });

  it('rejects component names that are already defined', () => {
    const { errors } = buildDefs(rows('r_1 = 5', "r' = (1, 2)"));
    expect(errors.get('r')).toMatch(/r_1 is already defined/);
  });

  it('draws the bare name as a point and picks off components', () => {
    const { defs } = buildDefs(rows("r' = perp(r)", 'r(0) = (1, 0)'));
    const comps = compsOf(defs, 'r');
    expect(comps).toEqual(['r_1', 'r_2']);
    // A plot row `r` lowers to (r_1, r_2) and classifies as a point whose
    // coordinates are the component states (uniform-backed like constants).
    const lowered = lowerGeom(parseExpr('r'), n => compsOf(defs, n));
    const cls = classify(lowered, new Set(defs.states.keys()));
    expect(compileCpu(cls)).toMatchObject({ type: 'point', dim: 2 });
    expect([...cls.params].sort()).toEqual(['r_1', 'r_2']);
    // Pickoff: y = r_1 is an ordinary scalar plot in the component state.
    const pick = classify(
      lowerGeom(parseExpr('y = r_1'), n => compsOf(defs, n)),
      new Set(defs.states.keys()),
    );
    expect((compileGpu(pick) as { field: string }).field).toContain(uniformName('r_1'));
    // The subscript spelling is the same name: y = r₁ picks off the same way.
    const sub = classify(
      lowerGeom(parseExpr('y = r₁'), n => compsOf(defs, n)),
      new Set(defs.states.keys()),
    );
    expect((compileGpu(sub) as { field: string }).field).toContain(uniformName('r_1'));
  });

  it('lowers point arithmetic in derivatives of scalar states', () => {
    // A scalar state may use vector machinery: E' = dot(r, r).
    const { defs, errors } = buildDefs(rows("r' = perp(r)", 'r(0) = (1, 0)', "E' = dot(r, r)"));
    expect(errors.size).toBe(0);
    expect(defs.vecStates.has('E')).toBe(false);
    expect(defs.states.has('E')).toBe(true);
  });

  it('bit-matches the hand-written scalar system', () => {
    const vec = run(["r' = perp(r)", 'r(0) = (1, 0)'], 1);
    const scal = run(["p' = -q", "q' = p", 'p(0) = 1', 'q(0) = 0'], 1);
    // perp((r_1, r_2)) = (-r_2, r_1): identical component derivatives.
    expect(vec.values.r_1).toBe(scal.values.p);
    expect(vec.values.r_2).toBe(scal.values.q);
  });
});
