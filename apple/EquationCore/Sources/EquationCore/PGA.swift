#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

/// Projective geometric algebra — Cl(2,0,1) for the plane and Cl(3,0,1) for
/// space (lib/pga.ts, docs/pga.md). The algebra of Clifford.swift with one
/// more basis vector, e0, whose square is 0: in it a plane of space (a line
/// of the plane) is a vector, a line of space a bivector, and a point the
/// complement of a vector, so the outer product ∧ intersects (meet) and the
/// regressive product ∨ spans (join).
///
/// Blade k is a bitmask as in Clifford.swift — bit 0 e_x, bit 1 e_y, bit 2
/// e_z in space — with e0 the next bit up: 4 in the plane, 8 in space. A
/// plane a x + b y + c z + d = 0 is a e_x + b e_y + c e_z + d e0 (a line of
/// the plane leaves out c e_z), and the point (x, y, z) is J(x e_x + y e_y +
/// z e_z + e0), J the complement below, so p ∧ P = (a x + b y + c z + d) I:
/// zero exactly when P lies on p.
///
/// Like multivectors, these vanish during lowering: every operation builds
/// the scalar expressions of the result's coefficients.

/// An element of the projective algebra of the plane or space: 2^(dim+1)
/// coefficients, indexed by blade bitmask.
///
/// With a `grade` it is a point, line or plane (the TypeScript's `Flat`): the
/// grade comes from how it was made, never from which coefficients happen to
/// be zero, so dragging never changes what it is. Operations of the algebra
/// give an element of no grade (0 here), which the caller sets.
struct Pga: Equatable {
  var dim: Int
  var data: [Expr]
  var grade = 0
  /// A motor made by motor(L, θ, d) keeps its slide apart, applied first:
  /// `data` turns about the axis and `slide` (a translation along it) moves,
  /// so the motion is X ↦ data (slide X slide~) data~. Kept as two factors,
  /// each stays small where their product, for an axis through draggable
  /// points, would not (motorOf multiplies them where the whole is needed).
  var slide: [Expr]?

  func graded(_ grade: Int) -> Pga { Pga(dim: dim, data: data, grade: grade) }
}

typealias Flat = Pga

private let ZERO = Expr.num(0)

/// The bit of e0, and the number of blades, of the algebra over `dim`.
func e0Bit(_ dim: Int) -> Int { 1 << dim }
private func size(_ dim: Int) -> Int { 1 << (dim + 1) }

func popcount(_ k: Int) -> Int { k.nonzeroBitCount }

/// The sign of the product of blades a and b: (−1)^(swaps to sort them).
private func pgaBladeSign(_ a: Int, _ b: Int) -> Int {
  var swaps = 0
  var x = a >> 1
  while x != 0 {
    swaps += popcount(x & b)
    x >>= 1
  }
  return swaps & 1 != 0 ? -1 : 1
}

func zeroPga(_ dim: Int) -> Pga { Pga(dim: dim, data: [Expr](repeating: ZERO, count: size(dim))) }

private func fromEntries(_ dim: Int, _ entries: [(Int, Expr)]) -> Pga {
  var data = [Expr](repeating: ZERO, count: size(dim))
  for (k, c) in entries { data[k] = c }
  return Pga(dim: dim, data: data)
}

/// Sum the products of blades whose pair passes `keep`; a pair sharing e0
/// is dropped, as e0² = 0. The one loop behind every product.
private func product(_ a: Pga, _ b: Pga, _ keep: (Int, Int) -> Bool) throws -> Pga {
  if a.dim != b.dim {
    throw LanguageError("A flat of the plane and one of space do not combine — give the points a z.")
  }
  let e0 = e0Bit(a.dim)
  var out = [Expr](repeating: ZERO, count: a.data.count)
  for (i, ca) in a.data.enumerated() where !isZero(ca) {
    for (j, cb) in b.data.enumerated() where !isZero(cb) && i & j & e0 == 0 && keep(i, j) {
      let term = mul(ca, cb)
      out[i ^ j] = pgaBladeSign(i, j) > 0 ? add(out[i ^ j], term) : sub(out[i ^ j], term)
    }
  }
  return Pga(dim: a.dim, data: out)
}

/// The geometric product: e_x² = e_y² = e_z² = 1, e0² = 0.
func geometricPga(_ a: Pga, _ b: Pga) throws -> Pga { try product(a, b) { _, _ in true } }
/// The outer product — the meet: the part whose grades add.
func outerPga(_ a: Pga, _ b: Pga) throws -> Pga { try product(a, b) { i, j in i & j == 0 } }
/// The inner product: the part of grade |grade(a) − grade(b)|, where one
/// blade lies inside the other.
func innerPga(_ a: Pga, _ b: Pga) throws -> Pga { try product(a, b) { i, j in i & j == i || i & j == j } }

func addPga(_ a: Pga, _ b: Pga, minus: Bool = false) -> Pga {
  Pga(dim: a.dim, data: zip(a.data, b.data).map { minus ? sub($0, $1) : add($0, $1) })
}

func scalePga(_ a: Pga, _ s: Expr) -> Pga { Pga(dim: a.dim, data: a.data.map { mul(s, $0) }) }

/// Reversion: grade k flips when k mod 4 is 2 or 3.
func reversePga(_ a: Pga) -> Pga {
  Pga(dim: a.dim, data: a.data.enumerated().map { k, c in popcount(k) % 4 >= 2 ? neg(c) : c })
}

/// The grade-k part.
func gradePartPga(_ a: Pga, _ k: Int) -> Pga {
  Pga(dim: a.dim, data: a.data.enumerated().map { blade, c in popcount(blade) == k ? c : ZERO })
}

/// The sign s_k with e_k ∧ s_k e_{~k} = +I, I the blade of every bit.
private func complementSign(_ k: Int, _ full: Int) -> Int { pgaBladeSign(k, full & ~k) }
private func signed(_ s: Int, _ c: Expr) -> Expr { s < 0 ? neg(c) : c }

/// The complement J: each blade to the blade of the bits it lacks, signed so
/// that e_k ∧ J(e_k) = I. The metric is degenerate, so this — not A I⁻¹ — is
/// the duality of PGA. J of a vector (x, y, z, w) is the point (x, y, z)/w.
func complement(_ a: Pga) -> Pga {
  let full = size(a.dim) - 1
  // J(e_k) = s_k e_{~k}, so J(a) at m is s_{~m} a(~m).
  return Pga(
    dim: a.dim, data: a.data.indices.map { m in signed(complementSign(full & ~m, full), a.data[full & ~m]) })
}

/// The inverse of J: J⁻¹(e_{~k}) = s_k e_k.
func uncomplement(_ a: Pga) -> Pga {
  let full = size(a.dim) - 1
  return Pga(dim: a.dim, data: a.data.indices.map { k in signed(complementSign(k, full), a.data[full & ~k]) })
}

/// The regressive product — the join: J⁻¹(J(a) ∧ J(b)), the span of a and b.
func regressivePga(_ a: Pga, _ b: Pga) throws -> Pga {
  uncomplement(try outerPga(complement(a), complement(b)))
}

/// The vector a e_x + b e_y (+ c e_z) + d e0: a line of the plane, a plane of space.
func hyperplane(_ normal: [Expr], _ offset: Expr) -> Pga {
  let dim = normal.count
  return fromEntries(dim, normal.enumerated().map { k, c in (1 << k, c) } + [(e0Bit(dim), offset)])
}

/// The point at `coords` (2 or 3 of them), of weight 1.
func pointPga(_ coords: [Expr]) -> Pga { complement(hyperplane(coords, .num(1))) }
/// The ideal point in direction `dir`: a point of weight 0.
func idealPointPga(_ dir: [Expr]) -> Pga { complement(hyperplane(dir, ZERO)) }

/// A point's weight: 0 for an ideal point.
func weight(_ p: Pga) -> Expr { uncomplement(p).data[e0Bit(p.dim)] }

/// A point's homogeneous coordinates: what it divides by its weight to be (x, y, z).
func pointParts(_ p: Pga) -> (coords: [Expr], weight: Expr) {
  let v = uncomplement(p)
  return ((0..<p.dim).map { v.data[1 << $0] }, v.data[e0Bit(p.dim)])
}

/// A finite point as the tuple it is.
func pointCoords(_ p: Pga) -> [Expr] {
  let (coords, w) = pointParts(p)
  return coords.map { div($0, w) }
}

/// The squared size of the part without e0: what a flat normalises by.
func euclideanNormSq(_ a: Pga) -> Expr {
  let e0 = e0Bit(a.dim)
  return a.data.enumerated().reduce(ZERO) { s, item in
    item.offset & e0 != 0 || isZero(item.element) ? s : add(s, mul(item.element, item.element))
  }
}

/// The direction of a line, of the plane or of space: where it meets the
/// ideal plane (line) e0, read as a vector. For join(A, B) it is B − A.
func lineDirection(_ l: Pga) throws -> [Expr] {
  let ideal = try outerPga(l, fromEntries(l.dim, [(e0Bit(l.dim), .num(1))]))
  // The sign that makes join(A, B) run from A to B.
  return pointParts(ideal).coords.map { l.dim == 3 ? neg($0) : $0 }
}

/// A hyperplane's normal (a, b[, c]) and offset d, for a x + b y + c z + d = 0.
func hyperplaneParts(_ p: Pga) -> (normal: [Expr], offset: Expr) {
  ((0..<p.dim).map { p.data[1 << $0] }, p.data[e0Bit(p.dim)])
}

/// The point of a flat nearest the origin: the origin projected onto it.
func nearestOrigin(_ flat: Pga) throws -> Pga {
  try project(pointPga([Expr](repeating: ZERO, count: flat.dim)), flat)
}

/// X ↦ M X M̃: a motor moving X, or a flat reflecting it (up to sign).
func sandwich(_ m: Pga, _ x: Pga) throws -> Pga { try geometricPga(geometricPga(m, x), reversePga(m)) }

/// ⟨b b̃⟩₀: |b|² for a plane or a line, its weight squared for a point.
private func selfProduct(_ b: Pga) throws -> Expr { try geometricPga(b, reversePga(b)).data[0] }

/// a projected onto b: (a · b) b̃ / ⟨b b̃⟩₀ — the point of a line nearest a
/// point, the shadow of a line on a plane, the plane through a point
/// parallel to a plane.
func project(_ a: Pga, _ b: Pga) throws -> Pga {
  scalePga(try geometricPga(innerPga(a, b), reversePga(b)), div(.num(1), try selfProduct(b)))
}

/// a reflected in b: b a b̃ / ⟨b b̃⟩₀. A point reflected in a point, line or
/// plane is the point; a flat comes back the same set, its orientation aside.
func reflect(_ a: Pga, _ b: Pga) throws -> Pga {
  scalePga(try sandwich(b, a), div(.num(1), try selfProduct(b)))
}

/// The pseudoscalar I, the blade of every bit.
private func pseudoscalar(_ dim: Int) -> Pga { fromEntries(dim, [(size(dim) - 1, .num(1))]) }

private func euclidSum(_ cs: [Expr]) -> Expr { cs.reduce(ZERO) { s, c in add(s, mul(c, c)) } }

/// e^B for a bivector B: the motor that screws about B's line. B's
/// Euclidean part (no e0) squares to −a², a its size; the rest of B² is a
/// multiple π I of the pseudoscalar, zero for a simple B and always in the
/// plane. With I² = 0, a + δI (δ = −π/2a) behaves as a dual number, so
///   e^B = cos a + sinc(a) B + (π/2)(sinc(a) I + h(a) B I),
/// h(a) = (sin a − a cos a)/a³, which tends to 1/3 as a → 0. With no
/// Euclidean part, B is a translation and e^B = 1 + B.
func expPga(_ b: Pga) throws -> Pga {
  let dim = b.dim
  let e0 = e0Bit(dim)
  let biv = gradePartPga(b, 2)
  if b.data.enumerated().contains(where: { k, c in !isZero(c) && popcount(k) != 2 }) {
    throw LanguageError("e^ takes a bivector of the projective algebra: a line, scaled by half the turn.")
  }
  let euclid = biv.data.enumerated().filter { k, c in k & e0 == 0 && !isZero(c) }.map(\.element)
  let one = fromEntries(dim, [(0, .num(1))])
  if euclid.isEmpty { return addPga(one, biv) }
  let a: Expr = euclid.count == 1 ? .call("abs", [euclid[0]]) : .call("sqrt", [euclidSum(euclid)])
  let sinc = Expr.call("sinc", [a])
  var out = addPga(fromEntries(dim, [(0, .call("cos", [a]))]), scalePga(biv, sinc))
  let pi = dim == 3 ? try geometricPga(biv, biv).data[size(dim) - 1] : ZERO
  if !isZero(pi) {
    let h = hOf(a)
    let i = pseudoscalar(dim)
    let dual = addPga(scalePga(i, sinc), scalePga(try geometricPga(biv, i), h))
    out = addPga(out, scalePga(dual, div(pi, .num(2))))
  }
  return out
}

/// What a flat of a given grade is, in the plane or in space.
func flatName(_ dim: Int, _ grade: Int) -> String? {
  if grade == MOTOR { return "motor" }
  if dim == 2 { return grade == 1 ? "line" : grade == 2 ? "point" : nil }
  return grade == 1 ? "plane" : grade == 2 ? "line" : grade == 3 ? "point" : nil
}

/// The internal call a flat travels in, from lowering to classify: its
/// dimension, its grade, then its coefficients. As a call, a list in a
/// coefficient broadcasts over it like any other.
let PGA_CALL = "[pga]"

func flatNode(_ f: Flat) -> Expr {
  .call(PGA_CALL, [.num(Double(f.dim)), .num(Double(f.grade))] + f.data + (f.slide ?? []))
}

func flatOfNode(_ e: Expr) -> Flat? {
  guard case .call(PGA_CALL, let args) = e, args.count >= 2 else { return nil }
  guard case .num(let dimValue) = args[0], case .num(let grade) = args[1] else { return nil }
  let dim = Int(dimValue)
  let end = 2 + size(dim)
  guard args.count >= end else { return nil }
  return Flat(
    dim: dim, data: Array(args[2..<end]), grade: Int(grade), slide: args.count > end ? Array(args[end...]) : nil)
}

func isPoint(_ f: Flat) -> Bool { f.grade == f.dim }

/// What draws a flat, as an ordinary row would write it: a point its tuple
/// (an ideal one divides by 0 and draws nothing), a line of the plane or a
/// plane its implicit equation, a line of space the curve where two planes
/// through it cross. The two planes hold the line and the axis least along
/// it, and the direction perpendicular to both, so they never coincide.
func flatFigure(_ f: Flat) throws -> Expr {
  let xyz = ["x", "y", "z"].prefix(f.dim).map { Expr.var($0) }
  // Every coordinate stays in a flat of space, even times a 0: a line of
  // space whose equations had lost z would read as a point of the plane.
  func term(_ c: Expr, _ k: Int) -> Expr { f.dim == 3 ? .bin(.mul, c, xyz[k]) : mul(c, xyz[k]) }
  func zeroEq(_ p: Pga) -> Expr {
    let (normal, offset) = hyperplaneParts(p)
    return normal.enumerated().reduce(offset) { s, item in
      f.dim == 3 ? .bin(.add, s, term(item.element, item.offset)) : add(s, term(item.element, item.offset))
    }
  }
  if f.grade == MOTOR { return try flatFigure(motorAxis(f)) }
  if isPoint(f) { return .vec(pointCoords(f)) }
  if f.grade == 1 { return .eq(zeroEq(f), ZERO) }
  // The axis d is least along: x when |d_x| is at most |d_y| and |d_z|,
  // else y when |d_y| is at most |d_z|, else z.
  let abs = try lineDirection(f).map { Expr.call("abs", [$0]) }
  func pick(_ conds: [(Expr, Expr)], _ k: Double) -> Expr {
    conds.reversed().reduce(.num(k)) { inner, pair in
      .piecewise([Expr.Case(cond: .ineq(.le, pair.0, pair.1), value: inner)], otherwise: ZERO)
    }
  }
  let ax = pick([(abs[0], abs[1]), (abs[0], abs[2])], 1)
  let ay = mul(sub(.num(1), ax), pick([(abs[1], abs[2])], 1))
  let axis = [ax, ay, sub(sub(.num(1), ax), ay)]
  let first = try regressivePga(f, idealPointPga(axis))
  let normal = hyperplaneParts(first).normal
  let second = try regressivePga(f, idealPointPga(normal))
  return .eq(.vec([zeroEq(first), zeroEq(second)]), .vec([ZERO, ZERO]))
}

/// `2x - y + 1`: a linear form from its coefficients, zero terms left out.
private func linearText(_ terms: [(Double, String)], _ constant: Double, _ format: (Double) -> String) -> String {
  var out = ""
  func push(_ value: Double, _ name: String) {
    if value == 0 { return }
    let mag = abs(value)
    let body = name.isEmpty ? format(mag) : mag == 1 ? name : "\(format(mag))\(name)"
    out += out.isEmpty ? (value < 0 ? "-\(body)" : body) : value < 0 ? " - \(body)" : " + \(body)"
  }
  for (value, name) in terms { push(value, name) }
  push(constant, "")
  return out.isEmpty ? "0" : out
}

private func readNum(_ e: Expr) -> Double {
  if case .num(let value) = e { return value }
  return .nan
}

/// A flat read out from its coefficients' values: a point as (x, y), or `at
/// infinity, direction (1, 2)` when its weight is 0; a line of the plane as
/// y = m x + k (or x = k); a plane as z = … (or y = …, x = …); a line of
/// space by its point nearest the origin and its direction. Rounding leaves
/// 1e-17 where a coefficient cancels: a value that small beside the largest
/// is zero.
func flatText(dim: Int, grade: Int, _ values: [Double], _ format: (Double) -> String) throws -> String {
  let floor = 1e-12 * JS.max([0] + values.map { abs($0) }.filter(\.isFinite))
  let clean = values.map { abs($0) <= floor ? 0 : $0 }
  if clean.contains(where: { !$0.isFinite }) { return "undefined" }
  if clean.allSatisfy({ $0 == 0 }) { return "undefined" }
  let flat = Flat(dim: dim, data: clean.map { .num($0) }, grade: grade)
  if grade == MOTOR { return try motorText(flat, format) }
  func tuple(_ vs: [Double]) -> String {
    "(\(vs.map { $0 < 0 ? "-\(format(-$0))" : format($0) }.joined(separator: ", ")))"
  }
  func small(_ vs: [Double]) -> [Double] {
    let top = JS.max(vs.map { abs($0) })
    return vs.map { abs($0) <= 1e-12 * top ? 0 : $0 }
  }
  if isPoint(flat) {
    let (coords, w) = pointParts(flat)
    let c = coords.map(readNum)
    if readNum(w) == 0 {
      // A direction has no size: scaled so its first component is 1.
      let lead = c.first { $0 != 0 } ?? 1
      return "at infinity, direction \(tuple(small(c.map { $0 / lead })))"
    }
    return tuple(c.map { $0 / readNum(w) })
  }
  if grade == 1 {
    let (normal, offset) = hyperplaneParts(flat)
    let n = normal.map(readNum)
    let d = readNum(offset)
    let names = Array(["x", "y", "z"].prefix(dim))
    // Solve for the last axis the normal has: z = …, then y = …, then x = ….
    guard let k = n.lastIndex(where: { $0 != 0 }) else { return "at infinity" }
    let terms = (0..<k).map { j in (-n[j] / n[k], names[j]) }
    return "\(names[k]) = \(linearText(terms, -d / n[k], format))"
  }
  let dir = small(try lineDirection(flat).map(readNum))
  if dir.allSatisfy({ $0 == 0 }) { return "at infinity" }
  let at = small(pointCoords(try nearestOrigin(flat)).map(readNum))
  return "through \(tuple(at)), direction \(tuple(dir))"
}

private func sqrtOf(_ e: Expr) -> Expr { .call("sqrt", [e]) }
private func dotOf(_ u: [Expr], _ v: [Expr]) -> Expr { zip(u, v).reduce(ZERO) { s, p in add(s, mul(p.0, p.1)) } }

/// |u × v|: of 2D vectors the size of their 2D cross product.
private func crossSize(_ u: [Expr], _ v: [Expr]) -> Expr {
  if u.count == 2 { return .call("abs", [sub(mul(u[0], v[1]), mul(u[1], v[0]))]) }
  let c = (0..<3).map { k in sub(mul(u[(k + 1) % 3], v[(k + 2) % 3]), mul(u[(k + 2) % 3], v[(k + 1) % 3])) }
  return sqrtOf(dotOf(c, c))
}

/// `cond ? yes : no`, where cond is `l > r`.
private func above(_ l: Expr, _ r: Expr, _ yes: Expr, _ no: Expr) -> Expr {
  .piecewise([Expr.Case(cond: .ineq(.gt, l, r), value: yes)], otherwise: no)
}

/// Whether a flat's sizes say it is ideal, relative to the sizes it came from.
private let PARALLEL = 1e-18

/// The direction a flat runs in that an angle is measured by: a line's
/// direction, a hyperplane's normal.
private func heading(_ f: Flat) throws -> [Expr] {
  try f.grade == 1 ? hyperplaneParts(f).normal : lineDirection(f)
}

/// The distance between two flats, one of which may be a point: from a
/// point, the size of its join with the other over both weights; between
/// skew lines of space, |L ∨ M| over |d × e|; between flats that cross, 0,
/// and between parallel ones the distance from the first's point nearest
/// the origin to the second.
func flatDistance(_ a: Flat, _ b: Flat) throws -> Expr {
  if isPoint(b) && !isPoint(a) { return try flatDistance(b, a) }
  if isPoint(a) {
    if isPoint(b) {
      let (p, q) = (pointCoords(a), pointCoords(b))
      return sqrtOf(zip(p, q).reduce(ZERO) { s, c in add(s, mul(sub(c.0, c.1), sub(c.0, c.1))) })
    }
    let w = Expr.call("abs", [weight(a)])
    let j = try regressivePga(a, b)
    // A hyperplane: the join is a number. A line of space: a plane, by its size.
    let size = b.grade == 1 ? Expr.call("abs", [j.data[0]]) : sqrtOf(euclideanNormSq(j))
    return div(size, mul(w, sqrtOf(euclideanNormSq(b))))
  }
  let apart = try flatDistance(nearestOrigin(a).graded(a.dim), b)
  if a.dim == 3 && a.grade == 2 && b.grade == 2 {
    let (d, e) = (try lineDirection(a), try lineDirection(b))
    let sin = crossSize(d, e)
    let skew = div(.call("abs", [try regressivePga(a, b).data[0]]), sin)
    return above(mul(sin, sin), mul(.num(PARALLEL), mul(dotOf(d, d), dotOf(e, e))), skew, apart)
  }
  // Two flats that are not both lines of space meet in something finite
  // unless they are parallel.
  let m = try outerPga(a, b)
  return above(euclideanNormSq(m), mul(.num(PARALLEL), mul(euclideanNormSq(a), euclideanNormSq(b))), ZERO, apart)
}

/// The acute angle between two lines or planes, 0 to π/2: between their
/// directions or normals, and from π/2 down for a line and a plane.
func flatAngle(_ a: Flat, _ b: Flat) throws -> Expr {
  let (u, v) = (try heading(a), try heading(b))
  let between = Expr.call("atan2", [crossSize(u, v), .call("abs", [dotOf(u, v)])])
  // A line of space against a plane: the normal's angle, turned to the plane's.
  let mixed = a.dim == 3 && a.grade != b.grade
  return mixed ? sub(.num(Double.pi / 2), between) : between
}

/// The grade a motor travels under in a `[pga]` node: it has no single
/// grade (it is even — a number, a bivector and, in space, I), so it is
/// tagged apart from points, lines and planes.
let MOTOR = -1

/// The motor that turns by `turn` about `axis` — a line of space or a point
/// of the plane — counterclockwise in the plane, and in space right-handed
/// about the axis's direction (join(A, B)'s A → B) while sliding `slide`
/// along it. For a unit line L̂ (L̂² = −1) e^(θ/2 L̂) is cos(θ/2) + sin(θ/2) L̂
/// exactly, and the slide is the product of two planes normal to the axis,
/// slide/2 apart; the two commute, being about one axis.
///
/// It is built homogeneously — scaled by |L| for each factor, rather than
/// dividing L by its size — since a motion is the same at any scale (M X M̃
/// scales X, which a point divides out): the coefficients stay a few dozen
/// nodes for an axis through draggable points. A unit motor, where one is
/// needed (log, slerp), is unitMotor of it.
func motorPga(_ axis: Pga, _ turnIn: Expr, _ slideIn: Expr = .num(0)) throws -> Flat {
  let (turn, slide) = (settle(turnIn), settle(slideIn))
  let size = axis.dim == 2 ? weight(axis) : sqrtOf(euclideanNormSq(axis))
  let half = div(turn, .num(2))
  // A unit point of the plane and a unit line of space turn opposite ways
  // under the sandwich at one sign.
  let sin = Expr.call("sin", [half])
  let turning = addPga(
    fromEntries(axis.dim, [(0, mul(size, .call("cos", [half])))]), scalePga(axis, axis.dim == 2 ? neg(sin) : sin))
  if axis.dim == 2 || isZero(slide) { return settlePga(turning).graded(MOTOR) }
  // Reflecting in dir·x = 0 and then in dir·x = slide |dir|/2 slides by slide along dir.
  let dir = try lineDirection(axis)
  let sliding = try geometricPga(hyperplane(dir, neg(div(mul(slide, size), .num(2)))), hyperplane(dir, ZERO))
  var out = settlePga(turning).graded(MOTOR)
  out.slide = sliding.data.map(settle)
  return out
}

/// A motor as one element of the algebra: its turn times its slide.
func motorOf(_ m: Flat) throws -> Pga {
  guard let slide = m.slide else { return m }
  return try geometricPga(m, Pga(dim: m.dim, data: slide))
}

/// A line or plane moved by a motor: slid, then turned. The sandwich is
/// linear in what it moves, so this is the sum of the blades' images, each
/// a sandwich of a constant, scaled by X's coefficients — rather than the
/// generic sandwich, which repeats the motor's coefficients in every product.
func moveFlat(_ m: Flat, _ x: Pga) throws -> Pga {
  func linear(_ r: Pga, _ at: Pga) throws -> Pga {
    var acc = zeroPga(r.dim)
    for (k, c) in at.data.enumerated() where !isZero(c) {
      let image = settlePga(try sandwich(r, fromEntries(r.dim, [(k, .num(1))])))
      acc = addPga(acc, scalePga(image, c))
    }
    return acc
  }
  let slid = try m.slide.map { try linear(Pga(dim: m.dim, data: $0), x) } ?? x
  return try linear(m, slid)
}

/// A motor scaled to M M̃ = 1.
func unitMotor(_ m: Pga) throws -> Pga {
  scalePga(m, div(.num(1), sqrtOf(try geometricPga(m, reversePga(m)).data[0])))
}

/// sin(a)/a's companion h(a) = (sin a − a cos a)/a³, which tends to 1/3.
private func hOf(_ a: Expr) -> Expr {
  .piecewise(
    [
      Expr.Case(
        cond: .ineq(.gt, a, .num(1e-3)),
        value: div(sub(.call("sin", [a]), mul(a, .call("cos", [a]))), mul(a, mul(a, a))))
    ], otherwise: sub(.num(1.0 / 3), div(mul(a, a), .num(30))))
}

/// The bivector B with e^B = M, for a unit motor M — the inverse of expPga,
/// taking the shorter way round (M and −M move alike, so M is turned to a
/// non-negative scalar part first, and the half-angle a stays in [0, π/2]).
/// From M = cos a + sinc(a) B + (π/2)(sinc(a) I + h(a) B I): a from the
/// scalar part, π from the I part, B's Euclidean part from the bivector's,
/// and its ideal part once B_E I is taken out.
func logMotor(_ motor: Pga) throws -> Pga {
  let m = try unitMotor(motor)
  let dim = m.dim
  let e0 = e0Bit(dim)
  let side = Expr.piecewise([Expr.Case(cond: .ineq(.lt, m.data[0], ZERO), value: .num(-1))], otherwise: .num(1))
  let turned = scalePga(m, side)
  let a = Expr.call("acos", [.call("min", [turned.data[0], .num(1)])])
  let sinc = Expr.call("sinc", [a])
  let biv = gradePartPga(turned, 2)
  let euclid = Pga(dim: dim, data: biv.data.enumerated().map { k, c in k & e0 != 0 ? ZERO : div(c, sinc) })
  var ideal = Pga(dim: dim, data: biv.data.enumerated().map { k, c in k & e0 != 0 ? c : ZERO })
  if dim == 3 {
    let pi = div(mul(.num(2), turned.data[size(dim) - 1]), sinc)
    let dual = try geometricPga(euclid, pseudoscalar(dim))
    ideal = addPga(ideal, scalePga(dual, mul(div(pi, .num(2)), hOf(a))), minus: true)
  }
  return addPga(euclid, scalePga(ideal, div(.num(1), sinc)))
}

/// The rigid motion u of the way from a to b: a e^(u log(ã b)), along the
/// screw that carries one to the other, at constant speed.
///
/// While a named value is lowered, a frame-constant coefficient can become a
/// hidden constant of its own (Definitions.swift `hoist`): `held` is handed
/// the intermediates — the unit motors, their relative motor and its log —
/// so each step multiplies names rather than formulas. (The TypeScript keeps
/// the hoister in a module variable for one lowering, `withHoisting`; here
/// the lowering's context carries it, so two documents can lower at once.)
func slerpMotor(_ a: Flat, _ b: Flat, _ u: Expr, hoist: ((Expr) -> Expr)? = nil) throws -> Flat {
  func held(_ a: Pga) -> Pga {
    guard let hoist else { return a }
    return Pga(dim: a.dim, data: a.data.map(hoist), grade: a.grade, slide: a.slide)
  }
  let ma = held(settlePga(try unitMotor(motorOf(a))))
  let mb = held(settlePga(try unitMotor(motorOf(b))))
  let relative = held(settlePga(try geometricPga(reversePga(ma), mb)))
  // The log repeats its argument's coefficients many times over: only a
  // modest one (a fixed axis, a slider or t in the turn) is taken.
  if exceedsNodes(.vec(relative.data), SLERP_NODES / 16) { throw LanguageError(SLERP_TOO_LARGE) }
  let step = held(settlePga(try logMotor(relative)))
  let out = settlePga(try geometricPga(ma, expPga(scalePga(step, u))))
  if exceedsNodes(.vec(out.data), SLERP_NODES) { throw LanguageError(SLERP_TOO_LARGE) }
  return out.graded(MOTOR)
}

/// What a motor screws about, from its bivector part B = sinc(a) B_E + (the
/// ideal part, which also holds the slide as a multiple of B_E I): in space
/// B with that multiple taken out — the moment of a line is perpendicular to
/// its direction, so what is left is the axis — and in the plane B itself, a
/// point (ideal for a translation, which has no centre). Unlike the log this
/// needs no normalising, so it stays small.
func motorAxis(_ m: Pga) throws -> Flat {
  let b = gradePartPga(m, 2)
  if m.dim == 2 { return b.graded(2) }
  let e0 = e0Bit(m.dim)
  let euclid = Pga(dim: m.dim, data: b.data.enumerated().map { k, c in k & e0 != 0 ? ZERO : c })
  let dual = try geometricPga(euclid, pseudoscalar(m.dim))
  func dot(_ x: Pga, _ y: Pga) -> Expr { zip(x.data, y.data).reduce(ZERO) { acc, p in add(acc, mul(p.0, p.1)) } }
  return addPga(b, scalePga(dual, div(dot(b, dual), dot(dual, dual))), minus: true).graded(2)
}

/// A motor read out from its values by what it does: in the plane `turn θ
/// about (x, y)` (counterclockwise positive) or `slide (dx, dy)`; in space
/// `turn θ about the line through …, direction …, slide s`, θ from 0 to π
/// right-handed about that direction — a motor and its negative are one
/// motion, read the shorter way round — or `slide (dx, dy, dz)`.
private func motorText(_ motor: Flat, _ format: (Double) -> String) throws -> String {
  let m = try motorOf(motor).graded(MOTOR)
  // (A coefficient that divides by zero is not a number, as on the site.)
  func read(_ e: Expr) -> Double { (try? evaluate(e, [:])) ?? .nan }
  func signedText(_ v: Double) -> String { v < 0 ? "-\(format(-v))" : format(v) }
  func tuple(_ vs: [Double]) -> String { "(\(vs.map(signedText).joined(separator: ", ")))" }
  func move(_ p: [Double]) throws -> [Double] {
    pointCoords(try moveFlat(motor, pointPga(p.map { .num($0) }))).map(read)
  }
  func tidy(_ vs: [Double]) -> [Double] { vs.map { abs($0) < 1e-12 ? 0 : $0 } }
  let axis = try motorAxis(m)
  let origin = [Double](repeating: 0, count: m.dim)
  func slideBy() throws -> String {
    let d = tidy(try move(origin))
    return d.allSatisfy { $0 == 0 } ? "no motion" : "slide \(tuple(d))"
  }
  if m.dim == 2 {
    let (coords, w) = pointParts(axis)
    if !(abs(read(w)) > 1e-12) { return try slideBy() }
    let c = coords.map { read($0) / read(w) }
    let q = try move([c[0] + 1, c[1]])
    return "turn \(signedText(atan2(q[1] - c[1], q[0] - c[0]))) about \(tuple(tidy(c)))"
  }
  let dir = try lineDirection(axis).map(read)
  let len = jsHypot(dir)
  if !(len > 1e-12) { return try slideBy() }
  let u = dir.map { $0 / len }
  let p = pointCoords(try nearestOrigin(axis)).map(read)
  let moved = try move(p)
  let slide = (0..<3).reduce(0.0) { acc, k in acc + (moved[k] - p[k]) * u[k] }
  // A unit vector across the axis, and where the turn takes it.
  let mags = u.map { abs($0) }
  let least = mags.firstIndex(of: JS.min(mags)) ?? 0
  let e = (0..<3).map { $0 == least ? 1.0 : 0.0 }
  func cross(_ a: [Double], _ b: [Double]) -> [Double] {
    (0..<3).map { k in a[(k + 1) % 3] * b[(k + 2) % 3] - a[(k + 2) % 3] * b[(k + 1) % 3] }
  }
  let across = cross(u, e)
  let acrossLen = jsHypot(across)
  let v = across.map { $0 / acrossLen }
  let carried = try move((0..<3).map { p[$0] + v[$0] })
  let w = (0..<3).map { carried[$0] - p[$0] - slide * u[$0] }
  let vw = cross(v, w)
  let turn = atan2(
    (0..<3).reduce(0.0) { acc, k in acc + vw[k] * u[k] }, (0..<3).reduce(0.0) { acc, k in acc + v[k] * w[k] })
  let about = "the line through \(tuple(tidy(p))), direction \(tuple(tidy(u)))"
  let along = abs(slide) > 1e-12 ? ", slide \(signedText(slide))" : ""
  return "turn \(signedText(turn)) about \(about)\(along)"
}

/// The point `coords` moved by the motor m, as its coordinates. The
/// sandwich is linear in what it moves, and a point is linear in its
/// coordinates — J(x e_x + y e_y + z e_z + e0) — so this is m O m̃ plus
/// x m E_x m̃ + …, where O is the origin and E_x the ideal point along x:
/// sandwiches of constants only, quadratic in m's coefficients. The generic
/// sandwich of a symbolic point repeats m's coefficients in every product,
/// which for a motor about a draggable axis runs to tens of thousands of nodes.
func movePoint(_ m: Flat, _ coords: [Expr]) throws -> [Expr] {
  let zero = coords.map { _ in ZERO }
  // The slide is a translation a + b_k e_k0 (motorPga's two planes): it
  // moves every point by 2 b / a.
  var at = coords
  if let slide = m.slide {
    at = coords.enumerated().map { k, c in
      add(c, div(mul(.num(2), slide[(1 << k) | e0Bit(m.dim)]), slide[0]))
    }
  }
  let origin = pointParts(settlePga(try sandwich(m, pointPga(zero))))
  let columns = try at.indices.map { j in
    pointParts(settlePga(try sandwich(m, idealPointPga(zero.indices.map { $0 == j ? .num(1) : ZERO })))).coords
  }
  // A motion keeps every point's weight, so all divide by the origin's.
  return origin.coords.enumerated().map { i, o in
    div(at.enumerated().reduce(o) { acc, item in add(acc, mul(item.element, columns[item.offset][i])) }, origin.weight)
  }
}

/// A coefficient with nothing left to vary — `cos(pi/4) 2`, a motor about a
/// fixed axis — as the number it is. Products of motors otherwise keep every
/// cos and sqrt of a constant as a tree, and the log of a motor (acos, sinc,
/// a piecewise) multiplies them past any useful size.
private func settle(_ e: Expr) -> Expr {
  switch e {
  case .num, .var: return e
  default: break
  }
  guard let v = try? evaluate(e, [:]), v.isFinite else { return e }
  return .num(v)
}

private func settlePga(_ a: Pga) -> Pga {
  Pga(dim: a.dim, data: a.data.map(settle), grade: a.grade, slide: a.slide)
}

/// How large a slerp of motors may grow before it is refused: one about
/// axes through draggable points, rather than fixed ones.
private let SLERP_NODES = 1 << 15
private let SLERP_TOO_LARGE =
  "slerp of motors takes two that stay fixed — fixed axes, turns and slides — and varies how far along: "
  + "slerp(M1, M2, (1 - cos(t))/2)."
