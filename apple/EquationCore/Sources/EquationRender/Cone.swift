import Foundation

// Unit cone for 3D arrow heads: tip at the origin, base the unit circle in
// z = −1, so local +z points from the base to the tip. Instances rotate that
// +z onto the shaft direction and scale (radius, height) in world units.
// (lib/cone.ts)

let CONE_SIDES = 24

func buildUnitCone(_ sides: Int = CONE_SIDES) -> (positions: [Float], normals: [Float], indices: [UInt16]) {
  var positions: [Float] = []
  var normals: [Float] = []
  var indices: [UInt16] = []
  let nlen = Float(2.0.squareRoot())
  let ring = (0..<sides).map { i -> (c: Float, s: Float) in
    let t = 2 * Double.pi * Double(i) / Double(sides)
    return (Float(cos(t)), Float(sin(t)))
  }
  for (c, s) in ring {
    // aNormal.z > 0 marks a side vertex; the fragment shader replaces this
    // with the analytic radial normal of the cone.
    positions += [c, s, -1]
    normals += [c / nlen, s / nlen, 1 / nlen]
  }
  let tip = sides
  positions += [0, 0, 0]
  normals += [0, 0, 1]
  for i in 0..<sides {
    // tip, ring[i], ring[i+1]: CCW from outside.
    indices += [UInt16(tip), UInt16(i), UInt16((i + 1) % sides)]
  }
  let capCenter = sides + 1
  positions += [0, 0, -1]
  normals += [0, 0, -1]
  let capRing = capCenter + 1
  for (c, s) in ring {
    positions += [c, s, -1]
    normals += [0, 0, -1]
  }
  for i in 0..<sides {
    // Clockwise in XY so the cap faces −z.
    indices += [UInt16(capCenter), UInt16(capRing + (i + 1) % sides), UInt16(capRing + i)]
  }
  return (positions, normals, indices)
}

/// One lit cone per finite run, plus a copy of `pts` whose last vertex on each
/// run sits at the cone base so the shaft does not poke through the tip. An
/// instance is eight floats: the tip, the unit direction, then radius and height.
func arrowConeInstances(
  _ pts: [Float], _ runs: [(first: Int, count: Int)], _ boxR: Double
) -> (shafts: [Float], instances: [Float], count: Int) {
  var shafts = pts
  var instances: [Float] = []
  for (first, count) in runs where count >= 2 {
    let i0 = (first + count - 2) * 3
    let i1 = (first + count - 1) * 3
    let dx = Double(pts[i1]) - Double(pts[i0])
    let dy = Double(pts[i1 + 1]) - Double(pts[i0 + 1])
    let dz = Double(pts[i1 + 2]) - Double(pts[i0 + 2])
    let L = (dx * dx + dy * dy + dz * dz).squareRoot()
    if !(L > 1e-12) || !(boxR > 0) { continue }
    let height = min(0.32 * L, 0.05 * boxR)
    if !(height > 0) { continue }
    let (ux, uy, uz) = (dx / L, dy / L, dz / L)
    shafts[i1] = Float(Double(pts[i1]) - ux * height)
    shafts[i1 + 1] = Float(Double(pts[i1 + 1]) - uy * height)
    shafts[i1 + 2] = Float(Double(pts[i1 + 2]) - uz * height)
    instances += [pts[i1], pts[i1 + 1], pts[i1 + 2], Float(ux), Float(uy), Float(uz)]
    instances += [Float(height * 0.36), Float(height)]
  }
  return (shafts, instances, instances.count / 8)
}
