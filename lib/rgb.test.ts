import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { compileCpu, compileGpu, shaderKey } from './compiler.ts';

// Behaviour shared by every color space is covered in color-field.test.ts.
describe('RGB color fields', () => {
  it('preserves 0–1 channel values as a literal field', () => {
    const row = analyzeRows(['rgb(1, 0.5, 0)']).rows[0];
    expect(row.error).toBeUndefined();
    expect(row.cpu).toMatchObject({
      type: 'rgb2d',
      channels: [
        { kind: 'num', value: 1 },
        { kind: 'num', value: 0.5 },
        { kind: 'num', value: 0 },
      ],
    });
    expect(row.gpu).toMatchObject({ type: 'rgb2d', field: 'vec3(1.0, 0.5, 0.0)' });
  });

  it('supports the aperture palette through coordinate fields and real projections of complex expressions', () => {
    const rows = analyzeRows([
      'R = 1',
      'alpha = atan2(y,x)/2',
      'rgb(R cos(alpha)^2, R cos(alpha+1)^2, R cos(alpha+2)^2)',
    ]).rows;
    expect(rows.map(r => r.error)).toEqual([undefined, undefined, undefined]);
    const row = rows[2];
    expect(row.cls!.params).toEqual(['R']);
    expect(row.gpu).toMatchObject({ type: 'rgb2d', locals: expect.stringContaining('atan(') });
    const complex = analyzeRows(['f(q)=q^2+1', 'rgb(cos(arg(f(w))/2)^2, abs(w), re(w))']).rows[1];
    expect(complex.error).toBeUndefined();
    expect(complex.gpu).toMatchObject({ type: 'rgb2d' });
    // Both independent backends leave the shared semantic object unchanged.
    const before = JSON.stringify(row.cls);
    compileCpu(row.cls!);
    compileGpu(row.cls!);
    expect(JSON.stringify(row.cls)).toBe(before);
  });

  it('supports user-defined channel functions with partial piecewise bodies', () => {
    const rows = analyzeRows(['red(q) = {q>0:1}', 'rgb(red(x), 0, 0)']).rows;
    expect(rows.map(r => r.error)).toEqual([undefined, undefined]);
    expect(rows[1].gpu).toMatchObject({ type: 'rgb2d', locals: expect.stringContaining('EQ_NAN') });
  });

  it('keeps repeated complex compositions compact across all three channels', () => {
    const rows = analyzeRows([
      'f(q) = q + exp(i arg(q))/max(0.01,abs(q))',
      'g(q) = f(f(f(f(f(q)))))',
      'rgb(cos(arg(g(w))/2)^2, cos(arg(g(w))/2+1)^2, cos(arg(g(w))/2+2)^2)',
    ]).rows;
    expect(rows.every(r => !r.error)).toBe(true);
    const shader = rows[2].gpu!;
    expect(shader.type).toBe('rgb2d');
    if (shader.type !== 'rgb2d') throw new Error('Expected RGB shader');
    expect(shader.locals.length + shader.field.length).toBeLessThan(4000);
    expect(shader.locals.match(/c_exp\(/g)).toHaveLength(5);
    expect(shaderKey(shader)).not.toBe(shaderKey({ ...shader, locals: shader.locals + '\n' }));
  });
});
