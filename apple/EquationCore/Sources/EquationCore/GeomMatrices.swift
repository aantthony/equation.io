/// Matrices and tensors under geometry lowering (lib/geom.ts `lowerMat`,
/// `lowerTensor` and what `lower` asks of them): a named matrix, a tuple of
/// rows, ⊗, ∧, contract, and algebra over them, each expanded to scalar
/// expressions before anything downstream looks.

/// Thrown where a matrix first shows in a row lowered with matrix algebra
/// off (lib/geom.ts `MatrixSeen`): the row is lowered again with it on.
/// Nearly every row has no matrix in it, and asking "is this a matrix?" at
/// every node of a huge one is real time.
struct MatrixSeen: Error {}

let NOT_A_VALUE =
  "A matrix is not a value on its own — apply it to a vector, like M (x, y), or name it: R = e^(a J)."

private func notATensorValue(_ t: Tensor) -> String {
  // (The TypeScript's replace('a', 'A'): the first a, which is the article.)
  var text = Array(shapeText(t.shape))
  if let at = text.firstIndex(of: "a") { text[at] = "A" }
  return "\(String(text)) is not a number or a point here — contract it, like contract(T, 1, 2), "
    + "or give it a row of its own to read it."
}

private func isE(_ e: Expr) -> Bool {
  switch e {
  case .var("e"): true
  case .num(let value): value == 2.718281828459045
  default: false
  }
}

/// ⊗, ∧ and their spellings outer(…), wedge(…), contract(…): a tensor
/// operation. (So is a tensor value already made.)
private func tensorOp(_ e: Expr) -> Bool {
  switch e {
  case .bin(_, _, _, let glyph): glyph == .outer || glyph == .wedge
  case .call(let name, _): name == "outer" || name == "wedge" || name == "contract" || name == TENSOR_CALL
  default: false
  }
}

/// Whether a tuple literal holds a row that is no point — a longer tuple, or
/// a tuple of tuples — so it may be a tensor rather than a tuple of points.
private func deepTupleRow(_ e: Expr) -> Bool {
  guard case .vec(let items) = e else { return false }
  return items.count > 3 || items.contains { if case .vec = $0 { true } else { false } }
}

private func deepTuple(_ e: Expr) -> Bool {
  if case .vec(let items) = e { return items.contains(where: deepTupleRow) }
  return false
}

/// A whole-number power written out: n, or -n.
private func writtenPower(_ e: Expr) -> Double {
  switch e {
  case .num(let value): value
  case .neg(.num(let value)): -value
  default: .nan
  }
}

/// A constant whole-number argument, such as an index of contract.
private func constIndex(_ e: Expr, _ what: String) throws -> Int {
  let v = writtenPower(e)
  if !JS.isInteger(v) {
    throw LanguageError("\(what) is a whole number written out, like contract(T, 1, 2) or T[2].")
  }
  return Int(v)
}

/// What one lowering reads of the document, and the matrix- and
/// tensor-valued subexpressions it has met (the TypeScript's `matSeen`,
/// `tenSeen` and `matsPossible`, which live for one `lowerGeom`).
final class GeomContext {
  let comps: (String) -> [String]?
  let getMat: GetMat
  let getTensor: GetTensor
  /// Whether matrix algebra is live for this lowering.
  let matsPossible: Bool
  /// Which names are lists: an argument that reads one is no point yet
  /// (ObjectLists.swift `waitingComp`).
  var isList: (String) -> Bool = { _ in false }
  private var matSeen: [Expr: MatValue?] = [:]
  private var tenSeen: [Expr: Tensor?] = [:]
  /// Multivectors and flats (GeomAlgebra.swift).
  var algebra = AlgebraSeen()

  init(comps: @escaping (String) -> [String]?, getMat: @escaping GetMat, getTensor: @escaping GetTensor, mats: Bool) {
    self.comps = comps
    self.getMat = getMat
    self.getTensor = getTensor
    matsPossible = mats
  }

  func lo(_ e: Expr) throws -> Lowered { try lowerPoints(e, comps, self) }

  private func items(_ v: Lowered) -> [Expr]? {
    if case .vec(let items) = v { return items }
    return nil
  }

  // MARK: Tensors

  /// A tensor-valued expression that matrix algebra alone cannot read: a
  /// tensor name, a nested tuple deeper or wider than a matrix, ⊗, ∧,
  /// contract, or algebra over any of them — or nil. (A square matrix and its
  /// algebra stay lowerMat's; the product of two tensors that happens to be
  /// square is handed back to it as a matrix.)
  func lowerTensor(_ e: Expr) throws -> Tensor? {
    if !matsPossible { return nil }
    if try lowerMv(e) != nil { return nil }
    if let hit = tenSeen[e] { return hit }
    // A cycle guard: a node under way is not a tensor to itself.
    tenSeen[e] = .some(nil)
    let found = try tensorOf(e)
    tenSeen[e] = .some(found)
    return found
  }

  private func tensorOf(_ e: Expr) throws -> Tensor? {
    switch e {
    case .var(let name):
      return getTensor(name, false)
    case .vec:
      return try tensorOfVec(e)
    case .neg(let inner):
      return try lowerTensor(inner).map(tensorNeg)
    case .bin:
      return try tensorOfBin(e)
    case .index:
      return try tensorOfIndex(e)
    case .call:
      return try tensorOfCall(e)
    default:
      return nil
    }
  }

  private func tensorOfVec(_ e: Expr) throws -> Tensor? {
    guard case .vec(let parts) = e else { return nil }
    func some(_ test: (Expr) throws -> Bool) rethrows -> Bool {
      for it in parts where try test(it) { return true }
      return false
    }
    if !(try some { try lowerTensor($0) != nil || deepTupleRow($0) }) { return nil }
    let t = try tupleTensor(parts)
    // A tuple of points that is not square is a tuple of points.
    let points = t.shape.count == 2 && (t.shape[1] == 2 || t.shape[1] == 3)
    return try points && !some({ try lowerTensor($0) != nil }) ? nil : t
  }

  private func tensorOfBin(_ e: Expr) throws -> Tensor? {
    guard case .bin(let op, let lhs, let rhs, let glyph) = e else { return nil }
    if glyph == .outer { return try outer(anyTensor(lhs), anyTensor(rhs)) }
    if glyph == .wedge { return try wedge(anyTensor(lhs), anyTensor(rhs)) }
    let a = try lowerTensor(lhs)
    let b = try lowerTensor(rhs)
    return try tensorOfSides(op, lhs, rhs, a, b)
  }

  private func tensorOfIndex(_ e: Expr) throws -> Tensor? {
    guard case .index(let target, let at) = e else { return nil }
    // T[k]: the k-th slice along the first index, as M[2] is a row.
    guard let t = try lowerTensor(target) else { return nil }
    let k = try constIndex(at, "A tensor index")
    if k < 1 || k > t.shape[0] {
      throw LanguageError("That tensor has \(t.shape[0]) rows along its first index; \(k) is not one.")
    }
    return rows(t)[k - 1]
  }

  private func tensorOfCall(_ e: Expr) throws -> Tensor? {
    guard case .call(let name, let args) = e else { return nil }
    if !tensorOp(e) { return nil }
    if name == TENSOR_CALL { return tensorOfNode(e) }
    if name == "contract" {
      if args.count != 3 {
        throw LanguageError(
          "contract takes a tensor and two of its indices: contract(T, 1, 2) sums T_ii… over i.")
      }
      return try contract(
        anyTensor(args[0]), constIndex(args[1], "An index") - 1, constIndex(args[2], "An index") - 1)
    }
    if args.count < 2 {
      throw LanguageError("\(name) takes two or more vectors or tensors: \(name)(a, b).")
    }
    var acc = try anyTensor(args[0])
    for n in args.dropFirst() { acc = try name == "outer" ? outer(acc, anyTensor(n)) : wedge(acc, anyTensor(n)) }
    return acc
  }

  /// A sum, product or quotient whose sides `a` and `b` are tensors, or are not (`tensorOf`, case .bin).
  private func tensorOfSides(_ op: BinOp, _ lhs: Expr, _ rhs: Expr, _ a: Tensor?, _ b: Tensor?) throws -> Tensor? {
    if a == nil && b == nil {
      // T Q with T a tuple of points: the consumer reads it as a matrix,
      // n×k — the rectangular matvec and product. (Scaled, 2 T, it stays a
      // tuple of points; on the right, M T, each of its points is moved.)
      if op != .mul { return nil }
      guard let l = try pointRows(lhs) else {
        // v T, a vector on the left of a tuple of points that is not
        // square: the contraction v_i T_ij, a vector of T's width.
        guard let r = try pointRows(rhs), r.shape[0] != r.shape[1] else { return nil }
        guard let v = items(try lo(lhs)) else { return nil }
        return try product(vectorTensor(v), r)
      }
      if let r = try pointRows(rhs) { return try product(l, r) }
      if let r = try lowerMat(rhs) { return try product(l, fromMat(r.m)) }
      guard let v = items(try lo(rhs)) else { return nil }
      return try product(l, vectorTensor(v))
    }
    switch op {
    case .add, .sub:
      return try tensorAdd(anyTensor(lhs), anyTensor(rhs), minus: op == .sub)
    case .mul:
      let l = try anyTensor(lhs)
      let r = try anyTensor(rhs)
      if l.shape.isEmpty { return tensorScale(r, l.data[0]) }
      if r.shape.isEmpty { return tensorScale(l, r.data[0]) }
      return try product(l, r)
    case .div:
      let r = try anyTensor(rhs)
      guard let a, r.shape.isEmpty else { throw LanguageError("Cannot divide by a tensor.") }
      return tensorScale(a, .bin(.div, .num(1), r.data[0]))
    case .pow:
      // (A power is matrix algebra: e^(th e_x ∧ e_y) is lowerMat's.)
      return nil
    }
  }

  /// A tuple of points that is no square matrix — written out, or named — as
  /// the rank-2 tensor of its rows; nil for anything else.
  private func pointRows(_ n: Expr) throws -> Tensor? {
    if case .var(let name) = n {
      let t = getTensor(name, true)
      return t?.shape.count == 2 ? t : nil
    }
    guard case .vec(let parts) = n, parts.count >= 2, try lowerMat(n) == nil else { return nil }
    var stacked: [Tensor] = []
    for part in parts {
      guard let row = items(try lo(part)) else { return nil }
      stacked.append(vectorTensor(row))
    }
    return try stack(stacked)
  }

  /// A tuple literal read as a tensor: its rows, stacked.
  private func tupleTensor(_ parts: [Expr]) throws -> Tensor {
    let stacked = try parts.map(anyTensor)
    guard let t = try stack(stacked) else {
      var shapes: [String] = []
      for r in stacked where !shapes.contains(shapeText(r.shape)) { shapes.append(shapeText(r.shape)) }
      throw LanguageError("The rows of a tensor need one shape, not \(shapes.joined(separator: " and ")).")
    }
    return t
  }

  /// Any value read as a tensor, for an operation on tensors: a number is
  /// rank 0, a point or a longer tuple rank 1, a matrix rank 2.
  func anyTensor(_ n: Expr) throws -> Tensor {
    if let t = try lowerTensor(n) { return t }
    if let m = try lowerMat(n) { return fromMat(m.m) }
    if case .vec(let parts) = n, parts.count > 3 { return try tupleTensor(parts) }
    if case .var(let name) = n, let tuple = getTensor(name, true) { return tuple }
    switch try lo(n) {
    case .vec(let v): return vectorTensor(v)
    case .scalar(.vec(let parts)): return try tupleTensor(parts)
    case .scalar(let e): return scalarTensor(e)
    }
  }

  // MARK: Matrices

  /// A matrix-valued expression — a named matrix, a tuple of rows
  /// `((a, b), (c, d))`, or algebra over them: `s M`, `M / s`, `-M`, `M + N`,
  /// `M N`, `M^n`, `e^M` / `exp(M)`, and the rotation generator `cross(n)` —
  /// or nil for anything else.
  func lowerMat(_ e: Expr) throws -> MatValue? {
    if !matsPossible { return nil }
    if try lowerMv(e) != nil { return nil }
    if let hit = matSeen[e] { return hit }
    func scalar(_ n: Expr, _ what: String) throws -> Expr {
      guard case .scalar(let value) = try lo(n) else {
        throw LanguageError("Cannot \(what) a matrix by a point — M v applies it.")
      }
      return value
    }
    // ⊗, ∧, contract and tensors of other shapes: a matrix when square.
    // Matrix algebra reads its own spine first (e^(th J) needs th kept
    // apart), and a product of tensors it cannot read comes back square here.
    func square() throws -> MatValue? {
      guard let t = try lowerTensor(e), let m = toMat(t) else { return nil }
      return MatValue(m: m)
    }
    let first: Bool =
      switch e {
      case .vec, .var: true
      default: tensorOp(e)
      }
    func found() throws -> MatValue? {
      if first, let t = try lowerTensor(e) { return toMat(t).map { MatValue(m: $0) } }
      switch e {
      case .var(let name):
        return getMat(name).map { MatValue(m: $0) }
      case .neg(let inner):
        return try lowerMat(inner).map(matNeg)
      case .bin(let op, let lhs, let rhs, _):
        if op == .pow {
          if let power = try lowerMat(rhs) {
            if !isE(lhs) { throw LanguageError("Only e takes a matrix power: e^(a J) is the rotation by a.") }
            return MatValue(m: try expOf(power))
          }
          guard let a = try lowerMat(lhs) else { return nil }
          return MatValue(m: try matPow(a.m, writtenPower(rhs)))
        }
        let a = try lowerMat(lhs)
        let b = try lowerMat(rhs)
        if a == nil && b == nil { return nil }
        switch op {
        case .add, .sub:
          guard let a, let b else {
            let verb = op == .add ? "add" : "subtract"
            // A point beside a tuple of points moves each of them: the point
            // is added to every row, wherever T is written.
            guard let p = items(try lo(a != nil ? rhs : lhs)) else {
              throw LanguageError("Cannot \(verb) a matrix and a number — use a multiple of the identity.")
            }
            let m = (a ?? b)!.m
            if p.count != m[0].count {
              throw LanguageError(
                "Cannot \(verb) a \(p.count)D point and a tuple of \(m[0].count)D points — "
                  + "each row takes a point of its own size.")
            }
            func combine(_ x: Expr, _ y: Expr) -> Expr { op == .add ? add(x, y) : sub(x, y) }
            return MatValue(
              m: m.map { row in
                row.enumerated().map { c, entry in a != nil ? combine(entry, p[c]) : combine(p[c], entry) }
              })
          }
          return MatValue(m: try matAdd(a.m, b.m, minus: op == .sub))
        case .mul:
          if let a, let b { return MatValue(m: try matMul(a.m, b.m)) }
          // M v is a vector, not a matrix: the caller applies it.
          if let a {
            guard case .scalar(let s) = try lo(rhs) else { return nil }
            return matScale(a, s)
          }
          return matScale(b!, try scalar(lhs, "multiply"))
        case .div:
          guard let a, b == nil else {
            throw LanguageError(
              "Cannot divide by a matrix — multiply by M^-1. (a/2J reads as a/(2J): write a/2 J.)")
          }
          return matScale(a, div(.num(1), try scalar(rhs, "divide")))
        case .pow:
          return nil
        }
      case .vec(let parts):
        // A tuple of rows — ((a, b), (c, d)), or named points (A, B) — is a
        // matrix when it is square. Anything else is left to lower(), which
        // says what that tuple is instead.
        var rows: [[Expr]] = []
        for part in parts {
          guard let row = items(try lo(part)) else { return nil }
          rows.append(row)
        }
        return matrixFromRows(rows).map { MatValue(m: $0) }
      case .call(let name, let args):
        if name == "exp" && args.count == 1 {
          return try lowerMat(args[0]).map { MatValue(m: try expOf($0)) }
        }
        if name == "transpose" && args.count == 1 {
          guard let a = try lowerMat(args[0]) else {
            throw LanguageError("transpose takes a matrix — define one with M = ((a, b), (c, d)).")
          }
          return MatValue(m: transposeOf(a.m))
        }
        // cross(n, v) with its v left off: the matrix of v ↦ n × v.
        if name == "cross" && args.count == 1 {
          guard let n = items(try lo(args[0])), n.count == 3 else {
            throw LanguageError(
              "cross(n) is the rotation generator about a 3D axis: e^(a cross((0, 0, 1))) v.")
          }
          return MatValue(m: hatOf(n))
        }
        return nil
      default:
        return nil
      }
    }
    var value = try found()
    if value == nil && !first { value = try square() }
    matSeen[e] = .some(value)
    return value
  }

  // MARK: What lower() asks

  /// Before a node lowers as a number or a point (the head of `lower`):
  /// with matrix algebra off, whether the node is where it must be switched
  /// on; with it on, the value of a tensor operation, which is whatever rank
  /// it comes to — a number (contract(M, 1, 2)), a vector (T v), or a tensor,
  /// which only a consumer of tensors, or a row of its own, can take.
  func tensorValue(_ e: Expr) throws -> Lowered? {
    switch e {
    case .var, .vec, .neg, .bin, .call, .index: break
    default: return nil
    }
    if !matsPossible {
      var seen = tensorOp(e) || deepTuple(e)
      if case .var(let name) = e, getTensor(name, false) != nil { seen = true }
      // T v: a named tuple of points applied as a matrix, and v T, a vector
      // contracted with one.
      if case .bin(.mul, let lhs, let rhs, _) = e {
        if case .var(let name) = lhs, getTensor(name, true)?.shape.count == 2 { seen = true }
        if case .var(let name) = rhs, getTensor(name, true)?.shape.count == 2, items(try lo(lhs)) != nil {
          seen = true
        }
      }
      if seen { throw MatrixSeen() }
      return nil
    }
    guard let t = try lowerTensor(e) else { return nil }
    if t.shape.isEmpty { return .scalar(t.data[0]) }
    if t.shape.count == 1 {
      return t.data.count == 2 || t.data.count == 3 ? .vec(t.data) : .scalar(.vec(t.data))
    }
    // (A square one is a matrix, and the matrix paths say what it may do.)
    if toMat(t) == nil { throw LanguageError(notATensorValue(t)) }
    return nil
  }

  /// A name that is a matrix stands for no number or point.
  func refuseMatrixName(_ name: String) throws {
    guard getMat(name) != nil else { return }
    if !matsPossible { throw MatrixSeen() }
    throw LanguageError("\(name) is a matrix — use \(name) v, solve(\(name), v), det(\(name)), or trace(\(name)).")
  }

  /// A matrix where a number or a point is wanted.
  func refuseMatrixValue(_ e: Expr) throws {
    if try lowerMat(e) != nil { throw LanguageError(NOT_A_VALUE) }
  }

  /// The matvec M v: a matrix as the direct left factor of a product.
  func matrixProduct(_ e: Expr, _ op: BinOp, _ lhs: Expr, _ rhs: Expr) throws -> Lowered? {
    if op == .mul {
      let m = try lowerMat(lhs)?.m
      if let m, try lowerMat(rhs) == nil, let v = items(try lo(rhs)) {
        if v.count != m.count {
          let named: String? = if case .var(let name) = lhs { name } else { nil }
          throw LanguageError(
            "\(named ?? "That matrix") is \(m.count)×\(m.count), so it multiplies a \(m.count)-component "
              + "vector: \(named ?? "M") (x, y\(m.count == 3 ? ", z" : "")).")
        }
        return .vec(matVec(m, v))
      }
      if m == nil, try lowerMat(rhs) != nil, items(try lo(lhs)) != nil {
        let named: String = if case .var(let name) = rhs { name } else { "M" }
        throw LanguageError("Matrices multiply on the left — write \(named) v.")
      }
    }
    try refuseMatrixValue(e)
    return nil
  }

  /// A tuple whose items are all points (lib/geom.ts `lower`, case 'vec'):
  /// a matrix, read again with matrix algebra on, so a consumer — M v,
  /// det(M), a definition — sees it as one. Reaching here with it on, nothing
  /// consumed it.
  func tupleOfPoints(_ e: Expr, _ rows: [[Expr]]) throws -> Lowered {
    if !matsPossible { throw MatrixSeen() }
    let square = try lowerMat(e) != nil
    let dims = Set(rows.map(\.count))
    // Not square, so not a matrix here: a tuple of points, which list
    // lowering keeps in order for polyline(T), T[k] and friends.
    if !square && dims.count == 1 { return .scalar(.vec(rows.map { .vec($0) })) }
    // Two points of one dimension may well have meant the segment.
    if rows.count == 2 && dims.count == 1 {
      throw LanguageError(
        "A pair of points is a 2×2 matrix, not a figure — segment(A, B) joins them, "
          + "and M (x, y) applies the matrix.")
    }
    throw LanguageError(square ? NOT_A_VALUE : "A matrix is 2×2 or 3×3 — \(SHAPE_HINT).")
  }

  /// The calls that take or make a matrix (lib/geom.ts `lower`, case 'call'),
  /// or nil for any other.
  func matrixCall(_ e: Expr, _ name: String, _ args: [Expr]) throws -> Lowered? {
    if !matsPossible && name == "cross" && args.count == 1 { throw MatrixSeen() }
    try refuseMatrixValue(e)
    // A transpose lowered here stands where a number or point goes: matrix
    // algebra (lowerMat) takes every transpose of a matrix before this.
    if name == "transpose" {
      if !matsPossible { throw MatrixSeen() }
      guard args.count == 1, try lowerMat(args[0]) != nil else {
        throw LanguageError("transpose takes a matrix — define one with M = ((a, b), (c, d)).")
      }
      throw LanguageError(
        "transpose(M) is a matrix: apply it to a vector, or give it a row of its own to read it.")
    }
    guard name == "det" || name == "trace" || name == "solve" else { return nil }
    var matrix: Mat?
    if let raw = args.first {
      // A matrix — named, a tuple of rows, or algebra over them — is only
      // read with matrix algebra on: switch it on.
      if !matsPossible { throw MatrixSeen() }
      matrix = try lowerMat(raw)?.m
    }
    guard let m = matrix else {
      throw LanguageError("\(name) takes a matrix — define one with M = ((a, b), (c, d)).")
    }
    if name == "det" || name == "trace" {
      if args.count != 1 { throw LanguageError("\(name) takes one matrix.") }
      return .scalar(name == "det" ? detOf(m) : traceOf(m))
    }
    // solve(M, v): the remaining arguments are the right-hand side — one
    // vector, or its components flattened out of a tuple literal.
    let rest = try args.dropFirst().map(lo)
    var v: [Expr] = []
    if rest.count == 1, let only = items(rest[0]) {
      v = only
    } else {
      for r in rest {
        if case .scalar(let value) = r { v.append(value) }
      }
      if rest.count != m.count || v.count != rest.count {
        throw LanguageError("solve takes solve(M, v) with v a \(m.count)-component vector.")
      }
    }
    if v.count != m.count {
      throw LanguageError(
        "\(m.count)×\(m.count) matrix, \(v.count)-component vector — solve needs them to match.")
    }
    return .vec(solveVec(m, v))
  }

  /// A matrix the value of a `comp` reads as its rows — f(M), hull(S) — is a
  /// list of points, which waits for lists.
  func compMatrix(_ value: Expr) throws -> Bool {
    if case .var(let name) = value, getMat(name) != nil { return true }
    return try lowerMat(value) != nil
  }
}

// MARK: - Definitions and rows

/// A definition whose value is a matrix (`R = e^(a J)`, `N = 2 M`), or nil
/// (lib/geom.ts `lowerMatrix`).
func lowerMatrix(
  _ e: Expr, comps: @escaping (String) -> [String]?, getMat: @escaping GetMat, getTensor: @escaping GetTensor
) throws -> Mat? {
  // Only the matrix-algebra spine can make a matrix: look along it for one.
  func spine(_ n: Expr) -> Bool {
    if tensorOp(n) { return true }
    switch n {
    case .var(let name):
      return getMat(name) != nil || getTensor(name, false) != nil
    case .index(let target, _):
      // T[2], a slice of a tensor.
      if case .var(let name) = target, getTensor(name, false) == nil { return false }
      return spine(target)
    case .vec(let items):
      // A tuple with a row in it: ((a, b), (c, d)), or named points (A, B).
      return (items.count == 2 || items.count == 3)
        && items.contains {
          switch $0 {
          case .vec: true
          case .var(let name): comps(name) != nil
          default: false
          }
        }
    case .neg(let a): return spine(a)
    case .bin(_, let a, let b, _): return spine(a) || spine(b)
    case .call(let name, let args):
      return (name == "cross" && args.count == 1)
        || ((name == "exp" || name == "transpose") && args.count == 1 && spine(args[0]))
    default: return false
    }
  }
  if !spine(e) { return nil }
  return try GeomContext(comps: comps, getMat: getMat, getTensor: getTensor, mats: true).lowerMat(e)?.m
}

/// A definition whose value is a tensor of any shape but a square matrix's
/// (`T = e_x ⊗ e_y ⊗ e_z`, `R = ((1, 2, 3, 4), (5, 6, 7, 8))`), or nil
/// (lib/geom.ts `lowerTensorValue`). (A square one is lowerMatrix's; a tuple
/// of points stays a tuple.)
func lowerTensorValue(
  _ e: Expr, comps: @escaping (String) -> [String]?, getMat: @escaping GetMat, getTensor: @escaping GetTensor
) throws -> Tensor? {
  var candidate = tensorOp(e) || deepTuple(e)
  switch e {
  case .var(let name): if getTensor(name, false) != nil { candidate = true }
  case .bin, .neg, .index: candidate = true
  default: break
  }
  if !candidate { return nil }
  let context = GeomContext(comps: comps, getMat: getMat, getTensor: getTensor, mats: true)
  guard let t = try context.lowerTensor(e) else { return nil }
  // (Not square with rows of 2 or 3 is a tuple of points, named as one.)
  let points = t.shape.count == 2 && (t.shape[1] == 2 || t.shape[1] == 3)
  return t.shape.count >= 2 && toMat(t) == nil && !points ? t : nil
}

/// The internal call streamlines(M) lowers to, around the lowered matrix.
let STREAMLINES_CALL = "[streamlines]"
let STREAMLINES_USAGE =
  "streamlines takes one 2×2 matrix in x and y — streamlines(((x, y), (y, -x))) traces its major eigenvector."

/// A matrix or tensor with nothing to act on is drawn as its values: it has
/// no position, so its row reads it out (lib/geom.ts `lowerStatement`). A
/// pair of named points keeps saying what it is not: it was most likely
/// meant as the segment. Nil for any other row.
func lowerTensorStatement(_ e: Expr, _ context: GeomContext) throws -> Expr? {
  if case .vec(let items) = e, items.count == 2, items.allSatisfy({ if case .var = $0 { true } else { false } }) {
    return nil
  }
  guard context.matsPossible else { return nil }
  var value = try context.lowerTensor(e)
  if value == nil {
    // (Not a matrix after all, (1, 2) M: lowering says what it is.)
    do {
      value = try context.lowerMat(e).map { fromMat($0.m) }
    } catch is LanguageError {
    }
  }
  guard let value, value.shape.count >= 2 else { return nil }
  // A 3×2 tensor is a tuple of 2D points however it was made, so it draws
  // as ((1, 1), (2, 2), (3, 3)) written out does: as dots.
  if value.shape.count == 2 && toMat(value) == nil && (value.shape[1] == 2 || value.shape[1] == 3) {
    return .vec(rows(value).map { .vec($0.data) })
  }
  return tensorNode(value)
}
