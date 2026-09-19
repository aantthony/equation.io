import { describe, expect, it } from 'vitest';
import { buildComb, buildTube, combScale, curveExtent, curveFrames, finiteRuns } from './curve3d.ts';

const N = 400;

/** Sample r(u) and its first three u-derivatives on [0,1]. */
function sample(
  r: (u: number) => [number, number, number],
  d1?: (u: number) => [number, number, number],
  d2?: (u: number) => [number, number, number],
  d3?: (u: number) => [number, number, number],
) {
  const at = (f: (u: number) => [number, number, number]) => {
    const out = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) out.set(f(i / (N - 1)), i * 3);
    return out;
  };
  return {
    pts: at(r),
    d1: d1 && at(d1),
    d2: d2 && at(d2),
    d3: d3 && at(d3),
  };
}

// Helix (a cos ωu, a sin ωu, b ωu): κ = a/(a²+b²), τ = b/(a²+b²).
const a = 2, b = 1, w = 4 * Math.PI;
const helix = sample(
  u => [a * Math.cos(w * u), a * Math.sin(w * u), b * w * u],
  u => [-a * w * Math.sin(w * u), a * w * Math.cos(w * u), b * w],
  u => [-a * w * w * Math.cos(w * u), -a * w * w * Math.sin(w * u), 0],
  u => [a * w * w * w * Math.sin(w * u), -a * w * w * w * Math.cos(w * u), 0],
);

describe('curveFrames', () => {
  it('recovers helix curvature and torsion from symbolic derivatives', () => {
    const fr = curveFrames(helix.pts, helix.d1, helix.d2, helix.d3);
    for (const i of [0, 100, 250, N - 1]) {
      expect(fr.kappa[i]).toBeCloseTo(a / (a * a + b * b), 6);
      expect(fr.tau[i]).toBeCloseTo(b / (a * a + b * b), 6);
    }
  });

  it('recovers helix curvature and torsion from finite differences', () => {
    const fr = curveFrames(helix.pts);
    // Interior samples only; third-order FD is the loosest.
    expect(fr.kappa[200]).toBeCloseTo(0.4, 2);
    expect(fr.tau[200]).toBeCloseTo(0.2, 1);
  });

  it('keeps tangents unit and the RMF orthonormal and continuous', () => {
    const fr = curveFrames(helix.pts, helix.d1, helix.d2, helix.d3);
    for (let i = 0; i < N; i++) {
      const j = i * 3;
      const dot = (p: Float32Array, q: Float32Array) =>
        p[j] * q[j] + p[j + 1] * q[j + 1] + p[j + 2] * q[j + 2];
      expect(dot(fr.tangent, fr.tangent)).toBeCloseTo(1, 5);
      expect(dot(fr.normal, fr.normal)).toBeCloseTo(1, 5);
      expect(dot(fr.tangent, fr.normal)).toBeCloseTo(0, 5);
      if (i) {
        const k = j - 3;
        const cont = fr.normal[j] * fr.normal[k]
          + fr.normal[j + 1] * fr.normal[k + 1]
          + fr.normal[j + 2] * fr.normal[k + 2];
        expect(cont).toBeGreaterThan(0.99);
      }
    }
  });

  it('points the Frenet normal toward the helix axis', () => {
    const fr = curveFrames(helix.pts, helix.d1, helix.d2, helix.d3);
    const i = 137, j = i * 3;
    // For a helix the principal normal is exactly -(cos ωu, sin ωu, 0).
    const u = i / (N - 1);
    expect(fr.frenetNormal[j]).toBeCloseTo(-Math.cos(w * u), 4);
    expect(fr.frenetNormal[j + 1]).toBeCloseTo(-Math.sin(w * u), 4);
    expect(fr.frenetNormal[j + 2]).toBeCloseTo(0, 4);
  });

  it('closes the frame seam on a circle', () => {
    const circle = sample(
      u => [3 * Math.cos(2 * Math.PI * u), 3 * Math.sin(2 * Math.PI * u), 0],
    );
    const fr = curveFrames(circle.pts);
    expect(fr.closed).toBe(true);
    expect(fr.kappa[200]).toBeCloseTo(1 / 3, 3);
    expect(Math.abs(fr.tau[200])).toBeLessThan(1e-3);
    const e = (N - 1) * 3;
    for (let c = 0; c < 3; c++) expect(fr.normal[e + c]).toBeCloseTo(fr.normal[c], 3);
  });

  it('tolerates NaN samples without poisoning the rest', () => {
    const pts = helix.pts.slice();
    pts.fill(NaN, 50 * 3, 53 * 3);
    const fr = curveFrames(pts);
    expect(fr.kappa[200]).toBeCloseTo(0.4, 2);
    expect(isFinite(fr.normal[300 * 3])).toBe(true);
  });
});

describe('buildTube', () => {
  it('places every ring vertex at the tube radius with unit normals', () => {
    const fr = curveFrames(helix.pts, helix.d1, helix.d2, helix.d3);
    const tube = buildTube(helix.pts, fr, 0.25, 16);
    const stride = 17; // duplicated seam column
    expect(tube.positions.length).toBe(N * stride * 3);
    expect(tube.indices.length).toBe((N - 1) * 16 * 6);
    for (const i of [0, 57, 399]) {
      for (let s = 0; s < stride; s++) {
        const o = (i * stride + s) * 3;
        const dx = tube.positions[o] - helix.pts[i * 3];
        const dy = tube.positions[o + 1] - helix.pts[i * 3 + 1];
        const dz = tube.positions[o + 2] - helix.pts[i * 3 + 2];
        expect(Math.hypot(dx, dy, dz)).toBeCloseTo(0.25, 5);
        expect(Math.hypot(tube.normals[o], tube.normals[o + 1], tube.normals[o + 2])).toBeCloseTo(1, 5);
      }
    }
    for (const ix of tube.indices) expect(ix).toBeLessThan(N * stride);
  });

  it('drops triangles that touch invalid rings', () => {
    const pts = helix.pts.slice();
    pts.fill(NaN, 100 * 3, 101 * 3);
    const fr = curveFrames(pts);
    const tube = buildTube(pts, fr, 0.2, 8);
    expect(tube.indices.length).toBe((N - 1 - 2) * 8 * 6);
    for (const ix of tube.indices) {
      const ring = Math.floor(ix / 9);
      expect(ring).not.toBe(100);
    }
  });

  it('lays material coordinates along arclength and around the RMF ring', () => {
    const fr = curveFrames(helix.pts, helix.d1, helix.d2, helix.d3);
    const tube = buildTube(helix.pts, fr, 0.25, 16);
    const stride = 17;
    // Constant-speed helix: arclength fraction u is linear in the parameter.
    for (const i of [0, 100, 399]) {
      expect(tube.uvs[(i * stride) * 2]).toBeCloseTo(i / (N - 1), 3);
    }
    // Ring seam duplicates position but carries v = 1 instead of 0.
    const i = 100;
    expect(tube.uvs[(i * stride) * 2 + 1]).toBe(0);
    expect(tube.uvs[(i * stride + 16) * 2 + 1]).toBeCloseTo(1, 6);
    for (let c = 0; c < 3; c++) {
      expect(tube.positions[(i * stride + 16) * 3 + c]).toBeCloseTo(tube.positions[(i * stride) * 3 + c], 5);
    }
  });

  it('sizes checker cells to be square-ish and even around closed loops', () => {
    const circle = sample(
      u => [3 * Math.cos(2 * Math.PI * u), 3 * Math.sin(2 * Math.PI * u), 0],
    );
    const fr = curveFrames(circle.pts);
    const tube = buildTube(circle.pts, fr, 0.25, 16);
    const [lenCells, angCells] = tube.cells;
    expect(angCells).toBe(8);
    expect(lenCells % 2).toBe(0);
    // Circumference 2π·3 against angular cell 2π·0.25/8: ~96 cells.
    expect(lenCells).toBeGreaterThan(80);
    expect(lenCells).toBeLessThan(110);
  });
});

describe('combs', () => {
  it('builds teeth of length κ·scale along the given direction', () => {
    const fr = curveFrames(helix.pts, helix.d1, helix.d2, helix.d3);
    const comb = buildComb(helix.pts, fr.frenetNormal, fr.kappa, -1.5, 4);
    // Every 4th sample plus the forced final one.
    expect(comb.teeth.length).toBe((Math.ceil(N / 4) + 1) * 6);
    const dx = comb.teeth[3] - comb.teeth[0];
    const dy = comb.teeth[4] - comb.teeth[1];
    const dz = comb.teeth[5] - comb.teeth[2];
    expect(Math.hypot(dx, dy, dz)).toBeCloseTo(0.4 * 1.5, 4);
    // -scale flips teeth away from the center of curvature.
    expect(dx * fr.frenetNormal[0] + dy * fr.frenetNormal[1] + dz * fr.frenetNormal[2])
      .toBeLessThan(0);
  });

  it('breaks the tip envelope at invalid samples', () => {
    const pts = helix.pts.slice();
    pts.fill(NaN, 0, 3);
    const fr = curveFrames(pts);
    const comb = buildComb(pts, fr.frenetNormal, fr.kappa, 1, 4);
    expect(Number.isNaN(comb.tips[0])).toBe(true);
    expect(isFinite(comb.tips[3])).toBe(true);
  });

  it('normalizes the tallest tooth to a fraction of the curve extent', () => {
    const ext = curveExtent(helix.pts);
    expect(ext).toBeGreaterThan(2);
    const kappa = new Float64Array(N).fill(0.4);
    expect(0.4 * combScale(kappa, ext)).toBeCloseTo(0.18 * ext, 6);
  });

  it('suppresses combs for negligible values instead of amplifying noise', () => {
    const ext = curveExtent(helix.pts);
    const noise = new Float64Array(N).fill(1e-6);
    expect(combScale(noise, ext)).toBe(0);
  });
});

describe('finiteRuns', () => {
  const N = NaN;
  it('is the whole strip when every vertex is finite', () => {
    expect(finiteRuns(new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]))).toEqual([[0, 3]]);
  });
  it('splits at a non-finite vertex, so no strip contains one', () => {
    const pts = new Float32Array([0, 0, 0, 1, 0, 0, N, N, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0]);
    expect(finiteRuns(pts)).toEqual([[0, 2], [3, 3]]);
  });
  it('drops lone points and handles gaps at the ends', () => {
    const pts = new Float32Array([N, 0, 0, 1, 0, 0, 0, Infinity, 0, 2, 0, 0, 3, 0, 0, 0, 0, N]);
    expect(finiteRuns(pts)).toEqual([[3, 2]]);
    expect(finiteRuns(new Float32Array(0))).toEqual([]);
  });
});
