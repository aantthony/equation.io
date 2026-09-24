import { describe, expect, it } from 'vitest';
import { arrowConeInstances, buildUnitCone, coneBasis, CONE_SIDES } from './cone.ts';
import { finiteRuns } from './curve3d.ts';

const cross = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vert = (pos: Float32Array, i: number) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];

describe('buildUnitCone', () => {
  const mesh = buildUnitCone();

  it('puts the tip at the origin and the base in z = −1', () => {
    expect(mesh.positions.length % 3).toBe(0);
    expect(mesh.indices.length).toBe(CONE_SIDES * 2 * 3);
    let sawTip = false,
      sawBase = false;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      if (mesh.positions[i] === 0 && mesh.positions[i + 1] === 0 && mesh.positions[i + 2] === 0) sawTip = true;
      if (mesh.positions[i + 2] === -1 && Math.hypot(mesh.positions[i], mesh.positions[i + 1]) > 0.5) sawBase = true;
    }
    expect(sawTip).toBe(true);
    expect(sawBase).toBe(true);
  });

  it('winds side faces so the normal points outward', () => {
    const i0 = mesh.indices[0],
      i1 = mesh.indices[1],
      i2 = mesh.indices[2];
    const a = vert(mesh.positions, i0),
      b = vert(mesh.positions, i1),
      c = vert(mesh.positions, i2);
    const n = cross(sub(b, a), sub(c, a));
    // The face contains the origin (the tip), so n·centroid is ~0. Outward
    // is away from the axis: n.xy aligns with the base-edge midpoint, n.z > 0.
    const mid = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2];
    expect(n[0] * mid[0] + n[1] * mid[1]).toBeGreaterThan(0);
    expect(n[2]).toBeGreaterThan(0);
  });

  it('winds the cap so the normal points −z', () => {
    const start = CONE_SIDES * 3;
    const i0 = mesh.indices[start],
      i1 = mesh.indices[start + 1],
      i2 = mesh.indices[start + 2];
    const n = cross(
      sub(vert(mesh.positions, i1), vert(mesh.positions, i0)),
      sub(vert(mesh.positions, i2), vert(mesh.positions, i0)),
    );
    expect(n[2]).toBeLessThan(0);
  });
});

describe('coneBasis', () => {
  it('for dir = +x: x = +y, y = +z (right-handed, z-up world)', () => {
    // dir +x, helper (0,0,1): x = (0,0,1)×(1,0,0) = (0,1,0), y = (1,0,0)×(0,1,0) = (0,0,1).
    const b = coneBasis([1, 0, 0]);
    expect(b.z).toEqual([1, 0, 0]);
    expect(b.x[0]).toBeCloseTo(0);
    expect(b.x[1]).toBeCloseTo(1);
    expect(b.x[2]).toBeCloseTo(0);
    expect(b.y[0]).toBeCloseTo(0);
    expect(b.y[1]).toBeCloseTo(0);
    expect(b.y[2]).toBeCloseTo(1);
  });

  it('maps the unit tip to the instance tip and the base behind it', () => {
    const tip: [number, number, number] = [3, 4, 5];
    const { x, y, z } = coneBasis([0, 0, 2]);
    const height = 2,
      radius = 0.8;
    const world = (p: [number, number, number]) => [
      tip[0] + x[0] * p[0] * radius + y[0] * p[1] * radius + z[0] * p[2] * height,
      tip[1] + x[1] * p[0] * radius + y[1] * p[1] * radius + z[1] * p[2] * height,
      tip[2] + x[2] * p[0] * radius + y[2] * p[1] * radius + z[2] * p[2] * height,
    ];
    expect(world([0, 0, 0])).toEqual(tip);
    const base = world([0, 0, -1]);
    expect(base[0]).toBeCloseTo(3);
    expect(base[1]).toBeCloseTo(4);
    expect(base[2]).toBeCloseTo(3);
  });
});

describe('arrowConeInstances', () => {
  it('places a cone at the tip and pulls the shaft back to the base', () => {
    const pts = new Float32Array([0, 0, 0, 10, 0, 0]);
    const { shafts, instances, count } = arrowConeInstances(pts, finiteRuns(pts), 100);
    expect(count).toBe(1);
    expect([...instances.slice(0, 3)]).toEqual([10, 0, 0]);
    expect(instances[3]).toBeCloseTo(1);
    expect(instances[7]).toBeCloseTo(3.2);
    expect(shafts[0]).toBe(0);
    expect(shafts[3]).toBeCloseTo(6.8);
  });

  it('skips a zero-length shaft', () => {
    const pts = new Float32Array([1, 1, 1, 1, 1, 1]);
    expect(arrowConeInstances(pts, [[0, 2]], 10).count).toBe(0);
  });
});
