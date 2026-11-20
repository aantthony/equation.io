/// Tensors — values of any rank, as symbolic entries (lib/tensor.ts).
///
/// A rank-k tensor is a k-deep nested tuple, and its shape is part of its
/// type: (1, 2, 3) is a 3-vector, ((1, 2, 3), (4, 5, 6)) a 2×3 matrix. Like
/// matrices (Mat.swift), tensors vanish during geometry lowering: every
/// operation here builds scalar expressions for the entries.
///
/// The operations act on coordinates:
/// - the outer product, (A ⊗ B)_ij = A_i B_j, with rank p + q;
/// - contraction of two indices of one tensor, which with ⊗ gives every
///   other contraction: M N is contract(M ⊗ N, 2, 3), and trace is
///   contract(M, 1, 2);
/// - the wedge, a ∧ b = a ⊗ b − b ⊗ a on vectors, and in general the
///   antisymmetrised product (p + q)!/(p! q!) Alt(A ⊗ B), which keeps ∧
///   associative.

/// Entries row-major: the last index runs fastest, as in nested tuples.
struct Tensor: Equatable {
  var shape: [Int]
  var data: [Expr]
}

/// Tensor lookup during lowering; nil for names that are not tensors. With
/// `tuples`, a named tuple of points counts too.
typealias GetTensor = (_ name: String, _ tuples: Bool) -> Tensor?

/// Entries a tensor may hold. Every one is a symbolic expression that
/// lowering carries to the end, so this bounds the work, not the memory.
let TENSOR_MAX = 729

private func size(_ shape: some Collection<Int>) -> Int { shape.reduce(1, *) }

/// A value of this shape, for messages: 'a number', 'a 3-vector', 'a 2×3 tensor'.
func shapeText(_ shape: [Int]) -> String {
  shape.isEmpty
    ? "a number"
    : shape.count == 1 ? "a \(shape[0])-vector" : "a \(shape.map(String.init).joined(separator: "×")) tensor"
}

private func checked(_ shape: [Int], _ data: [Expr]) throws -> Tensor {
  if data.count > TENSOR_MAX {
    throw LanguageError("That tensor has \(data.count) entries — the limit is \(TENSOR_MAX).")
  }
  return Tensor(shape: shape, data: data)
}

func scalarTensor(_ e: Expr) -> Tensor { Tensor(shape: [], data: [e]) }
func vectorTensor(_ items: [Expr]) -> Tensor { Tensor(shape: [items.count], data: items) }
func fromMat(_ m: Mat) -> Tensor { Tensor(shape: [m.count, m[0].count], data: m.flatMap { $0 }) }

/// The square 2×2 or 3×3 matrix a tensor is, or nil.
func toMat(_ t: Tensor) -> Mat? {
  guard t.shape.count == 2, t.shape[0] == t.shape[1], t.shape[0] == 2 || t.shape[0] == 3 else { return nil }
  let n = t.shape[0]
  return (0..<n).map { Array(t.data[($0 * n)..<(($0 + 1) * n)]) }
}

/// Stack tensors of one shape along a new first index: the rows of a tuple.
func stack(_ items: [Tensor]) throws -> Tensor? {
  guard let shape = items.first?.shape else { return nil }
  if items.contains(where: { $0.shape != shape }) { return nil }
  return try checked([items.count] + shape, items.flatMap(\.data))
}

/// The slices along the first index: a tensor's rows, as nested tuples list them.
func rows(_ t: Tensor) -> [Tensor] {
  let inner = Array(t.shape.dropFirst())
  let n = size(inner)
  return (0..<t.shape[0]).map { Tensor(shape: inner, data: Array(t.data[($0 * n)..<(($0 + 1) * n)])) }
}

private func sameShape(_ op: String, _ a: Tensor, _ b: Tensor) throws {
  if a.shape != b.shape {
    throw LanguageError("Cannot \(op) \(shapeText(a.shape)) and \(shapeText(b.shape)) — the shapes differ.")
  }
}

func tensorAdd(_ a: Tensor, _ b: Tensor, minus: Bool = false) throws -> Tensor {
  try sameShape(minus ? "subtract" : "add", a, b)
  return Tensor(shape: a.shape, data: zip(a.data, b.data).map { minus ? sub($0, $1) : add($0, $1) })
}

func tensorScale(_ t: Tensor, _ s: Expr) -> Tensor { Tensor(shape: t.shape, data: t.data.map { mul(s, $0) }) }
func tensorNeg(_ t: Tensor) -> Tensor { Tensor(shape: t.shape, data: t.data.map(neg)) }

/// (A ⊗ B)_{i…j…} = A_{i…} B_{j…}.
func outer(_ a: Tensor, _ b: Tensor) throws -> Tensor {
  try checked(a.shape + b.shape, a.data.flatMap { x in b.data.map { y in mul(x, y) } })
}

/// Strides of a row-major shape: how far one step along each index moves.
private func strides(_ shape: [Int]) -> [Int] { shape.indices.map { size(shape[($0 + 1)...]) } }

/// Sum over index i = index j (0-based, i ≠ j), which drops both: rank k
/// becomes rank k − 2. The two indices need one length.
func contract(_ t: Tensor, _ i: Int, _ j: Int) throws -> Tensor {
  let k = t.shape.count
  if i == j || i < 0 || j < 0 || i >= k || j >= k {
    throw LanguageError("contract takes two different indices of the tensor, 1 to \(k).")
  }
  if t.shape[i] != t.shape[j] {
    throw LanguageError(
      "contract needs two indices of one length — index \(i + 1) runs to \(t.shape[i]) and "
        + "index \(j + 1) to \(t.shape[j]).")
  }
  let st = strides(t.shape)
  let rest = t.shape.indices.filter { $0 != i && $0 != j }
  let shape = rest.map { t.shape[$0] }
  var out: [Expr] = []
  for flat in 0..<size(shape) {
    // The offset of this result entry's own indices in t.
    var base = 0
    var left = flat
    for r in rest.indices.reversed() {
      base += (left % shape[r]) * st[rest[r]]
      left /= shape[r]
    }
    var sum: Expr?
    for m in 0..<t.shape[i] {
      let x = t.data[base + m * (st[i] + st[j])]
      sum = sum.map { add($0, x) } ?? x
    }
    out.append(sum!)
  }
  return Tensor(shape: shape, data: out)
}

/// The product that juxtaposition writes, M N: contract the last index of a
/// with the first of b — the matrix product, matvec, and dot product.
func product(_ a: Tensor, _ b: Tensor) throws -> Tensor {
  let p = a.shape.count
  if a.shape[p - 1] != b.shape[0] {
    throw LanguageError(
      "Cannot multiply \(shapeText(a.shape)) by \(shapeText(b.shape)) — the last index of the first and "
        + "the first index of the second need one length.")
  }
  // Summed directly rather than through contract(outer(a, b)), which would
  // build every product only to add most of them away.
  let n = b.shape[0]
  let shape = Array(a.shape.dropLast()) + Array(b.shape.dropFirst())
  if n == 0 { return Tensor(shape: shape, data: []) }
  let left = a.data.count / n
  let right = b.data.count / n
  var out: [Expr] = []
  for r in 0..<left {
    for c in 0..<right {
      var sum = mul(a.data[r * n], b.data[c])
      for m in 1..<n { sum = add(sum, mul(a.data[r * n + m], b.data[m * right + c])) }
      out.append(sum)
    }
  }
  return try checked(shape, out)
}

/// The sign of a permutation (an array of 0…n−1), by counting inversions.
private func sign(_ perm: [Int]) -> Int {
  var s = 1
  for i in perm.indices {
    for j in (i + 1)..<perm.count where perm[i] > perm[j] { s = -s }
  }
  return s
}

private func permutations(_ n: Int) -> [[Int]] {
  if n == 0 { return [[]] }
  return permutations(n - 1).flatMap { p in (0..<n).map { k in Array(p[..<k]) + [n - 1] + Array(p[k...]) } }
}

private func factorial(_ n: Int) -> Int { n <= 1 ? 1 : n * factorial(n - 1) }

/// The exterior product. On two vectors it is a ⊗ b − b ⊗ a; in general it
/// is (p + q)!/(p! q!) Alt(A ⊗ B), where Alt averages the signed
/// permutations of the indices. A scalar wedges as multiplication.
func wedge(_ a: Tensor, _ b: Tensor) throws -> Tensor {
  let p = a.shape.count
  let q = b.shape.count
  if p == 0 || q == 0 { return try outer(a, b) }
  let t = try outer(a, b)
  let n = p + q
  let dim = t.shape[0]
  if t.shape.contains(where: { $0 != dim }) {
    throw LanguageError("∧ joins vectors of one dimension, not \(shapeText(a.shape)) and \(shapeText(b.shape)).")
  }
  if n > dim { return Tensor(shape: t.shape, data: t.data.map { _ in .num(0) }) }
  let perms = permutations(n).map { (perm: $0, sign: sign($0)) }
  let st = strides(t.shape)
  let weight = factorial(p) * factorial(q)
  var out: [Expr] = []
  var index = Array(repeating: 0, count: n)
  for flat in t.data.indices {
    var left = flat
    for d in (0..<n).reversed() {
      index[d] = left % dim
      left /= dim
    }
    var sum = Expr.num(0)
    for (perm, s) in perms {
      var at = 0
      for (d, from) in perm.enumerated() { at += index[from] * st[d] }
      let x = t.data[at]
      sum = s > 0 ? add(sum, x) : sub(sum, x)
    }
    out.append(weight == 1 ? sum : mul(.num(1 / Double(weight)), sum))
  }
  return Tensor(shape: t.shape, data: out)
}

/// The internal call a tensor value travels in, from geometry lowering to
/// classify: its rank, its shape, then its entries.
let TENSOR_CALL = "[tensor]"

func tensorNode(_ t: Tensor) -> Expr {
  .call(TENSOR_CALL, [.num(Double(t.shape.count))] + t.shape.map { .num(Double($0)) } + t.data)
}

/// The tensor a `[tensor]` call holds, or nil for any other node.
func tensorOfNode(_ e: Expr) -> Tensor? {
  guard case .call(TENSOR_CALL, let args) = e, let first = args.first else { return nil }
  func whole(_ a: Expr) -> Int {
    if case .num(let value) = a, value.isFinite { return Int(value) }
    return 0
  }
  let rank = whole(first)
  guard rank >= 0, args.count >= 1 + rank else { return nil }
  return Tensor(shape: args[1..<(1 + rank)].map(whole), data: Array(args[(1 + rank)...]))
}

/// `((1, 0), (0, 2))`: a tensor's values as the nested tuples that write it.
func nestedText(_ shape: [Int], _ values: [String]) -> String {
  guard let first = shape.first else { return values[0] }
  let inner = Array(shape.dropFirst())
  let n = size(inner)
  let parts = (0..<first).map { nestedText(inner, Array(values[($0 * n)..<(($0 + 1) * n)])) }
  return "(\(parts.joined(separator: ", ")))"
}
