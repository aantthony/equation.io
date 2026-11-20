#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

/// Plane maps: a panel whose screen shows the plane through a map that mixes
/// its coordinates, `view((x, y) = (Y cos X, Y sin X), X = -pi..pi, Y = 0..5)`
/// (lib/plane-map.ts). The screen's X runs along the angle and Y out along
/// the radius, so circles about the origin are level lines and a spiral
/// unrolls.
///
/// It is AxisMap.swift with the axes joined. A row is drawn per pixel by
/// putting the map in for x and y; velocities and matrices are carried by its
/// Jacobian J = ∂(x, y)/∂(X, Y) instead of two slopes. What places things at
/// positions needs the way back, from (x, y) to the screen, which no peeling
/// of the map finds in general, so it is found numerically
/// (PlaneInverse.swift).
public struct PlaneMap: Equatable, Sendable {
  /// The right side as the row wrote it, for writing the row back.
  public var text: String
  /// x and y in terms of the screen's X and Y.
  public var forward: [Expr]
  /// ∂x/∂X, ∂x/∂Y, ∂y/∂X, ∂y/∂Y, in X and Y.
  public var jacobian: [Expr]
  /// The map and its Jacobian as functions (the site keeps them by the map,
  /// `compiledMaps`): made with the map, and shared by its copies.
  let program: PlaneProgram

  public init(text: String, forward: [Expr], jacobian: [Expr]) {
    self.text = text
    self.forward = forward
    self.jacobian = jacobian
    program = PlaneProgram(forward: forward, jacobian: jacobian)
  }

  public static func == (a: PlaneMap, b: PlaneMap) -> Bool {
    a.text == b.text && a.forward == b.forward && a.jacobian == b.jacobian
  }
}

/// A screen window: X from lo[0] to hi[0], Y from lo[1] to hi[1].
public struct ScreenBox: Equatable, Hashable, Sendable {
  public var lo: [Double]
  public var hi: [Double]

  public init(lo: [Double], hi: [Double]) {
    self.lo = lo
    self.hi = hi
  }
}

/// A point of the screen (X, Y), or of the plane (x, y).
public typealias ScreenPoint = (Double, Double)

private let planeUsage =
  "A plane map writes x and y in terms of the screen’s X and Y: (x, y) = (Y cos(X), Y sin(X))."

/// Parse the right side of `(x, y) = (Y cos X, Y sin X)` in a view row
/// (`parsePlaneMap`). `env` has the sliders' values: one the map names is
/// read at its value, as an axis map reads them.
public func parsePlaneMap(_ src: String, env: [String: Double] = [:]) throws -> PlaneMap {
  try parsePlaneMap(src, env: env, doc: MapDoc())
}

func parsePlaneMap(_ src: String, env: [String: Double], doc: MapDoc) throws -> PlaneMap {
  guard let parsed = try? parseExpr(src, valueNames: doc.valueNames), case .vec(let written) = parsed,
    written.count == 2
  else { throw LanguageError(planeUsage) }
  let items = try written.map { try expandMapSums($0, ["X", "Y"], env, doc) }
  // Sliders are read at their value, as an axis map reads them.
  var values: [String: Expr] = [:]
  var screen = false
  for name in freeVars(.vec(items)).list {
    if name == "X" || name == "Y" {
      screen = true
    } else if name != "pi" && name != "e" {
      guard let v = env[name], v.isFinite else {
        throw LanguageError(
          "\(planeUsage) It can use X, Y, numbers and sliders; \(name) has no fixed value here "
            + "(not defined, or it changes with t).")
      }
      values[name] = .num(v)
    }
  }
  if !screen { throw LanguageError(planeUsage) }
  let forward = items.map { substVars($0, values) }
  let text = jsTrimmed(src)
  let jacobian: [Expr]
  do {
    jacobian = [
      try diff(forward[0], "X"), try diff(forward[0], "Y"), try diff(forward[1], "X"), try diff(forward[1], "Y"),
    ]
  } catch {
    throw LanguageError(
      "(x, y) = \(text) needs a derivative, to carry flows and directions: use smooth functions.")
  }
  let map = PlaneMap(text: text, forward: forward, jacobian: jacobian)
  if !opens(map) {
    throw LanguageError("(x, y) = \(map.text) flattens the screen onto a line: x and y must vary independently.")
  }
  return map
}

/// Whether the map spreads some part of the screen over an area of the
/// plane: a map whose Jacobian vanishes everywhere shows a curve at most.
private func opens(_ map: PlaneMap) -> Bool {
  // Near the origin, and far out, for a map defined only there (ln(X - 10)).
  for scale in [1.0, 30.0] {
    for i in -5...5 {
      for j in -5...5 {
        let (a, b, c, d) = planeJacobian(map, scale * (Double(i) + 0.37), scale * (Double(j) + 0.61))
        if abs(a * d - b * c) > 1e-9 { return true }
      }
    }
  }
  return false
}

/// One expression in X and Y as a function (`fn`): closures where the site
/// runs lib/vm.ts's program, the tree walker for what they do not cover. NaN
/// where the evaluation throws.
typealias PlaneFn = @Sendable (_ X: Double, _ Y: Double) -> Double

private func planeFn(_ e: Expr) -> PlaneFn {
  /// Anything else: the tree-walking evaluator.
  func walked() -> PlaneFn {
    { X, Y in (try? evaluate(e, ["X": X, "Y": Y])) ?? .nan }
  }
  switch e {
  case .num(let value):
    return { _, _ in value }
  case .var("X"):
    return { X, _ in X }
  case .var("Y"):
    return { _, Y in Y }
  case .neg(let a):
    let f = planeFn(a)
    return { -f($0, $1) }
  case .bin(let op, let l, let r, _):
    let (a, b) = (planeFn(l), planeFn(r))
    switch op {
    case .add: return { a($0, $1) + b($0, $1) }
    case .sub: return { a($0, $1) - b($0, $1) }
    case .mul: return { a($0, $1) * b($0, $1) }
    case .div: return { a($0, $1) / b($0, $1) }
    case .pow: return { realPow(a($0, $1), b($0, $1)) }
    }
  case .call(let name, let args):
    // (A Σ left for evaluate, a recurrence's term: walked.)
    guard boundSumIndex(e) == nil, name != TERM_AT_FN, let fn = evalFunctions[name] else { return walked() }
    let compiled = args.map(planeFn)
    switch compiled.count {
    case 1:
      let a = compiled[0]
      return { fn([a($0, $1)]) }
    case 2:
      let (a, b) = (compiled[0], compiled[1])
      return { fn([a($0, $1), b($0, $1)]) }
    default:
      return { X, Y in fn(compiled.map { $0(X, Y) }) }
    }
  default:
    return walked()
  }
}

/// A plane map's x and y, and its Jacobian, as functions (`Compiled`).
final class PlaneProgram: Sendable {
  private let fx: PlaneFn
  private let fy: PlaneFn
  private let js: [PlaneFn]

  init(forward: [Expr], jacobian: [Expr]) {
    // A tree naming anything but X and Y is one the site's compiler declines:
    // walked whole, so it is NaN wherever the walk reaches that name.
    func fn(_ e: Expr) -> PlaneFn {
      if freeVars(e).allSatisfy({ $0 == "X" || $0 == "Y" }) { return planeFn(e) }
      return { X, Y in (try? evaluate(e, ["X": X, "Y": Y])) ?? .nan }
    }
    fx = fn(forward[0])
    fy = fn(forward[1])
    js = jacobian.map(fn)
  }

  /// The world point (x, y) the screen shows at (X, Y).
  @inline(__always) func f(_ X: Double, _ Y: Double) -> ScreenPoint { (fx(X, Y), fy(X, Y)) }

  /// ∂x/∂X, ∂x/∂Y, ∂y/∂X, ∂y/∂Y at screen point (X, Y).
  @inline(__always) func j(_ X: Double, _ Y: Double) -> (Double, Double, Double, Double) {
    (js[0](X, Y), js[1](X, Y), js[2](X, Y), js[3](X, Y))
  }
}

/// The world point (x, y) the screen shows at (X, Y).
public func planeToWorld(_ map: PlaneMap, _ X: Double, _ Y: Double) -> ScreenPoint {
  map.program.f(X, Y)
}

/// ∂x/∂X, ∂x/∂Y, ∂y/∂X, ∂y/∂Y at screen point (X, Y).
public func planeJacobian(_ map: PlaneMap, _ X: Double, _ Y: Double) -> (Double, Double, Double, Double) {
  map.program.j(X, Y)
}

/// How far x and y move across one pixel at screen point (X, Y), a pixel
/// being ux by uy in screen units: the rows of the Jacobian, scaled.
public func pixelSpan(_ map: PlaneMap, _ X: Double, _ Y: Double, _ ux: Double, _ uy: Double) -> ScreenPoint {
  let (a, b, c, d) = planeJacobian(map, X, Y)
  return (hypot(a * ux, b * uy), hypot(c * ux, d * uy))
}

/// The part of the plane screen window `box` shows, as a box in x and y
/// (sampled), or nil when it shows none.
public func planeWorldBox(_ map: PlaneMap, _ box: ScreenBox) -> ScreenBox? {
  let n = 32
  var lo = [Double.infinity, .infinity]
  var hi = [-Double.infinity, -.infinity]
  for i in 0...n {
    for j in 0...n {
      let (x, y) = planeToWorld(
        map, box.lo[0] + (box.hi[0] - box.lo[0]) * Double(i) / Double(n),
        box.lo[1] + (box.hi[1] - box.lo[1]) * Double(j) / Double(n))
      if !x.isFinite || !y.isFinite { continue }
      lo[0] = min(lo[0], x)
      lo[1] = min(lo[1], y)
      hi[0] = max(hi[0], x)
      hi[1] = max(hi[1], y)
    }
  }
  return lo[0] <= hi[0] && lo[1] <= hi[1] ? ScreenBox(lo: lo, hi: hi) : nil
}

/// The map's x and y, and its Jacobian, with the screen's X and Y called x
/// and y — the renderer's x and y are the screen's (`planeIn`).
public func planeIn(_ map: PlaneMap) -> (forward: [Expr], jacobian: [Expr]) {
  func rename(_ e: Expr) -> Expr { substVars(e, ["X": .var("x"), "Y": .var("y")]) }
  return (map.forward.map(rename), map.jacobian.map(rename))
}

/// mapRowExpr through a plane map: x and y replaced by the map everywhere, a
/// graph included (on the unrolled polar screen, y = x^2 is no graph of
/// anything). A velocity is carried back by the Jacobian, J⁻¹ (P, Q)
/// (lib/axis-map.ts `mapPlaneExpr`).
func mapPlaneExpr(_ e: Expr, _ plane: PlaneMap, flow: Bool) throws -> Expr {
  let (forward, jacobian) = planeIn(plane)
  let env = ["x": forward[0], "y": forward[1]]
  if !flow { return substVars(e, env) }
  let velocity: [Expr]?
  if case .vec(let items) = e { velocity = items } else { velocity = try matchODE(e) }
  guard let velocity, velocity.count == 2 else { throw LanguageError(unmappedMessage) }
  let (P, Q) = (substVars(velocity[0], env), substVars(velocity[1], env))
  let (a, b, c, d) = (jacobian[0], jacobian[1], jacobian[2], jacobian[3])
  let det = Expr.bin(.sub, .bin(.mul, a, d), .bin(.mul, b, c))
  return .vec([
    .bin(.div, .bin(.sub, .bin(.mul, d, P), .bin(.mul, b, Q)), det),
    .bin(.div, .bin(.sub, .bin(.mul, a, Q), .bin(.mul, c, P)), det),
  ])
}

/// A coordinate field as a plane-mapped panel grids it: its level lines,
/// drawn on the screen through the map (web/scene.ts `planeGridField`). Nil
/// when the shaders cannot draw it there.
public func planeGridField(_ field: GridField, _ plane: PlaneMap) -> GridField? {
  let forward = planeIn(plane).forward
  let expr = substVars(field.cpu.expr, ["x": forward[0], "y": forward[1]])
  return planeGridField(LevelSetSpec(name: field.name, expr: expr, params: field.cpu.params, level: nil), field.panel)
}

/// x or y itself as a plane-mapped panel grids it: curves on the screen.
public func planeGridField(axis: AxisMap.Axis, _ plane: PlaneMap) -> GridField? {
  let forward = planeIn(plane).forward
  let spec = LevelSetSpec(name: axis.rawValue, expr: forward[axis == .x ? 0 : 1], params: [], level: nil)
  return planeGridField(spec, 0)
}

private func planeGridField(_ spec: LevelSetSpec, _ panel: Int) -> GridField? {
  guard let cpu = try? compileGridCpu(spec), let gpu = try? compileGridGpu(spec) else { return nil }
  return GridField(cpu: cpu, gpu: gpu, panel: panel)
}
