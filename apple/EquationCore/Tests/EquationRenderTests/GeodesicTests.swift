import Foundation
import Testing

@testable import EquationCore
@testable import EquationRender

/// Geodesic rows as Document3D draws them (web/scene.ts, the 'geodesic' case
/// of renderPanel, over lib/surface-geometry.ts `geodesicPath`).
@Suite struct Geodesics {
  private func document(_ rows: [String]) -> Document3D {
    let analysis = analyze(rows)
    let colors = Graph2D.colors(analysis, ids: Array(rows.indices), previous: [:], theme: .light).colors
    return Document3D(analysis, colors: colors)
  }

  private func spec(_ rows: [String]) -> GeodesicSpec? {
    guard case .geodesic(let spec)? = analyze(rows).rows.last?.cpu else { return nil }
    return spec
  }

  @Test func onASphereItIsAGreatCircle() throws {
    let sphere = "S = (cos(2 pi u) sin(pi v), sin(2 pi u) sin(pi v), cos(pi v))"
    let spec = try #require(spec([sphere, "geodesic(S, (0.1, 0.5), (1, 1), 3)"]))
    var ended = GeodesicEnd()
    let pts = geodesicPath(spec, [:], ended: &ended)
    #expect(pts.count >= 3 * 50 && !ended.budget && abs(ended.length - 3) < 1e-12)
    // Every point on the unit sphere, and in one plane through the centre:
    // the plane of the start and the first step.
    let p = stride(from: 0, to: pts.count, by: 3).map { [pts[$0], pts[$0 + 1], pts[$0 + 2]] }
    func cross(_ a: [Double], _ b: [Double]) -> [Double] {
      [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
    }
    func dot(_ a: [Double], _ b: [Double]) -> Double { a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
    let normal = cross(p[0], p[p.count / 3])
    let size = dot(normal, normal).squareRoot()
    for q in p {
      #expect(abs(dot(q, q) - 1) < 1e-9)
      #expect(abs(dot(q, normal)) / size < 1e-6)
    }
    // Unit speed: the chords add up to the arc asked for.
    let length = zip(p, p.dropFirst()).reduce(0.0) { sum, pair in
      let d = [pair.1[0] - pair.0[0], pair.1[1] - pair.0[1], pair.1[2] - pair.0[2]]
      return sum + dot(d, d).squareRoot()
    }
    #expect(abs(length - 3) < 1e-3)
  }

  @Test func itStopsAtTheEdgeOfItsSurface() throws {
    // On a plane a geodesic is a straight line, cut where u leaves [0, 1].
    let spec = try #require(spec(["geodesic((u, v, 0), (0.5, 0.5), (1, 0))"]))
    var ended = GeodesicEnd()
    let pts = geodesicPath(spec, [:], ended: &ended)
    #expect(pts.suffix(3) == [1, 0.5, 0])
    #expect(pts.prefix(3) == [0.5, 0.5, 0])
  }

  @Test func aBudgetCutIsNoted() throws {
    let torus = "S = ((3 + cos(2 pi v)) cos(2 pi u), (3 + cos(2 pi v)) sin(2 pi u), sin(2 pi v))"
    let spec = try #require(spec([torus, "geodesic(S, (0, 0.1), (1, 1), 1000)"]))
    var ended = GeodesicEnd()
    _ = geodesicPath(spec, [:], maxSteps: 40, ended: &ended)
    #expect(ended.budget && ended.length < 1000)
    #expect(geodesicCutNote(ended)?.hasPrefix("cut short at L ≈ ") == true)
    #expect(geodesicCutNote(ended)?.hasSuffix(" of 1000") == true)
  }

  @Test func aRowDrawsItsCurveAndAFamilyOnePerMember() {
    let one = document(["S = (u, v, u^2 - v^2)", "geodesic(S, (0.5, 0.5), (1, 0))"])
    let scene = one.scene(at: 0, camera: Camera3D())
    #expect(scene.curves.count == 1 && scene.curves[0].pts.count >= 6)
    #expect(one.geodesicNote(row: 1) == nil)
    let family = document(["S = (u, v, u^2 - v^2)", "a = [0..3] pi/2", "geodesic(S, (0.5, 0.5), (cos(a), sin(a)))"])
    #expect(family.scene(at: 0, camera: Camera3D()).curves.count == 4)
  }

  @Test func onAPanelsSurfaceItRunsInXAndY() {
    let rows = [
      "on((X, Y, Z) = ((3 + cos(y)) cos(x), (3 + cos(y)) sin(x), sin(y)), x = -pi..pi, y = -pi..pi)",
      "gaussian(x, y)", "geodesic((0, 0), (1, 0), 4)",
    ]
    let scene = document(rows).scene(at: 0, camera: Camera3D(radius: 11))
    // Round the outer equator, radius 4: every point at that distance from the axis, near z = 0.
    let curve = scene.curves.last!.pts.map(Double.init)
    for k in stride(from: 0, to: curve.count, by: 3) {
      #expect(abs((curve[k] * curve[k] + curve[k + 1] * curve[k + 1]).squareRoot() - 4) < 0.1)
      #expect(abs(curve[k + 2]) < 0.1)
    }
    // The torus's curvature is shaded to its own size: 1.5 over its typical |K|.
    let gain = scene.paints?.first?.paint.gain
    #expect(gain != nil && gain! > 1.5 && gain! < 20)
  }
}
