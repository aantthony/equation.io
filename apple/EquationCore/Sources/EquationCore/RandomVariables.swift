#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

/// The declared random variables of a document (lib/dist.ts `RVSystem`), for
/// the tiers that answer from a law: a closed-form density or mass function
/// (a declaration, or a derived variable a closure rule reduces to one), and
/// a sum of uniforms (an exact piecewise polynomial).
///
/// A variable built on discrete bases alone that has no law of its own is
/// enumerated (DiscreteEnumeration.swift). What the site answers by
/// quadrature against a base law, or from its joint sample, is not ported:
/// those paths throw `Unsupported`, and the row says so.

/// A random variable: a declaration `X ~ Normal(0, 1)`, or an expression in
/// others, `Y = X^2` (lib/dist.ts `RV`).
public enum RV: Equatable, Sendable {
  case base(name: String, dist: BaseDist)
  case derived(name: String, expr: Expr)

  public var name: String {
    switch self {
    case .base(let name, _), .derived(let name, _): name
    }
  }
}

/// A density drawn on the CPU (lib/dist.ts `DensityCurve`).
public struct DensityCurve: Equatable, Sendable {
  /// Flat [x0, y0, x1, y1, …] polyline of the density.
  public var pts: [Double]
  public var mean: Double
  public var sd: Double
  /// Fraction of the mass that is defined.
  public var mass: Double

  /// A curve drawn `k` times as tall: a row over continuous intervals is
  /// drawn against their length measure, not a probability (`scaleCurve`).
  public func scaled(_ k: Double) -> DensityCurve {
    if k == 1 { return self }
    var out = self
    out.pts = pts.enumerated().map { $0.offset % 2 == 1 ? $0.element * k : $0.element }
    return out
  }

  /// Linear interpolation of the polyline at x, 0 outside its range (`densityAt`).
  public func density(at x: Double) -> Double {
    let p = pts
    var i = 0
    while i + 3 < p.count {
      if x >= p[i] && x <= p[i + 2] {
        let span = p[i + 2] - p[i]
        let f = (x - p[i]) / (span != 0 && !span.isNaN ? span : 1)
        return p[i + 1] + f * (p[i + 3] - p[i + 1])
      }
      i += 2
    }
    return 0
  }

  /// The curve clipped to [lo, hi] and closed down to the x-axis: the
  /// polygon a `P(…)` row fills. Nil when the clip is empty (`shadePolygon`).
  public func shadePolygon(lo: Double?, hi: Double?) -> [Double]? {
    let p = pts
    if p.count < 4 { return nil }
    let xlo = lo ?? p[0]
    let xhi = hi ?? p[p.count - 2]
    if !(xhi > xlo) { return nil }
    var out = [xlo, 0, xlo, density(at: xlo)]
    var i = 0
    while i < p.count {
      if p[i] > xlo && p[i] < xhi { out += [p[i], p[i + 1]] }
      i += 2
    }
    out += [xhi, density(at: xhi), xhi, 0]
    return out
  }
}

/// A linear combination Σ coef·name + c over the *base* names of random
/// variables. Affine forms over closed families have exact laws.
private struct Affine {
  /// In the order the names were first met, as a JavaScript `Map` keeps them.
  var terms: [(name: String, coef: Expr)]
  var c: Expr
}

/// An exact law: a closed-form pdf the shader draws, or a uniform-sum
/// convolution evaluated as an exact piecewise polynomial per parameters.
enum Law {
  case dist(BaseDist)
  case usum(terms: [(c: Expr, lo: Expr, hi: Expr)], d: Expr)
}

/// What a derived row's readout says (lib/dist.ts `RVSystem.moments`).
enum Moments {
  case exact(mean: Double, sd: Double, mass: Double, note: String?)
  case estimate(mean: Double, sd: Double, mass: Double, note: String?)
  case robust(median: Double, iqr: Double, meanOk: Bool, mass: Double, note: String?)
}

/// A derived row's readout, from the moments' verdict: `μ = …, σ = …` under
/// an exact law, `≈` for an estimate, median/IQR where the tails make μ and σ
/// truncation artifacts; then what part of the mass is defined, and the
/// verdict's note (`momentsReadout`).
func momentsReadout(_ m: Moments) -> String {
  func about(_ x: Double) -> String { readoutNumber(x, 3) }
  let head: String
  let mass: Double
  let note: String?
  switch m {
  case .exact(let mean, let sd, let ms, let n):
    head = "μ = \(readoutNumber(mean)), σ = \(readoutNumber(sd))"
    (mass, note) = (ms, n)
  case .robust(let median, let iqr, let meanOk, let ms, let n):
    head = "median ≈ \(about(median)), IQR ≈ \(about(iqr)) (heavy tails: \(meanOk ? "σ" : "μ, σ") unstable)"
    (mass, note) = (ms, n)
  case .estimate(let mean, let sd, let ms, let n):
    head = "μ ≈ \(about(mean)), σ \(sd.isFinite ? "≈ \(about(sd))" : sd == .infinity ? "= ∞" : "unstable")"
    (mass, note) = (ms, n)
  }
  return head + (mass < 0.9995 ? ", P(defined) ≈ \(JS.toFixed(mass, 3))" : "") + (note.map { " (\($0))" } ?? "")
}

private func bin(_ op: BinOp, _ a: Expr, _ b: Expr) -> Expr { .bin(op, a, b) }

public struct RVSystem: Equatable, Sendable {
  /// Every variable by name: the document's declarations, and the anonymous
  /// ones of expression rows (`@3`, `@P5`, `@E7`), which have engine-owned
  /// names outside the user namespace.
  private var rvs: [String: RV] = [:]
  /// The names in the order they were declared.
  private var order: [String] = []

  init(_ declarations: [RV] = []) {
    for rv in declarations { add(rv) }
  }

  private mutating func add(_ rv: RV) {
    if rvs.updateValue(rv, forKey: rv.name) == nil { order.append(rv.name) }
  }

  /// Expression rows have engine-owned names outside the user namespace.
  mutating func addAnonymous(_ rv: RV) throws {
    if !rv.name.hasPrefix("@") { throw LanguageError("Anonymous random variables need an internal name.") }
    if rvs[rv.name] != nil { throw LanguageError("\(rv.name) is already defined.") }
    add(rv)
  }

  public func has(_ name: String) -> Bool { rvs[name] != nil }
  public func get(_ name: String) -> RV? { rvs[name] }
  public var isEmpty: Bool { rvs.isEmpty }

  // MARK: What a variable is built on

  /// The base variables a variable is built on, through every derived one.
  private func basesOf(_ name: String) -> [String] {
    var out: [String] = []
    var seen: Set<String> = []
    func walk(_ n: String) {
      if !seen.insert(n).inserted { return }
      switch rvs[n] {
      case .base: out.append(n)
      case .derived(_, let expr): for dep in freeVars(expr) { walk(dep) }
      case nil: break
      }
    }
    walk(name)
    return out
  }

  func baseDist(_ name: String) -> BaseDist? {
    if case .base(_, let dist)? = rvs[name] { return dist }
    return nil
  }

  /// Random variables of `e` that are not discrete (see isDiscreteVar).
  private func continuousIn(_ e: Expr) -> [String] {
    freeVars(e).list.filter { rvs[$0] != nil && !isDiscreteVar($0) }
  }

  /// Whether a variable is discrete: built on discrete bases only. Decided
  /// by the declarations, never by parameter values, so a row is a pmf row or
  /// a density row for good. One continuous base makes it a continuous
  /// mixture, which is not discrete.
  public func isDiscreteVar(_ name: String) -> Bool {
    let bases = basesOf(name)
    return !bases.isEmpty && bases.allSatisfy { isDiscrete(baseDist($0)!) }
  }

  /// Constants that are a whole-number parameter of a discrete law (the n of
  /// `X ~ Binomial(n, p)`, written as the bare name): their sliders step by
  /// 1, as a Σ bound's does, so a drag never lands on n = 2.5.
  public func wholeParamNames() -> Set<String> {
    var out: Set<String> = []
    for name in order {
      guard let dist = baseDist(name), isDiscrete(dist) else { continue }
      for (k, param) in familyOf(dist.kind).params.enumerated() where param.whole != .no {
        if case .var(let arg) = dist.args[k] { out.insert(arg) }
      }
    }
    return out
  }

  /// What a P(…) row may ask, judged against the declarations: a point event
  /// (`P(X = 3)`, `P(X = Y)`) only of discrete variables. With a continuous
  /// one anywhere in it the event has probability 0 by definition, and saying
  /// 0 would hide that the question was probably meant as an interval.
  func checkProbability(_ spec: ProbSpec) throws {
    if !spec.point { return }
    let continuous = continuousIn(spec.body)
    if continuous.isEmpty { return }
    if let single = spec.single {
      throw LanguageError(
        "P(\(single.rv) \(single.bounds.not ? "!=" : "=") …) needs a discrete variable: a continuous one"
          + " takes any single value with probability 0. Ask about an interval, like P(a < \(single.rv) < b).")
    }
    throw LanguageError(
      "P(… = …) needs discrete variables, and \(continuous.joined(separator: ", ")) "
        + "\(continuous.count > 1 ? "are" : "is") not:"
        + " a continuous value equals any given one with probability 0. Ask about an interval, like P(a < … < b).")
  }

  /// Non-random free names the variable depends on, transitively (may include 't').
  public func paramsOf(_ name: String) -> NameSet {
    var out = NameSet()
    var seen: Set<String> = []
    func walk(_ n: String) {
      if !seen.insert(n).inserted { return }
      guard let rv = rvs[n] else { return }
      var frees = NameSet()
      switch rv {
      case .base(_, let dist):
        for a in dist.args {
          for f in freeVars(a) { frees.insert(f) }
        }
      case .derived(_, let expr): frees = freeVars(expr)
      }
      for f in frees {
        if rvs[f] != nil { walk(f) } else { out.insert(f) }
      }
    }
    walk(name)
    return out
  }

  /// Non-random free names of a P(…) body, through the variables it references.
  func bodyParams(_ e: Expr) -> NameSet {
    var out = NameSet()
    for f in freeVars(e) {
      if rvs[f] != nil {
        for p in paramsOf(f) { out.insert(p) }
      } else {
        out.insert(f)
      }
    }
    return out
  }

  // MARK: Exact laws

  private func rvFree(_ x: Expr) -> Bool { !freeVars(x).contains { rvs[$0] != nil } }

  /// Decompose an expression as an affine form over base names, or nil
  /// where that fails (nonlinear use of a variable).
  private func affine(_ e: Expr) -> Affine? {
    if rvFree(e) { return Affine(terms: [], c: e) }
    func scale(_ af: Affine?, _ k: Expr) -> Affine? {
      guard let af else { return nil }
      return Affine(terms: af.terms.map { ($0.name, bin(.mul, k, $0.coef)) }, c: bin(.mul, k, af.c))
    }
    switch e {
    case .var(let name):
      if case .base = rvs[name] { return Affine(terms: [(name, .num(1))], c: .num(0)) }
      return affineOf(name)
    case .neg(let a):
      return scale(affine(a), .num(-1))
    case .bin(let op, let lhs, let rhs, _):
      switch op {
      case .add, .sub:
        guard let a = affine(lhs), let b = op == .sub ? scale(affine(rhs), .num(-1)) : affine(rhs) else {
          return nil
        }
        var terms = a.terms
        for (n, coef) in b.terms {
          if let k = terms.firstIndex(where: { $0.name == n }) {
            terms[k].coef = bin(.add, terms[k].coef, coef)
          } else {
            terms.append((n, coef))
          }
        }
        return Affine(terms: terms, c: bin(.add, a.c, b.c))
      case .mul:
        if rvFree(lhs) { return scale(affine(rhs), lhs) }
        if rvFree(rhs) { return scale(affine(lhs), rhs) }
        return nil  // X·Y: a product distribution, not affine
      case .div:
        return rvFree(rhs) ? scale(affine(lhs), bin(.div, .num(1), rhs)) : nil
      case .pow:
        return nil  // X^k and friends
      }
    default:
      return nil  // calls, piecewise, … over random variables: not affine
    }
  }

  private func affineOf(_ name: String) -> Affine? {
    if case .derived(_, let expr)? = rvs[name] { return affine(expr) }
    return nil
  }

  /// The exact law of a variable, when one is derivable (`exactLaw`). Base
  /// declarations pass through. A derived variable affine in independent
  /// bases (shared names accumulate into one coefficient first) reduces by
  /// family:
  ///
  /// - all normal → normal, mean Σcᵢμᵢ + d, sd √(Σ(cᵢσᵢ)²);
  /// - one term → the base transformed: c·U(lo,hi)+d is Uniform again,
  ///   c·Exp(λ) with a positive literal c is Exponential(λ/c);
  /// - Gamma-family terms sharing one scaled rate → Gamma (gammaSumLaw);
  /// - the square of a standard normal → ChiSquared(1) (squareLaw);
  /// - all Cauchy → Cauchy; c·LogNormal with a positive literal c → LogNormal;
  /// - a plain sum of Poissons, or of Binomials or NegativeBinomials sharing
  ///   one p, → that family (discreteSumLaw);
  /// - several uniform terms → `usum`, an exact piecewise-polynomial convolution.
  ///
  /// Nil means the site estimates it: nonlinear transforms, products, mixed families.
  func exactLaw(_ name: String) -> Law? {
    guard let rv = rvs[name] else { return nil }
    if case .base(_, let dist) = rv { return .dist(dist) }
    guard let af = affineOf(name) else { return squareLaw(name) }
    if af.terms.isEmpty { return nil }
    let bases = af.terms.map { (coef: $0.coef, dist: baseDist($0.name)!) }
    if bases.allSatisfy({ $0.dist.kind == .normal }) {
      var mean = af.c
      var variance: Expr?
      for (coef, dist) in bases {
        mean = bin(.add, mean, bin(.mul, coef, dist.args[0]))
        let term = bin(.pow, bin(.mul, coef, dist.args[1]), .num(2))
        variance = variance.map { bin(.add, $0, term) } ?? term
      }
      return .dist(BaseDist(kind: .normal, args: [mean, .call("sqrt", [variance!])]))
    }
    if bases.allSatisfy({ $0.dist.kind == .cauchy && (numOf($0.coef) ?? 0) != 0 }) {
      // Stable with index 1: locations add like means, and scales add (not
      // their squares), each through |c| so a flip stays a scale.
      // Coefficients are nonzero literals: a slider at 0 would make this
      // Cauchy(d, 0), no distribution, where the variable is the constant d.
      var location = af.c
      var scale: Expr?
      for (coef, dist) in bases {
        location = bin(.add, location, bin(.mul, coef, dist.args[0]))
        let term = bin(.mul, .call("abs", [coef]), dist.args[1])
        scale = scale.map { bin(.add, $0, term) } ?? term
      }
      return .dist(BaseDist(kind: .cauchy, args: [location, scale!]))
    }
    if bases.count == 1 {
      let (coef, dist) = bases[0]
      switch dist.kind {
      case .uniform:
        let e1 = bin(.add, bin(.mul, coef, dist.args[0]), af.c)
        let e2 = bin(.add, bin(.mul, coef, dist.args[1]), af.c)
        return .dist(BaseDist(kind: .uniform, args: [.call("min", [e1, e2]), .call("max", [e1, e2])]))
      case .lognormal:
        // c·X with a positive literal c shifts mu by ln c; a shift, a flip
        // or a slider that could flip leaves the family.
        guard let c = numOf(coef), c > 0, numOf(af.c) == 0 else { return nil }
        let mu = c == 1 ? dist.args[0] : bin(.add, dist.args[0], .num(log(c)))
        return .dist(BaseDist(kind: .lognormal, args: [mu, dist.args[1]]))
      case .exponential:
        // Only c·X with a positive literal c stays exponential (rate λ/c).
        guard let c = numOf(coef), c > 0, numOf(af.c) == 0 else { return nil }
        let rate = c == 1 ? dist.args[0] : bin(.div, dist.args[0], .num(c))
        return .dist(BaseDist(kind: .exponential, args: [rate]))
      default:
        break
      }
    }
    if let gammaSum = gammaSumLaw(bases, af.c) { return gammaSum }
    if let discreteSum = discreteSumLaw(bases, af.c) { return discreteSum }
    if bases.allSatisfy({ $0.dist.kind == .uniform }) {
      return .usum(terms: bases.map { ($0.coef, $0.dist.args[0], $0.dist.args[1]) }, d: af.c)
    }
    return nil
  }

  /// Σ cᵢXᵢ over independent Gamma-family bases (Gamma, ChiSquared, and
  /// Exponential = Gamma(1, λ)) is Gamma(Σαᵢ, β) when every scaled rate βᵢ/cᵢ
  /// is the same β and nothing is added. Coefficients must be positive
  /// literals. Rates count as equal when they fold to the same number or are
  /// the same expression (one slider b in both).
  private func gammaSumLaw(_ bases: [(coef: Expr, dist: BaseDist)], _ shift: Expr) -> Law? {
    if numOf(shift) != 0 { return nil }
    var shape: Expr?
    var rate: Expr?
    var rateKey: String?
    for (coef, dist) in bases {
      guard let c = numOf(coef), c > 0 else { return nil }
      let al: Expr
      let be: Expr
      switch dist.kind {
      case .gamma: (al, be) = (dist.args[0], dist.args[1])
      case .chisquared: (al, be) = (bin(.div, dist.args[0], .num(2)), .num(0.5))
      case .exponential: (al, be) = (.num(1), dist.args[0])
      default: return nil
      }
      let b = numOf(be)
      let key = b.map { "#\(JS.string($0 / c))" } ?? "\(exprKey(be))/\(JS.string(c))"
      if let rateKey, key != rateKey { return nil }
      rateKey = key
      if rate == nil { rate = b.map { .num($0 / c) } ?? (c == 1 ? be : bin(.div, be, .num(c))) }
      shape = shape.map { bin(.add, $0, al) } ?? al
    }
    guard let shape, let rate else { return nil }
    return .dist(BaseDist(kind: .gamma, args: [shape, rate]))
  }

  /// A plain sum of independent discrete bases that stays in its family:
  /// Poissons (means add), Binomials — Bernoulli is Binomial(1, p) — sharing
  /// one p (the n add), NegativeBinomials sharing one p (the r add). Every
  /// coefficient must be the literal 1 and nothing added.
  private func discreteSumLaw(_ bases: [(coef: Expr, dist: BaseDist)], _ shift: Expr) -> Law? {
    if numOf(shift) != 0 { return nil }
    var kind: BaseKind?
    var total: Expr?
    var p: Expr?
    var pKey: String?
    for (coef, dist) in bases {
      if numOf(coef) != 1 { return nil }
      let d = dist.kind == .bernoulli ? BaseDist(kind: .binomial, args: [.num(1), dist.args[0]]) : dist
      if d.kind != .poisson && d.kind != .binomial && d.kind != .negbinomial { return nil }
      if let kind, d.kind != kind { return nil }
      kind = d.kind
      if d.kind != .poisson {
        let key = numOf(d.args[1]).map { "#\(JS.string($0))" } ?? exprKey(d.args[1])
        if let pKey, key != pKey { return nil }
        pKey = key
        if p == nil { p = d.args[1] }
      }
      total = total.map { bin(.add, $0, d.args[0]) } ?? d.args[0]
    }
    guard let kind, let total else { return nil }
    return .dist(BaseDist(kind: kind, args: p.map { [total, $0] } ?? [total]))
  }

  /// Z² for a standard normal Z is ChiSquared(1). Standard means written so:
  /// mean and sd that fold to exactly 0 and 1. Only the bare square
  /// qualifies (Z^2 or Z·Z of one base variable).
  private func squareLaw(_ name: String) -> Law? {
    guard case .bin(let op, let a, let b, _)? = grounded(name) else { return nil }
    var base: Expr?
    if op == .pow, case .num(2) = b {
      base = a
    } else if op == .mul, case .var(let l) = a, case .var(let r) = b, l == r {
      base = a
    }
    guard case .var(let baseName)? = base, let dist = baseDist(baseName), dist.kind == .normal else { return nil }
    if numOf(dist.args[0]) != 0 || numOf(dist.args[1]) != 1 { return nil }
    return .dist(BaseDist(kind: .chisquared, args: [.num(1)]))
  }

  /// The variable's expression with every derived dependency inlined, so
  /// only base variables and parameters remain — or nil when the expansion
  /// blows up (shared subtrees duplicate under substitution).
  private func grounded(_ name: String) -> Expr? {
    if case .derived(_, let expr)? = rvs[name] { return ground(expr) }
    return nil
  }

  /// `e` with every derived variable inlined (see grounded).
  func ground(_ expr: Expr) -> Expr? {
    var e = expr
    // Dependencies are acyclic (cycles were dropped); the guard bounds
    // pathological chains and substitution blowup all the same.
    for _ in 0..<32 {
      var sub: [String: Expr] = [:]
      for n in freeVars(e) {
        if case .derived(_, let dep)? = rvs[n] { sub[n] = dep }
      }
      if sub.isEmpty { break }
      e = substVars(e, sub)
      if exprKey(e).utf16.count > 200_000 { return nil }
    }
    return e
  }

  /// The law of a variable that is one of the discrete families: a discrete
  /// declaration, or a derived variable a closure rule reduces to one (a sum
  /// of independent Poissons). Such a variable draws and answers through the
  /// law itself, at any size (`discreteDist`).
  func discreteDist(_ name: String) -> BaseDist? {
    if case .dist(let dist)? = exactLaw(name), isDiscrete(dist) { return dist }
    return nil
  }

  /// The exact law when it is a closed-form pdf the shader can draw — so
  /// never a discrete one, which has a pmf and draws as stems (`exactDist`).
  func exactDist(_ name: String) -> BaseDist? {
    if case .dist(let dist)? = exactLaw(name), !isDiscrete(dist) { return dist }
    return nil
  }

  /// Why a base variable's parameters declare no distribution at these
  /// constants (a slider dragged to sd = 0), or nil. A parameter that moves —
  /// t, or a constant built on it — is not judged: it may be invalid at this
  /// instant and fine the next, so its density just flattens to 0 while it is.
  func paramProblem(_ name: String, _ env: [String: Double], moving: Set<String>) -> String? {
    guard let dist = baseDist(name) else { return nil }
    if paramsOf(name).contains(where: { $0 == "t" || moving.contains($0) || env[$0] == nil }) { return nil }
    guard let values = try? dist.args.map({ try evaluate($0, env) }) else { return nil }
    return EquationCore.paramProblem(dist.kind, values)
  }

  /// The law of a variable that is one of the discrete families at these
  /// parameter values; nil while any base under it declares none — a sum of
  /// two Binomials with n = 2.5 each is not Binomial(5, p) (`lawOf`).
  func lawOf(_ name: String, _ env: [String: Double]) throws -> DiscreteLaw? {
    guard let d = discreteDist(name) else { return nil }
    for b in basesOf(name) where b != name {
      if try discreteLaw(baseDist(b)!, env) == nil { return nil }
    }
    return try discreteLaw(d, env)
  }

  // MARK: Stems

  /// The stems of a discrete variable over the visible x-range: one per
  /// whole number of the support in view, clipped to where the law has mass
  /// (all but 1e-12 per tail) and capped at STEM_MAX (see
  /// `PmfStems.envelope`). Nil while the parameters declare no distribution.
  func stems(_ name: String, _ env: [String: Double], view: (lo: Double, hi: Double)?) throws
    -> (stems: PmfStems, law: DiscreteLaw)?
  {
    guard rvs[name] != nil, discreteDist(name) != nil, let law = try lawOf(name, env) else { return nil }
    let kLo = law.quantile(STEM_TAIL, false)
    let kHi = law.quantile(STEM_TAIL, true)
    if !kLo.isFinite || !kHi.isFinite { return nil }
    // The window: the view clipped to the mass range. Its width decides
    // between stems and envelope, and the envelope's stride — a pan leaves
    // the width alone, so neither flips as ceil(view.lo) ticks over.
    let lo = JS.max([kLo, view?.lo ?? -.infinity])
    let hi = JS.min([kHi, view?.hi ?? .infinity])
    if !(lo <= hi) { return (PmfStems(ks: [], ps: [], envelope: false), law) }
    if hi - lo < STEM_MAX { return (buildStems(law, lo.rounded(.up), hi.rounded(.down)), law) }
    let stride = JS.pow(2, log2((hi - lo) / STEM_MAX).rounded(.up))
    return (buildEnvelope(law, kLo, kHi, stride, (lo / stride).rounded(.down), (hi / stride).rounded(.up)), law)
  }

  /// What a discrete variable draws over the visible x-range, as runs of
  /// stems (`pmfRuns`). With `select` — a P(…) row's bounds — only the part
  /// it selects, strictness and all. Nil for a variable that is not
  /// discrete, or while its parameters declare no distribution.
  public func pmfRuns(
    _ name: String, _ env: [String: Double], view: (lo: Double, hi: Double)? = nil, select: ProbBounds? = nil
  ) throws -> [PmfStems]? {
    if discreteDist(name) != nil {
      guard let drawn = try stems(name, env, view: view) else { return nil }
      guard let select else { return [drawn.stems] }
      return selectStems(drawn.stems, drawn.law, try integerBounds(select, env))
    }
    // A derived one, at its atoms' true locations.
    return try pmfOf(name, env).map { try atomRuns($0, env, view: view, select: select) }
  }

  /// The stem an E(…) marker stands on: the atom at x, within rounding, and
  /// its mass — else x itself, on the axis (`atomNear`).
  private func atomNear(_ name: String, _ x: Double, _ env: [String: Double]) throws -> (x: Double, h: Double) {
    if let law = try lawOf(name, env) {
      let k = wholeNumber(x)
      return k.isNaN ? (x, 0) : (k, law.pmf(k))
    }
    return try pmfOf(name, env).map { atomNear($0, x) } ?? (x, 0)
  }

  // MARK: Curves

  /// Numeric piecewise polynomial of a usum law at these parameter values.
  private func usumPP(_ terms: [(c: Expr, lo: Expr, hi: Expr)], _ d: Expr, _ env: [String: Double]) throws -> PPoly? {
    var acc: PPoly?
    let shift = try evaluate(d, env)
    if !shift.isFinite { return nil }
    for t in terms {
      let c = try evaluate(t.c, env)
      let lo = try evaluate(t.lo, env)
      let hi = try evaluate(t.hi, env)
      if !c.isFinite || !(hi > lo) { return nil }
      if c == 0 { continue }  // a slider zeroed this term: it contributes nothing
      let box = PPoly.uniform(lo, hi).scaled(c, 0)
      acc = acc.map { $0.convolved(with: box) } ?? box
    }
    guard let acc else { return nil }  // every coefficient zero: a constant, nothing to draw
    return shift != 0 ? acc.scaled(1, shift) : acc
  }

  /// The density curve for a variable whose law is a uniform convolution:
  /// the exact piecewise polynomial (`curve`). (Rows whose law is a
  /// closed-form pdf never come here: they draw through the shader.) Nil
  /// while its parameters declare no distribution.
  ///
  /// Port: the site's other tiers — the conditional-CDF curve of a transform
  /// of one or two bases (`condBase`), and the sample estimate
  /// (`estimateCurve`) — are not ported.
  public func curve(_ name: String, _ env: [String: Double]) throws -> DensityCurve? {
    guard case .usum(let terms, let d)? = exactLaw(name) else {
      if rvs[name] == nil { throw LanguageError("\(name) has an error in its definition.") }
      if isDiscreteVar(name) { return nil }  // no density: pmfRuns draws it
      throw Unsupported("the density of a transformed random variable")
    }
    guard let pp = try usumPP(terms, d, env), let m = try exactMoments(name, env) else { return nil }
    return DensityCurve(pts: pp.curve(), mean: m.mean, sd: m.sd, mass: 1)
  }

  // MARK: Moments

  /// Exact mean and sd under the variable's law, or nil when it has none
  /// (or its parameters declare no distribution) (`exactMoments`).
  func exactMoments(_ name: String, _ env: [String: Double]) throws -> (mean: Double, sd: Double)? {
    guard let law = exactLaw(name) else { return nil }
    switch law {
    case .dist(let dist):
      if isDiscrete(dist) { return try lawOf(name, env).map { ($0.mean, $0.sd) } }
      let a = try dist.args.map { try evaluate($0, env) }
      switch dist.kind {
      case .normal: return a[1] > 0 ? (a[0], a[1]) : nil
      case .uniform: return a[1] > a[0] ? ((a[0] + a[1]) / 2, (a[1] - a[0]) / 12.0.squareRoot()) : nil
      case .exponential: return a[0] > 0 ? (1 / a[0], 1 / a[0]) : nil
      default: break
      }
      if !a.allSatisfy(\.isFinite) || EquationCore.paramProblem(dist.kind, a) != nil { return nil }
      // A moment that does not exist is NaN and an infinite one ∞ — said,
      // not estimated: a Cauchy sample mean is a confident wrong number.
      switch dist.kind {
      case .gamma: return (a[0] / a[1], a[0].squareRoot() / a[1])
      case .chisquared: return (a[0], (2 * a[0]).squareRoot())
      case .beta:
        let n = a[0] + a[1]
        return (a[0] / n, ((a[0] * a[1]) / (n + 1)).squareRoot() / n)
      case .studentt:
        return (
          a[0] > 1 ? 0 : .nan, a[0] > 2 ? (a[0] / (a[0] - 2)).squareRoot() : a[0] > 1 ? .infinity : .nan
        )
      case .lognormal:
        let mean = exp(a[0] + (a[1] * a[1]) / 2)
        return (mean, mean * expm1(a[1] * a[1]).squareRoot())
      case .cauchy: return (.nan, .nan)
      case .weibull:
        // σ² = λ²(Γ₂ − Γ₁²) = λ²Γ₂(1 − Γ₁²/Γ₂), in logs: for a small shape
        // Γ(1 + 2/k) overflows long before σ does, and ∞ − ∞ is NaN.
        let l1 = lgammaFn(1 + 1 / a[0])
        let l2 = lgammaFn(1 + 2 / a[0])
        return (a[1] * exp(l1), a[1] * exp(l2 / 2) * JS.max([-expm1(2 * l1 - l2), 0]).squareRoot())
      default: return nil
      }
    case .usum(let terms, let d):
      var mean = try evaluate(d, env)
      var variance = 0.0
      for t in terms {
        let c = try evaluate(t.c, env)
        let lo = try evaluate(t.lo, env)
        let hi = try evaluate(t.hi, env)
        if !c.isFinite || !(hi > lo) { return nil }
        mean += (c * (lo + hi)) / 2
        variance += (c * (hi - lo)) * (c * (hi - lo)) / 12
      }
      return mean.isFinite ? (mean, variance.squareRoot()) : nil
    }
  }

  /// Moments certified without a closed law (`quadMoments`): of a derived
  /// discrete variable, the sum against the base pmfs, where enumeration
  /// reached and truncation is certified invisible in the mean.
  ///
  /// Port: for a transform of one continuous base the site integrates
  /// against the base pdf (lib/integrate.ts); that is not ported.
  func quadMoments(_ name: String, _ env: [String: Double]) throws -> (mean: Double, sd: Double, mass: Double)? {
    guard case .derived = rvs[name] else { return nil }  // base laws: exactMoments has them
    if isDiscreteVar(name) {
      guard let pmf = try pmfOf(name, env), pmf.meanExact else { return nil }
      return (pmf.mean, pmf.sd, pmf.mass)
    }
    throw Unsupported("the mean of a transformed random variable")
  }

  /// The mean of a variable: exact under its law when one is derivable, else
  /// the enumerated mean of a discrete one (`mean`). NaN while its parameters
  /// declare no distribution, or when the mean does not exist.
  ///
  /// Port: the site's last resorts — the mean of a drawn curve, and the
  /// sample's — are not ported.
  func mean(_ name: String, _ env: [String: Double]) throws -> Double {
    if let m = try exactMoments(name, env) { return m.mean }
    if let m = try quadMoments(name, env) { return m.mean }
    if isDiscreteVar(name) {
      // Uncertified enumeration; NaN while parameters are invalid or the
      // mean's sum diverges (meanUnstable says which).
      guard let pmf = try pmfOf(name, env), pmf.meanOk else { return .nan }
      return pmf.mean
    }
    // A declaration with no moments has no distribution at these values:
    // its sample is NaN throughout, and so is its mean.
    return .nan
  }

  /// Why mean() is NaN, when the reason is the law and not the parameters:
  /// the mean does not exist (Cauchy, StudentT with df ≤ 1), or its sum over
  /// the atoms diverges (`meanUnstable`).
  func meanUnstable(_ name: String, _ env: [String: Double]) throws -> Bool {
    if let m = try exactMoments(name, env) { return m.mean.isNaN }
    if try quadMoments(name, env) != nil { return false }
    if isDiscreteVar(name) { return try pmfOf(name, env)?.meanOk == false }
    return false
  }

  /// What a derived row's readout says, decided in one place: exact μ, σ
  /// under a closed law; for a discrete variable, what its enumeration
  /// certifies (`moments`). Nil when nothing computes.
  func moments(_ name: String, _ env: [String: Double]) throws -> Moments? {
    if let m = try exactMoments(name, env), m.mean.isFinite, m.sd.isFinite {
      return .exact(mean: m.mean, sd: m.sd, mass: 1, note: nil)
    }
    if isDiscreteVar(name) { return try pmfOf(name, env).map(atomMoments) }
    throw Unsupported("the moments of a transformed random variable")
  }

  // MARK: Probabilities

  /// Exact P(lo < name < hi) under the variable's law, or nil when it has
  /// none. The bounds' strictness matters to a discrete law only (`exactProbability`).
  func exactProbability(_ name: String, _ bounds: ProbBounds, _ env: [String: Double]) throws -> Double? {
    guard let law = exactLaw(name) else { return nil }
    switch law {
    case .dist(let dist):
      // (A base under a closed sum is invalid.)
      if isDiscrete(dist), try lawOf(name, env) == nil { return .nan }
      return try probabilityValue(dist, bounds.lo, bounds.hi, env, edges: bounds)
    case .usum(let terms, let d):
      guard let pp = try usumPP(terms, d, env) else { return .nan }
      let total = pp.cdf(pp.breaks[pp.breaks.count - 1])
      let upper = try bounds.hi.map { pp.cdf(try evaluate($0, env)) } ?? total
      let lower = try bounds.lo.map { pp.cdf(try evaluate($0, env)) } ?? 0
      return upper - lower
    }
  }

  /// The value of a P(…) row, and whether it is exact (shown to 4 places) or
  /// an estimate (3) (`eventProbability`). Constant bounds on one variable go
  /// through its law or its atoms; any other event over discrete variables
  /// alone is enumerated over the joint of their bases. Either way a discrete
  /// event keeps its strictness — ties have mass. `single` is the row's
  /// bounded variable, when it has that shape.
  ///
  /// Port: everything else the site estimates over its joint sample, which
  /// is not ported.
  func eventProbability(_ body: Expr, _ single: ProbShade?, _ env: [String: Double]) throws
    -> (value: Double, exact: Bool)
  {
    if let single {
      if let value = try exactProbability(single.rv, single.bounds, env) { return (value, true) }
      if isDiscreteVar(single.rv) {
        guard let pmf = try pmfOf(single.rv, env) else { return (.nan, true) }
        return (try atomProbability(pmf, single.bounds, env), true)
      }
    }
    if continuousIn(body).isEmpty, let value = try enumeratedProbability(body, env) { return (value, true) }
    throw Unsupported("probabilities estimated from samples")
  }

  /// Where an E(…) row's marker stands: x = the mean, reaching up to the law
  /// there (lib/dist.ts `markerHeight`). For a discrete variable that is the
  /// stem at the mean when the mean is a whole number, and the axis when it
  /// falls between stems; for a continuous one, the exact pdf or the drawn
  /// curve. Nil when there is no mean to mark.
  public func markerHeight(_ name: String, _ env: [String: Double]) throws -> (x: Double, h: Double)? {
    let m = try mean(name, env)
    if !m.isFinite { return nil }
    if isDiscreteVar(name) { return try atomNear(name, m, env) }
    var h: Double
    if let exact = exactDist(name) {
      h = try evaluate(pdfExpr(exact, .num(m)), env)
    } else {
      h = try curve(name, env)?.density(at: m) ?? 0
    }
    if !h.isFinite || h < 0 { h = 0 }
    return (m, h)
  }
}

// MARK: - Exact piecewise-polynomial densities (uniform convolutions)
//
// Sums of independent uniforms stay piecewise polynomial forever: uniform is
// degree 0 and each convolution raises the degree by one and merges
// breakpoints (X + Y is the triangle, four terms the Irwin–Hall cubic).
// Coefficients are plain numbers evaluated per parameter values.

private typealias Poly = [Double]

private func padd(_ a: Poly, _ b: Poly) -> Poly {
  var out = Poly(repeating: 0, count: max(a.count, b.count))
  for (i, v) in a.enumerated() { out[i] += v }
  for (i, v) in b.enumerated() { out[i] += v }
  return out
}

private func pscale(_ a: Poly, _ k: Double) -> Poly { a.map { $0 * k } }

private func pmul(_ a: Poly, _ b: Poly) -> Poly {
  var out = Poly(repeating: 0, count: max(1, a.count + b.count - 1))
  for i in a.indices {
    for j in b.indices { out[i + j] += a[i] * b[j] }
  }
  return out
}

private func peval(_ a: Poly, _ x: Double) -> Double {
  var v = 0.0
  for c in a.reversed() { v = v * x + c }
  return v
}

/// Antiderivative with constant 0.
private func pint(_ a: Poly) -> Poly { [0] + a.enumerated().map { $0.element / Double($0.offset + 1) } }

/// Compose: p(k·y + t) as a polynomial in y.
private func plin(_ p: Poly, _ k: Double, _ t: Double) -> Poly {
  var out: Poly = [0]
  for c in p.reversed() { out = padd(pmul(out, [t, k]), [c]) }
  return out
}

private func binom(_ n: Int, _ k: Int) -> Double {
  var v = 1.0
  for i in 0..<k { v = (v * Double(n - i)) / Double(i + 1) }
  return v
}

/// Density polynomial (ascending coefficients) per interval between breaks (`PPoly`).
struct PPoly {
  var breaks: [Double]
  var pieces: [[Double]]

  static func uniform(_ lo: Double, _ hi: Double) -> PPoly { PPoly(breaks: [lo, hi], pieces: [[1 / (hi - lo)]]) }

  /// The density of c·X + t for X with this density (c ≠ 0) (`scalePP`).
  func scaled(_ c: Double, _ t: Double) -> PPoly {
    var breaks = self.breaks.map { c * $0 + t }
    // g(y) = f((y − t)/c)/|c|; composing with the inverse map keeps polynomials.
    var pieces = self.pieces.map { pscale(plin($0, 1 / c, -t / c), 1 / abs(c)) }
    if c < 0 {
      breaks.reverse()
      pieces.reverse()
    }
    return PPoly(breaks: breaks, pieces: pieces)
  }

  /// Exact convolution of two piecewise-polynomial densities (`convPP`). For
  /// a piece pair u on [a, b] and v on [c, e], h(z) = ∫ u(x)v(z−x) dx over
  /// x ∈ [max(a, z−e), min(b, z−c)]: the antiderivative W(x; z) is computed
  /// once per pair (a polynomial in x whose coefficients are polynomials in
  /// z), and on each output interval each limit is either a constant or
  /// z + shift, so h is a polynomial.
  func convolved(with q: PPoly) -> PPoly {
    struct Pair {
      var a: Double, b: Double, c: Double, e: Double
      var Wx: [Poly]
    }
    var pairs: [Pair] = []
    var zb: [Double] = []
    for i in 0..<max(0, breaks.count - 1) {
      for k in 0..<max(0, q.breaks.count - 1) {
        let (a, b) = (breaks[i], breaks[i + 1])
        let (c, e) = (q.breaks[k], q.breaks[k + 1])
        let (u, v) = (pieces[i], q.pieces[k])
        // v(z−x) gathered by powers of x: Vx[r] is a polynomial in z.
        var Vx: [Poly] = Array(repeating: [], count: v.count)
        for kk in v.indices {
          for r in 0...kk {
            if Vx[r].count <= kk - r { Vx[r] += Poly(repeating: 0, count: kk - r + 1 - Vx[r].count) }
            Vx[r][kk - r] += v[kk] * binom(kk, r) * (r % 2 == 1 ? -1 : 1)
          }
        }
        // u(x)·v(z−x) by powers of x, then the antiderivative in x.
        var Px: [Poly] = Array(repeating: [], count: max(0, u.count + Vx.count - 1))
        for i2 in u.indices {
          for r in Vx.indices { Px[i2 + r] = padd(Px[i2 + r], pscale(Vx[r], u[i2])) }
        }
        var Wx: [Poly] = [[]]
        for j in Px.indices { Wx.append(pscale(Px[j], 1 / Double(j + 1))) }
        pairs.append(Pair(a: a, b: b, c: c, e: e, Wx: Wx))
        zb += [a + c, a + e, b + c, b + e]
      }
    }
    zb.sort()
    let eps = Swift.max(1e-300, (zb[zb.count - 1] - zb[0]) * 1e-12)
    let zs = zb.enumerated().filter { $0.offset == 0 || $0.element - zb[$0.offset - 1] > eps }.map(\.element)
    var outBreaks = [zs[0]]
    var outPieces: [Poly] = []
    for s in 0..<(zs.count - 1) {
      let mid = (zs[s] + zs[s + 1]) / 2
      var acc: Poly = [0]
      for pr in pairs {
        if mid <= pr.a + pr.c || mid >= pr.b + pr.e { continue }
        // W at a limit that is either constant or z + shift, as a poly in z.
        func wAt(_ constX: Double?, _ shift: Double) -> Poly {
          var out: Poly = []
          var xp = 1.0
          var pw: Poly = [1]
          for w in pr.Wx {
            if !w.isEmpty { out = padd(out, constX != nil ? pscale(w, xp) : pmul(w, pw)) }
            if let constX { xp *= constX } else { pw = pmul(pw, [shift, 1]) }
          }
          return out
        }
        let upper = pr.b <= mid - pr.c ? wAt(pr.b, 0) : wAt(nil, -pr.c)
        let lower = pr.a >= mid - pr.e ? wAt(pr.a, 0) : wAt(nil, -pr.e)
        acc = padd(acc, padd(upper, pscale(lower, -1)))
      }
      outBreaks.append(zs[s + 1])
      outPieces.append(acc)
    }
    return PPoly(breaks: outBreaks, pieces: outPieces)
  }

  /// Exact CDF at x (`cdfPP`).
  func cdf(_ x: Double) -> Double {
    var acc = 0.0
    for i in 0..<max(0, breaks.count - 1) {
      if x <= breaks[i] { break }
      let hi = JS.min([x, breaks[i + 1]])
      let F = pint(pieces[i])
      acc += peval(F, hi) - peval(F, breaks[i])
    }
    return acc
  }

  /// The exact curve as a polyline: pieces sampled densely, with every true
  /// breakpoint emitted so kinks stay corners (`curvePP`).
  func curve() -> [Double] {
    let span = breaks[breaks.count - 1] - breaks[0]
    var pts: [Double] = []
    for i in 0..<max(0, breaks.count - 1) {
      let (x0, x1) = (breaks[i], breaks[i + 1])
      let n = Int(JS.max([2, (((x1 - x0) / span) * 256).rounded(.up)]))
      for k in 0...n {
        let x = x0 + ((x1 - x0) * Double(k)) / Double(n)
        pts += [x, peval(pieces[i], x)]
      }
    }
    return pts
  }
}

// MARK: - Building the system from scanned rows

struct BuiltRVs {
  /// The declarations that stand, in the order their rows claimed them.
  var declarations: [RV] = []
  /// Every declared name, healthy or not — the set P(…) and bare rows resolve against.
  var names: Set<String> = []
  /// Row index → the variable it declares, in the order the rows were read (declarations, then derived rows).
  var rowRV: [(row: Int, name: String)] = []
  /// Row index → error message, for rows whose declaration failed.
  var errors: [Int: String] = [:]
  /// Row index → what the port could not read of the declaration.
  var unsupported: [Int: String] = [:]
}

/// Detect definition cycles; returns per-variable errors (`validateDeclarations`).
private func validateDeclarations(_ order: [String], _ declarations: [String: RV]) -> [(String, String)] {
  var broken: [(String, String)] = []
  var state: [String: Bool] = [:]  // false: visiting, true: done
  func visit(_ name: String, _ path: [String]) {
    guard let rv = declarations[name], state[name] != true else { return }
    if state[name] == false {
      let cycle = Array(path[path.firstIndex(of: name)!...]) + [name]
      let message = "\(cycle.joined(separator: " → ")) is circular."
      for cn in cycle {
        if let k = broken.firstIndex(where: { $0.0 == cn }) {
          broken[k].1 = message
        } else {
          broken.append((cn, message))
        }
      }
      return
    }
    state[name] = false
    if case .derived(_, let expr) = rv {
      for dep in freeVars(expr) where declarations[dep] != nil { visit(dep, path + [name]) }
    }
    state[name] = true
  }
  for name in order { visit(name, []) }
  return broken
}

/// Parse and resolve each declaration, reject name collisions, then drop
/// definition cycles and everything that depends on a failed variable,
/// reporting per-row errors (`buildRVDeclarations`). `taken`: the name is
/// already claimed by a definition row.
func buildRVDeclarations(
  _ scan: RandomScan, fnNames: Set<String>, getFn: @escaping GetFn, ropts: ResolveOpts, constNames: Set<String>,
  taken: (String) -> Bool
) -> BuiltRVs {
  var built = BuiltRVs()
  built.names = Set(scan.names)
  var declarations: [String: RV] = [:]
  var order: [String] = []
  var rowOf: [(name: String, row: Int)] = []

  func claim(_ i: Int, _ name: String) -> Bool {
    built.rowRV.append((i, name))
    // Late-addition builtins (gamma, sinc, …) stay claimable: a graph saved
    // before they existed may use one as a random variable name.
    let builtin = builtinFn(name)
    if reservedNames.contains(name) || (builtin != nil && !shadowableFunctions.contains(builtin!)) {
      built.errors[i] = "Cannot use \(name) as a random variable name."
    } else if declarations[name] != nil || taken(name) {
      built.errors[i] = "\(name) is already defined."
    } else {
      rowOf.append((name, i))
      return true
    }
    return false
  }
  func declare(_ rv: RV) {
    if declarations.updateValue(rv, forKey: rv.name) == nil { order.append(rv.name) }
  }
  func fail(_ i: Int, _ error: Error) {
    if let error = error as? Unsupported {
      built.unsupported[i] = error.what
    } else {
      built.errors[i] = errorMessage(error)
    }
  }

  let resolver = Resolver(getFn: getFn, opts: ropts)
  for (i, name, rhs) in scan.base {
    if !claim(i, name) { continue }
    do {
      var d = try parseDistribution(rhs, fnNames: fnNames, valueNames: ropts.valueNames)
      d.args = try d.args.map(resolver.resolve)
      for a in d.args {
        for f in freeVars(a) where built.names.contains(f) {
          throw LanguageError("Distribution parameters cannot depend on a random variable.")
        }
        try checkDerived(a, [], constNames)
      }
      declare(.base(name: name, dist: d))
    } catch {
      fail(i, error)
    }
  }
  for (i, name, rhs) in scan.derived {
    if !claim(i, name) { continue }
    do {
      let expr = try resolver.resolve(try parseExpr(rhs, userFns: fnNames, valueNames: ropts.valueNames))
      try checkDerived(expr, built.names, constNames)
      declare(.derived(name: name, expr: expr))
    } catch {
      fail(i, error)
    }
  }

  // Cycles, then the ripple: a variable whose dependency failed fails too.
  var failed = validateDeclarations(order, declarations)
  for (name, _) in failed { declarations[name] = nil }
  var changed = true
  while changed {
    changed = false
    for (name, _) in rowOf {
      guard case .derived(_, let expr)? = declarations[name] else { continue }
      for dep in freeVars(expr) where built.names.contains(dep) && declarations[dep] == nil {
        failed.append((name, "\(dep) has an error in its definition."))
        declarations[name] = nil
        changed = true
        break
      }
    }
  }
  for (name, message) in failed {
    guard let row = rowOf.first(where: { $0.name == name })?.row else { continue }
    if built.errors[row] == nil && built.unsupported[row] == nil { built.errors[row] = message }
  }
  built.declarations = order.compactMap { declarations[$0] }
  return built
}
