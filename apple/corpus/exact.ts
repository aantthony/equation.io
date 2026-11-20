/**
 * Records what JavaScript's BigInt and lib/poly.ts answer, as the fixture the
 * Swift port's exact arithmetic is held to (ExactConformanceTests.swift):
 * BigInt.swift is the port's own big integer, and Poly.swift is lib/poly.ts
 * on top of it.
 *
 *   pnpm swift:exact-corpus
 *
 * Integers travel as decimal text, doubles as text too (see diff.ts).
 */
import { writeFileSync } from 'node:fs';
import { type Expr, parseExpr } from '../../lib/expr.ts';
import {
  type FPoly,
  complexRootLabels,
  exprToPoly,
  fpdivmod,
  fpextgcd,
  fpgcd,
  frac,
  polynomialRoots,
  primitive,
  realRootsSquareFree,
  squareFree,
} from '../../lib/poly.ts';
import { findRoots } from '../../lib/roots.ts';

const fixtures = new URL('../EquationCore/Tests/EquationCoreTests/Fixtures/', import.meta.url);

const replacer = (key: string, value: unknown): unknown => {
  if (key === 'axes' || key === 'origin') return undefined;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
  return value;
};

// A seeded generator (mulberry32): the corpus is the same on every run.
let seed = 0x1234abcd;
const random = (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
  return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
};
const randomBig = (bits: number): bigint => {
  let x = 0n;
  for (let i = 0; i < bits; i += 16) x = (x << 16n) | BigInt(Math.floor(random() * 65536));
  x &= (1n << BigInt(bits)) - 1n;
  return random() < 0.5 ? -x : x;
};

// --- BigInt ---

// Limb edges (the port keeps 32-bit limbs), carries and borrows across them,
// and the operands Knuth's division corrects its estimate on.
const edges: bigint[] = [0n, 1n, -1n, 2n, -2n, 3n, 10n, -10n, 255n, 1000000007n];
for (const k of [31n, 32n, 33n, 63n, 64n, 65n, 96n, 127n, 128n, 512n, 1024n]) {
  for (const d of [-1n, 0n, 1n]) edges.push((1n << k) + d, -((1n << k) + d));
}
edges.push(0xffffffffffffffffffffffffn, 0x800000000000000000000000n, 0x7fffffff_ffffffff_00000000n);
edges.push(0x80000000_00000000_00000001n, 0xffffffff_00000000_ffffffffn, 10n ** 40n, -(10n ** 40n) + 1n);
const operands = [...edges];
for (const bits of [8, 20, 31, 32, 33, 53, 64, 70, 100, 128, 200, 333, 512, 1000, 2100]) {
  for (let i = 0; i < 6; i++) operands.push(randomBig(bits));
}

const isqrt = (n: bigint): bigint => {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
};

const unary = operands.map(a => ({
  a,
  neg: -a,
  number: Number(a),
  bits: (a < 0n ? -a : a).toString(2).length,
  shl: [0, 1, 31, 32, 33, 64, 100].map(k => [k, a << BigInt(k)]),
  shr: [0, 1, 31, 32, 33, 64, 100].map(k => [k, a >> BigInt(k)]),
  pow: [0, 1, 2, 3, 7].map(k => [k, a ** BigInt(k)]),
  isqrt: a >= 0n ? isqrt(a) : null,
  odd: (a & 1n) === 1n,
}));

const pairs: [bigint, bigint][] = [];
for (const a of edges) for (const b of edges) pairs.push([a, b]);
for (let i = 0; i < 1500; i++) {
  const a = operands[Math.floor(random() * operands.length)];
  const b = operands[Math.floor(random() * operands.length)];
  pairs.push([a, b]);
}
// Dividends just under and over a multiple of the divisor: the quotient
// estimate's corrections.
for (let i = 0; i < 300; i++) {
  const b = randomBig(40 + Math.floor(random() * 300));
  const q = randomBig(10 + Math.floor(random() * 300));
  if (b === 0n) continue;
  for (const d of [-1n, 0n, 1n]) pairs.push([b * q + d, b]);
}
const binary = pairs.map(([a, b]) => {
  const reduced = b === 0n ? null : frac(a, b);
  return {
    a,
    b,
    add: a + b,
    sub: a - b,
    mul: a * b,
    div: b === 0n ? null : a / b,
    mod: b === 0n ? null : a % b,
    cmp: a < b ? -1 : a > b ? 1 : 0,
    frac: reduced && [reduced.n, reduced.d],
  };
});

// Number(x) at the rounding edges: halfway cases round to even.
const rounding: bigint[] = [];
for (const k of [53n, 54n, 55n, 64n, 65n, 100n, 1023n, 1024n, 1100n]) {
  for (const d of [-3n, -2n, -1n, 0n, 1n, 2n, 3n]) {
    rounding.push((1n << k) + d, (1n << k) + (1n << (k - 53n)) + d, (3n << (k - 1n)) + (1n << (k - 54n)) + d);
  }
}
const numbers = rounding.flatMap(a => [a, -a]).map(a => ({ a, number: Number(a) }));

// BigInt(v) of whole doubles.
const wholes = [0, 1, -1, 2 ** 31, 2 ** 32, 2 ** 53, 2 ** 53 + 2, -(2 ** 64), 1e15, 1e21, 1e22, 1e100, 1.7976931348623157e308];
for (let i = 0; i < 40; i++) wholes.push(Math.round((random() - 0.5) * 2 ** (10 + Math.floor(random() * 200))));
const fromDouble = wholes.map(v => ({ v, big: BigInt(v) }));

// --- polynomials ---

const fp = (p: FPoly): string[] => p.map(c => `${c.n}/${c.d}`);

const polySources = [
  // lib/poly.test.ts and lib/roots.test.ts
  'x^2 - 2',
  'x^2 - 1',
  'x^2',
  'x^2 + 1',
  '(x - 1)^3 (x + 2)^2',
  'x^3 - 2x + 1',
  'x^3 - 6x^2 + 11x - 6',
  '(x - 1)(x - 2)(x - 3)(x - 4)(x - 5)(x - 6)(x - 7)(x - 8)(x - 9)(x - 10)',
  '(x-1)(x-2)(x-3)(x-4)(x-5)(x-6)(x-7)(x-8)(x-9)(x-10)(x-11)(x-12)(x-13)(x-14)(x-15)(x-16)(x-17)(x-18)(x-19)(x-20)',
  'x^7 - x - 2',
  'x^5 - x - 1',
  'x^5 - 5x + 12',
  'x^2 - x - 1',
  '3x - 1',
  '6x^2 - 5x + 1',
  'x^3 - 2',
  'x^4 - 4',
  'x^4 - 2',
  'x^4 + 4',
  '2x^3 + 54',
  '8x^3 - 27',
  'x^6 - 8',
  'x^5 + 3',
  '9x^4 - 4',
  'x^2 - 12',
  '4x^2 - 12x + 7',
  '2x^2 + 3x - 7',
  'x^2 - 1000003',
  'x^2 - 2000000000000',
  '(x^2 - 2)(x^2 - 3)',
  '(x^2 - 2)^2 (3x - 1)',
  '(x^2 - 2)(x - 1/3)(x + 5/7)',
  'x (x^2 - 5)',
  'x^3 (x - 1)',
  '0.1 x - 0.3',
  '(0.1x - 0.3)^3',
  '(0.1x - 0.3)^9',
  '(0.1x - 0.3)^16',
  '(x + 1)^128',
  '(x + 1)^129',
  '(x - 0.1)^32 (x - 0.3)^32',
  'x^2 - 2x + 1',
  'x^2 - 2.0000001x + 1',
  'x^2 + 2x + 1.0000001',
  '(x - 1e-8)(x + 1e-8)',
  '(x - 1e8)(x - 1e8 - 1)',
  '(x - 123456789)(x + 987654321)',
  'x^2 - 1e-300',
  'x^2 - 1e300',
  '1e200 x^2 - 1e-200',
  'x^10 - 1',
  'x^11 - 1',
  'x^16 - 3x^8 + 1',
  'x^17 - 1',
  'x^3 - 3x + 1',
  'x^4 - 10x^2 + 1',
  'x^4 - x^3 - x^2 - x - 1',
  'x^8 - 40 x^6 + 352 x^4 - 960 x^2 + 576',
  'x^2/3 - x/7 - 1/2',
  '(x - 2)/5',
  'x/0',
  'x^2 = 2',
  'x^3 = x',
  '2 x = 4 x - 6',
  'x - x',
  '0 x',
  '5',
  'x^2.5',
  'x^(-1)',
  '1/x',
  'sin(x)',
  'sqrt(2) x^2 - 3',
  'sin(3) x - cos(2)',
  'a x + 1',
  'pi x - 1',
  'x^2 + x y',
  '-(x - 4)^2',
  '-x^2 + 3',
  '(2x - 1)^2 (3x + 2)^3 (x^2 + 1)',
  '1024 x^5 - 1',
  'x^3 + x^2 - 2 x - 1',
  '(x^2 + x + 1)(x^2 - x + 1)(x - 5)',
  '(x^2 + 2x + 5)(x^2 - 4x + 13)',
  '(2x^2 + 2x + 1)(x^2 + 9)',
  '(x^2 + x + 1)^2',
  'x^4 + x^2 + 1',
  'x^4 + 1',
  'x^6 + 1',
  'x^2 + 3',
  '4x^2 + 4x + 5',
  'x^3 - 1',
  'x^5 - x^4 + x^3 - x^2 + x - 1',
];
const parsed = (src: string): Expr => parseExpr(src);
const polys = polySources.map(src => {
  const e = parsed(src);
  const p = exprToPoly(e, 'x');
  const roots = polynomialRoots(e, 'x');
  let factors: unknown = null;
  let real: unknown = null;
  if (p && p.length > 1) {
    const sf = squareFree(primitive(p));
    factors = sf.map(f => ({ p: fp(f.p), mult: f.mult }));
    real = sf.map(f => realRootsSquareFree(f.p.map(c => c.n)));
  }
  const w = parsed(src.replaceAll('x', 'w'));
  const complex = complexRootLabels(w);
  return {
    src,
    e,
    w,
    poly: p && fp(p),
    primitive: p && fp(primitive(p)),
    factors,
    real,
    roots: roots === 'zero' ? 'zero' : roots && roots.map(r => ({ ...r, sym: r.sym ?? null, rootOf: r.rootOf ?? null })),
    complex: complex && { roots: complex.roots, rootOf: complex.rootOf ?? null },
  };
});

// Division, gcd and the extended gcd, over pairs of the polynomials above.
const numeric = polys.map(p => exprToPoly(p.e, 'x')).filter((p): p is FPoly => !!p && p.length > 0);
const polyPairs: unknown[] = [];
for (let i = 0; i < numeric.length; i++) {
  for (const j of [i, (i * 7 + 3) % numeric.length, (i * 13 + 5) % numeric.length]) {
    const [a, b] = [numeric[i], numeric[j]];
    // (Small coefficients: the cofactors of an extended gcd grow fast, and the port's integers are slower.)
    const small = (p: FPoly): boolean => p.length <= 12 && p.every(c => c.n < 1n << 64n && c.n > -(1n << 64n) && c.d < 1n << 64n);
    if (!small(a) || !small(b)) continue;
    const { q, r } = fpdivmod(a, b);
    const ext = fpextgcd(a, b);
    polyPairs.push({
      a: fp(a),
      b: fp(b),
      q: fp(q),
      r: fp(r),
      gcd: fp(fpgcd(a, b)),
      ext: { g: fp(ext.g), s: fp(ext.s), t: fp(ext.t) },
    });
  }
}

// findRoots, where the polynomial path answers (lib/roots.ts).
const rootCases: [src: string, lo: number, hi: number][] = [
  ['x^2 - 2', -10, 10],
  ['x^2 - 2', 0, 10],
  ['x^2 - 2', 2, 10],
  ['(x - 1)^3 (x + 2)^2', -10, 10],
  ['x - x', -1, 1],
  ['x^5 - x - 1', -3, 3],
  ['x^3 - 6x^2 + 11x - 6', 1, 3],
  ['x^2 + 1', -5, 5],
  ['(0.1x - 0.3)^16', -10, 10],
];
const found = rootCases.map(([src, lo, hi]) => {
  const result = findRoots(parsed(src), 'x', lo, hi);
  return {
    src,
    f: parsed(src),
    lo,
    hi,
    result: result === 'zero' ? 'zero' : result.map(r => ({ ...r, sym: r.sym ?? null, rootOf: r.rootOf ?? null })),
  };
});

const fixture = { unary, binary, numbers, fromDouble, polys, polyPairs, found };
writeFileSync(new URL('exact-corpus.json', fixtures), JSON.stringify(fixture, replacer) + '\n');
console.log(
  `${unary.length} integers, ${binary.length} pairs, ${numbers.length} roundings, ${polys.length} polynomials, ` +
    `${polyPairs.length} polynomial pairs → exact-corpus.json`,
);
