/**
 * Differential geometry of CPU-sampled space curves r(u), u ∈ [0,1]:
 *
 * - curvature κ = |r'×r''|/|r'|³ and torsion τ = (r'×r'')·r'''/|r'×r''|²,
 *   from symbolic derivatives when the caller has them, finite differences
 *   of the samples otherwise;
 * - a rotation-minimizing frame (double-reflection parallel transport) for
 *   tube geometry — the Frenet frame flips at inflections and spins with
 *   torsion, which reads as a twisted tube;
 * - the Frenet normal/binormal directions for curvature and torsion combs
 *   (comb teeth must point along the actual curvature vector);
 * - tube mesh and comb segment builders for the 3D renderer.
 *
 * All point arrays are flat xyz triples. NaN samples flow through as NaN
 * frames; the mesh builders skip geometry touching them.
 */

export interface CurveFrames {
  /** Unit tangent per sample. */
  tangent: Float32Array;
  /** Rotation-minimizing normal — stable around the curve, no inflection flips. */
  normal: Float32Array;
  /** tangent × normal. */
  binormal: Float32Array;
  /** Unit Frenet (principal) normal; NaN where κ vanishes. */
  frenetNormal: Float32Array;
  /** Unit Frenet binormal r'×r''/|r'×r''|; NaN where κ vanishes. */
  frenetBinormal: Float32Array;
  kappa: Float64Array;
  tau: Float64Array;
  /** Endpoints and tangents match: the frame seam was distributed around the loop. */
  closed: boolean;
}

/** d/du by central differences (one-sided at the ends), u ∈ [0,1] over n samples. */
function fdDeriv(src: Float32Array, n: number): Float32Array {
  const h = 1 / (n - 1);
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = i === 0 ? 0 : i - 1;
    const b = i === n - 1 ? n - 1 : i + 1;
    const s = 1 / ((b - a) * h);
    for (let c = 0; c < 3; c++) out[i * 3 + c] = (src[b * 3 + c] - src[a * 3 + c]) * s;
  }
  return out;
}

const finite3 = (a: Float32Array, i: number): boolean =>
  isFinite(a[i * 3]) && isFinite(a[i * 3 + 1]) && isFinite(a[i * 3 + 2]);

/**
 * The drawable runs of a 3D polyline, as [first vertex, vertex count]: a
 * non-finite vertex (an undefined sample, a break at a jump) lifts the pen.
 * A GL line strip has no such notion — what a NaN vertex draws is up to the
 * driver — so the renderer draws one strip per run. Lone points draw nothing.
 */
export function finiteRuns(pts: Float32Array): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  const n = Math.floor(pts.length / 3);
  let start = -1;
  for (let i = 0; i <= n; i++) {
    if (i < n && finite3(pts, i)) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0 && i - start >= 2) runs.push([start, i - start]);
    start = -1;
  }
  return runs;
}

/** Half the bounding-box diagonal of the finite samples; 0 if none. */
export function curveExtent(pts: Float32Array): number {
  const n = pts.length / 3;
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    if (!finite3(pts, i)) continue;
    for (let c = 0; c < 3; c++) {
      const v = pts[i * 3 + c];
      if (v < lo[c]) lo[c] = v;
      if (v > hi[c]) hi[c] = v;
    }
  }
  if (!isFinite(lo[0])) return 0;
  return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
}

export function curveFrames(pts: Float32Array, d1?: Float32Array, d2?: Float32Array, d3?: Float32Array): CurveFrames {
  const n = pts.length / 3;
  const r1 = d1 ?? fdDeriv(pts, n);
  const r2 = d2 ?? fdDeriv(r1, n);
  const r3 = d3 ?? fdDeriv(r2, n);

  const tangent = new Float32Array(n * 3);
  const normal = new Float32Array(n * 3);
  const binormal = new Float32Array(n * 3);
  const frenetNormal = new Float32Array(n * 3).fill(NaN);
  const frenetBinormal = new Float32Array(n * 3).fill(NaN);
  const kappa = new Float64Array(n).fill(NaN);
  const tau = new Float64Array(n).fill(NaN);

  // Tangents, curvature, torsion, and Frenet directions per sample.
  let prevT: [number, number, number] = [1, 0, 0];
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    const vx = r1[j],
      vy = r1[j + 1],
      vz = r1[j + 2];
    const ax = r2[j],
      ay = r2[j + 1],
      az = r2[j + 2];
    const speed = Math.hypot(vx, vy, vz);
    if (isFinite(speed) && speed > 1e-12) {
      prevT = [vx / speed, vy / speed, vz / speed];
    }
    tangent[j] = prevT[0];
    tangent[j + 1] = prevT[1];
    tangent[j + 2] = prevT[2];
    if (!isFinite(speed) || speed <= 1e-12 || !isFinite(ax + ay + az)) continue;

    // c = r' × r''
    const cx = vy * az - vz * ay;
    const cy = vz * ax - vx * az;
    const cz = vx * ay - vy * ax;
    const cLen = Math.hypot(cx, cy, cz);
    kappa[i] = cLen / (speed * speed * speed);
    if (cLen > 1e-12 * speed * speed) {
      const bx = cx / cLen,
        by = cy / cLen,
        bz = cz / cLen;
      frenetBinormal[j] = bx;
      frenetBinormal[j + 1] = by;
      frenetBinormal[j + 2] = bz;
      // Frenet normal = B × T.
      frenetNormal[j] = by * prevT[2] - bz * prevT[1];
      frenetNormal[j + 1] = bz * prevT[0] - bx * prevT[2];
      frenetNormal[j + 2] = bx * prevT[1] - by * prevT[0];
      const dot3 = cx * r3[j] + cy * r3[j + 1] + cz * r3[j + 2];
      tau[i] = isFinite(dot3) ? dot3 / (cLen * cLen) : NaN;
    } else if (isFinite(cLen)) {
      tau[i] = 0; // straight to first order: κ = 0, torsion undefined → 0
    }
  }

  // Rotation-minimizing frame via the double-reflection method
  // (Wang et al. 2008): reflect the previous frame through the chord's
  // bisecting plane, then through the plane bisecting the tangents.
  {
    const j0 = 0;
    const tx = tangent[j0],
      ty = tangent[j0 + 1],
      tz = tangent[j0 + 2];
    // Seed with the axis least aligned with T, projected perpendicular.
    const ax = Math.abs(tx),
      ay = Math.abs(ty),
      az = Math.abs(tz);
    let sx = 0,
      sy = 0,
      sz = 0;
    if (ax <= ay && ax <= az) sx = 1;
    else if (ay <= az) sy = 1;
    else sz = 1;
    const d = sx * tx + sy * ty + sz * tz;
    let nx = sx - d * tx,
      ny = sy - d * ty,
      nz = sz - d * tz;
    const len = Math.hypot(nx, ny, nz) || 1;
    normal[0] = nx / len;
    normal[1] = ny / len;
    normal[2] = nz / len;
  }
  for (let i = 0; i + 1 < n; i++) {
    const j = i * 3,
      k = j + 3;
    let nx = normal[j],
      ny = normal[j + 1],
      nz = normal[j + 2];
    const t0x = tangent[j],
      t0y = tangent[j + 1],
      t0z = tangent[j + 2];
    const t1x = tangent[k],
      t1y = tangent[k + 1],
      t1z = tangent[k + 2];
    const v1x = pts[k] - pts[j],
      v1y = pts[k + 1] - pts[j + 1],
      v1z = pts[k + 2] - pts[j + 2];
    const c1 = v1x * v1x + v1y * v1y + v1z * v1z;
    if (isFinite(c1) && c1 > 1e-24) {
      const dn = ((v1x * nx + v1y * ny + v1z * nz) * 2) / c1;
      const dt = ((v1x * t0x + v1y * t0y + v1z * t0z) * 2) / c1;
      const rx = nx - dn * v1x,
        ry = ny - dn * v1y,
        rz = nz - dn * v1z;
      const px = t0x - dt * v1x,
        py = t0y - dt * v1y,
        pz = t0z - dt * v1z;
      const v2x = t1x - px,
        v2y = t1y - py,
        v2z = t1z - pz;
      const c2 = v2x * v2x + v2y * v2y + v2z * v2z;
      if (c2 > 1e-24) {
        const dr = ((v2x * rx + v2y * ry + v2z * rz) * 2) / c2;
        nx = rx - dr * v2x;
        ny = ry - dr * v2y;
        nz = rz - dr * v2z;
      } else {
        nx = rx;
        ny = ry;
        nz = rz;
      }
      // Guard drift and degenerate reflections.
      const dd = nx * t1x + ny * t1y + nz * t1z;
      nx -= dd * t1x;
      ny -= dd * t1y;
      nz -= dd * t1z;
      const ln = Math.hypot(nx, ny, nz);
      if (ln > 1e-12) {
        nx /= ln;
        ny /= ln;
        nz /= ln;
      } else {
        nx = normal[j];
        ny = normal[j + 1];
        nz = normal[j + 2];
      }
    }
    normal[k] = nx;
    normal[k + 1] = ny;
    normal[k + 2] = nz;
  }

  // Closed curve: the transported frame returns with some holonomy angle.
  // Distribute the mismatch as a gradual twist so the seam ring matches.
  const extent = curveExtent(pts);
  const e = (n - 1) * 3;
  const gap = Math.hypot(pts[e] - pts[0], pts[e + 1] - pts[1], pts[e + 2] - pts[2]);
  const tDot = tangent[0] * tangent[e] + tangent[1] * tangent[e + 1] + tangent[2] * tangent[e + 2];
  const closed = extent > 0 && gap < 1e-3 * extent && tDot > 0.999;
  if (closed) {
    const nex = normal[e],
      ney = normal[e + 1],
      nez = normal[e + 2];
    // Signed angle from N_end to N_0 about the (shared) tangent.
    const crx = ney * normal[2] - nez * normal[1];
    const cry = nez * normal[0] - nex * normal[2];
    const crz = nex * normal[1] - ney * normal[0];
    const sin = crx * tangent[0] + cry * tangent[1] + crz * tangent[2];
    const cos = nex * normal[0] + ney * normal[1] + nez * normal[2];
    const theta = Math.atan2(sin, cos);
    for (let i = 1; i < n; i++) {
      const j = i * 3;
      const a = (theta * i) / (n - 1);
      const ca = Math.cos(a),
        sa = Math.sin(a);
      const tx = tangent[j],
        ty = tangent[j + 1],
        tz = tangent[j + 2];
      const nx = normal[j],
        ny = normal[j + 1],
        nz = normal[j + 2];
      // B = T × N, then N' = N cos a + B sin a.
      const bx = ty * nz - tz * ny,
        by = tz * nx - tx * nz,
        bz = tx * ny - ty * nx;
      normal[j] = nx * ca + bx * sa;
      normal[j + 1] = ny * ca + by * sa;
      normal[j + 2] = nz * ca + bz * sa;
    }
  }

  for (let i = 0; i < n; i++) {
    const j = i * 3;
    binormal[j] = tangent[j + 1] * normal[j + 2] - tangent[j + 2] * normal[j + 1];
    binormal[j + 1] = tangent[j + 2] * normal[j] - tangent[j] * normal[j + 2];
    binormal[j + 2] = tangent[j] * normal[j + 1] - tangent[j + 1] * normal[j];
  }

  return { tangent, normal, binormal, frenetNormal, frenetBinormal, kappa, tau, closed };
}

export interface TubeMesh {
  positions: Float32Array;
  normals: Float32Array;
  /**
   * Material coordinates per vertex: x = arclength fraction along the curve,
   * y = angle fraction around the ring (in the rotation-minimizing frame, so
   * the coordinate does not spiral with torsion).
   */
  uvs: Float32Array;
  indices: Uint32Array;
  /**
   * Checker cell counts along (length, circumference) giving roughly square
   * cells in world units — a pattern painted on the material, not on the
   * parameter.
   */
  cells: [number, number];
}

const ANGULAR_CELLS = 8;

/** Sweep a circle of `radius` along the curve using the rotation-minimizing frame. */
export function buildTube(pts: Float32Array, frames: CurveFrames, radius: number, segments = 24): TubeMesh {
  const n = pts.length / 3;
  const { normal, binormal, closed } = frames;
  // Rings carry a duplicated seam column (angle 0 again as angle 1) so the
  // material coordinate interpolates cleanly across the wrap.
  const stride = segments + 1;
  const positions = new Float32Array(n * stride * 3);
  const normals = new Float32Array(n * stride * 3);
  const uvs = new Float32Array(n * stride * 2);

  // Cumulative arclength; steps through invalid samples contribute nothing.
  const arc = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const j = i * 3;
    const d = Math.hypot(pts[j] - pts[j - 3], pts[j + 1] - pts[j - 2], pts[j + 2] - pts[j - 1]);
    arc[i] = arc[i - 1] + (isFinite(d) ? d : 0);
  }
  const total = arc[n - 1] > 0 ? arc[n - 1] : 1;

  const cos = new Float64Array(stride);
  const sin = new Float64Array(stride);
  for (let s = 0; s < stride; s++) {
    // s % segments keeps the seam column bit-identical to column 0.
    cos[s] = Math.cos((2 * Math.PI * (s % segments)) / segments);
    sin[s] = Math.sin((2 * Math.PI * (s % segments)) / segments);
  }
  const valid: boolean[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    valid[i] = finite3(pts, i) && finite3(normal, i) && finite3(binormal, i);
    const u = arc[i] / total;
    for (let s = 0; s < stride; s++) {
      const o = (i * stride + s) * 3;
      const rx = cos[s] * normal[j] + sin[s] * binormal[j];
      const ry = cos[s] * normal[j + 1] + sin[s] * binormal[j + 1];
      const rz = cos[s] * normal[j + 2] + sin[s] * binormal[j + 2];
      normals[o] = rx;
      normals[o + 1] = ry;
      normals[o + 2] = rz;
      positions[o] = pts[j] + radius * rx;
      positions[o + 1] = pts[j + 1] + radius * ry;
      positions[o + 2] = pts[j + 2] + radius * rz;
      const q = (i * stride + s) * 2;
      uvs[q] = u;
      uvs[q + 1] = s / segments;
    }
  }
  const idx: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    if (!valid[i] || !valid[i + 1]) continue;
    for (let s = 0; s < segments; s++) {
      const a = i * stride + s;
      const c = (i + 1) * stride + s;
      idx.push(a, a + 1, c, a + 1, c + 1, c);
    }
  }

  // Along-length cell size matched to the angular cell (2πr / ANGULAR_CELLS);
  // on closed curves an even count makes the checker parity continue across
  // the loop seam.
  let lenCells = Math.max(2, Math.round(total / ((2 * Math.PI * radius) / ANGULAR_CELLS)));
  if (closed && lenCells % 2) lenCells += 1;
  return {
    positions,
    normals,
    uvs,
    indices: Uint32Array.from(idx),
    cells: [lenCells, ANGULAR_CELLS],
  };
}

export interface Comb {
  /** Tooth segments as vertex pairs (gl.LINES). */
  teeth: Float32Array;
  /** Polyline through the tooth tips (gl.LINE_STRIP; NaN triples break it). */
  tips: Float32Array;
}

/**
 * Comb of teeth P + dir·value·scale sampled every `step` points, plus the
 * envelope through the tips. Invalid samples produce NaN breaks.
 */
export function buildComb(pts: Float32Array, dirs: Float32Array, values: Float64Array, scale: number, step = 4): Comb {
  const n = pts.length / 3;
  const teeth: number[] = [];
  const tips: number[] = [];
  // Always include the last sample so the tip envelope reaches the end of
  // the curve (and closes the loop on closed curves).
  const idx: number[] = [];
  for (let i = 0; i < n; i += step) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  for (const i of idx) {
    const j = i * 3;
    const len = values[i] * scale;
    const ok = finite3(pts, i) && finite3(dirs, i) && isFinite(len);
    if (!ok) {
      tips.push(NaN, NaN, NaN);
      continue;
    }
    const tx = pts[j] + dirs[j] * len;
    const ty = pts[j + 1] + dirs[j + 1] * len;
    const tz = pts[j + 2] + dirs[j + 2] * len;
    teeth.push(pts[j], pts[j + 1], pts[j + 2], tx, ty, tz);
    tips.push(tx, ty, tz);
  }
  return { teeth: Float32Array.from(teeth), tips: Float32Array.from(tips) };
}

/**
 * Comb scale normalized to the curve: the tallest tooth reaches `frac` of the
 * curve's extent. Values whose dimensionless magnitude (|v|·extent, e.g. total
 * bend or twist) is negligible get 0 — otherwise a straight line's κ≈0 or a
 * planar curve's τ≈0 finite-difference noise would amplify to full height.
 */
export function combScale(values: Float64Array, extent: number, frac = 0.18): number {
  let max = 0;
  for (const v of values) {
    const a = Math.abs(v);
    if (isFinite(a) && a > max) max = a;
  }
  if (extent === 0 || max * extent < 1e-2) return 0;
  return (frac * extent) / max;
}
