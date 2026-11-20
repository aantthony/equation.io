/// Coordinate notation lowers to the same Cartesian objects as ordinary rows
/// (lib/coordinate.ts).

private let coordinateAxes: Set<String> = ["x", "y", "z"]

/// A row naming coordinates in a tuple on the left (`coordinateRow`): a
/// position `(r, theta) = (2, pi/4)` — two coordinates in the plane, three in
/// space — or a planar flow `(r', theta') = (F, G)`.
struct CoordinateRow {
  /// Each coordinate as a function of x, y and z.
  var coords: [Expr]
  var flow: Bool
  var rhs: [Expr]
}

/// The coordinate row `expr` is, or nil for any other row.
func coordinateRow(_ expr: Expr, _ fields: [String: Expr]) throws -> CoordinateRow? {
  guard case .eq(.vec(let items), let right) = expr else { return nil }
  var names: [String] = []
  for item in items {
    guard case .var(let name) = item else { return nil }
    names.append(name)
  }
  let flow = names.contains { $0.hasSuffix("'") }
  if !flow && !names.allSatisfy({ coordinateAxes.contains($0) || fields[$0] != nil }) { return nil }
  if flow && !names.allSatisfy({ $0.hasSuffix("'") }) {
    throw LanguageError("A coordinate flow needs a prime on every coordinate.")
  }
  let bases = names.map { flow ? String($0.dropLast()) : $0 }
  let shown = "(\(names.joined(separator: ", ")))"
  if Set(bases).count != bases.count {
    throw LanguageError("\(shown) repeats a coordinate — use distinct coordinates to determine a point or flow.")
  }
  if bases.count != 2 && bases.count != 3 {
    throw LanguageError(
      flow
        ? "A coordinate flow needs two coordinates — flows are 2D only."
        : "Use two coordinates to determine a point in the plane, or three in space.")
  }
  let coords = try bases.map { n -> Expr in
    if coordinateAxes.contains(n) { return .var(n) }
    if let field = fields[n] { return field }
    throw LanguageError("\(n) is not a coordinate — define \(n) as a function of x and y first.")
  }
  if flow && bases.count == 2 {
    if let k = bases.indices.first(where: { freeVars(coords[$0]).contains("z") }) {
      let spatial = bases[k]
      if spatial == "z" { throw LanguageError("Coordinate flows are 2D only — z cannot be a flow coordinate.") }
      throw LanguageError("\(spatial) uses z, and coordinate flows are 2D only.")
    }
  }
  let n = bases.count
  guard case .vec(let rhs) = right else {
    throw LanguageError(
      flow
        ? "A coordinate flow needs two components on the right."
        : "A vector equation needs components on both sides.")
  }
  if rhs.count != n { throw LanguageError("Mismatched components: \(n) on the left, \(rhs.count) on the right.") }
  return CoordinateRow(coords: coords, flow: flow, rhs: rhs)
}

/// A flow written in coordinates, `(r', theta') = (F, G)`, as the Cartesian
/// flow it is (`lowerCoordinateFlow`): the velocities solved for x' and y'
/// (and z') through the coordinates' Jacobian. Any other row comes back with
/// the fields written in.
func lowerCoordinateFlow(_ expr: Expr, _ fields: [String: Expr]) throws -> Expr {
  func timeDerivative(_ e: Expr) throws -> Expr { try diff(e, "t") }
  func isVar(_ e: Expr, _ name: String) -> Bool { if case .var(name) = e { true } else { false } }
  guard let row = try coordinateRow(expr, fields), row.flow,
    !(row.coords.count == 2 && isVar(row.coords[0], "x") && isVar(row.coords[1], "y"))
  else { return fields.isEmpty ? expr : substVars(expr, fields) }
  func isZero(_ determinant: Expr) throws -> Bool {
    try freeVars(determinant).list.isEmpty && evaluate(determinant, [:]) == 0
  }
  let singular = "These coordinates have a singular Jacobian and do not determine a flow."
  if row.coords.count == 3 {
    let jac = try row.coords.map { c in try ["x", "y", "z"].map { try diff(c, $0) } }
    if try isZero(detOf(jac)) { throw LanguageError(singular) }
    let rhs = try row.rhs.enumerated().map { k, c in
      Expr.bin(.sub, substVars(c, fields), try timeDerivative(row.coords[k]))
    }
    return .eq(.vec(["x'", "y'", "z'"].map { .var($0) }), .vec(solveVec(jac, rhs)))
  }
  let (a, b) = (row.coords[0], row.coords[1])
  let velocity = try row.rhs.enumerated().map { k, e in
    Expr.bin(.sub, substVars(e, fields), try timeDerivative(row.coords[k]))
  }
  let (f, g) = (velocity[0], velocity[1])
  let (ax, ay, bx, by) = (try diff(a, "x"), try diff(a, "y"), try diff(b, "x"), try diff(b, "y"))
  let det = Expr.bin(.sub, .bin(.mul, ax, by), .bin(.mul, ay, bx))
  if try isZero(det) { throw LanguageError(singular) }
  // Emit Cartesian prime notation so even a constant velocity remains a field.
  return .eq(
    .vec(["x'", "y'"].map { .var($0) }),
    .vec([
      .bin(.div, .bin(.sub, .bin(.mul, by, f), .bin(.mul, ay, g)), det),
      .bin(.div, .bin(.sub, .bin(.mul, ax, g), .bin(.mul, bx, f)), det),
    ]))
}
