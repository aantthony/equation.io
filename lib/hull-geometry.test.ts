import { describe, expect, it, vi } from 'vitest';
import { evaluate, parseExpr } from './expr.ts';
import { hullFaces, hullMesh } from './hull.ts';
import { hullGeometrySampler } from './hull-geometry.ts';
import { RetainedGeometry } from '../web/retained-geometry.ts';

describe('cached hull geometry', () => {
  it('reuses geometry across camera/time changes but updates every vertex dependency', () => {
    const sample = hullGeometrySampler(
      ['0', '0', 's', '0', '0', 'h'].map(s => parseExpr(s)),
      2,
    );
    const first = sample({ s: 2, h: 3, t: 0 })!;
    expect(sample({ s: 2, h: 3, t: 1, unrelated: 9 })).toBe(first);
    const scaled = sample({ s: 4, h: 3, t: 1 })!;
    expect(scaled).not.toBe(first);
    expect([...scaled.mesh.positions]).toContain(4);
    expect(sample({ s: 4, h: 5 })).not.toBe(scaled);
    // Three edges, each represented by two 3D endpoints, including closure.
    expect([...first.edges]).toEqual([0, 0, 0, 2, 0, 0, 2, 0, 0, 0, 3, 0, 0, 3, 0, 0, 0, 0]);
  });

  it('updates animated hulls and recovers from non-finite inputs', () => {
    const sample = hullGeometrySampler(
      ['0', '0', '1', '0', '0', 'sqrt(t)'].map(s => parseExpr(s)),
      2,
    );
    const first = sample({ t: 1 });
    expect(sample({ t: 4 })).not.toBe(first);
    expect(sample({ t: -1 })).toBeNull();
    expect(sample({ t: -1 })).toBeNull();
    expect(sample({ t: 1 })).toEqual(first);
  });

  it('takes the time as its own argument so the constants need no copy', () => {
    const consts = { s: 2 };
    const sample = hullGeometrySampler(
      ['0', '0', 's', '0', '0', 'sqrt(t)'].map(s => parseExpr(s)),
      2,
    );
    const first = sample(consts, 1)!;
    expect(sample(consts, 1)).toBe(first);
    expect(sample(consts, 4)).not.toBe(first);
    expect(consts).toEqual({ s: 2 });
    expect(sample(consts, 1)).toEqual(sample({ s: 2, t: 1 }));
  });

  it('folds fixed angles once and still matches the interpreter', () => {
    // cos(pi/3) and friends fold to numbers before compiling; a call the VM
    // cannot compile falls back to the interpreter with the same time.
    const points = ['0', '0', 's*cos(pi/3)', 's*sin(pi/3)', 'floor(t)*cos(pi/3)', 'sin(pi/3)'].map(s => parseExpr(s));
    const sample = hullGeometrySampler(points, 2);
    for (const [s, t] of [
      [1, 0.5],
      [2, 1.5],
      [-1, 2.9],
    ]) {
      const expected = hullMesh(
        hullFaces(
          points.map(p => evaluate(p, { s, t })),
          2,
        ),
      );
      expect(sample({ s }, t)!.mesh).toEqual(expected);
    }
  });

  it('keeps degenerate line hulls and empty hulls drawable', () => {
    const line = hullGeometrySampler(
      ['0', '0', '0', '1', '1', '1'].map(s => parseExpr(s)),
      3,
    )({})!;
    expect(line.mesh.indices.length).toBe(0);
    expect([...line.edges]).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0]);
    expect(hullGeometrySampler([], 3)({})!.edges.length).toBe(0);
  });

  it('matches interpreted geometry through positive, zero, and negative scales', () => {
    const points = ['0', '0', 's*cos(pi/3)', 's*sin(pi/3)', '-s*sin(pi/3)', 's*cos(pi/3)'].map(s => parseExpr(s));
    const sample = hullGeometrySampler(points, 2);
    for (const s of [1, 0.2, 0, -0.2, -1]) {
      const expected = hullMesh(
        hullFaces(
          points.map(p => evaluate(p, { s })),
          2,
        ),
      );
      expect(sample({ s })!.mesh).toEqual(expected);
    }
  });
});

describe('retained GPU geometry', () => {
  it('uploads once, frees replaced geometry, and clears the remaining buffers', () => {
    const gl = {
      ARRAY_BUFFER: 1,
      ELEMENT_ARRAY_BUFFER: 2,
      STATIC_DRAW: 3,
      FLOAT: 4,
      createVertexArray: vi.fn(() => ({})),
      createBuffer: vi.fn(() => ({})),
      bindVertexArray: vi.fn(),
      bindBuffer: vi.fn(),
      bufferData: vi.fn(),
      enableVertexAttribArray: vi.fn(),
      vertexAttribPointer: vi.fn(),
      deleteVertexArray: vi.fn(),
      deleteBuffer: vi.fn(),
    };
    const cache = new RetainedGeometry(gl as unknown as WebGL2RenderingContext);
    const points = new Float32Array(9),
      indices = new Uint32Array([0, 1, 2]);
    cache.bind(points, [{ data: points, size: 3 }], indices);
    cache.endFrame();
    cache.bind(points, [{ data: points, size: 3 }], indices);
    cache.endFrame();
    expect(gl.bufferData).toHaveBeenCalledTimes(2);
    expect(gl.deleteBuffer).not.toHaveBeenCalled();
    const next = new Float32Array(6);
    cache.bind(next, [{ data: next, size: 3 }]);
    cache.endFrame();
    expect(gl.bufferData).toHaveBeenCalledTimes(3);
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(2);
    expect(gl.deleteVertexArray).toHaveBeenCalledTimes(1);
    cache.clear();
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(3);
    expect(gl.deleteVertexArray).toHaveBeenCalledTimes(2);
    cache.clear();
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(3);
  });
});
