import { describe, expect, it } from 'vitest';
import { analyzePrepared, analyzeRows, prepareDocument } from './analysis.ts';
import { parseCsv } from './csv.ts';
import { RVSystem } from './dist.ts';
import { type Expr, evaluate } from './expr.ts';

describe('shared document analysis', () => {
  it('preserves source identity, blanks and partial success', () => {
    const document = prepareDocument([
      { id: 'blank', text: ' ' },
      { id: 2, text: '# heading' },
      { id: 3, text: 'a=2' },
      { id: 4, text: 'a=3' },
      { id: 5, text: 'a+1' },
    ]);
    const result = analyzePrepared(document);
    expect(result.rows.map(r => r.id)).toEqual(['blank', 2, 3, 4, 5]);
    expect(document.statements.map(s => s.kind)).toEqual([
      'blank',
      'comment',
      'definition',
      'definition',
      'expression',
    ]);
    expect(result.rows[3].error).toBe('a is already defined.');
    expect(result.rows[4].info).toBe('= 3');
    expect(document.rows[4].cls).toBeUndefined();
  });

  it('reads only the math before a trailing # note', () => {
    const result = analyzeRows(['a = 2 # slope', 'y = a x # line', 'a + 1 # readout']);
    expect(result.rows.map(r => r.error)).toEqual([undefined, undefined, undefined]);
    expect(result.rows[0].def).toMatchObject({ kind: 'const', name: 'a' });
    expect(result.rows[0].def?.kind === 'const' && result.rows[0].def.rhs.trim()).toBe('2');
    expect(result.rows[1].comment).toBeUndefined();
    expect(result.rows[2].info).toBe('= 3');
  });

  it('takes live integrated values without reseeding and keeps structure independent of values', () => {
    const rows = ["a'=-a", 'a(0)=2', 'b=a+1', 'b'];
    const document = prepareDocument(rows);
    const values = { a: 0.5 };
    const live = analyzePrepared(document, { stateValues: values, time: 4 });
    expect(live.constEnv).toMatchObject({ a: 0.5, b: 1.5 });
    expect(live.rows[3].info).toBe('= 1.5');
    expect(values).toEqual({ a: 0.5 });
    expect(analyzeRows(rows).constEnv).toMatchObject({ a: 2, b: 3 });
    expect(prepareDocument([...rows, '# edit']).stateSystem?.key).toBe(document.stateSystem?.key);
    expect(prepareDocument(["a'=-a", 'a(0)=3']).stateSystem?.key).not.toBe(document.stateSystem?.key);
    expect(prepareDocument(["a'=-2a", 'a(0)=2']).stateSystem?.key).not.toBe(document.stateSystem?.key);
    expect(document.boundVals).not.toHaveProperty('a');
    expect(document.boundVals).not.toHaveProperty('b');
  });

  it('reuses RV numerical caches and source IDs across inserted rows', () => {
    const rvs = new RVSystem();
    const rows = [
      { id: 'base', text: 'X ~ Normal(0,1)' },
      { id: 'derived', text: 'X^3' },
    ];
    const first = analyzePrepared(prepareDocument(rows), { rvs, readouts: false });
    const col = rvs.columns('@derived', {});
    const second = analyzePrepared(prepareDocument([{ id: 'comment', text: '# edit' }, ...rows]), {
      rvs,
      readouts: false,
    });
    expect(first.rvs).toBe(rvs);
    expect(second.rvs).toBe(rvs);
    expect(rvs.columns('@derived', {})).toBe(col);
    analyzePrepared(prepareDocument([{ id: 'base', text: 'X ~ Normal(2,1)' }, rows[1]]), { rvs, readouts: false });
    expect(rvs.columns('@derived', {})).not.toBe(col);
  });

  it('evaluates viewport constants after binding and rejects duplicate heads', () => {
    const { rows } = analyzeRows(['view(x=-a..a)', 'a=3', 'view(y=-1..1)', 'camera(0,0)', 'camera(1,0)']);
    expect(rows[0].view).toBeDefined();
    expect(rows[0].error).toBeUndefined();
    expect(rows[2].error).toMatch(/view is already set/);
    expect(rows[4].error).toMatch(/camera is already set/);
    expect(analyzeRows(['a=t+2', 'view(x=-a..a)']).rows[1].error).toBeDefined();
  });

  it('uses synchronous local tables and preserves missing-data diagnostics without bytes', () => {
    const sources = ['person=open("people.csv")', 'total(person.age)'];
    const local = analyzeRows(sources, { tables: () => parseCsv('age,name\n10,A\n20,B\n') });
    expect(local.rows[0].info).toContain('2 rows');
    expect(local.rows[1].info).toBe('= 30');
    const missing = analyzeRows(sources);
    expect(missing.rows[1].error).toBeUndefined();
    expect(missing.rows[1].dataLocal).toContain('not on this device');
    expect(missing.rows[1].needsFile).toBe(true);
  });

  it('builds grids only for canonical planar coordinate fields', () => {
    const result = analyzeRows(['A=(x,y)', 'r=sqrt(x^2+y^2)', 'q=x+z', 'r=2']);
    expect(result.gridFields.map(g => g.name)).toEqual(['r']);
    expect(evaluate(result.gridFields[0].expr, { x: 3, y: 4 })).toBe(5);
    expect(result.rows[3].error).toBeUndefined();
  });
});

describe('dependency retention after a failed definition', () => {
  it('drops a definition that references the failed name', () => {
    const { rows } = analyzeRows(['n = w', 'S = n + 1', 'S + x']);
    expect(rows[0].error).toBeDefined();
    expect(rows[1].error).toMatch(/\bn\b/);
    expect(rows[2].error).toBeDefined();
  });

  it('reads a sequence term exactly as its plot row: a computed vector is never splatted', () => {
    const { rows } = analyzeRows(['g(u) = (u, 2u)', 'a_n = atan(g(n))', 'a_3']);
    const term = (rows[1].cpu as { term: Expr }).term;
    expect(() => evaluate(term, { n: 3 })).toThrow(/Vector in scalar context/);
    // Not quietly atan(3, 6).
    expect(rows[2].info).toBeUndefined();
    expect(rows[2].error).toMatch(/Vector in scalar context|atan is not defined for points/);
  });

  it('keeps a definition whose Σ index or ∫ measure merely shares the letter', () => {
    for (const source of ['S = sum[n=1..5] n', 'S = sum(n=1..5, n)', 'S = 2 sum[n=1..5] n / n']) {
      const { rows } = analyzeRows(['n = w', source, 'S + x']);
      expect(rows[0].error).toBeDefined();
      expect(rows[1].error, source).toBeUndefined();
      expect(rows[2].error, source).toBeUndefined();
      expect(rows[2].cpu?.type, source).toBe('implicit2d');
    }
    const integral = analyzeRows(['k = w', 'I = int[0..1] k^2 dk', 'I + y']);
    expect(integral.rows[1].error).toBeUndefined();
    expect(integral.rows[2].error).toBeUndefined();
    expect(integral.rows[2].cpu?.type).toBe('scalar2d');
  });
});
