/// Exact real-root finding for polynomial expressions (lib/poly.ts).
///
/// The result of root finding is a *multiset*: each root carries a
/// multiplicity, and the whole set is enumerated solidly — every real root is
/// found exactly once, none missed, none duplicated. Following the multiset
/// view (roots(f) = Σ k·roots(g_k) where f = ∏ g_k^k):
///
///  1. Expression coefficients become exact rationals (every finite double is
///     a dyadic rational, so the conversion is lossless).
///  2. Yun's square-free decomposition splits f into multiplicity classes g_k.
///  3. Descartes' rule of signs + dyadic bisection isolates each real root of
///     each (square-free) g_k in exact integer arithmetic (BigInt.swift).
///  4. Exact bisection narrows the isolating interval, then Newton on the
///     square-free factor polishes to full double precision (Newton on f
///     itself would stall at a multiple root; on g_k it stays quadratic).

// MARK: - Exact rationals (numerator / positive denominator)

struct Frac: Equatable, Sendable {
  var n: BigInt
  var d: BigInt
}

func frac(_ n: BigInt, _ d: BigInt) -> Frac {
  var (n, d) = (n, d)
  if d.signum < 0 {
    n = -n
    d = -d
  }
  var g = bgcd(n, d)
  if g.isZero { g = .one }
  return Frac(n: n / g, d: d / g)
}

private let F0 = Frac(n: .zero, d: .one)
private let F1 = Frac(n: .one, d: .one)
private let FMinus1 = Frac(n: BigInt(-1), d: .one)
private func fadd(_ a: Frac, _ b: Frac) -> Frac { frac(a.n * b.d + b.n * a.d, a.d * b.d) }
func fmul(_ a: Frac, _ b: Frac) -> Frac { frac(a.n * b.n, a.d * b.d) }
private func fneg(_ a: Frac) -> Frac { Frac(n: -a.n, d: a.d) }
private func fdiv(_ a: Frac, _ b: Frac) -> Frac { frac(a.n * b.d, a.d * b.n) }

/// 2^k as a double (JavaScript's `2 ** k`): exact, ∞ past the largest.
func pow2(_ k: Int) -> Double { Double(sign: .plus, exponent: k, significand: 1) }

/// Exact rational value of a finite double (doubles are dyadic rationals).
private func fromNumber(_ value: Double) -> Frac? {
  if !value.isFinite { return nil }
  var v = value
  var e = 0
  while !JS.isInteger(v) {
    v *= 2  // exact: scaling a double by 2 never rounds
    e += 1
    if e > 1100 { return nil }
  }
  return frac(BigInt(exactly: v)!, BigInt.one << e)
}

// MARK: - Polynomials as dense coefficient arrays, ascending degree

typealias FPoly = [Frac]

private func ftrim(_ p: FPoly) -> FPoly {
  var n = p.count
  while n > 0 && p[n - 1].n.isZero { n -= 1 }
  return Array(p[0..<n])
}

func fpadd(_ a: FPoly, _ b: FPoly) -> FPoly {
  var out: FPoly = []
  for i in 0..<max(a.count, b.count) { out.append(fadd(i < a.count ? a[i] : F0, i < b.count ? b[i] : F0)) }
  return ftrim(out)
}

func fpscale(_ a: FPoly, _ s: Frac) -> FPoly { ftrim(a.map { fmul($0, s) }) }

func fpmul(_ a: FPoly, _ b: FPoly) -> FPoly {
  if a.isEmpty || b.isEmpty { return [] }
  var out = FPoly(repeating: F0, count: a.count + b.count - 1)
  for i in 0..<a.count {
    for j in 0..<b.count { out[i + j] = fadd(out[i + j], fmul(a[i], b[j])) }
  }
  return ftrim(out)
}

func fpderiv(_ a: FPoly) -> FPoly {
  ftrim(a.dropFirst().enumerated().map { i, c in fmul(c, Frac(n: BigInt(i + 1), d: .one)) })
}

/// Long division; returns quotient and remainder. b must be non-zero.
func fpdivmod(_ a: FPoly, _ b: FPoly) -> (q: FPoly, r: FPoly) {
  var q: FPoly = []
  var r = a
  let db = b.count - 1
  let lb = b[db]
  while true {
    r = ftrim(r)
    if r.isEmpty || r.count - 1 < db { break }
    let dr = r.count - 1
    let c = fdiv(r[dr], lb)
    // (The first quotient term is the highest: the array is its length from then on.)
    if q.count < dr - db + 1 { q += FPoly(repeating: F0, count: dr - db + 1 - q.count) }
    q[dr - db] = c
    for i in 0...db { r[dr - db + i] = fadd(r[dr - db + i], fneg(fmul(c, b[i]))) }
    r.removeLast()  // leading term cancelled exactly
  }
  return (ftrim(q), ftrim(r))
}

/// What `fpdivExact` throws when the division leaves a remainder.
struct InexactDivision: Error {}

/// Division known to be exact (used inside Yun's algorithm).
func fpdivExact(_ a: FPoly, _ b: FPoly) throws(InexactDivision) -> FPoly {
  let (q, r) = fpdivmod(a, b)
  if !r.isEmpty { throw InexactDivision() }
  return q
}

/// Clear denominators and divide by integer content → primitive ℤ[x].
func primitive(_ p: FPoly) -> FPoly {
  if p.isEmpty { return [] }
  var l = BigInt.one
  for c in p { l = (l / bgcd(l, c.d)) * c.d }
  let ints = p.map { $0.n * (l / $0.d) }
  var g = BigInt.zero
  for c in ints { g = bgcd(g, c) }
  if g.isZero { return [] }
  return ints.map { Frac(n: $0 / g, d: .one) }
}

/// Polynomial gcd via Euclid with primitive-part reduction (controls blowup).
func fpgcd(_ a: FPoly, _ b: FPoly) -> FPoly {
  var x = primitive(a)
  var y = primitive(b)
  if x.count < y.count { swap(&x, &y) }
  while !y.isEmpty {
    let r = fpdivmod(x, y).r
    x = y
    y = primitive(r)
  }
  return x
}

/// Extended Euclid: g = gcd(a, b) with s·a + t·b = g (g as fpgcd computes it,
/// up to a rational scale absorbed into s and t). Exact Frac arithmetic, no
/// primitive-part shortcuts — the cofactors are the point.
func fpextgcd(_ a: FPoly, _ b: FPoly) -> (g: FPoly, s: FPoly, t: FPoly) {
  var (r0, r1) = (a, b)
  var (s0, s1): (FPoly, FPoly) = ([F1], [])
  var (t0, t1): (FPoly, FPoly) = ([], [F1])
  while !r1.isEmpty {
    let (q, r) = fpdivmod(r0, r1)
    (r0, r1) = (r1, r)
    (s0, s1) = (s1, fpadd(s0, fpscale(fpmul(q, s1), FMinus1)))
    (t0, t1) = (t1, fpadd(t0, fpscale(fpmul(q, t1), FMinus1)))
  }
  return (r0, s0, t0)
}

// MARK: - Expression → polynomial coefficients

private let MAX_DEGREE = 128

/// Bit budget for a single coefficient's numerator or denominator.
///
/// Capping the degree alone does not bound the work: a decimal literal is a
/// dyadic rational with a ~55-bit numerator, so (0.1x - 0.3)^n carries ~55n
/// bits per coefficient while staying at degree n. Every Frac operation runs
/// a gcd, whose cost is quadratic in the operand size, so the exact path
/// grows like the cube of the bit size. Bounding the bits bounds that cost
/// directly. Over budget, exprToPoly returns nil and root finding falls back
/// to the numeric path, which still locates every root, just without exact
/// multiplicities or symbolic labels.
private let MAX_COEFF_BITS = 512
private let COEFF_LIMIT = BigInt.one << MAX_COEFF_BITS

/// True once any coefficient of p has outgrown the bit budget.
private func overBudget(_ p: FPoly) -> Bool {
  for c in p {
    if c.d > COEFF_LIMIT { return true }
    if c.n.magnitude > COEFF_LIMIT { return true }
  }
  return false
}

/// Coefficients of e as a polynomial in v, or nil if e is not a polynomial
/// (calls of v, division by v, fractional/negative powers, other free vars)
/// or if its coefficients exceed MAX_COEFF_BITS. Constant subexpressions
/// (sqrt(2), sin(3)…) evaluate to their exact double value.
///
/// Every recursive call goes through here, so the budget check applies to
/// each intermediate result and a blowup is caught as soon as it appears.
func exprToPoly(_ e: Expr, _ v: String) -> FPoly? {
  guard let p = polyIn(e, v) else { return nil }
  return overBudget(p) ? nil : p
}

private func polyIn(_ e: Expr, _ v: String) -> FPoly? {
  let vars = freeVars(e)
  if !vars.contains(v) {
    if !vars.isEmpty { return nil }
    guard let val = try? evaluate(e, [:]), let f = fromNumber(val) else { return nil }
    return ftrim([f])
  }
  switch e {
  case .var(let name):
    return name == v ? [F0, F1] : nil
  case .neg(let a):
    return exprToPoly(a, v).map { fpscale($0, FMinus1) }
  case .bin(let op, let l, let r, _):
    if op == .pow {
      guard case .num(let n) = r, JS.isInteger(n), n >= 0 else { return nil }
      guard let a = exprToPoly(l, v) else { return nil }
      if Double(a.count - 1) * n > Double(MAX_DEGREE) { return nil }
      var out: FPoly = [F1]
      var i = 0.0
      while i < n {
        out = fpmul(out, a)
        // One `^` node does all its work without returning, so the budget
        // has to be re-checked here rather than only on the way out.
        if overBudget(out) { return nil }
        i += 1
      }
      return out
    }
    if op == .div {
      guard let b = exprToPoly(r, v), b.count == 1 else { return nil }  // divisor must be a non-zero constant
      return exprToPoly(l, v).map { fpscale($0, fdiv(F1, b[0])) }
    }
    let a = exprToPoly(l, v)
    let b = exprToPoly(r, v)
    guard let a, let b else { return nil }
    if op == .add { return fpadd(a, b) }
    if op == .sub { return fpadd(a, fpscale(b, FMinus1)) }
    if a.count - 1 + (b.count - 1) > MAX_DEGREE { return nil }
    return fpmul(a, b)
  case .eq(let l, let r):
    let a = exprToPoly(l, v)
    let b = exprToPoly(r, v)
    guard let a, let b else { return nil }
    return fpadd(a, fpscale(b, FMinus1))
  default:
    return nil  // call with v inside, num (handled above), ineq, vec
  }
}

// MARK: - Yun's square-free decomposition

/// f = ∏ out[j].p ^ out[j].mult with each p square-free and pairwise coprime.
func squareFree(_ f: FPoly) throws(InexactDivision) -> [(p: FPoly, mult: Int)] {
  let df = fpderiv(f)
  let g = fpgcd(f, df)
  if g.count <= 1 { return [(f, 1)] }
  var out: [(p: FPoly, mult: Int)] = []
  var c = try fpdivExact(f, g)
  var d = fpadd(try fpdivExact(df, g), fpscale(fpderiv(c), FMinus1))
  var i = 1
  while c.count > 1 {
    let a = fpgcd(c, d)
    if a.count > 1 { out.append((a, i)) }
    c = try fpdivExact(c, a)
    d = fpadd(try fpdivExact(d, a), fpscale(fpderiv(c), FMinus1))
    i += 1
  }
  return out
}

// MARK: - Root isolation on ℤ[x] via Descartes' rule + dyadic bisection

/// Dense, ascending, trimmed, p[0] ≠ 0 where required.
typealias ZPoly = [BigInt]

private func signVariations(_ p: ZPoly) -> Int {
  var v = 0
  var last = 0
  for c in p {
    let s = c.signum
    if s == 0 { continue }
    if last != 0 && s != last { v += 1 }
    last = s
  }
  return v
}

/// Taylor shift: p(x) → p(x+1), in place.
private func shift1(_ p: inout ZPoly) {
  if p.count < 2 { return }
  for i in 0..<(p.count - 1) {
    var j = p.count - 2
    while j >= i {
      p[j] += p[j + 1]
      j -= 1
    }
  }
}

/// Upper bound on the number of roots of p in the open interval (0, 1).
private func var01(_ p: ZPoly) -> Int {
  var t = ZPoly(p.reversed())  // x^n · p(1/x)
  shift1(&t)  // (x+1)^n · p(1/(x+1))
  return signVariations(t)
}

/// Divide out the content (gcd of coefficients) to keep numbers small.
private func zprimitive(_ p: ZPoly) -> ZPoly {
  var g = BigInt.zero
  for c in p { g = bgcd(g, c) }
  return g > .one ? p.map { $0 / g } : p
}

/// Divide p (with p(1) = 0) by (x - 1); exact synthetic division.
private func divByXMinus1(_ p: ZPoly) -> ZPoly {
  var out = ZPoly(repeating: .zero, count: p.count - 1)
  var acc = BigInt.zero
  var i = p.count - 1
  while i >= 1 {
    acc += p[i]
    out[i - 1] = acc
    i -= 1
  }
  return out
}

/// Open isolating interval (a/2^k, (a+1)/2^k) in the unit-scaled domain.
private struct Iso {
  var a: BigInt
  var k: Int
}

/// Isolate the roots of square-free q in (0, 1). q(0) ≠ 0 and q(1) ≠ 0 are
/// invariants. Exact dyadic roots hit during splitting land in `exact`.
private func isolate01(_ q: ZPoly, _ out: inout [Iso], _ exact: inout [Iso], _ a: BigInt = .zero, _ k: Int = 0) {
  let v = var01(q)
  if v == 0 { return }
  if v == 1 || k > 96 {
    // v==1 → exactly one root. Depth cap: an unresolved cluster of nearly
    // coincident roots; report the interval once rather than looping.
    out.append(Iso(a: a, k: k))
    return
  }
  let n = q.count - 1
  // Left child: L(x) = 2^n q(x/2) maps roots in (0, 1/2) to (0, 1).
  var L = ZPoly(q.enumerated().map { i, c in c << (n - i) })
  L = zprimitive(L)
  var R = L
  shift1(&R)  // R(x) = L(x+1): roots of q in (1/2, 1) → (0, 1)
  var sum = BigInt.zero  // L(1) ∝ q(1/2)
  for c in L { sum += c }
  let two = BigInt(2)
  if sum.isZero { exact.append(Iso(a: two * a + .one, k: k + 1)) }
  isolate01(sum.isZero ? divByXMinus1(L) : L, &out, &exact, two * a, k + 1)
  isolate01(R[0].isZero ? zprimitive(Array(R.dropFirst())) : zprimitive(R), &out, &exact, two * a + .one, k + 1)
}

/// Sign of p at the dyadic rational n/2^e (exact integer arithmetic).
private func signAtDyadic(_ p: ZPoly, _ n: BigInt, _ e: Int) -> Int {
  let deg = p.count - 1
  var acc = p[deg]
  var i = deg - 1
  while i >= 0 {
    acc = acc * n + (p[i] << (e * (deg - i)))
    i -= 1
  }
  return acc.signum
}

/// Evaluate p (as doubles, coefficients pre-normalized) and p' at x.
private func hornerBoth(_ pd: [Double], _ x: Double) -> (f: Double, df: Double) {
  var f = 0.0
  var df = 0.0
  for c in pd.reversed() {
    df = df * x + f
    f = f * x + c
  }
  return (f, df)
}

/// Exact division of f by (den·x − num), removing the known root num/den.
/// The cofactor is integral when gcd(num, den) = 1: the divisor is then
/// primitive, so by Gauss's lemma it divides the primitive f over ℤ.
private func deflateLinear(_ f: ZPoly, _ num: BigInt, _ den: BigInt) -> ZPoly {
  let n = f.count - 1
  var s = ZPoly(repeating: .zero, count: n)
  var carry = f[n]
  var i = n
  while i >= 1 {
    s[i - 1] = carry / den  // exact
    carry = f[i - 1] + num * s[i - 1]
    i -= 1
  }
  return s
}

/// `x.toString(2).length` of |x|: the bits in it, and 1 for zero.
private func bitLength(_ x: BigInt) -> Int { max(1, x.bitWidth) }

/// Refine one root of square-free q inside (a/2^k, (a+1)/2^k) ⊂ (0,1):
/// exact dyadic bisection until the interval is tight, then Newton in doubles
/// for the last digits. q must have no dyadic roots at the interval's
/// endpoints (exact roots are deflated out before refinement).
private func refine01(_ q: ZPoly, _ iso: Iso, _ qd: [Double]) -> Double {
  var e = iso.k
  var lo = iso.a
  var hi = iso.a + .one
  let sL = signAtDyadic(q, lo, e)
  let two = BigInt(2)
  // Bisect until the width is < ~2^-45 of the root's magnitude; Newton
  // recovers the remaining bits in doubles.
  while e < 1070 && bitLength(lo) <= 45 {
    let mid = lo + hi  // the midpoint, at scale e+1
    let s = signAtDyadic(q, mid, e + 1)
    if s == 0 { return mid.double / pow2(e + 1) }
    if s == sL {
      lo = mid
      hi *= two
    } else {
      hi = mid
      lo *= two
    }
    e += 1
  }
  return polish(qd, lo.double / pow2(e), hi.double / pow2(e))
}

/// A few unclamped Newton steps from the interval midpoint, keeping the
/// iterate with the smallest residual (near-double-root noise floors and
/// 1-ulp limit cycles both settle on the best representable value).
private func polish(_ qd: [Double], _ lo: Double, _ hi: Double) -> Double {
  var x = (lo + hi) / 2
  var best = x
  var bestAbs = Double.infinity
  for _ in 0..<10 {
    let (f, df) = hornerBoth(qd, x)
    if abs(f) < bestAbs {
      bestAbs = abs(f)
      best = x
    }
    if f == 0 || df == 0 { break }
    let nx = x - f / df
    if !nx.isFinite || abs(nx - x) > hi - lo || nx == x { break }
    x = nx
  }
  return best
}

/// All real roots of a square-free primitive integer polynomial.
func realRootsSquareFree(_ poly: ZPoly) -> [Double] {
  var roots: [Double] = []
  var p = poly
  while !p.isEmpty && p[0].isZero {
    p.removeFirst()
    if roots.isEmpty { roots.append(0) }  // square-free ⇒ at most one zero root
  }
  if p.count <= 1 { return roots }
  let n = p.count - 1
  // Power-of-two Cauchy bound: all real roots lie in (-2^m, 2^m).
  var m = 1
  for i in 0..<n { m = max(m, bitLength(p[i]) - bitLength(p[n]) + 2) }
  for sign in [1.0, -1.0] {
    // q(x) = p(±2^m · x) has the corresponding roots in (0, 1).
    var q = ZPoly(p.enumerated().map { i, c in (sign < 0 && i % 2 == 1 ? -c : c) << (i * m) })
    q = zprimitive(q)
    var isos: [Iso] = []
    var exact: [Iso] = []
    isolate01(q, &isos, &exact)
    // Deflate exact dyadic roots out so no isolating interval of the
    // remaining roots has a root of q at an endpoint.
    for iso in exact {
      roots.append(((sign * iso.a.double) / pow2(iso.k)) * pow2(m))
      q = deflateLinear(q, iso.a, BigInt.one << iso.k)
    }
    let qd = toDoubles(q)
    for iso in isos { roots.append(sign * refine01(q, iso, qd) * pow2(m)) }
  }
  return stableSorted(roots) { $0 < $1 }
}

/// Coefficients as doubles, scaled so the largest magnitude is 1.
private func toDoubles(_ p: ZPoly) -> [Double] {
  var mx = 1.0
  let raw = p.map { c -> Double in
    let bl = bitLength(c)
    // Convert via a shifted mantissa to survive |c| > Number.MAX_VALUE.
    let shift = max(0, bl - 60)
    return (c >> shift).double * pow2(shift)
  }
  for c in raw { mx = max(mx, abs(c)) }
  return raw.map { $0 / mx }
}

// MARK: - Symbolic labels for algebraic roots
//
// A root is exactly represented by (square-free integer factor, isolating
// interval); rendering "√2" instead of 1.4142… is a display question that
// integer arithmetic settles exactly: rationals are verified by evaluating
// the factor at p/q, quadratics go through the quadratic formula with the
// square part of the discriminant extracted, and binomials a·x^n + c give
// n-th roots. Anything bigger has no radical form in general, so the label
// stays nil and the caller shows the decimal.

func isqrt(_ n: BigInt) -> BigInt {
  if n < BigInt(2) { return n }
  // (Math.ceil(bits / 2).)
  var x = BigInt.one << ((bitLength(n) + 1) / 2)
  while true {
    let y = (x + n / x) >> 1
    if y >= x { return x }
    x = y
  }
}

/// n = t²·s with s square-free as far as trial division can tell.
private func squarePart(_ n: BigInt) -> (t: BigInt, s: BigInt) {
  var t = BigInt.one
  var s = BigInt.one
  var rem = n
  var d = BigInt(2)
  let limit = BigInt(10000)
  while d <= limit && d * d <= rem {
    var e = 0
    while (rem % d).isZero {
      rem /= d
      e += 1
    }
    t *= d.power(e >> 1)
    if e & 1 == 1 { s *= d }
    d += .one
  }
  let r = isqrt(rem)
  if r * r == rem { t *= r } else { s *= rem }
  return (t, s)
}

/// Best rational approximation p/q of x with q ≤ maxDen (continued fraction).
private func ratApprox(_ x: Double, _ maxDen: Int) -> (BigInt, BigInt)? {
  if !x.isFinite || abs(x) > 1e15 { return nil }
  var p0 = BigInt.one
  var q0 = BigInt.zero
  var p1 = BigInt(exactly: x.rounded(.down))!
  var q1 = BigInt.one
  var frac = x - x.rounded(.down)
  let limit = BigInt(maxDen)
  var i = 0
  while i < 40 && frac > 1e-12 {
    let v = 1 / frac
    let a = v.rounded(.down)
    if !a.isFinite { break }
    let big = BigInt(exactly: a)!
    let p2 = big * p1 + p0
    let q2 = big * q1 + q0
    if q2 > limit { break }
    p0 = p1
    q0 = q1
    p1 = p2
    q1 = q2
    frac = v - a
    i += 1
  }
  return (p1, q1)
}

/// Exact test: is p/q (in lowest terms) a root of f?
private func isRationalRoot(_ f: ZPoly, _ p: BigInt, _ q: BigInt) -> Bool {
  let n = f.count - 1
  var acc = BigInt.zero
  var qp = BigInt.one  // q^(n-i)
  var i = n
  while i >= 0 {
    acc = acc * p + f[i] * qp
    qp *= q
    i -= 1
  }
  return acc.isZero
}

private let SYM_LIMIT = BigInt(1_000_000)

private func fitsSym(_ xs: BigInt...) -> Bool { xs.allSatisfy { $0.magnitude <= SYM_LIMIT } }

private func fmtRat(_ p: BigInt, _ q: BigInt) -> String? {
  if q == .one { return nil }  // the decimal already shows integers
  if !fitsSym(p, q) { return nil }
  return "\(p)/\(q)"
}

/// Render (p + q√s)/r reduced; nil when the numbers get ugly.
private func fmtQuadVal(_ p: BigInt, _ q: BigInt, _ r: BigInt, _ s: BigInt) -> String? {
  var (p, q, r) = (p, q, r)
  if r.signum < 0 {
    p = -p
    q = -q
    r = -r
  }
  let g = bgcd(bgcd(p, q), r)
  if g > .one {
    p /= g
    q /= g
    r /= g
  }
  if !fitsSym(p, q, r, s) { return nil }
  let minusOne = BigInt(-1)
  let rootTerm = "\(q == .one ? "" : q == minusOne ? "-" : "\(q)")√\(s)"
  if p.isZero { return r == .one ? rootTerm : "\(rootTerm)/\(r)" }
  let coefficient = q == .one || q == minusOne ? "" : "\(q.magnitude)"
  let base = "\(p)\(q.signum < 0 ? "-" : "+")\(coefficient)√\(s)"
  return r == .one ? base : "(\(base))/\(r)"
}

private typealias LabeledValue = (val: Double, sym: String?)

private func ratNorm(_ p: BigInt, _ q: BigInt) -> (BigInt, BigInt) {
  var (p, q) = (p, q)
  if q.signum < 0 {
    p = -p
    q = -q
  }
  var g = bgcd(p, q)
  if g.isZero { g = .one }
  return (p / g, q / g)
}

/// The two values and labels of a real quadratic a·x² + b·x + c (D > 0).
private func solveQuadratic(_ f: ZPoly) -> [LabeledValue] {
  let (c, b, a) = (f[0], f[1], f[2])
  let four = BigInt(4)
  let two = BigInt(2)
  let D = b * b - four * a * c
  if D.signum <= 0 { return [] }
  let (t, s) = squarePart(D)
  let sqrtD = t.double * s.double.squareRoot()
  var out: [LabeledValue] = []
  for sign in [-1, 1] {
    let val = ((-b).double + Double(sign) * sqrtD) / (two * a).double
    let signed = BigInt(sign) * t
    let sym: String?
    if s == .one {
      let (p, q) = ratNorm(-b + signed, two * a)
      sym = fmtRat(p, q)
    } else {
      sym = fmtQuadVal(-b, signed, two * a, s)
    }
    out.append((val, sym))
  }
  return out
}

/// Label for the real n-th roots of a binomial a·x^n + c (n ≥ 3).
private func solveBinomial(_ f: ZPoly) -> [LabeledValue] {
  var n = f.count - 1
  var (p, q) = ratNorm(-f[0], f[n])  // radicand p/q, roots ±(p/q)^(1/n)
  let negOdd = n % 2 == 1 && p.signum < 0
  if negOdd { p = -p }
  if p.signum <= 0 { return [] }  // even n with non-positive radicand: no real roots
  // ⁿ√ of a perfect square halves the index: ∜4 = √2.
  while true {
    let rp = isqrt(p)
    let rq = isqrt(q)
    if n % 2 == 0 && n > 2 && rp * rp == p && rq * rq == q {
      p = rp
      q = rq
      n /= 2
    } else {
      break
    }
  }
  let val = JS.pow(p.double / q.double, 1 / Double(n))
  var sym: String?
  if n == 2 {
    // √(p/q) = √(pq)/q, with the square part of pq pulled out.
    let (t, s) = squarePart(p * q)
    if s == .one {
      let (a, b) = ratNorm(t, q)
      sym = fmtRat(a, b)
    } else {
      sym = fmtQuadVal(.zero, t, q, s)
    }
  } else if fitsSym(p, q) {
    let rad = q == .one ? "\(p)" : "(\(p)/\(q))"
    sym = n == 3 ? "∛\(rad)" : n == 4 ? "∜\(rad)" : "\(rad)^(1/\(n))"
  }
  // (`sym && …`: an empty label stays empty, as a missing one stays missing.)
  func minus(_ s: String?) -> String? { s.map { $0.isEmpty ? $0 : "-\($0)" } }
  if n % 2 == 1 { return [(negOdd ? -val : val, negOdd ? minus(sym) : sym)] }
  return [(-val, minus(sym)), (val, sym)]
}

private let SUPERSCRIPT: [Character: Character] = [
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
]

/// Render an integer polynomial like "x⁷ - x - 2"; nil if unwieldy.
private func fmtPoly(_ poly: ZPoly) -> String? {
  var f = poly
  if f.count - 1 > 16 { return nil }
  if f[f.count - 1].signum < 0 { f = f.map { -$0 } }  // leading coefficient positive
  var parts: [String] = []
  var i = f.count - 1
  while i >= 0 {
    defer { i -= 1 }
    let c = f[i]
    if c.isZero { continue }
    if !fitsSym(c) { return nil }
    let mag = c.magnitude
    let coeff = i > 0 && mag == .one ? "" : "\(mag)"
    let xPow = i == 0 ? "" : i == 1 ? "x" : "x" + String(String(i).map { SUPERSCRIPT[$0] ?? $0 })
    parts.append(
      parts.isEmpty ? "\(c.signum < 0 ? "-" : "")\(coeff)\(xPow)" : "\(c.signum < 0 ? "- " : "+ ")\(coeff)\(xPow)")
  }
  let s = parts.joined(separator: " ")
  return s.utf16.count <= 48 ? s : nil
}

struct RootLabel: Equatable {
  /// Radical/rational form ("√2", "(1+√5)/2") when one exists.
  var sym: String?
  /// Defining polynomial ("x⁷ - x - 2") when no radical form exists.
  var rootOf: String?
}

/// Symbolic labels ("√2", "1/3", "(1+√5)/2", "∛2") for the roots of a
/// square-free primitive factor, where a radical form exists and stays
/// readable. Roots beyond radicals (unsolvable Galois groups) instead get
/// their defining polynomial; entries with neither fall back to decimals.
private func labelRoots(_ f: ZPoly, _ roots: [Double]) -> [RootLabel] {
  var out = [RootLabel](repeating: RootLabel(), count: roots.count)
  if roots.isEmpty { return out }
  var rem = f
  while rem.count > 1 && rem[0].isZero { rem.removeFirst() }  // drop the x = 0 root
  // (In the order met, as a JavaScript Set keeps them.)
  var unlabeled: [Int] = []
  for i in 0..<roots.count {
    if roots[i] == 0 { continue }
    if let cand = ratApprox(roots[i], 1_000_000), cand.1.signum > 0,
      abs(roots[i] - cand.0.double / cand.1.double) <= 1e-8 * max(1, abs(roots[i])),
      rem.count > 1, isRationalRoot(rem, cand.0, cand.1)
    {
      out[i].sym = fmtRat(cand.0, cand.1)
      rem = deflateLinear(rem, cand.0, cand.1)
    } else {
      unlabeled.append(i)
    }
  }
  var sols: [LabeledValue] = []
  let remDeg = rem.count - 1
  let isBinomial = remDeg >= 3 && rem[1..<(rem.count - 1)].allSatisfy(\.isZero)
  if remDeg == 2 { sols = solveQuadratic(rem) } else if isBinomial { sols = solveBinomial(rem) }
  for sol in sols {
    var bestI = -1
    for i in unlabeled where bestI < 0 || abs(roots[i] - sol.val) < abs(roots[bestI] - sol.val) { bestI = i }
    if bestI >= 0 && abs(roots[bestI] - sol.val) <= 1e-6 * max(1, abs(sol.val)) {
      out[bestI].sym = sol.sym
      unlabeled.removeAll { $0 == bestI }
    }
  }
  // No radical form (generic Galois groups above degree 4 are unsolvable):
  // the defining polynomial IS the exact representation, so show that.
  if remDeg >= 3 && !isBinomial {
    if let rootOf = fmtPoly(rem), !rootOf.isEmpty { for i in unlabeled { out[i].rootOf = rootOf } }
  }
  return out
}

// MARK: - Public API

struct PolyRoot: Equatable {
  var x: Double
  var mult: Int
  /// Exact symbolic form ("√2", "1/3", "(1+√5)/2", "∛2") when one exists.
  var sym: String?
  /// Defining polynomial ("x⁷ - x - 2") when no radical form exists.
  var rootOf: String?
}

/// What `polynomialRoots` finds: the TypeScript's `PolyRoot[] | 'zero'`.
enum PolyRoots: Equatable {
  /// e is identically zero (every point is a root).
  case zero
  case roots([PolyRoot])
}

/// The multiset of real roots of e viewed as a polynomial in v, sorted by x.
/// Nil when e is not a polynomial in v, and `.zero` when e is identically zero.
func polynomialRoots(_ e: Expr, _ v: String) -> PolyRoots? {
  guard let p = exprToPoly(e, v) else { return nil }
  if p.isEmpty { return .zero }
  if p.count == 1 { return .roots([]) }
  if p.count - 1 > MAX_DEGREE { return nil }
  var out: [PolyRoot] = []
  // (An inexact division inside Yun's algorithm is a thrown Error on the
  // site, which no caller catches; it cannot happen for a true gcd.)
  guard let factors = try? squareFree(primitive(p)) else { return nil }
  for (factor, mult) in factors {
    let zp = factor.map(\.n)  // primitive parts have denominator 1
    let roots = realRootsSquareFree(zp)
    let labels = labelRoots(zp, roots)
    for (i, x) in roots.enumerated() {
      out.append(PolyRoot(x: x, mult: mult, sym: labels[i].sym, rootOf: labels[i].rootOf))
    }
  }
  return .roots(stableSorted(out) { $0.x < $1.x })
}

struct ComplexRootLabel: Equatable {
  var re: Double
  var im: Double
  var label: String
}

/// Rational linear and quadratic factors, with exact division checking every
/// candidate. Factoring work is bounded; a remaining factor keeps its exact
/// defining-polynomial label instead of inventing a radical approximation.
func complexRootLabels(_ e: Expr) -> (roots: [ComplexRootLabel], rootOf: String?)? {
  guard let p = exprToPoly(e, "w"), p.count >= 2, p.count <= 17 else { return nil }
  var roots: [ComplexRootLabel] = []
  func rationalLabel(_ p: BigInt, _ q: BigInt) -> String? {
    let (a, b) = ratNorm(p, q)
    return b == .one ? "\(a)" : fmtRat(a, b)
  }
  if case .roots(let real)? = polynomialRoots(e, "w") {
    for r in real {
      var whole = false
      if r.sym == nil || r.sym!.isEmpty, JS.isInteger(r.x), let x = BigInt(exactly: r.x) {
        whole = isRationalRoot(primitive(p).map(\.n), x, .one)
      }
      if let sym = r.sym, !sym.isEmpty {
        roots.append(ComplexRootLabel(re: r.x, im: 0, label: sym))
      } else if whole {
        roots.append(ComplexRootLabel(re: r.x, im: 0, label: JS.string(r.x)))
      }
    }
  }
  var budget = 16000
  func divisors(_ value: BigInt) -> [BigInt] {
    let v = value.magnitude
    if v > BigInt(10000) || v.isZero { return [] }
    var out: [BigInt] = []
    var k = BigInt.one
    while k * k <= v {
      if (v % k).isZero {
        out.append(k)
        if k * k != v { out.append(v / k) }
      }
      k += .one
    }
    return out
  }
  let two = BigInt(2)
  func quadratic(_ f: ZPoly) {
    let (c, b, a) = (f[0], f[1], f[2])
    let disc = b * b - BigInt(4) * a * c
    if disc.signum >= 0 { return }
    let (t, s) = squarePart(-disc)
    let re = (-b).double / (two * a).double
    let im = abs((t.double * s.double.squareRoot()) / (two * a).double)
    let reLabel = rationalLabel(-b, two * a)
    let imag = s == .one ? rationalLabel(t, two * a.magnitude) : fmtQuadVal(.zero, t, two * a.magnitude, s)
    guard let imag, !imag.isEmpty, b.isZero || !(reLabel ?? "").isEmpty else { return }
    for sign in [-1.0, 1.0] {
      let part = imag == "1" ? "i" : "\(imag) i"
      roots.append(
        ComplexRootLabel(
          re: re, im: sign * im,
          label: b.isZero ? (sign < 0 ? "-" : "") + part : "\(reLabel!) \(sign < 0 ? "−" : "+") \(part)"))
    }
  }
  guard let factors = try? squareFree(primitive(p)) else { return nil }
  for (factor, _) in factors {
    var rem = factor
    while rem.count > 1 && rem[0].n.isZero {
      roots.append(ComplexRootLabel(re: 0, im: 0, label: "0"))
      rem.removeFirst()
    }
    // Remove rational real factors before looking for quadratic factors.
    let rs = realRootsSquareFree(primitive(rem).map(\.n))
    for root in rs {
      guard let rat = ratApprox(root, 1_000_000), rem.count >= 2 else { continue }
      let divisor = [Frac(n: -rat.0, d: .one), Frac(n: rat.1, d: .one)]
      let qr = fpdivmod(rem, divisor)
      if qr.r.isEmpty { rem = primitive(qr.q) }
    }
    while rem.count > 3 && budget > 0 {
      var found = false
      let z = primitive(rem).map(\.n)
      search: for a in divisors(z[z.count - 1]) {
        for c0 in divisors(z[0]) {
          for sign in [BigInt(-1), BigInt.one] {
            for b in -32...32 {
              budget -= 1
              if budget <= 0 { break search }
              let f = [sign * c0, BigInt(b), a]
              let qr = fpdivmod(rem, f.map { Frac(n: $0, d: .one) })
              if qr.r.isEmpty {
                quadratic(f)
                rem = primitive(qr.q)
                found = true
                break search
              }
            }
          }
        }
      }
      if !found { break }
    }
    if rem.count == 3 { quadratic(primitive(rem).map(\.n)) }
  }
  let rootOf = fmtPoly(primitive(p).map(\.n)).map { String($0.map { $0 == "x" ? "w" : $0 }) }
  return (roots, rootOf)
}
