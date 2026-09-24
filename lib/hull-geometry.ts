import type { Column, Expr } from './expr.ts';
import { vertexSampler } from './figure-vertices.ts';
import { hullFaces, hullMesh } from './hull.ts';

/** Immutable drawing buffers, shared across frames until a vertex input changes. */
export interface HullGeometry {
  mesh: ReturnType<typeof hullMesh>;
  edges: Float32Array;
}

export function hullGeometrySampler(points: readonly Expr[], dim: 2 | 3, over?: readonly Column[]) {
  const sample = vertexSampler(points, over);
  const { dependencies } = sample;
  let previous: number[] | undefined;
  let geometry: HullGeometry | null = null;
  /** `time` stands in for `t`, so a caller can pass its constants uncopied. */
  return (env: Record<string, number>, time?: number): HullGeometry | null => {
    const values = dependencies.map(name => (name === 't' && time !== undefined ? time : env[name]));
    if (previous && values.every((value, i) => Object.is(value, previous![i]))) return geometry;
    const coordinates = sample(env, time);
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
