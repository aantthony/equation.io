import { type Expr, evaluate, freeVars } from './expr.ts';
import { foldNums } from './defs.ts';
import { hullFaces, hullMesh } from './hull.ts';
import { compileProg, run } from './vm.ts';

/** Immutable drawing buffers, shared across frames until a vertex input changes. */
export interface HullGeometry {
  mesh: ReturnType<typeof hullMesh>;
  edges: Float32Array;
}

export function hullGeometrySampler(points: readonly Expr[], dim: 2 | 3) {
  const names = new Set<string>();
  for (const point of points) freeVars(point, names);
  const dependencies = [...names];
  // Rotations expand into repeated scalar arithmetic. Fold fixed angles and
  // other numeric subtrees once, then run the remaining arithmetic in the VM.
  // Keep unsupported expressions on the interpreter's existing path.
  const slots = new Map(dependencies.map((name, i) => [name, i]));
  const programs = points.map(point => {
    try { return compileProg(foldNums(point, true), slots); } catch { return null; }
  });
  const variables = new Float64Array(dependencies.length);
  const stack = new Float64Array(Math.max(1, ...programs.map(p => p?.depth ?? 0)));
  let previous: number[] | undefined;
  let geometry: HullGeometry | null = null;
  /** `time` stands in for `t`, so a caller can pass its constants uncopied. */
  return (env: Record<string, number>, time?: number): HullGeometry | null => {
    const values = dependencies.map(name => name === 't' && time !== undefined ? time : env[name]);
    if (previous && values.every((value, i) => Object.is(value, previous![i]))) return geometry;
    variables.set(values);
    const fallback = () => time === undefined ? env : { ...env, t: time };
    const coordinates = points.map((point, i) => programs[i] ? run(programs[i]!, variables, stack) : evaluate(point, fallback()));
    let next: HullGeometry | null = null;
    if (coordinates.every(Number.isFinite)) {
      const faces = hullFaces(coordinates, dim);
      // Closed face outlines packed as independent line pairs: one draw per
      // hull, retaining the same edges (including shared edges) as the strips.
      const edges = new Float32Array(faces.reduce((n, face) => n + face.outline.length * 6, 0));
      let offset = 0;
      for (const { outline } of faces) {
        for (let i = 0; i < outline.length; i++) {
          edges.set(outline[i], offset);
          edges.set(outline[(i + 1) % outline.length], offset + 3);
          offset += 6;
        }
      }
      next = { mesh: hullMesh(faces), edges };
    }
    previous = values;
    geometry = next;
    return geometry;
  };
}
