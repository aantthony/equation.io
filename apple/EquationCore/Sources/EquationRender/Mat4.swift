import Foundation
import simd

/// Minimal column-major mat4 utilities (only what the 3D view needs):
/// web/mat4.ts. Sixteen floats, as a shader's `uniform mat4` takes them.
public typealias Mat4 = [Float]

public func perspective(_ fovY: Double, _ aspect: Double, _ near: Double, _ far: Double) -> Mat4 {
  let f = 1 / tan(fovY / 2)
  let nf = 1 / (near - far)
  var m = Mat4(repeating: 0, count: 16)
  m[0] = Float(f / aspect)
  m[5] = Float(f)
  m[10] = Float((far + near) * nf)
  m[11] = -1
  m[14] = Float(2 * far * near * nf)
  return m
}

/// Right-handed lookAt with +Z treated as up (math convention).
public func lookAt(_ eye: [Double], _ target: [Double], _ up: [Double]) -> Mat4 {
  let e = SIMD3(eye[0], eye[1], eye[2])
  let z = simd_normalize(e - SIMD3(target[0], target[1], target[2]))
  var x = simd_cross(SIMD3(up[0], up[1], up[2]), z)
  let xl = simd_length(x)
  x /= xl == 0 ? 1 : xl
  let y = simd_cross(z, x)
  return [
    x.x, y.x, z.x, 0,
    x.y, y.y, z.y, 0,
    x.z, y.z, z.z, 0,
    -simd_dot(x, e), -simd_dot(y, e), -simd_dot(z, e), 1,
  ].map { Float($0) }
}

private func columns(_ m: Mat4) -> simd_double4x4 {
  simd_double4x4((0..<4).map { c in SIMD4((0..<4).map { r in Double(m[c * 4 + r]) }) })
}

private func floats(_ m: simd_double4x4) -> Mat4 {
  (0..<16).map { Float(m[$0 / 4][$0 % 4]) }
}

public func multiply(_ a: Mat4, _ b: Mat4) -> Mat4 {
  floats(columns(a) * columns(b))
}

/// The inverse, or nil for a singular matrix (where the site throws). The
/// site inverts by cofactors in single precision; simd's inverse in doubles
/// is the same matrix to more digits, which the rays unprojected through it
/// are glad of at the far plane.
public func invert(_ m: Mat4) -> Mat4? {
  let a = columns(m)
  return simd_determinant(a) == 0 ? nil : floats(a.inverse)
}
