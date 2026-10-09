import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../web/examples.ts';
import { readReference } from '../scripts/reference.ts';
import { analyzeRows } from './analysis.ts';
import {
  checkRows,
  examplesIndex,
  functionDoc,
  kindExamples,
  kindOf,
  listKinds,
  searchFunctions,
  shape,
} from './assistant-tools.ts';
import { assistantData } from './reference.ts';
import { KIND_MEANINGS } from './row-kind.ts';

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
const data = assistantData(readReference(), index);

describe('list_kinds', () => {
  it('names every kind, the common ones with their smallest form', () => {
    const text = listKinds(data);
    for (const kind of Object.keys(KIND_MEANINGS)) expect(text).toMatch(new RegExp(`\\b${kind}\\b`));
    expect(text).toContain('solid: (interval(0, 1), interval(0, 2), interval(0, 3)) | ');
    expect(text).toContain('probability: density, pmf, prob, expect');
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
    // A kind drawn in 2D and 3D shows both: a helix beside the plane curves.
    const dims = index.kinds.pcurve.map(e => analyzeRows(e.rows).rows.some(r => r.cls?.needs3D));
    expect(dims).toContain(true);
    expect(dims).toContain(false);
    // Kinds no short menu example draws: the reference's examples stand alone.
    expect(Object.keys(KIND_MEANINGS).filter(kind => !index.kinds[kind])).toEqual(['label', 'dlist']);
  });
  it("leads with the reference's examples, then the menu's, three in all", () => {
    for (const [kind, examples] of Object.entries(data.kinds)) {
      expect(examples.length, kind).toBeGreaterThan(0);
      expect(examples.length, kind).toBeLessThanOrEqual(3);
    }
    expect(data.kinds.solid[0]).toEqual({
      label: 'unit cube',
      rows: ['(interval(0, 1), interval(0, 1), interval(0, 1))'],
    });
  });
  it('answers with the meaning, the smallest form and examples, by name or by meaning', () => {
    const answer = kindExamples(data, 'solid');
    expect(answer).toContain(KIND_MEANINGS.solid);
    // Rows first, then the label: a label first was copied into a row.
    expect(answer).toContain('- ["(interval(0, 1), interval(0, 1), interval(0, 1))"] (unit cube)');
    expect(kindExamples(data, 'parametric curve')).toMatch(/^pcurve:/);
    expect(kindExamples(data, 'cube')).toContain('No kind');
    // By its name in the instructions, for every kind.
    for (const { kind, title } of data.groups.flatMap(g => g.kinds))
      expect(kindExamples(data, title).startsWith(`${kind}:`), title).toBe(true);
  });
});

describe('functions', () => {
  it('finds functions by what they do', () => {
    expect(searchFunctions('convex hull')).toMatch(/^hull\(/);
    expect(searchFunctions('inverse sine')).toMatch(/^asin\(/);
  });
  it("documents a function with the reference's note and examples that call it", () => {
    expect(functionDoc(data, 'interval')).toMatch(/^interval\(a, b\)/);
    expect(functionDoc(data, 'interval')).toContain('Every mention of one named interval is the same number');
    expect(functionDoc(data, 'interval')).toContain('examples');
    expect(functionDoc(data, 'Sin(x)')).toMatch(/^sin\(x\)/);
    expect(functionDoc(data, 'surface')).toContain('surface is not a built-in function');
  });
});

describe('shape', () => {
  it('finds a shape by name, alias, a name inside the request, a near spelling or a word of its name', () => {
    const first = (name: string) => shape(data, name).split(/[(:]/)[0].trim();
    expect(first('Torus')).toBe('Torus');
    expect(first('hyperboloid')).toBe('Hyperboloid of one sheet');
    expect(first('a hyperboloid of two sheets')).toBe('Hyperboloid of two sheets');
    expect(first('polar rose')).toBe('Rose');
    expect(first('sphere of radius 2')).toBe('Sphere');
    expect(first('unit cube')).toBe('Cube');
    expect(first('cardiod')).toBe('Cardioid');
    expect(first('Mobius strip')).toBe('Möbius strip');
    expect(first('lissajous')).toBe('Lissajous curve');
    expect(first('limacon')).toBe('Limaçon');
  });
  it('answers with the forms, their parameters and an instance; on a miss, every name', () => {
    const answer = shape(data, 'cardioid');
    expect(answer).toContain('- ["(a(1 + cos(2pi u)) cos(2pi u), a(1 + cos(2pi u)) sin(2pi u))"] (pcurve)');
    expect(answer).toContain('  a: ');
    expect(answer).toContain('  e.g. ["(2(1 + cos(2pi u)) cos(2pi u), 2(1 + cos(2pi u)) sin(2pi u))"]');
    expect(answer.split('\n').length).toBeLessThan(12);
    expect(answer).toMatch(/Nothing is drawn yet: .*set_graph\.$/);
    const miss = shape(data, 'kidney bean');
    expect(miss).toMatch(/^No shape "kidney bean"\. Shapes: circle, /);
    expect(miss).toContain('torus');
  });
});
