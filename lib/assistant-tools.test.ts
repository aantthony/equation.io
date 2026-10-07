import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../web/examples.ts';
import { analyzeRows } from './analysis.ts';
import {
  checkRows,
  examplesIndex,
  functionDoc,
  kindExamples,
  kindOf,
  listKinds,
  searchFunctions,
} from './assistant-tools.ts';
import { parseCsv } from './csv.ts';
import { KIND_FORMS, KIND_MEANINGS } from './row-kind.ts';
import { splitStatements } from './statements.ts';

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

const index = examplesIndex(EXAMPLES.flatMap(([, items]) => items.map(([label, text]) => [label, text] as const)));

describe('list_kinds', () => {
  it('names every kind', () => {
    const text = listKinds();
    for (const kind of Object.keys(KIND_FORMS)) expect(text).toMatch(new RegExp(`\\b${kind}\\b`));
  });
  it('gives each kind a form the analyzer reads as that kind, with no error', () => {
    const tables = () => parseCsv('age,height\n20,170\n30,180\n40,175');
    for (const [kind, [form]] of Object.entries(KIND_FORMS)) {
      const rows = splitStatements(form).map(s => s.trim());
      const analysis = analyzeRows(rows, { readouts: true, tables });
      expect(analysis.rows.map(r => r.error).filter(Boolean), form).toEqual([]);
      expect(kindOf(analysis.rows.at(-1)!), form).toBe(kind);
    }
  });
});

describe('kind_examples', () => {
  it('indexes the examples menu by kind, with whole graphs that draw that kind', () => {
    for (const [kind, examples] of Object.entries(index.kinds)) {
      expect(examples.length).toBeGreaterThan(0);
      expect(examples.length).toBeLessThanOrEqual(3);
      for (const { rows } of examples) {
        const analysis = analyzeRows(rows);
        expect(analysis.rows.map(r => r.error).filter(Boolean)).toEqual([]);
        expect(analysis.rows.map(kindOf)).toContain(kind);
      }
    }
    // Kinds no short example draws: kind_examples gives only their smallest form.
    expect(Object.keys(KIND_FORMS).filter(kind => !index.kinds[kind])).toEqual(['label', 'dlist']);
  });
  it('answers with the meaning, the smallest form and examples, by name or by meaning', () => {
    const answer = kindExamples(index, 'solid');
    expect(answer).toContain(KIND_MEANINGS.solid);
    expect(answer).toContain('solid cube');
    expect(kindExamples(index, 'parametric curve')).toMatch(/^pcurve:/);
    expect(kindExamples(index, 'cube')).toContain('No kind');
  });
});

describe('functions', () => {
  it('finds functions by what they do', () => {
    expect(searchFunctions('convex hull')).toMatch(/^hull\(/);
    expect(searchFunctions('inverse sine')).toMatch(/^asin\(/);
  });
  it('documents a function with examples that call it', () => {
    expect(functionDoc(index, 'interval')).toMatch(/^interval\(a, b\)/);
    expect(functionDoc(index, 'interval')).toContain('examples');
    expect(functionDoc(index, 'Sin(x)')).toMatch(/^sin\(x\)/);
    expect(functionDoc(index, 'surface')).toContain('surface is not a built-in function');
  });
});
