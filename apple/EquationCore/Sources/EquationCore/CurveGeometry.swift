/// Differential geometry of a parametric curve r(u), in the plane or in
/// space (lib/curves.ts), and how the resolver reads `curvature(C)`,
/// `torsion(C)`, `osculating(C, u0)` and `frame(C, u0)` (lib/defs.ts
/// `curveOperand`, `curveGeometry`). Each expands at resolve time, as grad
/// and d/dx do: written out of r′, r″ and r‴, taken symbolically along u, so
/// sliders and t work inside them and nothing downstream sees a curve
/// operator.
///
/// Everything is built from vectors that need no square root:
///   k  = r′ × r″                 (in the plane, its one component x′y″ − y′x″)
///   c² = |k|²
///   w  = k × r′                  (in the plane, k (−y′, x′))
/// w is r″ with its part along r′ removed, scaled: the curvature vector
/// K = κN = w/|r′|⁴. Nothing here tests whether the curve is straight.

/// The operators on a parametric curve in u (`CURVE_OPS`).
let curveOps: Set<String> = ["curvature", "torsion", "osculating", "frame"]

private let curveOpExample: [String: String] = [
  "curvature": "curvature(C) or curvature(C, 0.25)",
  "torsion": "torsion(C) or torsion(C, 0.25)",
  "osculating": "osculating(C, 0.25)",
  "frame": "frame(C, 0.25)",
]

/// The longest half arc length an osculating circle is drawn over (`REACH`):
/// a circle of radius R is drawn over s ∈ [−S, S] with S = min(πR, L), the
/// whole circle while πR ≤ L and otherwise an arc 2L long of it, which as
/// κ → 0 is that stretch of the tangent line.
private let reachLength = 1000.0

private let spaceNames: Set<String> = ["x", "y", "z"]

/// d/du, as the resolver takes it (symbolic, with its fallbacks) (`AlongU`).
typealias AlongU = (Expr) throws -> Expr

private func dot(_ a: [Expr], _ b: [Expr]) -> Expr {
  let terms = zip(a, b).map { mul($0, $1) }
  return terms.dropFirst().reduce(terms[0]) { add($0, $1) }
}

private func scale(_ s: Expr, _ a: [Expr]) -> [Expr] { a.map { mul(s, $0) } }
private func plus(_ a: [Expr], _ b: [Expr]) -> [Expr] { zip(a, b).map { add($0, $1) } }

/// r′ × r″ in space; in the plane its z component alone, as a 1-vector.
private func cross(_ a: [Expr], _ b: [Expr]) -> [Expr] {
  if a.count == 2 { return [sub(mul(a[0], b[1]), mul(a[1], b[0]))] }
  return (0..<3).map { k in sub(mul(a[(k + 1) % 3], b[(k + 2) % 3]), mul(a[(k + 2) % 3], b[(k + 1) % 3])) }
}

/// The curve's pieces at u0 (or along u, with no u0) (`pieces`).
private struct CurvePieces {
  var p: [Expr]
  var r1: [Expr]
  var speed2: Expr
  var k: [Expr]
  var c2: Expr
  var w: [Expr]
  /// κ: signed in the plane (positive turning left), |r′ × r″|/|r′|³ in space.
  var kappa: Expr
  var r2raw: [Expr]
  var at: (Expr) -> Expr

  init(_ r: [Expr], _ d: AlongU, _ u0: Expr? = nil) throws {
    let at: (Expr) -> Expr = { e in u0.map { substVars(e, ["u": $0]) } ?? e }
    let r1raw = try r.map(d)
    let r2raw = try r1raw.map(d)
    p = r.map(at)
    r1 = r1raw.map(at)
    let r2 = r2raw.map(at)
    speed2 = dot(r1, r1)
    k = cross(r1, r2)
    c2 = dot(k, k)
    w = r.count == 2 ? [mul(k[0], neg(r1[1])), mul(k[0], r1[0])] : cross(k, r1)
    kappa = div(r.count == 2 ? k[0] : .call("sqrt", [c2]), pow(speed2, .num(1.5)))
    self.r2raw = r2raw
    self.at = at
  }

  func r3(_ d: AlongU) throws -> [Expr] { try r2raw.map(d).map(at) }
}

/// κ along the curve, an expression in u (`curvatureOf`): signed in the
/// plane, |r′ × r″|/|r′|³ ≥ 0 in space.
func curvatureOf(_ r: [Expr], _ d: AlongU) throws -> Expr {
  try CurvePieces(r, d).kappa
}

/// τ along a space curve: (r′ × r″) · r‴ / |r′ × r″|², undefined (0/0) where
/// it is straight (`torsionOf`).
func torsionOf(_ r: [Expr], _ d: AlongU) throws -> Expr {
  let pieces = try CurvePieces(r, d)
  return div(dot(pieces.k, try pieces.r3(d)), pieces.c2)
}

/// The osculating circle at u0, as a parametric curve in u (`osculatingOf`).
/// By arc length s from the point,
///   c(s) = p + s sinc(κs) T + (s²/2) sinc²(κs/2) K,     K = κN = w/|r′|⁴,
/// which is smooth in κ and at κ = 0 is the tangent line p + sT. s = S v,
/// v = 2u − 1, runs over the whole circle (S = π/|κ|), capped at the reach.
func osculatingOf(_ r: [Expr], _ d: AlongU, _ u0: Expr) throws -> Expr {
  let c = try CurvePieces(r, d, u0)
  // S = min(π/|κ|, L) as π/max(|κ|, π/L), which divides by nothing that can
  // be 0: at κ = 0 it is L, and Θ = κS is 0.
  let absKappa = div(.call("sqrt", [c.c2]), pow(c.speed2, .num(1.5)))
  let reach = div(.num(Double.pi), .call("max", [absKappa, .num(Double.pi / reachLength)]))
  let turn = mul(c.kappa, reach)
  let v = sub(mul(.num(2), .var("u")), .num(1))
  let ahead = mul(v, .call("sinc", [mul(turn, v)]))
  let inward = pow(mul(v, .call("sinc", [mul(mul(.num(0.5), turn), v)])), .num(2))
  let along = scale(div(reach, .call("sqrt", [c.speed2])), c.r1)
  let across = scale(div(pow(reach, .num(2)), mul(.num(2), pow(c.speed2, .num(2)))), c.w)
  return .vec(plus(c.p, plus(scale(ahead, along), scale(inward, across))))
}

/// The Frenet frame at u0 as unit arrows from the point — `vector(P, P + [T,
/// N, B])`, a family of arrows (`frameOf`). In the plane N is T turned a
/// quarter left; in space N = K/|K| and B = (r′ × r″)/c, NaN where κ = 0.
func frameOf(_ r: [Expr], _ d: AlongU, _ u0: Expr) throws -> Expr {
  let c = try CurvePieces(r, d, u0)
  let tangent = scale(div(.num(1), .call("sqrt", [c.speed2])), c.r1)
  let frame =
    r.count == 2
    ? [tangent, [neg(tangent[1]), tangent[0]]]
    : [
      tangent, scale(div(.num(1), .call("sqrt", [mul(c.speed2, c.c2)])), c.w),
      scale(div(.num(1), .call("sqrt", [c.c2])), c.k),
    ]
  return .call("vector", [.vec(c.p), .list(frame.map { .vec(plus(c.p, $0)) })])
}

extension Resolver {
  /// What a curve operator acts on, as its components in u: a tuple, a named
  /// curve (c = (cos(2pi u), sin(2pi u)), written out through any scalar it
  /// uses), or a function of one parameter, called at u (`curveOperand`). A
  /// curve over one interval instead (`u = interval(0, 2pi)` above, or
  /// `s = interval(…)`) is read over that interval's own values, written as
  /// u; `over` is the interval, to put back where the result is a function
  /// along the curve.
  private func curveOperand(_ name: String, _ arg: Expr) throws -> (items: [Expr], over: Expr?) {
    let usage =
      "\(name) takes a parametric curve in u, like \(curveOpExample[name]!) with C = (cos(2pi u), sin(2pi u))."
    let uInterval = opts.interval("u")
    var r = arg
    if case .var(let fname) = arg, let fn = try getFn(fname) {
      if fn.params.count != 1 || fn.recursive { throw LanguageError(usage) }
      r = substVars(fn.body, [fn.params[0]: uInterval ?? .var("u")])
    }
    r = try lowerGeom(r, comps: opts.comps, isList: opts.isList)
    // (A named field over x, y or z is written out too, to be refused.)
    r = throughFields(r, over: ["u", "x", "y", "z"])
    // The interval the curve runs along, read at its own values as u: u's own
    // (`u = interval(0, 2pi)`), or else the one interval of a curve without u.
    // Any other interval stays, a family of curves.
    let hidden = intervalsIn(r)
    let uKey = uInterval.map(exprKey)
    let along =
      hidden.first { $0.key == uKey } ?? (hidden.count == 1 && !freeVars(r).contains("u") ? hidden[0] : nil)
    if let along { r = replaceIntervals(r) { $0.key == along.key ? .var("u") : $0.node } }
    if case .var = r, case .var(let n) = arg {
      let what = opts.consts(n) != nil ? "a number" : opts.isList(n) ? "a list" : nil
      if let what { throw LanguageError("\(name): \(n) is \(what), not a curve in u. \(usage)") }
      if opts.documentNames?.contains(n) != true {
        throw LanguageError(
          "\(name): \(n) is not a curve — define one first, like \(n) = (cos(2pi u), sin(2pi u)).")
      }
    }
    guard case .vec(let items) = r, items.count == 2 || items.count == 3 else { throw LanguageError(usage) }
    let vars = freeVars(r)
    if !vars.contains("u") {
      throw LanguageError("\(name) needs a curve, which moves with u — this is a fixed point. \(usage)")
    }
    if vars.contains("v") || vars.contains(where: spaceNames.contains) { throw LanguageError(usage) }
    return (items, along?.node)
  }

  /// Whether e is a list: a literal, a data column or a named list, or one
  /// mapped over, filtered or sliced — not one reduced or indexed to a
  /// number (`listValued`).
  private func listValued(_ e: Expr) -> Bool {
    switch e {
    case .list, .data: return true
    case .var(let name): return opts.isList(name)
    case .index(_, let at):
      if case .range = at { return true }
      return listValued(at)
    case .call(let name, let args)
    where SCALAR_REDUCTIONS.contains(name) || ((name == "min" || name == "max") && args.count == 1):
      return false
    default: return childrenOf(e).contains(where: listValued)
    }
  }

  /// curvature and torsion (along u, or at a point u0 of the curve), the
  /// osculating circle at u0 and the Frenet frame at u0 (`curveGeometry`).
  func curveGeometry(_ name: String, _ args: [Expr]) throws -> Expr {
    let example = curveOpExample[name]!
    let needsPoint = name == "osculating" || name == "frame"
    if args.count != 2 && (needsPoint || args.count != 1) {
      throw LanguageError(
        needsPoint
          ? "\(name) takes a curve and where on it: \(example)."
          : "\(name) takes a curve, and optionally where on it: \(example).")
    }
    let (r, over) = try curveOperand(name, args[0])
    let u0 = args.count > 1 ? args[1] : nil
    // κ(u) and τ(u) are functions of u, so k(u) = curvature(C, u) is κ; the
    // circle and frame are drawn over u of their own, which a u0 in u would
    // capture.
    let ownU = !needsPoint && opts.params?.contains("u") == true
    if let u0 {
      var isVec = false
      if case .vec = u0 { isVec = true }
      if isVec || (freeVars(u0).contains("u") && !ownU) {
        throw LanguageError(
          "\(name): the second argument is where on the curve — a number, slider or t, not u: \(example).")
      }
      // Several points map element by element, and the circles make a
      // family; the frame's arrows take one point at a time.
      if name == "frame", listValued(u0) {
        throw LanguageError(
          "frame takes one point on the curve at a time — a number, slider or t, like frame(C, 0.25) — not a list.")
      }
    }
    if name == "torsion" && r.count != 3 {
      throw LanguageError("torsion needs a curve in space — a plane curve has none, and its curvature is signed.")
    }
    let d: AlongU = { try self.applyDiff($0, "u", 1) }
    if name == "osculating" { return try osculatingOf(r, d, u0!) }
    if name == "frame" { return try frameOf(r, d, u0!) }
    let along = name == "curvature" ? try curvatureOf(r, d) : try torsionOf(r, d)
    if let u0 { return substVars(along, ["u": u0]) }
    return over.map { substVars(along, ["u": $0]) } ?? along
  }
}
