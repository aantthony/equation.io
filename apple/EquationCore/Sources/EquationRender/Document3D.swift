import EquationCore
import Foundation

/// Whether a document is drawn in the plane or in space.
public enum Graph {
  public enum Kind: Equatable, Sendable {
    /// Drawn by `Graph2D`.
    case plane
    /// Drawn by `Document3D`.
    case space
  }

  /// A document is drawn in space as soon as one of its rows needs it (a
  /// surface, a point or curve with three coordinates, …), as web/main.ts
  /// sets a panel's mode. Its 2D rows are then drawn in space too: a curve
  /// as the sheet it extrudes to, a point in the plane z = 0.
  ///
  /// The site decides this per panel. Rows in error or not supported are
  /// not counted, so for one panel's answer pass the analysis with the other
  /// panels' rows masked out, as for its `Graph2D`; `Document3D` skips the
  /// same rows.
  public static func kind(of analysis: DocumentAnalysis) -> Kind {
    analysis.rows.contains { $0.error == nil && $0.unsupported == nil && $0.classified?.needs3D == true }
      ? .space : .plane
  }
}

/// From what the language makes of a document (EquationCore `analyze`) to
/// what the 3D renderer draws: web/main.ts `renderPanel` for a panel in
/// space, between a row's plans and the renderer's `Scene3D`. `Graph2D`'s
/// counterpart; the app and metal-shot both draw through here.
///
///     let analysis = analyze(rows)
///     guard Graph.kind(of: analysis) == .space else { … Graph2D … }
///     let colors = Graph2D.colors(analysis, ids: ids, previous: [:], theme: theme).colors
///     let document = Document3D(analysis, colors: colors)
///     var camera = document.camera                  // the opening camera; gestures move it
///     let scene = document.scene(at: time, camera: camera)
///     renderer.render(…, cam: camera, scene: scene, time: time, env: document.environment(at: time),
///                     frame: Frame2D(grid: document.grid), …)
///
/// A scene depends on the camera as well as the time: what is solved or
/// traced on the CPU (intersections, systems, a field's streamlines, a
/// cloud's scale) is found over the box the camera looks at, padded so that
/// small pans and zooms stay inside it. Those are kept from frame to frame
/// until the camera leaves that box or a value they read changes.
public struct Document3D: Equatable, Sendable {
  public var analysis: DocumentAnalysis
  /// Each row's color, or nil for a row that takes none (`Graph2D.colors`).
  public var colors: [RGB?]
  /// How much of the grid is drawn (a `grid(…)` row).
  public var grid: Frame2D.Grid = .on
  /// The camera the graph opens with: the default, or what a `camera(…)` row asks for.
  public var camera = Camera3D()
  /// A `camera(…)` row's spin, in radians per second about the vertical: the
  /// view turns by itself (theta = the row's theta + spin · t).
  public var spin: Double?
  /// A `camera(…, locked)` row pins the view against gestures.
  public var locked = false
  /// Something moves with t, so the graph redraws every frame.
  public var animated = false
  /// The rows (by index) whose vector field is drawn as moving streamlines,
  /// and as arrows: toggles the site keeps outside the text. Neither: its
  /// integral curves.
  public var streamlines: Set<Int> = []
  public var arrows: Set<Int> = []

  /// What was traced on the CPU, kept between frames.
  private let traces = TraceCache()

  /// Samples along a parametric curve (lib/path.ts `CURVE_SAMPLES`).
  static let curveSamples = 400
  static let tubeSegments = 24

  public init(_ analysis: DocumentAnalysis, colors: [RGB?]) {
    self.analysis = analysis
    self.colors = colors
    animated = !analysis.animated.isEmpty
    for row in analysis.rows {
      switch row.view {
      case .grid(let mode)?: grid = Frame2D.Grid(rawValue: mode) ?? .on
      case .camera(let theta, let phi, let radius, let target, let spin, let locked)?:
        // web/main.ts applyViewSpecs: what the row leaves out is the default.
        camera = Camera3D(
          target: target.flatMap { $0.count == 3 ? SIMD3($0[0], $0[1], $0[2]) : nil } ?? .zero,
          radius: radius ?? 14, theta: theta, phi: clampPhi(phi))
        self.spin = spin
        self.locked = locked
      default: break
      }
      if row.error == nil, row.unsupported == nil, row.classified?.animated == true { animated = true }
    }
    if let spin, spin != 0 { animated = true }
  }

  /// The constants' values `time` seconds after the graph opened: what the uniforms read.
  public func environment(at time: Double) -> [String: Double] {
    analysis.environment(at: time)
  }

  /// The frame written down, for a picture of it (`MetalContext.image`):
  /// from `camera`, or else the opening camera turned by its spin.
  public func graph(at time: Double, camera: Camera3D? = nil) -> Graph3D {
    var cam = camera ?? self.camera
    if camera == nil, let spin { cam.theta += spin * time }
    return Graph3D(
      scene: scene(at: time, camera: cam), camera: cam, env: environment(at: time), frame: Frame2D(grid: grid),
      time: time)
  }

  /// Everything the rows draw at a time, seen from `camera`.
  public func scene(at time: Double, camera: Camera3D) -> Scene3D {
    var scene = Scene3D()
    var env = environment(at: time)
    env["t"] = time
    for (index, row) in analysis.rows.enumerated() {
      guard row.error == nil, row.unsupported == nil, let cpu = row.cpu, index < colors.count,
        let color = colors[index]
      else { continue }
      // A family draws member by member, each a shade lighter (web/main.ts `renderMembers`).
      for (member, shade) in Graph2D.familyMembers(row, cpu, color) {
        draw(member.cpu!, member, index, shade, env, time, camera, into: &scene)
      }
    }
    return scene
  }

  /// One row's part of the scene (the `switch (plot.type)` of renderPanel).
  private func draw(
    _ cpu: CpuPlan, _ row: RowAnalysis, _ index: Int, _ color: RGB, _ env: [String: Double], _ time: Double,
    _ camera: Camera3D, into scene: inout Scene3D
  ) {
    let params = row.gpu?.params ?? []
    // (A family member's index into the program its family shares.)
    let uniforms = Graph2D.shaderUniforms(row.gpu)
    // The box the solvers search: the camera's, padded a quarter each way so
    // small pans and zooms stay inside it (web/main.ts solveFor).
    let target = [camera.target.x, camera.target.y, camera.target.z]
    let view = TraceCache.Box(lo: target.map { $0 - cameraBoxR(camera) }, hi: target.map { $0 + cameraBoxR(camera) })
    let r = cameraBoxR(camera) * 1.5
    let (lo, hi) = (target.map { $0 - r }, target.map { $0 + r })
    /// What a traced row is kept by, besides its box: every value it reads.
    func key(_ what: String, _ moving: Bool = row.classified?.animated ?? false) -> String {
      let read = (row.classified?.params ?? []).map { "\(env[$0] ?? .nan)" }.joined(separator: ",")
      return "\(index):\(what):\(read):\(moving ? "\(time)" : "")"
    }
    /// A trace over the padded box, or the one kept from a box the view is still inside.
    func traced(_ key: String, _ trace: () -> [[[Double]]]) -> [[[Double]]] {
      traces.paths(key, view: view, box: TraceCache.Box(lo: lo, hi: hi), trace)
    }
    func value(_ e: Expr, _ scope: [String: Double]) -> Double { (try? evaluate(e, scope)) ?? .nan }
    /// A path's points as the floats the renderer takes, z = 0 for a point in the plane.
    func floats(_ path: [[Double]]) -> [Float] {
      path.flatMap { p in [Float(p[0]), Float(p[1]), p.count > 2 ? Float(p[2]) : 0] }
    }
    /// Several paths as one polyline: a NaN vertex between two lifts the pen.
    func lifted(_ paths: [[[Double]]]) -> [Float] {
      paths.flatMap { floats($0) + [Float.nan, .nan, .nan] }
    }

    switch cpu {
    case .implicit2d:
      // Extrudes to its true locus (a vertical sheet).
      guard case .implicit2d(let field, _)? = row.gpu?.shader else { break }
      scene.implicits.append(Surface3D(uniforms: uniforms, field: field, color: color, params: params))
    case .implicit3d:
      guard case .implicit3d(let field, let grad)? = row.gpu?.shader else { break }
      scene.implicits.append(Surface3D(uniforms: uniforms, field: field, color: color, params: params, grad: grad))
    case .scalar3d(let expr):
      guard case .scalar3d(let field)? = row.gpu?.shader else { break }
      // The largest the field has been since the view or a slider last
      // moved: renormalized every frame, a standing wave would never fade.
      let now = fieldScale(expr, env, camera.target, volumeRadius(camera))
      let scale = traces.largest(key("cloud:\(camera.target):\(camera.radius)", false), now)
      scene.volumes = (scene.volumes ?? []) + [Scene3D.Volume(field: field, scale: scale, color: color, params: params)]
    case .psurface(let comps, let paint):
      guard case .psurface(let glsl, let du, let dv, let painted)? = row.gpu?.shader else { break }
      // gaussian(S): shaded with the gain that brings its curvature to
      // about 1, kept until a value it reads (a slider, t) changes.
      let gain = paint.map { paint in traces.number(key("gain")) { paintGain(comps, paint, env) } }
      scene.psurfaces.append(
        Scene3D.PSurface(
          uniforms: uniforms, comps: glsl, du: du, dv: dv, color: color, params: params, paint: painted, gain: gain))
    case .pcurve(_, let comps, _, _, _):
      // (A curve in the plane lies in z = 0.)
      scene.curves.append(Scene3D.Curve(pts: Self.sample(comps, env), color: color))
    case .tube(let comps, let radius, let d1, _, _):
      // Tubes are opt-in through tube(…). The radius may use sliders and t;
      // while it evaluates ≤ 0 (say, mid slider drag) the curve draws as a
      // bare line instead of an inside-out tube.
      let pts = Self.sample(comps, env)
      let r = value(radius, env)
      if r.isFinite, r > 0 {
        let frames = curveFrames(pts, d1.map { Self.sample($0, env) })
        scene.tubes.append(buildTube(pts, frames, r, segments: Self.tubeSegments, color: color))
      } else {
        scene.curves.append(Scene3D.Curve(pts: pts, color: color))
      }
    case .point(_, let coords):
      let p = coords.map { value($0, env) }
      guard p.count >= 2, p.allSatisfy(\.isFinite) else { break }
      // A named point (`A = (1, 2, 3)`) is drawn with its name.
      scene.points.append(
        Scene3D.Point(
          pos: SIMD3(p[0], p[1], p.count > 2 ? p[2] : 0), color: color, label: row.definition?.name, group: index))
    case .label(_, let coords, let text):
      let p = coords.map { value($0, env) }
      guard p.count >= 2, p.allSatisfy(\.isFinite) else { break }
      scene.texts =
        (scene.texts ?? []) + [Scene3D.Text(pos: SIMD3(p[0], p[1], p.count > 2 ? p[2] : 0), text: text, color: color)]
    case .polygon(let dim, let pts, let closed, let arrow, let hull, let over):
      guard let vals = try? figureCoordinates(pts, over: over, env), vals.allSatisfy(\.isFinite) else { break }
      if hull {
        guard let geometry = hullGeometry(vals, dim: dim) else { break }
        // A solid's faces as one mesh, its edges in a lighter shade over them.
        let solid = !geometry.mesh.indices.isEmpty
        if solid {
          scene.tubes.append(
            Scene3D.Tube(
              positions: geometry.mesh.positions, normals: geometry.mesh.normals, uvs: geometry.mesh.uvs,
              indices: geometry.mesh.indices, cells: SIMD2(1, 1), color: color, retained: true))
        }
        scene.segments.append(
          Scene3D.Segments(pts: geometry.edges, color: solid ? color + (1 - color) * 0.55 : color, retained: true))
        break
      }
      var flat: [Double] = []
      for k in stride(from: 0, to: vals.count - dim + 1, by: dim) {
        flat += [vals[k], vals[k + 1], dim == 3 ? vals[k + 2] : 0]
      }
      // A closed polygon fills translucently when a fan from its first
      // vertex covers it exactly: triangles, convex outlines.
      let fill = closed && fanFillable(flat)
      if closed { flat += flat.prefix(3) }
      scene.curves.append(
        Scene3D.Curve(pts: flat.map { Float($0) }, color: color, arrow: arrow ? true : nil, fill: fill ? true : nil))
    case .vfield3d(let comps):
      if streamlines.contains(index), case .vfield3d(let glsl)? = row.gpu?.shader {
        scene.streamlines =
          (scene.streamlines ?? []) + [Scene3D.Streamlines(comps: glsl, color: color, params: params)]
        break
      }
      if arrows.contains(index) {
        // Arrow glyphs sample live t so an animated field stays smooth.
        let pts = lifted(traceField(comps, lo, hi, env, glyphs: true))
        if pts.count >= 6 { scene.curves.append(Scene3D.Curve(pts: pts, color: color, arrow: true)) }
        break
      }
      // Integral curves, retraced twenty times a second at most.
      var scope = env
      scope["t"] = (time * 20).rounded(.down) / 20
      let moving = row.classified?.animated ?? false
      let paths = traced("\(key("flow", false)):\(moving ? scope["t"]! : 0)") { traceField(comps, lo, hi, scope) }
      for path in paths where path.count >= 2 {
        scene.curves.append(Scene3D.Curve(pts: floats(path), color: color, fade: true))
      }
    case .spacecurve(let residuals):
      let paths = traced(key("curve")) { traceIntersection(residuals, lo, hi, env) }
      scene.curves.append(Scene3D.Curve(pts: lifted(paths), color: color))
    case .system(let dim, let residuals, let parametric, let angular):
      let vars = Array(["x", "y", "z"][..<dim])
      let (l, h) = (Array(lo[..<dim]), Array(hi[..<dim]))
      if parametric {
        let paths = traced(key("trace")) { traceSystem(residuals, vars, l, h, env, 256, angular) }
        scene.curves.append(Scene3D.Curve(pts: lifted(paths), color: color))
        break
      }
      let found = traced(key("solve")) {
        [solveSystem(residuals, vars, l, h, SolveOptions(env: env, angular: angular))]
      }
      // Each solution its own group: discrete answers, solid and full size,
      // not a cloud to shade by depth.
      for (k, p) in (found.first ?? []).enumerated() {
        scene.points.append(
          Scene3D.Point(pos: SIMD3(p[0], p[1], p.count > 2 ? p[2] : 0), color: color, group: index * 1000 + k))
      }
    case .plist(_, let pts):
      // One sprite per point of a list (Graph2D+Lists.swift has the plane's).
      for comps in pts {
        let p = comps.map { value($0, env) }
        guard p.count >= 2, p.allSatisfy(\.isFinite) else { continue }
        scene.points.append(Scene3D.Point(pos: SIMD3(p[0], p[1], p.count > 2 ? p[2] : 0), color: color, group: index))
      }
    case .dscatter(_, let coords) where coords.count >= 2:
      // A gap in any coordinate skips the point: an unplaced z would reach
      // projection and depth sorting as NaN.
      for k in coords[0].indices {
        let p = coords.map { k < $0.count ? $0[k] : .nan }
        guard p.allSatisfy(\.isFinite) else { continue }
        scene.points.append(Scene3D.Point(pos: SIMD3(p[0], p[1], p.count > 2 ? p[2] : 0), color: color, group: index))
      }
    default:
      // 2D-only plots (regions, planar fields, dot plots and bars) a 3D
      // scene leaves out (web/main.ts SKIPPED_IN_3D), and readouts, which
      // draw nothing.
      break
    }
  }

  /// A curve's samples as flat xyz floats, u from 0 to 1 (web/main.ts
  /// `sampleSpaceCurve`): a sample the curve has no value at is a gap in the line.
  static func sample(_ comps: [Expr], _ env: [String: Double]) -> [Float] {
    var out = [Float](repeating: 0, count: curveSamples * 3)
    var scope = env
    for k in 0..<curveSamples {
      scope["u"] = Double(k) / Double(curveSamples - 1)
      for (c, e) in comps.prefix(3).enumerated() { out[k * 3 + c] = Float((try? evaluate(e, scope)) ?? .nan) }
    }
    return out
  }

  /// The cache does not tell two documents apart.
  public static func == (a: Document3D, b: Document3D) -> Bool {
    a.analysis == b.analysis && a.colors == b.colors && a.grid == b.grid && a.camera == b.camera && a.spin == b.spin
      && a.locked == b.locked && a.animated == b.animated && a.streamlines == b.streamlines && a.arrows == b.arrows
  }
}

/// What a document's rows traced on the CPU, by what each was traced from: a
/// solve costs tens of milliseconds, far too much to repeat on every frame
/// (web/main.ts keeps `sysCache` and its like on each row).
final class TraceCache: @unchecked Sendable {
  private let lock = NSLock()
  /// The box a trace was made over.
  struct Box {
    var lo: [Double]
    var hi: [Double]
  }

  private var paths: [String: (box: Box, paths: [[[Double]]])] = [:]
  private var numbers: [String: Double] = [:]
  /// Oldest first.
  private var order: [String] = []

  private func remember(_ key: String) {
    order.append(key)
    if order.count > 64 {
      let old = order.removeFirst()
      paths[old] = nil
      numbers[old] = nil
    }
  }

  /// The paths kept under `key` while the box they were traced over still
  /// holds `view` and is not more than six times as wide (web/main.ts
  /// solveFor's bargain); else `trace`'s, made over `box` and kept.
  func paths(_ key: String, view: Box, box: Box, _ trace: () -> [[[Double]]]) -> [[[Double]]] {
    lock.lock()
    defer { lock.unlock() }
    if let kept = paths[key], kept.box.lo.count == view.lo.count,
      view.lo.indices.allSatisfy({ k in
        kept.box.lo[k] <= view.lo[k] && kept.box.hi[k] >= view.hi[k]
          && kept.box.hi[k] - kept.box.lo[k] <= 6 * (view.hi[k] - view.lo[k])
      })
    {
      return kept.paths
    }
    let traced = trace()
    if paths[key] == nil { remember(key) }
    paths[key] = (box, traced)
    return traced
  }

  func number(_ key: String, _ work: () -> Double) -> Double {
    lock.lock()
    defer { lock.unlock() }
    if let hit = numbers[key] { return hit }
    let value = work()
    numbers[key] = value
    remember(key)
    return value
  }

  /// The largest `now` has been under this key.
  func largest(_ key: String, _ now: Double) -> Double {
    lock.lock()
    defer { lock.unlock() }
    guard let last = numbers[key] else {
      numbers[key] = now
      remember(key)
      return now
    }
    let most = max(last, now)
    numbers[key] = most
    return most
  }
}
