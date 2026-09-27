/**
 * The coordinates a figure plan draws, flat: `dim` numbers per vertex. A plan
 * either lists its vertices' coordinates outright, or — packed, with `over` —
 * holds one vertex template run once per element of its columns, which is
 * how a path through thousands of computed points stays one small program.
 */
import { type Column, type Expr, evaluate, freeVars } from './expr.ts';
import { foldNums } from './defs.ts';
import { compileProg, run } from './vm.ts';

export interface VertexSampler {
  /** The constants (and t) the coordinates read, in the order they are read. */
  readonly dependencies: readonly string[];
  /** Coordinates for these constant values. `time` stands in for `t`, so a
   *  caller can pass its constants uncopied. */
  (env: Readonly<Record<string, number>>, time?: number): number[];
}

export function vertexSampler(pts: readonly Expr[], over?: readonly Column[]): VertexSampler {
  const names = new Set<string>();
  for (const p of pts) freeVars(p, names);
  for (const c of over ?? []) names.delete(c.name);
  const dependencies = [...names];
  // The columns take the slots after the constants: one write per element.
  const slots = new Map([...dependencies, ...(over ?? []).map(c => c.name)].map((name, i) => [name, i]));
  // Rotations expand into repeated scalar arithmetic: fold fixed numeric
  // subtrees once, then run the rest in the VM. A coordinate the VM cannot
  // compile keeps the interpreter.
  const programs = pts.map(p => {
    try {
      return compileProg(foldNums(p, true), slots);
    } catch {
      return null;
    }
  });
  const variables = new Float64Array(slots.size);
  const stack = new Float64Array(Math.max(1, ...programs.map(p => p?.depth ?? 0)));
  const sample = (env: Readonly<Record<string, number>>, time?: number): number[] => {
    dependencies.forEach((name, i) => {
      variables[i] = name === 't' && time !== undefined ? time : env[name];
    });
    const scope = (): Record<string, number> => (time === undefined ? { ...env } : { ...env, t: time });
    if (!over) return pts.map((p, i) => (programs[i] ? run(programs[i]!, variables, stack) : evaluate(p, scope())));
    const n = over[0].values.length,
      dim = pts.length,
      first = dependencies.length;
    const out = new Array<number>(n * dim);
    const fallback = programs.some(p => !p) ? scope() : null;
    for (let k = 0; k < n; k++) {
      for (let c = 0; c < over.length; c++) {
        variables[first + c] = over[c].values[k];
        if (fallback) fallback[over[c].name] = over[c].values[k];
      }
      for (let i = 0; i < dim; i++)
        out[k * dim + i] = programs[i] ? run(programs[i]!, variables, stack) : evaluate(pts[i], fallback!);
    }
    return out;
  };
  return Object.assign(sample, { dependencies });
}

/**
 * Whether a closed polygon in space (x, y, z per vertex, not repeating the
 * first) fills correctly as a triangle fan from its first vertex: planar,
 * and every fan triangle turning the same way about the polygon's normal.
 * That holds for every convex polygon and for a star-shaped one seen from
 * vertex 0 — a sector past 180° starts at its centre — and fails for a
 * skew or concave outline, which then stays an outline rather than filling
 * across itself.
 */
export function fanFillable(pts: ArrayLike<number>): boolean {
  const n = pts.length / 3;
  if (n < 3) return false;
  const at = (k: number, i: number) => pts[k * 3 + i];
  // Newell's normal, robust for any simple polygon.
  let nx = 0,
    ny = 0,
    nz = 0,
    extent = 0;
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    nx += (at(k, 1) - at(j, 1)) * (at(k, 2) + at(j, 2));
    ny += (at(k, 2) - at(j, 2)) * (at(k, 0) + at(j, 0));
    nz += (at(k, 0) - at(j, 0)) * (at(k, 1) + at(j, 1));
    for (let i = 0; i < 3; i++) extent = Math.max(extent, Math.abs(at(k, i) - at(0, i)));
  }
  const len = Math.hypot(nx, ny, nz);
  if (!(len > 0) || !(extent > 0)) return false;
  nx /= len;
  ny /= len;
  nz /= len;
  const tol = 1e-6 * extent;
  for (let k = 1; k < n; k++) {
    const dx = at(k, 0) - at(0, 0),
      dy = at(k, 1) - at(0, 1),
      dz = at(k, 2) - at(0, 2);
    if (Math.abs(dx * nx + dy * ny + dz * nz) > 1e-4 * extent) return false; // not planar
    if (k + 1 < n) {
      const ex = at(k + 1, 0) - at(0, 0),
        ey = at(k + 1, 1) - at(0, 1),
        ez = at(k + 1, 2) - at(0, 2);
      const turn = (dy * ez - dz * ey) * nx + (dz * ex - dx * ez) * ny + (dx * ey - dy * ex) * nz;
      if (turn < -tol * extent) return false;
    }
  }
  return true;
}
