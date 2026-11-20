/// The probability rows of a document, as lib/analysis.ts reads them
/// (`prepareDocument`, `analyzePrepared`): `X ~ …` and the rows derived from
/// one, `P(…)`, `E(…)`, and a bare expression in random variables.

/// What a probability row is (lib/analysis.ts `RowInfo.dist`): `X ~ …` plots
/// a density or a pmf, `P(…)` a shaded area, `E(…)` a marker at the mean.
public enum RowDistribution: String, Sendable {
  case density, pmf, probability, expectation
}

/// What a random variable's row draws on the CPU (lib/math-object.ts
/// 'distribution', but for `prob`, which is `MathObject.probability`).
public enum DistributionForm: String, Sendable {
  case density, pmf, expect
}

/// Probability rows classify as plain curves and regions; these say what
/// they are (lib/row-kind.ts `rowKind`).
func distributionKind(_ dist: RowDistribution, _ cpu: CpuPlan?) -> String {
  switch dist {
  case .density: return "random variable (density curve)"
  case .pmf: return "discrete random variable (pmf stems)"
  case .expectation: return "expectation (mean readout)"
  case .probability:
    // An event with no single-variable shape (P(X < Y)) is estimated, not drawn.
    if case .prob(_, nil)? = cpu { return "probability (readout only)" }
    return "probability (shaded area)"
  }
}

/// The `~` rows of a document and the rows derived from them, as far as
/// their declarations: found by their text, before definitions are built,
/// because these rows must not become constant definitions.
struct RandomRows {
  var scan = RandomScan()
  /// The rows that fit a model to data (`Y ~ m X + b`).
  var regressions: [Int: TildeRow] = [:]
  /// The variable each declaring row names.
  var declares: [Int: String] = [:]
  var built = BuiltRVs()

  init() {}

  /// What each row is by its text (lib/analysis.ts `prepareDocument`):
  /// `claimed` rows — comments, sequences — are not looked at.
  init(_ texts: [String], claimed: (Int) -> Bool) {
    let fits = scanRegressions(texts)
    regressions = fits
    scan = scanRandomRows(
      texts.enumerated().map { i, text in fits[i] != nil || text.isEmpty || claimed(i) ? nil : text })
    for (row, name, _) in scan.base + scan.derived { declares[row] = name }
  }
}

/// The declarations of a prepared document's random variables, resolved
/// against its definitions as a row is.
func buildRandomVariables(_ scan: RandomScan, _ built: BuiltDefs, _ raw: [Definition], documentNames: Set<String>)
  -> BuiltRVs
{
  let fnNames = Set(raw.compactMap { if case .function(let name, _, _) = $0 { name } else { nil } })
  var ropts = ResolveOpts()
  ropts.definition = { built.fields[$0] ?? built.conditions[$0] ?? built.consts[$0] }
  ropts.comps = { built.points.contains($0) ? pointComps($0, built.pointDims[$0] ?? 2) : nil }
  ropts.documentNames = documentNames
  ropts.complex = { built.complexes[$0] }
  ropts.interval = { built.intervals[$0] }
  let getFn: GetFn = { name in
    if let fn = built.fns[name] { return fn }
    if fnNames.contains(name) { throw LanguageError("\(name) has an error in its definition.") }
    return nil
  }
  return buildRVDeclarations(
    scan, fnNames: fnNames, getFn: getFn, ropts: ropts, constNames: Set(built.consts.keys),
    // Already claimed by a definition row (lib/env.ts `nameTaken`).
    taken: { name in
      built.consts.has(name) || built.fields.has(name) || built.conditions.has(name) || built.fns.has(name)
        || built.points.contains(name) || built.complexes.has(name) || built.mats.has(name)
        || built.tensors.has(name) || built.lists.has(name)
    })
}

/// The probability rows of one analysis: the system of variables, which
/// expression rows add their anonymous ones to, and what reading a row's
/// body needs of the document.
struct DistributionRows {
  var rvs: RVSystem
  /// Every declared name, healthy or not.
  let rvNames: Set<String>
  let constNames: Set<String>
  /// The constants at t = 0 (t itself has no value here: a readout that
  /// needs one is left blank, as on the site).
  let constEnv: [String: Double]
  /// Constants that move with t.
  let moving: Set<String>
  /// Parse and resolve a row's body, exactly as a plot row is read.
  let parse: (String) throws -> Expr
  /// Expand point arithmetic (`lowerObjects`).
  let lower: (Expr) throws -> Expr
  /// Lower a P(…)/E(…) body: its points, then its lists (ObjectLists.swift `lowerBody`).
  let lowerBody: (Expr) throws -> Expr
  /// The user has defined the name as something `P(…)` could apply.
  let userDefined: (String) -> Bool

  // MARK: Declarations

  /// The row of a declared or derived variable (`X ~ Normal(0, 1)`, `Y = X^2`).
  mutating func declarationRow(_ row: inout RowAnalysis, _ name: String, error: String?) throws {
    if let error {
      row.error = error
      return
    }
    // Labelled from the family, before anything can fail: a discrete
    // declaration whose parameter is bad is still a pmf row with an error.
    row.dist = rvs.isDiscreteVar(name) ? .pmf : .density
    // Parameters that are constants are judged at their values: a = -1 then
    // X ~ Gamma(a, 1) is no distribution.
    if let problem = rvs.paramProblem(name, constEnv, moving: moving) {
      row.error = problem
      return
    }
    try classifyVariable(&row, name)
  }

  /// How a variable's row draws (lib/dist.ts `variableRow`, lib/analysis.ts
  /// `classifyVariable`): a pmf as stems when it is built on discrete bases
  /// alone; the exact density `y = pdf(x)`, classified for the shader, when
  /// its law is a closed-form pdf; else a density drawn on the CPU.
  private func classifyVariable(_ row: inout RowAnalysis, _ name: String) throws {
    let discrete = rvs.isDiscreteVar(name)
    if !discrete, let exact = rvs.exactDist(name) {
      row.dist = .density
      row.classified = try classify(try densityExpr(exact), defined: constNames, fields: [:])
      return
    }
    // Port: the site draws any other continuous variable too, by
    // quadrature or from its sample. Here only a law draws.
    if !discrete {
      guard case .usum? = rvs.exactLaw(name) else {
        throw Unsupported("the density of a transformed random variable")
      }
    }
    let ps = rvs.paramsOf(name)
    row.dist = discrete ? .pmf : .density
    row.classified = Classified(
      object: .distribution(form: discrete ? .pmf : .density, rv: name), animated: ps.contains("t"), needs3D: false,
      params: ps.list.filter { $0 != "t" })
    // A derived pmf row reads out as in the app: exact μ, σ.
    if discrete, case .derived? = rvs.get(name) {
      do {
        if let m = try rvs.moments(name, constEnv) { row.info = momentsReadout(m) }
      } catch let error as Unsupported {
        throw error
      } catch {
        // Not computable at t = 0 (animated): no readout.
      }
    }
  }

  // MARK: P(…) and E(…)

  /// The body of a P(…)/E(…) row, read exactly as a plot row is read, and
  /// lowered, so `P(X < mean(L))` sees the list two rows above. `==` and
  /// `!=` are the filter comparisons, which list lowering refuses outside a
  /// filter — but at the top of a P(…) they are a point event, so there the
  /// two sides lower on their own (lib/dist.ts `lowerProbBody`).
  private func parseRowBody(_ body: String, probability: Bool = false) throws -> Expr {
    let resolved = try parse(body)
    if probability, case .eqtest(let op, let l, let r) = resolved {
      return .eqtest(op, try lowerBody(l), try lowerBody(r))
    }
    return try lowerBody(resolved)
  }

  private func checkDeclared(_ names: [String]) throws {
    for name in names where !rvs.has(name) { throw LanguageError("\(name) has an error in its definition.") }
  }

  /// `P(…)` shades an area under a declared density — unless the user has
  /// defined P themselves as something P(…) could apply, in which case the
  /// row is theirs. False when the row is not one.
  mutating func probabilityRow(_ row: inout RowAnalysis, _ text: String, index: Int) throws -> Bool {
    guard !userDefined("P"), let body = matchProbability(text) else { return false }
    if rvNames.isEmpty { throw LanguageError("Define a random variable first, e.g. X ~ Normal(0, 1).") }
    let p = try toProbability(try parseRowBody(body, probability: true), rvNames)
    try checkDeclared(p.rvs)
    // Point events only of discrete variables.
    try rvs.checkProbability(p)
    row.dist = .probability
    // Inline bounded expressions become anonymous derived variables, so
    // shading and exact laws apply.
    var single = p.single
    if single == nil, let inline = p.inline {
      try checkDerived(inline.e, rvNames, constNames)
      let anon = "@P\(index)"
      try rvs.addAnonymous(.derived(name: anon, expr: inline.e))
      single = ProbShade(rv: anon, bounds: inline.bounds)
    }
    // Constant bounds on one variable with a closed form get the exact CDF
    // and the shader-drawn region; the rest answer from the variable's law.
    if let single, let exact = rvs.exactDist(single.rv) {
      row.classified = try classify(
        try regionExpr(exact, single.bounds.lo, single.bounds.hi), defined: constNames, fields: [:])
      // (Not numerically computable at t = 0, e.g. animated: no readout.)
      if let value = try? probabilityValue(exact, single.bounds.lo, single.bounds.hi, constEnv), value.isFinite {
        row.info = "≈ \(JS.toFixed(value, 4))"
      }
      return true
    }
    let ps = rvs.bodyParams(p.body)
    row.classified = Classified(
      object: .probability(body: p.body, shade: single), animated: ps.contains("t"), needs3D: false,
      params: ps.list.filter { $0 != "t" })
    do {
      let (value, settled) = try rvs.eventProbability(p.body, single, constEnv)
      if value.isFinite { row.info = "≈ \(JS.toFixed(value, settled ? 4 : 3))" }
    } catch let error as Unsupported {
      throw error
    } catch {
      // Animated or broken: no readout.
    }
    return true
  }

  /// `E(…)` is the mean of an expression in random variables — unless the
  /// user has defined E themselves. False when the row is not one.
  mutating func expectationRow(_ row: inout RowAnalysis, _ text: String, index: Int) throws -> Bool {
    guard !userDefined("E"), let body = matchExpectation(text) else { return false }
    if rvNames.isEmpty { throw LanguageError("Define a random variable first, e.g. X ~ Normal(0, 1).") }
    let ex = try toExpectation(try parseRowBody(body), rvNames)
    try checkDeclared(ex.rvs)
    row.dist = .expectation
    // A bare name is the variable itself; anything else registers as an
    // anonymous derived variable, so exact laws apply unchanged.
    let name: String
    if case .var(let n) = ex.body, rvs.has(n) {
      name = n
    } else {
      try checkDerived(ex.body, rvNames, constNames)
      name = "@E\(index)"
      try rvs.addAnonymous(.derived(name: name, expr: ex.body))
    }
    let ps = rvs.bodyParams(ex.body)
    row.classified = Classified(
      object: .distribution(form: .expect, rv: name), animated: ps.contains("t"), needs3D: false,
      params: ps.list.filter { $0 != "t" })
    do {
      // A closed form and a certified enumeration both earn full display precision.
      let m = try rvs.exactMoments(name, constEnv)?.mean ?? rvs.quadMoments(name, constEnv)?.mean
      let value = try m ?? rvs.mean(name, constEnv)
      if value.isFinite {
        row.info = "≈ \(readoutNumber(value, m != nil ? 4 : 3))"
      } else if try rvs.meanUnstable(name, constEnv) {
        row.info = NO_MEAN_INFO
      }
    } catch let error as Unsupported {
      throw error
    } catch {
      // Animated or broken: no readout.
    }
    return true
  }

  // MARK: Expression rows

  /// u and v in a real row with no x, y or z, as independent Uniform(0, 1)
  /// base variables under internal names — or nil when the row is not one,
  /// or cannot be a random variable (a tuple, a complex path), which leaves
  /// the row to classify, where u and v trace curves (lib/analysis.ts
  /// `uniformDraws`).
  ///
  /// Port: a continuous interval is a uniform draw over its bounds too, with
  /// the density drawn times its length; intervals are not ported.
  private func uniformDraws(_ e: Expr, id: String) -> (expr: Expr, bases: [RV])? {
    switch e {
    case .eq, .ineq: return nil
    default: break
    }
    if usesComplex(e) { return nil }
    let free = freeVars(e).list.filter { !constNames.contains($0) }
    let params = free.filter { $0 == "u" || $0 == "v" }
    if params.isEmpty || free.contains(where: { ["x", "y", "z", "w"].contains($0) }) { return nil }
    // Numbers have a density; a point does not. Which one the row is depends
    // on its value, not its spelling: only the lowered row says so. A row
    // that does not lower is not one the density path can draw either.
    guard let value = try? lower(e) else { return nil }
    switch value {
    case .vec, .figure, .family: return nil
    case .list(let items) where items.contains(where: { if case .vec = $0 { true } else { false } }): return nil
    case .lazy(_, .vec): return nil
    default: break
    }
    let uniform = BaseDist(kind: .uniform, args: [.num(0), .num(1)])
    var bases: [RV] = []
    var names: [String: Expr] = [:]
    for p in params {
      bases.append(.base(name: "@\(p)\(id)", dist: uniform))
      names[p] = .var("@\(p)\(id)")
    }
    let expr = substVars(e, names)
    guard (try? checkDerived(expr, rvNames.union(bases.map(\.name)), constNames)) != nil else { return nil }
    return (expr, bases)
  }

  /// A bare expression in random variables plots that derived density; so
  /// does a real row in u and v alone, which does not depend on the screen
  /// and is drawn as its values (docs/multisets.md §5). `resolved` is the
  /// row as resolved, before lowering. False when the row is not one.
  mutating func expressionRow(
    _ row: inout RowAnalysis, _ resolved: Expr, painted: Bool, text: String, index: Int
  ) throws -> Bool {
    var parsed = resolved
    var known = rvNames
    if !painted, let draws = uniformDraws(parsed, id: "\(index)") {
      for base in draws.bases {
        try rvs.addAnonymous(base)
        known.insert(base.name)
      }
      parsed = draws.expr
    }
    let rvRefs = freeVars(parsed).list.filter(known.contains)
    if rvRefs.isEmpty { return false }
    try checkDeclared(rvRefs)
    if case .ineq = parsed {
      throw LanguageError("An inequality in random variables is a probability: try P(\(text)).")
    }
    try checkDerived(parsed, known, constNames)
    let name = "@\(index)"
    try rvs.addAnonymous(.derived(name: name, expr: parsed))
    try classifyVariable(&row, name)
    return true
  }
}
