/**
 * Exact real-root finding for polynomial expressions.
 *
 * The result of root finding is a *multiset*: each root carries a
 * multiplicity, and the whole set is enumerated solidly — every real root is
 * found exactly once, none missed, none duplicated. Following the multiset
 * view (roots(f) = Σ k·roots(g_k) where f = ∏ g_k^k):
 *
 *  1. Expression coefficients become exact rationals (every finite double is
 *     a dyadic rational, so the conversion is lossless).
 *  2. Yun's square-free decomposition splits f into multiplicity classes g_k.
 *  3. Descartes' rule of signs + dyadic bisection isolates each real root of
 *     each (square-free) g_k in exact bigint arithmetic.
 *  4. Exact bisection narrows the isolating interval, then Newton on the
 *     square-free factor polishes to full double precision (Newton on f
 *     itself would stall at a multiple root; on g_k it stays quadratic).
 */
import { type Expr, evaluate, freeVars } from './expr.ts';

// --- exact rationals (bigint numerator / positive bigint denominator) ---

export interface Frac {
  n: bigint;
  d: bigint;
}

function bgcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

export function frac(n: bigint, d: bigint): Frac {
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = bgcd(n, d) || 1n;
  return { n: n / g, d: d / g };
}

const F0: Frac = { n: 0n, d: 1n };
const fadd = (a: Frac, b: Frac): Frac => frac(a.n * b.d + b.n * a.d, a.d * b.d);
const fmul = (a: Frac, b: Frac): Frac => frac(a.n * b.n, a.d * b.d);
const fneg = (a: Frac): Frac => ({ n: -a.n, d: a.d });
const fdiv = (a: Frac, b: Frac): Frac => frac(a.n * b.d, a.d * b.n);
const fIsZero = (a: Frac): boolean => a.n === 0n;

/** Exact rational value of a finite double (doubles are dyadic rationals). */
function fromNumber(v: number): Frac | null {
  if (!Number.isFinite(v)) return null;
  let e = 0;
  while (!Number.isInteger(v)) {
    v *= 2; // exact: scaling a double by 2 never rounds
    if (++e > 1100) return null;
  }
  return frac(BigInt(v), 1n << BigInt(e));
}

// --- polynomials as dense coefficient arrays, ascending degree ---

export type FPoly = Frac[];

function ftrim(p: FPoly): FPoly {
  let n = p.length;
  while (n > 0 && fIsZero(p[n - 1])) n--;
  return p.slice(0, n);
}

export function fpadd(a: FPoly, b: FPoly): FPoly {
  const out: FPoly = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) out.push(fadd(a[i] ?? F0, b[i] ?? F0));
  return ftrim(out);
}

export function fpscale(a: FPoly, s: Frac): FPoly {
  return ftrim(a.map(c => fmul(c, s)));
}

export function fpmul(a: FPoly, b: FPoly): FPoly {
  if (!a.length || !b.length) return [];
  const out: FPoly = Array.from({ length: a.length + b.length - 1 }, () => F0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) out[i + j] = fadd(out[i + j], fmul(a[i], b[j]));
  }
  return ftrim(out);
}

export function fpderiv(a: FPoly): FPoly {
  return ftrim(a.slice(1).map((c, i) => fmul(c, { n: BigInt(i + 1), d: 1n })));
}

/** Long division; returns quotient and remainder. b must be non-zero. */
export function fpdivmod(a: FPoly, b: FPoly): { q: FPoly; r: FPoly } {
  const q: FPoly = [];
  let r = a.slice();
  const db = b.length - 1;
  const lb = b[db];
  while (ftrim(r).length - 1 >= db && ftrim(r).length > 0) {
    r = ftrim(r);
    const dr = r.length - 1;
    const c = fdiv(r[dr], lb);
    q[dr - db] = c;
    for (let i = 0; i <= db; i++) r[dr - db + i] = fadd(r[dr - db + i], fneg(fmul(c, b[i])));
    r.length = dr; // leading term cancelled exactly
  }
  for (let i = 0; i < q.length; i++) q[i] = q[i] ?? F0;
  return { q: ftrim(q), r: ftrim(r) };
}

/** Division known to be exact (used inside Yun's algorithm). */
export function fpdivExact(a: FPoly, b: FPoly): FPoly {
  const { q, r } = fpdivmod(a, b);
  if (r.length) throw new Error('poly: inexact division');
  return q;
}

/** Clear denominators and divide by integer content → primitive ℤ[x]. */
export function primitive(p: FPoly): FPoly {
  if (!p.length) return [];
  let l = 1n;
  for (const c of p) l = (l / bgcd(l, c.d)) * c.d;
  const ints = p.map(c => c.n * (l / c.d));
  let g = 0n;
  for (const c of ints) g = bgcd(g, c);
  if (!g) return [];
  return ints.map(c => ({ n: c / g, d: 1n }));
}

/** Polynomial gcd via Euclid with primitive-part reduction (controls blowup). */
export function fpgcd(a: FPoly, b: FPoly): FPoly {
  let x = primitive(a);
  let y = primitive(b);
  if (x.length < y.length) [x, y] = [y, x];
  while (y.length) {
    const { r } = fpdivmod(x, y);
    x = y;
    y = primitive(r);
  }
  return x;
}

/**
 * Extended Euclid: g = gcd(a, b) with s·a + t·b = g (g as fpgcd computes it,
 * up to a rational scale absorbed into s and t). Exact Frac arithmetic, no
 * primitive-part shortcuts — the cofactors are the point (Hermite reduction
 * in integrate.ts solves A = s·D + t·D′ with them).
 */
export function fpextgcd(a: FPoly, b: FPoly): { g: FPoly; s: FPoly; t: FPoly } {
  let r0 = a.slice();
  let r1 = b.slice();
  let s0: FPoly = [{ n: 1n, d: 1n }];
  let s1: FPoly = [];
  let t0: FPoly = [];
  let t1: FPoly = [{ n: 1n, d: 1n }];
  while (r1.length) {
    const { q, r } = fpdivmod(r0, r1);
    [r0, r1] = [r1, r];
    [s0, s1] = [s1, fpadd(s0, fpscale(fpmul(q, s1), { n: -1n, d: 1n }))];
    [t0, t1] = [t1, fpadd(t0, fpscale(fpmul(q, t1), { n: -1n, d: 1n }))];
  }
  return { g: r0, s: s0, t: t0 };
}

// --- expression → polynomial coefficients ---

const MAX_DEGREE = 128;

/**
 * Bit budget for a single coefficient's numerator or denominator.
 *
 * Capping the degree alone does not bound the work: a decimal literal is a
 * dyadic rational with a ~55-bit numerator, so (0.1x - 0.3)^n carries ~55n
 * bits per coefficient while staying at degree n. Every Frac operation runs
 * a bigint gcd, whose cost is quadratic in the operand size, so the exact
 * path grows like the cube of the bit size — (0.1x - 0.3)^128 needs 7041-bit
 * coefficients and takes ~60 s, all of it inside a synchronous hover
 * handler. Bounding the bits bounds that cost directly.
 *
 * 512 bits is chosen so the bail itself is cheap (a few ms): the cost of
 * reaching the budget dominates, so the budget *is* the worst-case runtime
 * knob. It leaves a wide margin over every expression that benefits from the
 * exact path — (x+1)^128 peaks at 125 bits, Wilkinson-20 at 64, a degree-32
 * product of irrational quadratics at 54, and products of a handful of
 * decimal linear factors at ~220 — while ~9 decimal factors deep the exact
 * answer is already slower than it is worth. Over budget, exprToPoly returns
 * null and roots.ts falls back to numeric root finding, which still locates
 * every root, just without exact multiplicities or symbolic labels.
 */
const MAX_COEFF_BITS = 512;
const COEFF_LIMIT = 1n << BigInt(MAX_COEFF_BITS);

/** True once any coefficient of p has outgrown the bit budget. */
function overBudget(p: FPoly): boolean {
  for (const c of p) {
    if (c.d > COEFF_LIMIT) return true;
    if ((c.n < 0n ? -c.n : c.n) > COEFF_LIMIT) return true;
  }
  return false;
}

/**
 * Coefficients of e as a polynomial in v, or null if e is not a polynomial
 * (calls of v, division by v, fractional/negative powers, other free vars)
 * or if its coefficients exceed MAX_COEFF_BITS. Constant subexpressions
 * (sqrt(2), sin(3), pi…) evaluate to their exact double value.
 *
 * Every recursive call goes through here, so the budget check applies to
 * each intermediate result and a blowup is caught as soon as it appears.
 */
export function exprToPoly(e: Expr, v: string): FPoly | null {
  const p = polyIn(e, v);
  return p && overBudget(p) ? null : p;
}

function polyIn(e: Expr, v: string): FPoly | null {
  const vars = freeVars(e);
  if (!vars.has(v)) {
    if (vars.size) return null;
    let val: number;
    try {
      val = evaluate(e, {});
    } catch {
      return null;
    }
    const f = fromNumber(val);
    return f ? ftrim([f]) : null;
  }
  switch (e.kind) {
    case 'var':
      return e.name === v ? [F0, { n: 1n, d: 1n }] : null;
    case 'neg': {
      const a = exprToPoly(e.a, v);
      return a && fpscale(a, { n: -1n, d: 1n });
    }
    case 'bin': {
      if (e.op === '^') {
        if (e.b.kind !== 'num' || !Number.isInteger(e.b.value) || e.b.value < 0) return null;
        const a = exprToPoly(e.a, v);
        if (!a) return null;
        const n = e.b.value;
        if ((a.length - 1) * n > MAX_DEGREE) return null;
        let out: FPoly = [{ n: 1n, d: 1n }];
        for (let i = 0; i < n; i++) {
          out = fpmul(out, a);
          // One `^` node does all its work without returning, so the budget
          // has to be re-checked here rather than only on the way out.
          if (overBudget(out)) return null;
        }
        return out;
      }
      if (e.op === '/') {
        const b = exprToPoly(e.b, v);
        if (!b || b.length !== 1) return null; // divisor must be a non-zero constant
        const a = exprToPoly(e.a, v);
        return a && fpscale(a, fdiv({ n: 1n, d: 1n }, b[0]));
      }
      const a = exprToPoly(e.a, v);
      const b = exprToPoly(e.b, v);
      if (!a || !b) return null;
      if (e.op === '+') return fpadd(a, b);
      if (e.op === '-') return fpadd(a, fpscale(b, { n: -1n, d: 1n }));
      if (a.length - 1 + (b.length - 1) > MAX_DEGREE) return null;
      return fpmul(a, b);
    }
    case 'eq': {
      const l = exprToPoly(e.l, v);
      const r = exprToPoly(e.r, v);
      return l && r && fpadd(l, fpscale(r, { n: -1n, d: 1n }));
    }
    default:
      return null; // call with v inside, num (handled above), ineq, vec
  }
}

// --- Yun's square-free decomposition ---

/** f = ∏ out[j].p ^ out[j].mult with each p square-free and pairwise coprime. */
export function squareFree(f: FPoly): Array<{ p: FPoly; mult: number }> {
  const df = fpderiv(f);
  const g = fpgcd(f, df);
  if (g.length <= 1) return [{ p: f, mult: 1 }];
  const out: Array<{ p: FPoly; mult: number }> = [];
  let c = fpdivExact(f, g);
  let d = fpadd(fpdivExact(df, g), fpscale(fpderiv(c), { n: -1n, d: 1n }));
  for (let i = 1; c.length > 1; i++) {
    const a = fpgcd(c, d);
    if (a.length > 1) out.push({ p: a, mult: i });
    c = fpdivExact(c, a);
    d = fpadd(fpdivExact(d, a), fpscale(fpderiv(c), { n: -1n, d: 1n }));
  }
  return out;
}

// --- root isolation on ℤ[x] via Descartes' rule + dyadic bisection ---

type ZPoly = bigint[]; // dense, ascending, trimmed, p[0] ≠ 0 where required

const bsign = (x: bigint): number => (x > 0n ? 1 : x < 0n ? -1 : 0);

function signVariations(p: ZPoly): number {
  let v = 0;
  let last = 0;
  for (const c of p) {
    const s = bsign(c);
    if (!s) continue;
    if (last && s !== last) v++;
    last = s;
  }
  return v;
}

/** Taylor shift: p(x) → p(x+1), in place. */
function shift1(p: ZPoly): void {
  for (let i = 0; i < p.length - 1; i++) {
    for (let j = p.length - 2; j >= i; j--) p[j] += p[j + 1];
  }
}

/** Upper bound on the number of roots of p in the open interval (0, 1). */
function var01(p: ZPoly): number {
  const t = p.slice().reverse(); // x^n · p(1/x)
  shift1(t); // (x+1)^n · p(1/(x+1))
  return signVariations(t);
}

/** Divide out the content (gcd of coefficients) to keep numbers small. */
function zprimitive(p: ZPoly): ZPoly {
  let g = 0n;
  for (const c of p) g = bgcd(g, c);
  return g > 1n ? p.map(c => c / g) : p;
}

/** Divide p (with p(1) = 0) by (x - 1); exact synthetic division. */
function divByXMinus1(p: ZPoly): ZPoly {
  const out: ZPoly = new Array(p.length - 1);
  let acc = 0n;
  for (let i = p.length - 1; i >= 1; i--) {
    acc += p[i];
    out[i - 1] = acc;
  }
  return out;
}

interface Iso {
  /** Open isolating interval (a/2^k, (a+1)/2^k) in the unit-scaled domain. */
  a: bigint;
  k: number;
}

/**
 * Isolate the roots of square-free q in (0, 1). q(0) ≠ 0 and q(1) ≠ 0 are
 * invariants. Exact dyadic roots hit during splitting land in `exact`.
 */
function isolate01(q: ZPoly, out: Iso[], exact: Iso[], a = 0n, k = 0): void {
  const v = var01(q);
  if (v === 0) return;
  if (v === 1 || k > 96) {
    // v==1 → exactly one root. Depth cap: an unresolved cluster of nearly
    // coincident roots; report the interval once rather than looping.
    out.push({ a, k });
    return;
  }
  const n = q.length - 1;
  // Left child: L(x) = 2^n q(x/2) maps roots in (0, 1/2) to (0, 1).
  let L: ZPoly = q.map((c, i) => c << BigInt(n - i));
  L = zprimitive(L);
  const R = L.slice();
  shift1(R); // R(x) = L(x+1): roots of q in (1/2, 1) → (0, 1)
  let sum = 0n; // L(1) ∝ q(1/2)
  for (const c of L) sum += c;
  if (sum === 0n) exact.push({ a: 2n * a + 1n, k: k + 1 });
  isolate01(sum === 0n ? divByXMinus1(L) : L, out, exact, 2n * a, k + 1);
  isolate01(R[0] === 0n ? zprimitive(R.slice(1)) : zprimitive(R), out, exact, 2n * a + 1n, k + 1);
}

/** Sign of p at the dyadic rational n/2^e (exact bigint arithmetic). */
function signAtDyadic(p: ZPoly, n: bigint, e: number): number {
  const deg = p.length - 1;
  let acc = p[deg];
  for (let i = deg - 1; i >= 0; i--) acc = acc * n + (p[i] << BigInt(e * (deg - i)));
  return bsign(acc);
}

/** Evaluate p (as doubles, coefficients pre-normalized) and p' at x. */
function hornerBoth(pd: number[], x: number): [number, number] {
  let f = 0;
  let df = 0;
  for (let i = pd.length - 1; i >= 0; i--) {
    df = df * x + f;
    f = f * x + pd[i];
  }
  return [f, df];
}

/**
 * Exact division of f by (den·x − num), removing the known root num/den.
 * The cofactor is integral when gcd(num, den) = 1: the divisor is then
 * primitive, so by Gauss's lemma it divides the primitive f over ℤ.
 */
function deflateLinear(f: ZPoly, num: bigint, den: bigint): ZPoly {
  const n = f.length - 1;
  const s: ZPoly = new Array(n);
  let carry = f[n];
  for (let i = n; i >= 1; i--) {
    s[i - 1] = carry / den; // exact
    carry = f[i - 1] + num * s[i - 1];
  }
  return s;
}

/**
 * Refine one root of square-free q inside (a/2^k, (a+1)/2^k) ⊂ (0,1):
 * exact dyadic bisection until the interval is tight, then Newton in doubles
 * for the last digits. q must have no dyadic roots at the interval's
 * endpoints (exact roots are deflated out before refinement).
 */
function refine01(q: ZPoly, iso: Iso, qd: number[]): number {
  let e = iso.k;
  let lo = iso.a;
  let hi = iso.a + 1n;
  const sL = signAtDyadic(q, lo, e);
  // Bisect until the width is < ~2^-45 of the root's magnitude; Newton
  // recovers the remaining bits in doubles.
  while (e < 1070 && bitLength(lo) <= 45) {
    const mid = lo + hi; // the midpoint, at scale e+1
    const s = signAtDyadic(q, mid, e + 1);
    if (s === 0) return Number(mid) / 2 ** (e + 1);
    if (s === sL) {
      lo = mid;
      hi *= 2n;
    } else {
      hi = mid;
      lo *= 2n;
    }
    e++;
  }
  return polish(qd, Number(lo) / 2 ** e, Number(hi) / 2 ** e);
}

/** A few unclamped Newton steps from the interval midpoint, keeping the
 *  iterate with the smallest residual (near-double-root noise floors and
 *  1-ulp limit cycles both settle on the best representable value). */
function polish(qd: number[], lo: number, hi: number): number {
  let x = (lo + hi) / 2;
  let best = x;
  let bestAbs = Infinity;
  for (let i = 0; i < 10; i++) {
    const [f, df] = hornerBoth(qd, x);
    if (Math.abs(f) < bestAbs) {
      bestAbs = Math.abs(f);
      best = x;
    }
    if (f === 0 || df === 0) break;
    const nx = x - f / df;
    if (!isFinite(nx) || Math.abs(nx - x) > hi - lo || nx === x) break;
    x = nx;
  }
  return best;
}

function bitLength(x: bigint): number {
  return (x < 0n ? -x : x).toString(2).length;
}

/** All real roots of a square-free primitive integer polynomial. */
export function realRootsSquareFree(p: ZPoly): number[] {
  const roots: number[] = [];
  p = p.slice();
  while (p.length && p[0] === 0n) {
    p.shift();
    if (!roots.length) roots.push(0); // square-free ⇒ at most one zero root
  }
  if (p.length <= 1) return roots;
  const n = p.length - 1;
  // Power-of-two Cauchy bound: all real roots lie in (-2^m, 2^m).
  let m = 1;
  for (let i = 0; i < n; i++) m = Math.max(m, bitLength(p[i]) - bitLength(p[n]) + 2);
  for (const sign of [1, -1]) {
    // q(x) = p(±2^m · x) has the corresponding roots in (0, 1).
    let q: ZPoly = p.map((c, i) => (sign < 0 && i % 2 ? -c : c) << BigInt(i * m));
    q = zprimitive(q);
    const isos: Iso[] = [];
    const exact: Iso[] = [];
    isolate01(q, isos, exact);
    // Deflate exact dyadic roots out so no isolating interval of the
    // remaining roots has a root of q at an endpoint.
    for (const iso of exact) {
      roots.push(((sign * Number(iso.a)) / 2 ** iso.k) * 2 ** m);
      q = deflateLinear(q, iso.a, 1n << BigInt(iso.k));
    }
    const qd = toDoubles(q);
    for (const iso of isos) roots.push(sign * refine01(q, iso, qd) * 2 ** m);
  }
  roots.sort((a, b) => a - b);
  return roots;
}

/** Coefficients as doubles, scaled so the largest magnitude is 1. */
function toDoubles(p: ZPoly): number[] {
  let mx = 1;
  const raw = p.map(c => {
    const bl = bitLength(c);
    // Convert via a shifted mantissa to survive |c| > Number.MAX_VALUE.
    const shift = Math.max(0, bl - 60);
    return Number(c >> BigInt(shift)) * 2 ** shift;
  });
  for (const c of raw) mx = Math.max(mx, Math.abs(c));
  return raw.map(c => c / mx);
}

// --- symbolic labels for algebraic roots ---
//
// A root is exactly represented by (square-free integer factor, isolating
// interval); rendering "√2" instead of 1.4142… is a display question that
// bigint arithmetic settles exactly: rationals are verified by evaluating
// the factor at p/q, quadratics go through the quadratic formula with the
// square part of the discriminant extracted, and binomials a·x^n + c give
// n-th roots. Anything bigger has no radical form in general, so the label
// stays undefined and the caller shows the decimal.

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(bitLength(n) / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** n = t²·s with s square-free as far as trial division can tell. */
function squarePart(n: bigint): { t: bigint; s: bigint } {
  let t = 1n;
  let s = 1n;
  let rem = n;
  for (let d = 2n; d <= 10000n && d * d <= rem; d++) {
    let e = 0n;
    while (rem % d === 0n) {
      rem /= d;
      e++;
    }
    t *= d ** (e >> 1n);
    if (e & 1n) s *= d;
  }
  const r = isqrt(rem);
  if (r * r === rem) t *= r;
  else s *= rem;
  return { t, s };
}

/** Best rational approximation p/q of x with q ≤ maxDen (continued fraction). */
function ratApprox(x: number, maxDen: number): [bigint, bigint] | null {
  if (!isFinite(x) || Math.abs(x) > 1e15) return null;
  let p0 = 1n;
  let q0 = 0n;
  let p1 = BigInt(Math.floor(x));
  let q1 = 1n;
  let frac = x - Math.floor(x);
  for (let i = 0; i < 40 && frac > 1e-12; i++) {
    const v = 1 / frac;
    const a = Math.floor(v);
    if (!isFinite(a)) break;
    const p2 = BigInt(a) * p1 + p0;
    const q2 = BigInt(a) * q1 + q0;
    if (q2 > BigInt(maxDen)) break;
    p0 = p1;
    q0 = q1;
    p1 = p2;
    q1 = q2;
    frac = v - a;
  }
  return [p1, q1];
}

/** Exact test: is p/q (in lowest terms) a root of f? */
function isRationalRoot(f: ZPoly, p: bigint, q: bigint): boolean {
  const n = f.length - 1;
  let acc = 0n;
  let qp = 1n; // q^(n-i)
  for (let i = n; i >= 0; i--) {
    acc = acc * p + f[i] * qp;
    qp *= q;
  }
  return acc === 0n;
}

const SYM_LIMIT = 1000000n;

const fitsSym = (...xs: bigint[]): boolean => xs.every(x => (x < 0n ? -x : x) <= SYM_LIMIT);

function fmtRat(p: bigint, q: bigint): string | undefined {
  if (q === 1n) return undefined; // the decimal already shows integers
  if (!fitsSym(p, q)) return undefined;
  return `${p}/${q}`;
}

/** Render (p + q√s)/r reduced; undefined when the numbers get ugly. */
function fmtQuadVal(p: bigint, q: bigint, r: bigint, s: bigint): string | undefined {
  if (r < 0n) {
    p = -p;
    q = -q;
    r = -r;
  }
  const g = bgcd(bgcd(p, q), r);
  if (g > 1n) {
    p /= g;
    q /= g;
    r /= g;
  }
  if (!fitsSym(p, q, r, s)) return undefined;
  const rootTerm = `${q === 1n ? '' : q === -1n ? '-' : q}√${s}`;
  if (p === 0n) return r === 1n ? rootTerm : `${rootTerm}/${r}`;
  const base = `${p}${q < 0n ? '-' : '+'}${q === 1n || q === -1n ? '' : q < 0n ? -q : q}√${s}`;
  return r === 1n ? base : `(${base})/${r}`;
}

/** The two values and labels of a real quadratic a·x² + b·x + c (D > 0). */
function solveQuadratic(f: ZPoly): Array<{ val: number; sym: string | undefined }> {
  const [c, b, a] = f;
  const D = b * b - 4n * a * c;
  if (D <= 0n) return [];
  const { t, s } = squarePart(D);
  const sqrtD = Number(t) * Math.sqrt(Number(s));
  const out = [];
  for (const sign of [-1n, 1n]) {
    const val = (Number(-b) + Number(sign) * sqrtD) / Number(2n * a);
    out.push({ val, sym: s === 1n ? fmtRat(...ratNorm(-b + sign * t, 2n * a)) : fmtQuadVal(-b, sign * t, 2n * a, s) });
  }
  return out;
}

function ratNorm(p: bigint, q: bigint): [bigint, bigint] {
  if (q < 0n) {
    p = -p;
    q = -q;
  }
  const g = bgcd(p, q) || 1n;
  return [p / g, q / g];
}

/** Label for the real n-th roots of a binomial a·x^n + c (n ≥ 3). */
function solveBinomial(f: ZPoly): Array<{ val: number; sym: string | undefined }> {
  let n = f.length - 1;
  let [p, q] = ratNorm(-f[0], f[n]); // radicand p/q, roots ±(p/q)^(1/n)
  const negOdd = n % 2 === 1 && p < 0n;
  if (negOdd) p = -p;
  if (p <= 0n) return []; // even n with non-positive radicand: no real roots
  // ⁿ√ of a perfect square halves the index: ∜4 = √2.
  for (;;) {
    const rp = isqrt(p);
    const rq = isqrt(q);
    if (n % 2 === 0 && n > 2 && rp * rp === p && rq * rq === q) {
      p = rp;
      q = rq;
      n /= 2;
    } else break;
  }
  const val = (Number(p) / Number(q)) ** (1 / n);
  let sym: string | undefined;
  if (n === 2) {
    // √(p/q) = √(pq)/q, with the square part of pq pulled out.
    const { t, s } = squarePart(p * q);
    sym = s === 1n ? fmtRat(...ratNorm(t, q)) : fmtQuadVal(0n, t, q, s);
  } else if (fitsSym(p, q)) {
    const rad = q === 1n ? `${p}` : `(${p}/${q})`;
    sym = n === 3 ? `∛${rad}` : n === 4 ? `∜${rad}` : `${rad}^(1/${n})`;
  }
  if (n % 2 === 1) return [{ val: negOdd ? -val : val, sym: sym && (negOdd ? `-${sym}` : sym) }];
  return [
    { val: -val, sym: sym && `-${sym}` },
    { val, sym },
  ];
}

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
};

/** Render an integer polynomial like "x⁷ - x - 2"; undefined if unwieldy. */
function fmtPoly(f: ZPoly): string | undefined {
  if (f.length - 1 > 16) return undefined;
  if (f[f.length - 1] < 0n) f = f.map(c => -c); // leading coefficient positive
  const parts: string[] = [];
  for (let i = f.length - 1; i >= 0; i--) {
    const c = f[i];
    if (c === 0n) continue;
    if (!fitsSym(c)) return undefined;
    const mag = c < 0n ? -c : c;
    const coeff = i > 0 && mag === 1n ? '' : `${mag}`;
    const xPow = i === 0 ? '' : i === 1 ? 'x' : `x${String(i).replace(/\d/g, d => SUPERSCRIPT[d])}`;
    parts.push(parts.length === 0 ? `${c < 0n ? '-' : ''}${coeff}${xPow}` : `${c < 0n ? '- ' : '+ '}${coeff}${xPow}`);
  }
  const s = parts.join(' ');
  return s.length <= 48 ? s : undefined;
}

export interface RootLabel {
  /** Radical/rational form ("√2", "(1+√5)/2") when one exists. */
  sym?: string;
  /** Defining polynomial ("x⁷ - x - 2") when no radical form exists. */
  rootOf?: string;
}

/**
 * Symbolic labels ("√2", "1/3", "(1+√5)/2", "∛2") for the roots of a
 * square-free primitive factor, where a radical form exists and stays
 * readable. Roots beyond radicals (unsolvable Galois groups) instead get
 * their defining polynomial; entries with neither fall back to decimals.
 */
function labelRoots(f: ZPoly, roots: number[]): RootLabel[] {
  const out: RootLabel[] = Array.from({ length: roots.length }, () => ({}));
  if (!roots.length) return out;
  let rem = f.slice();
  while (rem.length > 1 && rem[0] === 0n) rem = rem.slice(1); // drop the x = 0 root
  const unlabeled = new Set<number>();
  for (let i = 0; i < roots.length; i++) {
    if (roots[i] === 0) continue;
    const cand = ratApprox(roots[i], 1000000);
    if (
      cand &&
      cand[1] > 0n &&
      Math.abs(roots[i] - Number(cand[0]) / Number(cand[1])) <= 1e-8 * Math.max(1, Math.abs(roots[i])) &&
      rem.length > 1 &&
      isRationalRoot(rem, ...cand)
    ) {
      out[i].sym = fmtRat(...cand);
      rem = deflateLinear(rem, cand[0], cand[1]);
    } else {
      unlabeled.add(i);
    }
  }
  let sols: Array<{ val: number; sym: string | undefined }> = [];
  const remDeg = rem.length - 1;
  const isBinomial = remDeg >= 3 && rem.slice(1, -1).every(c => c === 0n);
  if (remDeg === 2) sols = solveQuadratic(rem);
  else if (isBinomial) sols = solveBinomial(rem);
  for (const sol of sols) {
    let bestI = -1;
    for (const i of unlabeled) {
      if (bestI < 0 || Math.abs(roots[i] - sol.val) < Math.abs(roots[bestI] - sol.val)) bestI = i;
    }
    if (bestI >= 0 && Math.abs(roots[bestI] - sol.val) <= 1e-6 * Math.max(1, Math.abs(sol.val))) {
      out[bestI].sym = sol.sym;
      unlabeled.delete(bestI);
    }
  }
  // No radical form (generic Galois groups above degree 4 are unsolvable):
  // the defining polynomial IS the exact representation, so show that.
  if (remDeg >= 3 && !isBinomial) {
    const rootOf = fmtPoly(rem);
    if (rootOf) for (const i of unlabeled) out[i].rootOf = rootOf;
  }
  return out;
}

// --- public API ---

export interface PolyRoot {
  x: number;
  mult: number;
  /** Exact symbolic form ("√2", "1/3", "(1+√5)/2", "∛2") when one exists. */
  sym?: string;
  /** Defining polynomial ("x⁷ - x - 2") when no radical form exists. */
  rootOf?: string;
}

/**
 * The multiset of real roots of e viewed as a polynomial in v, sorted by x.
 * Returns null when e is not a polynomial in v, and 'zero' when e is
 * identically zero (every point is a root).
 */
export function polynomialRoots(e: Expr, v: string): PolyRoot[] | null | 'zero' {
  const p = exprToPoly(e, v);
  if (!p) return null;
  if (!p.length) return 'zero';
  if (p.length === 1) return [];
  if (p.length - 1 > MAX_DEGREE) return null;
  const out: PolyRoot[] = [];
  for (const { p: factor, mult } of squareFree(primitive(p))) {
    const zp = factor.map(c => c.n); // primitive parts have denominator 1
    const roots = realRootsSquareFree(zp);
    const labels = labelRoots(zp, roots);
    roots.forEach((x, i) => out.push({ x, mult, sym: labels[i].sym, rootOf: labels[i].rootOf }));
  }
  out.sort((a, b) => a.x - b.x);
  return out;
}

export interface ComplexRootLabel {
  re: number;
  im: number;
  label: string;
}
/** Rational linear and quadratic factors, with exact division checking every
 * candidate. Factoring work is bounded; a remaining factor keeps its exact
 * defining-polynomial label instead of inventing a radical approximation. */
export function complexRootLabels(e: Expr): { roots: ComplexRootLabel[]; rootOf?: string } | null {
  const p = exprToPoly(e, 'w');
  if (!p || p.length < 2 || p.length > 17) return null;
  const roots: ComplexRootLabel[] = [];
  const rationalLabel = (p: bigint, q: bigint) => {
    const [a, b] = ratNorm(p, q);
    return b === 1n ? String(a) : fmtRat(a, b);
  };
  const real = polynomialRoots(e, 'w');
  if (real && real !== 'zero')
    for (const r of real)
      if (
        r.sym ||
        (Number.isInteger(r.x) &&
          isRationalRoot(
            primitive(p).map(c => c.n),
            BigInt(r.x),
            1n,
          ))
      )
        roots.push({ re: r.x, im: 0, label: r.sym ?? String(r.x) });
  let budget = 16000;
  const divisors = (v: bigint): bigint[] => {
    v = v < 0n ? -v : v;
    if (v > 10000n || !v) return [];
    const out: bigint[] = [];
    for (let k = 1n; k * k <= v; k++)
      if (v % k === 0n) {
        out.push(k);
        if (k * k !== v) out.push(v / k);
      }
    return out;
  };
  const quadratic = (f: ZPoly) => {
    const [c, b, a] = f,
      disc = b * b - 4n * a * c;
    if (disc >= 0n) return;
    const { t, s } = squarePart(-disc);
    const re = Number(-b) / Number(2n * a),
      im = Math.abs((Number(t) * Math.sqrt(Number(s))) / Number(2n * a));
    const reLabel = rationalLabel(-b, 2n * a);
    const imag = s === 1n ? rationalLabel(t, 2n * (a < 0n ? -a : a)) : fmtQuadVal(0n, t, 2n * (a < 0n ? -a : a), s);
    if (!imag || (b !== 0n && !reLabel)) return;
    for (const sign of [-1, 1]) {
      const part = imag === '1' ? 'i' : `${imag} i`;
      roots.push({
        re,
        im: sign * im,
        label: b === 0n ? (sign < 0 ? '-' : '') + part : `${reLabel} ${sign < 0 ? '−' : '+'} ${part}`,
      });
    }
  };
  for (const { p: factor } of squareFree(primitive(p))) {
    let rem = factor;
    while (rem.length > 1 && rem[0].n === 0n) {
      roots.push({ re: 0, im: 0, label: '0' });
      rem = rem.slice(1);
    }
    // Remove rational real factors before looking for quadratic factors.
    const rs = realRootsSquareFree(primitive(rem).map(c => c.n));
    for (const root of rs) {
      const rat = ratApprox(root, 1000000);
      if (!rat || rem.length < 2) continue;
      const divisor = [
        { n: -rat[0], d: 1n },
        { n: rat[1], d: 1n },
      ];
      const qr = fpdivmod(rem, divisor);
      if (!qr.r.length) rem = primitive(qr.q);
    }
    while (rem.length > 3 && budget > 0) {
      let found = false;
      const z = primitive(rem).map(c => c.n);
      search: for (const a of divisors(z[z.length - 1]))
        for (const c0 of divisors(z[0]))
          for (const sign of [-1n, 1n])
            for (let b = -32n; b <= 32n; b++) {
              if (--budget <= 0) break search;
              const f = [sign * c0, b, a];
              const qr = fpdivmod(
                rem,
                f.map(n => ({ n, d: 1n })),
              );
              if (!qr.r.length) {
                quadratic(f);
                rem = primitive(qr.q);
                found = true;
                break search;
              }
            }
      if (!found) break;
    }
    if (rem.length === 3) quadratic(primitive(rem).map(c => c.n));
  }
  return { roots, rootOf: fmtPoly(primitive(p).map(c => c.n))?.replaceAll('x', 'w') };
}
