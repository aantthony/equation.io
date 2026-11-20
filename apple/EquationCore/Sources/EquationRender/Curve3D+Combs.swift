import EquationCore
import Foundation

// Curvature and torsion combs of a curve in space (lib/curve3d.ts
// `curveFrames`, `buildComb`, `combScale`; web/scene.ts, case 'pcurve'):
// κ = |r′×r″|/|r′|³ and τ = (r′×r″)·r‴/|r′×r″|², from the curve's symbolic
// derivatives where the plan has them and finite differences of the samples
// otherwise, drawn as teeth along the Frenet normal and binormal. They are
// toggles the page keeps outside the text (`Document3D.combK`, `combT`).

/// Samples between a comb's teeth (web/session.ts `COMB_STEP`).
let COMB_STEP = 4

/// The Frenet directions and the curvature and torsion along a sampled curve.
struct CurveBending {
  /// Unit Frenet (principal) normal; NaN where κ vanishes.
  var frenetNormal: [Float]
  /// Unit Frenet binormal r′×r″/|r′×r″|; NaN where κ vanishes.
  var frenetBinormal: [Float]
  var kappa: [Double]
  var tau: [Double]
}

/// d/du by central differences (one-sided at the ends), u ∈ [0, 1] over n samples.
private func fdDeriv(_ src: [Float], _ n: Int) -> [Float] {
  let h = 1 / Double(n - 1)
  var out = [Float](repeating: 0, count: n * 3)
  for i in 0..<n {
    let a = i == 0 ? 0 : i - 1
    let b = i == n - 1 ? n - 1 : i + 1
    let s = 1 / (Double(b - a) * h)
    for c in 0..<3 { out[i * 3 + c] = Float((Double(src[b * 3 + c]) - Double(src[a * 3 + c])) * s) }
  }
  return out
}

private func finite3(_ a: [Float], _ i: Int) -> Bool {
  a[i * 3].isFinite && a[i * 3 + 1].isFinite && a[i * 3 + 2].isFinite
}

private func hypot3(_ x: Double, _ y: Double, _ z: Double) -> Double { (x * x + y * y + z * z).squareRoot() }

/// Curvature, torsion and the Frenet directions per sample (the part of
/// `curveFrames` the combs read).
func curveBending(_ pts: [Float], _ d1: [Float]? = nil, _ d2: [Float]? = nil, _ d3: [Float]? = nil) -> CurveBending {
  let n = pts.count / 3
  var out = CurveBending(
    frenetNormal: [Float](repeating: .nan, count: n * 3), frenetBinormal: [Float](repeating: .nan, count: n * 3),
    kappa: [Double](repeating: .nan, count: n), tau: [Double](repeating: .nan, count: n))
  guard n > 1 else { return out }
  let r1 = d1 ?? fdDeriv(pts, n)
  let r2 = d2 ?? fdDeriv(r1, n)
  let r3 = d3 ?? fdDeriv(r2, n)
  var prevT = (1.0, 0.0, 0.0)
  for i in 0..<n {
    let j = i * 3
    let (vx, vy, vz) = (Double(r1[j]), Double(r1[j + 1]), Double(r1[j + 2]))
    let (ax, ay, az) = (Double(r2[j]), Double(r2[j + 1]), Double(r2[j + 2]))
    let speed = hypot3(vx, vy, vz)
    if speed.isFinite, speed > 1e-12 { prevT = (vx / speed, vy / speed, vz / speed) }
    if !speed.isFinite || speed <= 1e-12 || !(ax + ay + az).isFinite { continue }
    // c = r′ × r″
    let cx = vy * az - vz * ay
    let cy = vz * ax - vx * az
    let cz = vx * ay - vy * ax
    let cLen = hypot3(cx, cy, cz)
    out.kappa[i] = cLen / (speed * speed * speed)
    if cLen > 1e-12 * speed * speed {
      let (bx, by, bz) = (cx / cLen, cy / cLen, cz / cLen)
      out.frenetBinormal[j] = Float(bx)
      out.frenetBinormal[j + 1] = Float(by)
      out.frenetBinormal[j + 2] = Float(bz)
      // Frenet normal = B × T.
      out.frenetNormal[j] = Float(by * prevT.2 - bz * prevT.1)
      out.frenetNormal[j + 1] = Float(bz * prevT.0 - bx * prevT.2)
      out.frenetNormal[j + 2] = Float(bx * prevT.1 - by * prevT.0)
      let dot3 = cx * Double(r3[j]) + cy * Double(r3[j + 1]) + cz * Double(r3[j + 2])
      out.tau[i] = dot3.isFinite ? dot3 / (cLen * cLen) : .nan
    } else if cLen.isFinite {
      // Straight to first order: κ = 0, torsion undefined → 0.
      out.tau[i] = 0
    }
  }
  return out
}

/// Comb of teeth P + dir·value·scale sampled every `step` points, plus the
/// envelope through the tips (`buildComb`): the teeth as vertex pairs, the
/// tips as a polyline that a NaN point breaks at an invalid sample.
func buildComb(_ pts: [Float], _ dirs: [Float], _ values: [Double], _ scale: Double, step: Int = COMB_STEP)
  -> (teeth: [Float], tips: [Float])
{
  let n = pts.count / 3
  var teeth: [Float] = []
  var tips: [Float] = []
  guard n > 0 else { return (teeth, tips) }
  // Always include the last sample so the tip envelope reaches the end of
  // the curve (and closes the loop on closed curves).
  var idx = Array(stride(from: 0, to: n, by: step))
  if idx.last != n - 1 { idx.append(n - 1) }
  for i in idx {
    let j = i * 3
    let len = values[i] * scale
    guard finite3(pts, i), finite3(dirs, i), len.isFinite else {
      tips += [.nan, .nan, .nan]
      continue
    }
    // (Each tip is rounded once, from doubles, as a Float32Array stores it.)
    let tip = (0..<3).map { Float(Double(pts[j + $0]) + Double(dirs[j + $0]) * len) }
    teeth += [pts[j], pts[j + 1], pts[j + 2]] + tip
    tips += tip
  }
  return (teeth, tips)
}

/// Comb scale normalized to the curve: the tallest tooth reaches `frac` of
/// the curve's extent (`combScale`). Values whose dimensionless magnitude
/// (|v|·extent, a total bend or twist) is negligible get 0: otherwise a
/// straight line's κ ≈ 0 or a planar curve's τ ≈ 0 would amplify its
/// finite-difference noise to full height.
func combScale(_ values: [Double], _ extent: Double, frac: Double = 0.18) -> Double {
  var top = 0.0
  for v in values where abs(v).isFinite && abs(v) > top { top = abs(v) }
  if extent == 0 || top * extent < 1e-2 { return 0 }
  return (frac * extent) / top
}

extension Document3D {
  /// The combs a curve's row asks for (web/scene.ts, case 'pcurve'): the
  /// curvature's teeth point along −N, away from the centre of curvature, in
  /// a darker shade; the torsion's are signed along ±B, which shows where it
  /// changes hand, in a paler one.
  func drawCombs(
    _ index: Int, _ pts: [Float], _ derivatives: [[Expr]?], _ color: RGB, _ env: [String: Double],
    into scene: inout Scene3D
  ) {
    guard combK.contains(index) || combT.contains(index) else { return }
    let sampled = derivatives.map { $0.map { Self.sample($0, env) } }
    let bending = curveBending(pts, sampled[0], sampled[1], sampled[2])
    let extent = curveExtent(pts)
    if combK.contains(index) {
      let shade = color * 0.7
      let comb = buildComb(pts, bending.frenetNormal, bending.kappa, -combScale(bending.kappa, extent))
      scene.segments.append(Scene3D.Segments(pts: comb.teeth, color: shade))
      scene.curves.append(Scene3D.Curve(pts: comb.tips, color: shade))
    }
    if combT.contains(index) {
      let shade = color * 0.45 + 0.25
      let comb = buildComb(pts, bending.frenetBinormal, bending.tau, combScale(bending.tau, extent))
      scene.segments.append(Scene3D.Segments(pts: comb.teeth, color: shade))
      scene.curves.append(Scene3D.Curve(pts: comb.tips, color: shade))
    }
  }
}
