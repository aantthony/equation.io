import { compileCpu, compileGpu } from './compiler.ts';
import { Env } from './env.ts';
import { describe, expect, it } from 'vitest';
import { evaluate, type Expr } from './expr.ts';
import { classifySeqRec, scanSeqRec, scanSequences, sequenceResolver } from './seq.ts';
import { evalTable } from './automaton.ts';
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

  it('draws a recurrence that reads its index as its terms, not a map', () => {
    // Alone it has no chain to read; analyzeRows gives it one (below).
    expect(() => cls('a_{n+1} = a_n + n')).toThrow(/needs the rest of the document/);
    expect(() => cls('a_{n+1} = x a_n + n')).toThrow(/cannot also take x/);
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
    expect(evaluate(plot.term, { n: 1 })).toBe(6); // 1+2+3
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
      consts: { N: 2 },
      boundConsts,
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
    const sums = new Env([
      ['s', scanSeqRec('s_n = Σ(s=1..n, s)')!],
      ['b', scanSeqRec('b_n = Σ[n=1..n] n')!],
    ]);
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
    expect(
      evaluate(
        resolveExpr(parseExpr('sum(n=1..3, a_n)'), () => undefined, { sequenceTerm: resolve }),
        {},
      ),
    ).toBe(14);
    expect(
      evaluate(
        resolveExpr(parseExpr('sum(m=1..3, a_m)'), () => undefined, { sequenceTerm: resolve }),
        {},
      ),
    ).toBe(14);
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
    const defs = new Env(
      others.map(r => {
        const scan = scanSeqRec(r)!;
        return [scan.name, scan] as const;
      }),
    );
    const sequenceTerm = sequenceResolver(defs, () => undefined, {}, new Set<string>());
    const names = new Set([...defs.sequences.keys(), scanSeqRec(row)!.name]);
    const c = classifySeqRec(scanSeqRec(row)!, none, () => undefined, new Set(), { sequenceTerm }, names);
    return (compileCpu(c) as { term: Expr }).term;
  };
  const errorsOf = (rows: string[]) => analyzeRows(rows).rows.map(r => r.error);

  it("reads another explicit sequence at the row's own index", () => {
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

  it('reads a recurrence at a changing index from the chain of its terms', () => {
    const at = (rows: string[], n: number) => {
      const { rows: out, constEnv } = analyzeRows(rows);
      expect(out.map(r => r.error)).toEqual(rows.map(() => undefined));
      const plot = compileCpu(out[out.length - 1].cls!) as { term: Expr; index: string };
      return evaluate(plot.term, { ...constEnv, [plot.index]: n });
    };
    const doubling = ['a_0 = 1', 'a_{n+1} = 2 a_n'];
    expect(at([...doubling, 'd_n = a_{n+1} - a_n'], 3)).toBe(8);
    expect(at([...doubling, 'd_k = a_(k+1)/a_k'], 5)).toBe(2); // its own letter
    expect(at([...doubling, 'b_n = a_n + 1'], 4)).toBe(17);
    // Past the chain (1000 terms), or off the whole numbers: no term.
    expect(at([...doubling, 'd_n = a_{n+1} - a_n'], 1000)).toBeNaN();
    // A recurrence may read another sequence at its own index too.
    expect(at(['b_n = n', 'a_0 = 1', 'a_{n+1} = a_n + b_n', 'd_n = a_n'], 4)).toBe(7);
  });

  it('depends on what the recurrence depends on', () => {
    const { rows } = analyzeRows(['r = 2.9', 'a_0 = 0.15', 'a_{n+1} = r a_n (1 - a_n)', 'd_n = a_{n+1}/a_n']);
    expect(rows[3].cls).toMatchObject({ params: ['a_0', 'r'], animated: false });
    expect(analyzeRows(['a_{n+1} = a_n + t', 'd_n = a_{n+1} - a_n']).rows[1].cls).toMatchObject({ animated: true });
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
    expect(
      evaluate(
        resolveExpr(parseExpr('b_{n+1} - b_(n)', new Set(), new Set(['b_'])), () => undefined, {
          sequenceTerm: sequenceResolver(new Env([['b', scanSeqRec(b[0])!]]), () => undefined, {}, new Set<string>()),
          openVars: new Set(['n']), // as in a sequence row, whose own index is open
        }),
        { n: 3 },
      ),
    ).toBe(7);
    expect(values([...b, 'a_n = b_{n+1} - b_n', 'c = a_{3}', 'k = 2', 'p = b_{k}'])).toMatchObject({ c: 7, p: 4 });
  });
});

describe('recurrences that read n and tuples', () => {
  const values = (rows: string[]) => {
    const { rows: out, constEnv } = analyzeRows(rows);
    expect(out.map(r => r.error)).toEqual(rows.map(() => undefined));
    return { out, constEnv };
  };
  /** The terms a recurrence row draws, n = 0..last. */
  const drawn = (rows: string[], row: number, last: number) => {
    const { out, constEnv } = values(rows);
    const plot = compileCpu(out[row].cls!) as { type: string; term: Expr; index: string };
    expect(plot.type).toBe('sequence');
    return Array.from({ length: last + 1 }, (_, n) => evaluate(plot.term, { ...constEnv, [plot.index]: n }));
  };

  it('reads n: each step is the source at that n', () => {
    expect(values(['a_0 = 1', 'a_{n+1} = (n + 1) a_n', 'c = a_5']).constEnv.c).toBe(120);
    expect(values(['a_0 = 0', 'a_{n+1} = a_n + 2n + 1', 'c = a_7']).constEnv.c).toBe(49);
    expect(values(['a_0 = 1', 'a_{n+1} = (n + 1) a_(n)', 'c = a_{4}']).constEnv.c).toBe(24);
    // Drawn as dots, one per term (there is no single map for a cobweb).
    expect(drawn(['a_0 = 1', 'a_{n+1} = (n + 1) a_n'], 1, 4)).toEqual([1, 1, 2, 6, 24]);
  });

  it('reads a slider, t and its seed as before', () => {
    const { constEnv } = values(['r = 2', 'a_0 = 3', 'a_{n+1} = r a_n + n', 'c = a_3']);
    expect(constEnv.c).toBe(28); // 3 → 6 → 13 → 28
    expect(analyzeRows(['r = 2', 'a_{n+1} = r a_n + n']).rows[1].cls).toMatchObject({ params: ['r'] });
    expect(analyzeRows(['a_{n+1} = a_n + n t']).rows[0].cls).toMatchObject({ animated: true });
  });

  it('reads a tuple at a position that moves with n: a state machine run', () => {
    const machine = [
      'D = (1, 1, 0, 1)', // 13 in binary
      'q_0 = 0',
      'step(q, s) = mod(2q + s, 3)',
      'q_{n+1} = step(q_n, D[n + 1])',
    ];
    // The remainder mod 3 of 1, 11, 110, 1101: 1, 0, 0, 1.
    expect(drawn(machine, 3, 4)).toEqual([0, 1, 0, 0, 1]);
    const { out, constEnv } = values([...machine, 'N = 3', 'c = q_4', 'mark(q_N)']);
    expect(constEnv.c).toBe(1);
    expect(out[6].mark).toBe(true);
    if (out[6].cpu?.type !== 'value') throw new Error('not a value');
    expect(evaluate(out[6].cpu.expr, constEnv)).toBe(0);
    // The run stops where the tuple does: drawn, the terms past it are
    // missing; asked for by number, it says why.
    expect(drawn(machine, 3, 6).slice(5).every(Number.isNaN)).toBe(true);
    expect(analyzeRows([...machine, 'c = q_5']).rows[4].error).toMatch(/out of range/);
  });

  it('reads a sorted list, and another sequence at n', () => {
    expect(values(['T = sort([1..5])', 'a_0 = 0', 'a_{n+1} = a_n + T[n + 1]', 'c = a_5']).constEnv.c).toBe(15);
    expect(values(['b_n = n^2', 'a_0 = 0', 'a_{n+1} = a_n + b_n', 'c = a_4']).constEnv.c).toBe(14);
    // Another recurrence at n: the sum of its terms, 1 + 2 + 4 + 8.
    const doubling = ['b_0 = 1', 'b_{n+1} = 2 b_n'];
    expect(values([...doubling, 'a_0 = 0', 'a_{n+1} = a_n + b_n', 'c = a_4']).constEnv.c).toBe(15);
    expect(drawn([...doubling, 'a_0 = 0', 'a_{n+1} = a_n + b_n'], 3, 4)).toEqual([0, 1, 3, 7, 15]);
  });

  it('stops a recurrence that reads another where that one runs out', () => {
    const rows = ['D = (1, 1, 0, 1)', 'q_0 = 0', 'q_{n+1} = q_n + D[n + 1]', 'b_0 = 0', 'b_{n+1} = b_n + q_n'];
    expect(drawn(rows, 2, 4)).toEqual([0, 1, 2, 2, 3]); // q, unharmed by b
    expect(drawn(rows, 4, 6).slice(0, 6)).toEqual([0, 0, 1, 3, 5, 8]);
    expect(drawn(rows, 4, 6)[6]).toBeNaN();
    expect(analyzeRows([...rows, 'g = b_6']).rows[5].error).toMatch(/out of range/);
  });

  it('still reports what is not a run off a tuple', () => {
    expect(analyzeRows(['r = [1..3]', 'a_0 = 0.5', 'a_{n+1} = a_n + r']).rows[2].error).toMatch(/one number/);
    const unknown = analyzeRows(['a_0 = 0', 'a_{n+1} = a_n + n + zz', 'c = a_3']).rows;
    expect(unknown[1].error).toMatch(/Unknown variable: zz/);
    expect(unknown[2].error).toMatch(/constant parameters \(found zz\)/);
    expect(analyzeRows(['a_0 = 0', 'a_{n+1} = a_n + n + y', 'c = a_3']).rows[2].error).toMatch(/found y/);
  });

  it('keeps an autonomous recurrence a cobweb', () => {
    expect(compileCpu(values(['a_0 = 0.2', 'a_{n+1} = a_n/2 + 1']).out[1].cls!).type).toBe('cobweb');
  });
});

describe('tuple-valued recurrences', () => {
  const values = (rows: string[]) => {
    const { rows: out, constEnv } = analyzeRows(rows);
    expect(out.map(r => r.error)).toEqual(rows.map(() => undefined));
    return { out, constEnv };
  };
  /** The terms a tuple-valued recurrence's row draws, one lattice row each. */
  const stack = (rows: string[], row: number) => {
    const plot = compileCpu(values(rows).out[row].cls!);
    if (plot.type !== 'lattice' || !plot.rows) throw new Error(`not a stack: ${plot.type}`);
    return plot.rows;
  };

  it('pushes onto the empty tuple, and reads its terms by number', () => {
    const rows = ['s_0 = ()', 's_{n+1} = push(s_n, n^2)'];
    expect(stack(rows, 1).slice(0, 4)).toEqual([[], [0], [0, 1], [0, 1, 4]]);
    const { constEnv } = values([...rows, 'c = count(s_3)', 'g = top(s_3)', 'h = s_3[2]', 'm = count(s_0)']);
    expect(constEnv).toMatchObject({ c: 3, g: 4, h: 1, m: 0 });
    // A slider picks the term, as for any sequence.
    expect(values([...rows, 'k = 4', 'c = top(s_k)']).constEnv.c).toBe(9);
    // No seed row: the empty tuple, a stack's usual start.
    expect(stack(['s_{n+1} = push(s_n, 1)'], 0)[2]).toEqual([1, 1]);
  });

  it('draws its terms as rows of a lattice: row n, position h', () => {
    const { out } = values(['s_0 = ()', 's_{n+1} = push(s_n, n + 1)']);
    expect(out[1].cls?.object).toMatchObject({ kind: 'lattice', axes: ['h', 'n'] });
    const plot = compileCpu(out[1].cls!) as Parameters<typeof evalTable>[0];
    // Rows 0..2, positions 0..3: position 0 and those past a term are empty.
    const grid = evalTable(plot, {}, 0, 0, 4, 3);
    expect(Array.from(grid.values)).toEqual([NaN, NaN, NaN, NaN, NaN, 1, NaN, NaN, NaN, 1, 2, NaN]);
  });

  it('starts from any tuple, and its step may change its length either way', () => {
    expect(stack(['s_0 = (1, 2, 3, 4)', 's_{n+1} = pop(s_n)'], 1)).toEqual([[1, 2, 3, 4], [1, 2, 3], [1, 2], [1], []]);
    // A number seed is a 1-tuple; s_n[1] reads its first element.
    expect(stack(['s_0 = 7', 's_{n+1} = push(s_n, s_n[1] + n)'], 1).slice(0, 3)).toEqual([[7], [7, 7], [7, 7, 8]]);
  });

  it('runs only the case that holds, so cases may differ in length', () => {
    // Balanced brackets: 1 opens, 2 closes.
    const rows = ['D = (1, 1, 2, 1, 2, 2)', 's_0 = ()', 's_{n+1} = {D[n + 1] = 1: push(s_n, 1), pop(s_n)}'];
    expect(stack(rows, 2)).toEqual([[], [1], [1, 1], [1], [1, 1], [1], []]);
    expect(values([...rows, 'c = count(s_6)']).constEnv.c).toBe(0);
    // The same step written as a function of the stack.
    const act = [
      'act(s, a) = {a = 1: push(s, 1), pop(s)}',
      'D = (1, 1, 2, 2)',
      's_0 = ()',
      's_{n+1} = act(s_n, D[n + 1])',
    ];
    expect(stack(act, 3)).toEqual([[], [1], [1, 1], [1], []]);
  });

  it('stops where it pops the empty tuple, or no case holds', () => {
    // A closing bracket with nothing open: the run ends at s_2.
    const rows = ['D = (1, 2, 2, 1)', 's_0 = ()', 's_{n+1} = {D[n + 1] = 1: push(s_n, 1), pop(s_n)}'];
    expect(stack(rows, 2)).toEqual([[], [1], []]);
    expect(analyzeRows([...rows, 'c = count(s_3)']).rows[3].error).toMatch(/empty tuple is out of range/);
    const stuck = ['D = (1, 3)', 's_0 = ()', 's_{n+1} = {D[n + 1] = 1: push(s_n, 1), D[n + 1] = 2: pop(s_n)}'];
    expect(stack(stuck, 2)).toEqual([[], [1]]);
    expect(analyzeRows([...stuck, 'c = s_2']).rows[3].error).toMatch(/No case of s's step holds at n = 1/);
  });

  it('is read by a recurrence that it reads: a pushdown automaton', () => {
    // a^n b^n: state 0 pushes each a (1), state 1 pops one per b (2); a b
    // before the a's are done moves to state 1.
    const pda = [
      'D = (1, 1, 1, 2, 2, 2)',
      'q_0 = 0',
      's_0 = ()',
      'q_{n+1} = {D[n + 1] = 2: 1, q_n}',
      's_{n+1} = {q_n = 0: {D[n + 1] = 1: push(s_n, 1), pop(s_n)}, pop(s_n)}',
      // Accepted: the input read, with the stack empty.
      'left = count(s_6)',
    ];
    expect(stack(pda, 4)).toEqual([[], [1], [1, 1], [1, 1, 1], [1, 1], [1], []]);
    expect(values(pda).constEnv.left).toBe(0);
    // The state reads the stack's top in turn: two sequences that read each
    // other, stepped together.
    const mutual = [
      'D = (1, 1, 2, 2)',
      'q_0 = 0',
      's_0 = ()',
      'q_{n+1} = {count(s_n) = 0: 0, top(s_n)}',
      's_{n+1} = {D[n + 1] = 1: push(s_n, q_n + 2), pop(s_n)}',
      'c = q_3',
    ];
    // q: 0, 0 (s_0 is empty), then the tops of s_1 and s_2, 2 and 2.
    expect(stack(mutual, 4)).toEqual([[], [2], [2, 2], [2], []]);
    expect(values(mutual).constEnv.c).toBe(2);
  });

  it('draws a point-valued recurrence as its orbit', () => {
    const henon = ['p_0 = (0, 0)', 'p_{n+1} = (1 - 1.4 p_n[1]^2 + p_n[2], 0.3 p_n[1])'];
    const plot = compileCpu(values(henon).out[1].cls!);
    if (plot.type !== 'dscatter') throw new Error(`not points: ${plot.type}`);
    expect(Array.from(plot.coords[0].slice(0, 3))).toEqual([0, 1, -0.3999999999999999]);
    expect(Array.from(plot.coords[1].slice(0, 3))).toEqual([0, 0, 0.3]);
    expect(values([...henon, 'c = p_2[1]']).constEnv.c).toBeCloseTo(-0.4);
  });

  it('says what it cannot do', () => {
    expect(analyzeRows(['s_{n+1} = push(s_n, t)']).rows[0].error).toMatch(/cannot read t/);
    expect(analyzeRows(['s_0 = (1, 2, 3, 4)', 's_{n+1} = s_n + 1']).rows[1].error).toMatch(/scales by a number/);
    expect(analyzeRows(['s_{n+1} = push(s_n, 1)', 'd_n = count(s_n)']).rows[1].error).toMatch(/s's terms are tuples/);
  });
});

describe('recurrences that read each other', () => {
  it('steps both together', () => {
    const { rows, constEnv } = analyzeRows([
      'q_0 = 0',
      'r_0 = 1',
      'q_{n+1} = q_n + r_n',
      'r_{n+1} = r_n + q_n + 1',
      'c = q_4',
    ]);
    expect(rows.map(r => r.error)).toEqual(rows.map(() => undefined));
    expect(constEnv.c).toBe(15); // q: 0, 1, 3, 7, 15
  });

  it('tests equality in a case, at whole n', () => {
    const { rows, constEnv } = analyzeRows([
      'a_n = {mod(n, 2) = 0: 1, 0}',
      'c = a_4',
      'b_0 = 0',
      'b_{n+1} = {b_n = 0: 1, 0}',
      'g = b_3',
    ]);
    expect(rows.map(r => r.error)).toEqual(rows.map(() => undefined));
    expect(constEnv).toMatchObject({ c: 1, g: 1 });
  });
});
