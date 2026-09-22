import { describe, expect, it } from 'vitest';
import { evaluate, type Expr } from './expr.ts';
import { classifySeqRec, scanSeqRec, sequenceResolver } from './seq.ts';
import { emptyDefs } from './defs.ts';

const none = new Set<string>();
const cls = (text: string, consts: ReadonlySet<string> = none) => {
  const scan = scanSeqRec(text);
  if (!scan) throw new Error('expected a sequence/recurrence row');
  return classifySeqRec(scan, none, () => undefined, consts);
};

describe('scanSeqRec', () => {
  it('detects explicit sequences', () => {
    expect(scanSeqRec('a_n = 1/n^2')).toMatchObject({ rec: false, name: 'a', index: 'n' });
    expect(scanSeqRec('b_k = 2^k')).toMatchObject({ rec: false, name: 'b', index: 'k' });
    expect(scanSeqRec('θ_n = n θ')).toMatchObject({ rec: false, name: 'θ', index: 'n' });
  });

  it('detects recurrences in brace and paren forms', () => {
    expect(scanSeqRec('a_{n+1} = r a_n (1 - a_n)')).toMatchObject({ rec: true, name: 'a', index: 'n' });
    expect(scanSeqRec('b_(k+1) = b_k/2')).toMatchObject({ rec: true, name: 'b', index: 'k' });
  });

  it('leaves subscripted constants and ordinary rows alone', () => {
    expect(scanSeqRec('a_0 = 0.2')).toBeNull(); // digit subscript → plain constant
    expect(scanSeqRec('y = x^2')).toBeNull();
    expect(scanSeqRec('theta = atan2(y, x)')).toBeNull();
  });

  it('leaves letter-subscripted constants to definition scanning', () => {
    // Physics and chemistry write constants this way; the term never
    // mentions the subscript, so these are not sequences.
    expect(scanSeqRec('T_c = 300')).toBeNull();
    expect(scanSeqRec('k_B = 1.380649e-23')).toBeNull();
    expect(scanSeqRec('v_x = 3')).toBeNull(); // reserved index
    expect(scanSeqRec('E_g = 1.1')).toBeNull();
  });

  it('accepts an unconventional index the term actually uses', () => {
    expect(scanSeqRec('a_j = 1/j^2')).toMatchObject({ rec: false, name: 'a', index: 'j' });
    // A conventional index needs no mention: the constant sequence.
    expect(scanSeqRec('a_n = 5')).toMatchObject({ rec: false, name: 'a', index: 'n' });
    // Recurrences are unambiguous whatever the index.
    expect(scanSeqRec('T_{c+1} = 2 T_c')).toMatchObject({ rec: true, name: 'T', index: 'c' });
  });
});

describe('classifySeqRec', () => {
  it('classifies explicit sequences and evaluates terms', () => {
    const c = cls('a_n = 1/n^2');
    expect(c.plot.type).toBe('sequence');
    const plot = c.plot as { term: Expr; index: string };
    expect(plot.index).toBe('n');
    expect(evaluate(plot.term, { n: 2 })).toBeCloseTo(0.25);
    expect(evaluate(plot.term, { n: 0 })).toBe(Infinity); // skipped by the renderer
  });

  it('flags t as animated and collects constants as params', () => {
    const c = cls('a_n = c sin(n t)', new Set(['c']));
    expect(c.animated).toBe(true);
    expect(c.params).toEqual(['c']);
  });

  it('rejects spatial variables in a sequence term', () => {
    expect(() => cls('a_n = x n')).toThrow(/may only use/);
  });

  it('rejects reserved index letters', () => {
    // The explicit form no longer reaches here — `a_x = 1` is a subscripted
    // constant — but the recurrence form is unambiguous, so it still can.
    expect(() => cls('a_{x+1} = 1')).toThrow(/reserved/);
  });

  it('classifies autonomous recurrences as cobwebs', () => {
    const c = cls('a_{n+1} = a_n/2 + 1');
    expect(c.plot.type).toBe('cobweb');
    const plot = c.plot as { f: Expr; recVar: string; curveField: string };
    expect(plot.recVar).toBe('a_n');
    expect(evaluate(plot.f, { a_n: 2 })).toBeCloseTo(2); // fixed point of x/2 + 1
    expect(plot.curveField).toContain('x');
  });

  it('uses a defined a_0 seed and lists it in params', () => {
    const c = cls('a_{n+1} = r a_n (1 - a_n)', new Set(['r', 'a_0']));
    expect(c.plot).toMatchObject({ type: 'cobweb', a0Name: 'a_0' });
    expect(c.params).toEqual(['a_0', 'r']);
    const plot = c.plot as { curveField: string };
    expect(plot.curveField).toContain('u_r'); // constants compile to uniforms
  });

  it('routes x-parameterized recurrences to bifurcation diagrams', () => {
    const c = cls('a_{n+1} = x a_n (1 - a_n)');
    expect(c.plot.type).toBe('bifurcation');
    const plot = c.plot as { field: string };
    expect(plot.field).toContain('a');
    expect(plot.field).toContain('x');
  });

  it('rejects y as the parameter axis', () => {
    expect(() => cls('a_{n+1} = y a_n')).toThrow(/x-axis/);
  });

  it('rejects the bare index inside a recurrence', () => {
    expect(() => cls('a_{n+1} = a_n + n')).toThrow(/not n itself/);
  });

  it('rejects unknown variables with the slider hint', () => {
    expect(() => cls('a_{n+1} = q a_n')).toThrow(/Unknown variable/);
  });
});

describe('sequences with sums', () => {
  it('expands Σ inside a sequence term', () => {
    const scan = scanSeqRec('a_n = sum(k=1..3, k^n)')!;
    const c = classifySeqRec(scan, none, () => undefined, new Set(), {});
    const plot = c.plot as { term: Expr };
    expect(evaluate(plot.term, { n: 1 })).toBe(6);  // 1+2+3
    expect(evaluate(plot.term, { n: 2 })).toBe(14); // 1+4+9
  });

  it('expands Σ bounds that reference a constant', () => {
    const scan = scanSeqRec('a_n = sum(k=1..N, k n)')!;
    const c = classifySeqRec(scan, none, () => undefined, new Set(['N']), { consts: { N: 3 } });
    const plot = c.plot as { term: Expr };
    expect(evaluate(plot.term, { n: 2 })).toBe(12); // (1+2+3)·2
  });

  it('sums up to the sequence index', () => {
    const c = cls('a_n=Σ(s=1..n, s)');
    expect(c.plot.type).toBe('sequence');
    const plot = c.plot as { term: Expr; index: string };
    expect(plot.index).toBe('n');
    expect(evaluate(plot.term, { n: 0 })).toBe(0); // empty sum
    expect(evaluate(plot.term, { n: 1 })).toBe(1);
    expect(evaluate(plot.term, { n: 5 })).toBe(15); // 1+2+3+4+5
    expect(evaluate(plot.term, { n: 10 })).toBe(55);
    // The same letter may name both the index and the summation variable.
    const shadowed = cls('a_n = Σ(n=1..n, n)');
    expect(evaluate((shadowed.plot as { term: Expr }).term, { n: 4 })).toBe(10);
    // Bracket form, nested sums, and products.
    expect(evaluate((cls('a_n = Σ[s=1..n] s').plot as { term: Expr }).term, { n: 4 })).toBe(10);
    expect(evaluate((cls('a_n = Σ(s=1..n, Σ(k=1..s, k))').plot as { term: Expr }).term, { n: 3 })).toBe(10);
    expect(evaluate((cls('a_n = Π(s=1..n, s)').plot as { term: Expr }).term, { n: 5 })).toBe(120);
    expect(evaluate((cls('a_n = Π(s=1..n, s)').plot as { term: Expr }).term, { n: 0 })).toBe(1);
  });

  it('lets a slider share the bound with the index, and still rejects other variables', () => {
    const boundConsts = new Set<string>();
    const c = classifySeqRec(scanSeqRec('a_n = Σ(s=1..n+N, s)')!, none, () => undefined, new Set(['N']), {
      consts: { N: 2 }, boundConsts,
    });
    expect([...boundConsts]).toEqual(['N']);
    expect(c.params).toEqual(['N']);
    expect(evaluate((c.plot as { term: Expr }).term, { n: 2, N: 2 })).toBe(10); // 1+2+3+4
    expect(() => cls('a_n = Σ(s=1..m, s)')).toThrow(/constant/);
    expect(() => cls('a_n = Σ(s=1..x, s)')).toThrow(/cannot depend on x/);
    expect(() => cls('a_n = Σ(s=1..t, s)')).toThrow(/cannot depend on t/);
    expect(() => evaluate((cls('a_n = Σ(s=1..n, s)').plot as { term: Expr }).term, { n: 501 })).toThrow(/terms/);
  });
});

describe('sequence term references', () => {
  it('resolves Greek-named terms, matching the Greek row shapes', () => {
    const defs = emptyDefs();
    defs.sequences.set('θ', scanSeqRec('θ_n = n^2')!);
    const resolve = sequenceResolver(defs, () => undefined, {}, new Set<string>());
    // θ₂ reaches here as θ_2 (subscripts canonicalize in the tokenizer).
    expect(evaluate(resolve('θ_2')!, {})).toBe(4);
    expect(resolve('θ_x')).toBeNull(); // not a literal index
  });
});
