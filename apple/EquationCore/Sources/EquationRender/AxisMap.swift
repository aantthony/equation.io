import EquationCore
import Foundation

/// Axis maps: a log (or any monotone) axis as a substitution (lib/axis-map.ts).
///
/// In a panel whose row reads `view(x = 1..1000, x = 10^X)`, X is the panel's
/// linear screen coordinate — what panning and zooming move evenly — and x,
/// the coordinate every row is written in, is 10^X. The overlay needs the map
/// both ways: a row's positions are carried to the screen by the inverse
/// (`mapOverlay`), and the axis is labelled at ticks chosen on the screen and
/// named in x (`axisTicks`).
///
/// Here so far: the map, its inverse by peeling, and their evaluation. Not
/// yet: `slope` (it needs lib/diff.ts, and only shaders and flows read it),
/// sums in a map (`expandMapSums`), and `mapRowExpr`, which rewrites a row for
/// the shader passes.
public struct AxisMap: Equatable, Sendable, Codable {
  public enum Axis: String, Codable, Sendable {
    case x, y

    /// The screen coordinate's name (lib/axis-map.ts `SCREEN`).
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

  public init(axis: Axis, text: String, forward: Expr, inverse: Expr) {
    self.axis = axis
    self.text = text
    self.forward = forward
    self.inverse = inverse
  }

  // Written down as the row wrote it, and parsed again: the core's Expr is
  // not Codable, and a map that names a slider has its value in `forward`
  // already, so such a map does not survive the trip.
  private enum CodingKeys: String, CodingKey {
    case axis, text
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self = try parseAxisMap(
      try container.decode(Axis.self, forKey: .axis), try container.decode(String.self, forKey: .text))
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(axis, forKey: .axis)
    try container.encode(text, forKey: .text)
  }
}

/// A panel's maps: x and y each on their own. On the site a panel may map
/// both at once through a plane map (lib/plane-map.ts), which is not ported:
/// `mapOverlay` takes its inverse as a parameter instead (`PlaneInverse`).
public struct AxisMaps: Equatable, Sendable, Codable {
  public var x: AxisMap?
  public var y: AxisMap?

  public init(x: AxisMap? = nil, y: AxisMap? = nil) {
    self.x = x
    self.y = y
  }
}

public struct AxisMapError: Error, Equatable, Sendable, CustomStringConvertible {
  public var message: String
  public var description: String { message }
}

// MARK: - The expressions a map is built from

/// lib/expr.ts `evaluate` of a map at one value of its variable. NaN where
/// the evaluation throws, as such a map reads on the site.
func evaluateMap(_ e: Expr, _ name: String, _ value: Double) -> Double {
  (try? evaluate(e, [name: value])) ?? .nan
}

/// Each function the map may apply, and the one that undoes it.
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
/// step has no inverse here.
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

/// Parse the right side of `x = 10^X` in a view row. `env` has the sliders'
/// values: one the map names is read at its value, so the map is plain
/// numbers from here on.
public func parseAxisMap(_ axis: AxisMap.Axis, _ src: String, env: [String: Double] = [:]) throws -> AxisMap {
  let screen = axis.screen
  let text = src.trimmingCharacters(in: .whitespaces)
  let usage =
    "An axis map writes \(axis.rawValue) in terms of the screen's \(screen), like \(axis.rawValue) = 10^\(screen)."
  guard var forward = try? parseExpr(src) else { throw AxisMapError(message: usage) }
  let free = freeVars(forward).list.filter { $0 != "pi" && $0 != "e" }
  guard free.contains(screen) else { throw AxisMapError(message: usage) }
  var values: [String: Expr] = [:]
  for name in free where name != screen {
    guard let v = env[name], v.isFinite else {
      throw AxisMapError(
        message: "\(usage) It can use \(screen), numbers and sliders; \(name) has no fixed value here "
          + "(not defined, or it changes with t).")
    }
    values[name] = .num(v)
  }
  forward = substVars(forward, values)
  guard let inverse = solveFor(forward, screen, .var(axis.rawValue)) else {
    throw AxisMapError(
      message: "\(axis.rawValue) = \(text) has no inverse that can be worked out, and the axis needs one: "
        + "build it from exp, ln, log, powers, sqrt, sinh and arithmetic.")
  }
  let map = AxisMap(axis: axis, text: text, forward: forward, inverse: inverse)
  guard increasing(map) else {
    throw AxisMapError(message: "\(axis.rawValue) = \(text) must increase with \(screen) wherever it is defined.")
  }
  return map
}

/// Whether the map increases, and its inverse undoes it, at every sampled
/// screen coordinate where it is defined: the peeled inverse takes one branch,
/// so X^2 is undone only for X ≥ 0, and -X runs the window backwards.
private func increasing(_ map: AxisMap) -> Bool {
  var last = -Double.infinity
  for k in -100...100 {
    let s = Double(k) / 10
    let v = toWorld(map, s)
    if !v.isFinite { continue }
    if v <= last || !(abs(toScreen(map, v) - s) <= 1e-6 * max(1, abs(s))) { return false }
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
  return abs(toWorld(map, at) - v) <= 1e-9 * max(1, abs(v)) ? at : .nan
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
