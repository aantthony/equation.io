#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

/// Probability distribution rows (lib/dist.ts, the part ahead of the sampled
/// system): what `X ~ Normal(mean, sd)` declares, the density and mass
/// expressions of each family, what `P(…)` and `E(…)` ask, and the exact
/// values a closed-form law answers them with.
///
/// Argument meaning by kind: normal [mean, sd]; uniform [lo, hi];
/// exponential [rate]; gamma [shape α, rate β]; beta [a, b]; chisquared [df];
/// studentt [df]; lognormal [mu, sigma] of the underlying normal; cauchy
/// [location, scale]; weibull [shape k, scale λ]; binomial [n, p]; bernoulli
/// [p]; poisson [mean]; geometric [p], the trial of the first success;
/// negbinomial [r, p], the failures before the r-th success; discreteuniform
/// [a, b], both included.
public struct BaseDist: Equatable, Sendable {
  public var kind: BaseKind
  public var args: [Expr]
}

/// A law on the whole numbers: it has a pmf (stems), a step cdf whose strict
/// and non-strict bounds differ, and no density for a shader.
func isDiscrete(_ d: BaseDist) -> Bool { familyOf(d.kind).discrete }

/// `name = value` for a message, short enough to read.
private func showParam(_ name: String, _ val: Double) -> String {
  "\(name) = \(JS.string(JS.number(JS.toPrecision(val, 6))))"
}

/// Why these parameter values declare no distribution, or nil when they do
/// (`paramProblem`). A parameter not known yet (a slider at parse time) is
/// nil or NaN: only what is known is judged.
func paramProblem(_ kind: BaseKind, _ a: [Double?]) -> String? {
  let family = familyOf(kind)
  for (k, param) in family.params.enumerated() {
    guard k < a.count, let val = a[k], !val.isNaN else { continue }
    let usage = distUsage(family)
    if param.positive && val <= 0 { return "\(usage) needs \(param.name) > 0." }
    if param.whole != .no && (wholeNumber(val).isNaN || (param.whole == .count && val < 0)) {
      return "\(usage) needs a whole number \(param.name)\(param.whole == .count ? " ≥ 0" : "") "
        + "(\(showParam(param.name, val)))."
    }
    if let unit = param.unit, !(val <= 1 && (unit == .closed ? val >= 0 : val > 0)) {
      return "\(usage) needs \(unit == .closed ? "0 ≤" : "0 <") \(param.name) ≤ 1."
    }
  }
  if a.count > 1, let lo = a[0], let hi = a[1] {
    if kind == .uniform && hi <= lo { return "Uniform(lo, hi) needs lo < hi." }
    if kind == .discreteuniform && hi < lo { return "DiscreteUniform(a, b) needs a ≤ b." }
  }
  return nil
}

/// The numeric value of a constant-folded expression, or nil (frees, NaN).
func numOf(_ e: Expr) -> Double? {
  guard let v = try? evaluate(e, [:]), v.isFinite else { return nil }
  return v
}

// MARK: - Scanning (the regular expressions of lib/dist.ts, by hand)

/// Detect a `name ~ rhs` row before parsing ('~' is not an expression
/// token): `^\s*(NAME)\s*~\s*([\s\S]+)$` (`scanDistribution`).
func scanDistribution(_ text: String) -> (name: String, rhs: String)? {
  var s = RowScanner(text)
  s.space()
  guard let name = s.name() else { return nil }
  s.space()
  guard s.eat("~"), !s.atEnd else { return nil }
  // `\s*` gives back what `[\s\S]+` needs: a right side of spaces alone is its last.
  let from = s.i
  s.space()
  if s.atEnd { s.i = max(from, s.end - 1) }
  return (canonicalName(name), String(s.u[s.i..<s.end]))
}

/// `^\s*head\s*\(([\s\S]+)\)\s*$`: the inner text of a `P(…)` or `E(…)` row.
private func matchCall(_ text: String, _ head: String) -> String? {
  var s = RowScanner(text)
  s.space()
  guard s.eat(word: head) else { return nil }
  s.space()
  guard s.eat("(") else { return nil }
  let rest = jsTrimEnd(s.u[s.i...])
  guard rest.last == unit(")"), rest.count >= 2 else { return nil }
  return String(rest.dropLast())
}

/// The inner text of a `P(…)` row, or nil if the row has another shape.
func matchProbability(_ text: String) -> String? { matchCall(text, "P") }

/// The inner text of an `E(…)` row, or nil if the row has another shape.
func matchExpectation(_ text: String) -> String? { matchCall(text, "E") }

private let DIST_HINT: String = {
  let all = DIST_FAMILIES.enumerated().map { k, f in (k == DIST_FAMILIES.count - 1 ? "or " : "") + distUsage(f) }
  return "Try \(all.joined(separator: ", "))."
}()

/// Parse the right side of `name ~ …` (`parseDistribution`). Family names
/// are matched case-insensitively and live in their own namespace, so they
/// collide with nothing a document defines.
func parseDistribution(_ rhs: String, fnNames: Set<String>, valueNames: Set<String> = []) throws -> BaseDist {
  // `^\s*(NAME)\s*(?:\(([\s\S]*)\))?\s*$`
  var s = RowScanner(rhs)
  s.space()
  var name: String?
  var inner: String?
  var matched = false
  if let written = s.name() {
    name = written
    s.space()
    if s.atEnd {
      matched = true
    } else if s.peek == unit("(") {
      let rest = jsTrimEnd(s.u[(s.i + 1)...])
      if rest.last == unit(")") {
        inner = String(rest.dropLast())
        matched = true
      }
    }
  }
  guard matched, let name, let spec = distFamily(name) else {
    throw LanguageError(
      matched && name != nil
        ? "Unknown distribution: \(name!). \(DIST_HINT)" : "Expected a distribution like Normal(0, 1).")
  }
  let arity = spec.params.count
  let arityError = LanguageError("\(distUsage(spec)) takes \(arity) argument\(arity > 1 ? "s" : "").")
  // A bare name takes the standard parameters: `X ~ N` is Normal(0, 1).
  guard let inner else {
    guard let defaults = spec.defaults else { throw arityError }
    return BaseDist(kind: spec.kind, args: defaults.map { .num($0) })
  }
  let args: Expr
  do {
    args = try parseExpr("(\(inner))", userFns: fnNames, valueNames: valueNames)
  } catch {
    if error.message.contains("vector components") { throw arityError }
    throw error
  }
  let items: [Expr] = if case .vec(let items) = args { items } else { [args] }
  if items.count != arity { throw arityError }
  // Written-out numbers are judged now; a slider's value is judged when it is
  // known (RVSystem.paramProblem), and flattens the density to 0 meanwhile.
  if let problem = paramProblem(spec.kind, items.map(numOf)) { throw LanguageError(problem) }
  return BaseDist(kind: spec.kind, args: items)
}

// MARK: - Densities and masses as expressions

private func bin(_ op: BinOp, _ a: Expr, _ b: Expr) -> Expr { .bin(op, a, b) }
private func chain(_ lo: Expr, _ mid: Expr, _ hi: Expr) -> Expr { .ineq(.lt, .ineq(.lt, lo, mid), hi) }
private func positive(_ e: Expr) -> Expr { .ineq(.gt, e, .num(0)) }

/// `value` where every condition holds, 0 elsewhere (nested piecewise = AND).
private func whereAll(_ conds: [Expr], _ value: Expr) -> Expr {
  conds.reversed().reduce(value) { inner, cond in
    .piecewise([Expr.Case(cond: cond, value: inner)], otherwise: .num(0))
  }
}

/// The discrete families reduced to the four that have an implementation,
/// once: Bernoulli(p) is Binomial(1, p), and Geometric(p) — trials, from 1 —
/// is 1 + NegativeBinomial(1, p). Everything downstream reads this and
/// applies `shift` (`canonicalDiscrete`).
enum CoreKind { case binomial, poisson, negbinomial, discreteuniform }

func canonicalDiscrete(_ d: BaseDist) -> (kind: CoreKind, fn: String, args: [Expr], shift: Double)? {
  switch d.kind {
  case .binomial: (.binomial, BINOM_PMF_FN, d.args, 0)
  case .bernoulli: (.binomial, BINOM_PMF_FN, [.num(1), d.args[0]], 0)
  case .poisson: (.poisson, POISSON_PMF_FN, d.args, 0)
  case .geometric: (.negbinomial, NEGBINOM_PMF_FN, [.num(1), d.args[0]], 1)
  case .negbinomial: (.negbinomial, NEGBINOM_PMF_FN, d.args, 0)
  case .discreteuniform: (.discreteuniform, DUNIFORM_PMF_FN, d.args, 0)
  default: nil
  }
}

/// The pmf of a discrete law at `k`: P(X = k). Exactly 0 off the support, at
/// a k that is not a whole number, and while a parameter is invalid. Nil for
/// a continuous law (`pmfExpr`).
func pmfExpr(_ d: BaseDist, _ k: Expr) -> Expr? {
  guard let c = canonicalDiscrete(d) else { return nil }
  return .call(c.fn, [c.shift != 0 ? bin(.sub, k, .num(c.shift)) : k] + c.args)
}

/// The exact pdf of a base distribution at `x`, piecewise where the support
/// ends (`pdfExpr`). For a discrete law this is its pmf, which must never be
/// handed to a shader as a curve (densityExpr and regionExpr refuse).
func pdfExpr(_ d: BaseDist, _ x: Expr) -> Expr {
  if let pmf = pmfExpr(d, x) { return pmf }
  let a = d.args
  switch d.kind {
  case .normal:
    return .call("normalpdf", [x, a[0], a[1]])
  case .uniform:
    // The condition is empty while hi <= lo (mid slider drag), so the pdf
    // degrades to 0 everywhere instead of going negative.
    return .piecewise(
      [Expr.Case(cond: chain(a[0], x, a[1]), value: bin(.div, .num(1), bin(.sub, a[1], a[0])))], otherwise: .num(0))
  case .exponential:
    // max(rate, 0): a non-positive rate flattens to 0 rather than blowing up.
    let r = Expr.call("max", [a[0], .num(0)])
    return .piecewise(
      [Expr.Case(cond: .ineq(.ge, x, .num(0)), value: bin(.mul, r, .call("exp", [.neg(bin(.mul, r, x))])))],
      otherwise: .num(0))
  // The next four are builtins with a CPU and a GLSL twin rather than
  // spelled-out formulas: x^(α−1)e^(−βx)/Γ(α) written out overflows float32
  // from α ≈ 35, and a pole or a support edge needs a branch.
  case .gamma:
    return .call(GAMMA_PDF_FN, [x, a[0], a[1]])
  case .chisquared:  // ChiSquared(k) is Gamma(k/2, rate 1/2)
    return .call(GAMMA_PDF_FN, [x, bin(.div, a[0], .num(2)), .num(0.5)])
  case .beta:
    return .call(BETA_PDF_FN, [x, a[0], a[1]])
  case .studentt:
    return .call(T_PDF_FN, [x, a[0]])
  case .weibull:
    return .call(WEIBULL_PDF_FN, [x, a[0], a[1]])
  case .lognormal:
    // normalpdf(ln x)/x on x > 0; the sigma > 0 guard flattens a bad slider.
    return whereAll(
      [positive(a[1]), positive(x)], bin(.div, .call("normalpdf", [.call("ln", [x]), a[0], a[1]]), x))
  case .cauchy:
    let z = bin(.div, bin(.sub, x, a[0]), a[1])
    return whereAll(
      [positive(a[1])],
      bin(.div, .num(1), bin(.mul, bin(.mul, .num(Double.pi), a[1]), bin(.add, .num(1), bin(.mul, z, z)))))
  case .binomial, .poisson, .geometric, .negbinomial, .bernoulli, .discreteuniform:
    preconditionFailure("a discrete law is answered by pmfExpr")
  }
}

private let NO_DENSITY = "A discrete distribution has no density curve: it draws as stems."

/// The density curve for a base random variable: y = pdf(x).
func densityExpr(_ d: BaseDist) throws -> Expr {
  if isDiscrete(d) { throw LanguageError(NO_DENSITY) }
  return .eq(.var("y"), pdfExpr(d, .var("x")))
}

/// A readout's number: to `places` decimals while that is a number a reader
/// can take in, else (and without `places`) six significant digits
/// (`readoutNumber`).
func readoutNumber(_ x: Double, _ places: Int? = nil) -> String {
  if let places, abs(x) < 1e15 { return JS.toFixed(x, places) }
  return JS.string(JS.number(JS.toPrecision(x, 6)))
}

/// The readout of an `E(…)` row whose mean is not a number.
let NO_MEAN_INFO = "no stable mean (heavy tails)"

// MARK: - Probability specs

/// Constant bounds around one variable. Whether a bound is strict is kept
/// because a discrete law cares: P(X < 3) and P(X <= 3) differ by P(X = 3).
public struct ProbBounds: Equatable, Sendable {
  public var lo: Expr?
  public var hi: Expr?
  /// The bound is `<`/`>`, not `<=`/`>=`: its endpoint is excluded. Nil
  /// where the bound is not written as a comparison.
  public var loStrict: Bool?
  public var hiStrict: Bool?
  /// A point event, `P(X = c)` (lo = hi = c, both included) or, with `not`,
  /// its complement `P(X != c)`. Only a discrete variable has these.
  public var point = false
  public var not = false

  public init(
    lo: Expr? = nil, hi: Expr? = nil, loStrict: Bool? = nil, hiStrict: Bool? = nil, point: Bool = false,
    not: Bool = false
  ) {
    self.lo = lo
    self.hi = hi
    self.loStrict = loStrict
    self.hiStrict = hiStrict
    self.point = point
    self.not = not
  }
}

/// The variable a `P(…)` row bounds, with its bounds: what is shaded.
public struct ProbShade: Equatable, Sendable {
  public var rv: String
  public var bounds: ProbBounds

  public init(rv: String, bounds: ProbBounds) {
    self.rv = rv
    self.bounds = bounds
  }
}

struct ProbSpec {
  /// The event to estimate, resolved: an inequality (chain), or the equation of a point event.
  var body: Expr
  /// Random variables the body references.
  var rvs: [String]
  /// The body is a point event (`=`, `==`, `!=`): only discrete variables have those.
  var point = false
  /// Present when the body is constant bounds around one bare variable
  /// (`P(a < X < b)`): the shadeable — and for closed-form laws, exact — case.
  var single: ProbShade?
  /// Bounds around one variable-bearing expression (`P(0.5 < X + Y < 1.5)`):
  /// the same case once the caller registers the expression as an anonymous
  /// derived variable.
  var inline: (e: Expr, bounds: ProbBounds)?
}

private let POINT_SHAPE = "P(… = …) compares single values, like P(X = 3) or P(X = Y)."
private let plotCoordinates: Set<String> = ["x", "y", "z", "u", "v", "w"]

/// Interpret a parsed P(…) body against the declared random variables (`toProbability`).
func toProbability(_ e: Expr, _ rvNames: Set<String>) throws -> ProbSpec {
  // `=` parses as an equation, `==` and `!=` as the filter comparisons.
  var point: (l: Expr, r: Expr, not: Bool)?
  switch e {
  case .eq(let l, let r): point = (l, r, false)
  case .eqtest(let op, let l, let r): point = (l, r, op == .ne)
  case .ineq: break
  default: throw LanguageError("P(…) expects an inequality like P(X < 2).")
  }
  let frees = freeVars(e)
  let rvs = frees.list.filter(rvNames.contains)
  if rvs.isEmpty {
    throw LanguageError("P(…) must reference a random variable, e.g. X ~ Normal(0, 1) then P(X < 2).")
  }
  for n in frees where plotCoordinates.contains(n) {
    throw LanguageError("P(…) cannot use the plot coordinate \(n).")
  }
  func bearing(_ t: Expr) -> Bool { freeVars(t).contains(where: rvNames.contains) }
  if let point {
    func scalar(_ t: Expr) -> Bool {
      switch t {
      case .vec, .ineq, .eq, .list: false
      default: true
      }
    }
    if !scalar(point.l) || !scalar(point.r) { throw LanguageError(POINT_SHAPE) }
    // Random on both sides (`P(X = Y)`): a joint event, like `P(X > Y)`.
    if bearing(point.l) && bearing(point.r) { return ProbSpec(body: e, rvs: rvs, point: true) }
    let (t, at) = bearing(point.l) ? (point.l, point.r) : (point.r, point.l)
    let bounds = ProbBounds(lo: at, hi: at, point: true, not: point.not)
    if case .var(let name) = t {
      return ProbSpec(body: e, rvs: rvs, point: true, single: ProbShade(rv: name, bounds: bounds))
    }
    return ProbSpec(body: e, rvs: rvs, point: true, inline: (t, bounds))
  }
  let comps = ineqComparisons(e)
  func less(_ op: IneqOp) -> Bool { op == .lt || op == .le }
  if Set(comps.map { less($0.op) }).count > 1 {
    throw LanguageError("Chained inequalities must point the same way.")
  }
  // Normalize to ascending order so the terms read lo … X … hi; each
  // comparison keeps whether it was strict.
  var asc = comps.map { c in
    (l: less(c.op) ? c.l : c.r, r: less(c.op) ? c.r : c.l, strict: c.op == .lt || c.op == .gt)
  }
  if !less(comps[0].op) { asc.reverse() }
  let terms = [asc[0].l] + asc.map(\.r)
  var spec = ProbSpec(body: e, rvs: rvs)

  // `lo < … < hi` with exactly one variable-bearing term and variable-free
  // bounds on its immediate sides shades (and computes exactly when a law is
  // derivable): a bare name yields `single`, an expression `inline`. Anything
  // else — P(Y > X), extra constraints beyond the bounds — samples.
  if let idx = terms.firstIndex(where: bearing), terms.count <= 3, idx <= 1, idx >= terms.count - 2,
    !terms.enumerated().contains(where: { $0.offset != idx && bearing($0.element) })
  {
    let t = terms[idx]
    var bounds = ProbBounds()
    if idx > 0 {
      bounds.lo = terms[idx - 1]
      bounds.loStrict = asc[idx - 1].strict
    }
    if idx < terms.count - 1 {
      bounds.hi = terms[idx + 1]
      bounds.hiStrict = asc[idx].strict
    }
    if case .var(let name) = t, rvNames.contains(name) {
      spec.single = ProbShade(rv: name, bounds: bounds)
    } else {
      spec.inline = (t, bounds)
    }
  }
  return spec
}

/// Interpret a parsed E(…) body against the declared random variables
/// (`toExpectation`): the scalar expression to average, and the variables it references.
func toExpectation(_ e: Expr, _ rvNames: Set<String>) throws -> (body: Expr, rvs: [String]) {
  switch e {
  case .ineq:
    throw LanguageError("E(…) expects a value like E(X + Y); the chance of an event is P(…).")
  case .eq, .vec, .list:
    throw LanguageError("E(…) expects a single value, like E(X + Y).")
  default: break
  }
  let frees = freeVars(e)
  let rvs = frees.list.filter(rvNames.contains)
  if rvs.isEmpty {
    throw LanguageError("E(…) must reference a random variable, e.g. X ~ Normal(0, 1) then E(X).")
  }
  for n in frees where plotCoordinates.contains(n) {
    throw LanguageError("E(…) cannot use the plot coordinate \(n).")
  }
  return (e, rvs)
}

/// The shaded region for an exact probability: the area between the x-axis
/// and the density, clipped to the bounds. Each part is normalized to F < 0
/// and combined with max() (intersection); '<=' gives the region a drawn
/// outline (`regionExpr`).
func regionExpr(_ d: BaseDist, _ lo: Expr?, _ hi: Expr?) throws -> Expr {
  if isDiscrete(d) { throw LanguageError(NO_DENSITY) }
  let x = Expr.var("x")
  let y = Expr.var("y")
  var f = bin(.sub, y, pdfExpr(d, x))  // y < pdf(x)
  var parts: [Expr] = [.neg(y)]  // 0 < y
  if let lo { parts.append(bin(.sub, lo, x)) }  // lo < x
  if let hi { parts.append(bin(.sub, x, hi)) }  // x < hi
  for part in parts { f = .call("max", [f, part]) }
  return .ineq(.le, f, .num(0))
}

/// Exact (P(X ≤ x), P(X > x)) of a base distribution; NaN while the
/// parameters are invalid. Both tails, each computed on its own side where
/// the law allows it (`cdfPQ`).
private func cdfPQ(_ d: BaseDist, _ x: Double, _ env: [String: Double]) throws -> (Double, Double) {
  let a = try d.args.map { try evaluate($0, env) }
  if x.isNaN || !a.allSatisfy(\.isFinite) || paramProblem(d.kind, a) != nil { return (.nan, .nan) }
  switch d.kind {
  case .normal:
    // The mirror image is the upper tail (normalcdf is the shader's erf twin).
    return (normalcdf(x, a[0], a[1]), normalcdf(2 * a[0] - x, a[0], a[1]))
  case .uniform:
    let p = JS.min([1, JS.max([0, (x - a[0]) / (a[1] - a[0])])])
    return (p, 1 - p)
  case .exponential:
    return x <= 0 ? (0, 1) : (-expm1(-a[0] * x), exp(-a[0] * x))
  case .gamma:
    return gammaPQ(a[0], a[1] * x)
  case .chisquared:
    return gammaPQ(a[0] / 2, x / 2)
  case .beta:
    return betaPQ(a[0], a[1], x)
  case .studentt:
    return studentTPQ(a[0], x)
  case .lognormal:
    return x <= 0 ? (0, 1) : normalPQ((log(x) - a[0]) / a[1])
  case .cauchy:
    // atan(1/z) is the tail itself; ½ − atan(z)/π would cancel it away.
    let z = (x - a[0]) / a[1]
    if z == 0 { return (0.5, 0.5) }
    let tail = atan(1 / abs(z)) / Double.pi
    return z > 0 ? (1 - tail, tail) : (tail, 1 - tail)
  case .weibull:
    if x <= 0 { return (0, 1) }
    let w = JS.pow(x / a[1], a[0])
    return (-expm1(-w), exp(-w))
  case .binomial, .poisson, .geometric, .negbinomial, .bernoulli, .discreteuniform:
    // (probabilityValue answers those itself; kept total.)
    return try discreteLaw(d, env)?.pq(x) ?? (.nan, .nan)
  }
}

/// The whole numbers a P(…) over a discrete variable selects: kLo ≤ X ≤ kHi
/// (either may be infinite; empty when kLo > kHi), or with `not` all the
/// rest. This is where strictness lands: `X < 3` ends at 2, `X <= 3` at 3
/// (`integerBounds`).
func integerBounds(_ b: ProbBounds, _ env: [String: Double]) throws -> (kLo: Double, kHi: Double, not: Bool) {
  // A bound within rounding of a whole number is that number, by the same
  // tolerance the parameters get (wholeNumber).
  func snap(_ x: Double) -> Double {
    let w = wholeNumber(x)
    return w.isNaN ? x : w
  }
  let lo = snap(try b.lo.map { try evaluate($0, env) } ?? -.infinity)
  let hi = snap(try b.hi.map { try evaluate($0, env) } ?? .infinity)
  return (
    b.loStrict == true ? lo.rounded(.down) + 1 : lo.rounded(.up),
    b.hiStrict == true ? hi.rounded(.up) - 1 : hi.rounded(.down), b.not
  )
}

/// Runs of at most this many whole numbers are summed term by term.
private let SUM_RUN = 64.0

/// Exact value of P(lo < X < hi) under the given constant environment
/// (`probabilityValue`). For a discrete law `edges` says which bounds are
/// strict (and whether the event is a complement): the value is the exact
/// mass of the selected whole numbers.
func probabilityValue(
  _ d: BaseDist, _ lo: Expr?, _ hi: Expr?, _ env: [String: Double], edges: ProbBounds? = nil
) throws -> Double {
  if isDiscrete(d) {
    let law = try discreteLaw(d, env)
    let bounds = ProbBounds(
      lo: lo, hi: hi, loStrict: edges?.loStrict, hiStrict: edges?.hiStrict, not: edges?.not ?? false)
    let (kLo, kHi, not) = try integerBounds(bounds, env)
    guard let law, !kLo.isNaN, !kHi.isNaN else { return .nan }  // invalid parameters or bounds
    if kLo > kHi { return not ? 1 : 0 }
    // A short run is the sum of its masses, not a difference of two cdfs.
    if !not && kHi - kLo < SUM_RUN {
      var sum = 0.0
      var k = kLo
      while k <= kHi {
        sum += law.pmf(k)
        k += 1
      }
      return sum
    }
    let L = kLo == -.infinity ? (0, 1) : law.pq(kLo - 1)
    let H = kHi == .infinity ? (1, 0) : law.pq(kHi)
    // The complement is below kLo plus above kHi, each from its own tail;
    // the event itself differences whichever side is the small one.
    if not { return L.0 + H.1 }
    return L.0 > 0.5 ? L.1 - H.1 : H.0 - L.0
  }
  let L = try lo.map { try cdfPQ(d, try evaluate($0, env), env) }
  let H = try hi.map { try cdfPQ(d, try evaluate($0, env), env) }
  guard let L else { return H?.0 ?? 1 }
  guard let H else { return L.1 }
  // Both bounds in the upper half: difference the (small) survival values.
  return L.0 > 0.5 ? L.1 - H.1 : H.0 - L.0
}

// MARK: - Row scanning

struct RandomScan {
  /// `name ~ …` rows, by row, in row order.
  var base: [(row: Int, name: String, rhs: String)] = []
  /// `name = rhs` rows whose right side mentions a random variable, in the order the scan found them.
  var derived: [(row: Int, name: String, rhs: String)] = []

  var names: [String] { base.map(\.name) + derived.map(\.name) }
  var rows: Set<Int> { Set(base.map(\.row) + derived.map(\.row)) }
}

/// Decide which rows declare random variables, before definitions are built
/// (`scanRandomRows`). `base` rows are `name ~ …`; `derived` rows are
/// `name = rhs` where the rhs mentions a random variable, transitively. Rows
/// the caller has already claimed (comments, sequences, fits) arrive as nil.
/// Matching is textual by design, by the tokenizer's identifier rule: `2X`
/// mentions X while `aX`, `X_1` and `X2` are their own names.
func scanRandomRows(_ texts: [String?]) -> RandomScan {
  var scan = RandomScan()
  var names: Set<String> = []
  var candidates: [(row: Int, name: String, rhs: String)] = []
  for (i, text) in texts.enumerated() {
    guard let text, !text.isEmpty else { continue }
    if let found = scanDistribution(text) {
      scan.base.append((i, found.name, found.rhs))
      names.insert(found.name)
      continue
    }
    // `^\s*(NAME)\s*=(?!=)([\s\S]+)$`
    var s = RowScanner(text)
    s.space()
    guard let written = s.name() else { continue }
    s.space()
    // The name must be claimable as a definition (`e = X` stays an equation).
    if let rhs = s.assignment(), nameable(canonicalName(written)) {
      candidates.append((i, canonicalName(written), rhs))
    }
  }
  var changed = !names.isEmpty
  while changed {
    changed = false
    var rest: [(row: Int, name: String, rhs: String)] = []
    for c in candidates {
      // (A row taken this pass is a random variable to the rows after it at once.)
      guard randomNameIn(c.rhs, names) != nil else {
        rest.append(c)
        continue
      }
      scan.derived.append(c)
      names.insert(c.name)
      changed = true
    }
    candidates = rest
  }
  return scan
}

/// The first random variable a row's text names, if any: the scan's own
/// identifier rule, so `2X` mentions X and `X2` does not.
func randomNameIn(_ text: String, _ names: Set<String>) -> String? {
  writtenNames(text).first(where: names.contains)
}

/// Every call that is a whole row rather than a value, by the name the user
/// writes (lib/complex.ts `WHOLE_EXPR_NAMES`, lib/geom.ts `GEOM_STATEMENTS`).
private let wholeRowCalls: Set<String> = [
  "domain", "conformal", "iter", "rgb", "hsl", "oklch", "tube", "revolve", "trail", "label", "segment", "polyline",
  "vector", "line", "polygon", "square", "circle", "hull",
]

/// A whole-row form or geometry statement is a picture, never a value, so an
/// expression holding one is not a derived random variable (`wholeRowForm`).
private func wholeRowForm(_ e: Expr, _ rvNames: Set<String>) throws {
  let kids: [Expr]
  switch e {
  case .neg, .bin, .call, .piecewise, .ineq, .eq, .vec, .list: kids = childrenOf(e)
  default: kids = []
  }
  if case .call(let name, _) = e, !rvNames.isEmpty, wholeRowCalls.contains(name) {
    throw LanguageError(
      freeVars(e).contains(where: rvNames.contains)
        ? "\(name)(…) cannot take a random variable." : "\(name)(…) must be the whole expression.")
  }
  for k in kids { try wholeRowForm(k, rvNames) }
}

/// Validate a resolved right-hand side as a derived random variable: a real
/// scalar in random variables, constants, and t (`checkDerived`).
func checkDerived(_ e: Expr, _ rvNames: Set<String>, _ constNames: Set<String>) throws {
  switch e {
  case .eq, .ineq, .vec, .list: throw LanguageError("A random variable must be a single value.")
  default: break
  }
  try wholeRowForm(e, rvNames)
  if usesComplex(e) { throw LanguageError("Random variables are real-valued.") }
  for n in freeVars(e) {
    if rvNames.contains(n) || constNames.contains(n) || n == "t" { continue }
    if ["x", "y", "z", "u", "v"].contains(n) {
      throw LanguageError("A random variable cannot depend on the plot coordinate \(n).")
    }
    throw LanguageError("\(n) is not defined.")
  }
}
