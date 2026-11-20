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
  // (A list of points in space; ListPlans.swift.)
  case .list(.points(3, _)), .list(.scatter(3, _)): true
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
  return .system(
    residuals: zip(left, right).map { .bin(.sub, $0, $1) }, parametric: parametric, angular: left.map(isAngle))
}
