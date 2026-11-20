/// What a row is, mathematically (lib/math-object.ts `MathObject`,
/// lib/plot.ts `classify`): source expressions, never backend programs.
///
/// - "l = r" → an implicit curve in x and y
/// - an inequality in x and y → the region it holds in
/// - a bare scalar in x and/or y → a 2D scalar field, drawn per pixel
/// - a pair of numbers → a point; a pair in x and y → a vector field
/// - ODEs: dy/dx = f and y' = f are the direction field (1, f); a system
///   (x', y') = (P, Q) the phase-plane field (P, Q)
/// - a pair in u → the parametric curve it traces, u ∈ (0, 1)
/// - with no x or y at all, a number or a claim to read out
/// - t is always allowed and means "animated": seconds since the start
///
/// The 2D kinds above are the ones ported. Everything else the site draws
/// (surfaces, curves in space, systems, lists, …) throws `Unsupported`.
public indirect enum MathObject: Equatable, Sendable {
  /// `y = f(x)`: a curve that is a graph.
  case curveGraph(rhs: Expr, equation: Expr, levels: LevelSetSpec?)
  case curveImplicit(residual: Expr, equation: Expr, levels: LevelSetSpec?)
  case region(constraints: [Constraint])
  case scalarField(expr: Expr)
  case vectorField(components: [Expr])
  case point(coordinates: [Expr])
  /// A pair in u: the curve it traces as u runs from 0 to 1.
  case curveParametric(coordinates: [Expr])
  case value(expr: Expr)
  /// A claim with no x or y in it (`2 + 2 = 4`), or an equation whose sides
  /// agree everywhere (`identity`). `constant`: the row reads like a slider
  /// named e, pi or i, which the readout explains.
  case note(expr: Expr, variable: Bool, constant: String?, identity: Bool)

  /// The kind as the site's tools name it (`publicKind`).
  public var publicKind: String {
    switch self {
    case .curveGraph, .curveImplicit: "implicit2d"
    case .region: "ineq2d"
    case .scalarField: "scalar2d"
    case .vectorField: "vfield2d"
    case .point: "point"
    case .curveParametric: "pcurve"
    case .value: "value"
    case .note: "note"
    }
  }
}

/// One side of a region: the residual is negative inside it.
public struct Constraint: Equatable, Sendable {
  public var residual: Expr
  public var strict: Bool
}

/// `f(x, y) = c` with c a defined constant: f, whose level sets the plot
/// can draw as a family.
public struct LevelSetSpec: Equatable, Sendable {
  public var name: String
  public var expr: Expr
  public var params: [String]
  public var level: String?
}

public struct Classified: Equatable, Sendable {
  public var object: MathObject
  public var animated: Bool
  public var needs3D: Bool
  public var params: [String]
}

/// The message for a row that tries to define t, which is animation time.
let tReserved =
  "t is reserved for time (it animates, counting seconds); use another name for a constant, like k = 3, "
  + "and write k where you meant t."

private let spaceVarNames: Set<String> = ["x", "y", "z"]
private let paramVarNames: Set<String> = ["u", "v"]

/// JavaScript's default sort: by UTF-16 code units.
func jsSorted(_ names: [String]) -> [String] {
  names.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
}

private func isVar(_ e: Expr, _ name: String) -> Bool {
  if case .var(name) = e { return true }
  return false
}

private func isVec(_ e: Expr) -> Bool {
  if case .vec = e { return true }
  return false
}

/// Result typing (lib/complex.ts `inferScalarType`), for real expressions:
/// what it is for here is what it refuses.
func checkScalar(_ e: Expr) throws {
  switch e {
  case .num, .var: return
  case .neg(let a): try checkScalar(a)
  case .bin(_, let a, let b, _):
    try checkScalar(a)
    try checkScalar(b)
  case .call(_, let args): for a in args { try checkScalar(a) }
  case .eq(let l, let r):
    try checkScalar(l)
    try checkScalar(r)
  case .ineq: throw LanguageError("Unexpected inequality.")
  case .vec: throw LanguageError("Vector in scalar context.")
  case .list: throw LanguageError("A list can only be plotted as its own row.")
  case .piecewise(let cases, let otherwise):
    func condition(_ cond: Expr) throws {
      if case .ineq(_, let l, let r, _) = cond {
        try condition(l)
        try condition(r)
      } else {
        try checkScalar(cond)
      }
    }
    for c in cases {
      try condition(c.cond)
      try checkScalar(c.value)
    }
    if let otherwise { try checkScalar(otherwise) }
  case .index, .range, .eqtest: throw LanguageError("This object must be lowered before scalar type inference.")
  case .str: throw LanguageError("Expected a scalar expression.")
  }
}

/// Match an equation that spells an ODE — dy/dx = f, y' = f, or a system
/// (x', y') = (P, Q) — and return its direction field as a tuple (lib/ode.ts).
func matchODE(_ e: Expr) throws -> [Expr]? {
  guard case .eq(let l, let r) = e else { return nil }
  if case .bin(.div, let a, let b, _) = l {
    if isVar(a, "dy") && isVar(b, "dx") { return [.num(1), r] }
    if isVar(a, "dx") && isVar(b, "dy") { return [r, .num(1)] }
  }
  if isVar(l, "y'") { return [.num(1), r] }
  guard case .vec(let items) = l else { return nil }
  if items.count == 3, isVar(items[0], "x'"), isVar(items[1], "y'"), isVar(items[2], "z'") {
    guard case .vec(let velocity) = r, velocity.count == 3 else {
      throw LanguageError("A 3D flow needs three velocity components.")
    }
    return velocity
  }
  if items.count == 2, isVar(items[0], "x'"), isVar(items[1], "y'") {
    guard case .vec(let velocity) = r, velocity.count == 2 else {
      throw LanguageError("A system needs two components on the right: (x', y') = (P, Q).")
    }
    return velocity
  }
  return nil
}

/// A named condition (`within = r < R`, written in with the fields) read as
/// a number — anywhere but a whole row or a piecewise case's condition.
private func conditionAsValue(_ e: Expr, _ fields: [String: Expr], whole: Bool = true) -> String? {
  if case .var(let name) = e {
    if !whole, case .ineq? = fields[name] { return name }
    return nil
  }
  var parts: [Expr]
  if case .piecewise(let cases, let otherwise) = e {
    parts = cases.flatMap { c -> [Expr] in
      if case .var = c.cond { return [c.value] }
      return [c.cond, c.value]
    }
    if let otherwise { parts.append(otherwise) }
  } else {
    parts = childrenOf(e)
  }
  for part in parts {
    if let hit = conditionAsValue(part, fields, whole: false) { return hit }
  }
  return nil
}

/// `f(x,y) = c` (either way around) where c is a defined constant: the
/// level-set family of f, so the plot can draw the whole contour stack.
private func levelFamily(_ l: Expr, _ r: Expr, _ params: [String], _ defined: Set<String>) -> LevelSetSpec? {
  func level(_ s: Expr) -> String? {
    if case .var(let name) = s, params.contains(name) { return name }
    return nil
  }
  let f: Expr
  let name: String?
  if let c = level(r) {
    f = l
    name = c
  } else if level(l) != nil {
    f = r
    // (The level is the left side when that is a name.)
    if case .var(let left) = l { name = left } else { name = nil }
  } else {
    return nil
  }
  let fv = freeVarNames(f)
  if !fv.contains("x") && !fv.contains("y") { return nil }
  return LevelSetSpec(name: "F", expr: f, params: jsSorted(fv.list.filter(defined.contains)), level: name)
}

/// Whether the two sides of an equation agree at every x, y, z, t and slider
/// value — a numerical check, not a proof: they are compared at seeded
/// random points spread over several scales, where both are defined.
func holdsEverywhere(_ l: Expr, _ r: Expr) -> Bool {
  let names = freeVarNames(.eq(l, r)).list.filter { $0 != "pi" && $0 != "e" }
  var seed: Int32 = Int32(truncatingIfNeeded: 0x9e37_79b9 as UInt32)
  func random() -> Double {
    seed = seed &+ 0x6d2b_79f5
    let s = UInt32(bitPattern: seed)
    var q = UInt32(bitPattern: Int32(bitPattern: s ^ (s >> 15)) &* Int32(bitPattern: 1 | s))
    q = (q &+ UInt32(bitPattern: Int32(bitPattern: q ^ (q >> 7)) &* Int32(bitPattern: 61 | q))) ^ q
    return Double(q ^ (q >> 14)) / 4294967296
  }
  // Magnitudes from 0.1 to 100, either sign.
  func sample() -> Double {
    let sign: Double = random() < 0.5 ? -1 : 1
    return sign * JS.pow(10, 3 * random() - 1)
  }
  var agreed = 0
  var k = 0
  while k < 64 && agreed < 24 {
    k += 1
    var env: [String: Double] = [:]
    for n in names { env[n] = sample() }
    guard let a = try? evaluate(l, env), let b = try? evaluate(r, env) else { return false }
    if !a.isFinite || !b.isFinite { continue }
    if abs(a - b) > 1e-9 * (1 + abs(a) + abs(b)) { return false }
    agreed += 1
  }
  return agreed >= 24
}

/// Classify a lowered row (`classifyLowered`). `defined` are the names with
/// a value each frame; `fields` the coordinate fields and named conditions,
/// written into the row here.
func classify(_ lowered: Expr, defined: Set<String>, fields: [String: Expr]) throws -> Classified {
  var expr = lowered
  if fields.values.contains(where: { if case .ineq = $0 { true } else { false } }),
    let misread = conditionAsValue(expr, fields)
  {
    throw LanguageError(conditionAsNumber(misread))
  }
  // A row naming coordinates in a tuple on the left: a position
  // `(r, theta) = (2, pi/4)`, or a planar flow `(r', theta') = (F, G)`
  // (lib/coordinate.ts). Only the Cartesian flow (x', y') is ported.
  if case .eq(.vec(let names), _) = expr,
    names.allSatisfy({ if case .var = $0 { true } else { false } })
  {
    let written = names.compactMap { item -> String? in if case .var(let n) = item { n } else { nil } }
    let flow = written.contains { $0.hasSuffix("'") }
    if flow ? written != ["x'", "y'"] : written.allSatisfy({ spaceVarNames.contains($0) || fields[$0] != nil }) {
      throw Unsupported("coordinates named in a tuple")
    }
    if flow, case .eq(_, let rhs) = expr {
      guard case .vec(let velocity) = rhs else {
        throw LanguageError("A coordinate flow needs two components on the right.")
      }
      if velocity.count != 2 {
        throw LanguageError("Mismatched components: 2 on the left, \(velocity.count) on the right.")
      }
    }
  }
  if !fields.isEmpty { expr = substVars(expr, fields) }
  let ode = try matchODE(expr)
  if let ode { expr = .vec(ode) }

  var vars = freeVarNames(expr)
  if vars.contains("i") || vars.contains("w") { throw Unsupported("complex numbers") }
  var params: [String] = []
  for v in vars.list where defined.contains(v) {
    params.append(v)
    vars.remove(v)
  }
  params = jsSorted(params)
  for v in vars where !spaceVarNames.contains(v) && !paramVarNames.contains(v) && v != "t" {
    if v.hasSuffix("'") { throw LanguageError("\(v) can only appear on the left of an ODE like y' = x - y.") }
    let u = Array(v.utf16)
    if v == "d" || (u.count == 2 && u[0] == unit("d") && isASCIILetter(u[1])) {
      throw LanguageError("Write derivatives as d/dx (…).")
    }
    if let fn = builtinFn(v) {
      throw LanguageError("\(v) is a function — write it with parentheses, e.g. \(fn)(x).")
    }
    throw LanguageError("Unknown variable: \(v). Define \"\(v) = 1\" to make a slider.")
  }
  let animated = vars.contains("t")
  let hasParam = vars.contains("u") || vars.contains("v")
  let hasSpace = vars.contains("x") || vars.contains("y") || vars.contains("z")
  var paramSystem = false
  if case .eq(.vec, _) = expr { paramSystem = vars.contains("u") && !vars.contains("v") }
  if hasParam && hasSpace && !paramSystem { throw LanguageError("Cannot mix u/v with x/y/z.") }

  func done(_ object: MathObject) -> Classified {
    var moving = animated
    if case .vectorField = object { moving = true }
    return Classified(object: object, animated: moving, needs3D: false, params: params)
  }

  // `t = 3` reads like a constant, but t is time: the row would be a silent
  // claim about the clock. Say so instead of drawing nothing.
  if case .eq(.var("t"), let r) = expr, !freeVarNames(r).contains("t"), !hasSpace, !hasParam {
    throw LanguageError(tReserved)
  }
  var sides: (l: Expr, r: Expr)?
  switch expr {
  case .eq(let l, let r), .ineq(_, let l, let r, _): sides = (l, r)
  default: break
  }
  if let sides, !isVec(sides.l), !isVec(sides.r), !hasSpace, !hasParam {
    return done(.note(expr: expr, variable: animated || !params.isEmpty, constant: nil, identity: false))
  }
  // An equation whose sides agree everywhere has no curve to draw — it is a
  // claim, and it holds.
  if case .eq(let l, let r) = expr, !isVec(l), !isVec(r), hasSpace, !hasParam, holdsEverywhere(l, r) {
    return done(.note(expr: expr, variable: false, constant: nil, identity: true))
  }

  if case .vec(let items) = expr {
    // Longer than a point: values at positions, shown as a readout.
    if items.count > 3 {
      if hasSpace || hasParam || items.contains(where: isVec) {
        throw LanguageError(
          "A tuple of more than 3 values is a value to read, not a picture: (1, 2, 3, 5, 8).")
      }
      throw Unsupported("tuples of more than 3 values")
    }
    if hasSpace || ode != nil {
      if hasParam { throw LanguageError("Vector fields cannot use u or v.") }
      if items.count == 3 { throw Unsupported("vector fields in space") }
      if vars.contains("z") { throw LanguageError("A field using z needs three components.") }
      return done(.vectorField(components: items))
    }
    if vars.contains("v") && !vars.contains("u") { throw LanguageError("Parametric surfaces use u (and v).") }
    if vars.contains("u") && vars.contains("v") { throw Unsupported("parametric regions and surfaces") }
    if items.count == 3 { throw Unsupported(vars.contains("u") ? "parametric curves in space" : "points in space") }
    if vars.contains("u") { return done(.curveParametric(coordinates: items)) }
    return done(.point(coordinates: items))
  }

  if hasParam && !paramSystem {
    throw LanguageError(
      "u and v trace a curve or surface in a tuple, like (cos(u), sin(u)) or (u, v, u v); "
        + "to set the range one runs over, define it as an interval: u = interval(0, 2pi)."
    )
  }

  // A vector equation is a system, one residual per component.
  if case .eq(let l, let r) = expr, isVec(l) || isVec(r) {
    guard case .vec(let left) = l, case .vec(let right) = r else {
      throw LanguageError("A vector equation needs components on both sides, like (f, g) = (0, 0).")
    }
    if left.count != right.count {
      throw LanguageError("Mismatched components: \(left.count) on the left, \(right.count) on the right.")
    }
    throw Unsupported("systems of equations")
  }

  if case .ineq = expr {
    if vars.contains("z") { throw LanguageError("Inequalities are 2D only.") }
    let comparisons = ineqComparisons(expr)
    if Set(comparisons.map { $0.op == .lt || $0.op == .le }).count > 1 {
      throw LanguageError("Chained inequalities must point the same way.")
    }
    var constraints: [Constraint] = []
    for c in comparisons {
      let less = c.op == .lt || c.op == .le
      let residual = Expr.bin(.sub, less ? c.l : c.r, less ? c.r : c.l)
      try checkScalar(residual)
      constraints.append(Constraint(residual: residual, strict: c.op == .lt || c.op == .gt))
    }
    return done(.region(constraints: constraints))
  }

  if case .eq(let l, let r) = expr {
    try checkScalar(l)
    try checkScalar(r)
    if vars.contains("z") { throw Unsupported("surfaces in space") }
    let graphRhs: Expr? = isVar(l, "y") ? r : isVar(r, "y") ? l : nil
    let levels = levelFamily(l, r, params, defined)
    if let graphRhs, !freeVarNames(graphRhs).contains("y") {
      return done(.curveGraph(rhs: graphRhs, equation: expr, levels: levels))
    }
    return done(.curveImplicit(residual: .bin(.sub, l, r), equation: expr, levels: levels))
  }

  // A bare scalar that depends on the screen's x and y is drawn at every
  // pixel. There is no implicit graph: the curve is `y = sin(x)`.
  try checkScalar(expr)
  if vars.contains("z") { throw Unsupported("scalar fields in space") }
  if hasSpace { return done(.scalarField(expr: expr)) }
  return done(.value(expr: expr))
}
