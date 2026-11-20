/// The rows that give a panel a metric (`ds^2 = …`, Metric.swift) and what
/// the panel's other rows read of it: the part of lib/analysis.ts
/// `analyzePrepared` that is `panelMetricRows`, `metricOf`, `curvatureOf`,
/// `tidesOf` and the rows they classify.

/// `^\s*ds\s*(?:\^\s*2|²)\s*=`: a panel's metric row (lib/metric.ts `METRIC_ROW`).
func isMetricRowText(_ text: String) -> Bool {
  var s = RowScanner(text)
  s.space()
  guard s.eat(word: "ds") else { return false }
  s.space()
  if s.eat("^") {
    s.space()
    guard s.eat("2") else { return false }
  } else if !s.eat("\u{B2}") {
    return false
  }
  s.space()
  return s.peek == unit("=")
}

/// A document's panel metrics, each worked out when a row of its panel first
/// asks for it.
final class PanelMetrics {
  /// Each panel's ds^2 rows, in order: the first is its metric.
  var rows: [Int: [Int]] = [:]
  /// The panels whose view(…) maps an axis.
  var mapped: Set<Int> = []
  /// The panels drawn on a surface (an on(…) row), which gives them their metric.
  var surfaces: Set<Int> = []
  private var states: [Int: PanelMetricState] = [:]
  private var tides: [Int: TidalSpec] = [:]

  let texts: [String]
  /// A row's text as the parser reads it.
  let parse: (String) throws -> Expr
  /// A parsed expression resolved and lowered, as a plot row's is.
  let lower: (Expr) throws -> Expr
  /// The document's coordinate fields and named conditions, and the fields'
  /// names in the order they are defined.
  let fieldEnv: [String: Expr]
  let fieldNames: [String]
  let documentNames: Set<String>
  let fnNames: Set<String>
  let constNames: () -> Set<String>
  /// The constants' values at t = 0, the states at their starts.
  let values: () -> [String: Double]
  /// The constants that move: with t, or as states.
  let moving: () -> Set<String>
  /// Reads an expression as a surface in u and v, or throws.
  let surfaceOperand: (Expr) throws -> Void

  init(
    texts: [String], parse: @escaping (String) throws -> Expr, lower: @escaping (Expr) throws -> Expr,
    fieldEnv: [String: Expr], fieldNames: [String], documentNames: Set<String>, fnNames: Set<String>,
    constNames: @escaping () -> Set<String>, values: @escaping () -> [String: Double],
    moving: @escaping () -> Set<String>, surfaceOperand: @escaping (Expr) throws -> Void
  ) {
    self.texts = texts
    self.parse = parse
    self.lower = lower
    self.fieldEnv = fieldEnv
    self.fieldNames = fieldNames
    self.documentNames = documentNames
    self.fnNames = fnNames
    self.constNames = constNames
    self.values = values
    self.moving = moving
    self.surfaceOperand = surfaceOperand
  }

  /// Whether a row is a ds^2 row (the document may define ds itself).
  func isMetricRow(_ text: String) -> Bool { isMetricRowText(text) && !documentNames.contains("ds") }

  private func metricRhs(_ panel: Int) throws -> Expr {
    guard let ri = rows[panel]?.first, case .eq(_, let r) = try parse(texts[ri]) else {
      throw LanguageError("A metric row is ds^2 = … in the differentials of its coordinates.")
    }
    return r
  }

  /// A panel's metric, from its first ds^2 row (`metricOf`).
  func state(_ panel: Int) -> PanelMetricState? {
    guard rows[panel]?.first != nil else { return nil }
    if let known = states[panel] { return known }
    var state: PanelMetricState
    do {
      if surfaces.contains(panel) {
        throw LanguageError(
          "This panel is drawn on a surface, which gives it its metric: a ds^2 row is for a plane panel.")
      }
      if mapped.contains(panel) {
        throw LanguageError(
          "This panel's view(…) maps its axes, and a ds^2 metric is traced on a panel without one, for now.")
      }
      let rhs = try metricRhs(panel)
      let context = MetricContext(
        resolve: { [self] e in try inlineFields(try lower(e), fieldEnv) }, fieldNames: fieldNames,
        isDefined: { [documentNames] in documentNames.contains($0) }, constNames: constNames(), values: values())
      state = .metric(try parseMetric(rhs, context))
    } catch let error as Unsupported {
      state = .unsupported(error.what)
    } catch {
      state = .error(errorMessage(error))
    }
    states[panel] = state
    return state
  }

  /// What the panel's tidal glyphs read, made when first asked (`tidesOf`).
  private func tides(_ panel: Int) throws -> TidalSpec {
    guard let state = state(panel) else { throw LanguageError(METRIC_ERROR) }
    let metric = try state.sound()
    if let known = tides[panel] { return known }
    let made = try tidalSpec(
      try metricRhs(panel), metric,
      CurvatureContext(written: lower, fieldEnv: fieldEnv),
      inXY: { [fieldEnv] in try inlineFields($0, fieldEnv) })
    tides[panel] = made
    return made
  }

  /// A row that is one of the metric's by its text alone: the ds^2 row
  /// itself, `lightcones` or `tidal`. Nil for any other row.
  func row(_ text: String, index: Int, panel: Int) throws -> Classified? {
    // ds^2 = …: the panel's metric, which its geodesic and lightray rows
    // follow. It draws nothing itself.
    if isMetricRow(text) {
      if rows[panel]?.first != index {
        throw LanguageError(
          "This panel already has a metric: one ds^2 row a panel (a --- row starts a new panel).")
      }
      switch state(panel)! {
      case .error(let message): throw LanguageError(message)
      case .unsupported(let what): throw Unsupported(what)
      case .metric(let m):
        return Classified(
          object: .metric(.row(n: m.n, coords: m.coords, lorentzian: m.lorentzian, mixed: m.mixed)),
          animated: false, needs3D: false, params: [])
      }
    }
    let trimmed = jsTrimmed(text)
    // (On a surface's panel a ds^2 row gives no metric to draw the cones or tides of.)
    let state = surfaces.contains(panel) ? nil : state(panel)
    // lightcones: the light cones of the panel's metric over the window.
    if trimmed == "lightcones" && !documentNames.contains("lightcones") {
      return try classifyLightCone(nil, state, lower: lower, constNames: constNames(), moving: moving())
    }
    // tidal: the tidal forces of the panel's metric over the window.
    if trimmed == "tidal" && !documentNames.contains("tidal") {
      return try classifyTidal(
        nil, state, spec: { try self.tides(panel) }, lower: lower, constNames: constNames(),
        moving: moving())
    }
    return nil
  }

  /// A parsed row that is a call of the metric's: geodesic(…), lightray(…),
  /// lightcone(P) or tidal(P). Nil for any other row.
  func call(_ parsed: Expr, panel: Int) throws -> Classified? {
    guard case .call(let name, let args) = parsed, !fnNames.contains(name) else { return nil }
    let onSurface = surfaces.contains(panel)
    func state(_ panel: Int) -> PanelMetricState? { onSurface ? nil : self.state(panel) }
    switch name {
    case "geodesic", "lightray":
      // (On a surface's panel, geodesic(P, d) is that surface's: not ported.)
      if onSurface && name == "geodesic" { throw Unsupported("geodesic(…)") }
      return try classifyMetricGeodesic(
        name, args, state(panel), surfaceOperand: surfaceOperand, lower: lower, constNames: constNames(),
        moving: moving())
    case "lightcone":
      if args.count != 1 { throw LanguageError(glyphUsage(name)) }
      return try classifyLightCone(
        args[0], state(panel), lower: lower, constNames: constNames(), moving: moving())
    case "tidal":
      if args.count != 1 { throw LanguageError(glyphUsage(name)) }
      return try classifyTidal(
        args[0], state(panel), spec: { try self.tides(panel) }, lower: lower, constNames: constNames(),
        moving: moving())
    default:
      return nil
    }
  }
}
