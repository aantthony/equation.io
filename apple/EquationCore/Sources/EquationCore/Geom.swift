/// Point values and geometry statements (lib/geom.ts).
///
/// Point arithmetic (±, scalar ×/÷, dot, cross, perp, midpoint, unit, rotate,
/// distance, angle, |P|) is lowered into componentwise scalar expressions,
/// with a point name `A` expanding to the derived constants `A_x`, `A_y` (and
/// `A_z` in space), so everything downstream — GLSL, evaluate, diff — still
/// sees only scalars.
///
/// The statement forms segment/polyline/vector/polygon/square/hull desugar to
/// a `figure` node holding a flat scalar vertex list (classify turns it into
/// a CPU-drawn polygon plot); line and circle desugar to ordinary implicit
/// equations.
///
/// `lowerPoints` (Resolve.swift) is the TypeScript's `lower`; what it does
/// for calls, for `f(P)` and for whole statements is here.

/// Whole-statement geometry forms (like the special forms, they never nest).
let GEOM_STATEMENTS: Set<String> = ["segment", "polyline", "vector", "line", "polygon", "square", "circle", "hull"]

/// The calls lowering reads as geometry: the resolver hands them on as written.
let geometryFunctions: Set<String> = GEOM_STATEMENTS.union([
  "dot", "cross", "midpoint", "perp", "unit", "rotate", "distance", "angle", "label",
  // Matrices and tensors.
  "det", "trace", "transpose", "solve", "outer", "wedge", "contract", "streamlines",
  // Multivectors, projective geometry and their glyphs (GeomAlgebra.swift).
  "gp", "rev", "grade", "dual", "quat", "slerp", "vec", "meet", "join", "plane", "project", "reflect", "motor",
  "action", "qjulia",
])

/// Lower a whole statement (lib/geom.ts `lowerStatement`): desugar a
/// root-level geometry form, expand all point arithmetic, and return an
/// expression classify already understands.
func lowerStatement(_ e: Expr, _ context: GeomContext) throws -> Expr {
  if let statement = try lowerGeomStatement(e, context) { return statement }
  return try context.lo(e).expr
}

/// `lowerStatement`, lowered again with matrix algebra on if a matrix shows
/// (lib/geom.ts `withMatrices`).
func lowerWithMatrices(
  _ e: Expr, comps: @escaping (String) -> [String]?, getMat: @escaping GetMat, getTensor: @escaping GetTensor,
  isList: @escaping (String) -> Bool = { _ in false }
) throws -> Expr {
  func context(mats: Bool) -> GeomContext {
    let context = GeomContext(comps: comps, getMat: getMat, getTensor: getTensor, mats: mats)
    context.isList = isList
    return context
  }
  do {
    return try lowerStatement(e, context(mats: false))
  } catch is MatrixSeen {
    do {
      return try lowerStatement(e, context(mats: true))
    } catch let error as LanguageError {
      throw FailedWithMatrices(error: error)
    }
  }
}

/// A row that failed to lower with matrix algebra on: it holds a matrix or a
/// tuple of points; its error is the row's (`lowerGeomObjects`).
struct FailedWithMatrices: Error {
  var error: LanguageError
}

/// Functions over points, by how many point arguments they take.
private let POINT_FNS: [String: Int] = ["dot": 2, "cross": 2, "midpoint": 2, "perp": 1, "unit": 1]
private let ROTATE_USAGE =
  "rotate takes rotate(P, angle), rotate(P, angle, center) in 2D, or rotate(P, angle) about z and "
  + "rotate(P, angle, axis) in 3D."

private func sq(_ e: Expr) -> Expr { mul(e, e) }

func lenOfN(_ items: [Expr]) -> Expr {
  var s = sq(items[0])
  for k in 1..<items.count { s = add(s, sq(items[k])) }
  return .call("sqrt", [s])
}

/// Re-pair a lowered argument list into vectors of any dimension: vec args
/// pass through, adjacent scalars (a flattened tuple literal) join into a 2D
/// point. A scalar left without a partner throws `stray`, a message made
/// from that argument's index.
func legacyPointArgs(_ args: [Lowered], _ stray: (Int) -> String) throws -> [[Expr]] {
  var vs: [[Expr]] = []
  var i = 0
  while i < args.count {
    switch args[i] {
    case .vec(let items):
      vs.append(items)
    case .scalar(let a):
      guard i + 1 < args.count, case .scalar(let b) = args[i + 1] else { throw LanguageError(stray(i)) }
      vs.append([a, b])
      i += 1
    }
    i += 1
  }
  return vs
}

func legacyPointArgs(_ args: [Lowered], _ stray: String) throws -> [[Expr]] {
  try legacyPointArgs(args) { _ in stray }
}

/// legacyPointArgs for the figures that are 2D only. `usage` is the argument
/// list shown in the error, e.g. 'A' or 'A, B'.
private func pairPoints(_ name: String, _ args: [Lowered], _ usage: String) throws -> [[Expr]] {
  let vs = try legacyPointArgs(
    args, "\(name) takes points — write \(name)(\(usage)), with A = (0, 0) defined above.")
  if let big = vs.first(where: { $0.count != 2 }) {
    throw LanguageError("\(name) takes 2D points, not \(big.count)-component vectors.")
  }
  return vs
}

private let DISTANCE_USAGE =
  "distance takes two points: distance(A, B) with A = (0, 0) defined above, or distance((0, 0), (3, 4))."
private let ANGLE_USAGE =
  "angle takes three matching points — angle(A, B, C), the angle at B — or two vectors: angle(U, V). "
  + "Points may be 2D or 3D."

/// distance(A, B) ≡ |A - B|, in any dimension |A - B| has. `usage` is thrown
/// for every arity failure: tuple literals arrive flattened — (1, 2, 3) is
/// three loose scalars — so it is the one message true however they pair.
private func lowerDistance(_ args: [Lowered], _ usage: String, _ stray: (Int) -> String) throws -> Expr {
  let vs = try legacyPointArgs(args, stray)
  if vs.count != 2 { throw LanguageError(usage) }
  let (p, q) = (vs[0], vs[1])
  if p.count != q.count {
    throw LanguageError(
      "distance needs points with the same number of components, not \(p.count) and \(q.count).")
  }
  return lenOfN(zip(p, q).map { sub($0, $1) })
}

/// angle(A, B, C), the angle at B turning from B→A to B→C, or angle(U, V):
/// signed, counterclockwise positive, in (−π, π]. It lowers to one internal
/// call over the two arms' components (see angleFn), so each component
/// appears once however large it is.
private func lowerAngle(_ args: [Lowered], _ usage: String, _ stray: (Int) -> String) throws -> Expr {
  let vs = try legacyPointArgs(args, stray)
  if vs.count != 2 && vs.count != 3 { throw LanguageError(usage) }
  let dim = vs[0].count
  if (dim != 2 && dim != 3) || vs.contains(where: { $0.count != dim }) {
    throw LanguageError("angle needs points with matching dimensions.")
  }
  let u = vs.count == 3 ? zip(vs[0], vs[1]).map { sub($0, $1) } : vs[0]
  let v = vs.count == 3 ? zip(vs[2], vs[1]).map { sub($0, $1) } : vs[1]
  if dim == 3 {
    let cross = (0..<3).map { k in sub(mul(u[(k + 1) % 3], v[(k + 2) % 3]), mul(u[(k + 2) % 3], v[(k + 1) % 3])) }
    let terms = zip(u, v).map { mul($0, $1) }
    let dot = terms.dropFirst().reduce(terms[0], add)
    let valid = Expr.ineq(.gt, mul(lenOfN(u), lenOfN(v)), .num(0))
    return .piecewise([Expr.Case(cond: valid, value: .call("atan2", [lenOfN(cross), dot]))], otherwise: nil)
  }
  return .call(ANGLE_FN, u + v)
}

// MARK: - f(P)

/// Whether a point of `got` coordinates fills a comp of arity n reading index k.
func compFits(_ n: Int, _ k: Int, _ got: Int) -> Bool { n != 0 ? got == n : got > k }

/// What a `comp` says of a point with the wrong number of coordinates
/// (lib/expr.ts `compDims`).
func compDims(_ fn: String, _ n: Int, _ value: Expr, _ got: Int) -> String {
  let what: String = if case .var(let name) = value { name } else { "that point" }
  return n != 0
    ? "\(fn) takes \(n) arguments, and \(what) has \(got) components."
    : "\(fn) reads a coordinate \(what) does not have: it has \(got)."
}

/// f(P): component k of the one argument, once it is known to be a point
/// (lib/geom.ts `lower`, case 'comp'). A matrix has no meaning of its own to
/// a function of scalars, so there it is the list of its rows; that and a
/// list of points wait for lists (`lo` refuses those).
func lowerComp(_ value: Expr, _ k: Int, _ n: Int, _ fn: String, _ context: GeomContext) throws -> Lowered {
  if try context.compMatrix(value) { throw Unsupported("a matrix read as a list of its rows") }
  guard case .vec(let items) = try context.lo(value) else { throw LanguageError(compArity(fn, n)) }
  if !compFits(n, k, items.count) { throw LanguageError(compDims(fn, n, value, items.count)) }
  return .scalar(items[k])
}

// MARK: - Calls

/// A call lowering reads as geometry (lib/geom.ts `lower`, case 'call'), or
/// nil for any other, which takes numbers and gives one.
func lowerGeomCall(_ e: Expr, _ name: String, _ rawArgs: [Expr], _ context: GeomContext) throws -> Lowered? {
  let lo = context.lo
  if GEOM_STATEMENTS.contains(name) || name == "action" || name == "streamlines" || name == "qjulia" {
    throw LanguageError("\(name)(…) must be a whole statement.")
  }
  func coordinates(_ args: [Lowered]) -> [Expr] {
    if args.count == 1, case .vec(let items) = args[0] { return items }
    var out: [Expr] = []
    for a in args {
      guard case .scalar(let e) = a else { return [] }
      out.append(e)
    }
    return out
  }
  if name == "trail" {
    let coords = coordinates(try rawArgs.map(lo))
    if coords.count != 2 && coords.count != 3 {
      throw LanguageError("trail takes a 2D or 3D point: trail(A) or trail((cos(t), sin(t))).")
    }
    return .scalar(.trail(coordinates: coords))
  }
  if name == "label" {
    // The text comes last; the point before it arrives as one vector
    // (label(A, …)) or, from a tuple literal, as its spread coordinates.
    let text = rawArgs.last
    // One text only: an extra string would read as a third coordinate.
    if rawArgs.dropLast().contains(where: { if case .str = $0 { true } else { false } }) {
      throw LanguageError("label takes one quoted text, after the point: label((1, 2), \"peak\").")
    }
    let coords = coordinates(try rawArgs.dropLast().map(lo))
    guard coords.count == 2 || coords.count == 3, case .str(let value)? = text else {
      throw LanguageError(
        "label takes a point and quoted text: label(A, \"vertex\") or label((1, 2), \"peak\").")
    }
    return .scalar(.label(coordinates: coords, text: value))
  }
  // cross(n), the rotation generator; transpose, det, trace and solve.
  if let value = try context.matrixCall(e, name, rawArgs) { return value }
  if name == "rotate" {
    // rotate(P, a[, center]) ≡ C + e^(a J) (P − C); rotate(P, a, axis) ≡
    // e^(a cross(axis/|axis|)) P, and a 3D P with no axis turns about z —
    // the turn rotate(P, a) makes in the xy-plane. Flattened tuples are
    // told apart by count.
    let parts = try rawArgs.map(lo)
    var flat = parts.flatMap { part -> [Expr] in
      switch part {
      case .vec(let items): items
      case .scalar(let e): [e]
      }
    }
    if parts.count == 2, case .vec(let p) = parts[0], p.count == 3, case .scalar = parts[1] {
      flat += [.num(0), .num(0), .num(1)]
    }
    if flat.count == 7 {
      let axis = Array(flat[4...])
      let turn = try expOf(matScale(MatValue(m: hatOf(axis)), div(flat[3], lenOfN(axis))))
      return .vec(matVec(turn, Array(flat[..<3])))
    }
    if flat.count != 3 && flat.count != 5 { throw LanguageError(ROTATE_USAGE) }
    let num0 = Expr.num(0)
    let c = flat.count == 5 ? Array(flat[3...]) : [num0, num0]
    let turn = try expOf(matScale(MatValue(m: [[num0, .num(-1)], [.num(1), num0]]), flat[2]))
    let moved = matVec(turn, [sub(flat[0], c[0]), sub(flat[1], c[1])])
    return .vec(moved.enumerated().map { k, p in add(c[k], p) })
  }
  if name == "distance" || name == "angle" {
    // Scalars like dot and cross: they work inside any expression, read out
    // as a bare row, and draw nothing.
    let usage = name == "distance" ? DISTANCE_USAGE : ANGLE_USAGE
    // (A named matrix is a list of rows here, which lowering would reject first.)
    if rawArgs.contains(where: { if case .var(let arg) = $0 { context.getMat(arg) != nil } else { false } }) {
      let form = name == "distance" ? "distance(A, B)" : "angle(A, B, C)"
      throw LanguageError(
        "\(name) takes points, and a list cannot stand for a point yet — \(form), one point each.")
    }
    // (An argument left without a partner that is a list, or an element of
    // one, says so on the site; `lo` has refused lists by here.)
    let args = try rawArgs.map(lo)
    return .scalar(
      try name == "distance" ? lowerDistance(args, usage) { _ in usage } : lowerAngle(args, usage) { _ in usage })
  }
  if let nPts = POINT_FNS[name] {
    // Vector args of any dim pass straight through; runs of flattened
    // scalars still pair into 2D points as before.
    let args = try rawArgs.map(lo)
    let vs = try legacyPointArgs(
      args, "\(name) takes points — write \(name)(\(nPts == 1 ? "A" : "A, B")), with A = (0, 0) defined above.")
    if vs.count != nPts { throw LanguageError("\(name) takes \(nPts) point\(nPts == 1 ? "" : "s").") }
    let dim = vs[0].count
    if vs.contains(where: { $0.count != dim }) {
      throw LanguageError("\(name) needs vectors with the same number of components.")
    }
    func twoOnly() throws {
      if dim != 2 { throw LanguageError("\(name) is only defined for 2D points.") }
    }
    let p = vs[0]
    switch name {
    case "dot":
      let q = vs[1]
      var s = mul(p[0], q[0])
      for k in 1..<dim { s = add(s, mul(p[k], q[k])) }
      return .scalar(s)
    case "cross":
      let q = vs[1]
      if dim == 3 {
        return .vec((0..<3).map { k in sub(mul(p[(k + 1) % 3], q[(k + 2) % 3]), mul(p[(k + 2) % 3], q[(k + 1) % 3])) })
      }
      try twoOnly()
      return .scalar(sub(mul(p[0], q[1]), mul(p[1], q[0])))
    case "midpoint":
      let q = vs[1]
      return .vec(zip(p, q).map { div(add($0, $1), .num(2)) })
    case "perp":
      try twoOnly()
      return .vec([neg(p[1]), p[0]])
    default:
      // unit
      return .vec(p.map { div($0, lenOfN(p)) })
    }
  }
  if name == "abs" {
    // |P| is a point's length; |(3, 4)| arrives as abs(3, 4) because the
    // tuple flattens into the argument list, so a scalar pair re-pairs too.
    let args = try rawArgs.map(lo)
    if args.count == 1, case .vec(let items) = args[0] { return .scalar(lenOfN(items)) }
    if args.count == 2 {
      let pts = try pairPoints("abs", args, "A")
      if pts.count == 1 { return .scalar(lenOfN(pts[0])) }
    }
  }
  return nil
}

// MARK: - Statements

private let VECTOR_USAGE = "vector takes one or two points: vector(A, B) from A to B, or vector(V) from the origin."

private func polyCall(_ form: FigureForm, _ pts: [[Expr]]) -> Expr {
  .figure(form: form, dimension: pts[0].count, vertices: pts.flatMap { $0 })
}

/// Desugar a root-level geometry form (lib/geom.ts `lowerStatement`), or nil
/// for a row that is not one.
func lowerGeomStatement(_ e: Expr, _ context: GeomContext) throws -> Expr? {
  // streamlines(M): a matrix field drawn along its major eigenvector rather
  // than as glyphs. The matrix lowers as a row of its own would, inside a
  // marker classify unwraps.
  if case .call("streamlines", let args) = e {
    if args.count != 1 { throw LanguageError(STREAMLINES_USAGE) }
    return .call(STREAMLINES_CALL, [try lowerStatement(args[0], context)])
  }
  if let algebra = try lowerAlgebraStatement(e, context) { return algebra }
  if let tensor = try lowerTensorStatement(e, context) { return tensor }
  guard case .call(let name, let rawArgs) = e, GEOM_STATEMENTS.contains(name) else { return nil }
  let args = try rawArgs.map(context.lo)
  if name == "circle" {
    // circle(C, r): the trailing argument is the scalar radius.
    guard args.count >= 2, case .scalar(let r)? = args.last else {
      throw LanguageError("circle takes circle(center, radius).")
    }
    let pts = try pairPoints("circle", Array(args.dropLast()), "center, radius")
    if pts.count != 1 { throw LanguageError("circle takes circle(center, radius).") }
    let (cx, cy) = (pts[0][0], pts[0][1])
    return .eq(add(sq(sub(.var("x"), cx)), sq(sub(.var("y"), cy))), sq(r))
  }
  // Tuple literals arrive flattened, so (1, 2, 3) cannot be told from
  // (1, 2), 3: an odd run of scalars gets the one message true of both.
  let allScalars = args.allSatisfy { if case .scalar = $0 { true } else { false } }
  if name == "vector" && allScalars && args.count % 2 == 1 { throw LanguageError(VECTOR_USAGE) }
  let pts = try legacyPointArgs(args, "\(name) takes points with matching dimensions.")
  if pts.isEmpty || ![2, 3].contains(pts[0].count) || pts.contains(where: { $0.count != pts[0].count }) {
    throw LanguageError("\(name) needs points with matching dimensions.")
  }
  if pts[0].count == 3 && name == "line" && pts.count == 2 {
    // A line of space is a value of projective geometry (lib/pga.ts).
    return flatNode(try regressivePga(pointPga(pts[0]), pointPga(pts[1])).graded(2))
  }
  if pts[0].count == 3 && (name == "line" || name == "square") {
    throw LanguageError("\(name) is only defined for 2D points.")
  }
  switch name {
  case "line":
    if pts.count != 2 {
      throw LanguageError("line takes two points: line(A, B), with A = (0, 0) defined above.")
    }
    // The infinite line through A and B: cross(P - A, B - A) = 0, an
    // ordinary implicit equation (so it renders on the GPU like any curve).
    let (ax, ay, bx, by) = (pts[0][0], pts[0][1], pts[1][0], pts[1][1])
    return .eq(sub(mul(sub(.var("x"), ax), sub(by, ay)), mul(sub(.var("y"), ay), sub(bx, ax))), .num(0))
  case "segment":
    if pts.count != 2 {
      throw LanguageError("segment takes two points: segment(A, B), with A = (0, 0) defined above.")
    }
    return polyCall(.segment, pts)
  case "hull":
    // The convex hull: a filled polygon in the plane, a solid in space.
    // Which vertices are extreme is settled per frame, from their values.
    if pts.count < 3 {
      throw LanguageError("hull needs at least 3 points: hull(A, B, C, D), or hull(P) for a list of points.")
    }
    return polyCall(.hull, pts)
  case "polyline":
    if pts.count < 2 { throw LanguageError("polyline needs at least 2 points: polyline(A, B, C).") }
    return polyCall(.polyline, pts)
  case "vector":
    // vector(A, B) is the arrow from A to B; vector(V) starts at the origin.
    if pts.count != 1 && pts.count != 2 { throw LanguageError(VECTOR_USAGE) }
    return polyCall(.vector, pts.count == 1 ? [pts[0].map { _ in .num(0) }, pts[0]] : pts)
  case "square":
    if pts.count != 2 { throw LanguageError("square takes two points: square(A, B).") }
    // The square erected on side A→B, on the left of the direction A→B.
    let (ax, ay, bx, by) = (pts[0][0], pts[0][1], pts[1][0], pts[1][1])
    let px = neg(sub(by, ay))  // perp(B - A)
    let py = sub(bx, ax)
    return polyCall(.square, [[ax, ay], [bx, by], [add(bx, px), add(by, py)], [add(ax, px), add(ay, py)]])
  default:
    if pts.count < 3 { throw LanguageError("polygon needs at least 3 vertices.") }
    return polyCall(.polygon, pts)
  }
}
