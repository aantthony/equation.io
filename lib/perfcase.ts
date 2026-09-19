/**
 * Shared corpus + row-compilation pipeline for the performance guard tests
 * (perf-guards.test.ts, perf-smoke.test.ts, perf.bench.ts).
 *
 * compileRows mirrors web/main.ts recompileAll: scan definition rows, build
 * defs, then resolve + classify the plot rows against them. Kept in sync by
 * hand; if recompileAll gains steps that affect compile output, add them here.
 */
import {
  animatedConstNames,
  buildDefs,
  compsOf,
  defKey,
  evalConstEnv,
  resolveExpr,
  scanDefinition,
  type Definition,
} from './defs.ts';
import { buildStateSystem, initialState } from './state.ts';
import { parseExpr, substVars } from './expr.ts';
import { lowerGeom } from './geom.ts';
import { type Classified, classify } from './plot.ts';
import { buildGridField, type GridField } from './grid.ts';
import { classifySeqRec, scanSeqRec } from './seq.ts';

export interface CompiledRows {
  classified: Classified[];
  gridFields: GridField[];
  errors: string[];
}

export function compileRows(rows: string[]): CompiledRows {
  const raw: Definition[] = [];
  const seen = new Set<string>();
  const plotTexts: string[] = [];
  for (const text0 of rows) {
    const text = text0.trim();
    if (!text) continue;
    // Sequence/recurrence rows (a_n = …, a_{n+1} = …) are plots, not
    // definitions, exactly as recompileAll skips them before scanDefinition.
    if (scanSeqRec(text)) {
      plotTexts.push(text);
      continue;
    }
    const d = scanDefinition(text);
    if (d && !seen.has(defKey(d))) {
      seen.add(defKey(d));
      raw.push(d);
      continue;
    }
    plotTexts.push(text);
  }
  const built = buildDefs(raw);
  const errors = [...built.errors.values()];
  // States are constants to every consumer (uniforms in GLSL), exactly as
  // recompileAll folds them into the same name set.
  const constNames = new Set([...built.defs.consts.keys(), ...built.defs.states.keys()]);
  const gridFields: GridField[] = [];
  for (const [name, e] of built.defs.fields) {
    gridFields.push(buildGridField(name, e, constNames));
  }
  const fieldEnv = Object.fromEntries(built.defs.fields);
  const fnNames = new Set(raw.filter(d => d.kind === 'fn').map(d => d.name));
  const getFn = (name: string) => built.defs.fns.get(name);
  // Σ/Π bounds expand against constant *values*, so they need the same env
  // recompileAll builds (animated constants excluded).
  let constVals: Record<string, number> = {};
  try {
    const sys = buildStateSystem(built.defs);
    constVals = evalConstEnv(built.defs, 0, sys ? initialState(built.defs, sys) : {});
  } catch {}
  for (const name of animatedConstNames(built.defs)) delete constVals[name];
  for (const name of built.defs.states.keys()) delete constVals[name];
  const ropts = { consts: constVals, boundConsts: built.sumBoundConsts };
  const classified: Classified[] = [];
  for (const text of plotTexts) {
    // Sequences/recurrences classify through their own path (lib/seq.ts),
    // same as recompileAll; lists and piecewise ride the ordinary parse.
    const seq = scanSeqRec(text);
    if (seq) {
      classified.push(classifySeqRec(seq, fnNames, getFn, constNames, ropts));
      continue;
    }
    let parsed = resolveExpr(parseExpr(text, fnNames), getFn, ropts);
    // Expand point arithmetic and geometry statements like the app does.
    parsed = lowerGeom(parsed, n => compsOf(built.defs, n), n => built.defs.mats.get(n) ?? null);
    if (built.defs.fields.size) parsed = substVars(parsed, fieldEnv);
    classified.push(classify(parsed, constNames));
  }
  return { classified, gridFields, errors };
}

/**
 * Representative rows spanning every compile path, each with a slider
 * constant so uniform-parameterization can be asserted. When a new plot
 * family lands, add a case here (and a budget in perf-guards.test.ts).
 */
export const CORPUS: { name: string; rows: (c: number) => string[] }[] = [
  { name: 'scalar2d', rows: c => [`a = ${c}`, 'y = sin(a x) + x^2/4'] },
  { name: 'implicit2d', rows: c => [`c = ${c}`, 'x^2 + y^2 = c^2'] },
  { name: 'ineq2d', rows: c => [`a = ${c}`, 'y < a x^2'] },
  { name: 'complex2d', rows: c => [`a = ${c}`, 'w^2 + a'] },
  { name: 'pcurve3d', rows: c => [`k = ${c}`, '(cos(2pi k u), sin(2pi k u), u)'] },
  { name: 'psurface', rows: c => [`b = ${c}`, '(u, v, b u v)'] },
  { name: 'implicit3d', rows: c => [`b = ${c}`, 'z = sin(b x) cos(b y)'] },
  { name: 'point', rows: c => [`a = ${c}`, '(a, a^2)'] },
  { name: 'derivative', rows: c => [`a = ${c}`, 'y = d/dx (sin(a x) x^2)'] },
  { name: 'userfn', rows: c => [`a = ${c}`, 'f(x) = a x^2 + sin(x)', 'y = f(f(x))'] },
  { name: 'polarfield', rows: c => [`a = ${c}`, 'r = sqrt(x^2 + y^2)', 'r = 2a'] },
  { name: 'vfield2d', rows: c => [`a = ${c}`, '(-a y, a x)'] },
  { name: 'ode2d', rows: c => [`a = ${c}`, 'dy/dx = a x y'] },
  { name: 'domain2d', rows: c => [`a = ${c}`, 'domain((w^3 - a)/w)'] },
  { name: 'conformal2d', rows: c => [`a = ${c}`, 'conformal(w^2/a)'] },
  { name: 'fractal2d', rows: c => [`a = ${c}`, 'iter(z^2 + w/a)'] },
  // Sequences, recurrences, lists, piecewise, and number theory (README rows).
  { name: 'sequence', rows: c => [`a = ${c}`, 'a_n = a/n^2'] },
  { name: 'seq-isprime', rows: c => [`a = ${c}`, 'a_n = a isprime(n)'] },
  { name: 'seq-sum-term', rows: c => [`a = ${c}`, 'a_n = a sum(k=1..3, k^n)'] },
  { name: 'cobweb', rows: c => [`r = ${c}`, 'a_{n+1} = r a_n (1 - a_n)'] },
  { name: 'cobweb-seed', rows: c => [`a_0 = ${c}`, 'a_{n+1} = a_n/2 + 1'] },
  { name: 'bifurcation', rows: c => [`a_0 = ${c}`, 'a_{n+1} = x a_n (1 - a_n)'] },
  { name: 'vlist', rows: c => [`a = ${c}`, '[a, 1, 4, 1, 5]'] },
  { name: 'plist', rows: c => [`a = ${c}`, '[(a, 2), (3, 4)]'] },
  { name: 'plist3d', rows: c => [`a = ${c}`, '[(1, 2, a), (4, 5, 6)]'] },
  { name: 'piecewise', rows: c => [`a = ${c}`, 'y = {x < 0: -a x, x >= 0: a x^2}'] },
  { name: 'piecewise-default', rows: c => [`a = ${c}`, 'y = {x < a: sin(x), cos(x)}'] },
  { name: 'gcd2d', rows: c => [`a = ${c}`, 'y = gcd(floor(x), floor(a x))'] },
  // Square systems carry residual Exprs (CPU-solved), no GLSL.
  { name: 'system2d', rows: c => [`a = ${c}`, '(x^2 + y^2 - a, x y - 1) = (0, 0)'] },
  { name: 'system3d', rows: c => [`a = ${c}`, '(x + y, x - y, z - a) = (1, 2, 3)'] },
  // Time-integrated state (a' = …): the state a is a u_a uniform downstream,
  // so neither the deriv constant k nor the a(0) slider may leak into GLSL.
  { name: 'state', rows: c => [`k = ${c}`, "a' = -k a + sin(t)", `a(0) = ${c}`, 'y = a sin(x)'] },
];

/**
 * Σ/Π is the one compile path that deliberately breaks uniform
 * parameterization: bounds expand at compile time, so the bound constant's
 * *value* is baked into the output and every step of an N slider produces
 * new GLSL — and a new shader compile. Kept out of CORPUS (which asserts the
 * invariant) and pinned separately in perf-guards.test.ts, so the cost stays
 * measured rather than forgotten.
 */
export const SUM_CASE = (n: number) => [`N = ${n}`, 'y = (4/pi) sum(k=1..N, sin((2k-1)x)/(2k-1))'];

/** Structural size of an expression tree (perf proxy for symbolic swell). */
export { countNodes } from './size.ts';
