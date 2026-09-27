/**
 * The critical points of a Hamiltonian H, for drawing its energy contours
 * (web/main.ts): the separatrices, the level sets through its saddles, which
 * divide the phase plane into kinds of motion (a pendulum's swinging from its
 * spinning), and the values of H at its wells and humps, which set how far
 * apart the other contours go.
 *
 * A critical point is a zero of ∇H; a saddle is one where the Hessian's
 * determinant is negative. Newton's method on ∇H, from each cell of a grid
 * over the box where both of its components change sign, finds them. Values
 * of H are merged when they repeat (a pendulum's saddles at ±π, ±3π … are one
 * level). Everything runs in the compiled VM: the whole search is a few
 * thousand evaluations.
 */
import { diff } from './diff.ts';
import { type Expr } from './expr.ts';
import { compileProg, run } from './vm.ts';

export interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface CriticalLevels {
  /** H at the saddles, ascending: the separatrices. */
  separatrices: number[];
  /** H at every critical point (saddles, wells, humps), ascending. */
  critical: number[];
}

/** At most this many separatrices: a uniform array's length in the shader. */
export const MAX_SEPARATRICES = 4;

type Fn = (x: number, y: number) => number;

/**
 * Compile H's gradient and Hessian against `params`; null when H has a form
 * the VM does not run or does not differentiate (then no separatrix is
 * drawn, and the ordinary contours still are).
 */
export function criticalFinder(
  H: Expr,
  params: readonly string[],
): ((env: Record<string, number>, box: Box) => CriticalLevels) | null {
  const slots = new Map<string, number>([['x', 0], ['y', 1], ...params.map((n, k): [string, number] => [n, k + 2])]);
  const vars = new Float64Array(params.length + 2);
  let fns: Fn[];
  try {
    const hx = diff(H, 'x');
    const hy = diff(H, 'y');
    const exprs = [H, hx, hy, diff(hx, 'x'), diff(hx, 'y'), diff(hy, 'y')];
    fns = exprs.map(e => {
      const prog = compileProg(e, slots);
      const stack = new Float64Array(Math.max(prog.depth, 1));
      return (x, y) => {
        vars[0] = x;
        vars[1] = y;
        return run(prog, vars, stack);
      };
    });
  } catch {
    return null;
  }
  const [h, hx, hy, hxx, hxy, hyy] = fns;
  return (env, box) => {
    params.forEach((n, k) => {
      vars[k + 2] = Object.hasOwn(env, n) ? env[n] : NaN;
    });
    return criticalLevels(h, hx, hy, hxx, hxy, hyy, box);
  };
}

function criticalLevels(h: Fn, hx: Fn, hy: Fn, hxx: Fn, hxy: Fn, hyy: Fn, box: Box): CriticalLevels {
  const N = 32;
  const cw = (box.x1 - box.x0) / N;
  const ch = (box.y1 - box.y0) / N;
  const size = Math.hypot(box.x1 - box.x0, box.y1 - box.y0);
  // ∇H at the grid's corners: a zero of it lies in a cell where both
  // components change sign (or touch 0), and Newton from that cell's centre
  // is inside its basin, where a coarse seed may not be.
  const gx: number[] = [];
  const gy: number[] = [];
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      gx.push(hx(box.x0 + i * cw, box.y0 + j * ch));
      gy.push(hy(box.x0 + i * cw, box.y0 + j * ch));
    }
  }
  const changes = (g: number[], i: number, j: number): boolean => {
    const c = [g[i * (N + 1) + j], g[(i + 1) * (N + 1) + j], g[i * (N + 1) + j + 1], g[(i + 1) * (N + 1) + j + 1]];
    return c.every(Number.isFinite) && Math.min(...c) <= 0 && Math.max(...c) >= 0;
  };
  const found: Array<[number, number]> = [];
  const separatrices: number[] = [];
  const critical: number[] = [];
  const addTo = (list: number[], v: number) => {
    if (!list.some(l => Math.abs(l - v) <= 1e-9 * Math.max(1, Math.abs(v)))) list.push(v);
  };
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      if (!changes(gx, i, j) || !changes(gy, i, j)) continue;
      let x = box.x0 + (i + 0.5) * cw;
      let y = box.y0 + (j + 0.5) * ch;
      let det = NaN;
      let converged = false;
      for (let it = 0; it < 20; it++) {
        const a = hxx(x, y);
        const b = hxy(x, y);
        const d = hyy(x, y);
        det = a * d - b * b;
        if (!Number.isFinite(det) || det === 0) break;
        const px = hx(x, y);
        const py = hy(x, y);
        const dx = (d * px - b * py) / det;
        const dy = (a * py - b * px) / det;
        x -= dx;
        y -= dy;
        if (Math.hypot(dx, dy) < 1e-10 * size) {
          converged = true;
          break;
        }
      }
      if (!converged || !Number.isFinite(det) || det === 0) continue;
      // It must be this cell's zero (a neighbour finds its own), in the box.
      if (Math.abs(x - (box.x0 + (i + 0.5) * cw)) > cw || Math.abs(y - (box.y0 + (j + 0.5) * ch)) > ch) continue;
      if (found.some(([fx, fy]) => Math.hypot(fx - x, fy - y) < 1e-6 * size)) continue;
      found.push([x, y]);
      const v = h(x, y);
      if (!Number.isFinite(v)) continue;
      addTo(critical, v);
      if (det < 0) addTo(separatrices, v);
    }
  }
  const up = (p: number, q: number) => p - q;
  return { separatrices: separatrices.sort(up).slice(0, MAX_SEPARATRICES), critical: critical.sort(up) };
}
