/**
 * Time integration for state definitions (`a' = …`, `a(0) = …`).
 *
 * Every other value in a graph is a formula the renderer can evaluate at any
 * t, which is why scrubbing time is free. A state is the exception: it is
 * carried from frame to frame, so systems with no closed form — a driven
 * oscillator, a double pendulum — can be graphed at all. Downstream a state
 * is just another entry in the constant environment (a uniform in GLSL), so
 * nothing else has to know it is integrated.
 *
 * Stepping is RK4 at a fixed step, decoupled from the frame rate: a chaotic
 * system integrated at whatever dt the display happened to deliver is not
 * reproducible even on the same machine.
 */
import { type Defs, evalConstEnv } from './defs.ts';
import { type Expr, evaluate, freeVars } from './expr.ts';

export interface StateSystem {
  names: string[];
  derivs: Expr[];
  /**
   * Identity of the system as written. Recompiling on every keystroke rebuilds
   * this; an unchanged key means the run in progress survives the edit.
   */
  key: string;
}

/** Fixed integration step, in seconds of graph time. */
const STEP = 1 / 240;
/** Most steps per frame: past this the simulation runs slow rather than
 *  freezing the page (a backgrounded tab can hand back a gap of minutes). */
const MAX_STEPS = 60;

/** A stable structural key for an expression, used for change detection. */
function exprKey(e: Expr): string {
  switch (e.kind) {
    case 'num': return String(e.value);
    case 'var': return e.name;
    case 'neg': return `-(${exprKey(e.a)})`;
    case 'bin': return `(${exprKey(e.a)}${e.op}${exprKey(e.b)})`;
    case 'call': return `${e.name}(${e.args.map(exprKey).join(',')})`;
    case 'eq': return `(${exprKey(e.l)}=${exprKey(e.r)})`;
    case 'ineq': return `(${exprKey(e.l)}${e.op}${exprKey(e.r)})`;
    case 'vec': return `(${e.items.map(exprKey).join(',')})`;
    case 'list': return `[${e.items.map(exprKey).join(',')}]`;
    case 'data': return `#${e.values.length}`;
    case 'piecewise':
      return `{${e.cases.map(c => `${exprKey(c.cond)}:${exprKey(c.value)}`).join(',')}${e.otherwise ? `,${exprKey(e.otherwise)}` : ''}}`;
  }
}

/** The system to integrate, or null when the graph defines no states. */
export function buildStateSystem(defs: Defs): StateSystem | null {
  if (!defs.states.size) return null;
  const names = [...defs.states.keys()];
  const derivs = names.map(n => defs.states.get(n)!.deriv);
  const key = names
    .map(n => `${n}'=${exprKey(defs.states.get(n)!.deriv)};${n}(0)=${exprKey(defs.states.get(n)!.init)}`)
    .join('\n');
  return { names, derivs, key };
}

/** Starting values, read from the `a(0)` expressions against the constants. */
export function initialState(defs: Defs, sys: StateSystem): Record<string, number> {
  const out: Record<string, number> = {};
  let env: Record<string, number> = {};
  try {
    // Constants that read a state cannot be resolved before there is one;
    // initial values may not use states, so those failures don't matter here.
    env = evalConstEnv(defs, 0, Object.fromEntries(sys.names.map(n => [n, 0])));
  } catch { /* leave env empty: an init using a broken constant lands on 0 */ }
  for (const name of sys.names) {
    let v = 0;
    try {
      v = evaluate(defs.states.get(name)!.init, env);
    } catch { /* keep 0 */ }
    out[name] = isFinite(v) ? v : 0;
  }
  return out;
}

/** Constants whose value moves under the integrator, so the derivative sees a
 *  fresh environment at every RK4 stage rather than one per frame. */
function dynamicConsts(defs: Defs): boolean {
  for (const e of defs.consts.values()) {
    for (const fv of freeVars(e)) {
      if (fv === 't' || defs.states.has(fv)) return true;
    }
  }
  return false;
}

/**
 * Integrate `values` from `from` towards `to` (both in seconds of graph time),
 * in place. Returns the time actually reached: only whole steps are taken, so
 * the leftover carries to the next frame and the trajectory is the same
 * sequence of steps at any frame rate — which is the only way two runs of a
 * chaotic system agree.
 *
 * Beyond MAX_STEPS the excess is dropped rather than queued: a backgrounded
 * tab hands back a gap of minutes, and a backlog that large can never be
 * worked off. Such a run comes back slow, not stuck.
 *
 * A step that produces a non-finite value is rolled back and integration
 * stops: a blown-up system holds its last good frame instead of vanishing.
 */
export function advanceState(
  defs: Defs,
  sys: StateSystem,
  values: Record<string, number>,
  from: number,
  to: number,
): number {
  const n = sys.names.length;
  // The epsilon keeps a frame that is a whole number of steps long from
  // losing one to float dust and running a step behind ever after.
  let steps = Math.floor((to - from) / STEP + 1e-9);
  if (steps <= 0) return from;
  let reached = from + steps * STEP;
  if (steps > MAX_STEPS) {
    steps = MAX_STEPS;
    reached = to;
  }
  const perStage = dynamicConsts(defs);

  // Constants that hold still for the whole call are evaluated once; the rest
  // (and anything reading a state) are re-evaluated per stage below.
  let base: Record<string, number> = {};
  if (!perStage) {
    try {
      base = evalConstEnv(defs, to, values);
    } catch {
      // A half-typed definition: hold the state where it is and stay glued to
      // the clock, so finishing the edit resumes rather than fast-forwards.
      return to;
    }
  }

  const y = sys.names.map(name => values[name] ?? 0);
  const tmp = new Array<number>(n);
  const k1 = new Array<number>(n);
  const k2 = new Array<number>(n);
  const k3 = new Array<number>(n);
  const k4 = new Array<number>(n);

  /** dy/dt at `time` for the state vector `at`, into `out`. False if it is
   *  not a finite number anywhere (a pole, a broken definition). */
  const deriv = (time: number, at: number[], out: number[]): boolean => {
    let env: Record<string, number>;
    try {
      if (perStage) {
        const seed: Record<string, number> = {};
        for (let i = 0; i < n; i++) seed[sys.names[i]] = at[i];
        env = evalConstEnv(defs, time, seed);
      } else {
        env = { ...base };
        for (let i = 0; i < n; i++) env[sys.names[i]] = at[i];
      }
      env.t = time;
      for (let i = 0; i < n; i++) {
        const v = evaluate(sys.derivs[i], env);
        if (!isFinite(v)) return false;
        out[i] = v;
      }
    } catch {
      return false;
    }
    return true;
  };

  /** An RK4 midpoint/endpoint stage: sample the derivative at y + scale·k. */
  const stage = (time: number, scale: number, k: number[], out: number[]): boolean => {
    for (let i = 0; i < n; i++) tmp[i] = y[i] + scale * k[i];
    return deriv(time, tmp, out);
  };

  const h = STEP;
  let now = from;
  for (let s = 0; s < steps; s++) {
    if (!deriv(now, y, k1)) break;
    if (!stage(now + h / 2, h / 2, k1, k2)) break;
    if (!stage(now + h / 2, h / 2, k2, k3)) break;
    if (!stage(now + h, h, k3, k4)) break;
    let ok = true;
    for (let i = 0; i < n; i++) {
      tmp[i] = y[i] + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
      if (!isFinite(tmp[i])) ok = false;
    }
    if (!ok) break;
    for (let i = 0; i < n; i++) y[i] = tmp[i];
    now += h;
  }

  for (let i = 0; i < n; i++) values[sys.names[i]] = y[i];
  return reached;
}
