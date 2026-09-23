import { describe, expect, it } from 'vitest';
import { analyzeRows, analyzePrepared, prepareDocument } from './analysis.ts';
import { shaderKey, cpuStructureKey } from './compiler.ts';
import { emptyEnv } from './env.ts';
import { publicKind } from './math-object.ts';
import { syntaxHelp } from './syntax-help.ts';

describe.each(['hsl', 'oklch'] as const)('%s color fields', name => {
  it('preserves its color space through semantic, CPU and GPU plans', () => {
    const row = analyzeRows([`${name}(1,2,3)`]).rows[0];
    expect(row.error).toBeUndefined();
    expect(row.cls).toMatchObject({ object: { kind: 'color-field', space: name }, needs3D: false });
    expect(publicKind(row.cls!.object)).toBe(`${name}2d`);
    expect(row.cpu!.type).toBe(`${name}2d`);
    expect(row.gpu!.type).toBe(`${name}2d`);
    const rgb = analyzeRows(['rgb(1,2,3)']).rows[0];
    expect(shaderKey(row.gpu!)).not.toBe(shaderKey(rgb.gpu!));
    expect(cpuStructureKey(row.cpu!)).not.toBe(cpuStructureKey(rgb.cpu!));
  });

  it('supports complex projections, partial channels, sliders and time', () => {
    const doc = prepareDocument(['a = 2+sin(t)', `${name}(a, {x>0:abs(w)}, arg(w)*180/pi+t)`]);
    const first = analyzePrepared(doc, { time: 0 });
    const later = analyzePrepared(doc, { time: Math.PI/2 });
    expect(first.rows[1].error).toBeUndefined();
    expect(first.rows[1].cls!.animated).toBe(true);
    expect(first.constEnv.a).toBeCloseTo(2);
    expect(later.constEnv.a).toBeCloseTo(3);
    expect(shaderKey(first.rows[1].gpu!)).toBe(shaderKey(later.rows[1].gpu!));
  });

  it.each([
    ['(1,2)', /three channels/],
    ['(1,2,3,4)', /three channels/],
    ['(w,0,0)', /real numbers/],
    ['(u,0,0)', /Cannot use u\/v/],
    ['(0,0,z)', /3D axis/],
    ['([1,2],0,0)', /superimpose|list/],
    ['(rgb(1,2,3),0,0)', /whole expression/],
  ])('rejects invalid channels %s', (args, error) => {
    expect(analyzeRows([name+args]).rows[0].error).toMatch(error);
  });

  it('rejects nesting and color-value definitions', () => {
    expect(analyzeRows([`sin(${name}(1,2,3))`]).rows[0].error).toMatch(/whole expression/);
    expect(analyzeRows([`c=${name}(1,2,3)`]).rows[0].error).toMatch(/whole row/);
  });

  it('preserves user-defined functions and constants with this name', () => {
    for (const rows of [[`${name}(q)=q^2`, `${name}(x)`], [`${name}=2`, `${name} x`]]) {
      const result = analyzeRows(rows).rows;
      expect(result.map(r => r.error)).toEqual([undefined, undefined]);
      expect(result[1].cpu!.type).toBe('implicit2d');
    }
  });

  it('explains hue units in editor help', () => {
    expect(syntaxHelp(`${name}(`, name.length+1, emptyEnv()).hint).toContain('degrees');
  });
});
