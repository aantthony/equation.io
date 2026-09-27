/**
 * A field in space is drawn as a cloud (web/render3d.ts volumeFrag) whose
 * density grows with |F| / scale. The scale is what the field typically
 * reaches in view: a fixed one would draw `x y z` as a solid block and a
 * hydrogen orbital, whose values are thousandths, as nothing.
 */
import { type Expr, freeVars } from './expr.ts';
import { type Prog, compileProg, run } from './vm.ts';

/** Samples per axis of the lattice the scale is read from. */
const LATTICE = 12;
/** The fraction of |F| over the lattice the scale sits above: high enough
 *  that most of the cloud is thin, low enough that a pole (1/r) or a corner
 *  (x y z) does not wash out the rest. */
const QUANTILE = 0.95;

interface Sampler {
  prog: Prog;
  names: string[];
  vars: Float64Array;
  stack: Float64Array;
}

const samplers = new WeakMap<Expr, Sampler | null>();

function sampler(expr: Expr): Sampler | null {
  let s = samplers.get(expr);
  if (s !== undefined) return s;
  const names = ['x', 'y', 'z', ...[...freeVars(expr)].filter(n => n !== 'x' && n !== 'y' && n !== 'z')];
  try {
    const prog = compileProg(expr, new Map(names.map((n, k) => [n, k])));
    s = { prog, names, vars: new Float64Array(names.length), stack: new Float64Array(Math.max(prog.depth, 1)) };
  } catch {
    s = null;
  }
  samplers.set(expr, s);
  return s;
}

/** The size |F| typically reaches over the ball of radius r at center (where
 *  the cloud is at full density), or 1 when it cannot be evaluated here or is
 *  zero throughout. */
export function fieldScale(
  expr: Expr,
  env: Readonly<Record<string, number>>,
  center: readonly number[],
  r: number,
): number {
  const s = sampler(expr);
  if (!s) return 1;
  const { prog, names, vars, stack } = s;
  for (let k = 3; k < names.length; k++) vars[k] = Object.hasOwn(env, names[k]) ? env[names[k]] : NaN;
  const sizes: number[] = [];
  for (let i = 0; i < LATTICE; i++)
    for (let j = 0; j < LATTICE; j++)
      for (let k = 0; k < LATTICE; k++) {
        const dx = (2 * i + 1) / LATTICE - 1;
        const dy = (2 * j + 1) / LATTICE - 1;
        const dz = (2 * k + 1) / LATTICE - 1;
        if (dx * dx + dy * dy + dz * dz > 1) continue;
        vars[0] = center[0] + r * dx;
        vars[1] = center[1] + r * dy;
        vars[2] = center[2] + r * dz;
        const v = Math.abs(run(prog, vars, stack));
        if (Number.isFinite(v)) sizes.push(v);
      }
  if (!sizes.length) return 1;
  sizes.sort((a, b) => a - b);
  const scale = sizes[Math.min(sizes.length - 1, Math.floor(QUANTILE * sizes.length))];
  return scale > 0 ? scale : 1;
}
