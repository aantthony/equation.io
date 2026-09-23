import { describe, expect, it } from 'vitest';
import { analyzeRows, analyzePrepared, prepareDocument } from './analysis.ts';
import { compileCpu, compileGpu, cpuStructureKey, shaderKey } from './compiler.ts';
import { emptyEnv } from './env.ts';
import { publicKind } from './math-object.ts';
import { syntaxHelp } from './syntax-help.ts';

describe('RGB color fields', () => {
  it('classifies solid colors as 2D plots and preserves 0–255 channel values', () => {
    const row = analyzeRows(['rgb(255, 128, 0)']).rows[0];
    expect(row.error).toBeUndefined();
    expect(row.cls).toMatchObject({ object: { kind: 'color-field' }, animated: false, needs3D: false });
    expect(publicKind(row.cls!.object)).toBe('rgb2d');
    expect(row.cpu).toMatchObject({ type: 'rgb2d', channels: [
      { kind: 'num', value: 255 }, { kind: 'num', value: 128 }, { kind: 'num', value: 0 },
    ] });
    expect(row.gpu).toMatchObject({ type: 'rgb2d', field: 'vec3(255.0, 128.0, 0.0)' });
  });

  it('supports the aperture palette through coordinate fields and real projections of complex expressions', () => {
    const rows = analyzeRows([
      'R = 255', 'alpha = atan2(y,x)/2',
      'rgb(R cos(alpha)^2, R cos(alpha+1)^2, R cos(alpha+2)^2)',
    ]).rows;
    expect(rows.map(r => r.error)).toEqual([undefined, undefined, undefined]);
    const row = rows[2];
    expect(row.cls!.params).toEqual(['R']);
    expect(row.gpu).toMatchObject({ type: 'rgb2d', locals: expect.stringContaining('atan(') });
    const complex = analyzeRows(['f(q)=q^2+1', 'rgb(255cos(arg(f(w))/2)^2, abs(w), re(w))']).rows[1];
    expect(complex.error).toBeUndefined();
    expect(complex.gpu).toMatchObject({ type: 'rgb2d' });
    // Both independent backends leave the shared semantic object unchanged.
    const before = JSON.stringify(row.cls);
    compileCpu(row.cls!); compileGpu(row.cls!);
    expect(JSON.stringify(row.cls)).toBe(before);
  });

  it('animates direct time and time-dependent constants without changing the shader', () => {
    const doc = prepareDocument(['gain = 127.5(1+sin(t))', 'rgb(gain, 127.5(1+cos(t)), x+y)']);
    const a = analyzePrepared(doc, { time: 0 });
    const b = analyzePrepared(doc, { time: Math.PI/2 });
    expect(a.rows[1].error).toBeUndefined();
    expect(a.rows[1].cls!.animated).toBe(true);
    expect(a.constEnv.gain).toBeCloseTo(127.5);
    expect(b.constEnv.gain).toBeCloseTo(255);
    expect(shaderKey(a.rows[1].gpu!)).toBe(shaderKey(b.rows[1].gpu!));
    expect(cpuStructureKey(a.rows[1].cpu!)).toBe(cpuStructureKey(b.rows[1].cpu!));
  });

  it('supports partial piecewise channels and user-defined channel functions', () => {
    const rows = analyzeRows(['red(q) = {q>0:255}', 'rgb(red(x), 0, 0)']).rows;
    expect(rows.map(r => r.error)).toEqual([undefined, undefined]);
    expect(rows[1].gpu).toMatchObject({ type: 'rgb2d', locals: expect.stringContaining('EQ_NAN') });
  });

  it.each([
    ['rgb(255, 0)', /three channels/],
    ['rgb(1, 2, 3, 4)', /three channels/],
    ['rgb(w, 0, 0)', /real numbers/],
    ['rgb(u, 0, 0)', /Cannot use u\/v/],
    ['rgb(0, v, 0)', /Cannot use u\/v/],
    ['rgb(0, 0, z)', /3D axis/],
    ['rgb([1,2], 0, 0)', /do not superimpose|list/i],
    ['sin(rgb(255, 0, 0))', /whole expression/],
    ['rgb(rgb(1,2,3), 0, 0)', /whole expression/],
    ['c = rgb(255, 0, 0)', /whole row/],
  ])('rejects unsupported input: %s', (text, error) => {
    expect(analyzeRows([text]).rows[0].error).toMatch(error);
  });

  it('preserves existing definitions named rgb', () => {
    for (const rows of [['rgb(q) = q^2', 'rgb(x)'], ['rgb = 2', 'rgb x']]) {
      const result = analyzeRows(rows).rows;
      expect(result.map(r => r.error)).toEqual([undefined, undefined]);
      expect(result[1].cpu!.type).toBe('implicit2d');
    }
  });

  it('keeps repeated complex compositions compact across all three channels', () => {
    const rows = analyzeRows([
      'f(q) = q + exp(i arg(q))/max(0.01,abs(q))',
      'g(q) = f(f(f(f(f(q)))))',
      'rgb(255cos(arg(g(w))/2)^2, 255cos(arg(g(w))/2+1)^2, 255cos(arg(g(w))/2+2)^2)',
    ]).rows;
    expect(rows.every(r => !r.error)).toBe(true);
    const shader = rows[2].gpu!;
    expect(shader.type).toBe('rgb2d');
    if (shader.type !== 'rgb2d') throw new Error('Expected RGB shader');
    expect(shader.locals.length + shader.field.length).toBeLessThan(4000);
    expect(shader.locals.match(/c_exp\(/g)).toHaveLength(5);
    expect(shaderKey(shader)).not.toBe(shaderKey({ ...shader, locals: shader.locals + '\n' }));
  });

  it('explains the channel scale in editor help', () => {
    expect(syntaxHelp('rgb(', 4, emptyEnv()).hint).toContain('0 to 255');
  });
});
