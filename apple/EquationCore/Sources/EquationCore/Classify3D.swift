/// What a row is in space (lib/plot.ts `classifyLowered`, lib/math-object.ts
/// `objectNeeds3D`): the parts of classification that only a 3D row reaches.
/// `classify` (Classify.swift) calls in here where the TypeScript's one
/// function goes on.
///
/// - an equation in x, y, z → the surface it holds on; `revolve(f)` is one
/// - a bare scalar in x, y, z → a cloud
/// - a triple in u → a curve in space (`tube(…)` sweeps it), in u and v a surface
/// - a triple of numbers → a point; a triple in x, y, z → a vector field
/// - `(f, g) = (a, b)` in x, y, z → the curve two surfaces meet in
/// - `(f, g, h) = (a, b, c)` → the points a square system cuts out

private let spaceVarNames: Set<String> = ["x", "y", "z"]
private let paramVarNames: Set<String> = ["u", "v"]

/// Default sweep radius for tube(…) when no explicit radius is given.
private let defaultTubeRadius = 0.1

/// The axes revolve(f, axis) turns a profile about (lib/expr.ts `REVOLVE_AXES`).
private let revolveAxes = ["x", "y", "z"]

/// Whether a document with this object in it is drawn in space (`objectNeeds3D`).
func objectNeeds3D(_ object: MathObject) -> Bool {
  switch object {
  case .surfaceImplicit, .surfaceParametric, .intersection, .scalarField3D, .curveTube: true
  case .point(let coordinates), .curveParametric(let coordinates): coordinates.count == 3
  case .vectorField(let components): components.count == 3
  case .system(let residuals, _, _): residuals.count == 3
  default: false
  }
}

/// tube(curve[, radius]): sweep a 3D parametric curve as a lit tube
/// (`matchTube`). Opt-in by design: a bare curve stays a line strip, so a
/// tube can never swallow points or curves sharing the scene.
func matchTube(_ e: Expr) throws -> (inner: Expr, radius: Expr)? {
  guard case .call("tube", let written) = e else { return nil }
  // A parenthesized vector inside a call flattens into the argument list, so
  // tube((x, y, z)) and tube(x, y, z) arrive here identically, and a fourth
  // argument is the radius.
  let args = legacyCallArgs("tube", written)
  if args.count != 3 && args.count != 4 {
    throw LanguageError("tube takes three components and an optional radius: tube(cos(u), sin(u), u/4, 0.1).")
  }
  var radius = Expr.num(defaultTubeRadius)
  if args.count == 4 {
    if case .num(let value) = args[3], !(value > 0) {
      throw LanguageError("The tube radius must be a positive number.")
    }
    radius = args[3]
  }
  return (.vec(Array(args[..<3])), radius)
}

/// What classify asks of a tube's radius once the curve is split off: one
/// real number, which may vary with time and sliders but not along the
/// curve or across space. Its names join the row's.
func checkTubeRadius(_ r: Expr, _ vars: inout NameSet) throws {
  var single = !usesComplex(r)
  switch r {
  case .vec, .list, .eq, .ineq: single = false
  default: break
  }
  if !single { throw LanguageError("The tube radius must be a single real number.") }
  // The radius was split off before the root-only check, so whole-expression
  // forms hiding inside it need their own rejection.
  if let form = nestedSpecial(r) { throw LanguageError("\(form)(…) must be the whole expression.") }
  for v in freeVars(r) {
    if spaceVarNames.contains(v) || paramVarNames.contains(v) {
      throw LanguageError("The tube radius can only use constants, sliders, and t.")
    }
    vars.insert(v)
  }
}

/// The axis revolve's optional second argument names (lib/expr.ts `revolveAxis`).
func revolveAxis(_ ax: Expr?) throws -> String {
  guard let ax else { return "x" }
  if case .var(let name) = ax, revolveAxes.contains(name) { return name }
  throw LanguageError("The revolve axis must be x, y, or z: revolve(y^2, y).")
}

/// revolve(f[, axis]): the surface swept by turning the curve y = f(x) about
/// the x-axis, or a profile in y or z about that axis (`matchRevolve`). It
/// is nothing but the implicit surface y^2 + z^2 = f(x)^2, so the raymarcher
/// and the symbolic gradient render it as they would the equation.
func matchRevolve(_ e: Expr) throws -> Expr? {
  guard case .call("revolve", let args) = e else { return nil }
  if args.count != 1 && args.count != 2 {
    throw LanguageError(
      "revolve takes a profile and an optional axis: revolve(sqrt(x)), or revolve(y^2, y) about the y-axis.")
  }
  let f = args[0]
  let axis = try revolveAxis(args.count == 2 ? args[1] : nil)
  let form = args.count == 2 ? "revolve(f, \(axis))" : "revolve(f)"
  switch f {
  case .list, .data:
    throw LanguageError("revolve of a list is not supported yet — write one revolve(…) row per profile.")
  case .vec, .eq, .ineq, .str, .text:
    throw LanguageError("\(form) takes a single real expression in \(axis), like revolve(sqrt(x)).")
  default: break
  }
  // The profile was split off before the root-only check in classify, so a
  // whole-expression form hiding inside it needs its own rejection.
  if let nested = nestedSpecial(f) { throw LanguageError("\(nested)(…) must be the whole expression.") }
  if usesComplex(f) {
    throw LanguageError("\(form) takes a real expression in \(axis); complex values cannot be revolved.")
  }
  for v in freeVars(f) where v != axis && (spaceVarNames.contains(v) || paramVarNames.contains(v)) {
    throw LanguageError("\(form) takes an expression in \(axis) only.")
  }
  func sq(_ a: Expr) -> Expr { .bin(.pow, a, .num(2)) }
  let others = revolveAxes.filter { $0 != axis }
  return .eq(.bin(.add, sq(.var(others[0])), sq(.var(others[1]))), sq(f))
}

/// Whether a side of a system is a direct angle coordinate — atan2, or the
/// angle(…) measurement — which is periodic; nesting one inside a real
/// expression does not make that expression an angle.
private func isAngle(_ e: Expr) -> Bool {
  if case .call(let name, let args) = e {
    return name == "atan2" || name == ANGLE_FN || (name == "atan" && args.count == 2)
  }
  return false
}

/// A vector equation, one residual per component: F(x, y, z) = (a, b, c) is
/// the fiber of a map, (f, g) = (0, 0) in space an intersection of surfaces.
/// Square systems (as many equations as unknowns) cut out isolated points;
/// the solver finds them numerically.
func classifySystem(
  _ left: [Expr], _ right: [Expr], vars: NameSet, hasParam: Bool, parametric: Bool
) throws -> MathObject {
  let dim = vars.contains("z") ? 3 : 2
  if left.count == 2 && dim == 3 && !hasParam {
    return .intersection(
      residuals: zip(left, right).map { a, b in
        let residual = Expr.bin(.sub, a, b)
        return isAngle(a) ? .call("atan2", [.call("sin", [residual]), .call("cos", [residual])]) : residual
      })
  }
  if left.count != dim {
    let eqs = "\(left.count) equation\(left.count == 1 ? "" : "s")"
    throw LanguageError("\(eqs) in \(dim) unknowns — a system needs one equation per unknown.")
  }
  // Port: a system in the plane draws its solutions over the 2D window,
  // which Graph2D's overlay is not given.
  if dim == 2 { throw Unsupported("systems of equations in the plane") }
  return .system(
    residuals: zip(left, right).map { .bin(.sub, $0, $1) }, parametric: parametric, angular: left.map(isAngle))
}

/// A flow in space written on the axes themselves, `(x', y', z') = (P, Q, R)`
/// in any order (lib/coordinate.ts `lowerCoordinateFlow`, its three-coordinate
/// case): the velocities solved for x', y' and z' by Cramer's rule through
/// the coordinates' Jacobian, a permutation here. Nil for any other row — a
/// flow in coordinates that are fields is not ported.
func lowerSpaceFlow(_ expr: Expr, _ fields: [String: Expr]) throws -> Expr? {
  guard case .eq(.vec(let names), let right) = expr, names.count == 3 else { return nil }
  var bases: [String] = []
  for item in names {
    guard case .var(let name) = item, name.hasSuffix("'") else { return nil }
    bases.append(String(name.dropLast()))
  }
  guard Set(bases) == spaceVarNames else { return nil }
  guard case .vec(let velocity) = right else {
    throw LanguageError("A coordinate flow needs two components on the right.")
  }
  if velocity.count != 3 {
    throw LanguageError("Mismatched components: 3 on the left, \(velocity.count) on the right.")
  }
  let axes = ["x", "y", "z"]
  let jac: [[Expr]] = bases.map { base in axes.map { .num($0 == base ? 1 : 0) } }
  // (An axis does not move with t: its time derivative is the 0 taken off.)
  let rhs = velocity.map { Expr.bin(.sub, fields.isEmpty ? $0 : substVars($0, fields), .num(0)) }
  return .eq(.vec(["x'", "y'", "z'"].map { .var($0) }), .vec(solveVec(jac, rhs)))
}

/// Whether a row names three coordinates in a tuple on the left — a position
/// in space, `(rho, theta, phi) = (2, pi/4, pi/3)` — with what the site says
/// of one it cannot read (lib/coordinate.ts `coordinateRow`). Its
/// coordinates are axes or fields, which classify writes in: it is then a
/// system in x, y and z like any other.
func isSpacePosition(_ names: [String], _ expr: Expr, _ fields: [String: Expr]) throws -> Bool {
  guard names.count == 3, names.allSatisfy({ spaceVarNames.contains($0) || fields[$0] != nil }),
    case .eq(_, let right) = expr
  else { return false }
  if Set(names).count != names.count {
    throw LanguageError(
      "(\(names.joined(separator: ", "))) repeats a coordinate — use distinct coordinates to determine "
        + "a point or flow.")
  }
  guard case .vec(let items) = right else {
    throw LanguageError("A vector equation needs components on both sides.")
  }
  if items.count != 3 {
    throw LanguageError("Mismatched components: 3 on the left, \(items.count) on the right.")
  }
  return true
}
