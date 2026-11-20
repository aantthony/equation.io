/// Multivectors and the points, lines and planes of projective geometry
/// under geometry lowering (lib/geom.ts `lowerMv`, `lowerFlat` and what
/// `lower` and `lowerStatement` ask of them): each is expanded to the scalar
/// expressions of its coefficients before anything downstream looks.

/// The multivectors and flats one lowering has met (lib/geom.ts `mvSeen`,
/// `flatSeen`), and what it knows of where it is.
struct AlgebraSeen {
  /// A node under way is no multivector to itself, and one whose lowering
  /// threw stays none, as on the site.
  var mv: [Expr: Multivector?] = [:]
  var flat: [Expr: Flat?] = [:]
  /// Whether the node being lowered sits in a run of products, negations and
  /// calls already known to hold no multivector or flat (`mvIn`, `flatIn`):
  /// nearly every row, which then never asks again on the way down. (The
  /// TypeScript remembers the answer per node object, `mvMark`; a value has
  /// no identity to remember it by.)
  var clean = false
  /// Makes a frame-constant coefficient a hidden constant of the name being
  /// defined (lib/pga.ts `withHoisting`).
  var hoist: ((Expr) -> Expr)?
}

/// The calls that make or take multivectors (lib/clifford.ts).
private let MV_FNS: Set<String> = ["gp", "rev", "grade", "dual", "quat", "slerp", "vec", MV_CALL]

/// Whether a subtree holds a multivector at all: a blade, ⟑ or a multivector
/// function. Rows without one — nearly all — skip lowerMv entirely.
func mvIn(_ e: Expr) -> Bool {
  switch e {
  case .call(let name, let args): MV_FNS.contains(name) || args.contains(where: mvIn)
  case .bin(_, let a, let b, let glyph): glyph == .geometric || mvIn(a) || mvIn(b)
  case .neg(let a): mvIn(a)
  default: false
  }
}

/// The calls that make or take points, lines and planes of projective
/// geometry (lib/pga.ts). `line` is one only inside another expression: a
/// row of its own keeps drawing as the implicit line it always has.
private let FLAT_FNS: Set<String> = [
  "meet", "join", "plane", "project", "reflect", "line", "motor", "rotate", "slerp", PGA_CALL,
]

func flatIn(_ e: Expr) -> Bool {
  switch e {
  case .call(let name, let args): FLAT_FNS.contains(name) || args.contains(where: flatIn)
  case .bin(_, let a, let b, _): flatIn(a) || flatIn(b)
  case .neg(let a): flatIn(a)
  default: false
  }
}

private let NOT_A_MV_VALUE =
  "A multivector is not a number or a point here — grade(A, 1) is its vector part and |A| its size, "
  + "or give it a row of its own to draw it."
private let MOTOR_USAGE =
  "motor takes an axis and a turn: motor(L, th, d) turns by th about the line L of space and slides d along it; "
  + "motor(P, th) turns the plane about the point P."
private let JOIN_USAGE =
  "join takes points, or in space a point and a line: join(A, B) is the line through A and B, "
  + "join(A, B, C) the plane through three points."
private let MEET_USAGE =
  "meet takes two lines of the plane, or in space two planes or a line and a plane: "
  + "meet(L, M) is where they cross."
private let PLANE_USAGE =
  "plane takes three points of space — plane(A, B, C) — or a point and a normal: plane(P, n)."

private func isE(_ e: Expr) -> Bool {
  switch e {
  case .var("e"): true
  case .num(let value): value == 2.718281828459045
  default: false
  }
}

/// A whole-number power written out: n, or -n.
private func writtenNumber(_ e: Expr) -> Double {
  switch e {
  case .num(let value): value
  case .neg(.num(let value)): -value
  default: .nan
  }
}

/// What a flat is called in a message: "a line", "a plane", "a point".
private func aFlat(_ f: Flat) -> String { "a \(flatName(f.dim, f.grade) ?? "flat")" }

/// Whether a multivector — or a side that is none — is only a number or
/// only a vector, so mvValue can take it as that.
private func plainValue(_ m: Multivector?) -> Bool {
  guard let m else { return true }
  let grades = gradesOf(m)
  return grades.isEmpty || (grades.count == 1 && (grades.contains(0) || grades.contains(1)))
}

/// A multivector where a number or a point is wanted: fine when that is all
/// it is written as (e_x ⟑ e_x is 1, grade(A, 1) a vector), an error else.
private func mvValue(_ m: Multivector) throws -> Lowered {
  if !plainValue(m) { throw LanguageError(NOT_A_MV_VALUE) }
  if !gradesOf(m).contains(1) { return .scalar(m.data[0]) }
  return .vec((0..<m.dim).map { m.data[1 << $0] })
}

/// A flat where a number or a point is wanted: a point is its tuple, and
/// a line or plane is refused, saying what to do with it.
private func flatValue(_ f: Flat) throws -> Lowered {
  if isPoint(f) { return .vec(pointCoords(f)) }
  if f.grade == MOTOR {
    throw LanguageError(
      "A motor is not a number or a point here — rotate(X, M) moves X by it; "
        + "or give it a row of its own to draw its axis.")
  }
  // (The TypeScript's replace('a', 'A'): the first a, which is the article.)
  throw LanguageError(
    "A\(aFlat(f).dropFirst()) is not a number or a point here — meet(L, M) is where two cross, "
      + "distance(P, L) how far a point is from one; or give it a row of its own to draw it.")
}

extension GeomContext {
  /// Called as a node starts to lower: whether it is known to hold no
  /// multivector or flat. Returns what to put back when the node is done.
  func enterAlgebra(_ e: Expr) -> Bool {
    let outer = algebra.clean
    switch e {
    case .bin, .neg, .call:
      if !outer { algebra.clean = !(mvIn(e) || flatIn(e)) }
    default:
      algebra.clean = false
    }
    return outer
  }

  private func vector(_ v: Lowered) -> [Expr]? {
    if case .vec(let items) = v { return items }
    return nil
  }

  /// Before a node lowers as a number or a point (the head of `lower`). A
  /// point that projective geometry made is its tuple; a line or plane only
  /// goes where meet, join and the measures take it. A multivector — or a
  /// number or vector that one reduces to — comes before matrix algebra: its
  /// ⟑, ∧ and products are its own.
  func algebraValue(_ e: Expr) throws -> Lowered? {
    if algebra.clean { return nil }
    switch e {
    case .bin, .neg, .call: break
    default: return nil
    }
    if case .call(let name, let args) = e {
      if flatIn(e) {
        if let measured = try flatMeasure(name, args) { return measured }
        if let f = try lowerFlat(e) { return try flatValue(f) }
      }
      // rotate(P, R): the sandwich R P R⁻¹, as the matrix it is.
      if name == "rotate", args.count == 2, let r = try lowerMv(args[1]) {
        guard let p = vector(try lo(args[0])) else {
          throw LanguageError("rotate(P, R) turns a point P by a rotor or quaternion R.")
        }
        return .vec(matVec(try sandwichMatrix(r, p.count), p))
      }
    }
    if let m = try lowerMv(e) { return try mvValue(m) }
    return nil
  }

  /// Any value read as a multivector: a number is grade 0, a point grade 1.
  func anyMv(_ n: Expr) throws -> Multivector {
    if let m = try lowerMv(n) { return m }
    // Inside a multivector, a sum of a number and a vector is one too: in
    // 1 + e_x + e_xy the 1 + e_x is read before e_xy says what it is.
    if case .bin(let op, let a, let b, nil) = n, op == .add || op == .sub {
      return mvAdd(try anyMv(a), try anyMv(b), minus: op == .sub)
    }
    if case .neg(let a) = n { return mvNeg(try anyMv(a)) }
    switch try lo(n) {
    case .vec(let items): return try vectorMv(items)
    case .scalar(let e): return scalarMv(e)
    }
  }

  /// A multivector-valued expression, or nil: a blade (e_xy), quat(…), ⟑ and
  /// gp(…), and — once one side is a multivector — juxtaposition (the
  /// geometric product), ∧ (the outer product), +, −, division (by the
  /// inverse), whole powers, e^A, rev, dual, grade, slerp and |A|. Two plain
  /// vectors multiply as they always have: juxtaposition between them stays
  /// an error and ∧ the tensor wedge, so only ⟑ turns vectors into a
  /// multivector.
  func lowerMv(_ e: Expr) throws -> Multivector? {
    if !mvIn(e) { return nil }
    if let hit = algebra.mv[e] { return hit }
    algebra.mv[e] = .some(nil)
    let value = try mvOf(e).map { try sandwiched(e, $0) }
    algebra.mv[e] = .some(value)
    return value
  }

  private func mvOf(_ e: Expr) throws -> Multivector? {
    switch e {
    case .neg(let inner):
      return try lowerMv(inner).map(mvNeg)
    case .bin(let op, let lhs, let rhs, let glyph):
      if glyph == .geometric { return geometric(try anyMv(lhs), try anyMv(rhs)) }
      if op == .pow {
        if isE(lhs) { return try lowerMv(rhs).map(mvExp) }
        guard let a = try lowerMv(lhs) else { return nil }
        return try mvPower(a, writtenNumber(rhs))
      }
      let a = try lowerMv(lhs)
      let b = try lowerMv(rhs)
      if a == nil && b == nil { return nil }
      if glyph == .dot || glyph == .cross || glyph == .outer {
        // grade(a ⟑ b, 1) · (1, 0): a multivector that is only a number or a
        // vector takes these as that number or vector does, and 2 · e_xy
        // multiplies as 2 · 3 does.
        if plainValue(a) && plainValue(b) { return nil }
        if glyph == .dot, a == nil || b == nil, case .scalar(let n) = try lo(a != nil ? rhs : lhs) {
          return mvScale((a ?? b)!, n)
        }
        let sign = glyph == .dot ? "·" : glyph == .cross ? "×" : "⊗"
        throw LanguageError(
          "\(sign) does not take a multivector — ⟑ is the geometric product and ∧ the outer product.")
      }
      if glyph == .wedge { return outerMv(try anyMv(lhs), try anyMv(rhs)) }
      switch op {
      case .add, .sub:
        return mvAdd(try anyMv(lhs), try anyMv(rhs), minus: op == .sub)
      case .mul:
        // J grade(A, 1): a matrix applies to a multivector that is only a
        // vector, as J v does — lower() takes both as the values they are.
        if a == nil || b == nil, plainValue(a ?? b) {
          do {
            return geometric(try anyMv(lhs), try anyMv(rhs))
          } catch is LanguageError {
            return nil
          }
        }
        return geometric(try anyMv(lhs), try anyMv(rhs))
      case .div:
        // Dividing by a multivector is refused, as by a matrix: a/2e_xy
        // reads as a/(2e_xy), and e_xy⁻¹ = −e_xy would quietly flip it.
        let d = try anyMv(rhs)
        if !isScalar(d) {
          throw LanguageError(
            "Cannot divide by a multivector — multiply by B^-1. (a/2e_xy reads as a/(2e_xy): write a/2 e_xy.)")
        }
        return mvScale(try anyMv(lhs), div(.num(1), d.data[0]))
      case .pow:
        return nil
      }
    case .call(let name, let args):
      if name == MV_CALL { return mvOfNode(e) }
      func arity(_ n: Int, _ usage: String) throws {
        if args.count != n { throw LanguageError(usage) }
      }
      switch name {
      case "gp":
        if args.count < 2 { throw LanguageError("gp takes two or more multivectors: gp(a, b) is a ⟑ b.") }
        var acc = try anyMv(args[0])
        for n in args.dropFirst() { acc = geometric(acc, try anyMv(n)) }
        return acc
      case "rev":
        try arity(1, "rev takes one multivector: rev(R) reverses it, so R p rev(R) turns the point p.")
        return reverse(try anyMv(args[0]))
      case "dual":
        try arity(1, "dual takes one multivector: dual(e_xy) is e_z.")
        return dual(try anyMv(args[0]))
      case "conj":
        // conj of a multivector is its Clifford conjugate; of a number, the complex one.
        return try args.count == 1 ? lowerMv(args[0]).map(conjugate) : nil
      case "grade":
        try arity(2, "grade takes a multivector and a grade: grade(A, 2) is its bivector part.")
        let k = writtenNumber(args[1])
        if !JS.isInteger(k) {
          throw LanguageError("A grade is a whole number written out, like contract(T, 1, 2) or T[2].")
        }
        return try gradePart(try anyMv(args[0]), Int(k))
      case "vec":
        // A quaternion's vector part (x, y, z): the axis it turns about,
        // scaled by sin(θ/2). For any multivector, the vector of its
        // bivector part read as a quaternion's (i = e_zy, j = e_xz, k = e_yx).
        try arity(1, "vec takes one quaternion: vec(quat(w, x, y, z)) is the point (x, y, z).")
        return try vectorMv(Array(quaternionParts(try anyMv(args[0])).dropFirst()))
      case "quat":
        // quat(w, x, y, z), or quat(w, v) with v a 3-vector.
        let vals = try args.map(lo)
        let flat = vals.flatMap { v -> [Expr] in
          switch v {
          case .vec(let items): items
          case .scalar(let e): [e]
          }
        }
        if flat.count != 4 || (vals.count == 2 && vector(vals[1])?.count != 3) {
          throw LanguageError(
            "quat takes quat(w, x, y, z) — w + x i + y j + z k — or quat(w, v) with v a 3D vector.")
        }
        return quaternion(flat[0], flat[1], flat[2], flat[3])
      case "slerp":
        try arity(3, "slerp takes two rotors or quaternions and how far along: slerp(q1, q2, u), u from 0 to 1.")
        guard case .scalar(let u) = try lo(args[2]) else {
          throw LanguageError("slerp goes a number of the way from q1 to q2: slerp(q1, q2, u).")
        }
        return slerp(try anyMv(args[0]), try anyMv(args[1]), u)
      case "exp":
        return try args.count == 1 ? lowerMv(args[0]).map(mvExp) : nil
      case "abs":
        guard args.count == 1, let a = try lowerMv(args[0]) else { return nil }
        return scalarMv(.call("sqrt", [normSquared(a)]), a.dim)
      default:
        return nil
      }
    default:
      return nil
    }
  }

  /// R p rev(R), for R a rotor or quaternion (or n p rev(n), n a vector): the
  /// point p turned (or reflected), which is a vector. Its trivector part is
  /// zero, but as products that cancel rather than a written 0, so without
  /// this it would not read as a point. Any other product comes back as it is.
  private func sandwiched(_ e: Expr, _ m: Multivector) throws -> Multivector {
    func product(_ n: Expr) -> (Expr, Expr)? {
      if case .bin(.mul, let a, let b, let glyph) = n, glyph == nil || glyph == .geometric { return (a, b) }
      return nil
    }
    var factors: [Expr]?
    if case .call("gp", let args) = e, args.count == 3 {
      factors = args
    } else if let outer = product(e) {
      if let left = product(outer.0) {
        factors = [left.0, left.1, outer.1]
      } else if let right = product(outer.1) {
        factors = [outer.0, right.0, right.1]
      }
    }
    guard let factors, case .call("rev", let back) = factors[2], back.count == 1 else { return m }
    let r = try anyMv(factors[0])
    let p = gradesOf(try anyMv(factors[1]))
    let parities = Set(gradesOf(r).map { $0 % 2 })
    let turned = try anyMv(back[0])
    if parities.count != 1 || p.contains(where: { $0 != 1 }) || r.dim != turned.dim || r.data != turned.data {
      return m
    }
    return try gradePart(m, 1)
  }

  /// A point, line or plane of projective geometry, or nil: line(A, B),
  /// plane(…), join, meet, project, reflect and a `[pga]` node written in for
  /// a name. Points enter as the tuples they are (docs/pga.md); arithmetic on
  /// a line or plane is not defined, so only these calls make one.
  func lowerFlat(_ e: Expr) throws -> Flat? {
    guard case .call(let name, let args) = e, FLAT_FNS.contains(name) else { return nil }
    if let hit = algebra.flat[e] { return hit }
    algebra.flat[e] = .some(nil)
    let found = try flatOf(e, name, args)
    algebra.flat[e] = .some(found)
    return found
  }

  private func flatOf(_ e: Expr, _ name: String, _ args: [Expr]) throws -> Flat? {
    func point(_ n: Expr, _ usage: String) throws -> Flat {
      guard let items = vector(try lo(n)), items.count == 2 || items.count == 3 else { throw LanguageError(usage) }
      return pointPga(items).graded(items.count)
    }
    func arg(_ n: Expr, _ usage: String) throws -> Flat {
      let f = try lowerFlat(n) ?? point(n, usage)
      if f.grade == MOTOR {
        throw LanguageError("\(usage) A motor moves things rather than being one: rotate(X, M) applies it.")
      }
      return f
    }
    func scalar(_ n: Expr, _ usage: String) throws -> Expr {
      guard case .scalar(let value) = try lo(n) else { throw LanguageError(usage) }
      return value
    }
    /// A motor argument, or nil when the argument is something else.
    func motorArg(_ n: Expr) throws -> Flat? {
      guard let f = try lowerFlat(n), f.grade == MOTOR else { return nil }
      return f
    }
    func sameDim(_ fs: [Flat], _ usage: String) throws {
      if fs.contains(where: { $0.dim != fs[0].dim }) {
        throw LanguageError("\(usage) (One is in the plane and one in space.)")
      }
    }
    func join(_ a: Flat, _ b: Flat) throws -> Flat {
      let grade = a.grade + b.grade - (a.dim + 1)
      if grade < 1 { throw LanguageError(JOIN_USAGE) }
      return try regressivePga(a, b).graded(grade)
    }
    switch name {
    case PGA_CALL:
      return flatOfNode(e)
    case "line":
      let usage = "line takes two points: line(A, B) is the line through A and B."
      // Older links write the coordinates loose, line(0, 0, 1, 2), as a
      // row of its own still may: they pair into points.
      let pts = try legacyPointArgs(try args.map(lo), usage)
      if pts.count != 2 || pts.contains(where: { $0.count != 2 && $0.count != 3 }) { throw LanguageError(usage) }
      let ends = pts.map { pointPga($0).graded($0.count) }
      try sameDim(ends, usage)
      return try join(ends[0], ends[1])
    case "join":
      if args.count != 2 && args.count != 3 { throw LanguageError(JOIN_USAGE) }
      let fs = try args.map { try arg($0, JOIN_USAGE) }
      try sameDim(fs, JOIN_USAGE)
      return try fs.dropFirst().reduce(fs[0], join)
    case "plane":
      if args.count == 3 {
        let fs = try args.map { try point($0, PLANE_USAGE) }
        if fs.contains(where: { $0.dim != 3 }) { throw LanguageError(PLANE_USAGE) }
        return try fs.dropFirst().reduce(fs[0], join)
      }
      if args.count != 2 { throw LanguageError(PLANE_USAGE) }
      let lowered = try args.map(lo)
      guard let p = vector(lowered[0]), let n = vector(lowered[1]), p.count == 3, n.count == 3 else {
        throw LanguageError(PLANE_USAGE)
      }
      // n · (X − P) = 0.
      let offset = neg(zip(p, n).reduce(Expr.num(0)) { s, c in add(s, mul(c.0, c.1)) })
      return hyperplane(n, offset).graded(1)
    case "meet":
      if args.count != 2 { throw LanguageError(MEET_USAGE) }
      let fs = try args.map { try arg($0, MEET_USAGE) }
      let (a, b) = (fs[0], fs[1])
      try sameDim(fs, MEET_USAGE)
      if isPoint(a) || isPoint(b) {
        throw LanguageError("\(MEET_USAGE) A point meets nothing more: it is already a point.")
      }
      let grade = a.grade + b.grade
      if grade > a.dim {
        throw LanguageError(
          "Two lines in space seldom cross, so meet does not take them — meet a line with a plane, "
            + "or join(L, P) to span them.")
      }
      return try outerPga(a, b).graded(grade)
    case "project", "reflect":
      let usage =
        name == "project"
        ? "project takes what to project and what onto: project(P, L) is the point of L nearest P."
        : "reflect takes what to reflect and what in: reflect(P, L) mirrors P in the line or plane L, or in a point."
      if args.count != 2 { throw LanguageError(usage) }
      let fs = try args.map { try arg($0, usage) }
      try sameDim(fs, usage)
      return try (name == "project" ? project(fs[0], fs[1]) : reflect(fs[0], fs[1])).graded(fs[0].grade)
    case "motor":
      if args.count != 2 && args.count != 3 { throw LanguageError(MOTOR_USAGE) }
      let axis = try arg(args[0], MOTOR_USAGE)
      let fine = axis.dim == 3 ? axis.grade == 2 : isPoint(axis) && args.count == 2
      if !fine { throw LanguageError(MOTOR_USAGE) }
      let turn = try scalar(args[1], MOTOR_USAGE)
      return try motorPga(axis, turn, args.count == 3 ? try scalar(args[2], MOTOR_USAGE) : .num(0))
    case "rotate":
      // rotate(X, M): a motor moving a point, line or plane — the
      // sandwich M X M̃. Any other rotate is a turn by an angle or a rotor.
      guard args.count == 2, let m = try motorArg(args[1]) else { return nil }
      let usage = "rotate(X, M) moves a point, line or plane X by the motor M."
      let x = try arg(args[0], usage)
      try sameDim([x, m], usage)
      // A point is moved by the motor's affine map, which stays small.
      if isPoint(x) { return pointPga(try movePoint(m, pointCoords(x))).graded(x.grade) }
      return try moveFlat(m, x).graded(x.grade)
    case "slerp":
      // slerp(M1, M2, u): the rigid motion u of the way from one to the other.
      guard args.count == 3 else { return nil }
      let a = try motorArg(args[0])
      let b = try motorArg(args[1])
      if a == nil && b == nil { return nil }
      let usage = "slerp takes two motors and how far along: slerp(M1, M2, u), u from 0 to 1."
      guard let a, let b else { throw LanguageError(usage) }
      try sameDim([a, b], usage)
      return try slerpMotor(a, b, try scalar(args[2], usage), hoist: algebra.hoist)
    default:
      return nil
    }
  }

  /// distance and angle where a line or plane is involved, or nil.
  private func flatMeasure(_ name: String, _ args: [Expr]) throws -> Lowered? {
    guard name == "distance" || name == "angle", args.count == 2 else { return nil }
    let fs = try args.map(lowerFlat)
    if !fs.contains(where: { $0.map { !isPoint($0) } ?? false }) { return nil }
    let usage =
      name == "distance"
      ? "distance takes two points, lines or planes: distance(P, L)."
      : "angle takes three points, two vectors, or two lines or planes: angle(L, M)."
    let both = try zip(args, fs).map { n, f -> Flat in
      if let f { return f }
      guard let items = vector(try lo(n)), items.count == 2 || items.count == 3 else { throw LanguageError(usage) }
      return pointPga(items).graded(items.count)
    }
    let (a, b) = (both[0], both[1])
    if a.dim != b.dim { throw LanguageError("\(usage) (One is in the plane and one in space.)") }
    if name == "distance" { return .scalar(try flatDistance(a, b)) }
    if isPoint(a) || isPoint(b) { throw LanguageError(usage) }
    return .scalar(try flatAngle(a, b))
  }

  /// A list holding a multivector is a multiset of them, read out item by
  /// item: [e_xy, e_x ⟑ e_x] holds e_xy and 1. A list holding lines or
  /// planes is a multiset of them (docs/pga.md). Nil for any other list.
  func algebraList(_ items: [Expr]) throws -> Expr? {
    if try items.contains(where: { !plainValue(try lowerMv($0)) }) {
      return .list(try items.map { mvNode(try anyMv($0)) })
    }
    let flats = try items.map { a -> Flat? in
      if case .call = a, flatIn(a) { return try lowerFlat(a) }
      return nil
    }
    guard flats.contains(where: { $0.map { !isPoint($0) } ?? false }) else { return nil }
    let first = flats[0]
    var nodes: [Expr] = []
    for f in flats {
      guard let f, !isPoint(f), f.grade == first?.grade, f.dim == first?.dim else {
        throw LanguageError(
          "A list of lines or planes holds only lines, or only planes, of the plane or of space.")
      }
      nodes.append(flatNode(f))
    }
    return .list(nodes)
  }

  /// A self-call's quaternion spreads into consecutive parameters, as a
  /// point does — into its w, x, y, z — so an orbit can be written in
  /// quaternion algebra: Q(q^2 + c, k + 1). Nil for an argument that is no
  /// multivector (lib/geom.ts `lower`, case 'loop', `spread`).
  func quaternionSpread(_ a: Expr) throws -> [Expr]? {
    guard let m = try lowerMv(a) else { return nil }
    if !m.quat { throw LanguageError(NOT_A_MV_VALUE) }
    return quaternionParts(m)
  }
}

/// The rows that are a multivector's or a flat's own (lib/geom.ts
/// `lowerStatement`): qjulia(c[, s]); action(M); a point, line or plane on a
/// row of its own, which draws and reads out what it is; and a multivector,
/// which draws by grade. Nil for any other row.
func lowerAlgebraStatement(_ e: Expr, _ context: GeomContext) throws -> Expr? {
  // qjulia(c[, s]): the quaternion Julia set of c, sliced at k = s.
  if case .call("qjulia", let args) = e {
    let usage =
      "qjulia takes a quaternion and, optionally, the slice to cut: qjulia(quat(-0.2, 0.8, 0, 0)) or qjulia(c, s)."
    if args.count != 1 && args.count != 2 { throw LanguageError(usage) }
    guard let c = try context.lowerMv(args[0]) else { throw LanguageError(usage) }
    var slice = Expr.num(0)
    if args.count == 2 {
      guard case .scalar(let s) = try context.lo(args[1]) else { throw LanguageError(usage) }
      slice = s
    }
    return juliaSurface(quaternionParts(c), slice)
  }
  // action(M): the matrix drawn by what it does (Glyphs.swift).
  if case .call("action", let args) = e {
    if !context.matsPossible { throw MatrixSeen() }
    let usage =
      "action takes one 2×2 or 3×3 matrix — action(((1, 1), (0, 1))) draws where it sends the unit square, "
      + "circle and axes."
    if args.count != 1 { throw LanguageError(usage) }
    guard let m = try context.lowerMat(args[0])?.m else { throw LanguageError(usage) }
    return actionNode(m)
  }
  // A point, line or plane on a row of its own draws, and reads out what it
  // is (docs/pga.md). line(A, B) of the plane stays the implicit line.
  if case .call(let name, _) = e, name != "line", flatIn(e), let f = try context.lowerFlat(e) {
    return flatNode(f)
  }
  // A multivector on a row of its own draws by grade (docs/clifford.md); one
  // that is only a number or a vector lowers as that number or vector. A
  // quaternion stays one, so q1 = quat(1, 0, 0, 0) still turns rotate(P, q1).
  if mvIn(e), let m = try context.lowerMv(e) {
    let grades = gradesOf(m)
    if m.quat || grades.count > 1 || grades.contains(where: { $0 >= 2 }) { return mvNode(m) }
  }
  return nil
}

/// What a definition that reads a multivector or a flat names (lib/defs.ts,
/// the `lowerLineValue ?? lowerGeom` of a constant): `L = line(A, B)` is the
/// line as the value it is, where a row of its own draws line(A, B) as the
/// implicit line it always has (lib/geom.ts `lowerLineValue`); any other is
/// lowered as its row would be. `hoist` makes a slerp's intermediates hidden
/// constants of the name. Throws what lowering does; the caller decides
/// whether the definition can be read another way.
func lowerAlgebraDefinition(
  _ e: Expr, comps: @escaping (String) -> [String]?, getMat: @escaping GetMat, getTensor: @escaping GetTensor,
  isList: @escaping (String) -> Bool, hoist: @escaping (Expr) -> Expr
) throws -> Expr {
  func lower(mats: Bool) throws -> Expr {
    let context = GeomContext(comps: comps, getMat: getMat, getTensor: getTensor, mats: mats)
    context.isList = isList
    context.algebra.hoist = hoist
    if case .call("line", _) = e, let f = try context.lowerFlat(e) { return flatNode(f) }
    return try lowerStatement(e, context)
  }
  do {
    return try lower(mats: false)
  } catch is MatrixSeen {
    return try lower(mats: true)
  }
}

/// Whether a resolved definition reads a multivector or a flat anywhere, so
/// it may name one.
func holdsAlgebra(_ e: Expr) -> Bool {
  if case .call(let name, _) = e, MV_FNS.contains(name) || FLAT_FNS.contains(name) { return true }
  if case .bin(_, _, _, .geometric?) = e { return true }
  return childrenOf(e).contains(where: holdsAlgebra)
}

/// A `[pga]` or `[mv]` node with its coefficients (after the two tags)
/// hoisted (lib/defs.ts `hoistNode`).
func hoistNode(_ e: Expr, _ hoist: (Expr) -> Expr) -> Expr {
  guard case .call(let name, let args) = e else { return e }
  return .call(name, args.enumerated().map { k, a in k < 2 ? a : hoist(a) })
}

/// What a definition that reads a multivector or a flat comes to.
enum NamedAlgebra {
  /// A line, plane, motor or multivector: its node, coefficients hoisted,
  /// and what a binder is told it is.
  case named(Expr, what: String)
  /// Anything else, as the expression the rest of the definition reads: the
  /// point a flat came to, or the definition as written.
  case value(Expr)
}

/// lib/defs.ts, a constant's `lowerLineValue ?? lowerGeom` and what follows
/// it. A definition that does not lower here is left to the object expansion
/// (`N = line(P, A)` over a list names the lines, as join does), which says
/// what is wrong with it.
func namedAlgebra(
  _ resolved: Expr, comps: @escaping (String) -> [String]?, getMat: @escaping GetMat,
  getTensor: @escaping GetTensor, isList: @escaping (String) -> Bool, hoist: @escaping (Expr) -> Expr
) throws -> NamedAlgebra {
  let e: Expr
  do {
    e = try lowerAlgebraDefinition(
      resolved, comps: comps, getMat: getMat, getTensor: getTensor, isList: isList, hoist: hoist)
  } catch is LanguageError {
    if case .call("line", let args) = resolved { return .value(.call("join", args)) }
    return .value(resolved)
  }
  if let flat = flatOfNode(e) {
    if isPoint(flat) { return .value(.vec(pointCoords(flat))) }
    return .named(hoistNode(e, hoist), what: "a \(flatName(flat.dim, flat.grade) ?? "flat")")
  }
  if mvOfNode(e) != nil { return .named(hoistNode(e, hoist), what: "a multivector") }
  return .value(resolved)
}

/// A named multivector's kind (lib/row-kind.ts `constKind`): a line or plane
/// is written in as a multivector is, but is not one.
func algebraKind(_ node: Expr) -> String {
  flatOfNode(node).flatMap { flatName($0.dim, $0.grade) } ?? "multivector"
}

/// The unit vectors (lib/defs.ts `unitVector`), so `[0,1] e_x` is two
/// points, and the blades of space e_xy, e_zx, e_xyz, which are multivectors.
/// Unlike pi and e they are resolved rather than parsed, so a document that
/// defines `e_x` keeps its own. They are always 3D: a row using one is a 3D
/// scene, as `(1,0,0)` makes it. In scope only when the document's names are
/// known and do not hold the name.
func unitVector(_ name: String, _ opts: ResolveOpts) -> Expr? {
  let axes: [String: [Double]] = ["e_x": [1, 0, 0], "e_y": [0, 1, 0], "e_z": [0, 0, 1]]
  let axis = axes[name]
  let blade = axis == nil ? bladeByName(name) : nil
  // (An open Σ index of that name is bound, not the vector.)
  guard axis != nil || blade != nil, let names = opts.documentNames, !names.contains(name),
    !opts.openVars.contains(name)
  else { return nil }
  if let blade { return mvNode(blade) }
  return .vec(axis!.map { .num($0) })
}

/// Points that meet, project and reflect made, as the tuples they are; any
/// other item as it stands (lib/object-lists.ts `tupleItems`).
func tupleItems(_ items: [Expr]) -> [Expr] {
  items.map { it in
    if let f = flatOfNode(it), isPoint(f) { return .vec(pointCoords(f)) }
    return it
  }
}
