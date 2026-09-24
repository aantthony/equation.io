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
    try { return compileProg(foldNums(p, true), slots); } catch { return null; }
  });
  const variables = new Float64Array(slots.size);
  const stack = new Float64Array(Math.max(1, ...programs.map(p => p?.depth ?? 0)));
  const sample = (env: Readonly<Record<string, number>>, time?: number): number[] => {
    dependencies.forEach((name, i) => { variables[i] = name === 't' && time !== undefined ? time : env[name]; });
    const scope = (): Record<string, number> => (time === undefined ? { ...env } : { ...env, t: time });
    if (!over) return pts.map((p, i) => programs[i] ? run(programs[i]!, variables, stack) : evaluate(p, scope()));
    const n = over[0].values.length, dim = pts.length, first = dependencies.length;
    const out = new Array<number>(n * dim);
    const fallback = programs.some(p => !p) ? scope() : null;
    for (let k = 0; k < n; k++) {
      for (let c = 0; c < over.length; c++) {
        variables[first + c] = over[c].values[k];
        if (fallback) fallback[over[c].name] = over[c].values[k];
      }
      for (let i = 0; i < dim; i++) out[k * dim + i] = programs[i] ? run(programs[i]!, variables, stack) : evaluate(pts[i], fallback!);
    }
    return out;
  };
  return Object.assign(sample, { dependencies });
}
