/// Figures in object positions (lib/object-lists.ts `lowerObjects`, the part
/// that reads figures): a transformed figure is the figure of the
/// transformed points, a figure of one tuple of points is the figure of
/// those points, and a figure of a matrix is the figure of its rows.

/// Figures that are just their points: moving the points moves the figure.
private let POINT_FIGURES: Set<String> = ["segment", "polyline", "polygon", "vector", "hull"]

private func figureCall(_ e: Expr) -> (name: String, args: [Expr])? {
  if case .call(let name, let args) = e, POINT_FIGURES.contains(name) { return (name, args) }
  return nil
}

private func holdsFigure(_ e: Expr) -> Bool {
  switch e {
  case .call(let name, let args): POINT_FIGURES.contains(name) || args.contains(where: holdsFigure)
  case .bin(_, let a, let b, _): holdsFigure(a) || holdsFigure(b)
  case .neg(let a): holdsFigure(a)
  default: false
  }
}

/// A transformed figure is the figure of the transformed points: `R hull(P)`,
/// `polygon(A, B, C) + (1, 0)`, `2 segment(A, B)`, `rotate(hull(…), a)`. Every
/// map a row can write this way is affine, and affine maps carry segments to
/// segments and hulls to hulls — so the transform moves inside, onto each
/// point, and the figure stays the whole statement (lib/object-lists.ts
/// `pushTransforms`).
private func pushTransforms(_ e: Expr, _ rowsOf: (Expr) -> [Expr]?) throws -> Expr {
  func onto(_ fig: (name: String, args: [Expr]), shifts: Bool = false, _ move: (Expr) -> Expr) throws -> Expr {
    // vector(V) starts at the origin, which a shift would have to move too.
    if shifts && fig.name == "vector" && fig.args.count == 1 {
      throw LanguageError("vector(V) starts at the origin — write vector(A, B) to move it.")
    }
    // A figure of a matrix's rows moves each row, as a point: R polygon(T)
    // is polygon(R A, R B, …), not polygon(R T), the matrix product.
    let args = (fig.args.count == 1 ? rowsOf(fig.args[0]) : nil) ?? fig.args
    return .call(fig.name, args.map(move))
  }
  switch e {
  case .neg(let inner):
    guard let a = figureCall(try pushTransforms(inner, rowsOf)) else { return e }
    return try onto(a) { .neg($0) }
  case .bin(let op, let lhs, let rhs, let glyph):
    let l = try pushTransforms(lhs, rowsOf)
    let r = try pushTransforms(rhs, rowsOf)
    let a = figureCall(l)
    let b = figureCall(r)
    if a != nil && b != nil {
      throw LanguageError("Two figures do not combine — transform one figure at a time.")
    }
    let shifts = op == .add || op == .sub
    if let a, op != .pow { return try onto(a, shifts: shifts) { .bin(op, $0, r, glyph: glyph) } }
    if let b, op != .pow, op != .div { return try onto(b, shifts: shifts) { .bin(op, l, $0, glyph: glyph) } }
    return e
  case .call("rotate", let args):
    guard let first = args.first, let a = figureCall(try pushTransforms(first, rowsOf)) else { return e }
    return try onto(a) { .call("rotate", [$0] + args.dropFirst()) }
  default:
    return e
  }
}

/// A row's figures made ready for geometry lowering: transforms moved onto
/// the points; a tuple of points written out — polyline(((0, 0), (1, 1),
/// (2, 0))), polygon((A, B, C)) — read as its points in order; and a matrix
/// as its rows, computed as the matrix first (2 M, M N), so polyline(M N)
/// draws what P = M N; polyline(P) draws.
func lowerFigureObjects(
  _ source: Expr, _ comps: @escaping (String) -> [String]?, _ mats: @escaping GetMat, _ tensors: @escaping GetTensor
) throws -> Expr {
  /// A matrix consumed as its rows (lib/object-lists.ts `matrixRows`).
  func matrixRows(_ arg: Expr) -> [Expr]? {
    let m: Mat? =
      if case .var(let name) = arg {
        mats(name)
      } else {
        (try? lowerMatrix(arg, comps: comps, getMat: mats, getTensor: tensors)) ?? nil
      }
    return m?.map { .vec($0) }
  }
  var e = source
  if figureCall(e) == nil, !exceedsNodes(e, 32768), holdsFigure(e) { e = try pushTransforms(e, matrixRows) }
  // Connectedness consumes a whole tuple; it does not broadcast its vertices
  // into separate one-vertex figures.
  if case .call(let name, let args) = e, ["polyline", "polygon", "hull"].contains(name), args.count == 1 {
    if case .vec(let items) = args[0], items.count >= 2 {
      let points = items.allSatisfy {
        switch $0 {
        case .vec: true
        case .var(let item): comps(item) != nil
        default: false
        }
      }
      if points { return try lowerFigureObjects(.call(name, items), comps, mats, tensors) }
    }
    if let rows = matrixRows(args[0]) { return .call(name, rows) }
  }
  return e
}

/// What a row that failed to lower says. Where lowering fails, the site
/// expands the row over its lists (lib/object-lists.ts `expand`), and a
/// matrix is the list of its rows there, as a tuple of points is of its
/// points: distance(M, A) is a list of distances. Lists are not ported, so
/// the failure of a row that names a matrix or writes a tuple of points is
/// not known to be the site's — unless it is about the matrix itself, which
/// the site keeps (`/matri|tensor/`, but for a matrix standing where a value
/// goes).
func failedLowering(
  _ error: LanguageError, _ e: Expr, _ comps: (String) -> [String]?, _ mats: GetMat, withMatrices: Bool
) -> any Error {
  func isRow(_ item: Expr) -> Bool {
    switch item {
    case .vec: true
    case .var(let name): comps(name) != nil
    default: false
    }
  }
  func readsRows(_ n: Expr) -> Bool {
    switch n {
    case .var(let name): if mats(name) != nil { return true }
    case .vec(let items): if items.contains(where: isRow) { return true }
    default: break
    }
    return childrenOf(n).contains(where: readsRows)
  }
  guard withMatrices || readsRows(e) else { return error }
  let text = error.message.lowercased()
  let aboutTheMatrix = (text.contains("matri") || text.contains("tensor")) && !text.contains("not a value on its own")
  return aboutTheMatrix ? error : Unsupported("a row that reads a matrix or a tuple of points as a list")
}

/// A tuple of points is a list of them in order (lib/list.ts): it draws as
/// dots, indexes and feeds polyline(T). Lists are not ported, so a lowered
/// row that still holds one is not supported.
func refuseTuplesOfPoints(_ e: Expr) throws {
  if case .vec(let items) = e, items.contains(where: { if case .vec = $0 { true } else { false } }) {
    throw Unsupported("tuples of points")
  }
  for child in childrenOf(e) { try refuseTuplesOfPoints(child) }
}
