import { describe, expect, it } from 'vitest';
import { evaluate, Expr, freeVars, ISPRIME_MAX, LANCZOS, parseExpr } from './expr.ts';
import { GLSL_PRELUDE, toGLSL } from './glsl.ts';

function evalExpr(e: Expr, env: Record<string, number>): number {
  switch (e.kind) {
    case 'num': return e.value;
    case 'var': {
      if (!(e.name in env)) throw new Error(`Unbound: ${e.name}`);
      return env[e.name];
    }
    case 'neg': return -evalExpr(e.a, env);
    case 'bin': {
      const a = evalExpr(e.a, env);
      const b = evalExpr(e.b, env);
      switch (e.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return a / b;
        case '^': return Math.pow(a, b);
      }
    }
    case 'call': {
      const args = e.args.map(a => evalExpr(a, env));
      const fns: Record<string, (...xs: number[]) => number> = {
        sin: Math.sin, cos: Math.cos, tan: Math.tan, sqrt: Math.sqrt,
        abs: Math.abs, exp: Math.exp, ln: Math.log, log: Math.log10,
        min: Math.min, max: Math.max, atan: Math.atan, floor: Math.floor,
      };
      return fns[e.name](...args);
    }
    case 'eq': return evalExpr(e.l, env) - evalExpr(e.r, env);
  }
}

const evl = (s: string, env: Record<string, number> = {}) => evalExpr(parseExpr(s), env);

describe('parseExpr', () => {
  it('parses arithmetic with precedence', () => {
    expect(evl('1+2*3')).toBe(7);
    expect(evl('(1+2)*3')).toBe(9);
    expect(evl('2^10')).toBe(1024);
    expect(evl('2^3^2')).toBe(512); // right associative
    expect(evl('10-2-3')).toBe(5);
    expect(evl('12/2/3')).toBe(2);
  });

  it('handles unary minus', () => {
    expect(evl('-3')).toBe(-3);
    expect(evl('-x^2', { x: 2 })).toBe(-4);
    expect(evl('2*-3')).toBe(-6);
    expect(evl('x^-1', { x: 4 })).toBe(0.25);
    expect(evl('-(1+2)')).toBe(-3);
  });

  it('handles implicit multiplication', () => {
    expect(evl('2x', { x: 5 })).toBe(10);
    expect(evl('2x^2', { x: 3 })).toBe(18);
    expect(evl('x(x+1)', { x: 3 })).toBe(12);
    expect(evl('(x+1)(x-1)', { x: 3 })).toBe(8);
    expect(evl('2pi')).toBeCloseTo(Math.PI * 2);
  });

  it('parses function calls', () => {
    expect(evl('sin(0)')).toBe(0);
    expect(evl('cos(0)')).toBe(1);
    expect(evl('sin(x)^2', { x: 2 })).toBeCloseTo(Math.sin(2) ** 2);
    expect(evl('max(1, 2)')).toBe(2);
    expect(evl('min(1+1, 5, 0-3)')).toBe(-3);
    expect(evl('2sin(x)', { x: 1 })).toBeCloseTo(2 * Math.sin(1));
  });

  it('parses decimals', () => {
    expect(evl('1.5+2.25')).toBe(3.75);
    expect(evl('0.5x', { x: 4 })).toBe(2);
  });

  it('has no scientific notation: 1e-3 is 1·e − 3, not 0.001', () => {
    // The grammar treats `e` as Euler's constant with implicit multiplication,
    // so anything gating on "plain number" (e.g. slider detection in the web
    // UI) must not accept exponent forms.
    expect(evl('1e-3')).toBeCloseTo(Math.E - 3);
    expect(evl('2e5', { e5: 7 })).toBe(14); // e5 is one symbol
    expect(evl('1E-3', { E: 2 })).toBe(-1);
  });

  it('parses equations as l - r', () => {
    const e = parseExpr('y = x^2');
    expect(e.kind).toBe('eq');
    expect(evalExpr(e, { x: 3, y: 9 })).toBe(0);
    expect(evalExpr(e, { x: 3, y: 10 })).toBe(1);
  });

  it('rejects incomplete expressions with a parse error', () => {
    for (const s of ['f(x) = x^3 - 2x,', 'x,', '2,', 'x+', ',x', 'sin()']) {
      expect(() => parseExpr(s)).toThrow('Incomplete expression.');
    }
  });

  it('auto-closes brackets left open at the end of input', () => {
    // Half-typed input parses as if the missing closers were there, so the
    // plot updates while typing.
    expect(parseExpr('y=sin(x')).toEqual(parseExpr('y=sin(x)'));
    expect(parseExpr('y=(x+1)(x-2')).toEqual(parseExpr('y=(x+1)(x-2)'));
    expect(parseExpr('y=max(x,1')).toEqual(parseExpr('y=max(x,1)'));
    expect(parseExpr('y=sqrt((x')).toEqual(parseExpr('y=sqrt((x))'));
    expect(parseExpr('y=|x')).toEqual(parseExpr('y=|x|'));
    expect(parseExpr('y=[1,2')).toEqual(parseExpr('y=[1,2]'));
    expect(parseExpr('Σ[n=1..3')).toEqual(parseExpr('Σ[n=1..3]'));
    // A stray closer is still an error.
    expect(() => parseExpr('y=x)')).toThrow(/open brace/);
  });

  it('parses Σ/Π headers into sum/prod call nodes', () => {
    const e = parseExpr('sum(n=1..N, n^2)');
    expect(e).toMatchObject({ kind: 'call', name: 'sum' });
    expect((e as Expr & { kind: 'call' }).args).toHaveLength(4);
    expect((e as Expr & { kind: 'call' }).args[0]).toEqual({ kind: 'var', name: 'n' });

    const header = parseExpr('Σ[n=1..3]');
    expect(header).toMatchObject({ kind: 'call', name: 'sum' });
    expect((header as Expr & { kind: 'call' }).args).toHaveLength(3);

    expect(parseExpr('∏(k=1..3, k)')).toMatchObject({ kind: 'call', name: 'prod' });
    expect(() => parseExpr('sum(1..3, n)')).toThrow(/Expected sum/);
    expect(() => parseExpr('sum(n=1..2, a, b)')).toThrow(/Expected sum/);
  });

  it('tokenizes .. after integers and decimals', () => {
    const range = (s: string) => parseExpr(`sum(n=${s}, n)`) as Expr & { kind: 'call' };
    expect(range('1..3').args.slice(1, 3)).toEqual([{ kind: 'num', value: 1 }, { kind: 'num', value: 3 }]);
    expect(range('1.5..N').args[1]).toEqual({ kind: 'num', value: 1.5 });
  });

  it('collects free variables', () => {
    expect([...freeVars(parseExpr('x^2+y^2=1'))].sort()).toEqual(['x', 'y']);
    expect([...freeVars(parseExpr('z = sin(x)cos(y)'))].sort()).toEqual(['x', 'y', 'z']);
    expect([...freeVars(parseExpr('sin(x)'))]).toEqual(['x']);
    expect([...freeVars(parseExpr('2pi'))]).toEqual([]);
  });
});

describe('toGLSL', () => {
  it('emits float literals', () => {
    expect(toGLSL(parseExpr('1+2'))).toBe('(1.0 + 2.0)');
    expect(toGLSL(parseExpr('1.5'))).toBe('1.5');
  });

  it('expands small integer powers', () => {
    expect(toGLSL(parseExpr('x^2'))).toBe('(x*x)');
    expect(toGLSL(parseExpr('x^y'))).toBe('eq_pow(x, y)');
  });

  it('maps function names', () => {
    expect(toGLSL(parseExpr('ln(x)'))).toBe('log(x)');
    expect(toGLSL(parseExpr('sin(x)'))).toBe('sin(x)');
  });

  it('compiles equations to a difference', () => {
    expect(toGLSL(parseExpr('y=x'))).toBe('(y - (x))');
  });
});

describe('factorial and special functions', () => {
  const ev = (s: string, env: Record<string, number> = {}) => evaluate(parseExpr(s), env);

  it('evaluates postfix factorial exactly on whole numbers', () => {
    expect(ev('5!')).toBe(120);
    expect(ev('0!')).toBe(1);
    expect(ev('3!!')).toBe(720);
    expect(ev('170!')).toBe(7.257415615307994e306);
    expect(ev('171!')).toBe(Infinity);
  });

  it('binds tighter than ^ and unary minus, and ends a value', () => {
    expect(ev('2^3!')).toBe(64);
    expect(ev('-3!')).toBe(-6);
    expect(ev('3! x', { x: 2 })).toBe(12); // implicit multiplication after !
    expect(ev('3!(x + 1)', { x: 1 })).toBe(12);
  });

  it('extends to the reals through Gamma, undefined at the poles', () => {
    expect(ev('gamma(5)')).toBeCloseTo(24, 9);
    // Lanczos g=5 is documented to ~2e-10 relative error; hold it to that.
    expect(ev('gamma(0.5)')).toBeCloseTo(Math.sqrt(Math.PI), 9);
    expect(ev('gamma(-0.5)')).toBeCloseTo(-2 * Math.sqrt(Math.PI), 9);
    expect(ev('(0.5)!')).toBeCloseTo(0.5 * Math.sqrt(Math.PI), 9);
    expect(ev('Gamma(4)')).toBeCloseTo(6, 9); // case-folded like other builtins
    expect(ev('gamma(0)')).toBeNaN();
    expect(ev('gamma(-3)')).toBeNaN();
    expect(ev('(-1)!')).toBeNaN();
  });

  it('evaluates sinc and coth', () => {
    expect(ev('sinc(0)')).toBe(1);
    expect(ev('sinc(pi)')).toBeCloseTo(0, 12);
    expect(ev('sinc(1.5)')).toBeCloseTo(Math.sin(1.5) / 1.5, 12);
    expect(ev('coth(1)')).toBeCloseTo(1 / Math.tanh(1), 12);
  });

  it('compiles to the GLSL twins', () => {
    expect(toGLSL(parseExpr('gamma(x)'))).toBe('eq_gamma(x)');
    expect(toGLSL(parseExpr('x!'))).toBe('eq_factorial(x)');
    expect(toGLSL(parseExpr('sinc(x)'))).toBe('eq_sinc(x)');
    expect(toGLSL(parseExpr('coth(x)'))).toBe('eq_coth(x)');
  });

  it('feeds the one LANCZOS array into the GLSL prelude', () => {
    for (const c of LANCZOS) expect(GLSL_PRELUDE).toContain(`+ ${c} / (z + `);
  });

  it('reads != as a comparison, never as postfix factorial', () => {
    // One token, so the '!' can never be read as a factorial with '=' after
    // it — which would silently graph factorial(x) = 2.
    expect(parseExpr('x != 2')).toMatchObject({ kind: 'call', name: '[ne]' });
    expect(parseExpr('x!=2')).toMatchObject({ kind: 'call', name: '[ne]' });
    expect(parseExpr('x == 2')).toMatchObject({ kind: 'call', name: '[eq]' });
    expect(ev('x! = 2', { x: 3 })).toBe(4); // spaced: the equation x! = 2, as l - r
  });

  it('stays finite up to the true double overflow (log-space Lanczos)', () => {
    expect(ev('gamma(150)') / ev('149!')).toBeCloseTo(1, 9);
    expect(ev('gamma(171)') / ev('170!')).toBeCloseTo(1, 9);
    expect(ev('gamma(172)')).toBe(Infinity); // 171! really is beyond a double
    expect(ev('169.5!')).toBeLessThan(Infinity);
    // Reflection stays finite too: Γ(x)Γ(1−x) = π/sin(πx) deep in the negatives.
    expect(Math.abs(ev('gamma(-142.7)'))).toBeGreaterThan(0);
    expect(ev('gamma(-142.7) gamma(143.7)')).toBeCloseTo(Math.PI / Math.sin(-142.7 * Math.PI), 6);
  });
});

describe('negative base with fractional exponent (real odd roots)', () => {
  const ev = (s: string, env: Record<string, number> = {}) => evaluate(parseExpr(s), env);

  it('takes the real cube root of a negative base', () => {
    expect(ev('(-8)^(1/3)')).toBeCloseTo(-2);
    expect(ev('(-1)^(1/3)')).toBeCloseTo(-1);
  });

  it('gives a positive result for an even numerator over an odd denominator', () => {
    expect(ev('(-8)^(2/3)')).toBeCloseTo(4);
  });

  it('handles negative fractional exponents', () => {
    expect(ev('(-8)^(-1/3)')).toBeCloseTo(-0.5);
  });

  it('leaves even roots of a negative base undefined', () => {
    expect(ev('(-4)^(1/2)')).toBeNaN();
    expect(ev('(-8)^(1/4)')).toBeNaN();
  });

  it('does not snap a typed decimal approximation to a nearby rational', () => {
    // 0.33333 is ~3.3e-6 away from 1/3, outside the 1e-6 tolerance, so this
    // stays undefined rather than being guessed at as a cube root.
    expect(ev('(-8)^(0.33333)')).toBeNaN();
  });

  it('leaves positive bases with fractional exponents unaffected', () => {
    expect(ev('8^(1/3)')).toBeCloseTo(2);
    expect(ev('8^(2/3)')).toBeCloseTo(4);
  });

  it('still handles integer exponents on negative bases', () => {
    expect(ev('(-2)^3')).toBe(-8);
    expect(ev('(-2)^2')).toBe(4);
  });
});

describe('absolute value bars', () => {
  const ev = (s: string, env: Record<string, number> = {}) => evaluate(parseExpr(s), env);

  it('parses |x| as abs(x)', () => {
    expect(ev('|x|', { x: -3 })).toBe(3);
    expect(ev('|x-5|', { x: 2 })).toBe(3);
  });

  it('multiplies implicitly around bars', () => {
    expect(ev('2|x|', { x: -3 })).toBe(6);
    expect(ev('|x||y|', { x: -2, y: -3 })).toBe(6);
    expect(ev('|x|y', { x: -2, y: 3 })).toBe(6);
  });

  it('handles nested bars', () => {
    expect(ev('||x|-4|', { x: 1 })).toBe(3);
    expect(ev('|x-|y||', { x: 1, y: -4 })).toBe(3);
  });

  it('compiles to GLSL abs', () => {
    expect(toGLSL(parseExpr('|x|+1'))).toBe('(abs(x) + 1.0)');
  });
});

describe('hyperbolic functions', () => {
  const ev = (s: string, env: Record<string, number> = {}) => evaluate(parseExpr(s), env);

  it('evaluates sech and inverse hyperbolics', () => {
    expect(ev('sech(0)')).toBe(1);
    expect(ev('sech(x)', { x: 2 })).toBeCloseTo(1 / Math.cosh(2));
    expect(ev('asinh(x)', { x: Math.sinh(1.5) })).toBeCloseTo(1.5);
    expect(ev('acosh(x)', { x: Math.cosh(1.5) })).toBeCloseTo(1.5);
    expect(ev('atanh(x)', { x: Math.tanh(0.5) })).toBeCloseTo(0.5);
  });

  it('compiles sech via helper and inverse hyperbolics to builtins', () => {
    expect(toGLSL(parseExpr('sech(x)'))).toBe('eq_sech(x)');
    expect(toGLSL(parseExpr('asinh(x)'))).toBe('asinh(x)');
    expect(toGLSL(parseExpr('acosh(x)'))).toBe('acosh(x)');
    expect(toGLSL(parseExpr('atanh(x)'))).toBe('atanh(x)');
  });
});

describe('case-insensitive builtin functions', () => {
  const ev = (s: string, env: Record<string, number> = {}) => evaluate(parseExpr(s), env);

  it('folds function-name case to the canonical builtin', () => {
    expect(parseExpr('Sin(x)')).toMatchObject({ kind: 'call', name: 'sin' });
    expect(parseExpr('COS(x)')).toMatchObject({ kind: 'call', name: 'cos' });
    expect(parseExpr('SQRT(x)')).toMatchObject({ kind: 'call', name: 'sqrt' });
    expect(parseExpr('Ln(x)')).toMatchObject({ kind: 'call', name: 'ln' });
    expect(parseExpr('ATAN2(y, x)')).toMatchObject({ kind: 'call', name: 'atan2' });
  });

  it('evaluates and compiles a folded call as its canonical form', () => {
    expect(ev('Sin(pi/2)')).toBeCloseTo(1);
    expect(toGLSL(parseExpr('COS(x)'))).toBe('cos(x)');
  });

  it('keeps user-defined function names case-sensitive', () => {
    // F is not a builtin, so with no user fns it is a product F*(x), not a call.
    expect(parseExpr('F(x)')).toMatchObject({ kind: 'bin', op: '*' });
    // Declared as a user fn, it parses as a call under its exact name.
    expect(parseExpr('F(x)', new Set(['F']))).toMatchObject({ kind: 'call', name: 'F' });
  });
});

describe('a name the document already bound', () => {
  const NONE = new Set<string>();

  it('reads as that value, not as the builtin added later', () => {
    // `total`, `count` and `mean` became reductions long after graphs were
    // shared using them as slider names, where `total(x + 1)` was a product.
    // Nothing else in a saved link could tell those two readings apart.
    expect(parseExpr('total(x + 1)')).toMatchObject({ kind: 'call', name: 'total' });
    expect(parseExpr('total(x + 1)', NONE, NONE, new Set(['total'])))
      .toMatchObject({ kind: 'bin', op: '*', a: { kind: 'var', name: 'total' } });
    // Case folds with the builtin lookup, so no spelling sneaks back in.
    expect(parseExpr('Count(x)', NONE, NONE, new Set(['count'])))
      .toMatchObject({ kind: 'bin', op: '*' });
  });

  it('only shadows the builtins a graph was allowed to claim', () => {
    // `sin` was never nameable, so a stray entry cannot turn sin(x) into a
    // product — the shadow list and the naming rule answer the same question.
    expect(parseExpr('sin(x)', NONE, NONE, new Set(['sin'])))
      .toMatchObject({ kind: 'call', name: 'sin' });
    // …and a document that binds nothing keeps every reduction a reduction.
    expect(parseExpr('mean(L)', NONE, new Set(['L']))).toMatchObject({ kind: 'call', name: 'mean' });
  });
});

describe('piecewise', () => {
  const ev = (s: string, env: Record<string, number> = {}) => evaluate(parseExpr(s), env);

  it('parses and evaluates {cond: value} branches in order', () => {
    const e = parseExpr('{x < 0: -x, x >= 0: x^2}');
    expect(e.kind).toBe('piecewise');
    expect(ev('{x < 0: -x, x >= 0: x^2}', { x: -3 })).toBe(3);
    expect(ev('{x < 0: -x, x >= 0: x^2}', { x: 2 })).toBe(4);
  });

  it('supports chained conditions and a trailing default', () => {
    expect(ev('{0 < x < 1: 1, 0}', { x: 0.5 })).toBe(1);
    expect(ev('{0 < x < 1: 1, 0}', { x: 2 })).toBe(0);
  });

  it('is NaN outside all cases when there is no default', () => {
    expect(ev('{x > 0: 1}', { x: -1 })).toBeNaN();
  });

  it('compiles to nested GLSL ternaries', () => {
    const g = toGLSL(parseExpr('{x < 0: -x, 1}'));
    expect(g).toContain('(x < 0.0)');
    expect(g).toContain('?');
  });

  it('rejects non-inequality conditions', () => {
    expect(() => parseExpr('{x: 1, 2}')).toThrow(/inequalities/);
  });

  it('keeps plain braces as grouping', () => {
    expect(ev('2{x + 1}', { x: 2 })).toBe(6);
  });
});

describe('lists', () => {
  it('parses numeric lists', () => {
    const e = parseExpr('[1, 4, 2, 8]');
    if (e.kind !== 'list') throw new Error('expected list');
    expect(e.items).toHaveLength(4);
    expect(evaluate(e.items[3], {})).toBe(8);
  });

  it('parses point lists without flattening the pairs', () => {
    const e = parseExpr('[(1, 2), (3, 4)]');
    if (e.kind !== 'list') throw new Error('expected list');
    expect(e.items).toHaveLength(2);
    expect(e.items.every(i => i.kind === 'vec')).toBe(true);
  });

  it('keeps single-item brackets as grouping', () => {
    expect(evaluate(parseExpr('2[x + 1]'), { x: 2 })).toBe(6);
  });

  it('rejects lists inside expressions', () => {
    expect(() => toGLSL(parseExpr('[1, 2] + 1'))).toThrow(/own row/);
  });

  it('still parses parenthesized vectors and function arguments', () => {
    expect(parseExpr('(1, 2)').kind).toBe('vec');
    expect(evaluate(parseExpr('atan2(1, 1)'), {})).toBeCloseTo(Math.PI / 4);
  });
});

describe('leading-dot numbers', () => {
  it('reads .5 as a bound of a range', () => {
    // The number scan is greedy, so `.5..2` tokenizes as `.` `5.` `.` `2` —
    // the range operator has to be reassembled from the two halves.
    expect(parseExpr('[.5..2]')).toEqual(parseExpr('[0.5..2]'));
    expect(evaluate(parseExpr('.5'), {})).toBe(0.5);
    expect(evaluate(parseExpr('x + .25'), { x: 1 })).toBe(1.25);
  });
});

describe('text', () => {
  it('reads quoted text', () => {
    expect(parseExpr('"New York"')).toEqual({ kind: 'str', value: 'New York' });
  });

  it('ends a value, so text in arithmetic parses and then says what is wrong', () => {
    // Text was not one of the token types that end a value, so `"NYC" + 1`
    // read the '+' as a unary sign and left two things on the stack. The row
    // died as "Incomplete expression.", which reads as a typo rather than as
    // the real answer — text has no numeric value.
    const text = /Text has no numeric value/;
    expect(() => evaluate(parseExpr('"NYC" + 1'), {})).toThrow(text);
    expect(() => evaluate(parseExpr('2 "NYC"'), {})).toThrow(text);
    expect(() => evaluate(parseExpr('x + "NYC"'), { x: 1 })).toThrow(text);
    // Where text belongs, nothing changed.
    expect(parseExpr('p[p.city == "NYC"]', undefined, new Set(['p'])))
      .toMatchObject({ name: '[index]' });
  });

  it('refuses a ";" inside text', () => {
    // The URL joins rows with ';' and percent-encodes the quotes, so nothing
    // in the payload distinguishes this from a separator: the row would come
    // back split. Refusing it here keeps the "a row never contains a bare ;"
    // invariant that decodePayload relies on.
    expect(() => parseExpr('p[p.city = "a;b"]')).toThrow(/separates rows/);
    expect(() => parseExpr('t = open("sales;2026.csv")')).toThrow(/separates rows/);
  });
});

describe('number theory', () => {
  const ev = (s: string) => evaluate(parseExpr(s), {});

  it('evaluates gcd', () => {
    expect(ev('gcd(12, 18)')).toBe(6);
    expect(ev('gcd(7, 3)')).toBe(1);
    expect(ev('gcd(0, 5)')).toBe(5);
  });

  it('evaluates isprime', () => {
    expect(ev('isprime(2)')).toBe(1);
    expect(ev('isprime(97)')).toBe(1);
    expect(ev('isprime(91)')).toBe(0);
    expect(ev('isprime(1)')).toBe(0);
    expect(ev('isprime(2.5)')).toBe(0);
    expect(ev(`isprime(${ISPRIME_MAX})`)).toBe(0); // 4194303 = 3 · 1398101
    expect(ev('isprime(4194301)')).toBe(1); // the largest prime it decides
  });

  it('bounds isprime instead of freezing the frame', () => {
    // Trial division past the limit costs seconds per call, in a path that
    // runs per frame; the answer is unknown rather than prime.
    expect(ev(`isprime(${ISPRIME_MAX + 1})`)).toBeNaN();
    const t0 = performance.now();
    expect(ev('isprime(9007199254740881)')).toBeNaN(); // a prime near 2^53
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it('compiles to prelude helpers', () => {
    expect(toGLSL(parseExpr('gcd(x, y)'))).toBe('eq_gcd(x, y)');
    expect(toGLSL(parseExpr('isprime(x)'))).toBe('eq_isprime(x)');
  });
});
