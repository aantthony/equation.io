/// What the rows of a panel with a metric are (lib/math-object.ts `metric`,
/// `geodesic`, `lightcone`, `tidal`), what they compile to for the CPU
/// (lib/compiler.ts: nothing of theirs is drawn by a shader), and how a
/// geodesic, light-cone or tidal row is classified (lib/analysis.ts
/// `classifyGeodesic`, `classifyLightCone`, `classifyTidal`).

/// How a geodesic of a metric moves, and so what its velocity's size means
/// (lib/surface-geometry.ts `Motion`).
public enum Motion: String, Equatable, Sendable {
  case riemannian, timelike, null
}

/// A metric written in a plane panel's x and y, and maybe one more coordinate
/// τ (first) that no component depends on (lib/surface-geometry.ts `MetricSpec`).
public struct MetricSpec: Equatable, Sendable {
  /// 2: x and y; 3: τ, x and y.
  public var n: Int
  /// g_ij as written, the upper triangle row by row.
  public var components: [Expr]
  /// ∂g/∂x of each, then ∂g/∂y.
  public var derivatives: [Expr]
  /// When the coordinates are not x and y: their Jacobian in x and y,
  /// row-major, then its ∂/∂x, then its ∂/∂y.
  public var jacobian: [Expr]?
  public var motion: Motion
  /// τ's name, for what it says.
  public var time: String?
}

/// What a geodesic row draws (lib/surface-geometry.ts `GeodesicSpec`).
public struct GeodesicSpec: Equatable, Sendable {
  /// 3: on the surface, in space; 2: in the parameters themselves.
  public var dim: Int
  public var params: [String]
  /// The surface in the parameters: (x, y, 0) under a panel's metric.
  public var surface: [Expr]
  /// Its first and second derivatives; none under a metric.
  public var derivatives: [Expr]
  public var start: [Expr]
  public var direction: [Expr]
  /// Arc length; when absent, as far as the window it is drawn in.
  public var length: Expr?
  /// The parameters' ranges; none under a metric.
  public var domain: [Expr]
  /// A plane panel's own metric, which the geodesic follows.
  public var metric: MetricSpec?
}

/// What a lightcones or lightcone(P) row draws (lib/light-cone.ts `LightConeSpec`).
public struct LightConeSpec: Equatable, Sendable {
  /// 2: a spacetime diagram in x and y; 3: a time, then x and y.
  public var n: Int
  public var components: [Expr]
  public var jacobian: [Expr]?
  /// The point of lightcone(P); without it, a lattice over the window.
  public var at: [Expr]?
  /// A diagram's time orientation: dτ, then the other coordinate's gradient.
  public var future: [Expr]?
}

/// What a tidal or tidal(P) row draws (lib/tidal.ts `TidalSpec`).
public struct TidalSpec: Equatable, Sendable {
  public var n: Int
  /// Which coordinate is the time the static observer moves along.
  public var time: Int
  /// The panel's two coordinates as the metric is written.
  public var params: [String]
  /// g's upper triangle in `params`, then its derivatives in them: ∂p, ∂q,
  /// ∂pp, ∂pq, ∂qq — or, with `symbols`, its partial derivatives in each
  /// symbol and each pair of them.
  public var curvature: [Expr]
  public var symbols: [String]?
  /// When `params` are not x and y: they as fields of x and y, then their
  /// Jacobian (and, with `symbols`, its ∂x and ∂y).
  public var chart: [Expr]?
  /// The metric as written, in x and y, and its Jacobian: what the horizon
  /// cut-off reads.
  public var components: [Expr]
  public var jacobian: [Expr]?
  /// The point of tidal(P); without it, a lattice over the window.
  public var at: [Expr]?
}

/// A row of a panel with a metric: the ds^2 row itself, or what follows it.
public enum MetricObject: Equatable, Sendable {
  /// A plane panel's metric: it draws nothing itself.
  case row(n: Int, coords: [String], lorentzian: Bool, mixed: Bool)
  /// A geodesic, integrated as it is drawn.
  case geodesic(GeodesicSpec)
  case lightcone(LightConeSpec)
  case tidal(TidalSpec)

  /// The kind as the site's tools name it.
  public var publicKind: String {
    switch self {
    case .row: "metric"
    case .geodesic: "geodesic"
    case .lightcone: "lightcone"
    case .tidal: "tidal"
    }
  }
}

/// The CPU's plan for one (lib/compiler.ts): the specs as they are, and a
/// metric row's readout.
public enum MetricPlan: Equatable, Sendable {
  case row(text: String)
  case geodesic(GeodesicSpec)
  case lightcone(LightConeSpec)
  case tidal(TidalSpec)

  public var type: String {
    switch self {
    case .row: "metric"
    case .geodesic: "geodesic"
    case .lightcone: "lightcone"
    case .tidal: "tidal"
    }
  }
}

func compileMetricCpu(_ object: MetricObject) -> MetricPlan {
  switch object {
  case .row(let n, let coords, let lorentzian, let mixed):
    .row(text: metricSummary(n: n, coords: coords, lorentzian: lorentzian, mixed: mixed))
  case .geodesic(let spec): .geodesic(spec)
  case .lightcone(let spec): .lightcone(spec)
  case .tidal(let spec): .tidal(spec)
  }
}

// MARK: - Classification

private let GEODESIC_USAGE =
  "geodesic takes a surface, where to start on it and which way: geodesic(S, (0.5, 0.5), (1, 0)) with "
  + "S = (u, v, u^2 - v^2), and optionally how far, geodesic(S, P, (1, 0), 4)."
private let METRIC_GEODESIC_USAGE =
  "On a panel with a metric (a ds^2 row), geodesic takes where to start and which way in x and y — for a "
  + "particle in a spacetime, its velocity d(x, y)/dt: geodesic((10, 0), (0, 0.3)), or with how far, "
  + "geodesic(P, v, 200)."
private let LIGHTRAY_USAGE =
  "lightray takes where a light ray starts and which way, in x and y: lightray((-30, 4), (1, 0)), or with how "
  + "far, lightray(P, d, 60)."
private let LIGHTCONE_USAGE =
  "lightcone(P) draws the light cone at a point, in x and y: lightcone((4, 0)), or a list, "
  + "lightcone(([3..8], 0)); lightcones alone on a row draws them over the panel."
private let TIDAL_USAGE =
  "tidal(P) draws the tidal forces at a point, in x and y: tidal((6, 0)), or a list, tidal(([4..9], 0)); tidal "
  + "alone on a row draws them over the panel."
let METRIC_ERROR = "This panel's metric (its ds^2 row) has an error."

/// A panel's metric for its geodesic rows: what its ds^2 row gives, why that
/// row is in error, or what of it the port does not read (`PanelMetricState`).
enum PanelMetricState {
  case metric(PanelMetric)
  case error(String)
  case unsupported(String)

  /// The metric, as a row that needs one reads it.
  func sound() throws -> PanelMetric {
    switch self {
    case .metric(let m): return m
    case .error: throw LanguageError(METRIC_ERROR)
    case .unsupported(let what): throw Unsupported(what)
    }
  }
}

private func isNested(_ e: Expr) -> Bool {
  switch e {
  case .vec, .list: true
  default: false
  }
}

private func used(_ exprs: [Expr]) -> NameSet {
  var names = NameSet()
  for e in exprs {
    for name in freeVars(e) { names.insert(name) }
  }
  return names
}

private func classified(_ object: MetricObject, _ reads: NameSet, _ constNames: Set<String>, _ moving: Set<String>)
  -> Classified
{
  Classified(
    object: .metric(object), animated: reads.contains { $0 == "t" || moving.contains($0) }, needs3D: false,
    params: jsSorted(reads.filter(constNames.contains)))
}

private func family(_ members: [Classified]) -> Classified {
  if members.count == 1 { return members[0] }
  var params: [String] = []
  for m in members {
    for p in m.params where !params.contains(p) { params.append(p) }
  }
  return Classified(
    object: .family(members: members, shared: nil), animated: members.contains(where: \.animated), needs3D: false,
    params: jsSorted(params))
}

/// A geodesic or lightray row on a plane panel with a metric:
/// geodesic(P, d[, L]) follows that metric in x and y — at unit speed, or,
/// in a spacetime, as a massive particle with coordinate velocity d — and
/// lightray(P, d[, L]) is a light ray in it (`classifyGeodesic`, the part
/// for a panel's metric; a surface's geodesics are not ported).
func classifyMetricGeodesic(
  _ name: String, _ args: [Expr], _ metricState: PanelMetricState?, surfaceOperand: (Expr) throws -> Void,
  lower: (Expr) throws -> Expr, constNames: Set<String>, moving: Set<String>
) throws -> Classified {
  // With a surface first, geodesic(S, start, direction) is that surface's.
  var failure: Error?
  if name == "geodesic", args.count >= 3 {
    do {
      try surfaceOperand(args[0])
    } catch let error as Unsupported {
      throw error
    } catch {
      failure = error
    }
    // (On a surface: lib/surface-geometry.ts's geodesics, not ported.)
    if failure == nil { throw Unsupported("geodesic(…)") }
  }
  let panelForm = args.count == 2 || args.count == 3
  if name == "lightray" {
    guard metricState != nil else {
      throw LanguageError(
        "lightray(P, d) traces a light ray of its panel's metric, a ds^2 row (like ds^2 = -(1 - 2/r) dt^2 + "
          + "dr^2/(1 - 2/r) + r^2 dphi^2), and this panel has none. \(LIGHTRAY_USAGE)")
    }
    if !panelForm { throw LanguageError(LIGHTRAY_USAGE) }
  }
  guard let metricState, panelForm else {
    if args.count == 2 {
      throw LanguageError(
        "geodesic(P, d) draws on its panel's surface (an on(…) row) or under its metric (a ds^2 row), and this "
          + "panel has neither. \(GEODESIC_USAGE)")
    }
    if let failure, args.count >= 3 { throw failure }
    throw LanguageError(GEODESIC_USAGE)
  }
  let m = try metricState.sound()
  if name == "lightray" && m.n == 2 && !m.lorentzian {
    throw LanguageError(
      "lightray needs a spacetime: a metric with a time coordinate, like ds^2 = -dt^2 + dx^2 + dy^2, or a "
        + "spacetime diagram, like ds^2 = -dy^2 + dx^2. This one, in \(m.coords.joined(separator: " and ")), is "
        + "positive definite everywhere it was checked; draw its geodesics with geodesic(P, d).")
  }
  // With a diagram's signature anywhere, a geodesic takes the kind at its
  // start (metricStart): mixed metrics are planes in places.
  let motion: Motion = m.n == 2 && !m.lorentzian ? .riemannian : name == "lightray" ? .null : .timelike
  let metric = MetricSpec(
    n: m.n, components: m.components, derivatives: m.derivatives, jacobian: m.jacobian, motion: motion,
    time: m.time)
  let usage = name == "lightray" ? LIGHTRAY_USAGE : METRIC_GEODESIC_USAGE
  let params = ["x", "y"]
  let items: [Expr] = [.var("x"), .var("y"), .num(0)]
  // Where it starts, which way and how far, each one value or a list.
  func elements(_ e: Expr, _ size: Int, _ what: String) throws -> [[Expr]] {
    let lowered = try lower(e)
    var each = [lowered]
    if case .list(let listed) = lowered { each = listed }
    return try each.map { item in
      var parts: [Expr] = []
      if size == 1 { parts = [item] } else if case .vec(let comps) = item { parts = comps }
      if parts.count != size || parts.contains(where: isNested) {
        throw LanguageError("\(name): \(what) is \(size == 1 ? "one number" : "a pair, like (1, 0)"). \(usage)")
      }
      for p in parts {
        for n in freeVars(p) where n != "t" && !constNames.contains(n) {
          throw LanguageError(
            "\(name): \(what) is numbers, sliders, t and named points"
              + "\(n == params[0] || n == params[1] ? ", not \(n)" : " (found \(n))"). \(usage)")
        }
      }
      return parts
    }
  }
  let starts = try elements(args[0], 2, "where it starts")
  // A particle's velocity in a spacetime; in a metric of mixed signature, a
  // plane's direction where it starts positive definite.
  let directions = try elements(
    args[1], 2,
    motion != .timelike
      ? "its direction" : m.mixed ? "its velocity (or direction, in a plane)" : "its velocity")
  let lengths = args.count > 2 ? try elements(args[2], 1, "its length") : [[]]
  let n = max(starts.count, directions.count, lengths.count)
  for list in [starts, directions, lengths] where list.count != 1 && list.count != n {
    throw LanguageError(
      "\(name): lists of starts, directions and lengths go element by element, so they must be as long.")
  }
  if n > 64 {
    throw LanguageError("A family of \(name == "lightray" ? "light rays" : "geodesics") has at most 64 members.")
  }
  let members = (0..<n).map { k -> Classified in
    func pick(_ list: [[Expr]]) -> [Expr] { list[list.count == 1 ? 0 : k] }
    let spec = GeodesicSpec(
      dim: 2, params: params, surface: items, derivatives: [], start: pick(starts), direction: pick(directions),
      length: args.count > 2 ? pick(lengths)[0] : nil, domain: [], metric: metric)
    let reads = used(
      items + pick(starts) + pick(directions) + pick(lengths) + metric.components + metric.derivatives
        + (metric.jacobian ?? []))
    return classified(.geodesic(spec), reads, constNames, moving)
  }
  return family(members)
}

/// A point of lightcone(P) or tidal(P), or each of a list of them.
private func glyphPoints(_ at: Expr, _ name: String, _ example: String, _ usage: String, _ constNames: Set<String>)
  throws -> [[Expr]]
{
  var each = [at]
  if case .list(let listed) = at { each = listed }
  return try each.map { item in
    guard case .vec(let parts) = item, parts.count == 2, !parts.contains(where: isNested) else {
      throw LanguageError("\(name): its point is a pair, like \(example). \(usage)")
    }
    for p in parts {
      for n in freeVars(p) where n != "t" && !constNames.contains(n) {
        throw LanguageError(
          "\(name): its point is numbers, sliders, t and named points"
            + "\(n == "x" || n == "y" ? ", not \(n)" : " (found \(n))"). \(usage)")
      }
    }
    return parts
  }
}

/// A `lightcones` row (no `at`), or lightcone(P): the light cones of the
/// panel's metric, drawn as it is in view (`classifyLightCone`).
func classifyLightCone(
  _ at: Expr?, _ metricState: PanelMetricState?, lower: (Expr) throws -> Expr, constNames: Set<String>,
  moving: Set<String>
) throws -> Classified {
  let what = at != nil ? "lightcone(P)" : "lightcones"
  guard let metricState else {
    throw LanguageError(
      "\(what) draws the light cones of its panel's metric, a ds^2 row — a spacetime, like ds^2 = -(1 - 2/r) "
        + "dt^2 + dr^2/(1 - 2/r) + r^2 dphi^2, or a spacetime diagram, like ds^2 = -dy^2 + dx^2 — and this panel "
        + "has none.")
  }
  let m = try metricState.sound()
  if m.n == 2 && !m.lorentzian {
    throw LanguageError(
      "A Riemannian metric has no light cones: this one, in \(m.coords.joined(separator: " and ")), is positive "
        + "definite everywhere it was checked. A spacetime has a time, like -dt^2 + dx^2 + dy^2, or one minus "
        + "sign, like -dy^2 + dx^2.")
  }
  let metricReads = used(m.components + (m.jacobian ?? []) + (m.future ?? []))
  func member(_ point: [Expr]?) -> Classified {
    var reads = metricReads
    for name in used(point ?? []) { reads.insert(name) }
    let spec = LightConeSpec(n: m.n, components: m.components, jacobian: m.jacobian, at: point, future: m.future)
    return classified(.lightcone(spec), reads, constNames, moving)
  }
  guard let at else { return member(nil) }
  let points = try glyphPoints(try lower(at), "lightcone", "(4, 0)", LIGHTCONE_USAGE, constNames)
  if points.count > 256 { throw LanguageError("A family of light cones has at most 256 members.") }
  return family(points.map(member))
}

/// A `tidal` row (no `at`), or tidal(P): the tidal forces of the panel's
/// metric on an observer held at rest, drawn as glyphs as it is in view
/// (`classifyTidal`). `spec` makes the panel's curvature expressions, once.
func classifyTidal(
  _ at: Expr?, _ metricState: PanelMetricState?, spec: () throws -> TidalSpec, lower: (Expr) throws -> Expr,
  constNames: Set<String>, moving: Set<String>
) throws -> Classified {
  let what = at != nil ? "tidal(P)" : "tidal"
  guard let metricState else {
    throw LanguageError(
      "\(what) draws the tidal forces of its panel's metric, a ds^2 row with a time — like ds^2 = -(1 - 2/r) "
        + "dt^2 + dr^2/(1 - 2/r) + r^2 dphi^2 — and this panel has none.")
  }
  let m = try metricState.sound()
  if m.n == 2 && !m.lorentzian {
    throw LanguageError(
      "Tidal forces need a time: write the ds^2 with a dt term, like -(1 - 2/r) dt^2 + dr^2/(1 - 2/r) + r^2 "
        + "dphi^2. This one, in \(m.coords.joined(separator: " and ")), is a Riemannian plane.")
  }
  let tides = try spec()
  var metricReads = used(tides.curvature + (tides.chart ?? []) + tides.components + (tides.jacobian ?? []))
  for p in tides.params { metricReads.remove(p) }
  func member(_ point: [Expr]?) -> Classified {
    var reads = metricReads
    for name in used(point ?? []) { reads.insert(name) }
    var spec = tides
    spec.at = point
    return classified(.tidal(spec), reads, constNames, moving)
  }
  guard let at else { return member(nil) }
  let points = try glyphPoints(try lower(at), "tidal", "(6, 0)", TIDAL_USAGE, constNames)
  if points.count > 256 { throw LanguageError("A family of tidal glyphs has at most 256 members.") }
  return family(points.map(member))
}

/// What is wrong with the arguments of a lightcone(…) or tidal(…) row.
func glyphUsage(_ name: String) -> String { name == "lightcone" ? LIGHTCONE_USAGE : TIDAL_USAGE }
