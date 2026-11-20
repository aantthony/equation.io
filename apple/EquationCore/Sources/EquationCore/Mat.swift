/// Small matrices — 2×2 and 3×3 — as definition-time symbolic objects
/// (lib/mat.ts).
///
/// `M = ((a, b), (c, d))` — a tuple of rows, or of named points as rows — is
/// a matrix. Like sums, d/dx and points, matrices vanish before anything
/// downstream looks: det, trace, the matvec `M v` and `solve(M, v)` (Cramer's
/// rule) all expand during geometry lowering into ordinary scalar
/// expressions. GLSL, evaluate and diff never see a matrix.
///
/// Matrices also combine — `s M`, `M + N`, `M N`, `M^n`, `M^-1` — and
/// exponentiate: `e^(th J)` with `J = ((0, -1), (1, 0))` is the rotation by
/// th, and `e^(th cross(n))` the rotation about the axis n, each expanded to
/// its closed form (see `expOf`) so that the result is, again, only scalars.

/// Row-major square matrix of scalar expressions, side 2 or 3.
typealias Mat = [[Expr]]

/// Matrix lookup during lowering; nil for names that are not matrices.
typealias GetMat = (String) -> Mat?

/// The shape a matrix literal takes, for errors about one.
let SHAPE_HINT = "write a tuple of equal-length rows: M = ((a, b), (c, d))"

/// Read a matrix out of lowered rows — the items of a tuple of tuples, or of
/// named points. A square 2×2 or 3×3 is a matrix; any other shape is nil, so
/// the caller can say what that tuple is in its own context.
func matrixFromRows(_ rows: [[Expr]]) -> Mat? {
  let n = rows.count
  if (n != 2 && n != 3) || rows.contains(where: { $0.count != n }) { return nil }
  return rows
}

/// det for side 2 or 3 (cofactor expansion along the first row).
func detOf(_ m: Mat) -> Expr {
  if m.count == 2 { return sub(mul(m[0][0], m[1][1]), mul(m[0][1], m[1][0])) }
  func minor(_ r0: Int, _ r1: Int, _ c0: Int, _ c1: Int) -> Expr {
    sub(mul(m[r0][c0], m[r1][c1]), mul(m[r0][c1], m[r1][c0]))
  }
  return add(sub(mul(m[0][0], minor(1, 2, 1, 2)), mul(m[0][1], minor(1, 2, 0, 2))), mul(m[0][2], minor(1, 2, 0, 1)))
}

func traceOf(_ m: Mat) -> Expr {
  var s = m[0][0]
  for k in 1..<m.count { s = add(s, m[k][k]) }
  return s
}

/// M v, componentwise dot products.
func matVec(_ m: Mat, _ v: [Expr]) -> [Expr] {
  m.map { row in
    var s = mul(row[0], v[0])
    for k in 1..<v.count { s = add(s, mul(row[k], v[k])) }
    return s
  }
}

/// The solution of M x = v by Cramer's rule: x_i = det(M with column i
/// replaced by v) / det(M). Symbolic — a singular M yields NaN at evaluation
/// time.
func solveVec(_ m: Mat, _ v: [Expr]) -> [Expr] {
  let d = detOf(m)
  return v.indices.map { i in
    let mi = m.enumerated().map { r, row in row.enumerated().map { c, entry in c == i ? v[r] : entry } }
    return div(detOf(mi), d)
  }
}

private func isNum(_ e: Expr) -> Bool {
  if case .num = e { return true }
  return false
}

private func numValue(_ e: Expr) -> Double? {
  if case .num(let value) = e { return value }
  return nil
}

/// A constant entry as its number: (1, 1, 1)/sqrt(3) is an axis of numbers,
/// not three copies of 1/sqrt(3) in every entry of the rotation.
private func settle(_ e: Expr) -> Expr {
  if isNum(e) || !freeVars(e).isEmpty { return e }
  guard let v = try? evaluate(e, [:]), v.isFinite else { return e }
  return .num(v)
}

/// A matrix under lowering. `scale`·`base` is the same matrix with a scalar
/// factor kept apart — `th J` remembers th and J — because a rotation's angle
/// is exactly that factor, and reading it back out of the products would cost
/// a square root and a division by zero at th = 0.
struct MatValue {
  var m: Mat
  var scale: Expr?
  var base: Mat?
}

func identity(_ n: Int) -> Mat {
  (0..<n).map { r in (0..<n).map { c in .num(r == c ? 1 : 0) } }
}

private func mapMat(_ m: Mat, _ f: (Expr, Int, Int) -> Expr) -> Mat {
  m.enumerated().map { r, row in row.enumerated().map { c, entry in f(entry, r, c) } }
}

private func sameSide(_ op: String, _ a: Mat, _ b: Mat) throws {
  if a.count != b.count {
    throw LanguageError("Cannot \(op) a \(a.count)×\(a.count) and a \(b.count)×\(b.count) matrix.")
  }
}

func matScale(_ v: MatValue, _ s: Expr) -> MatValue {
  MatValue(m: mapMat(v.m) { entry, _, _ in mul(s, entry) }, scale: v.scale.map { mul(s, $0) } ?? s, base: v.base ?? v.m)
}

func matNeg(_ v: MatValue) -> MatValue {
  MatValue(m: mapMat(v.m) { entry, _, _ in neg(entry) }, scale: v.scale.map(neg) ?? .num(-1), base: v.base ?? v.m)
}

func matAdd(_ a: Mat, _ b: Mat, minus: Bool = false) throws -> Mat {
  try sameSide(minus ? "subtract" : "add", a, b)
  return mapMat(a) { entry, r, c in minus ? sub(entry, b[r][c]) : add(entry, b[r][c]) }
}

func matMul(_ a: Mat, _ b: Mat) throws -> Mat {
  try sameSide("multiply", a, b)
  return mapMat(a) { _, r, c in
    let terms = a[r].enumerated().map { k, entry in mul(entry, b[k][c]) }
    return terms.dropFirst().reduce(terms[0], add)
  }
}

func transposeOf(_ m: Mat) -> Mat {
  m.indices.map { r in m[r].indices.map { c in m[c][r] } }
}

/// The inverse as adjugate / det — singular matrices give NaN at evaluation
/// time, like solve.
func inverseOf(_ m: Mat) -> Mat {
  let d = detOf(m)
  if m.count == 2 {
    return [
      [div(m[1][1], d), div(neg(m[0][1]), d)],
      [div(neg(m[1][0]), d), div(m[0][0], d)],
    ]
  }
  func cof(_ r: Int, _ c: Int) -> Expr {
    let rs = [0, 1, 2].filter { $0 != r }
    let cs = [0, 1, 2].filter { $0 != c }
    let minor = sub(mul(m[rs[0]][cs[0]], m[rs[1]][cs[1]]), mul(m[rs[0]][cs[1]], m[rs[1]][cs[0]]))
    return (r + c) % 2 != 0 ? neg(minor) : minor
  }
  return mapMat(m) { _, r, c in div(cof(c, r), d) }
}

/// Whole powers a symbolic product can afford.
let MAT_POWER_MAX = 8

func matPow(_ m: Mat, _ n: Double) throws -> Mat {
  if n == -1 { return inverseOf(m) }
  if !JS.isInteger(n) || n < 0 || n > Double(MAT_POWER_MAX) {
    throw LanguageError(
      "A matrix power is a whole number from 0 to \(MAT_POWER_MAX), or -1 for the inverse — "
        + "for a rotation by any angle write e^(th J).")
  }
  var out = identity(m.count)
  for _ in 0..<Int(n) { out = try matMul(out, m) }
  return out
}

/// [n]×, the matrix of v ↦ n × v: the generator of rotations about n.
func hatOf(_ n: [Expr]) -> Mat {
  [
    [.num(0), neg(n[2]), n[1]],
    [n[2], .num(0), neg(n[0])],
    [neg(n[1]), n[0], .num(0)],
  ]
}

private func same(_ a: Expr, _ b: Expr) -> Bool { sameExprKey(a, b) }

private func opposite(_ a: Expr, _ b: Expr) -> Bool {
  if let x = numValue(a), let y = numValue(b) { return x == -y }
  return same(neg(a), b) || same(a, neg(b))
}

/// Whether e is 0 for every value of its variables. Structure alone misses
/// a wedge of named vectors, whose diagonal is `a_x b_x − b_x a_x`, so a
/// symbolic entry is evaluated at a few arbitrary points: an entry that
/// vanishes at all of them is taken as zero.
private let probes: [Double] = [0.7318, 1.3906, -0.4561]

private func vanishes(_ e: Expr) -> Bool {
  let vars = freeVars(e).list
  if vars.isEmpty { return numValue(settle(e)) == 0 }
  return probes.enumerated().allSatisfy { k, seed in
    var env: [String: Double] = [:]
    for (i, name) in vars.enumerated() { env[name] = seed + 0.61 * Double(i) + 0.17 * Double(k) * Double(i) }
    guard let v = try? evaluate(e, env) else { return false }
    return abs(v) < 1e-9
  }
}

/// JavaScript's `Math.hypot` (V8: scaled by the largest, summed with Kahan's
/// compensation), so an axis' length is the number the site computes.
func jsHypot(_ values: [Double]) -> Double {
  var largest = 0.0
  for v in values {
    if v.isNaN { return .nan }
    largest = Swift.max(largest, abs(v))
  }
  if largest == 0 { return 0 }
  if largest == .infinity { return .infinity }
  var sum = 0.0
  var compensation = 0.0
  for v in values {
    let n = abs(v) / largest
    let summand = n * n - compensation
    let preliminary = sum + summand
    compensation = (preliminary - sum) - summand
    sum = preliminary
  }
  return sum.squareRoot() * largest
}

/// e^M in closed form.
///
/// 2×2, `[(p, -w), (w, p)]` — a rotation generator plus a multiple of I — is
/// e^p times the rotation by w. Any other 2×2 uses
///   e^M = e^s (C I + S (M − s I)),  s = tr/2,  δ = s² − det,
/// with C = cosh √δ and S = sinh √δ / √δ, which continue to cos and sin / ·
/// for δ < 0: one formula for spirals, saddles and nodes alike, smooth across
/// δ = 0 — so e^(t A) (x0, y0) is the exact flow of (x', y') = A (x, y).
///
/// 3×3 must be skew-symmetric — cross(n), or s cross(n) — and is Rodrigues'
/// rotation about n by |n|.
func expOf(_ v: MatValue) throws -> Mat {
  let scale = v.scale ?? .num(1)
  let base = (v.base ?? v.m).map { $0.map(settle) }
  let eye = identity(base.count)
  func fn(_ name: String, _ args: Expr...) -> Expr { .call(name, args) }
  if base.count == 2 {
    let (a, b, c, d) = (base[0][0], base[0][1], base[1][0], base[1][1])
    if same(a, d) && opposite(b, c) {
      let angle = mul(scale, c)
      let grow = numValue(a) == 0 ? Expr.num(1) : fn("exp", mul(scale, a))
      let cos = mul(grow, fn("cos", angle))
      let sin = mul(grow, fn("sin", angle))
      return [
        [cos, neg(sin)],
        [sin, cos],
      ]
    }
    let m = v.m
    let s = div(traceOf(m), .num(2))
    let delta = sub(mul(s, s), detOf(m))
    let q = fn("sqrt", fn("abs", delta))
    // √δ guarded away from 0 where it divides (no branch may hold a 0/0,
    // taken or not), and S read off its series 1 + δ/6 + … across δ = 0.
    let qs = fn("max", q, .num(1e-4))
    let real = Expr.ineq(.ge, delta, .num(0))
    let tiny = Expr.ineq(.lt, fn("abs", delta), .num(1e-6))
    let C = Expr.piecewise([Expr.Case(cond: real, value: fn("cosh", q))], otherwise: fn("cos", q))
    let S = Expr.piecewise(
      [
        Expr.Case(cond: tiny, value: add(.num(1), div(delta, .num(6)))),
        Expr.Case(cond: real, value: div(fn("sinh", qs), qs)),
      ], otherwise: div(fn("sin", qs), qs))
    let es = fn("exp", s)
    return mapMat(m) { entry, r, col in
      mul(es, add(mul(C, eye[r][col]), mul(S, sub(entry, mul(s, eye[r][col])))))
    }
  }
  let skew = base.enumerated().allSatisfy { r, row in
    row.enumerated().allSatisfy { c, entry in
      r == c ? vanishes(entry) : opposite(entry, base[c][r]) || vanishes(add(entry, base[c][r]))
    }
  }
  if !skew {
    throw LanguageError(
      "e^M for a 3×3 matrix needs a rotation generator: e^(th cross(n)) turns by th about the axis n.")
  }
  let w = [base[2][1], base[0][2], base[1][0]]
  let numbers = w.compactMap(numValue)
  let numeric = numbers.count == w.count
  let squares = w.map { mul($0, $0) }
  let len: Expr = numeric ? .num(jsHypot(numbers)) : fn("sqrt", squares.dropFirst().reduce(squares[0], add))
  // A zero axis turns nothing: the guard makes that the identity, not 0/0.
  let safe = numeric ? len : fn("max", len, .num(1e-6))
  if numValue(safe) == 0 { return eye }
  let angle = mul(scale, len)
  let first = div(fn("sin", angle), safe)
  let second = div(sub(.num(1), fn("cos", angle)), mul(safe, safe))
  let squared = try matMul(base, base)
  return mapMat(eye) { one, r, c in add(add(one, mul(first, base[r][c])), mul(second, squared[r][c])) }
}
