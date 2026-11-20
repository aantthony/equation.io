/// Figures in object positions (lib/object-lists.ts `lowerObjects`, the part
/// that reads figures): a transformed figure is the figure of the
/// transformed points, and a figure of one tuple of points is the figure of
/// those points.

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

/// Whether an expression may be a matrix (lib/geom.ts `lowerMatrix`'s spine,
/// with no matrix named): a figure of one such argument is a figure of its
/// rows, which waits for matrices.
private func matrixSpine(_ e: Expr, _ comps: (String) -> [String]?) -> Bool {
  switch e {
  case .vec(let items):
    return (items.count == 2 || items.count == 3)
      && items.contains {
        switch $0 {
        case .vec: true
        case .var(let name): comps(name) != nil
        default: false
        }
      }
  case .neg(let a): return matrixSpine(a, comps)
  case .bin(_, let a, let b, let glyph):
    return glyph == .outer || glyph == .wedge || matrixSpine(a, comps) || matrixSpine(b, comps)
  case .call(let name, let args):
    if name == "outer" || name == "wedge" || name == "contract" { return true }
    return (name == "cross" && args.count == 1)
      || ((name == "exp" || name == "transpose") && args.count == 1 && matrixSpine(args[0], comps))
  default: return false
  }
}

/// A transformed figure is the figure of the transformed points: `polygon(A,
/// B, C) + (1, 0)`, `2 segment(A, B)`, `rotate(hull(…), a)`. Every map a row
/// can write this way is affine, and affine maps carry segments to segments
/// and hulls to hulls — so the transform moves inside, onto each point, and
/// the figure stays the whole statement (lib/object-lists.ts `pushTransforms`).
private func pushTransforms(_ e: Expr, _ comps: (String) -> [String]?) throws -> Expr {
  func onto(_ fig: (name: String, args: [Expr]), shifts: Bool = false, _ move: (Expr) -> Expr) throws -> Expr {
    // vector(V) starts at the origin, which a shift would have to move too.
    if shifts && fig.name == "vector" && fig.args.count == 1 {
      throw LanguageError("vector(V) starts at the origin — write vector(A, B) to move it.")
    }
    // A figure of a matrix's rows moves each row, as a point; matrices are
    // not ported.
    if fig.args.count == 1, matrixSpine(fig.args[0], comps) { throw Unsupported("matrices and tensors") }
    return .call(fig.name, fig.args.map(move))
  }
  switch e {
  case .neg(let inner):
    guard let a = figureCall(try pushTransforms(inner, comps)) else { return e }
    return try onto(a) { .neg($0) }
  case .bin(let op, let lhs, let rhs, let glyph):
    let l = try pushTransforms(lhs, comps)
    let r = try pushTransforms(rhs, comps)
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
    guard let first = args.first, let a = figureCall(try pushTransforms(first, comps)) else { return e }
    return try onto(a) { .call("rotate", [$0] + args.dropFirst()) }
  default:
    return e
  }
}

/// A row's figures made ready for geometry lowering: transforms moved onto
/// the points, and a tuple of points written out — polyline(((0, 0), (1, 1),
/// (2, 0))), polygon((A, B, C)) — read as its points in order.
func lowerFigureObjects(_ source: Expr, _ comps: (String) -> [String]?) throws -> Expr {
  var e = source
  if figureCall(e) == nil, !exceedsNodes(e, 32768), holdsFigure(e) { e = try pushTransforms(e, comps) }
  // Connectedness consumes a whole tuple; it does not broadcast its vertices
  // into separate one-vertex figures.
  if case .call(let name, let args) = e, ["polyline", "polygon", "hull"].contains(name), args.count == 1,
    case .vec(let items) = args[0], items.count >= 2
  {
    let points = items.allSatisfy {
      switch $0 {
      case .vec: true
      case .var(let item): comps(item) != nil
      default: false
      }
    }
    if points { return try lowerFigureObjects(.call(name, items), comps) }
  }
  return e
}
