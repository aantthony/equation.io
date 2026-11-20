/// Multivectors — the Clifford algebra of the plane and of space, Cl(2) and
/// Cl(3) with the Euclidean metric (lib/clifford.ts, docs/clifford.md).
///
/// A multivector is 2ⁿ symbolic coefficients, one per basis blade. Blade k is
/// the bitmask of its unit vectors: bit 0 is e_x, bit 1 e_y, bit 2 e_z, so
/// 3 is e_xy and 7 the pseudoscalar e_xyz. Like tensors (Tensor.swift) they
/// vanish during geometry lowering: every operation builds the scalar
/// expressions of the result's coefficients, so a slider, t or a list inside a
/// coefficient flows through to the end.
///
/// Quaternions are the even part of Cl(3): i = e_zy, j = e_xz, k = e_yx, so
/// i² = j² = k² = ijk = −1, and the unit quaternion cos(θ/2) + sin(θ/2) n̂
/// (n̂ read as i, j, k) is the rotor that turns by θ about n̂ in R v R̃.

struct Multivector: Equatable {
  /// 2 or 3.
  var dim: Int
  /// 2^dim coefficients, indexed by blade bitmask.
  var data: [Expr]
  /// Written as a quaternion (quat(…) or products of them): read out in i, j, k.
  var quat = false
}

private let ZERO = Expr.num(0)

func isZero(_ e: Expr) -> Bool {
  if case .num(let value) = e { return value == 0 }
  return false
}

func bladeGrade(_ blade: Int) -> Int { (blade & 1) + ((blade >> 1) & 1) + ((blade >> 2) & 1) }

/// The sign of the product of blades a and b: (−1)^(swaps to sort them).
func bladeSign(_ a: Int, _ b: Int) -> Int {
  var swaps = 0
  var x = a >> 1
  while x != 0 {
    swaps += bladeGrade(x & b)
    x >>= 1
  }
  return swaps & 1 != 0 ? -1 : 1
}

/// The blades as the readout and the input spell them: e_zx rather than e_xz
/// in space, the cyclic order that makes e_yz, e_zx, e_xy the duals of e_x,
/// e_y, e_z. `sign` is the stored blade's sign in that spelling.
private let SPELLING: [Int: [(blade: Int, name: String, sign: Double)]] = [
  2: [(0, "", 1), (1, "e_x", 1), (2, "e_y", 1), (3, "e_xy", 1)],
  3: [
    (0, "", 1), (1, "e_x", 1), (2, "e_y", 1), (4, "e_z", 1), (3, "e_xy", 1), (6, "e_yz", 1), (5, "e_zx", -1),
    (7, "e_xyz", 1),
  ],
]

/// A blade written as a name — e_xy, e_yx (= −e_xy), e_zx, e_xyz — or nil.
/// Single vectors are e_x, e_y, e_z, which stay the vectors they are.
/// Like them, a blade is always in space.
func bladeByName(_ name: String) -> Multivector? {
  let u = Array(name.utf16)
  guard u.count == 4 || u.count == 5, u[0] == unit("e"), u[1] == unit("_") else { return nil }
  var order: [Int] = []
  for c in u[2...] {
    guard c >= unit("x"), c <= unit("z") else { return nil }
    order.append(Int(c - unit("x")))
  }
  if Set(order).count != order.count { return nil }
  // Sort the axes, counting swaps: each one flips the sign.
  var sign = 1.0
  for i in 0..<order.count {
    var j = 0
    while j + 1 < order.count - i {
      if order[j] > order[j + 1] {
        order.swapAt(j, j + 1)
        sign = -sign
      }
      j += 1
    }
  }
  let blade = order.reduce(0) { $0 | (1 << $1) }
  // Always in space, as e_x is: (1, 0) ⟑ (0, 1) is the plane's own e_xy.
  return Multivector(dim: 3, data: (0..<8).map { $0 == blade ? .num(sign) : ZERO })
}

func scalarMv(_ e: Expr, _ dim: Int = 2) -> Multivector {
  Multivector(dim: dim, data: (0..<(1 << dim)).map { $0 == 0 ? e : ZERO })
}

/// A point or vector as a grade-1 multivector.
func vectorMv(_ items: [Expr]) throws -> Multivector {
  if items.count != 2 && items.count != 3 {
    throw LanguageError("A vector in a geometric product has 2 or 3 components, not \(items.count).")
  }
  var data = [Expr](repeating: ZERO, count: 1 << items.count)
  for (k, c) in items.enumerated() { data[1 << k] = c }
  return Multivector(dim: items.count, data: data)
}

/// w + x i + y j + z k.
func quaternion(_ w: Expr, _ x: Expr, _ y: Expr, _ z: Expr) -> Multivector {
  var data = [Expr](repeating: ZERO, count: 8)
  data[0] = w
  data[6] = neg(x)  // i = e_zy = −e_yz
  data[5] = y  // j = e_xz
  data[3] = neg(z)  // k = e_yx = −e_xy
  return Multivector(dim: 3, data: data, quat: true)
}

/// A quaternion's w, x, y, z, from the even part of a multivector.
func quaternionParts(_ a: Multivector) -> [Expr] {
  let d = widen(a, 3).data
  return [d[0], neg(d[6]), d[5], neg(d[3])]
}

/// The same multivector in space: the plane's blades keep their bitmasks.
private func widen(_ a: Multivector, _ dim: Int) -> Multivector {
  if a.dim == dim { return a }
  return Multivector(dim: dim, data: (0..<(1 << dim)).map { $0 < a.data.count ? a.data[$0] : ZERO }, quat: a.quat)
}

private func common(_ a: Multivector, _ b: Multivector) -> (Multivector, Multivector) {
  let dim = a.dim == 3 || b.dim == 3 ? 3 : 2
  return (widen(a, dim), widen(b, dim))
}

/// Only products of quaternions stay written as quaternions, and only while even.
private func quatFlag(_ data: [Expr], _ from: [Multivector]) -> Bool {
  if !from.allSatisfy({ $0.quat || isScalar($0) }) { return false }
  if !from.contains(where: \.quat) { return false }
  return data.enumerated().allSatisfy { k, c in bladeGrade(k) % 2 == 0 || isZero(c) }
}

/// Whether every coefficient beyond grade 0 is written as zero.
func isScalar(_ a: Multivector) -> Bool { a.data.enumerated().allSatisfy { k, c in k == 0 || isZero(c) } }

/// The grades whose coefficients are not all written as zero.
func gradesOf(_ a: Multivector) -> Set<Int> {
  var out: Set<Int> = []
  for (k, c) in a.data.enumerated() where !isZero(c) { out.insert(bladeGrade(k)) }
  return out
}

func mvAdd(_ a: Multivector, _ b: Multivector, minus: Bool = false) -> Multivector {
  let (x, y) = common(a, b)
  let data = zip(x.data, y.data).map { minus ? sub($0, $1) : add($0, $1) }
  return Multivector(dim: x.dim, data: data, quat: quatFlag(data, [a, b]))
}

func mvScale(_ a: Multivector, _ s: Expr) -> Multivector {
  Multivector(dim: a.dim, data: a.data.map { mul(s, $0) }, quat: a.quat)
}

func mvNeg(_ a: Multivector) -> Multivector { Multivector(dim: a.dim, data: a.data.map(neg), quat: a.quat) }

/// Sum the products of blades whose pair passes `keep`: the one loop behind
/// the geometric, outer and inner products.
private func product(_ a: Multivector, _ b: Multivector, _ keep: (Int, Int) -> Bool) -> Multivector {
  let (x, y) = common(a, b)
  var out = [Expr](repeating: ZERO, count: x.data.count)
  for (i, ca) in x.data.enumerated() where !isZero(ca) {
    for (j, cb) in y.data.enumerated() where !isZero(cb) && keep(i, j) {
      let term = mul(ca, cb)
      out[i ^ j] = bladeSign(i, j) > 0 ? add(out[i ^ j], term) : sub(out[i ^ j], term)
    }
  }
  return Multivector(dim: x.dim, data: out, quat: quatFlag(out, [a, b]))
}

/// The geometric product: e_i e_i = 1, e_i e_j = −e_j e_i.
func geometric(_ a: Multivector, _ b: Multivector) -> Multivector { product(a, b) { _, _ in true } }
/// The outer product: the part of the geometric product whose grades add.
func outerMv(_ a: Multivector, _ b: Multivector) -> Multivector { product(a, b) { i, j in i & j == 0 } }

/// Flip each grade k whose sign(k) is −1.
private func gradeSigns(_ a: Multivector, _ flips: (Int) -> Bool) -> Multivector {
  Multivector(
    dim: a.dim, data: a.data.enumerated().map { k, c in flips(bladeGrade(k)) ? neg(c) : c }, quat: a.quat)
}

/// Reversion Ã: the order of every blade's vectors reversed.
func reverse(_ a: Multivector) -> Multivector { gradeSigns(a) { $0 % 4 == 2 || $0 % 4 == 3 } }
/// Clifford conjugation Ā: reversion and grade involution together.
func conjugate(_ a: Multivector) -> Multivector { gradeSigns(a) { $0 % 4 == 1 || $0 % 4 == 2 } }

/// The grade-k part.
func gradePart(_ a: Multivector, _ k: Int) throws -> Multivector {
  if k < 0 || k > a.dim {
    throw LanguageError(
      "grade takes a grade from 0 to \(a.dim) for a multivector of \(a.dim == 2 ? "the plane" : "space").")
  }
  return Multivector(dim: a.dim, data: a.data.enumerated().map { blade, c in bladeGrade(blade) == k ? c : ZERO })
}

/// |A|² = ⟨A Ã⟩₀, the sum of the squared coefficients in a Euclidean algebra.
func normSquared(_ a: Multivector) -> Expr {
  a.data.reduce(ZERO) { s, c in isZero(c) ? s : add(s, mul(c, c)) }
}

/// The pseudoscalar of the multivector's space.
private func pseudoscalar(_ dim: Int) -> Multivector {
  Multivector(dim: dim, data: (0..<(1 << dim)).map { $0 == (1 << dim) - 1 ? .num(1) : ZERO })
}

/// The dual A I⁻¹: in space e_xy ↦ e_z, and a vector ↦ the plane it is normal to.
func dual(_ a: Multivector) -> Multivector {
  // I⁻¹ = Ĩ / |I|², and |I| = 1.
  geometric(a, reverse(pseudoscalar(a.dim)))
}

/// The inverse. In the plane A Ā is a number; in space it lies in the centre,
/// s + p I with I² = −1, so A⁻¹ = Ā (s − p I) / (s² + p²) — for every
/// invertible multivector, not only versors. (The other grades of A Ā
/// cancel identically; only s and p are read.)
func inverse(_ a: Multivector) -> Multivector {
  let bar = conjugate(a)
  let n = geometric(a, bar)
  let s = n.data[0]
  if a.dim == 2 {
    var out = mvScale(bar, div(.num(1), s))
    out.quat = quatFlag(bar.data, [a])
    return out
  }
  let p = n.data[7]
  let centre = Multivector(dim: 3, data: (0..<8).map { $0 == 0 ? s : $0 == 7 ? neg(p) : ZERO })
  var out = mvScale(geometric(bar, centre), div(.num(1), add(mul(s, s), mul(p, p))))
  out.quat = quatFlag(out.data, [a])
  return out
}

/// A whole power, n from −8 to 8: repeated products, a negative through the inverse.
func mvPower(_ a: Multivector, _ n: Double) throws -> Multivector {
  if !JS.isInteger(n) || abs(n) > 8 {
    throw LanguageError("A multivector power is a whole number from −8 to 8 — for e^A write e^(…).")
  }
  let base = n < 0 ? inverse(a) : a
  var out = scalarMv(.num(1), a.dim)
  out.quat = a.quat
  for _ in 0..<Int(abs(n)) { out = geometric(out, base) }
  return out
}

/// sqrt of a sum of squares, left as |c| for one coefficient.
func magnitude(_ coeffs: [Expr]) -> Expr {
  if coeffs.count == 1 { return .call("abs", [coeffs[0]]) }
  return .call("sqrt", [coeffs.reduce(ZERO) { s, c in add(s, mul(c, c)) }])
}

/// e^A. Scalars and the pseudoscalar of space commute with everything, so
/// they split off as e^s and cos p + I sin p. What is left must be a bivector,
/// which squares to −|B|² (every bivector of the plane or space is a blade),
/// so e^B = cos|B| + B sin|B|/|B|; or a vector, which squares to |v|², so
/// e^v = cosh|v| + v sinh|v|/|v|. A vector and a bivector together have no
/// closed form here.
func mvExp(_ a: Multivector) throws -> Multivector {
  let dim = a.dim
  let top = (1 << dim) - 1
  func at(_ grade: Int) -> [Expr] {
    a.data.enumerated().map { k, c in
      bladeGrade(k) == grade && k != 0 && !(dim == 3 && k == top) ? c : ZERO
    }
  }
  let vec = at(1)
  let biv = at(2)
  let hasVec = vec.contains { !isZero($0) }
  let hasBiv = biv.contains { !isZero($0) }
  if hasVec && hasBiv {
    throw LanguageError(
      "e^ takes a multivector whose non-scalar part is a bivector (a rotor) or a vector, not both.")
  }
  let own = hasVec ? vec : biv
  let parts = own.filter { !isZero($0) }
  var out: [Expr]
  if parts.isEmpty {
    out = a.data.indices.map { $0 == 0 ? .num(1) : ZERO }
  } else if parts.count == 1 {
    // One blade: cos b + B̂ sin b, or cosh b + v̂ sinh b, with no magnitude to take.
    let (even, odd) = hasVec ? ("cosh", "sinh") : ("cos", "sin")
    out = a.data.indices.map { k in
      if k == 0 { return .call(even, [parts[0]]) }
      return isZero(own[k]) ? ZERO : .call(odd, [own[k]])
    }
  } else {
    let r = magnitude(parts)
    // sin r / r is sinc; sinh r / r needs its limit 1 at r = 0 written in.
    let ratio: Expr =
      hasVec
      ? .piecewise(
        [Expr.Case(cond: .ineq(.gt, r, ZERO), value: div(.call("sinh", [r]), r))], otherwise: .num(1))
      : .call("sinc", [r])
    out = a.data.indices.map { k in
      if k == 0 { return .call(hasVec ? "cosh" : "cos", [r]) }
      return isZero(own[k]) ? ZERO : mul(ratio, own[k])
    }
  }
  var result = Multivector(dim: dim, data: out)
  let s = a.data[0]
  if !isZero(s) { result = mvScale(result, .call("exp", [s])) }
  let p = dim == 3 ? a.data[top] : ZERO
  if !isZero(p) {
    let turn = Multivector(
      dim: dim, data: result.data.indices.map { $0 == 0 ? .call("cos", [p]) : $0 == top ? .call("sin", [p]) : ZERO })
    result = geometric(result, turn)
  }
  result.quat = quatFlag(result.data, [a])
  return result
}

/// The spherical interpolation from a to b at u ∈ [0, 1], along the shorter
/// arc: both are normalised, and b turned to the same side as a (q and −q are
/// one rotation). sin(uΩ)/sin Ω is written u sinc(uΩ)/sinc(Ω), which stays
/// finite as a and b meet.
func slerp(_ a: Multivector, _ b: Multivector, _ u: Expr) -> Multivector {
  let (x, y) = common(a, b)
  let nx = Expr.call("sqrt", [normSquared(x)])
  let ny = Expr.call("sqrt", [normSquared(y)])
  let dot = zip(x.data, y.data).reduce(ZERO) { s, pair in add(s, mul(pair.0, pair.1)) }
  let cos = div(dot, mul(nx, ny))
  let side = Expr.piecewise([Expr.Case(cond: .ineq(.lt, cos, ZERO), value: .num(-1))], otherwise: .num(1))
  let omega = Expr.call("acos", [.call("min", [.call("abs", [cos]), .num(1)])])
  let v = sub(.num(1), u)
  let wa = div(mul(v, .call("sinc", [mul(v, omega)])), mul(.call("sinc", [omega]), nx))
  let wb = div(mul(mul(side, u), .call("sinc", [mul(u, omega)])), mul(.call("sinc", [omega]), ny))
  var out = mvAdd(mvScale(x, wa), mvScale(y, wb))
  out.quat = quatFlag(out.data, [a, b])
  return out
}

/// The matrix of v ↦ ⟨A v A⁻¹⟩₁, column j the image of e_j: for a rotor or a
/// unit quaternion the rotation it makes, for a vector n the reflection
/// along n. A⁻¹ is written Ã / |A|², which is the inverse of every versor.
func sandwichMatrix(_ a: Multivector, _ dim: Int) throws -> [[Expr]] {
  let x = widen(a, dim == 3 || a.dim == 3 ? 3 : 2)
  if x.dim > dim {
    throw LanguageError("A multivector of space cannot turn a point of the plane — give the point a z.")
  }
  let n2 = normSquared(x)
  let rev = reverse(x)
  let cols = try (0..<dim).map { j -> [Expr] in
    let ej = try vectorMv((0..<dim).map { .num($0 == j ? 1 : 0) })
    let img = geometric(geometric(x, ej), rev)
    return (0..<dim).map { i in div(img.data[1 << i], n2) }
  }
  return (0..<dim).map { i in cols.map { $0[i] } }
}

/// The internal call a multivector travels in, from lowering to classify:
/// its dimension, a quaternion flag, then its 2^dim coefficients. As a call,
/// a list in a coefficient broadcasts over it like any other.
let MV_CALL = "[mv]"

func mvNode(_ a: Multivector) -> Expr {
  .call(MV_CALL, [.num(Double(a.dim)), .num(a.quat ? 1 : 0)] + a.data)
}

func mvOfNode(_ e: Expr) -> Multivector? {
  guard case .call(MV_CALL, let args) = e, args.count >= 2 else { return nil }
  var dim = 2
  if case .num(let value) = args[0] { dim = Int(value) }
  var quat = false
  if case .num(1) = args[1] { quat = true }
  return Multivector(dim: dim, data: Array(args[2...]), quat: quat)
}

/// `1 + 2 e_xy - e_zx`, or `1 + 2i + 3j - 4k` for a quaternion, from the
/// coefficients' values. Terms that are zero are left out; all zero is `0`.
func mvText(dim: Int, quat: Bool, _ values: [Double], _ format: (Double) -> String) -> String {
  var terms: [(value: Double, name: String)] = []
  if quat {
    terms = [(values[0], ""), (-values[6], "i"), (values[5], "j"), (-values[3], "k")]
  } else {
    for spelled in SPELLING[dim] ?? [] { terms.append((spelled.sign * values[spelled.blade], spelled.name)) }
  }
  // Rounding leaves 1e-17 where a coefficient cancels (q⁻¹ q): a term that
  // small beside the largest is zero.
  let floor = 1e-12 * JS.max([0] + terms.map { abs($0.value) }.filter(\.isFinite))
  var out = ""
  for (value, name) in terms {
    if value == 0 || abs(value) <= floor { continue }
    let mag = abs(value)
    let coeff = !name.isEmpty && mag == 1 ? "" : format(mag)
    let body = name.isEmpty ? coeff : quat ? "\(coeff)\(name)" : coeff.isEmpty ? name : "\(coeff) \(name)"
    out += out.isEmpty ? (value < 0 ? "-\(body)" : body) : value < 0 ? " - \(body)" : " + \(body)"
  }
  return out.isEmpty ? "0" : out
}

/// A multivector's bivector as a glyph draws it: the vector normal to its
/// plane in space, or its one coefficient in the plane.
enum GlyphBivector {
  case normal([Expr])
  case plane(Expr)
}

/// The glyph parts of a multivector: its vector, its bivector, and its
/// trivector coefficient.
func glyphParts(_ a: Multivector) -> (vector: [Expr]?, bivector: GlyphBivector?, trivector: Expr?) {
  let d = a.data
  func any(_ ks: [Int]) -> Bool { ks.contains { !isZero(d[$0]) } }
  if a.dim == 2 {
    return (any([1, 2]) ? [d[1], d[2]] : nil, any([3]) ? .plane(d[3]) : nil, nil)
  }
  return (
    any([1, 2, 4]) ? [d[1], d[2], d[4]] : nil,
    // The dual of b_xy e_xy + b_yz e_yz + b_zx e_zx is (b_yz, b_zx, b_xy).
    any([3, 5, 6]) ? .normal([d[6], neg(d[5]), d[3]]) : nil,
    any([7]) ? d[7] : nil
  )
}

/// Passes of q ↦ q² + c a Julia surface takes, and where an orbit has escaped.
let JULIA_STEPS = 12
private let JULIA_ESCAPE = 1e4
/// The level of the Green's function drawn: small, so the surface hugs the set.
let JULIA_LEVEL = 1e-3

/// The quaternion Julia set of c, as the implicit surface G = JULIA_LEVEL in
/// the slice where q's k-part is `slice`: q = x + y i + z j + slice k.
///
/// G is the Green's function ln|qₙ|/2ⁿ of the orbit q ↦ q² + c, read at the
/// pass the orbit escapes (or the last). It is continuous — it tends to 0 on
/// the set and inside it — so the raymarcher sees a crossing where escape
/// counts would give it a jump, which it refuses. q² = (w² − |v|², 2 w v).
/// The orbit runs as a bounded loop, like a tail-recursive function.
func juliaSurface(_ c: [Expr], _ slice: Expr) -> Expr {
  let (w, x, y, z, n) = ("eqioQw", "eqioQx", "eqioQy", "eqioQz", "eqioQn")
  func v(_ name: String) -> Expr { .var(name) }
  let r2 = [w, x, y, z].reduce(ZERO) { s, k in add(s, mul(v(k), v(k))) }
  let green = div(.call("ln", [.call("max", [r2, .num(1e-12)])]), .bin(.pow, .num(2), add(v(n), .num(1))))
  let step = Expr.call(
    RECUR,
    [
      add(sub(mul(v(w), v(w)), add(add(mul(v(x), v(x)), mul(v(y), v(y))), mul(v(z), v(z)))), c[0]),
      add(mul(.num(2), mul(v(w), v(x))), c[1]),
      add(mul(.num(2), mul(v(w), v(y))), c[2]),
      add(mul(.num(2), mul(v(w), v(z))), c[3]),
      add(v(n), .num(1)),
    ])
  let loop = Expr.loop(
    params: [w, x, y, z, n], seeds: [v("x"), v("y"), v("z"), slice, ZERO],
    body: .piecewise(
      [
        Expr.Case(cond: .ineq(.gt, r2, .num(JULIA_ESCAPE)), value: green),
        Expr.Case(cond: .ineq(.ge, v(n), .num(Double(JULIA_STEPS))), value: green),
      ], otherwise: step),
    limit: JULIA_STEPS + 1)
  return .eq(loop, .num(JULIA_LEVEL))
}
