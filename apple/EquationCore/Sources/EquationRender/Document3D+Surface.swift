import EquationCore
import Foundation

// A panel drawing its 2D rows on a surface (an on(…) row, the core's
// SurfaceMap.swift): the surface first, then each 2D row painted on it or
// carried onto it (web/scene.ts `renderPanel`, where a panel has a surface).
//
// Port: a vector field's arrows are worked out every frame; the site keeps
// them until a value the field reads changes.

/// A panel's surface as the shaders take it (web/scene.ts `surfaceGLSL`),
/// made once for the document.
struct SurfaceMesh: Equatable, Sendable {
  var map: SurfaceMap
  var comps: [String]
  var du: [String]?
  var dv: [String]?
  /// x and y in the mesh's u and v.
  var xy: [String]

  /// The surface of the first on(…) row that reads, or nil.
  init?(_ analysis: DocumentAnalysis) {
    for row in analysis.rows where row.error == nil && row.unsupported == nil {
      guard case .surface(let map)? = row.view, let glsl = try? surfaceGLSL(map) else { continue }
      self.map = map
      (comps, du, dv, xy) = (glsl.comps, glsl.du, glsl.dv, glsl.xy)
      return
    }
    return nil
  }
}

/// Steps a straight run in x and y is cut into on the surface, which bends it.
private let surfacePieces = 24

/// Where a scene stood before a row added to it (`markScene`).
struct SceneMark {
  var curves: Int
  var points: Int
  var texts: Int
  var segments: Int

  init(_ scene: Scene3D) {
    curves = scene.curves.count
    points = scene.points.count
    texts = scene.texts?.count ?? 0
    segments = scene.segments.count
  }
}

/// A point on a surface moved a hair toward the eye, so the surface does not
/// hide what lies exactly on it (`towardEye`).
private func towardEye(_ camera: Camera3D) -> ([Double]) -> [Double] {
  let eye = cameraEye(camera)
  let lift = 0.004 * camera.radius
  return { p in
    let to = [eye.x - p[0], eye.y - p[1], eye.z - p[2]]
    let length = (to[0] * to[0] + to[1] * to[1] + to[2] * to[2]).squareRoot()
    let d = length == 0 || length.isNaN ? 1 : length
    return (0..<3).map { p[$0] + (lift * to[$0]) / d }
  }
}

/// Carry what a 2D row added to the scene since `mark` — placed in the plane
/// z = 0 — onto the surface (`carryOntoSurface`): each point to the surface
/// point at its x and y, each line cut into pieces first (a straight run in
/// x and y is a curve on the surface). Everything is lifted a hair toward
/// the eye.
func carryOntoSurface(_ scene: inout Scene3D, since mark: SceneMark, _ surface: SurfaceMap, _ camera: Camera3D) {
  let lifted = towardEye(camera)
  func onto(_ x: Double, _ y: Double) -> [Double] { lifted(surfacePoint(surface, x, y)) }
  func line(_ pts: [Double], _ pieces: Int) -> [Float] {
    var out: [Float] = []
    var i = 0
    while i + 2 < pts.count {
      let (x0, y0) = (pts[i], pts[i + 1])
      let next = i + 5 < pts.count
      let steps = next && pts[i + 3].isFinite ? pieces : 1
      for k in 0..<steps {
        let t = Double(k) / Double(steps)
        let (x, y) = next && steps > 1 ? (x0 + (pts[i + 3] - x0) * t, y0 + (pts[i + 4] - y0) * t) : (x0, y0)
        let q = x.isFinite && y.isFinite ? onto(x, y) : nil
        // A gap where the surface is undefined, as in a sampled curve.
        if let q, q.allSatisfy(\.isFinite) { out += q.map { Float($0) } } else { out += [.nan, .nan, .nan] }
      }
      i += 3
    }
    return out
  }
  // A sampled curve is short steps already; a figure's edges are long.
  for k in min(mark.curves, scene.curves.count)..<scene.curves.count {
    let pts = scene.curves[k].pts.map(Double.init)
    scene.curves[k].pts = line(pts, pts.count > 300 ? 1 : surfacePieces)
  }
  for k in min(mark.segments, scene.segments.count)..<scene.segments.count {
    let pts = scene.segments[k].pts.map(Double.init)
    var out: [Float] = []
    var i = 0
    while i + 5 < pts.count {
      let piece = line([pts[i], pts[i + 1], 0, pts[i + 3], pts[i + 4], 0], surfacePieces)
      var j = 0
      while j + 5 < piece.count {
        let seg = piece[j..<(j + 6)]
        if seg.allSatisfy(\.isFinite) { out += seg }
        j += 3
      }
      i += 6
    }
    scene.segments[k].pts = out
    scene.segments[k].retained = false
  }
  // A point where the surface is undefined (1/x at x = 0) is not drawn.
  func place(_ pos: SIMD3<Double>) -> SIMD3<Double>? {
    let q = onto(pos.x, pos.y)
    return q.allSatisfy(\.isFinite) ? SIMD3(q[0], q[1], q[2]) : nil
  }
  let from = min(mark.points, scene.points.count)
  let points = scene.points[from...].compactMap { p -> Scene3D.Point? in
    guard let pos = place(p.pos) else { return nil }
    var q = p
    q.pos = pos
    return q
  }
  scene.points.replaceSubrange(from..., with: points)
  if var texts = scene.texts {
    let from = min(mark.texts, texts.count)
    let placed = texts[from...].compactMap { t -> Scene3D.Text? in
      guard let pos = place(t.pos) else { return nil }
      var q = t
      q.pos = pos
      return q
    }
    texts.replaceSubrange(from..., with: placed)
    scene.texts = texts
  }
}

extension Document3D {
  /// The bare surface's colour: between the page and its axes, so rows read
  /// on it in either theme (`surfaceShade`).
  var surfaceShade: RGB { theme.bg * 0.65 + theme.axis * 0.35 }

  /// The panel's surface itself, which its rows are drawn over.
  func drawSurface(_ mesh: SurfaceMesh, into scene: inout Scene3D) {
    scene.psurfaces.append(Scene3D.PSurface(comps: mesh.comps, du: mesh.du, dv: mesh.dv, color: surfaceShade))
  }

  /// A 2D row on the panel's surface: painted per pixel, or drawn in the
  /// plane z = 0 and carried onto it. False for a row in space, which draws
  /// as in any 3D panel.
  func drawOnSurface(
    _ mesh: SurfaceMesh, _ cpu: CpuPlan, _ row: RowAnalysis, _ index: Int, _ color: RGB, _ env: [String: Double],
    _ time: Double, _ camera: Camera3D, into scene: inout Scene3D
  ) -> Bool {
    guard let cls = row.classified, !cls.needs3D else { return false }
    switch surfaceMapping(cls.object) {
    case .paint?:
      let paint: SurfacePaint.Paint? =
        switch row.gpu?.shader {
        case .implicit2d(let field, _)?: .init(kind: .curve, field: field)
        case .ineq2d(let field, let edges)?: .init(kind: .region, field: field, edges: edges)
        case .scalar2d(let field)?:
          // gaussian(x, y): shaded to its own size on the surface.
          if row.autoscale, case .scalar2d(let expr) = cpu {
            .init(kind: .scalar, field: field, gain: surfaceFieldGain(mesh.map, expr, env))
          } else {
            .init(kind: .scalar, field: field)
          }
        default: nil
        }
      guard let paint else { break }
      scene.paints =
        (scene.paints ?? []) + [
          SurfacePaint(
            comps: mesh.comps, du: mesh.du, dv: mesh.dv, xy: mesh.xy, paint: paint, color: color,
            params: row.gpu?.params ?? [], uniforms: Graph2D.shaderUniforms(row.gpu))
        ]
    case .carry?:
      // A parametric region's own mesh, carried onto the surface whole.
      if case .pregion(let comps) = cpu {
        let params = row.gpu?.params ?? []
        guard let region = try? surfaceRegionGLSL(mesh.map, comps, params: params) else { break }
        scene.paints =
          (scene.paints ?? []) + [
            SurfacePaint(
              comps: region.comps, du: region.du, dv: region.dv, xy: ["u", "v"],
              paint: .init(kind: .region, field: "-1.0", edges: []), color: color, params: params,
              uniforms: Graph2D.shaderUniforms(row.gpu), lift: true)
          ]
        break
      }
      // A vector field as arrows along the surface's tangents.
      if case .vfield2d(let comps) = cpu {
        var scope = env
        let arrows = surfaceArrows(mesh.map) { x, y in
          scope["x"] = x
          scope["y"] = y
          return comps.map { (try? evaluate($0, scope)) ?? .nan }
        }
        let lifted = towardEye(camera)
        var pts: [Float] = []
        pts.reserveCapacity(arrows.count)
        for k in stride(from: 0, to: arrows.count - 2, by: 3) {
          let p = Array(arrows[k..<(k + 3)])
          // (The NaN point that parts two arrows stays one.)
          pts += lifted(p).map { Float($0) }
        }
        if !pts.isEmpty { scene.curves.append(Scene3D.Curve(pts: pts, color: color, arrow: true)) }
        break
      }
      let mark = SceneMark(scene)
      draw(cpu, row, index, color, env, time, camera, into: &scene)
      carryOntoSurface(&scene, since: mark, mesh.map, camera)
    default:
      break
    }
    return true
  }

  /// Named points in x and y (`A = (0.5, 1)`) sit on the surface, labelled.
  func drawSurfacePoints(
    _ mesh: SurfaceMesh, _ env: [String: Double], _ camera: Camera3D, into scene: inout Scene3D
  ) {
    for (index, row) in analysis.rows.enumerated() {
      guard row.error == nil, row.unsupported == nil, row.cpu == nil, let name = row.definition?.name,
        index < colors.count, let color = colors[index], let x = env["\(name)_x"], let y = env["\(name)_y"],
        env["\(name)_z"] == nil, x.isFinite, y.isFinite
      else { continue }
      let mark = SceneMark(scene)
      scene.points.append(Scene3D.Point(pos: SIMD3(x, y, 0), color: color, label: writtenName(name)))
      carryOntoSurface(&scene, since: mark, mesh.map, camera)
    }
  }
}
