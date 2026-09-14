/** Equation-native least squares: observed-list ~ model-list.
 * Unbound scalar names are coefficients; already defined constants stay fixed.
 * Fits never change an equation's text or introduce hidden slider values.
 */
import { diff } from './diff.ts';
import { type Expr, evaluate, freeVars } from './expr.ts';

export interface RegressionRow { kind: 'regression'; name: string; lhs: string; rhs: string }

/** A declared data name on the left disambiguates regression from a random
 * variable declaration. Explicit lists/columns also unambiguously mean data.
 * Distribution syntax keeps its existing meaning (and collision diagnostics).
 */
export function scanRegressions(texts: readonly string[]): Map<number, RegressionRow> {
  const declared = new Set(texts.flatMap(t => {
    const m = /^\s*([A-Za-z_]\w*)\s*=(?!=)/.exec(t);
    return m ? [m[1]] : [];
  }));
  const out = new Map<number, RegressionRow>();
  texts.forEach((text, i) => {
    if (text.trim().startsWith('#')) return;
    let quote = '', depth = 0, tilde = -1;
    for (let k = 0; k < text.length; k++) {
      const c = text[k];
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === '"' || (c === "'" && !/[\w)\]}']/.test(text[k - 1] ?? ''))) { quote = c; continue; }
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      else if (c === '~' && depth === 0) { if (tilde >= 0) return; tilde = k; }
    }
    if (tilde < 0) return;
    const lhs = text.slice(0, tilde).trim(), rhs = text.slice(tilde + 1).trim();
    if (/^(?:Normal|N|Uniform|U|Exponential)\s*(?:\(|$)/i.test(rhs) || /^Exp\s*(?:\(|$)/.test(rhs)) return;
    if (declared.has(lhs) || /[.\[\](+*/-]/.test(lhs)) {
      out.set(i, { kind: 'regression', name: `~${i}`, lhs, rhs });
    }
  });
  return out;
}

export interface FitResult {
  coefficients: Record<string, number>;
  count: number;
  skipped: number;
  rmse: number;
  r2: number | null;
  nonlinear: boolean;
}

/** Modified Gram–Schmidt with reorthogonalization and column scaling.
 * Avoids normal equations and rejects rank-deficient models explicitly.
 */
function leastSquares(columns: number[][], target: number[]): number[] {
  const n = columns.length;
  const q: number[][] = [];
  const r = Array.from({ length: n }, () => Array(n).fill(0) as number[]);
  const scale = columns.map(c => Math.hypot(...c));
  const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
  for (let j = 0; j < n; j++) {
    if (!(scale[j] > 0) || !Number.isFinite(scale[j])) throw new Error('Regression coefficients are not identifiable: the model is rank deficient.');
    const v = columns[j].map(x => x / scale[j]);
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < j; k++) {
        const a = dot(q[k], v);
        r[k][j] += a;
        for (let i = 0; i < v.length; i++) v[i] -= a * q[k][i];
      }
    }
    r[j][j] = Math.hypot(...v);
    if (r[j][j] < 1e-10) throw new Error('Regression coefficients are not identifiable: the model is rank deficient.');
    q.push(v.map(x => x / r[j][j]));
  }
  const x = q.map(c => dot(c, target));
  for (let j = n - 1; j >= 0; j--) {
    for (let k = j + 1; k < n; k++) x[j] -= r[j][k] * x[k];
    x[j] /= r[j][j];
  }
  return x.map((v, i) => v / scale[i]);
}

export function fitRegression(observed: number[], models: Expr[], parameters: string[], fixed: Record<string, number>): FitResult {
  if (observed.length !== models.length) throw new Error('Regression lists must have the same length.');
  if (!parameters.length) throw new Error('Regression needs an unbound coefficient, like Y ~ m X + b. Defined constants stay fixed.');
  if (parameters.length > 8) throw new Error('Regression supports at most 8 fitted coefficients.');
  if (observed.length > 10_000) throw new Error('Regression supports at most 10000 observations; filter the data first.');
  const ys: number[] = [], fs: Expr[] = [];
  for (let i = 0; i < observed.length; i++) {
    // Missing input values are numeric NaN leaves after list lowering. A
    // domain error in the model is different: never silently drop that row.
    const hasMissing = (e: Expr): boolean => {
      if (e.kind === 'num') return !Number.isFinite(e.value);
      if (e.kind === 'bin') return hasMissing(e.a) || hasMissing(e.b);
      if (e.kind === 'neg') return hasMissing(e.a);
      if (e.kind === 'call') return e.args.some(hasMissing);
      if (e.kind === 'eq' || e.kind === 'ineq') return hasMissing(e.l) || hasMissing(e.r);
      if (e.kind === 'piecewise') return e.cases.some(c => hasMissing(c.cond) || hasMissing(c.value))
        || !!(e.otherwise && hasMissing(e.otherwise));
      return false;
    };
    if (!Number.isFinite(observed[i]) || hasMissing(models[i])) continue;
    ys.push(observed[i]); fs.push(models[i]);
  }
  if (ys.length < parameters.length) throw new Error('Regression needs at least as many finite observations as coefficients.');
  let derivatives: Expr[][];
  try { derivatives = parameters.map(p => fs.map(f => diff(f, p))); }
  catch { throw new Error('Regression needs a differentiable model in its fitted coefficients.'); }
  const nonlinear = derivatives.some(col => col.some(e => [...freeVars(e)].some(n => parameters.includes(n))));
  const env = (values: number[]) => Object.assign({}, fixed, Object.fromEntries(parameters.map((p, i) => [p, values[i]])));
  const predictions = (values: number[]) => {
    const e = env(values);
    return fs.map(f => evaluate(f, e));
  };
  const jacobian = (values: number[]) => {
    const e = env(values);
    return derivatives.map(col => col.map(d => evaluate(d, e)));
  };
  const cost = (values: number[]) => predictions(values).reduce((s, v, i) => s + (v - ys[i]) ** 2, 0);
  let values: number[];
  if (!nonlinear) {
    const zero = parameters.map(() => 0);
    const offset = predictions(zero);
    const columns = jacobian(zero);
    if (![...offset, ...columns.flat()].every(Number.isFinite)) throw new Error('The regression model is undefined for some observations.');
    values = leastSquares(columns, ys.map((v, i) => v - offset[i]));
  } else {
    if (ys.length > 2000) throw new Error('Nonlinear regression supports at most 2000 observations; filter the data first.');
    let best: number[] | null = null, bestCost = Infinity;
    // Deterministic starts, bounded iterations. No random fits on reload.
    for (const start of [1, 0, -1, 0.1]) {
      let x = parameters.map(() => start), lambda = 1e-3;
      let score = cost(x);
      if (!Number.isFinite(score)) continue;
      for (let iteration = 0; iteration < 60; iteration++) {
        const j = jacobian(x);
        if (!j.flat().every(Number.isFinite)) break;
        const predicted = predictions(x);
        const residual = ys.map((v, i) => v - predicted[i]);
        const norms = j.map(col => Math.max(1e-12, Math.hypot(...col)));
        const augmented = j.map((col, k) => [...col, ...parameters.map((_, i) => i === k ? Math.sqrt(lambda) * norms[k] : 0)]);
        let delta: number[];
        try { delta = leastSquares(augmented, [...residual, ...parameters.map(() => 0)]); } catch { break; }
        const next = x.map((v, i) => v + delta[i]);
        const nextCost = cost(next);
        if (Number.isFinite(nextCost) && nextCost < score) {
          const improvement = score - nextCost;
          x = next; score = nextCost; lambda = Math.max(1e-12, lambda / 3);
          if (improvement <= 1e-12 * Math.max(1, score)) break;
        } else {
          lambda *= 10;
          if (lambda > 1e12) break;
        }
      }
      if (score < bestCost) { best = x; bestCost = score; }
    }
    if (!best) throw new Error('Nonlinear regression could not find a finite fit; try another model or rescale the data.');
    values = best;
    // Identifiability is checked without damping; damping must not disguise
    // redundant coefficients such as a*b*X.
    leastSquares(jacobian(values), ys);
    const residual = predictions(values).map((v, i) => v - ys[i]);
    const j = jacobian(values);
    const stationary = j.every(col => Math.abs(col.reduce((s, v, i) => s + v * residual[i], 0))
      <= 1e-5 * Math.max(1, Math.hypot(...col) * Math.hypot(...residual)));
    if (!stationary) throw new Error('Nonlinear regression did not converge; try another model or rescale the data.');
  }
  if (!values.every(Number.isFinite)) throw new Error('Regression did not produce finite coefficients.');
  const sse = cost(values);
  if (!Number.isFinite(sse)) throw new Error('Regression overflowed; rescale the data before fitting.');
  const mean = ys.reduce((s, v) => s + v, 0) / ys.length;
  const sst = ys.reduce((s, v) => s + (v - mean) ** 2, 0);
  return { coefficients: Object.fromEntries(parameters.map((p, i) => [p, values[i]])), count: ys.length,
    skipped: observed.length - ys.length, rmse: Math.sqrt(sse / ys.length), r2: sst > 0 ? 1 - sse / sst : null, nonlinear };
}

export function formatFit(fit: FitResult): string {
  const number = (v: number) => Number(v.toPrecision(6)).toString();
  return [...Object.entries(fit.coefficients).map(([p, v]) => `${p} ≈ ${number(v)}`),
    `RMSE ≈ ${number(fit.rmse)}`, ...(fit.r2 === null ? [] : [`R² ≈ ${number(fit.r2)}`]),
    `${fit.count} observations`, ...(fit.skipped ? [`${fit.skipped} rows skipped`] : []),
    ...(fit.nonlinear ? ['nonlinear local fit'] : [])].join(' · ');
}
