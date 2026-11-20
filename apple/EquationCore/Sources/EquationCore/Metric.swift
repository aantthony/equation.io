/// A plane panel's own metric (lib/metric.ts): a `ds^2 = …` row, a quadratic
/// form in the differentials of the panel's two coordinates (x and y, or two
/// coordinates defined from them, like r = sqrt(x^2 + y^2) and
/// phi = atan2(y, x)) and of at most one more coordinate τ that no component
/// depends on:
///
///   ds^2 = (dx^2 + dy^2)/y^2                                (Poincaré)
///   ds^2 = -(1 - 2M/r) dt^2 + dr^2/(1 - 2M/r) + r^2 dphi^2  (Schwarzschild)
///
/// Only in this row is `dr` the differential of r. The row draws nothing;
/// `geodesic(P, v)` and `lightray(P, d)` rows in its panel trace its
/// geodesics (MetricGeodesic.swift), and `lightcones` and `lightcone(P)`
/// draw its light cones (LightCone.swift).
///
/// The metric is pulled back to x and y through the Jacobian of the
/// coordinates it is written in, g_xy = Jᵀ g J, so a geodesic is integrated
/// and drawn in x and y and needs no inverse of the coordinate map.

#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

/// What a panel's ds^2 row gives its geodesics (`PanelMetric`).
struct PanelMetric: Equatable {
  /// 2: x and y; 3: τ, then x and y.
  var n: Int
  /// The coordinates as written: τ (if any) first, then the panel's two.
  var coords: [String]
  /// The upper triangle of g as written, in x and y.
  var components: [Expr]
  /// ∂g/∂x of each component, then ∂g/∂y.
  var derivatives: [Expr]
  /// The written coordinates' Jacobian in x and y and its derivatives, when
  /// they are not x and y.
  var jacobian: [Expr]?
  /// τ's name.
  var time: String?
  /// With no τ: whether it is Lorentzian anywhere checked, so that x and y
  /// make a spacetime diagram there (like -dy^2 + dx^2)…
  var lorentzian = false
  /// …and whether it is also positive definite somewhere.
  var mixed = false
  /// A diagram's time orientation: the gradient in x and y of its time
  /// coordinate, then of the other, for ties.
  var future: [Expr]?
  /// That time coordinate, as an index into coords.
  var timeAxis: Int?
}

/// What parseMetric needs of its document (`MetricContext`).
struct MetricContext {
  /// The row as the resolver writes it, with coordinate fields written in.
  var resolve: (Expr) throws -> Expr
  /// The document's coordinate fields (r = sqrt(x^2 + y^2)), in the order
  /// they are defined.
  var fieldNames: [String]
  /// Whether the document defines a name.
  var isDefined: (String) -> Bool
  /// The sliders and other constants a component may read.
  var constNames: Set<String>
  /// Their values, to check the form at sample points.
  var values: [String: Double]
}

private let PANEL: Set<String> = ["x", "y"]
private let EXAMPLE = "like ds^2 = (dx^2 + dy^2)/y^2, or ds^2 = -(1 - 2/r) dt^2 + dr^2/(1 - 2/r) + r^2 dphi^2"

/// The name a differential stands under while the row is resolved: one no
/// row can spell, so no definition (a slider named dr) reaches it.
private func placeholder(_ k: Int) -> String { "[d\(k)]" }

/// ∂e/∂v, 0 for a part that does not read v (so abs(y) beside dx^2 is no
/// obstacle), the derivative's rules otherwise (`partial`).
func metricPartial(_ e: Expr, _ v: String) throws(DiffError) -> Expr {
  if !freeVars(e).contains(v) { return .num(0) }
  if case .neg(let a) = e { return neg(try metricPartial(a, v)) }
  if case .bin(let op, let a, let b, _) = e {
    switch op {
    case .add: return add(try metricPartial(a, v), try metricPartial(b, v))
    case .sub: return sub(try metricPartial(a, v), try metricPartial(b, v))
    case .mul: return add(mul(try metricPartial(a, v), b), mul(a, try metricPartial(b, v)))
    case .div:
      if !freeVars(b).contains(v) { return div(try metricPartial(a, v), b) }
    case .pow:
      if case .num(let value) = b { return mul(mul(b, pow(a, .num(value - 1))), try metricPartial(a, v)) }
    }
  }
  return try diff(e, v)
}

/// ∂e/∂v symbolically, or a symbolic central difference where e has no
/// usable derivative (lib/surface-geometry.ts `smoothPartial`).
func smoothPartial(_ e: Expr, _ v: String) throws -> Expr {
  do {
    return try diff(e, v)
  } catch {
    if !error.nonSmooth { throw LanguageError(error.message) }
    let h = 1e-4
    func at(_ h: Double) -> Expr { substVars(e, [v: add(.var(v), .num(h))]) }
    return div(sub(at(h), at(-h)), .num(2 * h))
  }
}

/// Sample points of the plane a metric is checked at: rings round the
/// origin, four a decade from 0.001 to 100 000 across, off the axes.
private let SAMPLES: [(Double, Double)] = (0..<33).flatMap { i -> [(Double, Double)] in
  let r = JS.pow(10, -3 + Double(i) / 4)
  return (0..<7).map { k in
    let a = 0.3 + 0.37 * Double(i) + (2 * Double.pi * Double(k)) / 7
    return (r * cos(a), r * sin(a))
  }
}

/// A term of a ds^2 row as written, expanded: whether it carries a minus
/// sign, and the coordinates whose differentials it multiplies.
private struct WrittenTerm {
  var negative: Bool
  var differentials: [String]
}

/// Terms past this many are not expanded further (a product of sums).
private let MAX_WRITTEN_TERMS = 64

/// The row's terms as written, expanded through products and quotients
/// (`writtenTerms`).
private func writtenTerms(_ e: Expr, _ names: [String: String]) -> [WrittenTerm] {
  func holds(_ e: Expr) -> Bool { freeVars(e).contains { names[$0] != nil } }
  func value(_ negative: Bool = false) -> [WrittenTerm] { [WrittenTerm(negative: negative, differentials: [])] }
  func times(_ A: [WrittenTerm], _ B: [WrittenTerm]) -> [WrittenTerm] {
    var out: [WrittenTerm] = []
    for a in A {
      for b in B {
        out.append(WrittenTerm(negative: a.negative != b.negative, differentials: a.differentials + b.differentials))
      }
    }
    return Array(out.prefix(MAX_WRITTEN_TERMS))
  }
  func flipped(_ terms: [WrittenTerm]) -> [WrittenTerm] {
    terms.map { WrittenTerm(negative: !$0.negative, differentials: $0.differentials) }
  }
  switch e {
  case .var(let name):
    if let of = names[name] { return [WrittenTerm(negative: false, differentials: [of])] }
    return value()
  case .num(let v): return value(v < 0)
  case .neg(let a): return flipped(writtenTerms(a, names))
  case .bin(let op, let a, let b, _):
    if !holds(e) { return value() }
    switch op {
    case .add, .sub:
      let right = writtenTerms(b, names)
      return Array((writtenTerms(a, names) + (op == .sub ? flipped(right) : right)).prefix(MAX_WRITTEN_TERMS))
    case .mul:
      return times(writtenTerms(a, names), writtenTerms(b, names))
    case .div:
      // Over a value: its sign if it is one term, none if a sum.
      let below = writtenTerms(b, names)
      return times(writtenTerms(a, names), below.count == 1 ? below : value())
    case .pow:
      let base = writtenTerms(a, names)
      if case .num(2) = b, base.count == 1 {
        return [WrittenTerm(negative: false, differentials: base[0].differentials + base[0].differentials)]
      }
      return value()
    }
  default: return value()
  }
}

/// The coordinate a spacetime diagram's row writes as its time: that of the
/// first term, in written order, that is a squared differential carrying a
/// minus sign (`writtenTime`).
private func writtenTime(_ rhs: Expr, _ names: [String: String]) -> String? {
  for term in writtenTerms(rhs, names) {
    let d = term.differentials
    if term.negative, d.count == 2, d[0] == d[1] { return d[0] }
  }
  return nil
}

private struct SampleCounts {
  var quadratic = true
  var defined = 0
  var independent = 0
  var traceable = 0
  var space = 0
  var lorentz = 0
  var riemann = 0
  var timeA = 0
  var timeB = 0
}

/// A metric checked at the sample points, with its sliders at their values
/// (`sampleCounts`).
private func sampleCounts(_ Q: Expr, _ g: [[Expr]], _ J: [[Expr]], _ vars: [String], _ values: [String: Double])
  -> SampleCounts
{
  let n = g.count
  var counts = SampleCounts()
  for (k, (x, y)) in SAMPLES.enumerated() {
    let w = vars.indices.map { sin(1.7 * Double(k) + 2.3 * Double($0) + 0.4) }
    var env = values
    env["x"] = x
    env["y"] = y
    for (i, v) in vars.enumerated() { env[v] = w[i] }
    func at(_ e: Expr) -> Double { (try? evaluate(e, env)) ?? .nan }
    let q = at(Q)
    let G = g.map { $0.map(at) }
    if !q.isFinite || !G.allSatisfy({ $0.allSatisfy(\.isFinite) }) { continue }
    counts.defined += 1
    var sum = 0.0
    var size = abs(q)
    for i in 0..<n {
      for j in 0..<n {
        sum += G[i][j] * w[i] * w[j]
        size += abs(G[i][j] * w[i] * w[j])
      }
    }
    if abs(sum - q) > 1e-7 * size {
      counts.quadratic = false
      return counts
    }
    let j = J.map { $0.map(at) }
    if abs(j[0][0] * j[1][1] - j[0][1] * j[1][0]) > 1e-12 * JS.max(j.flatMap { $0 }.map { abs($0) }) {
      counts.independent += 1
    }
    if n == 2 {
      // Positive definite (a Riemannian plane) or Lorentzian (a spacetime
      // diagram): either can be traced.
      let det = G[0][0] * G[1][1] - G[0][1] * G[0][1]
      if G[0][0] > 0 && det > 0 { counts.riemann += 1 }
      if det < 0 {
        counts.lorentz += 1
        if G[0][0] < 0 { counts.timeA += 1 }
        if G[1][1] < 0 { counts.timeB += 1 }
      }
      if (G[0][0] > 0 && det > 0) || det < 0 { counts.traceable += 1 }
      continue
    }
    let det =
      G[0][0] * (G[1][1] * G[2][2] - G[1][2] * G[1][2]) - G[0][1] * (G[0][1] * G[2][2] - G[0][2] * G[1][2])
      + G[0][2] * (G[0][1] * G[1][2] - G[0][2] * G[1][1])
    if det < 0 { counts.lorentz += 1 }
    // The panel's coordinates are space here; with det g < 0, the other is
    // a time (in an ergoregion too, where g_ττ > 0).
    if G[1][1] > 0 && G[1][1] * G[2][2] - G[1][2] * G[1][2] > 0 {
      counts.space += 1
      if det < 0 { counts.traceable += 1 }
    }
  }
  return counts
}

/// The names of a time: d<name> is its differential in a ds^2 row even
/// where the document defines d<name> or the name itself.
private let TIME_NAMES: Set<String> = ["t", "τ", "tau"]

/// Names a differential cannot be of: constants and the imaginary unit.
private let NOT_COORDINATES: Set<String> = ["pi", "e", "i", "inf"]

/// Whether a list of trees has more than `limit` nodes (lib/size.ts
/// `exceedsNodes` of an array: the array is one).
func exceedsNodes(_ list: [Expr], _ limit: Int) -> Bool {
  var n = 1
  for e in list {
    n += countNodes(e, limit: limit - n)
    if n > limit { return true }
  }
  return false
}

/// Nodes a flow's field may have (lib/flow.ts `FLOW_NODE_LIMIT`).
let FLOW_NODE_LIMIT = 8192

/// The metric of a `ds^2 = rhs` row, or an error saying what is wrong with
/// it (`parseMetric`).
func parseMetric(_ rhs: Expr, _ ctx: MetricContext) throws -> PanelMetric {
  // The differentials: d<name> for x, y, coordinate fields and t (τ)
  // always; for any other name only when d<name> is not itself something
  // the document defines, which then keeps its value here (`shadowed`).
  var panel: [String] = []
  var extra: [String] = []
  var shadowed: [String] = []
  var names: [String: String] = [:]
  let fields = Set(ctx.fieldNames)
  for name in freeVars(rhs) {
    let u = Array(name.utf16)
    if u.count < 2 || u[0] != unit("d") { continue }
    let of = String(decoding: u[1...], as: UTF16.self)
    if PANEL.contains(of) || fields.contains(of) {
      panel.append(of)
      names[name] = of
      continue
    }
    if !TIME_NAMES.contains(of) && ctx.isDefined(name) {
      shadowed.append(name)
      continue
    }
    if NOT_COORDINATES.contains(of) || builtinFn(of) != nil {
      throw LanguageError(
        "ds^2: \(name) is no differential — \(of) is \(builtinFn(of) != nil ? "a function" : "a constant"), "
          + "not a coordinate.")
    }
    // A time keeps its name inside ds^2 even beside a slider τ elsewhere.
    if ctx.isDefined(of) && !TIME_NAMES.contains(of) {
      throw LanguageError(
        "ds^2: \(of) is not a coordinate, so \(name) is no differential — define \(of) from x and y "
          + "(like r = sqrt(x^2 + y^2)), or use a coordinate of its own, like dt.")
    }
    extra.append(of)
    names[name] = of
  }
  func listed(_ list: [String]) -> String { list.map { "d\($0)" }.joined(separator: ", ") }
  if panel.count < 2 {
    // dr and dphi with no r and phi defined read as coordinates of their own.
    let loose = extra.filter { !TIME_NAMES.contains($0) }
    throw LanguageError(
      "ds^2 needs the differentials of both of the panel's coordinates — dx and dy, or of two coordinates "
        + "defined from x and y\(panel.isEmpty ? "" : " (it has only \(listed(panel)))"). "
        + (loose.isEmpty
          ? "Write it \(EXAMPLE)."
          : "\(listed(loose)) \(loose.count == 1 ? "is the differential" : "are differentials") of no "
            + "coordinate yet: define \(loose.joined(separator: " and ")) from x and y first, like "
            + "r = sqrt(x^2 + y^2) and phi = atan2(y, x)."))
  }
  if extra.count > 1 {
    throw LanguageError(
      "ds^2 takes the panel's two coordinates and at most one more, a time no component depends on: "
        + "\(listed(extra)) are \(extra.count).")
  }
  if panel.count > 2 {
    throw LanguageError(
      "ds^2 is drawn on the plane, in two of the panel's coordinates: \(listed(panel)) are \(panel.count).")
  }
  // τ first, then the panel's two: x before y, coordinate fields in the
  // order they are defined (r before phi).
  func rank(_ c: String) -> Int { c == "x" ? -2 : c == "y" ? -1 : ctx.fieldNames.firstIndex(of: c) ?? -1 }
  // (A stable sort, as JavaScript's is.)
  if rank(panel[0]) > rank(panel[1]) { panel.swapAt(0, 1) }
  let coords = extra + panel
  let time = extra.first
  let n = coords.count
  var slot: [String: String] = [:]
  for (k, c) in coords.enumerated() { slot[c] = placeholder(k) }
  var renamed: [String: Expr] = [:]
  for (name, of) in names { renamed[name] = .var(slot[of]!) }
  let Q = try ctx.resolve(substVars(rhs, renamed))

  // What the components may read: x, y, the differentials and constants.
  let vars = coords.map { slot[$0]! }
  for v in freeVars(Q) {
    // The extra coordinate first: a slider of the same name (τ = 2) is not
    // what a component in the time τ reads.
    if v == time {
      throw LanguageError(
        TIME_NAMES.contains(v)
          ? "ds^2 depends on \(v): metrics that change with time are not supported yet (inside ds^2, d\(v) is "
            + "the differential of the time coordinate \(v))."
          : "ds^2 depends on \(v): its coordinate besides the panel's two must be cyclic — no component may "
            + "depend on it.")
    }
    if PANEL.contains(v) || vars.contains(v) || ctx.constNames.contains(v) { continue }
    throw LanguageError("Unknown variable: \(v). Define \"\(v) = 1\" to make a slider.")
  }

  // g_ij = ½ ∂²Q/∂dᵢ∂dⱼ, each free of the differentials, and Q = gᵢⱼ dⁱ dʲ.
  let one = shadowed.count == 1
  let notQuadratic = LanguageError(
    "ds^2 is a quadratic form in the differentials: each term a coefficient times two of them, like "
      + "r^2 dphi^2 or 2 a dt dphi."
      + (shadowed.isEmpty
        ? ""
        : " (\(shadowed.joined(separator: ", ")) \(one ? "is" : "are") defined elsewhere in the document, so "
          + "\(one ? "it is" : "they are") that value here, not a differential: rename the definition to use "
          + "\(one ? "it" : "them") as one.)"))
  var g: [[Expr]] = []
  do {
    for i in 0..<n {
      g.append([])
      for j in 0..<n {
        g[i].append(j < i ? g[j][i] : mul(.num(0.5), try metricPartial(try metricPartial(Q, vars[i]), vars[j])))
      }
    }
  } catch {
    if error.nonSmooth { throw notQuadratic }
    throw LanguageError(error.message)
  }
  for row in g {
    for e in row where vars.contains(where: freeVars(e).contains) { throw notQuadratic }
  }

  // The coordinates in x and y, and their Jacobian.
  func field(_ c: String) throws -> Expr {
    if PANEL.contains(c) { return .var(c) }
    let e = try ctx.resolve(.var(c))
    let used = freeVars(e)
    if used.contains("z") { throw LanguageError("ds^2 is drawn on the plane, and \(c) uses z.") }
    if used.contains("t") {
      throw LanguageError("ds^2: \(c) changes with t, and metrics that change with time are not supported yet.")
    }
    return e
  }
  let spatial = Array(coords[(n - 2)...])
  let J = try spatial.map { c -> [Expr] in
    let e = try field(c)
    return [try smoothPartial(e, "x"), try smoothPartial(e, "y")]
  }

  // Checked at sample points (with the sliders at their values): the form is
  // g's, the coordinates are independent, and the signature is one a
  // geodesic can be traced in somewhere.
  let s = sampleCounts(Q, g, J, vars, ctx.values)
  if !s.quadratic { throw notQuadratic }
  if s.defined > 0 && s.independent == 0 && !spatial.allSatisfy(PANEL.contains) {
    throw LanguageError(
      "ds^2: \(spatial.joined(separator: " and ")) do not make coordinates on the plane — their Jacobian in x "
        + "and y vanishes.")
  }
  if s.defined > 0 && s.traceable == 0 {
    throw LanguageError(
      n == 2
        ? "ds^2 in two coordinates must be positive for every direction (a Riemannian metric, like "
          + "(dx^2 + dy^2)/y^2) or have one minus sign (a spacetime diagram, like -dy^2 + dx^2) somewhere; this "
          + "one is negative for every direction wherever it was checked."
        : s.space > 0
          ? "ds^2: \(time!) must be a time, with one minus sign, like -dt^2 + dx^2 + dy^2."
          : s.lorentz > 0
            ? "ds^2: the panel's coordinates are not space anywhere it was checked, at distances from 0.001 to "
              + "100 000 from the origin — inside a horizon everywhere there?"
            : "ds^2 must have one minus sign, for d\(time!): the panel's coordinates are space.")
  }

  // With no time: a spacetime diagram if it is Lorentzian anywhere checked
  // (a plane where it is positive definite, if that too). Its time is the
  // one the row writes with a minus sign first (writtenTime), else the
  // second (y): from how the row is written, not the metric's values.
  let lorentzian = n == 2 && s.lorentz > 0
  let mixed = lorentzian && s.riemann > 0
  let timeIndex: Int
  if let written = writtenTime(rhs, names) {
    timeIndex = spatial.firstIndex(of: written) == 0 ? 0 : 1
  } else {
    timeIndex = s.timeA == s.lorentz && s.timeB < s.lorentz ? 0 : 1
  }
  let future = lorentzian ? J[timeIndex] + J[1 - timeIndex] : nil

  // g as written, its x and y derivatives, and — unless it is written in x
  // and y — the Jacobian it is pulled back to x and y with as it is traced.
  var components: [Expr] = []
  for i in 0..<n {
    for j in i..<n { components.append(g[i][j]) }
  }
  var derivatives: [Expr] = []
  for v in ["x", "y"] { derivatives += try components.map { try smoothPartial($0, v) } }
  let plain = spatial[0] == "x" && spatial[1] == "y"
  let entries = J.flatMap { $0 }
  var jacobian: [Expr]?
  if !plain {
    var all = entries
    for v in ["x", "y"] { all += try entries.map { try smoothPartial($0, v) } }
    jacobian = all
  }
  if exceedsNodes(components + derivatives + (jacobian ?? []), 4 * FLOW_NODE_LIMIT) {
    throw LanguageError("This metric is too large to trace geodesics in.")
  }
  return PanelMetric(
    n: n, coords: coords, components: components, derivatives: derivatives, jacobian: jacobian, time: time,
    lorentzian: lorentzian, mixed: mixed, future: future, timeAxis: lorentzian ? timeIndex : nil)
}

/// What a metric row reads out: its signature and coordinates (`metricSummary`).
func metricSummary(n: Int, coords: [String], lorentzian: Bool, mixed: Bool) -> String {
  let all = coords.joined(separator: ", ")
  if n == 2 {
    if mixed {
      return "Metric of mixed signature in \(all): Riemannian where positive definite, a spacetime diagram where "
        + "Lorentzian — geodesic(P, v) takes the kind at P, lightray(P, d) and lightcones where it is Lorentzian"
    }
    return lorentzian
      ? "Lorentzian metric in \(all) (a spacetime diagram): geodesic(P, v) for a particle, lightray(P, d) for "
        + "light, lightcones for its cones"
      : "Riemannian metric in \(all): geodesic(P, d) traces it"
  }
  return "Lorentzian metric in \(coords[0]); \(coords.dropFirst().joined(separator: ", ")): geodesic(P, v) for a "
    + "particle, lightray(P, d) for light, lightcones for its cones"
}
