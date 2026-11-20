/// A fit's row among the definitions (lib/defs.ts `buildDefs`, the
/// 'regression' case): `P.y ~ m P.x + b` reads its two sides as a row does,
/// lowers their points and lists, and hands the numbers to `fitRegression`.
/// The fitted coefficients are constants of the document from then on.

/// The two sides of a fit as parsed (the row's source, for what it references).
func parseFit(
  _ lhs: String, _ rhs: String, userFns: Set<String>, valueNames: Set<String>, listNames: Set<String>
) throws -> (lhs: Expr, rhs: Expr) {
  (
    try parseExpr(lhs, userFns: userFns, listNames: listNames, valueNames: valueNames),
    try parseExpr(rhs, userFns: userFns, listNames: listNames, valueNames: valueNames)
  )
}

/// Already claimed by a definition above (lib/defs.ts `draftNameTaken`, for
/// the stores ported).
private func draftNameTaken(_ defs: BuiltDefs, _ n: String) -> Bool {
  defs.consts.has(n) || defs.fns.has(n) || defs.fields.has(n) || defs.complexes.has(n) || defs.conditions.has(n)
    || defs.states.has(n) || defs.points.contains(n) || defs.mats.has(n) || defs.tensors.has(n) || defs.lists.has(n)
}

/// Fit a parsed `observed ~ model` row against the definitions above it.
/// `numEnv`: the constants' values so far, which stay fixed. `isRow`: a name
/// some definition row of the document owns, above or below.
func fitRow(
  _ source: (lhs: Expr, rhs: Expr), _ defs: BuiltDefs, _ numEnv: [String: Double], getFn: @escaping GetFn,
  opts: ResolveOpts, isRow: (String) -> Bool, stateNames: Set<String>
) throws -> FitResult {
  let lhs = try Resolver(getFn: getFn, opts: opts).resolve(source.lhs)
  let rhs = try Resolver(getFn: getFn, opts: opts).resolve(source.rhs)
  let rhsVars = freeVars(rhs)
  let getList = listGetter(defs)
  // Points first, as in a plot row: `Y ~ g(A) X + b` reads g at the point A.
  func points(_ e: Expr) throws -> Expr {
    try lowerGeom(
      e, comps: opts.comps, mats: { defs.mats[$0] }, isList: { name in ((try? getList(name)) ?? nil) != nil })
  }
  let parameters = rhsVars.list.filter { n in
    nameable(n) && !isRow(n) && !draftNameTaken(defs, n) && !n.utf16.contains(unit("."))
  }
  if parameters.isEmpty {
    throw LanguageError("Regression needs an unbound coefficient, like Y ~ m X + b. Defined constants stay fixed.")
  }
  if parameters.count > 8 { throw LanguageError("Regression supports at most 8 fitted coefficients.") }
  for n in rhsVars where reservedNames.contains(n) || stateNames.contains(n) {
    throw LanguageError("Regression models must be static; \(n) cannot vary during a fit.")
  }
  func numericList(_ p: Low) throws -> [Double] {
    if p.isData { return p.values }
    guard p.isList else {
      throw LanguageError("Regression observations must be a numeric list, like Y ~ m X + b.")
    }
    return try p.items.map { item in
      for n in freeVars(item) where numEnv[n] == nil {
        throw LanguageError("Regression data must be static; define \(n) above the fit.")
      }
      return try evaluate(item, numEnv)
    }
  }
  let observed = try numericList(try lowerLists(try points(lhs), getList, opts))
  if observed.count > 10_000 {
    throw LanguageError("Regression supports at most 10000 observations; filter the data first.")
  }
  // Keep model arithmetic symbolic even for packed columns. The usual fast
  // path folds ln(-1) into NaN; a fit must distinguish an invalid model from
  // a missing input pair instead of dropping it.
  let model = try lowerLists(
    try points(rhs),
    { name in
      guard let value = try getList(name), value.isData else { return try getList(name) }
      if value.values.count > 10_000 {
        throw LanguageError("Regression supports at most 10000 observations; filter the data first.")
      }
      return Low(.list(value.values.map { .num($0) }), value.own, none: value.none)
    }, opts)
  let models: [Expr] =
    model.isList
    ? model.items : model.isData ? model.values.map { .num($0) } : Array(repeating: model.e, count: observed.count)
  for f in models {
    for n in freeVars(f) where !parameters.contains(n) && numEnv[n] == nil {
      throw LanguageError("Regression models must be static; define \(n) above the fit.")
    }
  }
  return try fitRegression(observed, models, parameters, numEnv)
}
