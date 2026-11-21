import EquationCore
import Foundation

// Trails in a 3D panel (web/scene.ts renderPanel, case 'trail'): where a
// moving point has been, as the run saw it, and where it is now. A trail in
// the plane lies in z = 0, or on the panel's surface.

extension Document3D {
  /// Draw a `trail(…)` row: the line `run` has of it and its head, or with no
  /// run the point where it is. True when the plan is a trail.
  func drawTrail(
    _ cpu: CpuPlan, _ row: RowAnalysis, _ index: Int, _ color: RGB, _ env: [String: Double], _ camera: Camera3D,
    _ run: StateStepper?, into scene: inout Scene3D
  ) -> Bool {
    guard case .trail(let dim, let coords) = cpu else { return false }
    let mark = SceneMark(scene)
    var head: [Double]?
    if let trail = run?.trails[index] {
      // (A trail in the plane is flat: z = 0 where the point was, a gap where it was nowhere.)
      let flat = trail.line
      var pts: [Float] = []
      pts.reserveCapacity(flat.count / max(1, dim) * 3)
      for k in stride(from: 0, to: flat.count - dim + 1, by: dim) {
        pts += [Float(flat[k]), Float(flat[k + 1]), dim == 3 ? Float(flat[k + 2]) : flat[k].isFinite ? 0 : .nan]
      }
      scene.curves.append(Scene3D.Curve(pts: pts, color: color))
      head = trail.head
    } else {
      let p = coords.map { (try? evaluate($0, env)) ?? .nan }
      if p.count == dim, p.allSatisfy(\.isFinite) { head = p }
    }
    if let p = head, p.count >= 2 {
      scene.points.append(Scene3D.Point(pos: SIMD3(p[0], p[1], p.count > 2 ? p[2] : 0), color: color, group: index))
    }
    // On a surface panel a trail in x and y is carried onto the surface.
    if let surface, dim == 2, row.classified.map({ surfaceMapping($0.object) == .carry }) == true {
      carryOntoSurface(&scene, since: mark, surface.map, camera)
    }
    return true
  }
}
