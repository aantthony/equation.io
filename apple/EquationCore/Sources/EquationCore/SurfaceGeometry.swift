/// The curvatures of a parametric surface in u and v
/// (lib/surface-geometry.ts `gaussianOf`, `meanCurvatureOf`), how the
/// resolver reads `gaussian(S)` and `meancurvature(S)` (lib/defs.ts
/// `surfaceGeometry`), and the row that is one of them alone, which draws S
/// coloured by it (lib/analysis.ts `curvaturePaint`, lib/plot.ts
/// `paintedSurface`).
///
/// Not ported: the surface of a panel's on(…) row (`gaussian(x, y)`),
/// geodesics, and the rest of lib/surface-geometry.ts.

/// `[paint](S, f)`: the surface S coloured by f, a scalar in the same u and
/// v — gaussian(S) alone on a row, which classify unwraps (lib/geom.ts).
let PAINT_CALL = "[paint]"

private let spaceVarNames: Set<String> = ["x", "y", "z"]

private func dot(_ a: [Expr], _ b: [Expr]) -> Expr {
  let terms = zip(a, b).map { mul($0, $1) }
  return terms.dropFirst().reduce(terms[0]) { add($0, $1) }
}

private func cross(_ a: [Expr], _ b: [Expr]) -> [Expr] {
  (0..<3).map { k in sub(mul(a[(k + 1) % 3], b[(k + 2) % 3]), mul(a[(k + 2) % 3], b[(k + 1) % 3])) }
}

/// The fundamental forms of r at a general point of (u, v) (`forms`); `d` is
/// ∂/∂v as the resolver takes it (symbolic, with its fallbacks).
private func forms(_ r: [Expr], _ d: (Expr, String) throws -> Expr) throws
  -> (E: Expr, F: Expr, G: Expr, W2: Expr, L: Expr, M: Expr, N: Expr)
{
  let ru = try r.map { try d($0, "u") }
  let rv = try r.map { try d($0, "v") }
  let ruu = try ru.map { try d($0, "u") }
  let ruv = try ru.map { try d($0, "v") }
  let rvv = try rv.map { try d($0, "v") }
  let n = cross(ru, rv)
  return (dot(ru, ru), dot(ru, rv), dot(rv, rv), dot(n, n), dot(ruu, n), dot(ruv, n), dot(rvv, n))
}

/// K = (LN − M²)/(EG − F²), an expression in u and v.
func gaussianOf(_ r: [Expr], _ d: (Expr, String) throws -> Expr) throws -> Expr {
  let f = try forms(r, d)
  return div(sub(mul(f.L, f.N), pow(f.M, .num(2))), pow(f.W2, .num(2)))
}

/// H = (EN − 2FM + GL)/(2(EG − F²)), with the normal r_u × r_v.
func meanCurvatureOf(_ r: [Expr], _ d: (Expr, String) throws -> Expr) throws -> Expr {
  let f = try forms(r, d)
  let top = add(sub(mul(f.E, f.N), mul(.num(2), mul(f.F, f.M))), mul(f.G, f.L))
  return div(top, mul(.num(2), pow(f.W2, .num(1.5))))
}

extension Resolver {
  /// What a surface operator acts on, as its components in u and v: a
  /// tuple, a named surface (S = (u, v, u v)) or a function of two
  /// parameters, called at u and v (`surfaceOperand`). A surface over
  /// intervals (`u = interval(0, 2pi)` above) is read over their values,
  /// written as u and v; `over` holds them, to put back where the result is a
  /// function on the surface.
  func surfaceOperand(_ name: String, _ arg: Expr) throws -> (items: [Expr], over: (u: Expr?, v: Expr?)) {
    let usage = "\(name) takes a parametric surface in u and v, like \(name)(S) with S = (u, v, u^2 - v^2)."
    // Port: where an interval is not read (Interval.swift), neither are u's and v's.
    let uInterval = opts.interval("u")
    let vInterval = opts.interval("v")
    if uInterval != nil || vInterval != nil, !opts.intervals { throw Unsupported("interval(…)") }
    var r = arg
    if case .var(let fname) = arg, let fn = try getFn(fname) {
      if fn.params.count != 2 { throw LanguageError(usage) }
      r = substVars(fn.body, [fn.params[0]: uInterval ?? .var("u"), fn.params[1]: vInterval ?? .var("v")])
    }
    r = try lowerGeom(r, comps: opts.comps)
    r = throughFields(r, over: ["u", "v", "x", "y", "z"])
    if case .var = r, case .var(let written) = arg, opts.documentNames?.contains(written) != true {
      throw LanguageError(
        "\(name): \(written) is not a surface — define one first, like \(written) = (u, v, u^2 - v^2).")
    }
    let (uKey, vKey) = (uInterval.map(exprKey), vInterval.map(exprKey))
    let hidden = intervalsIn(r)
    if !hidden.isEmpty, !opts.intervals { throw Unsupported("interval(…)") }
    var over: (u: Expr?, v: Expr?) = (nil, nil)
    for h in hidden {
      if h.key == uKey {
        over.u = h.node
      } else if h.key == vKey {
        over.v = h.node
      } else {
        throw LanguageError("\(name) reads a surface over u and v; this one sweeps another interval. \(usage)")
      }
    }
    if !hidden.isEmpty { r = replaceIntervals(r) { .var($0.key == uKey ? "u" : "v") } }
    guard case .vec(let items) = r, items.count == 3 else { throw LanguageError(usage) }
    let vars = freeVars(r)
    if !vars.contains("u") || !vars.contains("v") {
      throw LanguageError("\(name) needs a surface, which moves with both u and v. \(usage)")
    }
    if vars.contains(where: spaceVarNames.contains) { throw LanguageError(usage) }
    return (items, over)
  }

  /// A point's two coordinates from a surface operator's trailing arguments:
  /// (u0, v0) as one tuple or a named point, or as two numbers (`pointArgs`).
  private func pointArgs(_ name: String, _ args: [Expr], _ example: String) throws -> (Expr, Expr) {
    func isVec(_ e: Expr) -> Bool { if case .vec = e { true } else { false } }
    if args.count == 2, !args.contains(where: isVec) { return (args[0], args[1]) }
    if args.count == 1 {
      if case .vec(let items) = args[0], items.count == 2 { return (items[0], items[1]) }
      if case .var(let point) = args[0], let comps = opts.comps(point), comps.count == 2 {
        return (.var(comps[0]), .var(comps[1]))
      }
    }
    throw LanguageError("\(name): where on the surface is two numbers, a point or a tuple: \(example).")
  }

  /// gaussian(S) and meancurvature(S): K and H of the surface, functions of
  /// u and v, or read at a point of it, gaussian(S, u0, v0)
  /// (`surfaceGeometry`, for a panel with no surface).
  func surfaceGeometry(_ name: String, _ args: [Expr]) throws -> Expr {
    let example = "\(name)(S) or \(name)(S, 0.5, 0.25)"
    if args.isEmpty || args.count > 3 {
      throw LanguageError("\(name) takes a surface, and optionally where on it: \(example).")
    }
    // gaussian(x, y) or gaussian((1, 2)): a point of a surface the panel lacks.
    var named = false
    if case .var(let first) = args[0] {
      named = try getFn(first) != nil || opts.documentNames?.contains(first) == true
    }
    var pointOnly = false
    if case .vec(let items) = args[0] { pointOnly = items.count == 2 }
    if args.count == 2, !named, !args.contains(where: { if case .vec = $0 { true } else { false } }) {
      pointOnly = true
    }
    if pointOnly {
      throw LanguageError(
        "\(name)(x, y) reads the surface of its panel's on(…) row, and this panel has none: write \(name)(S) "
          + "with S = (u, v, u^2 - v^2).")
    }
    let (r, over) = try surfaceOperand(name, args[0])
    let point = args.count > 1 ? try pointArgs(name, Array(args.dropFirst()), example) : nil
    func d(_ e: Expr, _ v: String) throws -> Expr { try applyDiff(e, v, 1) }
    let field = name == "gaussian" ? try gaussianOf(r, d) : try meanCurvatureOf(r, d)
    if let point { return substVars(field, ["u": point.0, "v": point.1]) }
    var back: [String: Expr] = [:]
    if let u = over.u { back["u"] = u }
    if let v = over.v { back["v"] = v }
    return back.isEmpty ? field : substVars(field, back)
  }
}

/// The surface of a row that is gaussian(S) or meancurvature(S) alone — which
/// draws S coloured by it — or nil: for any other row, for one of the
/// document's own functions of those names, and for a point, gaussian(P) or
/// gaussian(P + (0, 1)), which is a number (`curvaturePaint`).
func curvaturePaint(_ e: Expr, _ fnNames: Set<String>, isPoint: (Expr) -> Bool) -> Expr? {
  guard case .call(let name, let args) = e, name == "gaussian" || name == "meancurvature", !fnNames.contains(name),
    args.count == 1
  else { return nil }
  if case .vec(let items) = args[0], items.count == 2 { return nil }
  return isPoint(args[0]) ? nil : args[0]
}

/// A parametric surface coloured by a scalar on it, both written in u and v
/// (`paintedSurface`): the arguments of a `[paint]` call.
func paintedSurface(_ args: [Expr], defined: Set<String>, fields: [String: Expr]) throws -> Classified {
  let usage = "gaussian(S) and meancurvature(S) alone on a row colour one parametric surface S in u and v."
  guard args.count >= 2 else { throw LanguageError(usage) }
  var (surface, paint) = (args[0], args[1])
  // Both are written in u and v, or in the intervals u and v were defined
  // as, which are swept here as classify sweeps them, the same interval to
  // the same parameter in both.
  let both = Expr.vec([surface, paint])
  let hidden = intervalsIn(both)
  if !hidden.isEmpty {
    let used = freeVars(both)
    let free = ["u", "v"].filter { !used.contains($0) }
    if hidden.count > free.count { throw LanguageError(usage) }
    var slot: [String: String] = [:]
    for (k, h) in hidden.enumerated() { slot[h.key] = free[k] }
    surface = replaceIntervals(surface) { sweep($0, slot[$0.key]!) }
    paint = replaceIntervals(paint) { sweep($0, slot[$0.key]!) }
  }
  if case .list = paint { throw LanguageError(usage) }
  if case .list = surface { throw LanguageError(usage) }
  let cls = try classify(surface, defined: defined, fields: fields)
  guard case .surfaceParametric(let coordinates, _) = cls.object else { throw LanguageError(usage) }
  let vars = freeVars(paint)
  if vars.contains(where: spaceVarNames.contains) { throw LanguageError(usage) }
  var params = cls.params
  for v in vars where defined.contains(v) && !params.contains(v) { params.append(v) }
  return Classified(
    object: .surfaceParametric(coordinates: coordinates, paint: paint),
    animated: cls.animated || vars.contains("t"), needs3D: cls.needs3D, params: jsSorted(params))
}

private let GEODESIC_USAGE =
  "geodesic takes a surface, where to start on it and which way: geodesic(S, (0.5, 0.5), (1, 0)) with "
  + "S = (u, v, u^2 - v^2), and optionally how far, geodesic(S, P, (1, 0), 4)."

/// A geodesic row: geodesic(S, (u0, v0), (du, dv)[, L]), or on a panel drawn
/// on a surface geodesic((x0, y0), (dx, dy)[, L]) (lib/analysis.ts
/// `classifyGeodesic`). What the site refuses is refused in its words; a
/// geodesic it would trace is not ported.
func classifyGeodesic(_ args: [Expr], onSurface: Bool, surfaceOperand: (Expr) throws -> Void) throws -> Never {
  var operand = false
  var failure: Error?
  if args.count >= 3 {
    do {
      try surfaceOperand(args[0])
      operand = true
    } catch let error as Unsupported {
      throw error
    } catch {
      failure = error
    }
  }
  let panelForm = !operand && (args.count == 2 || args.count == 3)
  if !operand && !(panelForm && onSurface) {
    if args.count == 2 {
      throw LanguageError(
        "geodesic(P, d) draws on its panel's surface (an on(…) row), and this panel has none. \(GEODESIC_USAGE)")
    }
    if let failure, args.count >= 3 { throw failure }
    throw LanguageError(GEODESIC_USAGE)
  }
  if operand && args.count > 4 { throw LanguageError(GEODESIC_USAGE) }
  throw Unsupported("geodesic(…)")
}
