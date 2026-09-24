/**
 * Unit cone for 3D arrow heads: tip at the origin, base the unit circle in
 * z = −1, so local +z points from the base to the tip. Instances rotate that
 * +z onto the shaft direction and scale (radius, height) in world units.
 */
export const CONE_SIDES = 24;

export function buildUnitCone(sides = CONE_SIDES): {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint16Array;
} {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const nlen = Math.SQRT2;
  for (let i = 0; i < sides; i++) {
    const t = (2 * Math.PI * i) / sides;
    const c = Math.cos(t),
      s = Math.sin(t);
    // aNormal.z > 0 marks a side vertex; the fragment shader replaces this
    // with the analytic radial normal of the cone.
    positions.push(c, s, -1);
    normals.push(c / nlen, s / nlen, 1 / nlen);
  }
  const tip = sides;
  positions.push(0, 0, 0);
  normals.push(0, 0, 1);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    // tip, ring[i], ring[i+1]: CCW from outside (see cone.test.ts).
    indices.push(tip, i, j);
  }
  const capCenter = sides + 1;
  positions.push(0, 0, -1);
  normals.push(0, 0, -1);
  const capRing = capCenter + 1;
  for (let i = 0; i < sides; i++) {
    const t = (2 * Math.PI * i) / sides;
    positions.push(Math.cos(t), Math.sin(t), -1);
    normals.push(0, 0, -1);
  }
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    // Clockwise in XY so the cap faces −z.
    indices.push(capCenter, capRing + j, capRing + i);
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint16Array(indices),
  };
}

/** Orthonormal frame with +z along `dir`. Matches the cone instance shader. */
export function coneBasis(dir: [number, number, number]): {
  x: [number, number, number];
  y: [number, number, number];
  z: [number, number, number];
} {
  const len = Math.hypot(...dir);
  const z: [number, number, number] = [dir[0] / len, dir[1] / len, dir[2] / len];
  const h: [number, number, number] = Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const cx = h[1] * z[2] - h[2] * z[1],
    cy = h[2] * z[0] - h[0] * z[2],
    cz = h[0] * z[1] - h[1] * z[0];
  const cl = Math.hypot(cx, cy, cz);
  const x: [number, number, number] = [cx / cl, cy / cl, cz / cl];
  const y: [number, number, number] = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return { x, y, z };
}

/**
 * One lit cone per finite run, plus a copy of `pts` whose last vertex on each
 * run sits at the cone base so the shaft does not poke through the tip.
 */
export function arrowConeInstances(
  pts: Float32Array,
  runs: Array<[number, number]>,
  boxR: number,
): {
  shafts: Float32Array;
  instances: Float32Array;
  count: number;
} {
  const shafts = new Float32Array(pts);
  const instances: number[] = [];
  for (const [first, count] of runs) {
    if (count < 2) continue;
    const i0 = (first + count - 2) * 3;
    const i1 = (first + count - 1) * 3;
    const dx = pts[i1] - pts[i0],
      dy = pts[i1 + 1] - pts[i0 + 1],
      dz = pts[i1 + 2] - pts[i0 + 2];
    const L = Math.hypot(dx, dy, dz);
    if (!(L > 1e-12) || !(boxR > 0)) continue;
    const height = Math.min(0.32 * L, 0.05 * boxR);
    if (!(height > 0)) continue;
    const inv = 1 / L;
    const ux = dx * inv,
      uy = dy * inv,
      uz = dz * inv;
    shafts[i1] = pts[i1] - ux * height;
    shafts[i1 + 1] = pts[i1 + 1] - uy * height;
    shafts[i1 + 2] = pts[i1 + 2] - uz * height;
    instances.push(pts[i1], pts[i1 + 1], pts[i1 + 2], ux, uy, uz, height * 0.36, height);
  }
  return { shafts, instances: new Float32Array(instances), count: instances.length / 8 };
}
