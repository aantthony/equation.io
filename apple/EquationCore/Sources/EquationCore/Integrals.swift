/// ∫ in a row (lib/defs.ts `expandInt`, `integral`, `resolveRow`), and what a
/// definite integral's row carries to shade its area (lib/plot.ts
/// `lowerShade`; the sampling of the area is IntShade.swift).

import Synchronization

/// What a `value` row carries when it is exactly one definite integral
/// (lib/intshade.ts `IntShade`).
public struct IntShade: Equatable, Hashable, Sendable {
  /// The integrand, with the d<v> measure stripped.
  public var body: Expr
  /// The integration variable.
  public var v: String
  /// Bounds as written (resolved); ±inf stays the `inf` name.
  public var lo: Expr
  public var hi: Expr

  public init(body: Expr, v: String, lo: Expr, hi: Expr) {
    self.body = body
    self.v = v
    self.lo = lo
    self.hi = hi
  }
}

/// Cache of expanded integrals (lib/defs.ts `intMemo`). The expansion is a
/// pure function of the resolved integrand and bounds — slider VALUES stay
/// symbolic inside it — so a document analyzed again after an edit elsewhere
/// hits this instead of re-running the symbolic engine and its verification
/// quadratures. As on the site, a hit does not count toward a resolve's term
/// budget.
private let intMemo = Mutex<[String: Expr]>([:])

/// ±1 for a bound written as ±inf/±∞, 0 for a finite (or absent) bound.
private func infOf(_ e: Expr?) -> Int {
  switch e {
  case .var("inf")?: 1
  case .neg(.var("inf"))?: -1
  default: 0
  }
}

/// Stand-in argument for an antiderivative's limit at ±∞. Far beyond any plot
/// range, so F(±BIG) matches the true limit wherever F converges by then —
/// and verifyDefinite runs the REAL improper quadrature, so a
/// not-yet-converged (or divergent) limit is rejected, never reported.
private let INT_BIG = 1e8

/// Reductions that read a whole multiset (lib/measure.ts `isReductionCall`).
let REDUCTIONS: Set<String> = ["count", "total", "mean", "min", "max", "stdev", "median", "hist"]

func isReductionCall(_ e: Expr) -> Bool {
  if case .call(let name, let args) = e { return REDUCTIONS.contains(name) && args.count == 1 }
  return false
}

private func containsReduction(_ e: Expr) -> Bool {
  isReductionCall(e) || childrenOf(e).contains(where: containsReduction)
}

extension Resolver {
  /// Expand an ∫ (lib/defs.ts `expandInt`): a verified antiderivative when
  /// Integrate.swift finds one (definite values additionally checked against
  /// adaptive quadrature — the fundamental theorem lies across a
  /// non-integrable singularity), otherwise a fixed Gauss–Legendre sum in
  /// ordinary Expr form.
  func expandInt(_ bounds: (Expr, Expr)?, _ rawBody: Expr) throws -> Expr {
    // Resolve the body FIRST: a d/dt inside consumes its own dt, user
    // functions inline, and nested (parenthesized) integrals expand — only
    // then is the surviving d<letter> factor unambiguous.
    guard let m = try stripDx(try resolveIntegrand(rawBody)) else {
      throw LanguageError("∫ needs its variable as a dx factor: int(x^2 dx) or int[0..2] x^2 dx.")
    }
    let lo = try bounds.map { try resolve($0.0) }
    let hi = try bounds.map { try resolve($0.1) }
    if ctx.ints != nil {
      if let lo, let hi, m.residual == nil {
        ctx.ints!.append(IntShade(body: m.integrand, v: m.v, lo: lo, hi: hi))
      } else {
        ctx.ints!.append(nil)
      }
    }
    let out = try integral(m.integrand, m.v, lo, hi)!
    // An enclosing integral's measure rides along: (∫ inner) · residual.
    return m.residual.map { .bin(.mul, out, $0) } ?? out
  }

  /// An ∫ body, resolved with its variable bound (`resolveIntegrand`): a
  /// reduction inside runs over its own continuous sets for each value of
  /// it, so ∫₀¹ total({0 < u < 1: x u}) dx is ∫₀¹ x/2 dx, not a total over
  /// every x as well. The variable is certain only once the body has
  /// resolved, so a body with a reduction is resolved again when the dx read
  /// off it first was not it.
  private func resolveIntegrand(_ rawBody: Expr) throws -> Expr {
    if !containsReduction(rawBody) { return try resolve(rawBody) }
    func bound(_ v: String?) throws -> Expr {
      guard let v else { return try resolve(rawBody) }
      var inner = self
      inner.opts.params = (opts.params ?? []).union([v])
      return try inner.resolve(rawBody)
    }
    let guess = (try? stripDx(rawBody))??.v
    let body = try bound(guess)
    let v = try stripDx(body)?.v
    return v == guess ? body : try bound(v)
  }

  /// ∫ integrand dv from lo to hi (resolved; nil bounds for the indefinite
  /// integral anchored at 0) (lib/defs.ts `integral`). Shared by ∫ rows and
  /// the reductions over continuous sets that become integrals. With
  /// `exactOnly`, a verified closed form or nil — never the fixed-order
  /// numeric fallback (the caller integrates adaptively instead).
  func integral(_ integrand: Expr, _ v: String, _ lower: Expr?, _ upper: Expr?, exactOnly: Bool = false) throws
    -> Expr?
  {
    var (lo, hi) = (lower, upper)
    let bounds = lo != nil && hi != nil
    var loI = infOf(lo)
    var hiI = infOf(hi)
    // Normalize a downhill infinite range (int[inf..0]) to the negated uphill one.
    var flip = false
    if loI == 1 || hiI == -1 {
      (lo, hi) = (hi, lo)
      (loI, hiI) = (hiI, loI)
      flip = true
      if loI == 1 || hiI == -1 { return .num(0) }  // int[inf..inf]: equal bounds
    }
    let memoKey =
      "[\(jsonString(v)),\(exprKey(integrand)),\(lo.map(exprKey) ?? "null"),\(hi.map(exprKey) ?? "null"),"
      + "\(exactOnly)]"
    func done(_ out: Expr) -> Expr { flip ? neg(out) : out }
    if let hit = intMemo.withLock({ $0[memoKey] }) { return done(hit) }

    let F = antiderivative(integrand, v)
    var out: Expr?
    if !bounds {
      out = F
    } else if let F, let lo, let hi {
      let loSub = loI != 0 ? Expr.num(Double(loI) * INT_BIG) : lo
      let hiSub = hiI != 0 ? Expr.num(Double(hiI) * INT_BIG) : hi
      let val = foldNums(sub(substVars(F, [v: hiSub]), substVars(F, [v: loSub])))
      let loChk = loI != 0 ? Expr.num(Double(loI) * .infinity) : lo
      let hiChk = hiI != 0 ? Expr.num(Double(hiI) * .infinity) : hi
      if verifyDefinite(val, integrand, v, loChk, hiChk) { out = val }
    }
    if out == nil && exactOnly { return nil }
    if out == nil {
      // Numeric fallback. An indefinite ∫ anchors at 0: F(x) = ∫₀ˣ; infinite
      // ranges transform onto a finite interval first (improperSum).
      ctx.terms += QUAD_TERMS
      if ctx.terms > sumMaxTotal {
        throw LanguageError("Nested Σ/∫ expand to too many terms (limit \(sumMaxTotal) total).")
      }
      let expanded = foldNums(
        loI != 0 || hiI != 0
          ? improperSum(integrand, v, loI != 0 ? nil : lo, hiI != 0 ? nil : hi)
          : quadratureSum(integrand, v, lo ?? .num(0), hi ?? .var(v)))
      if exprKey(expanded).utf16.count > 400_000 {
        throw LanguageError("∫ has no closed form here and its numeric expansion is too large.")
      }
      out = expanded
    }
    intMemo.withLock { memo in
      if memo.count > 500 { memo.removeAll() }
      memo[memoKey] = out!
    }
    return done(out!)
  }

  /// Resolve a whole row, also reporting the ∫ it consists of (lib/defs.ts
  /// `resolveRow`): `integral` is set when the parsed row is exactly one
  /// definite integral — `int[a..b] f dx` or `int(a..b, f dx)` standing
  /// alone — and that was the ONLY ∫ the resolution expanded. A coefficient,
  /// a sum of integrals, an iterated or nested ∫ and an indefinite ∫ all
  /// report nil, because no single region IS their value. The pieces are the
  /// ones expandInt itself resolved, not a second resolution.
  func resolveRow(_ e: Expr) throws -> (expr: Expr, integral: IntShade?) {
    ctx.ints = []
    let expr = try resolve(e)
    let m = splitSumChain(e)
    let call: Expr? = m == nil ? e : m!.coeff == nil && isIntHeader(m!.header) ? intCallOf(m!.header, m!.body) : nil
    var sole = false
    if case .call("int", let args)? = call { sole = args.count == 3 && ctx.ints!.count == 1 }
    return (expr, sole ? ctx.ints![0] : nil)
  }
}

/// A stand-in for the integration variable while the integrand is lowered:
/// no document name can collide with it (it is not an identifier).
private let INT_VAR = "[dx]"

/// What a `value` row that is one definite integral shades (lib/plot.ts
/// `lowerShade`): its pieces lowered, or nil when they are not real numbers
/// of names that have a value each frame — the readout is unaffected.
/// `lower` is the row's geometry/list lowering.
func lowerShade(_ int: IntShade, lower: (Expr) throws -> Expr, known: Set<String>) -> IntShade? {
  let v = int.v
  func isInf(_ b: Expr) -> Bool {
    if case .neg(let a) = b { return a == .var("inf") }
    return b == .var("inf")
  }
  // Inside the integrand v is the bound variable, whatever else the
  // document calls by that name: a slider it merely shadows, but a list or
  // a point would be substituted in by lowering — so it lowers under a
  // stand-in name. In the bounds the name keeps its document meaning.
  guard let hidden = try? lower(substVars(int.body, [v: .var(INT_VAR)])) else { return nil }
  let body = substVars(hidden, [INT_VAR: .var(v)])
  guard let lo = isInf(int.lo) ? int.lo : try? lower(int.lo), let hi = isInf(int.hi) ? int.hi : try? lower(int.hi)
  else { return nil }
  func scalar(_ e: Expr) -> Bool {
    switch e {
    case .vec, .list, .data, .eq, .ineq: false
    default: !usesComplex(e)
    }
  }
  if ![body, lo, hi].allSatisfy(scalar) { return nil }
  func free(_ e: Expr, _ bound: String? = nil) -> Bool {
    freeVars(e).allSatisfy { $0 == bound || $0 == "t" || known.contains($0) }
  }
  if !free(body, v) || ![lo, hi].allSatisfy({ isInf($0) || free($0) }) { return nil }
  return IntShade(body: body, v: v, lo: lo, hi: hi)
}
