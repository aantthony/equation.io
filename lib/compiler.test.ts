import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { compileCpu, compileGpu, cpuStructureKey, shaderKey } from './compiler.ts';
import * as complex from './complex.ts';
import * as glsl from './glsl.ts';
import { evaluate, freeVars, parseExpr } from './expr.ts';
import { publicKind } from './math-object.ts';
import { classify } from './plot.ts';

afterEach(() => vi.restoreAllMocks());

describe('semantic classification and independent backends', () => {
  it('classifies all scalar shapes without generating any GLSL', () => {
    const shader = vi.spyOn(glsl, 'toGLSL').mockImplementation(() => {
      throw new Error('GPU invoked');
    });
    const typed = vi.spyOn(complex, 'compileTyped').mockImplementation(() => {
      throw new Error('GPU invoked');
    });
    for (const text of [
      'sin(x)',
      'x+y=2',
      're(w)',
      're(w)=0',
      'w^2=1',
      '1+2i',
      'exp(i u)',
      'domain(w)',
      'iter(z^2+w)',
      '(u,v,u*v)',
    ]) {
      expect(classify(parseExpr(text)).object).toBeDefined();
    }
    expect(shader).not.toHaveBeenCalled();
    expect(typed).not.toHaveBeenCalled();
  });

  it('keeps real result type distinct from complex involvement and validates both operands', () => {
    expect(complex.usesComplex(parseExpr('re(w)'))).toBe(true);
    expect(complex.inferScalarType(parseExpr('re(w)'))).toBe('real');
    expect(complex.inferScalarType(parseExpr('z^2'), { z: 'complex' })).toBe('complex');
    expect(() => complex.inferScalarType(parseExpr('i + floor(i)'))).toThrow(
      'floor is not supported for complex values.',
    );
    expect(publicKind(classify(parseExpr('re(w)')).object)).toBe('scalar2d');
    expect(publicKind(classify(parseExpr('re(w)=0')).object)).toBe('implicit2d');
  });

  it('retains complex point, path and equation sources until CPU projection', () => {
    for (const [text, kind] of [
      ['1+2i', 'point'],
      ['exp(i u)', 'pcurve'],
      ['w^2=1', 'system'],
    ] as const) {
      const classified = classify(parseExpr(text));
      const object = classified.object;
      expect('source' in object && object.source.representation).toBe('complex');
      const before = JSON.stringify(object);
      expect(compileCpu(classified).type).toBe(kind);
      compileGpu(classified);
      expect(JSON.stringify(object)).toBe(before);
    }
    const point = compileCpu(classify(parseExpr('1+2i')));
    if (point.type !== 'point') throw new Error('point');
    expect(point.coords.map(e => evaluate(e, {}))).toEqual([1, 2]);
    const system = compileCpu(classify(parseExpr('w^2=1')));
    if (system.type !== 'system') throw new Error('system');
    for (const x of [-1, 1])
      for (const residual of system.residuals) expect(evaluate(residual, { x, y: 0 })).toBeCloseTo(0);
  });

  it('supports CPU-only analysis and projects real expressions involving complex values', () => {
    const shader = vi.spyOn(glsl, 'toGLSL').mockImplementation(() => {
      throw new Error('GPU invoked');
    });
    const result = analyzeRows(['re(w^2)', 're(w)=2', 're(1+2i)'], { backend: 'cpu' });
    expect(result.rows.map(r => r.error)).toEqual([undefined, undefined, undefined]);
    expect(result.rows.every(r => r.gpu === undefined)).toBe(true);
    const scalar = result.rows[0].cpu!;
    if (scalar.type !== 'scalar2d') throw new Error('scalar');
    expect(evaluate(scalar.expr, { x: 3, y: 2 })).toBe(5);
    expect(result.rows[2].info).toBe('= 1');
    expect(shader).not.toHaveBeenCalled();
  });

  it('keeps graph RHS, normalized residuals, heightmaps and level parameter identity', () => {
    const graph = classify(parseExpr('y = sin(x)'));
    expect(graph.object).toMatchObject({ kind: 'curve', form: 'graph' });
    for (const text of ['y=x^2', 'x^2=y'])
      expect(classify(parseExpr(text)).object).toMatchObject({ kind: 'curve', form: 'graph' });
    expect(classify(parseExpr('x^2+y^2=1')).object).toMatchObject({ kind: 'curve', form: 'implicit' });
    const curve = compileCpu(graph);
    if (curve.type !== 'implicit2d') throw new Error('curve');
    expect(evaluate(curve.residual, { x: 0, y: 2 })).toBe(2);
    const surface = compileCpu(classify(parseExpr('z=x+y')));
    if (surface.type !== 'implicit3d') throw new Error('surface');
    expect(evaluate(surface.heightmap!, { x: 2, y: 3 })).toBe(5);
    const levels = classify(parseExpr('a*x+y=c'), new Set(['a', 'c'])).object;
    if (levels.kind !== 'curve' || levels.form !== 'implicit') throw new Error('levels');
    expect(levels.levels).toMatchObject({ level: 'c', params: ['a'] });
  });

  it('preserves CPU aliases and shader identity across slider values', () => {
    const a = analyzeRows(['a=1', 'A=(a,2)', 'A', 'y=A_x*x']);
    const b = analyzeRows(['a=3', 'A=(a,2)', 'A', 'y=A_x*x']);
    expect(shaderKey(a.rows[3].gpu!)).toBe(shaderKey(b.rows[3].gpu!));
    expect(cpuStructureKey(a.rows[3].cpu!)).toBe(cpuStructureKey(b.rows[3].cpu!));
    const point = a.rows[2].cpu!;
    if (point.type !== 'point') throw new Error('point');
    expect([...freeVars(point.coords[0])]).toEqual(['A_x']);
    expect(point.coords.map(e => evaluate(e, a.constEnv))).toEqual([1, 2]);
    expect(point.coords.map(e => evaluate(e, b.constEnv))).toEqual([3, 2]);
  });

  it('shares one GPU family template while CPU members retain their actual equations', () => {
    const row = analyzeRows(['y=[1,2] x']).rows[0];
    const cpu = row.cpu!;
    const gpu = row.gpu!;
    if (cpu.type !== 'family' || gpu.type !== 'family') throw new Error('family');
    expect(cpu.members.map(m => m.cpu.type)).toEqual(['implicit2d', 'implicit2d']);
    expect(cpu.members.map(m => m.cpu.type === 'implicit2d' && evaluate(m.cpu.residual, { x: 2, y: 4 }))).toEqual([
      2, 0,
    ]);
    expect(shaderKey(gpu.members[0])).toBe(shaderKey(gpu.members[1]));
    expect(gpu.members[0].uniforms).not.toEqual(gpu.members[1].uniforms);
    expect(row.cls!.params).not.toContain('eqioFamilyIndex');
  });

  it('keeps packed storage zero-copy and excludes list identity from structure keys', () => {
    const values = new Float64Array([1, 2, 3]);
    const classified = classify({ kind: 'data', values });
    const cpu = compileCpu(classified);
    if (cpu.type !== 'dlist') throw new Error('packed list');
    expect(cpu.values).toBe(values);
    const a = compileCpu(
      classify({
        kind: 'vec',
        items: [
          { kind: 'num', value: 1, origin: 10 },
          { kind: 'num', value: 2 },
        ],
      }),
    );
    const b = compileCpu(
      classify({
        kind: 'vec',
        items: [
          { kind: 'num', value: 1, origin: 99, axes: [{ id: 'axis', n: 100 }] },
          { kind: 'num', value: 2 },
        ],
      }),
    );
    expect(cpuStructureKey(a)).toBe(cpuStructureKey(b));
  });

  it('retains the locally complex iteration variable through piecewise GPU compilation', () => {
    const plan = compileGpu(classify(parseExpr('iter({re(z)<0:re(z),im(z)})')));
    if (plan.type !== 'fractal2d') throw new Error('fractal');
    expect(plan.step).toContain('zc');
    expect(plan.step).not.toContain('vec2(z,');
  });

  it('gives a 3D vector field a shader for streamlines, and none when GLSL cannot express it', () => {
    const plan = compileGpu(classify(parseExpr('(-y, x, z/2)')));
    if (plan.type !== 'vfield3d') throw new Error('vfield3d');
    expect(plan.comps).toHaveLength(3);
    expect(shaderKey(plan)).toBe(shaderKey(compileGpu(classify(parseExpr('(-y, x, z/2)')))));
    expect(shaderKey(plan)).not.toBe(shaderKey(compileGpu(classify(parseExpr('(-y, x, z/3)')))));
    // Trajectories trace on the CPU, so the row still draws without it.
    vi.spyOn(glsl, 'toGLSL').mockImplementation(() => {
      throw new Error('no GLSL');
    });
    expect(compileGpu(classify(parseExpr('(-y, x, z)'))).type).toBe('none');
  });
});
