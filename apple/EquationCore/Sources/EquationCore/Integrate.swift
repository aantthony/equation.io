/// Symbolic integration with a numeric safety net (lib/integrate.ts).
///
/// `antiderivative(e, v)` tries a small tower of exact methods — linearity,
/// power rules, a table of elementary forms with linear arguments, the
/// complete rational-function algorithm (Horowitz–Ostrogradsky reduction in
/// exact rational arithmetic, log/atan terms over the certified real roots
/// from Poly.swift), Gaussian integrals via erf, integration by parts, trig
/// product/power rewrites, and u-substitution. It is NOT a full Risch
/// decision procedure: nil means "no form found", not "no elementary form
/// exists", and callers fall back to numeric quadrature.
///
/// Every symbolic result is *verified before it is returned*: the candidate F
/// is differentiated (symbolically when diff() can, finite differences when it
/// cannot) and compared against the integrand at a spread of sample points.
/// A rule with a sign slip or a domain surprise is rejected rather than
/// plotted — heuristics are safe because nothing unverified escapes.
///
/// For definite integrals the fundamental theorem is itself the thing that can
/// lie (F(b) − F(a) is wrong across a non-integrable singularity), so
/// `verifyDefinite` checks the closed form against adaptive Gauss–Kronrod
/// quadrature at probe parameter values. `quadratureSum` builds the fallback:
/// a fixed composite Gauss–Legendre rule expanded into an ordinary Expr, the
/// same way Σ expands — so shaders and every other consumer evaluate it with
/// no new machinery.

private func num(_ value: Double) -> Expr { .num(value) }
private func vr(_ name: String) -> Expr { .var(name) }
private func call(_ name: String, _ args: Expr...) -> Expr { .call(name, args) }
private func ln(_ x: Expr) -> Expr { call("ln", x) }
private func lnAbs(_ x: Expr) -> Expr { call("ln", call("abs", x)) }

private func numValue(_ e: Expr) -> Double? {
  if case .num(let value) = e { return value }
  return nil
}

private func key(_ e: Expr) -> String { exprKey(e) }

private func isConstIn(_ e: Expr, _ v: String) -> Bool { !freeVars(e).contains(v) }

/// The numeric value of a v-free expression with no other frees, or nil.
private func constVal(_ e: Expr) -> Double? {
  if !freeVars(e).isEmpty { return nil }
  guard let x = try? evaluate(e, [:]), x.isFinite else { return nil }
  return x
}

// MARK: - Polynomials with symbolic (v-free Expr) coefficients

private let SYM_DEG_MAX = 8

/// Coefficients of e as a polynomial in v whose coefficients are v-free
/// expressions (sliders welcome), ascending, or nil. The symbolic sibling of
/// Poly.swift's exprToPoly, for the rules that stay exact under slider
/// parameters.
func exprPolyCoeffs(_ e: Expr, _ v: String) -> [Expr]? {
  if isConstIn(e, v) { return [e] }
  switch e {
  case .var(let name):
    return name == v ? [num(0), num(1)] : nil
  case .neg(let a):
    return exprPolyCoeffs(a, v).map { $0.map(neg) }
  case .bin(let op, let l, let r, _):
    if op == .pow {
      guard let n = numValue(r), JS.isInteger(n), n >= 0 else { return nil }
      guard let a = exprPolyCoeffs(l, v), Double(a.count - 1) * n <= Double(SYM_DEG_MAX) else { return nil }
      var out: [Expr] = [num(1)]
      var i = 0.0
      while i < n {
        out = convolve(out, a)
        i += 1
      }
      return out
    }
    if op == .div {
      if !isConstIn(r, v) { return nil }
      return exprPolyCoeffs(l, v).map { $0.map { div($0, r) } }
    }
    let a = exprPolyCoeffs(l, v)
    let b = exprPolyCoeffs(r, v)
    guard let a, let b else { return nil }
    if op == .add || op == .sub {
      var out: [Expr] = []
      for i in 0..<max(a.count, b.count) {
        let x = i < a.count ? a[i] : num(0)
        let y = i < b.count ? b[i] : num(0)
        out.append(op == .add ? add(x, y) : sub(x, y))
      }
      return out
    }
    if a.count - 1 + (b.count - 1) > SYM_DEG_MAX { return nil }
    return convolve(a, b)
  default:
    return nil
  }
}

private func convolve(_ a: [Expr], _ b: [Expr]) -> [Expr] {
  var out = [Expr](repeating: num(0), count: a.count + b.count - 1)
  for i in 0..<a.count {
    for j in 0..<b.count { out[i + j] = add(out[i + j], mul(a[i], b[j])) }
  }
  return out
}

/// a·v + b with a ≠ 0 (v-free a, b), or nil. The "linear argument" matcher.
private func linearIn(_ e: Expr, _ v: String) -> (a: Expr, b: Expr)? {
  guard let c = exprPolyCoeffs(e, v), c.count == 2 else { return nil }
  if numValue(c[1]) == 0 { return nil }
  return (c[1], c[0])
}

// MARK: - Multiplicative structure

private struct Factor: Equatable {
  var base: Expr
  var exp: Int
}

/// Flatten products/quotients/negations/integer powers into factors and a sign.
private func factorsOf(_ e: Expr, _ sign: Int, _ out: inout [Factor], _ flip: inout Bool) {
  switch e {
  case .neg(let a):
    flip.toggle()
    factorsOf(a, sign, &out, &flip)
    return
  case .bin(.mul, let a, let b, _):
    factorsOf(a, sign, &out, &flip)
    factorsOf(b, sign, &out, &flip)
    return
  case .bin(.div, let a, let b, _):
    factorsOf(a, sign, &out, &flip)
    factorsOf(b, -sign, &out, &flip)
    return
  case .bin(.pow, let a, .num(let n), _) where JS.isInteger(n) && abs(n) <= 16 && n != 0:
    out.append(Factor(base: a, exp: sign * Int(n)))
    return
  default:
    break
  }
  out.append(Factor(base: e, exp: sign))
}

private func flatten(_ e: Expr) -> (neg: Bool, factors: [Factor]) {
  var flip = false
  var raw: [Factor] = []
  factorsOf(e, 1, &raw, &flip)
  // Merge repeated bases so sin(x)·sin(x) reads as sin(x)^2.
  var merged: [String: Int] = [:]
  var order: [Factor] = []
  for f in raw {
    if numValue(f.base) == 1 { continue }  // 1/x carries a unit factor
    let k = key(f.base)
    if let at = merged[k] {
      order[at].exp += f.exp
    } else {
      merged[k] = order.count
      order.append(f)
    }
  }
  return (flip, order.filter { $0.exp != 0 })
}

private func rebuild(_ factors: [Factor], _ negate: Bool) -> Expr {
  var numr: Expr?
  var den: Expr?
  for f in factors {
    let p = abs(f.exp) == 1 ? f.base : pow(f.base, num(Double(abs(f.exp))))
    if f.exp > 0 { numr = numr.map { mul($0, p) } ?? p } else { den = den.map { mul($0, p) } ?? p }
  }
  var out = numr ?? num(1)
  if let den { out = div(out, den) }
  return negate ? neg(out) : out
}

// MARK: - Exact rational arithmetic helpers

private let F0 = Frac(n: .zero, d: .one)
private let F1 = Frac(n: .one, d: .one)

private func fracNum(_ f: Frac) -> Double { f.n.double / f.d.double }

private func fpEval(_ p: FPoly, _ x: Double) -> Double {
  var acc = 0.0
  for c in p.reversed() { acc = acc * x + fracNum(c) }
  return acc
}

/// ∑ cᵢ vⁱ as an Expr with double coefficients.
private func fpToExpr(_ p: FPoly, _ v: String) -> Expr {
  var acc: Expr = num(0)
  for c in p.reversed() { acc = add(mul(acc, vr(v)), num(fracNum(c))) }
  return acc
}

private func fsubF(_ a: Frac, _ b: Frac) -> Frac { frac(a.n * b.d - b.n * a.d, a.d * b.d) }

/// Exact Gaussian elimination; nil when the system is singular.
private func solveLinear(_ A: [[Frac]], _ b: [Frac]) -> [Frac]? {
  let n = b.count
  var M = A.enumerated().map { i, row in row + [b[i]] }
  for col in 0..<n {
    guard let piv = (col..<n).first(where: { !M[$0][col].n.isZero }) else { return nil }
    M.swapAt(col, piv)
    let inv = Frac(n: M[col][col].d, d: M[col][col].n)
    for c in col...n { M[col][c] = fmul(M[col][c], inv) }
    for r in 0..<n {
      if r == col || M[r][col].n.isZero { continue }
      let f = M[r][col]
      for c in col...n { M[r][c] = fsubF(M[r][c], fmul(f, M[col][c])) }
    }
  }
  return M.map { $0[n] }
}

// MARK: - The rational-function algorithm

/// ∫ P/Q dv for numeric-coefficient polynomials: the polynomial part by the
/// power rule; Horowitz–Ostrogradsky reduction (an exact linear solve) splits
/// off the rational part P₁/Q₁; the remaining log part integrates over the
/// certified real roots (residue · ln|v − r|) with one conjugate quadratic
/// pair handled in closed form (ln + atan). Nil when the leftover complex
/// factor has degree ≥ 4 — the verifier-gated numeric fallback covers it.
private func integrateRational(_ P: FPoly, _ Q: FPoly, _ v: String) throws -> Expr? {
  if Q.isEmpty { return nil }
  var terms: [Expr] = []
  let (polyPart, r) = fpdivmod(P, Q)
  if !polyPart.isEmpty {
    var F: FPoly = [F0]
    for (i, c) in polyPart.enumerated() { F.append(fmul(c, frac(.one, BigInt(i + 1)))) }
    terms.append(fpToExpr(F, v))
  }
  if !r.isEmpty {
    var A = r
    var D = Q
    let D1 = fpgcd(D, fpderiv(D))
    if D1.count > 1 {
      let D2 = try fpdivExact(D, D1)
      guard let H = try? fpdivExact(fpmul(fpderiv(D1), D2), D1) else { return nil }
      // A = P₁′·D₂ − P₁·H + P₂·D₁ with deg P₁ < deg D₁, deg P₂ < deg D₂:
      // one column per unknown coefficient, equated degree by degree.
      let d1 = D1.count - 1
      let d2 = D2.count - 1
      let n = d1 + d2
      var rows = [[Frac]](repeating: [Frac](repeating: F0, count: n), count: n)
      let rhs = (0..<n).map { $0 < A.count ? A[$0] : F0 }
      if A.count - 1 >= n { return nil }  // not proper: cannot happen, be safe
      func put(_ colIdx: Int, _ p: FPoly) {
        for (deg, c) in p.enumerated() where deg < n {
          rows[deg][colIdx] = fpadd([rows[deg][colIdx]], [c]).first ?? F0
        }
      }
      func zeros(_ k: Int) -> FPoly { FPoly(repeating: F0, count: k) }
      for j in 0..<d1 {
        // P₁ = v^j: P₁′·D₂ − v^j·H
        let dTerm = j > 0 ? fpmul(zeros(j - 1) + [frac(BigInt(j), .one)], D2) : []
        let hTerm = fpscale(fpmul(zeros(j) + [F1], H), Frac(n: BigInt(-1), d: .one))
        put(j, fpadd(dTerm, hTerm))
      }
      for j in 0..<d2 { put(d1 + j, fpmul(zeros(j) + [F1], D1)) }
      guard let sol = solveLinear(rows, rhs) else { return nil }
      var P1 = Array(sol[0..<d1])
      var P2 = Array(sol[d1...])
      while let last = P1.last, last.n.isZero { P1.removeLast() }
      while let last = P2.last, last.n.isZero { P2.removeLast() }
      if !P1.isEmpty { terms.append(div(fpToExpr(P1, v), fpToExpr(D1, v))) }
      A = P2
      D = D2
    }
    if !A.isEmpty {
      guard let logPart = integrateLogPart(A, D, v) else { return nil }
      terms.append(logPart)
    }
  }
  return terms.reduce(num(0)) { add($0, $1) }
}

/// ∫ A/D with D square-free: residues at the certified real roots, plus one
/// conjugate pair in closed form.
private func integrateLogPart(_ A: FPoly, _ D: FPoly, _ v: String) -> Expr? {
  let zp = primitive(D).map(\.n)
  let roots = realRootsSquareFree(zp)
  let degLeft = D.count - 1 - roots.count
  if degLeft != 0 && degLeft != 2 { return nil }
  let dD = fpderiv(D)
  var terms: [Expr] = []
  for r0 in roots {
    let res = fpEval(A, r0) / fpEval(dD, r0)
    if !res.isFinite { return nil }
    terms.append(mul(num(res), lnAbs(sub(vr(v), num(r0)))))
  }
  if degLeft == 2 {
    // Deflate the real roots numerically; the quotient is the conjugate pair.
    var cur = D.map(fracNum)
    for r0 in roots {
      var next = [Double](repeating: 0, count: cur.count - 1)
      var carry = 0.0
      var i = cur.count - 1
      while i >= 1 {
        carry = cur[i] + carry * r0
        next[i - 1] = carry
        i -= 1
      }
      cur = next
    }
    let (c, b, a) = (cur[0], cur[1], cur[2])
    let disc = b * b - 4 * a * c
    if !(disc < 0) || !disc.isFinite { return nil }
    let alpha = -b / (2 * a)
    let beta = (-disc).squareRoot() / (2 * a)
    // Complex residue at α + βi: c = A(z)/D′(z), by complex Horner.
    func horner(_ p: FPoly) -> (Double, Double) {
      var re = 0.0
      var im = 0.0
      for c in p.reversed() {
        let nre = re * alpha - im * beta + fracNum(c)
        im = re * beta + im * alpha
        re = nre
      }
      return (re, im)
    }
    let (nRe, nIm) = horner(A)
    let (dRe, dIm) = horner(dD)
    let dd = dRe * dRe + dIm * dIm
    let resRe = (nRe * dRe + nIm * dIm) / dd
    let resIm = (nIm * dRe - nRe * dIm) / dd
    if !resRe.isFinite || !resIm.isFinite { return nil }
    let shifted = sub(vr(v), num(alpha))
    let quadExpr = add(pow(shifted, num(2)), num(beta * beta))
    terms.append(mul(num(resRe), ln(quadExpr)))
    terms.append(mul(num(-2 * resIm), call("atan", div(shifted, num(beta)))))
  }
  return terms.reduce(num(0)) { add($0, $1) }
}

// MARK: - Table of elementary antiderivatives, argument u = a·v + b

/// Math.LN10 and √π, as JavaScript has them.
private let LN10 = 2.302585092994046
private let SQRT_PI = Double.pi.squareRoot()

/// ∫ f(u) du for one call family; the caller divides by a. Nil = no entry.
private func tableCall(_ name: String, _ u: Expr) -> Expr? {
  switch name {
  case "sin": return neg(call("cos", u))
  case "cos": return call("sin", u)
  case "tan": return neg(lnAbs(call("cos", u)))
  case "exp": return call("exp", u)
  case "sinh": return call("cosh", u)
  case "cosh": return call("sinh", u)
  case "tanh": return ln(call("cosh", u))
  case "sech": return call("atan", call("sinh", u))
  case "sqrt": return mul(num(2.0 / 3.0), pow(u, num(1.5)))
  case "ln": return sub(mul(u, ln(u)), u)
  case "log": return div(sub(mul(u, ln(u)), u), num(LN10))
  case "abs": return div(mul(u, call("abs", u)), num(2))
  case "sign": return call("abs", u)
  case "asin": return add(mul(u, call("asin", u)), call("sqrt", sub(num(1), pow(u, num(2)))))
  case "acos": return sub(mul(u, call("acos", u)), call("sqrt", sub(num(1), pow(u, num(2)))))
  case "atan": return sub(mul(u, call("atan", u)), div(ln(add(num(1), pow(u, num(2)))), num(2)))
  case "asinh": return sub(mul(u, call("asinh", u)), call("sqrt", add(pow(u, num(2)), num(1))))
  case "acosh": return sub(mul(u, call("acosh", u)), call("sqrt", sub(pow(u, num(2)), num(1))))
  case "atanh": return add(mul(u, call("atanh", u)), div(ln(sub(num(1), pow(u, num(2)))), num(2)))
  case "erf": return add(mul(u, call("erf", u)), div(call("exp", neg(pow(u, num(2)))), num(SQRT_PI)))
  default: return nil
  }
}

// MARK: - Verification

private let V_PROBES = [-3.7, -2.1, -1.05, -0.51, 0.33, 0.77, 1.29, 2.42, 3.91]
private let PARAM_PROBES = [0.73, 1.91, -1.37, 0.42]

/// Probe environments for the free parameters (two spreads, cycled values).
private func probeEnvs(_ names: [String]) -> [[String: Double]] {
  func mk(_ offset: Int) -> [String: Double] {
    var env: [String: Double] = [:]
    for (i, n) in names.enumerated() { env[n] = PARAM_PROBES[(i + offset) % PARAM_PROBES.count] }
    return env
  }
  return names.isEmpty ? [[:]] : [mk(0), mk(1)]
}

/// Does F′ = f? Symbolic differentiation (finite differences when diff cannot)
/// compared at sample points; accepted only when enough samples are defined
/// and every defined one matches. This gate is what lets the rules above be
/// fearless: a wrong candidate is dropped, never returned.
func verifyAntiderivative(_ F: Expr, _ f: Expr, _ v: String) -> Bool {
  let dF = try? diff(F, v)
  var frees = freeVars(f)
  for name in freeVars(F) { frees.insert(name) }
  frees.remove(v)
  var matched = 0
  for base in probeEnvs(frees.list) {
    var env = base
    for x in V_PROBES {
      env[v] = x
      // (An unbound name: nothing meaningful to verify against.)
      guard let want = try? evaluate(f, env) else { return false }
      if !want.isFinite { continue }
      let got: Double
      var tol = 1e-6 * (1 + abs(want))
      if let dF {
        guard let value = try? evaluate(dF, env) else { return false }
        got = value
      } else {
        let h = 1e-5 * (1 + abs(x))
        env[v] = x + h
        guard let fp = try? evaluate(F, env) else { return false }
        env[v] = x - h
        guard let fm = try? evaluate(F, env) else { return false }
        got = (fp - fm) / (2 * h)
        tol = 1e-3 * (1 + abs(want))
      }
      if !got.isFinite { continue }  // F undefined there (domain edge): unjudged
      if abs(got - want) > tol { return false }
      matched += 1
    }
  }
  // Limited domains (asin, acosh, √) leave few in-domain probes; three
  // agreeing points across the spread is already a strong certificate.
  return matched >= 3
}

// MARK: - Adaptive quadrature (Gauss–Kronrod 7–15)

private let K15_X = [
  0, 0.2077849550078985, 0.4058451513773972, 0.5860872354676911, 0.7415311855993945, 0.8648644233597691,
  0.9491079123427585, 0.9914553711208126,
]
private let K15_W = [
  0.2094821410847278, 0.2044329400752989, 0.1903505780647854, 0.1690047266392679, 0.1406532597155259,
  0.1047900103222502, 0.0630920926299786, 0.0229353220105292,
]
private let G7_W = [0.4179591836734694, 0.3818300505051189, 0.2797053914892767, 0.1294849661688697]

/// Adaptive Gauss–Kronrod estimate of ∫ f over [lo, hi] (sign-aware when
/// reversed; ±∞ bounds handled by the standard rational change of
/// variables). NaN when the integral fails to settle within the subdivision
/// budget — divergence reads as "no answer", never a confident wrong one.
func quadrature(_ f: (Double) -> Double, _ lo: Double, _ hi: Double) -> Double {
  if lo.isNaN || hi.isNaN { return .nan }
  if lo == hi { return 0 }
  if !lo.isFinite || !hi.isFinite {
    if lo > hi { return -quadrature(f, hi, lo) }
    if lo == -.infinity && hi == .infinity {
      // x = u/(1−u²) maps (−1, 1) onto ℝ; dx = (1+u²)/(1−u²)² du.
      return quadrature(
        { u in
          let d = 1 - u * u
          return (f(u / d) * (1 + u * u)) / (d * d)
        }, -1, 1)
    }
    if hi == .infinity {
      // x = lo + u/(1−u) maps (0, 1) onto (lo, ∞); dx = du/(1−u)².
      return quadrature(
        { u in
          let d = 1 - u
          return f(lo + u / d) / (d * d)
        }, 0, 1)
    }
    // (−∞, hi): the mirror map.
    return quadrature(
      { u in
        let d = 1 - u
        return f(hi - u / d) / (d * d)
      }, 0, 1)
  }
  let sign: Double = lo < hi ? 1 : -1
  let a = min(lo, hi)
  let b = max(lo, hi)
  func panel(_ x0: Double, _ x1: Double) -> (k: Double, err: Double) {
    let c = (x0 + x1) / 2
    let h = (x1 - x0) / 2
    var k15 = 0.0
    var g7 = 0.0
    for i in 0..<8 {
      let fp = f(c + h * K15_X[i])
      let fm = i == 0 ? fp : f(c - h * K15_X[i])
      let s = i == 0 ? fp : fp + fm
      k15 += K15_W[i] * s
      // The embedded G7 rule lives on the even-index K15 nodes.
      if i % 2 == 0 { g7 += G7_W[i / 2] * s }
    }
    return (k15 * h, abs((k15 - g7) * h))
  }
  var total = 0.0
  var badMass = 0.0
  var stack: [(x0: Double, x1: Double, depth: Int)] = [(a, b, 0)]
  var evals = 0
  while let top = stack.popLast() {
    let (x0, x1, depth) = top
    let (k, err) = panel(x0, x1)
    evals += 15
    let tol = 1e-10 * max(1, abs(total)) * ((x1 - x0) / (b - a))
    // Depth 45 lets an endpoint singularity refine down to ~1e-12 widths
    // (only the singular panel keeps splitting, so the cost stays linear).
    // (`err <= tol` is false for a NaN error, as in JavaScript.)
    if err <= tol || depth >= 45 || evals > 20000 {
      if k.isFinite {
        total += k
        if depth >= 45 || evals > 20000 { badMass += err }
      }
      // Non-finite panels (a sampled singularity) contribute nothing: the
      // neighboring subdivisions already carry the finite mass.
      continue
    }
    let mid = (x0 + x1) / 2
    stack.append((x0, mid, depth + 1))
    stack.append((mid, x1, depth + 1))
  }
  if !total.isFinite || badMass > 1e-4 * max(1, abs(total)) { return .nan }
  return sign * total
}

/// Check a closed-form definite value against quadrature at probe parameter
/// values — the guard against FTC across a singularity (∫₋₁¹ dv/v² is NOT
/// v⁻¹ evaluated at the ends). True only when at least one probe is judgeable
/// and every judgeable probe agrees.
func verifyDefinite(_ value: Expr, _ body: Expr, _ v: String, _ lo: Expr, _ hi: Expr) -> Bool {
  // Only the BODY's occurrences of v are bound. In `int[a..x] f(x) dx` the
  // upper bound's x is the ambient plot variable sharing the name — it (and
  // its appearances in the substituted value) must be probed like any other
  // parameter, or evaluation throws and a perfectly good closed form gets
  // discarded for the far-worse fixed-order fallback.
  var frees = freeVars(lo)
  for name in freeVars(hi) { frees.insert(name) }
  for name in freeVars(value) { frees.insert(name) }
  for name in freeVars(body) where name != v { frees.insert(name) }
  var judged = 0
  for env in probeEnvs(frees.list) {
    guard let a = try? evaluate(lo, env), let b = try? evaluate(hi, env), let want = try? evaluate(value, env)
    else { return false }
    // Infinite bounds are fine (quadrature transforms them); huge FINITE
    // spans are skipped — they take forever and prove little extra.
    if a.isNaN || b.isNaN { continue }
    if (a.isFinite && abs(a) > 1e6) || (b.isFinite && abs(b) > 1e6) { continue }
    if !want.isFinite { continue }
    var scope = env
    let got = quadrature(
      { x in
        scope[v] = x
        return (try? evaluate(body, &scope)) ?? .nan
      }, a, b)
    if !got.isFinite { continue }
    if abs(got - want) > 1e-6 * (1 + abs(got)) { return false }
    judged += 1
  }
  return judged > 0
}

// MARK: - The numeric fallback as an ordinary expression

private let GL8_X = [0.1834346424956498, 0.525532409916329, 0.7966664774136267, 0.9602898564975363]
private let GL8_W = [0.362683783378362, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763]
private let QUAD_PANELS = 5

/// Terms one quadratureSum expands to (for resolve-time term budgets).
let QUAD_TERMS = QUAD_PANELS * 8

/// ∫ body dv over [lo, hi] as a composite Gauss–Legendre sum, expanded into a
/// plain Expr (5 panels × 8 points). Exactly how Σ rows expand — so the GPU
/// shaders, sampled densities and symbolic differentiation all keep working
/// with no new node kind. Fixed-order, not adaptive: smooth integrands are
/// ~1e-12, kinks land near panel edges. lo and hi may be any expressions,
/// including the ambient plot coordinate (∫₀ˣ makes a function of x).
func quadratureSum(_ body: Expr, _ v: String, _ lo: Expr, _ hi: Expr) -> Expr {
  let width = sub(hi, lo)
  var acc: Expr = num(0)
  for p in 0..<QUAD_PANELS {
    for i in 0..<4 {
      for s in [1.0, -1.0] {
        let c = (Double(p) + 0.5 + (s * GL8_X[i]) / 2) / Double(QUAD_PANELS)  // node in (0, 1)
        let xi = add(lo, mul(num(c), width))
        let term = substAll(body, v, xi)
        acc = add(acc, mul(num(GL8_W[i] / Double(2 * QUAD_PANELS)), term))
      }
    }
  }
  return mul(width, acc)
}

/// quadratureSum over a half- or fully-infinite range: the same rational
/// change of variables quadrature() uses, applied symbolically, so the result
/// is still an ordinary finite-interval Gauss–Legendre expansion. A nil
/// bound means infinite on that side (callers normalize direction first).
func improperSum(_ body: Expr, _ v: String, _ lo: Expr?, _ hi: Expr?) -> Expr {
  if let lo, let hi { return quadratureSum(body, v, lo, hi) }
  let u = "@w"
  if lo == nil && hi == nil {
    // x = u/(1−u²) over (−1, 1); dx = (1+u²)/(1−u²)² du.
    let uu = mul(vr(u), vr(u))
    let d = sub(num(1), uu)
    let x = div(vr(u), d)
    let jac = div(add(num(1), uu), mul(d, d))
    return quadratureSum(mul(substAll(body, v, x), jac), u, num(-1), num(1))
  }
  // Half-infinite: x = end ± u/(1−u) over (0, 1); dx = du/(1−u)².
  let d = sub(num(1), vr(u))
  let step = div(vr(u), d)
  let x = lo.map { add($0, step) } ?? sub(hi!, step)
  let jac = div(num(1), mul(d, d))
  return quadratureSum(mul(substAll(body, v, x), jac), u, num(0), num(1))
}

/// Substitute every free occurrence of variable v (no binders can capture:
/// the bound variable is eliminated in the same pass).
private func substAll(_ e: Expr, _ v: String, _ val: Expr) -> Expr {
  func s(_ x: Expr) -> Expr { substAll(x, v, val) }
  switch e {
  case .index, .range, .eqtest, .comp, .figure, .lazy, .trail, .label, .hist, .family:
    return mapChildren(e, s)
  case .num, .data, .str, .text:
    return e
  case .var(let name):
    return name == v ? val : e
  case .neg(let a):
    return neg(s(a))
  case .bin(let op, let a, let b, _):
    return .bin(op, s(a), s(b))
  case .call(let name, let args):
    return .call(name, args.map(s))
  case .eq(let l, let r):
    return .eq(s(l), s(r))
  case .ineq(let op, let l, let r, let grouped):
    return .ineq(op, s(l), s(r), grouped: grouped)
  case .vec(let items):
    return .vec(items.map(s))
  case .list(let items):
    return .list(items.map(s))
  case .piecewise(let cases, let otherwise):
    return .piecewise(
      cases.map { Expr.Case(cond: s($0.cond), value: s($0.value), bare: $0.bare) }, otherwise: otherwise.map(s))
  case .loop(let params, let seeds, let body, let limit):
    // The loop's params rebind inside its body; its seeds are open.
    return .loop(params: params, seeds: seeds.map(s), body: params.contains(v) ? body : s(body), limit: limit)
  }
}

// MARK: - The rule tower

private let MAX_DEPTH = 10

/// A verified antiderivative of e with respect to v, or nil. The public
/// entry: candidates come from `anti`, and only survivors of
/// `verifyAntiderivative` escape.
func antiderivative(_ e: Expr, _ v: String) -> Expr? {
  guard let F = try? anti(e, v, 0) else { return nil }
  return verifyAntiderivative(F, e, v) ? F : nil
}

private func callParts(_ e: Expr) -> (name: String, args: [Expr])? {
  if case .call(let name, let args) = e { return (name, args) }
  return nil
}

private func anti(_ e: Expr, _ v: String, _ depth: Int) throws -> Expr? {
  if depth > MAX_DEPTH { return nil }
  if isConstIn(e, v) { return mul(e, vr(v)) }
  // Structural linearity keeps the current depth: splitting a sum or pulling
  // a constant multiple strictly shrinks the tree, so it cannot cycle, and
  // charging it depth would starve the real rules on longer expressions.
  switch e {
  case .var(let name):
    return name == v ? div(pow(vr(v), num(2)), num(2)) : nil
  case .neg(let a):
    return try anti(a, v, depth).map(neg)
  case .bin(let op, let a, let b, _) where op == .add || op == .sub:
    if let A = try anti(a, v, depth), let B = try anti(b, v, depth) { return op == .add ? add(A, B) : sub(A, B) }
  default:
    break
  }

  // Constant multiples pull out of the flattened product.
  let (negated, factors) = flatten(e)
  let constFs = factors.filter { isConstIn($0.base, v) }
  let varFs = factors.filter { !isConstIn($0.base, v) }
  if !constFs.isEmpty {
    let coef = rebuild(constFs, negated)
    return try anti(rebuild(varFs, false), v, depth).map { mul(coef, $0) }
  }
  if negated {
    return try anti(rebuild(varFs, false), v, depth).map(neg)
  }

  // A sum inside a product distributes: (A ± B)·rest splits into two
  // integrals (each strictly smaller in sum-factors, so this cannot cycle).
  let sumAt = varFs.firstIndex { f in
    if f.exp == 1, case .bin(let op, _, _, _) = f.base { return op == .add || op == .sub }
    return false
  }
  if let sumAt, varFs.count > 1, case .bin(let op, let ba, let bb, _) = varFs[sumAt].base {
    let rest = rebuild(varFs.enumerated().filter { $0.offset != sumAt }.map(\.element), false)
    if let A = try anti(mul(ba, rest), v, depth), let B = try anti(mul(bb, rest), v, depth) {
      return op == .add ? add(A, B) : sub(A, B)
    }
  }

  // Exact numeric-coefficient polynomials and rational functions.
  let numExpr = rebuild(varFs.filter { $0.exp > 0 }, false)
  let denExpr = rebuild(varFs.filter { $0.exp < 0 }.map { Factor(base: $0.base, exp: -$0.exp) }, false)
  let P = exprToPoly(numExpr, v)
  let Q = exprToPoly(denExpr, v)
  if let P, let Q, let F = try integrateRational(P, Q, v) { return F }

  // Symbolic-coefficient polynomials (slider coefficients stay exact).
  if let symPoly = exprPolyCoeffs(e, v) {
    var F: Expr = num(0)
    for (i, c) in symPoly.enumerated() {
      F = add(F, mul(div(c, num(Double(i + 1))), pow(vr(v), num(Double(i + 1)))))
    }
    return F
  }

  let single = varFs.count == 1 ? varFs[0] : nil

  // Table forms with a linear argument: f(a·v + b) → F(u)/a.
  if let single, single.exp == 1, let c = callParts(single.base) {
    if c.args.count == 1, let lin = linearIn(c.args[0], v), let T = tableCall(c.name, c.args[0]) {
      return div(T, lin.a)
    }
    // normalpdf/normalcdf in their first argument (mean and sd v-free).
    if c.name == "normalpdf" || c.name == "normalcdf", c.args.count == 3, isConstIn(c.args[1], v),
      isConstIn(c.args[2], v), let lin = linearIn(c.args[0], v)
    {
      let (x, m, s) = (c.args[0], c.args[1], c.args[2])
      let T =
        c.name == "normalpdf"
        ? call("normalcdf", x, m, s)
        : add(mul(sub(x, m), call("normalcdf", x, m, s)), mul(pow(s, num(2)), call("normalpdf", x, m, s)))
      return div(T, lin.a)
    }
  }

  // Powers of a linear argument: (a·v + b)^p for any constant p (p = −1 → ln).
  if let single, single.exp == 1, case .bin(.pow, let base, let p, _) = single.base {
    if isConstIn(p, v), let lin = linearIn(base, v) {
      if numValue(p) == -1 { return div(lnAbs(base), lin.a) }
      let p1 = add(p, num(1))
      return div(pow(base, p1), mul(lin.a, p1))
    }
    // c^(a·v + b) for a v-free base: c^u / (a ln c).
    let linExp = linearIn(p, v)
    if isConstIn(base, v), let linExp {
      return div(pow(base, p), mul(linExp.a, ln(base)))
    }
  }
  if let single, single.exp == -1, let lin = linearIn(single.base, v) {
    return div(lnAbs(single.base), lin.a)
  }
  // Negative powers of a linear argument: (a·v + b)^(−k).
  if let single, single.exp < -1, let lin = linearIn(single.base, v) {
    let p1 = Double(single.exp + 1)
    return div(pow(single.base, num(p1)), mul(lin.a, num(p1)))
  }

  // Gaussian integrals: exp(quadratic with negative leading coefficient) → erf.
  if let single, single.exp == 1, let c = callParts(single.base), c.name == "exp", c.args.count == 1,
    let q = exprPolyCoeffs(c.args[0], v), q.count == 3, let c2 = constVal(q[2]), c2 < 0
  {
    let k = (-c2).squareRoot()
    // exp(c₂v² + c₁v + c₀) = exp(c₀ − c₁²/4c₂) · exp(−(kv − c₁/2k)²)
    let shiftK = div(q[1], num(2 * k))  // c₁/(2k)
    let inner = sub(mul(num(k), vr(v)), shiftK)
    let amp = call("exp", add(q[0], pow(shiftK, num(2))))
    return mul(amp, mul(num(SQRT_PI / (2 * k)), call("erf", inner)))
  }

  // Trig powers and products.
  if let trig = try trigRule(varFs, v, depth) { return trig }

  // exp(a v + b) · sin/cos(c v + d): the classic closed form.
  if let expTrig = expTrigRule(varFs, v) { return expTrig }

  // Integration by parts: polynomial × table family.
  if let parts = try partsRule(varFs, v, depth) { return parts }

  // u-substitution: find u with e = g(u)·u′ structurally.
  return try uSubstitution(e, varFs, v, depth)
}

// MARK: - Trig products

/// sin^m(u)·cos^n(u) with a shared linear argument (odd powers via the
/// complementary substitution, even ones by power reduction / product-to-sum).
private func trigRule(_ factors: [Factor], _ v: String, _ depth: Int) throws -> Expr? {
  if factors.isEmpty { return nil }
  var names: [String] = []
  var args: [Expr] = []
  for f in factors {
    guard f.exp >= 1, let c = callParts(f.base), c.name == "sin" || c.name == "cos", c.args.count == 1,
      linearIn(c.args[0], v) != nil
    else { return nil }
    names.append(c.name)
    args.append(c.args[0])
  }

  // Distinct arguments: peel one pair with a product-to-sum identity.
  if factors.count >= 2, Set(args.map(key)).count > 1 {
    let (f1, f2) = (factors[0], factors[1])
    let (A, B) = (args[0], args[1])
    let (n1, n2) = (names[0], names[1])
    var rest: [Factor] = []
    if f1.exp > 1 { rest.append(Factor(base: f1.base, exp: f1.exp - 1)) }
    if f2.exp > 1 { rest.append(Factor(base: f2.base, exp: f2.exp - 1)) }
    rest += factors[2...]
    // Combine the arguments through their linear coefficients so repeated
    // peels fold: cos(2x − x − x) must become the CONSTANT cos(0), not an
    // expression that still looks like it depends on v.
    let lA = linearIn(A, v)!
    let lB = linearIn(B, v)!
    let argSub = add(mul(sub(lA.a, lB.a), vr(v)), sub(lA.b, lB.b))
    let argAdd = add(mul(add(lA.a, lB.a), vr(v)), add(lA.b, lB.b))
    func half(_ x: Expr) -> Expr { mul(num(0.5), x) }
    let sum: Expr
    if n1 == "sin" && n2 == "sin" {
      sum = sub(half(call("cos", argSub)), half(call("cos", argAdd)))
    } else if n1 == "cos" && n2 == "cos" {
      sum = add(half(call("cos", argSub)), half(call("cos", argAdd)))
    } else {
      // sin A · cos B, arranged so the sine carries A.
      let (aS, aC) = n1 == "sin" ? (lA, lB) : (lB, lA)
      let sPlus = add(mul(add(aS.a, aC.a), vr(v)), add(aS.b, aC.b))
      let sMinus = add(mul(sub(aS.a, aC.a), vr(v)), sub(aS.b, aC.b))
      sum = add(half(call("sin", sPlus)), half(call("sin", sMinus)))
    }
    let restE = rebuild(rest, false)
    return try anti(mul(sum, restE), v, depth + 1)
  }

  let u = args[0]
  let lin = linearIn(u, v)!
  var m = 0
  var n = 0
  for (f, name) in zip(factors, names) { if name == "sin" { m += f.exp } else { n += f.exp } }
  if m + n > 12 { return nil }

  // Odd sine power: t = cos u, sin² = 1 − t².
  if m % 2 == 1 { return div(oddTrigPoly(m, n, "cos", u), lin.a) }
  // Odd cosine power: t = sin u.
  if n % 2 == 1 { return div(oddTrigPoly(n, m, "sin", u), lin.a) }
  // Both even: reduce one sin² or cos² by its half-angle identity and recurse.
  let twoU = mul(num(2), u)
  if m >= 2 {
    let rest = mul(
      m - 2 >= 1 ? pow(call("sin", u), num(Double(m - 2))) : num(1),
      n >= 1 ? pow(call("cos", u), num(Double(n))) : num(1))
    let rewritten = mul(sub(num(0.5), mul(num(0.5), call("cos", twoU))), rest)
    return try anti(rewritten, v, depth + 1)
  }
  if n >= 2 {
    let rest = n - 2 >= 1 ? pow(call("cos", u), num(Double(n - 2))) : num(1)
    let rewritten = mul(add(num(0.5), mul(num(0.5), call("cos", twoU))), rest)
    return try anti(rewritten, v, depth + 1)
  }
  return nil
}

/// ∫ sin^m cos^n du with m odd (or the mirror): substitute t for the OTHER
/// function, expand (1 − t²)^((m−1)/2)·t^n, and integrate the polynomial.
/// Signs: dt = −sin u du for t = cos u, dt = +cos u du for t = sin u.
private func oddTrigPoly(_ oddPow: Int, _ evenPow: Int, _ tFn: String, _ u: Expr) -> Expr {
  // Polynomial in t: (1 − t²)^((odd−1)/2) · t^even.
  var poly: [Double] = [1]
  let half = (oddPow - 1) / 2
  for _ in 0..<half {
    var next = [Double](repeating: 0, count: poly.count + 2)
    for (k, c) in poly.enumerated() {
      next[k] += c
      next[k + 2] -= c
    }
    poly = next
  }
  let shifted = [Double](repeating: 0, count: evenPow) + poly
  // Integrate termwise, then substitute t = cos u (extra −1) or t = sin u.
  let sign: Double = tFn == "cos" ? -1 : 1
  var F: Expr = num(0)
  for (k, c) in shifted.enumerated() where c != 0 {
    F = add(F, mul(num((sign * c) / Double(k + 1)), pow(call(tFn, u), num(Double(k + 1)))))
  }
  return F
}

/// e^{av+b}·sin(cv+d) or ·cos(cv+d): e^u(a·trig − ...)/(a² + c²).
private func expTrigRule(_ factors: [Factor], _ v: String) -> Expr? {
  if factors.count != 2 { return nil }
  let ex = factors.first { $0.exp == 1 && callParts($0.base)?.name == "exp" }
  let tr = factors.first { f in
    f.exp == 1 && (callParts(f.base)?.name == "sin" || callParts(f.base)?.name == "cos")
  }
  guard let ex, let tr, let eArg = callParts(ex.base)?.args.first, let trig = callParts(tr.base),
    let tArg = trig.args.first, let la = linearIn(eArg, v), let lc = linearIn(tArg, v)
  else { return nil }
  let a = la.a
  let c = lc.a
  let den = add(pow(a, num(2)), pow(c, num(2)))
  let sinT = call("sin", tArg)
  let cosT = call("cos", tArg)
  let numTerm = trig.name == "sin" ? sub(mul(a, sinT), mul(c, cosT)) : add(mul(a, cosT), mul(c, sinT))
  return div(mul(ex.base, numTerm), den)
}

/// Call families whose DERIVATIVE is algebraic: by parts these are the u to
/// differentiate (∫x·ln x picks u = ln x, dv = x dx).
private let PARTS_DIFF: Set<String> = ["ln", "log", "atan", "asin", "acos", "atanh", "asinh", "acosh", "erf"]

/// Integration by parts for polynomial × one table family. The polynomial is
/// differentiated away for exp/trig partners; the logarithmic/inverse family
/// is differentiated instead (its derivative is algebraic), the polynomial
/// integrated.
private func partsRule(_ factors: [Factor], _ v: String, _ depth: Int) throws -> Expr? {
  if factors.count != 2 { return nil }
  let polyAt = factors.firstIndex { f in
    f.exp > 0 && f.exp <= 6 && exprPolyCoeffs(pow(f.base, num(Double(f.exp))), v) != nil
  }
  guard let polyAt else { return nil }
  let other = factors[1 - polyAt]
  if other.exp != 1 { return nil }
  let p = rebuild([factors[polyAt]], false)
  let g = other.base
  if let c = callParts(g), PARTS_DIFF.contains(c.name) {
    // ∫p·g = P·g − ∫P·g′ with P = ∫p: g′ is algebraic, so the rest recurses
    // into the rational/root rules instead of looping back here.
    guard let P = try anti(p, v, depth + 1), let dg = try? diff(g, v),
      let restF = try anti(mul(P, dg), v, depth + 1)
    else { return nil }
    return sub(mul(P, g), restF)
  }
  guard let G = try anti(g, v, depth + 1), let dp = try? diff(p, v), let restF = try anti(mul(dp, G), v, depth + 1)
  else { return nil }
  return sub(mul(p, G), restF)
}

// MARK: - u-substitution

/// Candidate inner functions: call arguments, non-trivial power bases and
/// exponents, denominators. In the order met, each once.
private func subCandidates(_ e: Expr, _ v: String, _ out: inout [Expr], _ seen: inout Set<String>) {
  func consider(_ u: Expr) {
    if case .var = u { return }
    if isConstIn(u, v) { return }
    if seen.insert(key(u)).inserted { out.append(u) }
  }
  switch e {
  case .neg(let a):
    subCandidates(a, v, &out, &seen)
  case .bin(let op, let a, let b, _):
    if op == .pow {
      consider(a)
      consider(b)
    }
    if op == .div { consider(b) }
    subCandidates(a, v, &out, &seen)
    subCandidates(b, v, &out, &seen)
  case .call(_, let args):
    consider(e)  // u may be the call itself: ln(x) in ln(x)/x
    for a in args {
      consider(a)
      subCandidates(a, v, &out, &seen)
    }
  default:
    return
  }
}

/// Structural replacement of a subexpression (by shape) with a variable.
private func replaceExpr(_ e: Expr, _ target: String, _ s: Expr) -> Expr {
  if key(e) == target { return s }
  switch e {
  case .neg(let a):
    return neg(replaceExpr(a, target, s))
  case .bin(let op, let a, let b, _):
    return .bin(op, replaceExpr(a, target, s), replaceExpr(b, target, s))
  case .call(let name, let args):
    return .call(name, args.map { replaceExpr($0, target, s) })
  default:
    return e
  }
}

/// Try e = g(u)·u′: for each candidate u, divide u′ out of the factor list
/// (structural cancellation, then exact polynomial division for what remains)
/// and check the quotient depends on v only through u.
private func uSubstitution(_ e: Expr, _ factors: [Factor], _ v: String, _ depth: Int) throws -> Expr? {
  var candidates: [Expr] = []
  var seen: Set<String> = []
  subCandidates(e, v, &candidates, &seen)
  for u in candidates {
    guard let du = try? diff(u, v), let ratio = divideOut(factors, du, v) else { continue }
    let s = "@u\(depth)"
    let inS = replaceExpr(ratio, key(u), vr(s))
    if freeVars(inS).contains(v) { continue }
    guard let G = try anti(inS, s, depth + 1) else { continue }
    return substAll(G, s, u)
  }
  return nil
}

/// e / du as an expression, by cancelling shared factors and finishing with
/// exact polynomial division; nil when the quotient will not come clean.
private func divideOut(_ eFactors: [Factor], _ du: Expr, _ v: String) -> Expr? {
  let (duNeg, duFs) = flatten(du)
  var left = eFactors
  var still: [Factor] = []
  var coefNum = 1.0
  for f in duFs {
    if isConstIn(f.base, v) {
      guard let c = constVal(f.base), c != 0 else { return nil }
      coefNum *= JS.pow(c, Double(f.exp))
      continue
    }
    let k = key(f.base)
    if let hit = left.firstIndex(where: { key($0.base) == k }), left[hit].exp >= f.exp {
      left[hit].exp -= f.exp
    } else {
      still.append(f)
    }
  }
  let remaining = left.filter { $0.exp != 0 }
  if still.isEmpty { return div(rebuild(remaining, duNeg), num(coefNum)) }
  // Whatever did not cancel structurally must divide the polynomial part.
  let duRest = rebuild(still, false)
  guard let dP = exprToPoly(duRest, v), dP.count >= 1 else { return nil }
  var polyFs: [Factor] = []
  var nonPoly: [Factor] = []
  for f in remaining {
    if f.exp > 0 && exprToPoly(pow(f.base, num(Double(f.exp))), v) != nil { polyFs.append(f) } else { nonPoly.append(f) }
  }
  guard let eP = exprToPoly(rebuild(polyFs, false), v) else { return nil }
  let (q, r) = fpdivmod(eP, dP)
  if !r.isEmpty { return nil }
  let out = mul(fpToExpr(q, v), rebuild(nonPoly, false))
  return div(duNeg ? neg(out) : out, num(coefNum))
}
