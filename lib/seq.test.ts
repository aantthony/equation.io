import { compileCpu, compileGpu } from './compiler.ts';
import { Env } from './env.ts';
import { describe, expect, it } from 'vitest';
import { evaluate, type Expr } from './expr.ts';
import { classifySeqRec, scanSeqRec, scanSequences, sequenceResolver } from './seq.ts';
import { analyzeRows } from './analysis.ts';
import { resolveExpr, scanDefinition } from './defs.ts';
import { parseExpr } from './expr.ts';


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
    expect(compileCpu(c).type).toBe('sequence');
    const plot = compileCpu(c) as { term: Expr; index: string };
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
    expect(compileCpu(c).type).toBe('cobweb');
    const plot = compileCpu(c) as { f: Expr; recVar: string };
    const gpu = compileGpu(c) as { curveField: string };
    expect(plot.recVar).toBe('a_n');
    expect(evaluate(plot.f, { a_n: 2 })).toBeCloseTo(2); // fixed point of x/2 + 1
    expect(gpu.curveField).toContain('x');
  });

  it('uses a defined a_0 seed and lists it in params', () => {
    const c = cls('a_{n+1} = r a_n (1 - a_n)', new Set(['r', 'a_0']));
    expect(compileCpu(c)).toMatchObject({ type: 'cobweb', a0Name: 'a_0' });
    expect(c.params).toEqual(['a_0', 'r']);
    const plot = compileGpu(c) as { curveField: string };
    expect(plot.curveField).toContain('u_r'); // constants compile to uniforms
  });

  it('routes x-parameterized recurrences to bifurcation diagrams', () => {
    const c = cls('a_{n+1} = x a_n (1 - a_n)');
    expect(compileCpu(c).type).toBe('bifurcation');
    const plot = compileGpu(c) as { field: string };
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
    const plot = compileCpu(c) as { term: Expr };
    expect(evaluate(plot.term, { n: 1 })).toBe(6);  // 1+2+3
    expect(evaluate(plot.term, { n: 2 })).toBe(14); // 1+4+9
  });

  it('expands Σ bounds that reference a constant', () => {
    const scan = scanSeqRec('a_n = sum(k=1..N, k n)')!;
    const c = classifySeqRec(scan, none, () => undefined, new Set(['N']), { consts: { N: 3 } });
    const plot = compileCpu(c) as { term: Expr };
    expect(evaluate(plot.term, { n: 2 })).toBe(12); // (1+2+3)·2
  });

  it('sums up to the sequence index', () => {
    const c = cls('a_n=Σ(s=1..n, s)');
    expect(compileCpu(c).type).toBe('sequence');
    const plot = compileCpu(c) as { term: Expr; index: string };
    expect(plot.index).toBe('n');
    expect(evaluate(plot.term, { n: 0 })).toBe(0); // empty sum
    expect(evaluate(plot.term, { n: 1 })).toBe(1);
    expect(evaluate(plot.term, { n: 5 })).toBe(15); // 1+2+3+4+5
    expect(evaluate(plot.term, { n: 10 })).toBe(55);
    // The same letter may name both the index and the summation variable.
    const shadowed = cls('a_n = Σ(n=1..n, n)');
    expect(evaluate((compileCpu(shadowed) as { term: Expr }).term, { n: 4 })).toBe(10);
    // Bracket form, nested sums, and products.
    expect(evaluate((compileCpu(cls('a_n = Σ[s=1..n] s')) as { term: Expr }).term, { n: 4 })).toBe(10);
    expect(evaluate((compileCpu(cls('a_n = Σ(s=1..n, Σ(k=1..s, k))')) as { term: Expr }).term, { n: 3 })).toBe(10);
    expect(evaluate((compileCpu(cls('a_n = Π(s=1..n, s)')) as { term: Expr }).term, { n: 5 })).toBe(120);
    expect(evaluate((compileCpu(cls('a_n = Π(s=1..n, s)')) as { term: Expr }).term, { n: 0 })).toBe(1);
  });

  it('lets a slider share the bound with the index, and still rejects other variables', () => {
    const boundConsts = new Set<string>();
    const c = classifySeqRec(scanSeqRec('a_n = Σ(s=1..n+N, s)')!, none, () => undefined, new Set(['N']), {
      consts: { N: 2 }, boundConsts,
    });
    expect([...boundConsts]).toEqual(['N']);
    expect(c.params).toEqual(['N']);
    expect(evaluate((compileCpu(c) as { term: Expr }).term, { n: 2, N: 2 })).toBe(10); // 1+2+3+4
    expect(() => cls('a_n = Σ(s=1..m, s)')).toThrow(/constant/);
    expect(() => cls('a_n = Σ(s=1..x, s)')).toThrow(/cannot depend on x/);
    expect(() => cls('a_n = Σ(s=1..t, s)')).toThrow(/cannot depend on t/);
    expect(() => evaluate((compileCpu(cls('a_n = Σ(s=1..n, s)')) as { term: Expr }).term, { n: 501 })).toThrow(/terms/);
  });
});

describe('sequence term references', () => {
  it('resolves Greek-named terms, matching the Greek row shapes', () => {
    const defs = new Env([['θ', scanSeqRec('θ_n = n^2')!]]);
    const resolve = sequenceResolver(defs, () => undefined, {}, new Set<string>());
    // θ₂ reaches here as θ_2 (subscripts canonicalize in the tokenizer).
    expect(evaluate(resolve('θ_2')!, {})).toBe(4);
    expect(resolve('θ_x')).toBeNull(); // not a literal index
  });

  it('pins the index in the source and resolves once, so Σ up to the index is a number', () => {
    const sums = new Env([['s', scanSeqRec('s_n = Σ(s=1..n, s)')!], ['b', scanSeqRec('b_n = Σ[n=1..n] n')!]]);
    const resolveSums = sequenceResolver(sums, () => undefined, {}, new Set<string>());
    expect(resolveSums('s_5')).toEqual({ kind: 'num', value: 15 });
    expect(resolveSums('b_4')).toEqual({ kind: 'num', value: 10 });
  });

  it('reads a_k at a slider, but never a_n at its own index', () => {
    const defs = new Env([['a', scanSeqRec('a_n = n^2')!]]);
    const resolve = sequenceResolver(defs, () => undefined, { consts: { k: 3, n: 2 } }, new Set(['k', 'n']));
    expect(evaluate(resolve('a_k')!, {})).toBe(9);
    expect(resolve('a_n')).toBeNull();
    expect(resolve('a_q')).toBeNull(); // no value to index by
  });

  it('reads a_n inside a Σ over n as each term', () => {
    const defs = new Env([['a', scanSeqRec('a_n = n^2')!]]);
    const resolve = sequenceResolver(defs, () => undefined, {}, new Set<string>());
    expect(evaluate(resolveExpr(parseExpr('sum(n=1..3, a_n)'), () => undefined, { sequenceTerm: resolve }), {})).toBe(14);
    expect(evaluate(resolveExpr(parseExpr('sum(m=1..3, a_m)'), () => undefined, { sequenceTerm: resolve }), {})).toBe(14);
  });

  it('reads a_N once per element of a list, in rows and in list-bounded sums', () => {
    for (const row of ['y = a_N x', 'y = (a_N + N) x', 'y = sum(n=1..N, a_n) x']) {
      const { rows } = analyzeRows(['a_0 = 1', 'a_{n+1} = a_n / 2', 'N = [2..4]', row]);
      expect(rows[3].error).toBeUndefined();
    }
  });
});

describe('sequences built from other sequences', () => {
  /** The plotted term of `row`, with the explicit sequences in `others` defined. */
  const termOf = (others: string[], row: string) => {
    const defs = new Env(others.map(r => { const scan = scanSeqRec(r)!; return [scan.name, scan] as const; }));
    const sequenceTerm = sequenceResolver(defs, () => undefined, {}, new Set<string>());
    const names = new Set([...defs.sequences.keys(), scanSeqRec(row)!.name]);
    const c = classifySeqRec(scanSeqRec(row)!, none, () => undefined, new Set(), { sequenceTerm }, names);
    return (compileCpu(c) as { term: Expr }).term;
  };
  const errorsOf = (rows: string[]) => analyzeRows(rows).rows.map(r => r.error);

  it('reads another explicit sequence at the row\'s own index', () => {
    expect(evaluate(termOf(['b_n = n^2'], 'a_n = b_n + 1'), { n: 3 })).toBe(10);
    expect(evaluate(termOf(['b_k = k^2'], 'a_n = b_n + 1'), { n: 3 })).toBe(10); // its own letter
    expect(evaluate(termOf(['b_n = n^2'], 'a_n = b_[n+1] - b_n'), { n: 3 })).toBe(7);
    expect(evaluate(termOf(['b_n = n^2'], 'a_n = sum(k=1..n, b_k)'), { n: 3 })).toBe(14);
  });

  it('gives terms at fixed indices too', () => {
    const { rows, constEnv } = analyzeRows(['b_n = n^2', 'a_n = b_n + 1', 'c = a_3']);
    expect(rows.map(r => r.error)).toEqual([undefined, undefined, undefined]);
    expect(constEnv.c).toBe(10);
  });

  it('names a cycle rather than looping', () => {
    expect(errorsOf(['a_n = b_n', 'b_n = a_n'])[1]).toMatch(/a and b are defined in terms of each other/);
    expect(errorsOf(['a_n = a_n + 1'])[0]).toMatch(/depends on itself/);
  });

  it('says a recurrence has no term at a changing index', () => {
    expect(errorsOf(['b_0 = 1', 'b_{n+1} = 2 b_n', 'a_n = b_n + 1'])[2]).toMatch(/b is a recurrence/);
    expect(errorsOf(['b_0 = 1', 'b_{k+1} = 2 b_k', 'a_n = b_n + 1'])[2]).toMatch(/b is a recurrence/);
    // …and a recurrence is drawn as a map, with no index to read another term at.
    expect(errorsOf(['b_n = n', 'a_0 = 1', 'a_{n+1} = a_n + b_n'])[2]).toMatch(/cannot use b_n/);
    // Fixed indices of a recurrence still work.
    expect(errorsOf(['b_0 = 1', 'b_{n+1} = 2 b_n', 'a_n = b_3 n'])[2]).toBeUndefined();
  });
});

describe('one sequence per letter', () => {
  it('reads a_k = 7 beside a_n = 1/n as the constant a_k', () => {
    expect(scanSequences(['a_n = 1/n', 'a_k = 7']).map(s => s?.name ?? null)).toEqual(['a', null]);
    // Alone, it is still the constant sequence.
    expect(scanSequences(['a_k = 7'])[0]).toMatchObject({ name: 'a', index: 'k' });
    const { rows, constEnv } = analyzeRows(['a_n = 1/n', 'k = 2', 'a_k = 7', 'c = a_k', 'p = a_2']);
    expect(rows.map(r => r.error)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(constEnv.c).toBe(7);
    expect(constEnv.p).toBe(0.5);
  });

  it('refuses a second definition of the same sequence', () => {
    expect(analyzeRows(['a_n = 1/n', 'a_k = k^2']).rows[1].error).toBe('Sequence a is already defined.');
    expect(analyzeRows(['a_n = 1/n', 'a_{n+1} = a_n / 2']).rows[1].error).toBe('Sequence a is already defined.');
  });
});

describe('subscripts in braces and parens', () => {
  const values = (rows: string[]) => {
    const { rows: out, constEnv } = analyzeRows(rows);
    expect(out.map(r => r.error)).toEqual(rows.map(() => undefined));
    return constEnv;
  };

  it('reads a single name or number in braces as one name, anywhere', () => {
    expect(parseExpr('T_{c} x')).toEqual(parseExpr('T_c x'));
    expect(parseExpr('a_{ 10 }^2')).toEqual(parseExpr('a_10^2'));
    expect(values(['T_{c} = 300', 'c = T_{c} + T_c']).c).toBe(600);
  });

  it('defines seeds and sequences written as the recurrence row is', () => {
    expect(scanDefinition('a_{0} = 1')).toMatchObject({ kind: 'const', name: 'a_0' });
    expect(scanDefinition('a_(0) = 1')).toMatchObject({ kind: 'const', name: 'a_0' });
    expect(scanDefinition('f_(x) = x^2')).toMatchObject({ kind: 'fn', name: 'f_' }); // parens around a name: a function
    expect(scanSeqRec('a_{n} = 1/n')).toMatchObject({ rec: false, name: 'a', index: 'n' });
    expect(scanSeqRec('b_(k) = k^2')).toMatchObject({ rec: false, name: 'b', index: 'k' });
    // The seed used to be dropped: a_{0} = 1 was not a definition at all.
    expect(values(['a_{0} = 1', 'a_{n+1} = 2 a_{n}', 'c = a_{3}']).c).toBe(8);
    expect(values(['a_(0) = 1', 'a_{n+1} = a_(n) + 1', 'c = a_(3)']).c).toBe(4);
  });

  it('indexes a sequence by an expression in braces or parens', () => {
    const b = ['b_n = n^2'];
    expect(evaluate(resolveExpr(parseExpr('b_{n+1} - b_(n)', new Set(), new Set(['b_'])), () => undefined, {
      sequenceTerm: sequenceResolver(new Env([['b', scanSeqRec(b[0])!]]), () => undefined, {}, new Set<string>()),
      openVars: new Set(['n']), // as in a sequence row, whose own index is open
    }), { n: 3 })).toBe(7);
    expect(values([...b, 'a_n = b_{n+1} - b_n', 'c = a_{3}', 'k = 2', 'p = b_{k}']))
      .toMatchObject({ c: 7, p: 4 });
  });
});
