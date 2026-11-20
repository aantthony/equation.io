/// Axis maps: a log (or any monotone) axis as a substitution, the way
/// `u = interval(0, 2pi)` rescales u (lib/axis-map.ts).
///
/// In a panel whose row reads `view(x = 1..1000, x = 10^X)`, X is the panel's
/// linear screen coordinate — what panning and zooming move evenly — and x,
/// the coordinate every row is written in, is 10^X. A row is drawn by putting
/// the map in for x, so `y = x^2` draws as `y = (10^X)^2` against the screen:
/// shaders, gradients and antialiasing see an ordinary expression in the
/// screen's coordinates and need no axis of their own. Y maps y the same way.
///
/// The map must be invertible, because the window is written in x units and a
/// graph `y = f` stays a graph only as Y = g⁻¹(f). The inverse is found by
/// peeling the map one step at a time (exp ↔ ln, 10^ ↔ log, affine, powers),
/// which covers the log, log-log, sqrt and symlog (sinh) axes; a map it cannot
/// peel is an error rather than a guess.
///
/// Not ported: Σ and Π in a map (lib/defs.ts `expandMapSums` writes them out;
/// sums are not ported, so such a map is not supported), and a tensor field's
/// Jacobian (`tensorJacobian`: tensor fields are not ported).
public struct AxisMap: Equatable, Sendable {
  public enum Axis: String, Sendable {
    case x, y

    /// The screen coordinate's name (`SCREEN`).
    public var screen: String { self == .x ? "X" : "Y" }
  }

  /// The world coordinate, x or y.
  public var axis: Axis
  /// As the row wrote it, for writing the row back.
  public var text: String
  /// The world coordinate in terms of the screen one (X or Y).
  public var forward: Expr
  /// The screen coordinate in terms of the world one (x or y).
  public var inverse: Expr
  /// d(world)/d(screen), in the screen coordinate: how fast x moves per X,
  /// which divides a velocity in x into one on the screen.
  public var slope: Expr

  public init(axis: Axis, text: String, forward: Expr, inverse: Expr, slope: Expr) {
    self.axis = axis
    self.text = text
    self.forward = forward
    self.inverse = inverse
    self.slope = slope
  }
}

/// A panel's maps: x and y each on their own, or both at once through a
/// plane map (lib/plane-map.ts), which a view row never mixes with them. The
/// plane map is not ported: a view with one is not supported.
public struct AxisMaps: Equatable, Sendable {
  public var x: AxisMap?
  public var y: AxisMap?

  public init(x: AxisMap? = nil, y: AxisMap? = nil) {
    self.x = x
    self.y = y
  }

  public subscript(axis: AxisMap.Axis) -> AxisMap? { axis == .x ? x : y }
}

// MARK: - The expressions a map is built from

/// lib/expr.ts `evaluate` of a map at one value of its variable. NaN where
/// the evaluation throws, as such a map reads on the site.
func evaluateMap(_ e: Expr, _ name: String, _ value: Double) -> Double {
  (try? evaluate(e, [name: value])) ?? .nan
}

/// Each function the map may apply, and the one that undoes it (`INVERSE_FN`).
private func inverseFn(_ name: String, _ w: Expr) -> Expr? {
  switch name {
  case "exp": .call("ln", [w])
  case "ln": .call("exp", [w])
  case "log": .bin(.pow, .num(10), w)
  case "log2": .bin(.pow, .num(2), w)
  case "sqrt": .bin(.pow, w, .num(2))
  case "sinh": .call("asinh", [w])
  case "asinh": .call("sinh", [w])
  case "tanh": .call("atanh", [w])
  case "atanh": .call("tanh", [w])
  default: nil
  }
}

/// s such that f(s) = target, peeling f from the outside in; nil when some
/// step has no inverse here (`solveFor`).
private func solveFor(_ f: Expr, _ s: String, _ target: Expr) -> Expr? {
  let has = { (e: Expr) in freeVars(e).contains(s) }
  switch f {
  case .var(let name) where name == s: return target
  case .neg(let a): return solveFor(a, s, .neg(target))
  case .call(let name, let args) where args.count == 1:
    return inverseFn(name, target).flatMap { solveFor(args[0], s, $0) }
  case .bin(let op, let a, let b, _):
    let (inA, inB) = (has(a), has(b))
    if inA == inB { return nil }
    switch op {
    case .add: return inA ? solveFor(a, s, .bin(.sub, target, b)) : solveFor(b, s, .bin(.sub, target, a))
    case .sub: return inA ? solveFor(a, s, .bin(.add, target, b)) : solveFor(b, s, .bin(.sub, a, target))
    case .mul: return inA ? solveFor(a, s, .bin(.div, target, b)) : solveFor(b, s, .bin(.div, target, a))
    case .div: return inA ? solveFor(a, s, .bin(.mul, target, b)) : solveFor(b, s, .bin(.div, a, target))
    case .pow:
      // s^p undone by the p-th root; b^s by the log base b.
      return inA
        ? solveFor(a, s, .bin(.pow, target, .bin(.div, .num(1), b)))
        : solveFor(b, s, .bin(.div, .call("ln", [target]), .call("ln", [a])))
    }
  default: return nil
  }
}

/// Whether a map's expression writes a Σ or Π anywhere, which
/// `expandMapSums` would write out term by term.
private func hasSum(_ e: Expr) -> Bool {
  switch e {
  case .call(let name, _) where name == "sum" || name == "prod" || name == "int": return true
  case .var(let name) where name == "sum" || name == "prod" || name == "int": return true
  default: return childrenOf(e).contains(where: hasSum)
  }
}

/// Parse the right side of `x = 10^X` in a view row (`parseAxisMap`). `env`
/// has the sliders' values: one the map names is read at its value, so the
/// map is plain numbers from here on. `documentNames` are the names the
/// document defines, which a bare function name may be one of.
public func parseAxisMap(
  _ axis: AxisMap.Axis, _ src: String, env: [String: Double] = [:], documentNames: Set<String> = []
) throws -> AxisMap {
  let screen = axis.screen
  let text = jsTrimmed(src)
  let usage =
    "An axis map writes \(axis.rawValue) in terms of the screen's \(screen), like \(axis.rawValue) = 10^\(screen)."
  guard var forward = try? parseExpr(src) else { throw LanguageError(usage) }
  if hasSum(forward) { throw Unsupported("sums in a view's map") }
  // A bare function name (`cos X`) would otherwise read as a name with no value (`expandMapSums`).
  for v in freeVars(forward).list where builtinFn(v) == v && env[v] == nil && !documentNames.contains(v) {
    throw LanguageError("\(v) is a function — write it with parentheses, e.g. \(v)(\(screen)).")
  }
  let free = freeVars(forward).list.filter { $0 != "pi" && $0 != "e" }
  guard free.contains(screen) else { throw LanguageError(usage) }
  // A slider (`x = b^X`) is read at its value, so the map is plain numbers
  // from here on.
  var values: [String: Expr] = [:]
  for name in free where name != screen {
    guard let v = env[name], v.isFinite else {
      throw LanguageError(
        "\(usage) It can use \(screen), numbers and sliders; \(name) has no fixed value here "
          + "(not defined, or it changes with t).")
    }
    values[name] = .num(v)
  }
  forward = substVars(forward, values)
  guard let inverse = solveFor(forward, screen, .var(axis.rawValue)) else {
    throw LanguageError(
      "\(axis.rawValue) = \(text) has no inverse that can be worked out, and the axis needs one: "
        + "build it from exp, ln, log, powers, sqrt, sinh and arithmetic.")
  }
  let slope: Expr
  do {
    slope = try diff(forward, screen)
  } catch {
    throw LanguageError(error.message)
  }
  let map = AxisMap(axis: axis, text: text, forward: forward, inverse: inverse, slope: slope)
  guard increasing(map) else {
    throw LanguageError("\(axis.rawValue) = \(text) must increase with \(screen) wherever it is defined.")
  }
  return map
}

/// Whether the map increases, and its inverse undoes it, at every sampled
/// screen coordinate where it is defined: the peeled inverse takes one branch,
/// so X^2 is undone only for X ≥ 0, and -X runs the window backwards. Where
/// the map is undefined (ln(X) for X ≤ 0) is the window's business.
private func increasing(_ map: AxisMap) -> Bool {
  var last = -Double.infinity
  for k in -100...100 {
    let s = Double(k) / 10
    let v = toWorld(map, s)
    if !v.isFinite { continue }
    if v <= last || !(abs(toScreen(map, v) - s) <= 1e-6 * JS.max([1, abs(s)])) { return false }
    last = v
  }
  return last.isFinite
}

/// The screen coordinate showing world value v, NaN when none does. The
/// inverse may name values the map never reaches (y = sqrt(Y) has Y = y^2,
/// which sends y = -3 to 9): only a round trip shows v is there.
public func toScreen(_ map: AxisMap, _ v: Double) -> Double {
  let at = evaluateMap(map.inverse, map.axis.rawValue, v)
  if !at.isFinite { return at }
  return abs(toWorld(map, at) - v) <= 1e-9 * JS.max([1, abs(v)]) ? at : .nan
}

/// Where the screen shows world value v, or the edge (±infinity) past which
/// it lies when the map cannot show it: y = 0 on a log axis is below every
/// value it shows. Bars and integrals stand on y = 0 there.
public func toScreenOrEdge(_ map: AxisMap, _ v: Double) -> Double {
  let at = toScreen(map, v)
  if at.isFinite || v.isNaN { return at }
  return toWorld(map, 0) > v ? -.infinity : .infinity
}

/// The world value at screen coordinate s.
public func toWorld(_ map: AxisMap, _ s: Double) -> Double {
  evaluateMap(map.forward, map.axis.screen, s)
}

/// A view row's window, given in world units, as screen coordinates. The map
/// must take both ends somewhere, in order: `x = 10^X` with x = -1..10 has no
/// screen place for -1 (`windowToScreen`).
public func windowToScreen(_ map: AxisMap, _ lo: Double, _ hi: Double) throws -> [Double] {
  let (a, b) = (toScreen(map, lo), toScreen(map, hi))
  func back(_ s: Double, _ v: Double) -> Bool { abs(toWorld(map, s) - v) <= 1e-9 * JS.max([1, abs(v)]) }
  let axis = map.axis.rawValue
  if !a.isFinite || !b.isFinite || !back(a, lo) || !back(b, hi) {
    throw LanguageError(
      "view \(axis) range \(JS.string(lo))..\(JS.string(hi)) reaches past what \(axis) = \(map.text) can show.")
  }
  if a >= b { throw LanguageError("\(axis) = \(map.text) must increase with \(map.axis.screen).") }
  return [a, b]
}

/// Whether screen window [a, b] shows only world values the map can name:
/// a pan past ln(X)'s X = 0 has no x to write.
public func screenWindowOk(_ map: AxisMap, _ a: Double, _ b: Double) -> Bool {
  toWorld(map, a).isFinite && toWorld(map, b).isFinite && toWorld(map, a) < toWorld(map, b)
}

/// Write the document's coordinate fields (`r = sqrt(x^2 + y^2)`, which may
/// be built from other fields) into a row, so the map reaches the x and y
/// inside them. The renderer would otherwise put them in later, unmapped.
func inlineFields(_ e: Expr, _ fields: [String: Expr]) throws -> Expr {
  var e = e
  for _ in 0..<32 {
    if !freeVars(e).contains(where: { fields[$0] != nil }) { return e }
    e = substVars(e, fields)
  }
  throw LanguageError("The coordinate fields this row uses refer to each other in a loop.")
}

/// The part of screen window [lo, hi] the map can show, as world values
/// (ln(X) shows nothing left of X = 0), or nil when it shows none of it.
public func shownRange(
  _ map: AxisMap, _ lo: Double, _ hi: Double
) -> (screen: (Double, Double), world: (Double, Double))? {
  let n = 64
  var (a, b) = (lo, hi)
  var k = 0
  while k <= n, !toWorld(map, a).isFinite {
    a = lo + (hi - lo) * Double(k) / Double(n)
    k += 1
  }
  k = 0
  while k <= n, !toWorld(map, b).isFinite {
    b = hi - (hi - lo) * Double(k) / Double(n)
    k += 1
  }
  let (wa, wb) = (toWorld(map, a), toWorld(map, b))
  guard a < b, wa.isFinite, wb.isFinite else { return nil }
  return ((a, b), (wa, wb))
}

// MARK: - A row on a mapped panel

/// The map's world coordinate written in the screen one, with the screen
/// coordinate called by the world's name — the renderer's x is the screen.
private func forwardIn(_ map: AxisMap) -> Expr {
  substVars(map.forward, [map.axis.screen: .var(map.axis.rawValue)])
}

/// The map's slope with the screen coordinate called by the world's name.
private func slopeIn(_ map: AxisMap) -> Expr {
  substVars(map.slope, [map.axis.screen: .var(map.axis.rawValue)])
}

/// g⁻¹(e) for map g: the screen coordinate at which the world one is e.
private func inverseOf(_ map: AxisMap, _ e: Expr) -> Expr {
  substVars(map.inverse, [map.axis.rawValue: e])
}

let unmappedMessage =
  "This panel's view(…) maps its axes, which draw curves, regions, fields, points, figures and histograms — "
  + "not this yet."

/// A row's expression as the mapped panel draws it, in screen coordinates. A
/// graph y = f keeps its shape, y = g⁻¹(f(…)), and so does x = f; everything
/// else has x and y replaced by the map (`mapRowExpr`). With `flow`, the row
/// is a velocity in x and y.
func mapRowExpr(_ e: Expr, _ maps: AxisMaps, flow: Bool = false) throws -> Expr {
  var env: [String: Expr] = [:]
  for map in [maps.x, maps.y] {
    if let map { env[map.axis.rawValue] = forwardIn(map) }
  }
  if flow {
    // A velocity in x and y is one on the screen times the map's slope
    // there: x = g(X) moves at g'(X) dX/dt. So arrows, streamlines and traced
    // trajectories all run on the screen as they do anywhere else.
    let velocity: [Expr]?
    if case .vec(let items) = e { velocity = items } else { velocity = try matchODE(e) }
    guard let velocity, velocity.count == 2 else { throw LanguageError(unmappedMessage) }
    return .vec(
      zip([AxisMap.Axis.x, .y], velocity).map { axis, item in
        let carried = substVars(item, env)
        return maps[axis].map { .bin(.div, carried, slopeIn($0)) } ?? carried
      })
  }
  if case .eq(let l, let r) = e {
    for axis in [AxisMap.Axis.y, .x] {
      let name = axis.rawValue
      let lhs: Expr
      let rhs: Expr
      if case .var(name) = l {
        (lhs, rhs) = (l, r)
      } else if case .var(name) = r {
        (lhs, rhs) = (r, l)
      } else {
        continue
      }
      if freeVars(rhs).contains(name) { continue }
      // The first form found decides, so y = x stays a graph of y.
      let side = substVars(rhs, env)
      return .eq(lhs, maps[axis].map { inverseOf($0, side) } ?? side)
    }
  }
  return substVars(e, env)
}

/// A classified row as its mapped panel draws it (lib/analysis.ts, where a
/// row is classified): what places points is left as it is, to be carried
/// when drawn; what is drawn per pixel is classified again from the row
/// rewritten in screen coordinates. `lowered` is the row as `plain` was
/// classified from it.
func classifyMapped(
  _ plain: Classified, _ lowered: Expr, _ maps: AxisMaps, defined: Set<String>, fields: [String: Expr]
) throws -> Classified {
  guard let how = plain.needs3D ? AxisMapping.refused : axisMapping(plain.object) else {
    throw Unsupported("this kind of row on mapped axes")
  }
  switch how {
  case .refused: throw LanguageError(unmappedMessage)
  case .place, .none: return plain
  case .substitute:
    var flow = false
    if case .vectorField = plain.object { flow = true }
    return try classify(try mapRowExpr(try inlineFields(lowered, fields), maps, flow: flow), defined: defined, fields: fields)
  }
}

/// How a mapped panel draws an object (`AxisMapping`):
///
/// - `substitute`: drawn per pixel from x and y (graphs, implicit curves,
///   regions, fields), so the row is rewritten by `mapRowExpr` and the shader
///   sees screen coordinates;
/// - `place`: it puts things at positions (points, parametric curves), so it
///   is computed in x and y as anywhere else and each position it produces
///   is carried to the screen by the inverse (EquationRender `mapOverlay`);
/// - `none`: nothing drawn, or drawn by its own rule (a value, a note);
/// - `refused`: the site says it cannot draw the object there.
public enum AxisMapping: Sendable {
  case substitute, place, none, refused
}

/// `axisMapping`, for the kinds the port classifies. A kind that joins
/// `MathObject` without a case here is not supported on a mapped panel
/// (nil), rather than drawn in the wrong place.
public func axisMapping(_ object: MathObject) -> AxisMapping? {
  switch object {
  case .value, .note: return AxisMapping.none
  case .curveGraph, .curveImplicit, .region, .scalarField: return .substitute
  case .curveParametric, .point: return .place
  // Rewritten with the map's slope (`mapRowExpr`): a 2D flow only.
  case .vectorField(let components): return components.count == 2 ? .substitute : .refused
  default: return nil
  }
}
