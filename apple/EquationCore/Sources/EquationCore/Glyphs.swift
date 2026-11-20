#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

/// Glyphs: values with no position of their own, drawn as the figures that
/// show what they are (lib/glyphs.ts).
///
/// The picture of a multivector, grade by grade (docs/clifford.md): its vector
/// an arrow from the origin; its bivector an oriented disc of that area in its
/// plane, with an arrow round the rim for its sense of turn; its trivector a
/// cube of that volume. Each is an ordinary figure, so every renderer that
/// draws figures draws these.

private func figure(_ form: FigureForm, _ dimension: Int, _ points: [[Expr]]) -> Expr {
  .figure(form: form, dimension: dimension, vertices: points.flatMap { $0 })
}

/// Vertices round the rim; how far round the arrow of turn goes, and how
/// far in from the rim it runs, so it reads apart from the outline.
private let RIM = 48
private let TURN = 0.75
private let INSET = 0.6

/// The columns an arc runs over: not names a document can write.
private let ARC_COS = "eqioArcCos"
private let ARC_SIN = "eqioArcSin"

/// The arc r (cos θ e1 + sin θ e2), θ from 0 to 2π·share in `steps` steps
/// (a closed rim leaves out its repeated last point), as ONE vertex template
/// run over columns of cos θ and sin θ: e1, e2 and r may be large — a slerp's
/// coefficients — and are then written once, not once per vertex.
private func arc(
  _ form: FigureForm, _ dimension: Int, _ r: Expr, _ e1: [Expr], _ e2: [Expr], _ share: Double, _ steps: Int,
  _ sense: Expr = .num(1)
) -> Expr {
  let count = form == .polygon ? steps : steps + 1
  func angle(_ k: Int) -> Double { (2 * Double.pi * share * Double(k)) / Double(steps) }
  let over = [
    Column(name: ARC_COS, values: (0..<count).map { cos(angle($0)) }),
    Column(name: ARC_SIN, values: (0..<count).map { sin(angle($0)) }),
  ]
  let c = Expr.var(ARC_COS)
  let s = mul(sense, .var(ARC_SIN))
  return .figure(
    form: form, dimension: dimension,
    vertices: zip(e1, e2).map { a, b in mul(r, add(mul(c, a), mul(s, b))) }, over: over)
}

/// A right-handed orthonormal pair spanning the plane normal to the unit
/// vector n, in closed form (Duff et al., "Building an orthonormal basis,
/// revisited", 2017): e1 × e2 = n with no branch but the sign of n_z.
private func planeBasis(_ n: [Expr]) -> ([Expr], [Expr]) {
  let (x, y, z) = (n[0], n[1], n[2])
  let s = Expr.piecewise([Expr.Case(cond: .ineq(.lt, z, .num(0)), value: .num(-1))], otherwise: .num(1))
  let a = div(.num(-1), add(s, z))
  let b = mul(mul(x, y), a)
  return (
    [add(.num(1), mul(mul(s, mul(x, x)), a)), mul(s, b), neg(mul(s, x))],
    [b, add(s, mul(mul(y, y), a)), neg(y)]
  )
}

/// The internal call `action(M)` lowers to: its size, then its entries
/// row-major. Classify draws it with actionGlyphs and reads the matrix out.
let ACTION_CALL = "[action]"

func actionNode(_ m: Mat) -> Expr { .call(ACTION_CALL, [.num(Double(m.count))] + m.flatMap { $0 }) }

func actionOfNode(_ e: Expr) -> Mat? {
  guard case .call(ACTION_CALL, let args) = e, let first = args.first else { return nil }
  var n = 0
  if case .num(let value) = first { n = Int(value) }
  return (0..<n).map { i in Array(args[(1 + i * n)..<(1 + (i + 1) * n)]) }
}

/// What a matrix does, drawn: the image of the unit square (a filled
/// parallelogram, whose signed area is det M) or cube, of the unit circle (an
/// ellipse, its axes the singular vectors), and the arrows M e_x, M e_y
/// (and M e_z) — the columns.
func actionGlyphs(_ m: Mat) -> [Expr] {
  let n = m.count
  func col(_ j: Int) -> [Expr] { m.map { $0[j] } }
  let origin = [Expr](repeating: .num(0), count: n)
  func sum(_ vs: [[Expr]]) -> [Expr] {
    vs.reduce(origin) { acc, v in zip(acc, v).map { add($0, $1) } }
  }
  var out: [Expr] = []
  if n == 2 {
    out.append(figure(.polygon, 2, [origin, col(0), sum([col(0), col(1)]), col(1)]))
    let circle = (0...RIM).map { k -> [Expr] in
      let th = (2 * Double.pi * Double(k)) / Double(RIM)
      return m.map { row in add(mul(row[0], .num(cos(th))), mul(row[1], .num(sin(th)))) }
    }
    out.append(.figure(form: .polyline, dimension: 2, vertices: circle.flatMap { $0 }))
  } else {
    var corners: [[Expr]] = []
    for a in [0, 1] {
      for b in [0, 1] {
        for c in [0, 1] {
          corners.append(sum([a, b, c].enumerated().compactMap { j, on in on != 0 ? col(j) : nil }))
        }
      }
    }
    out.append(figure(.hull, 3, corners))
  }
  for j in 0..<n { out.append(figure(.vector, n, [origin, col(j)])) }
  return out
}

private let SWEEP_F = "eqioSweepF"
private let SWEEP_R = "eqioSweepR"

/// A sweep through `angle` (radians, either sign) of the circle of radius r
/// in the plane of e1, e2, as one template over the fraction of the sweep: a
/// `sector` starts at the centre, so the polygon fills the wedge. The angle
/// may be any expression — a quaternion's, which moves with its sliders.
private func sweep(
  _ form: FigureForm, _ dimension: Int, _ r: Expr, _ e1: [Expr], _ e2: [Expr], _ angle: Expr, _ steps: Int,
  sector: Bool = false
) -> Expr {
  let n = steps + 1 + (sector ? 1 : 0)
  let over = [
    Column(name: SWEEP_F, values: (0..<n).map { Double(max(0, $0 - (sector ? 1 : 0))) / Double(steps) }),
    Column(name: SWEEP_R, values: (0..<n).map { sector && $0 == 0 ? 0 : 1 }),
  ]
  let th = mul(.var(SWEEP_F), angle)
  let rr = mul(.var(SWEEP_R), r)
  let c = Expr.call("cos", [th])
  let sn = Expr.call("sin", [th])
  return .figure(
    form: form, dimension: dimension,
    vertices: zip(e1, e2).map { a, b in mul(rr, add(mul(c, a), mul(sn, b))) }, over: over)
}

/// A quaternion or a rotor — a scalar and a bivector — drawn as the rotation
/// it makes in R v R̃: q = w + v turns by θ = 2 atan2(|v|, w) about v, so the
/// picture is an arrow along the axis, |q| long, and a filled sector of
/// radius |q| sweeping θ with an arrow for the turn. Moving w moves θ, which
/// a disc of the bivector alone could not show. Nil when the multivector is
/// not one: an odd part, no bivector, or no scalar (a pure bivector is an
/// oriented area, drawn as one — unless it was written as a quaternion).
private func rotationGlyphs(_ m: Multivector) -> [Expr]? {
  let odd = m.data.enumerated().contains { k, c in bladeGrade(k) % 2 == 1 && !isZero(c) }
  guard let bivector = glyphParts(m).bivector, !odd, !(isZero(m.data[0]) && !m.quat) else { return nil }
  let w = m.data[0]
  let size = Expr.call("sqrt", [normSquared(m)])
  let steps = Int((Double(RIM) * 0.75).rounded())
  switch bivector {
  case .plane(let plane):
    // R = cos(θ/2) − sin(θ/2) e_xy turns the plane by θ counterclockwise.
    let angle = mul(.num(2), .call("atan2", [neg(plane), w]))
    let e1: [Expr] = [.num(1), .num(0)]
    let e2: [Expr] = [.num(0), .num(1)]
    return [
      sweep(.polygon, 2, size, e1, e2, angle, steps, sector: true),
      sweep(.vector, 2, mul(.num(1.12), size), e1, e2, angle, steps),
    ]
  case .normal(let normal):
    // The quaternion's vector part is minus the bivector's dual (i = e_zy).
    let v = normal.map(neg)
    let len = magnitude(v)
    let axis = v.map { div($0, len) }
    let (e1, e2) = planeBasis(axis)
    let angle = mul(.num(2), .call("atan2", [len, w]))
    return [
      sweep(.polygon, 3, size, e1, e2, angle, steps, sector: true),
      sweep(.vector, 3, mul(.num(1.12), size), e1, e2, angle, steps),
      figure(.vector, 3, [axis.map { _ in .num(0) }, axis.map { mul(size, $0) }]),
    ]
  }
}

/// The figures that draw a multivector: none for a plain number, which
/// classify reads out alone, and at least one for anything else.
func multivectorGlyphs(_ m: Multivector) -> [Expr] {
  if let turn = rotationGlyphs(m) { return turn }
  let (vector, bivector, trivector) = glyphParts(m)
  let dim = m.dim
  let origin = [Expr](repeating: .num(0), count: dim)
  var out: [Expr] = []
  switch bivector {
  case .plane(let b)?:
    // Area |b|: radius √(|b|/π). The rim arrow turns the way b does.
    let r = Expr.call("sqrt", [div(.call("abs", [b]), .num(Double.pi))])
    let e1: [Expr] = [.num(1), .num(0)]
    let e2: [Expr] = [.num(0), .num(1)]
    out.append(arc(.polygon, 2, r, e1, e2, 1, RIM))
    out.append(
      arc(.vector, 2, mul(.num(INSET), r), e1, e2, TURN, Int((Double(RIM) * TURN).rounded()), .call("sign", [b])))
  case .normal(let n)?:
    // In space the disc lies across its dual, turning counterclockwise
    // seen from the tip of the normal, which is the bivector's sense.
    let len = magnitude(n)
    let (e1, e2) = planeBasis(n.map { div($0, len) })
    let r = Expr.call("sqrt", [div(len, .num(Double.pi))])
    out.append(arc(.polygon, 3, r, e1, e2, 1, RIM))
    out.append(arc(.vector, 3, mul(.num(INSET), r), e1, e2, TURN, Int((Double(RIM) * TURN).rounded())))
  case nil:
    break
  }
  if let trivector {
    // A cube of volume |p|, centred on the origin.
    let h = div(pow(.call("abs", [trivector]), .num(1.0 / 3)), .num(2))
    var corners: [[Expr]] = []
    for sx in [-1.0, 1.0] {
      for sy in [-1.0, 1.0] {
        for sz in [-1.0, 1.0] { corners.append([sx, sy, sz].map { mul(.num($0), h) }) }
      }
    }
    out.append(figure(.hull, 3, corners))
  }
  if let vector { out.append(figure(.vector, dim, [origin, vector])) }
  return out
}
