/**
 * Orbits: `p(50..400)` draws where the state p goes between t = 50 and
 * t = 400, integrated ahead of time from p(0) with the same fixed RK4 step
 * the live simulation takes (state.ts), so a moving p runs along its own
 * orbit. A scalar state draws against time instead: `th(0..20)` is the curve
 * (t, th(t)). A family's orbit is one path per run.
 *
 * Only the states the drawn value reaches are integrated, through their
 * derivatives: the orbit of one run of a 300-run family costs one run.
 */
import type { Env } from './env.ts';
import { type Expr, evaluate, freeVars, substVars } from './expr.ts';
import { STEP } from './state.ts';
import { compileProg, run } from './vm.ts';

/** State-steps one orbit may integrate (a step of every needed state). */
export const ORBIT_WORK_MAX = 24_000_000;
/** Vertices one orbit row may draw, over all its paths. */
export const ORBIT_VERTICES = 200_000;

export interface OrbitInput {
  /** The scalar states integrated, their derivatives and starting values. */
  names: string[];
  derivs: Expr[];
  init: number[];
  /** Drawn per path: coordinates in states, constants and t — or, for a
   *  time series, the single value plotted against t. */
  paths: Expr[][];
  series: boolean;
  from: number;
  to: number;
  /** Values of the constants that hold still over the orbit. */
  env: Record<string, number>;
}

/**
 * The system behind drawing `paths`: every state they reach, with constants
 * that move (read a state or t) inlined, since the orbit evaluates them at
 * its own time rather than the frame's.
 */
export function orbitInput(
  defs: Env,
  paths: readonly (readonly Expr[])[],
  series: boolean,
  from: number,
  to: number,
  env: Record<string, number>,
): OrbitInput {
  if (!(Number.isFinite(from) && Number.isFinite(to))) throw new Error('An orbit needs a finite time range.');
  if (from < 0) throw new Error('An orbit starts at t = 0 or later: the states begin at their (0) values.');
  if (!(to > from)) throw new Error('An orbit runs forward in time: write the earlier time first, like p(0..50).');
  const moving = new Map<string, Expr>();
  for (let changed = true; changed;) {
    changed = false;
    for (const [n, e] of defs.consts) {
      if (moving.has(n)) continue;
      if ([...freeVars(e)].some(v => v === 't' || defs.states.has(v) || moving.has(v))) {
        moving.set(n, e);
        changed = true;
      }
    }
  }
  const inline = (e: Expr): Expr => {
    for (let depth = 0; depth <= moving.size; depth++) {
      const hit = [...freeVars(e)].filter(v => moving.has(v));
      if (!hit.length) return e;
      e = substVars(e, Object.fromEntries(hit.map(v => [v, moving.get(v)!])));
    }
    throw new Error('An orbit cannot read a constant defined in terms of itself.');
  };
  const drawn = paths.map(p => p.map(inline));
  const names: string[] = [];
  const derivs: Expr[] = [];
  const seen = new Set<string>();
  const visit = (e: Expr) => {
    for (const v of freeVars(e)) {
      const state = defs.states.get(v);
      if (!state || seen.has(v)) continue;
      seen.add(v);
      const deriv = inline(state.deriv);
      names.push(v);
      derivs.push(deriv);
      visit(deriv);
    }
  };
  for (const p of drawn) for (const c of p) visit(c);
  const init = names.map(n => {
    try {
      const v = evaluate(defs.states.get(n)!.init, env);
      return Number.isFinite(v) ? v : 0;
    } catch {
      return 0;
    }
  });
  const steps = Math.ceil(to / STEP);
  if (steps * Math.max(1, names.length) > ORBIT_WORK_MAX) {
    throw new Error(
      paths.length > 1
        ? `That is too much to integrate for ${paths.length} runs — draw one run's orbit, like p[1](${fmt(from)}..${fmt(to)}), or a shorter time range.`
        : 'That orbit is too long to integrate — try a shorter time range.',
    );
  }
  const fixed: Record<string, number> = {};
  for (const e of [...drawn.flat(), ...derivs]) {
    for (const v of freeVars(e)) if (v !== 't' && !seen.has(v) && v in env) fixed[v] = env[v];
  }
  return { names, derivs, init, paths: drawn, series, from, to, env: fixed };
}

const fmt = (v: number) => String(parseFloat(v.toPrecision(6)));

/**
 * Integrate an orbit and sample it: the points of every path in turn, each
 * path ended by a NaN point. Integration stops early, as the live simulation
 * does, at the first step that leaves the finite numbers.
 */
export function traceOrbit(input: OrbitInput): number[][] {
  const { names, derivs, init, paths, series, from, to, env } = input;
  const n = names.length;
  const slots = new Map<string, number>();
  names.forEach((name, i) => slots.set(name, i));
  const tSlot = n;
  slots.set('t', tSlot);
  for (const name of Object.keys(env)) if (!slots.has(name)) slots.set(name, slots.size);
  const vars = new Float64Array(slots.size);
  for (const [name, v] of Object.entries(env)) vars[slots.get(name)!] = v;
  const unbound = (e: Expr) => [...freeVars(e)].find(v => !slots.has(v));
  for (const e of [...derivs, ...paths.flat()]) {
    const v = unbound(e);
    if (v) throw new Error(`${v} has no value an orbit can use.`);
  }
  const progs = derivs.map(d => compileProg(d, slots));
  const drawn = paths.map(p => p.map(c => compileProg(c, slots)));
  const stack = new Float64Array(Math.max(64, ...progs.map(p => p.depth), ...drawn.flat().map(p => p.depth)));

  const y = Float64Array.from(init);
  const tmp = new Float64Array(n);
  const k = [new Float64Array(n), new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const deriv = (time: number, at: Float64Array, out: Float64Array): boolean => {
    for (let i = 0; i < n; i++) vars[i] = at[i];
    vars[tSlot] = time;
    for (let i = 0; i < n; i++) {
      const v = run(progs[i], vars, stack);
      if (!Number.isFinite(v)) return false;
      out[i] = v;
    }
    return true;
  };
  const stage = (time: number, scale: number, from: Float64Array, out: Float64Array) => {
    for (let i = 0; i < n; i++) tmp[i] = y[i] + scale * from[i];
    return deriv(time, tmp, out);
  };

  const steps = Math.ceil(to / STEP - 1e-9);
  const first = Math.max(0, Math.floor(from / STEP + 1e-9));
  const stride = Math.max(1, Math.ceil(((steps - first + 1) * paths.length) / ORBIT_VERTICES));
  const out: number[][][] = paths.map(() => []);
  const sample = (time: number) => {
    for (let i = 0; i < n; i++) vars[i] = y[i];
    vars[tSlot] = time;
    drawn.forEach((p, j) => {
      const coords = p.map(prog => run(prog, vars, stack));
      out[j].push(series ? [time, coords[0]] : coords);
    });
  };
  const h = STEP;
  for (let s = 0; ; s++) {
    const time = s * h;
    if (s >= first && ((s - first) % stride === 0 || s === steps)) sample(time);
    if (s >= steps) break;
    if (!deriv(time, y, k[0])) break;
    if (!stage(time + h / 2, h / 2, k[0], k[1])) break;
    if (!stage(time + h / 2, h / 2, k[1], k[2])) break;
    if (!stage(time + h, h, k[2], k[3])) break;
    let ok = true;
    for (let i = 0; i < n; i++) {
      tmp[i] = y[i] + (h / 6) * (k[0][i] + 2 * k[1][i] + 2 * k[2][i] + k[3][i]);
      if (!Number.isFinite(tmp[i])) ok = false;
    }
    if (!ok) break;
    y.set(tmp);
  }
  const dim = series ? 2 : (paths[0]?.length ?? 2);
  return out.flatMap(path => [...path, Array(dim).fill(NaN)]);
}
