import { describe, expect, it } from 'vitest';
import { parseExpr } from './expr.ts';
import { exprToPoly, polynomialRoots } from './poly.ts';

function roots(s: string, v = 'x') {
  return polynomialRoots(parseExpr(s), v);
}

function poly(s: string, v = 'x') {
  return exprToPoly(parseExpr(s), v);
}

describe('polynomialRoots', () => {
  it('finds simple roots to full precision', () => {
    const r = roots('x^2 - 2');
    expect(r).toEqual([
      { x: -Math.SQRT2, mult: 1, sym: '-√2' },
      { x: Math.SQRT2, mult: 1, sym: '√2' },
    ]);
  });

  it('returns the multiset of roots with multiplicities', () => {
    // (x-1)^2 (x+2): double root at 1, simple root at -2.
    expect(roots('(x-1)^2 (x+2)')).toEqual([
      { x: -2, mult: 1 },
      { x: 1, mult: 2 },
    ]);
    expect(roots('x^3')).toEqual([{ x: 0, mult: 3 }]);
    expect(roots('x^2 - 2x + 1')).toEqual([{ x: 1, mult: 2 }]);
  });

  it('enumerates all roots of a Wilkinson-style product exactly once', () => {
    // ∏ (x - k), k = 1..10 — notoriously ill-conditioned in expanded form.
    const s = Array.from({ length: 10 }, (_, i) => `(x - ${i + 1})`).join('');
    const r = roots(s);
    expect(r).not.toBeNull();
    expect(r).not.toBe('zero');
    const list = r as Array<{ x: number; mult: number }>;
    expect(list.length).toBe(10);
    list.forEach((root, i) => {
      expect(root.mult).toBe(1);
      expect(root.x).toBeCloseTo(i + 1, 12);
    });
  });

  it('separates very close roots', () => {
    const r = roots('(x - 1)(x - 1.0000001)') as Array<{ x: number; mult: number }>;
    expect(r.length).toBe(2);
    expect(r[0].x).toBeCloseTo(1, 12);
    expect(r[1].x).toBeCloseTo(1.0000001, 12);
  });

  it('handles no real roots and constants', () => {
    expect(roots('x^2 + 1')).toEqual([]);
    expect(roots('7')).toEqual([]);
    expect(roots('0 x + 0')).toBe('zero');
  });

  it('evaluates constant subexpressions exactly as doubles', () => {
    const r = roots('(x - sqrt(2))(x + pi)') as Array<{ x: number }>;
    expect(r.length).toBe(2);
    expect(r[0].x).toBeCloseTo(-Math.PI, 14);
    expect(r[1].x).toBeCloseTo(Math.SQRT2, 14);
  });

  it('handles decimal coefficients', () => {
    const r = roots('(x - 0.1)(x - 0.2)') as Array<{ x: number }>;
    expect(r.length).toBe(2);
    expect(r[0].x).toBeCloseTo(0.1, 15);
    expect(r[1].x).toBeCloseTo(0.2, 15);
  });

  it('works through equations (l = r means l - r)', () => {
    expect(roots('x^2 = 4')).toEqual([
      { x: -2, mult: 1 },
      { x: 2, mult: 1 },
    ]);
  });

  it('rejects non-polynomials', () => {
    expect(roots('sin(x)')).toBeNull();
    expect(roots('2^x')).toBeNull();
    expect(roots('x^0.5')).toBeNull();
    expect(roots('1/x')).toBeNull();
    expect(roots('x + y')).toBeNull();
  });

  it('scales to moderately high degree', () => {
    const r = roots('x^64 - 1') as Array<{ x: number; mult: number }>;
    expect(r.length).toBe(2);
    expect(r[0].x).toBe(-1);
    expect(r[1].x).toBe(1);
  });
});

describe('symbolic root labels', () => {
  const syms = (s: string) => (roots(s) as Array<{ sym?: string }>).map(r => r.sym);

  it('labels quadratic irrationals as radicals', () => {
    expect(syms('x^2 - 2')).toEqual(['-√2', '√2']);
    expect(syms('2 - x^2')).toEqual(['-√2', '√2']);
    expect(syms('x^2 - 12')).toEqual(['-2√3', '2√3']);
    expect(syms('x^2 - x - 1')).toEqual(['(1-√5)/2', '(1+√5)/2']);
    expect(syms('4x^2 - 3')).toEqual(['-√3/2', '√3/2']);
  });

  it('labels rationals, but leaves integers to the decimal display', () => {
    expect(syms('6x^2 - 5x + 1')).toEqual(['1/3', '1/2']);
    expect(syms('x^2 - 4')).toEqual([undefined, undefined]);
    expect(syms('3x - 1')).toEqual(['1/3']);
  });

  it('labels roots of deflatable cubics and binomials', () => {
    // (x - 1)(x² - 2) expanded: the rational root deflates away and the
    // remaining quadratic yields radicals.
    expect(syms('x^3 - x^2 - 2x + 2')).toEqual(['-√2', undefined, '√2']);
    expect(syms('x^3 - 2')).toEqual(['∛2']);
    expect(syms('x^4 - 4')).toEqual(['-√2', '√2']); // ∜4 simplifies
    expect(syms('x^4 - 3')).toEqual(['-∜3', '∜3']);
  });

  it('does not force radicals onto float-coefficient roots', () => {
    // 0.1 is a dyadic double, not 1/10, so no false "1/10" label.
    expect(syms('(x - 0.1)(x - 0.2)')).toEqual([undefined, undefined]);
  });

  it('shows the defining polynomial when no radical form exists', () => {
    // x⁷ - x - 2: no rational roots, not a binomial — generic degree-7
    // Galois group is S₇, unsolvable, so no radical expression exists.
    const r = roots('2 - x^7 + x') as Array<{ sym?: string; rootOf?: string }>;
    expect(r.length).toBe(1);
    expect(r[0].sym).toBeUndefined();
    expect(r[0].rootOf).toBe('x⁷ - x - 2');
    // A deflatable rational root still labels, and the leftover quintic
    // x⁵ - x - 1 gets its defining polynomial.
    const q = roots('(x - 1)(x^5 - x - 1)') as Array<{ x: number; rootOf?: string }>;
    expect(q.length).toBe(2);
    expect(q.find(v => Math.abs(v.x - 1) > 1e-9)!.rootOf).toBe('x⁵ - x - 1');
  });

  it('keeps multiplicity alongside the label', () => {
    const r = roots('(x^2 - 2)^2') as Array<{ sym?: string; mult: number }>;
    expect(r).toEqual([
      { x: -Math.SQRT2, mult: 2, sym: '-√2' },
      { x: Math.SQRT2, mult: 2, sym: '√2' },
    ]);
  });
});

describe('exprToPoly coefficient bit budget', () => {
  // Decimal literals are dyadic rationals with ~55-bit numerators, so
  // (0.1x - 0.3)^n keeps degree n but carries ~55n bits per coefficient.
  // Degree alone therefore does not bound the work: every Frac operation
  // runs a bigint gcd, and the exact path used to take ~60 s for n = 128
  // — synchronously, inside the pointermove hover handler.

  it('keeps modest decimal coefficients on the exact path', () => {
    // 221 bits: well inside the budget, so multiplicity stays exact.
    // (0.3 / 0.1 as doubles is a hair under 3, and the exact path says so.)
    expect(poly('(0.1x - 0.3)^4')).not.toBeNull();
    const r = roots('(0.1x - 0.3)^4') as Array<{ x: number; mult: number }>;
    expect(r.length).toBe(1);
    expect(r[0].mult).toBe(4);
    expect(r[0].x).toBeCloseTo(3, 14);
    expect(poly('(x - 0.1)(x - 0.2)(x - 0.3)(x - 0.4)(x - 0.5)')).not.toBeNull();
  });

  it('bails to null once coefficients outgrow the bit budget', () => {
    for (const s of ['(0.1x - 0.3)^16', '(0.1x - 0.3)^128', '(x - 0.1)^32 (x - 0.3)^32', '(x - 0.1)^64 (x - 0.3)^64']) {
      expect(poly(s), s).toBeNull();
      // polynomialRoots propagates the null so roots.ts falls back to
      // numeric root finding rather than grinding on huge rationals.
      expect(roots(s), s).toBeNull();
    }
  });

  it('bails on coefficient growth, not just on degree', () => {
    // Same degree 64, and the same MAX_DEGREE verdict, but only the decimal
    // version blows up in coefficient size.
    expect(poly('(x + 1)^64')).not.toBeNull();
    expect(poly('(x - 0.1)^64')).toBeNull();
  });

  it('resolves pathological expressions quickly', () => {
    // Each of these took 0.7 s – 60 s before the budget existed. The bound
    // is deliberately loose for slow CI; locally they are all a few ms.
    for (const s of [
      '(0.1x - 0.3)^128',
      '(x - 0.1)^64 (x - 0.3)^64',
      '(x - 0.123456789)^64 (x - 0.3)^32 (x - 0.7)^32',
      '(x - 0.1)^32 (x - 0.3)^32',
    ]) {
      const t0 = performance.now();
      roots(s);
      expect(performance.now() - t0, s).toBeLessThan(2000);
    }
  });

  it('keeps integer-coefficient polynomials exact and fast', () => {
    const t0 = performance.now();
    // (x+1)^128 peaks at 125 bits — binomial coefficients, not decimals.
    expect(roots('(x + 1)^128')).toEqual([{ x: -1, mult: 128 }]);
    // x^128 - 2 stays a binomial with its radical label.
    const bin = roots('x^128 - 2') as Array<{ sym?: string }>;
    expect(bin.length).toBe(2);
    expect(bin[1].sym).toBe('2^(1/128)');
    // Wilkinson-20: 64 bits, all twenty roots exact.
    const w = Array.from({ length: 20 }, (_, i) => `(x - ${i + 1})`).join('');
    expect(roots(w)).toEqual(Array.from({ length: 20 }, (_, i) => ({ x: i + 1, mult: 1, sym: undefined })));
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
