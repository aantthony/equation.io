import Foundation

/// Differential geometry of CPU-sampled space curves r(u), u ∈ [0, 1]
/// (lib/curve3d.ts): a rotation-minimizing frame (double-reflection parallel
/// transport) for tube geometry — the Frenet frame flips at inflections and
/// spins with torsion, which reads as a twisted tube — and the tube mesh
/// builder for the 3D renderer.
///
/// All point arrays are flat xyz triples. NaN samples flow through as NaN
/// frames; the mesh builder skips geometry touching them.
///
/// Not ported: curvature, torsion and the Frenet directions, which only the
/// curvature and torsion combs read (toggles the page keeps outside the text).
struct CurveFrames {
  /// Unit tangent per sample.
  var tangent: [Float]
  /// Rotation-minimizing normal — stable around the curve, no inflection flips.
  var normal: [Float]
  /// tangent × normal.
  var binormal: [Float]
  /// Endpoints and tangents match: the frame seam was distributed around the loop.
  var closed: Bool
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

/// Half the bounding-box diagonal of the finite samples; 0 if none.
func curveExtent(_ pts: [Float]) -> Double {
  let n = pts.count / 3
  var lo = [Double](repeating: .infinity, count: 3)
  var hi = [Double](repeating: -.infinity, count: 3)
  for i in 0..<n where finite3(pts, i) {
    for c in 0..<3 {
      let v = Double(pts[i * 3 + c])
      if v < lo[c] { lo[c] = v }
      if v > hi[c] { hi[c] = v }
    }
  }
  if !lo[0].isFinite { return 0 }
  return hypot3(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2
}

/// The frames along a sampled curve; `d1` its derivative in u where the
/// caller has it, finite differences of the samples otherwise.
func curveFrames(_ pts: [Float], _ d1: [Float]? = nil) -> CurveFrames {
  let n = pts.count / 3
  guard n > 0 else { return CurveFrames(tangent: [], normal: [], binormal: [], closed: false) }
  let r1 = d1 ?? fdDeriv(pts, n)
  var tangent = [Float](repeating: 0, count: n * 3)
  var normal = [Float](repeating: 0, count: n * 3)
  var binormal = [Float](repeating: 0, count: n * 3)
  func at(_ a: [Float], _ j: Int) -> (Double, Double, Double) { (Double(a[j]), Double(a[j + 1]), Double(a[j + 2])) }
  func set(_ a: inout [Float], _ j: Int, _ x: Double, _ y: Double, _ z: Double) {
    a[j] = Float(x)
    a[j + 1] = Float(y)
    a[j + 2] = Float(z)
  }

  // Tangents: the last good direction where the speed vanishes.
  var prevT = (1.0, 0.0, 0.0)
  for i in 0..<n {
    let j = i * 3
    let (vx, vy, vz) = at(r1, j)
    let speed = hypot3(vx, vy, vz)
    if speed.isFinite, speed > 1e-12 { prevT = (vx / speed, vy / speed, vz / speed) }
    set(&tangent, j, prevT.0, prevT.1, prevT.2)
  }

  // Rotation-minimizing frame via the double-reflection method
  // (Wang et al. 2008): reflect the previous frame through the chord's
  // bisecting plane, then through the plane bisecting the tangents.
  do {
    let (tx, ty, tz) = at(tangent, 0)
    // Seed with the axis least aligned with T, projected perpendicular.
    let (ax, ay, az) = (abs(tx), abs(ty), abs(tz))
    var s = (0.0, 0.0, 0.0)
    if ax <= ay && ax <= az { s.0 = 1 } else if ay <= az { s.1 = 1 } else { s.2 = 1 }
    let d = s.0 * tx + s.1 * ty + s.2 * tz
    let (nx, ny, nz) = (s.0 - d * tx, s.1 - d * ty, s.2 - d * tz)
    var len = hypot3(nx, ny, nz)
    if len == 0 || len.isNaN { len = 1 }
    set(&normal, 0, nx / len, ny / len, nz / len)
  }
  for i in 0..<(n - 1) {
    let j = i * 3
    let k = j + 3
    var (nx, ny, nz) = at(normal, j)
    let (t0x, t0y, t0z) = at(tangent, j)
    let (t1x, t1y, t1z) = at(tangent, k)
    let v1x = Double(pts[k]) - Double(pts[j])
    let v1y = Double(pts[k + 1]) - Double(pts[j + 1])
    let v1z = Double(pts[k + 2]) - Double(pts[j + 2])
    let c1 = v1x * v1x + v1y * v1y + v1z * v1z
    if c1.isFinite, c1 > 1e-24 {
      let dn = ((v1x * nx + v1y * ny + v1z * nz) * 2) / c1
      let dt = ((v1x * t0x + v1y * t0y + v1z * t0z) * 2) / c1
      let (rx, ry, rz) = (nx - dn * v1x, ny - dn * v1y, nz - dn * v1z)
      let (px, py, pz) = (t0x - dt * v1x, t0y - dt * v1y, t0z - dt * v1z)
      let (v2x, v2y, v2z) = (t1x - px, t1y - py, t1z - pz)
      let c2 = v2x * v2x + v2y * v2y + v2z * v2z
      if c2 > 1e-24 {
        let dr = ((v2x * rx + v2y * ry + v2z * rz) * 2) / c2
        (nx, ny, nz) = (rx - dr * v2x, ry - dr * v2y, rz - dr * v2z)
      } else {
        (nx, ny, nz) = (rx, ry, rz)
      }
      // Guard drift and degenerate reflections.
      let dd = nx * t1x + ny * t1y + nz * t1z
      nx -= dd * t1x
      ny -= dd * t1y
      nz -= dd * t1z
      let ln = hypot3(nx, ny, nz)
      if ln > 1e-12 {
        nx /= ln
        ny /= ln
        nz /= ln
      } else {
        (nx, ny, nz) = at(normal, j)
      }
    }
    set(&normal, k, nx, ny, nz)
  }

  // Closed curve: the transported frame returns with some holonomy angle.
  // Distribute the mismatch as a gradual twist so the seam ring matches.
  let extent = curveExtent(pts)
  let e = (n - 1) * 3
  let gap = hypot3(
    Double(pts[e]) - Double(pts[0]), Double(pts[e + 1]) - Double(pts[1]), Double(pts[e + 2]) - Double(pts[2]))
  let (t0, tE) = (at(tangent, 0), at(tangent, e))
  let tDot = t0.0 * tE.0 + t0.1 * tE.1 + t0.2 * tE.2
  let closed = extent > 0 && gap < 1e-3 * extent && tDot > 0.999
  if closed {
    let (nex, ney, nez) = at(normal, e)
    let n0 = at(normal, 0)
    // Signed angle from N_end to N_0 about the (shared) tangent.
    let crx = ney * n0.2 - nez * n0.1
    let cry = nez * n0.0 - nex * n0.2
    let crz = nex * n0.1 - ney * n0.0
    let sine = crx * t0.0 + cry * t0.1 + crz * t0.2
    let cosine = nex * n0.0 + ney * n0.1 + nez * n0.2
    let theta = atan2(sine, cosine)
    for i in 1..<n {
      let j = i * 3
      let a = theta * Double(i) / Double(n - 1)
      let (ca, sa) = (cos(a), sin(a))
      let (tx, ty, tz) = at(tangent, j)
      let (nx, ny, nz) = at(normal, j)
      // B = T × N, then N' = N cos a + B sin a.
      let (bx, by, bz) = (ty * nz - tz * ny, tz * nx - tx * nz, tx * ny - ty * nx)
      set(&normal, j, nx * ca + bx * sa, ny * ca + by * sa, nz * ca + bz * sa)
    }
  }

  for i in 0..<n {
    let j = i * 3
    let (tx, ty, tz) = at(tangent, j)
    let (nx, ny, nz) = at(normal, j)
    set(&binormal, j, ty * nz - tz * ny, tz * nx - tx * nz, tx * ny - ty * nx)
  }
  return CurveFrames(tangent: tangent, normal: normal, binormal: binormal, closed: closed)
}

private let ANGULAR_CELLS = 8

/// Sweep a circle of `radius` along the curve using the rotation-minimizing
/// frame (`buildTube`). The mesh's uvs are material coordinates: arclength
/// fraction along the curve, angle fraction around the ring; its cells give
/// roughly square checker cells in world units.
func buildTube(_ pts: [Float], _ frames: CurveFrames, _ radius: Double, segments: Int = 24, color: RGB)
  -> Scene3D.Tube
{
  let n = pts.count / 3
  let (normal, binormal) = (frames.normal, frames.binormal)
  // Rings carry a duplicated seam column (angle 0 again as angle 1) so the
  // material coordinate interpolates cleanly across the wrap.
  let stride = segments + 1
  var positions = [Float](repeating: 0, count: n * stride * 3)
  var normals = [Float](repeating: 0, count: n * stride * 3)
  var uvs = [Float](repeating: 0, count: n * stride * 2)

  // Cumulative arclength; steps through invalid samples contribute nothing.
  var arc = [Double](repeating: 0, count: max(n, 1))
  for i in 1..<max(n, 1) {
    let j = i * 3
    let d = hypot3(
      Double(pts[j]) - Double(pts[j - 3]), Double(pts[j + 1]) - Double(pts[j - 2]),
      Double(pts[j + 2]) - Double(pts[j - 1]))
    arc[i] = arc[i - 1] + (d.isFinite ? d : 0)
  }
  let total = n > 0 && arc[n - 1] > 0 ? arc[n - 1] : 1

  // s % segments keeps the seam column bit-identical to column 0.
  let cosines = (0..<stride).map { cos(2 * Double.pi * Double($0 % segments) / Double(segments)) }
  let sines = (0..<stride).map { sin(2 * Double.pi * Double($0 % segments) / Double(segments)) }
  var valid = [Bool](repeating: false, count: n)
  for i in 0..<n {
    let j = i * 3
    valid[i] = finite3(pts, i) && finite3(normal, i) && finite3(binormal, i)
    let u = arc[i] / total
    for s in 0..<stride {
      let o = (i * stride + s) * 3
      for c in 0..<3 {
        let r = cosines[s] * Double(normal[j + c]) + sines[s] * Double(binormal[j + c])
        normals[o + c] = Float(r)
        positions[o + c] = Float(Double(pts[j + c]) + radius * r)
      }
      let q = (i * stride + s) * 2
      uvs[q] = Float(u)
      uvs[q + 1] = Float(Double(s) / Double(segments))
    }
  }
  var indices: [UInt32] = []
  for i in 0..<max(n - 1, 0) where valid[i] && valid[i + 1] {
    for s in 0..<segments {
      let a = UInt32(i * stride + s)
      let c = UInt32((i + 1) * stride + s)
      indices += [a, a + 1, c, a + 1, c + 1, c]
    }
  }

  // Along-length cell size matched to the angular cell (2πr / ANGULAR_CELLS);
  // on closed curves an even count makes the checker parity continue across
  // the loop seam.
  var lenCells = max(2, (total / ((2 * Double.pi * radius) / Double(ANGULAR_CELLS))).rounded())
  if frames.closed, lenCells.truncatingRemainder(dividingBy: 2) != 0 { lenCells += 1 }
  return Scene3D.Tube(
    positions: positions, normals: normals, uvs: uvs, indices: indices,
    cells: SIMD2(Float(lenCells), Float(ANGULAR_CELLS)), color: color)
}
