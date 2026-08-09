/**
 * Symbolic integration with a numeric safety net.
 *
 * `antiderivative(e, v)` tries a small tower of exact methods — linearity,
 * power rules, a table of elementary forms with linear arguments, the
 * complete rational-function algorithm (Horowitz–Ostrogradsky reduction in
 * exact rational arithmetic, log/atan terms over the certified real roots
 * from poly.ts), Gaussian integrals via erf, integration by parts, trig
 * product/power rewrites, and u-substitution. It is NOT a full Risch
 * decision procedure: a null result means "no form found", not "no
 * elementary form exists", and callers fall back to numeric quadrature.
 *
 * Every symbolic result is *verified before it is returned*: the candidate F
 * is differentiated (symbolically when diff() can, finite differences when it
 * cannot) and compared against the integrand at a spread of sample points.
 * A rule with a sign slip or a domain surprise is rejected rather than
 * plotted — heuristics are safe because nothing unverified escapes.
 *
 * For definite integrals the fundamental theorem is itself the thing that can
 * lie (F(b) − F(a) is wrong across a non-integrable singularity), so
 * `verifyDefinite` checks the closed form against adaptive Gauss–Kronrod
 * quadrature at probe parameter values. `quadratureSum` builds the fallback:
 * a fixed composite Gauss–Legendre rule expanded into an ordinary Expr, the
 * same way Σ expands — so shaders, the worker VM and every other consumer
 * evaluate it with no new machinery.
 */
import { type Expr, evaluate, freeVars } from './expr.ts';
import { add, diff, div, mul, neg, pow, sub } from './diff.ts';
import {
  type FPoly,
  type Frac,
  exprToPoly,
  fpadd,
  fpderiv,
  fpdivExact,
  fpdivmod,
  fpgcd,
  fpmul,
  fpscale,
  frac,
  primitive,
  realRootsSquareFree,
} from './poly.ts';

const num = (value: number): Expr => ({ kind: 'num', value });
const vr = (name: string): Expr => ({ kind: 'var', name });
const call = (name: string, ...args: Expr[]): Expr => ({ kind: 'call', name, args });
const ln = (x: Expr): Expr => call('ln', x);
const lnAbs = (x: Expr): Expr => call('ln', call('abs', x));

const isNum = (e: Expr): e is Expr & { kind: 'num' } => e.kind === 'num';

const key = (e: Expr): string => JSON.stringify(e);

const isConstIn = (e: Expr, v: string): boolean => !freeVars(e).has(v);

/** The numeric value of a v-free expression with no other frees, or null. */
function constVal(e: Expr): number | null {
  if (freeVars(e).size) return null;
  try {
    const x = evaluate(e, {});
    return isFinite(x) ? x : null;
  } catch {
    return null;
  }
}

// --- polynomials with symbolic (v-free Expr) coefficients ---

const SYM_DEG_MAX = 8;

/**
 * Coefficients of e as a polynomial in v whose coefficients are v-free
 * expressions (sliders welcome), ascending, or null. The symbolic sibling of
 * poly.ts exprToPoly, for the rules that stay exact under slider parameters.
 */
export function exprPolyCoeffs(e: Expr, v: string): Expr[] | null {
  if (isConstIn(e, v)) return [e];
  switch (e.kind) {
    case 'var':
      return e.name === v ? [num(0), num(1)] : null;
    case 'neg': {
      const a = exprPolyCoeffs(e.a, v);
      return a && a.map(neg);
    }
    case 'bin': {
      if (e.op === '^') {
        if (!isNum(e.b) || !Number.isInteger(e.b.value) || e.b.value < 0) return null;
        const a = exprPolyCoeffs(e.a, v);
        if (!a || (a.length - 1) * e.b.value > SYM_DEG_MAX) return null;
        let out: Expr[] = [num(1)];
        for (let i = 0; i < e.b.value; i++) out = convolve(out, a);
        return out;
      }
      if (e.op === '/') {
        if (!isConstIn(e.b, v)) return null;
        const a = exprPolyCoeffs(e.a, v);
        return a && a.map(c => div(c, e.b));
      }
      const a = exprPolyCoeffs(e.a, v);
      const b = exprPolyCoeffs(e.b, v);
      if (!a || !b) return null;
      if (e.op === '+' || e.op === '-') {
        const out: Expr[] = [];
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          const x = a[i] ?? num(0);
          const y = b[i] ?? num(0);
          out.push(e.op === '+' ? add(x, y) : sub(x, y));
        }
        return out;
      }
      if ((a.length - 1) + (b.length - 1) > SYM_DEG_MAX) return null;
      return convolve(a, b);
    }
    default:
      return null;
  }
}

function convolve(a: Expr[], b: Expr[]): Expr[] {
  const out: Expr[] = Array.from({ length: a.length + b.length - 1 }, () => num(0));
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) out[i + j] = add(out[i + j], mul(a[i], b[j]));
  }
  return out;
}

/** a·v + b with a ≠ 0 (v-free a, b), or null. The "linear argument" matcher. */
function linearIn(e: Expr, v: string): { a: Expr; b: Expr } | null {
  const c = exprPolyCoeffs(e, v);
  if (!c || c.length !== 2) return null;
  if (isNum(c[1]) && c[1].value === 0) return null;
  return { a: c[1], b: c[0] };
}

// --- multiplicative structure ---

interface Factor { base: Expr; exp: number }

/** Flatten products/quotients/negations/integer powers into factors and a sign. */
function factorsOf(e: Expr, sign: 1 | -1, out: Factor[], flip: { neg: boolean }): void {
  switch (e.kind) {
    case 'neg':
      flip.neg = !flip.neg;
      factorsOf(e.a, sign, out, flip);
      return;
    case 'bin':
      if (e.op === '*') {
        factorsOf(e.a, sign, out, flip);
        factorsOf(e.b, sign, out, flip);
        return;
      }
      if (e.op === '/') {
        factorsOf(e.a, sign, out, flip);
        factorsOf(e.b, -sign as 1 | -1, out, flip);
        return;
      }
      if (e.op === '^' && isNum(e.b) && Number.isInteger(e.b.value)
        && Math.abs(e.b.value) <= 16 && e.b.value !== 0) {
        out.push({ base: e.a, exp: sign * e.b.value });
        return;
      }
      break;
  }
  out.push({ base: e, exp: sign });
}

function flatten(e: Expr): { neg: boolean; factors: Factor[] } {
  const flip = { neg: false };
  const raw: Factor[] = [];
  factorsOf(e, 1, raw, flip);
  // Merge repeated bases so sin(x)·sin(x) reads as sin(x)^2.
  const merged = new Map<string, Factor>();
  const order: string[] = [];
  for (const f of raw) {
    if (isNum(f.base) && f.base.value === 1) continue; // 1/x carries a unit factor
    const k = key(f.base);
    const hit = merged.get(k);
    if (hit) hit.exp += f.exp;
    else {
      merged.set(k, { ...f });
      order.push(k);
    }
  }
  return { neg: flip.neg, factors: order.map(k => merged.get(k)!).filter(f => f.exp !== 0) };
}

function rebuild(factors: Factor[], negate: boolean): Expr {
  let numr: Expr | null = null;
  let den: Expr | null = null;
  for (const f of factors) {
    const p = Math.abs(f.exp) === 1 ? f.base : pow(f.base, num(Math.abs(f.exp)));
    if (f.exp > 0) numr = numr === null ? p : mul(numr, p);
    else den = den === null ? p : mul(den, p);
  }
  let out = numr ?? num(1);
  if (den) out = div(out, den);
  return negate ? neg(out) : out;
}

// --- exact rational arithmetic helpers ---

const F1: Frac = { n: 1n, d: 1n };

const fracNum = (f: Frac): number => Number(f.n) / Number(f.d);

const fpEval = (p: FPoly, x: number): number => {
  let acc = 0;
  for (let i = p.length - 1; i >= 0; i--) acc = acc * x + fracNum(p[i]);
  return acc;
};

/** ∑ cᵢ vⁱ as an Expr with double coefficients. */
function fpToExpr(p: FPoly, v: string): Expr {
  let acc: Expr = num(0);
  for (let i = p.length - 1; i >= 0; i--) acc = add(mul(acc, vr(v)), num(fracNum(p[i])));
  return acc;
}

/** Exact Gaussian elimination; null when the system is singular. */
function solveLinear(A: Frac[][], b: Frac[]): Frac[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = -1;
    for (let r = col; r < n; r++) {
      if (M[r][col].n !== 0n) { piv = r; break; }
    }
    if (piv < 0) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const inv = { n: M[col][col].d, d: M[col][col].n };
    for (let c = col; c <= n; c++) M[col][c] = fmulF(M[col][c], inv);
    for (let r = 0; r < n; r++) {
      if (r === col || M[r][col].n === 0n) continue;
      const f = M[r][col];
      for (let c = col; c <= n; c++) M[r][c] = fsubF(M[r][c], fmulF(f, M[col][c]));
    }
  }
  return M.map(row => row[n]);
}

const fmulF = (a: Frac, b: Frac): Frac => frac(a.n * b.n, a.d * b.d);
const fsubF = (a: Frac, b: Frac): Frac => frac(a.n * b.d - b.n * a.d, a.d * b.d);

// --- the rational-function algorithm ---

/**
 * ∫ P/Q dv for numeric-coefficient polynomials: the polynomial part by the
 * power rule; Horowitz–Ostrogradsky reduction (an exact linear solve) splits
 * off the rational part P₁/Q₁; the remaining log part integrates over the
 * certified real roots (residue · ln|v − r|) with one conjugate quadratic
 * pair handled in closed form (ln + atan). Null when the leftover complex
 * factor has degree ≥ 4 — the verifier-gated numeric fallback covers it.
 */
function integrateRational(P: FPoly, Q: FPoly, v: string): Expr | null {
  if (!Q.length) return null;
  const terms: Expr[] = [];
  const { q: polyPart, r } = fpdivmod(P, Q);
  if (polyPart.length) {
    const F: FPoly = [{ n: 0n, d: 1n }];
    polyPart.forEach((c, i) => { F[i + 1] = fmulF(c, frac(1n, BigInt(i + 1))); });
    terms.push(fpToExpr(F, v));
  }
  if (r.length) {
    let A = r;
    let D = Q;
    const D1 = fpgcd(D, fpderiv(D));
    if (D1.length > 1) {
      const D2 = fpdivExact(D, D1);
      let H: FPoly;
      try {
        H = fpdivExact(fpmul(fpderiv(D1), D2), D1);
      } catch {
        return null;
      }
      // A = P₁′·D₂ − P₁·H + P₂·D₁ with deg P₁ < deg D₁, deg P₂ < deg D₂:
      // one column per unknown coefficient, equated degree by degree.
      const d1 = D1.length - 1;
      const d2 = D2.length - 1;
      const n = d1 + d2;
      const rows: Frac[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => ({ n: 0n, d: 1n })));
      const rhs: Frac[] = Array.from({ length: n }, (_, i) => A[i] ?? { n: 0n, d: 1n });
      if ((A.length - 1) >= n) return null; // not proper: cannot happen, be safe
      const put = (colIdx: number, p: FPoly) => {
        p.forEach((c, deg) => {
          if (deg < n) rows[deg][colIdx] = fpadd([rows[deg][colIdx]], [c])[0] ?? { n: 0n, d: 1n };
        });
      };
      for (let j = 0; j < d1; j++) {
        // P₁ = v^j: P₁′·D₂ − v^j·H
        const dTerm = j > 0 ? fpmul([...Array.from({ length: j - 1 }, () => ({ n: 0n, d: 1n }) as Frac), frac(BigInt(j), 1n)], D2) : [];
        const hTerm = fpscale(fpmul([...Array.from({ length: j }, () => ({ n: 0n, d: 1n }) as Frac), F1], H), { n: -1n, d: 1n });
        put(j, fpadd(dTerm, hTerm));
      }
      for (let j = 0; j < d2; j++) {
        put(d1 + j, fpmul([...Array.from({ length: j }, () => ({ n: 0n, d: 1n }) as Frac), F1], D1));
      }
      const sol = solveLinear(rows, rhs);
      if (!sol) return null;
      const P1 = sol.slice(0, d1);
      const P2 = sol.slice(d1);
      while (P1.length && P1[P1.length - 1].n === 0n) P1.pop();
      while (P2.length && P2[P2.length - 1].n === 0n) P2.pop();
      if (P1.length) terms.push(div(fpToExpr(P1, v), fpToExpr(D1, v)));
      A = P2;
      D = D2;
    }
    if (A.length) {
      const logPart = integrateLogPart(A, D, v);
      if (!logPart) return null;
      terms.push(logPart);
    }
  }
  return terms.reduce((acc, t) => add(acc, t), num(0));
}

/** ∫ A/D with D square-free: residues at the certified real roots, plus one
 *  conjugate pair in closed form. */
function integrateLogPart(A: FPoly, D: FPoly, v: string): Expr | null {
  const zp = primitive(D).map(c => c.n);
  const roots = realRootsSquareFree(zp);
  const degLeft = (D.length - 1) - roots.length;
  if (degLeft !== 0 && degLeft !== 2) return null;
  const dD = fpderiv(D);
  const terms: Expr[] = [];
  for (const r0 of roots) {
    const res = fpEval(A, r0) / fpEval(dD, r0);
    if (!isFinite(res)) return null;
    terms.push(mul(num(res), lnAbs(sub(vr(v), num(r0)))));
  }
  if (degLeft === 2) {
    // Deflate the real roots numerically; the quotient is the conjugate pair.
    let cur = D.map(fracNum);
    for (const r0 of roots) {
      const next: number[] = Array.from({ length: cur.length - 1 }, () => 0);
      let carry = 0;
      for (let i = cur.length - 1; i >= 1; i--) {
        carry = cur[i] + carry * r0;
        next[i - 1] = carry;
      }
      cur = next;
    }
    const [c, b, a] = cur;
    const disc = b * b - 4 * a * c;
    if (!(disc < 0) || !isFinite(disc)) return null;
    const alpha = -b / (2 * a);
    const beta = Math.sqrt(-disc) / (2 * a);
    // Complex residue at α + βi: c = A(z)/D′(z), by complex Horner.
    const horner = (p: FPoly): [number, number] => {
      let re = 0;
      let im = 0;
      for (let i = p.length - 1; i >= 0; i--) {
        const nre = re * alpha - im * beta + fracNum(p[i]);
        im = re * beta + im * alpha;
        re = nre;
      }
      return [re, im];
    };
    const [nRe, nIm] = horner(A);
    const [dRe, dIm] = horner(dD);
    const dd = dRe * dRe + dIm * dIm;
    const resRe = (nRe * dRe + nIm * dIm) / dd;
    const resIm = (nIm * dRe - nRe * dIm) / dd;
    if (!isFinite(resRe) || !isFinite(resIm)) return null;
    const shifted = sub(vr(v), num(alpha));
    const quadExpr = add(pow(shifted, num(2)), num(beta * beta));
    terms.push(mul(num(resRe), ln(quadExpr)));
    terms.push(mul(num(-2 * resIm), call('atan', div(shifted, num(beta)))));
  }
  return terms.reduce((acc, t) => add(acc, t), num(0));
}

// --- table of elementary antiderivatives, argument u = a·v + b ---

/** ∫ f(u) du for one call family; the caller divides by a. Null = no entry. */
function tableCall(name: string, u: Expr): Expr | null {
  switch (name) {
    case 'sin': return neg(call('cos', u));
    case 'cos': return call('sin', u);
    case 'tan': return neg(lnAbs(call('cos', u)));
    case 'exp': return call('exp', u);
    case 'sinh': return call('cosh', u);
    case 'cosh': return call('sinh', u);
    case 'tanh': return ln(call('cosh', u));
    case 'sech': return call('atan', call('sinh', u));
    case 'sqrt': return mul(num(2 / 3), pow(u, num(1.5)));
    case 'ln': return sub(mul(u, ln(u)), u);
    case 'log': return div(sub(mul(u, ln(u)), u), num(Math.LN10));
    case 'abs': return div(mul(u, call('abs', u)), num(2));
    case 'sign': return call('abs', u);
    case 'asin': return add(mul(u, call('asin', u)), call('sqrt', sub(num(1), pow(u, num(2)))));
    case 'acos': return sub(mul(u, call('acos', u)), call('sqrt', sub(num(1), pow(u, num(2)))));
    case 'atan': return sub(mul(u, call('atan', u)), div(ln(add(num(1), pow(u, num(2)))), num(2)));
    case 'asinh': return sub(mul(u, call('asinh', u)), call('sqrt', add(pow(u, num(2)), num(1))));
    case 'acosh': return sub(mul(u, call('acosh', u)), call('sqrt', sub(pow(u, num(2)), num(1))));
    case 'atanh': return add(mul(u, call('atanh', u)), div(ln(sub(num(1), pow(u, num(2)))), num(2)));
    case 'erf': return add(mul(u, call('erf', u)), div(call('exp', neg(pow(u, num(2)))), num(Math.sqrt(Math.PI))));
    default: return null;
  }
}

// --- verification ---

const V_PROBES = [-3.7, -2.1, -1.05, -0.51, 0.33, 0.77, 1.29, 2.42, 3.91];
const PARAM_PROBES = [0.73, 1.91, -1.37, 0.42];

/** Probe environments for the free parameters (two spreads, cycled values). */
function probeEnvs(frees: Iterable<string>): Array<Record<string, number>> {
  const names = [...frees];
  const mk = (offset: number): Record<string, number> => {
    const env: Record<string, number> = {};
    names.forEach((n, i) => { env[n] = PARAM_PROBES[(i + offset) % PARAM_PROBES.length]; });
    return env;
  };
  return names.length ? [mk(0), mk(1)] : [{}];
}

/**
 * Does F′ = f? Symbolic differentiation (finite differences when diff cannot)
 * compared at sample points; accepted only when enough samples are defined
 * and every defined one matches. This gate is what lets the rules above be
 * fearless: a wrong candidate is dropped, never returned.
 */
export function verifyAntiderivative(F: Expr, f: Expr, v: string): boolean {
  let dF: Expr | null = null;
  try {
    dF = diff(F, v);
  } catch {
    dF = null;
  }
  const frees = new Set([...freeVars(f), ...freeVars(F)]);
  frees.delete(v);
  let matched = 0;
  for (const env of probeEnvs(frees)) {
    for (const x of V_PROBES) {
      let want: number;
      try {
        want = evaluate(f, { ...env, [v]: x });
      } catch {
        return false; // unbound name: nothing meaningful to verify against
      }
      if (!isFinite(want)) continue;
      let got: number;
      let tol = 1e-6 * (1 + Math.abs(want));
      try {
        if (dF) {
          got = evaluate(dF, { ...env, [v]: x });
        } else {
          const h = 1e-5 * (1 + Math.abs(x));
          const fp = evaluate(F, { ...env, [v]: x + h });
          const fm = evaluate(F, { ...env, [v]: x - h });
          got = (fp - fm) / (2 * h);
          tol = 1e-3 * (1 + Math.abs(want));
        }
      } catch {
        return false;
      }
      if (!isFinite(got)) continue; // F undefined there (domain edge): unjudged
      if (Math.abs(got - want) > tol) return false;
      matched++;
    }
  }
  // Limited domains (asin, acosh, √) leave few in-domain probes; three
  // agreeing points across the spread is already a strong certificate.
  return matched >= 3;
}

// --- adaptive quadrature (Gauss–Kronrod 7–15) ---

const K15_X = [0, 0.2077849550078985, 0.4058451513773972, 0.5860872354676911,
  0.7415311855993945, 0.8648644233597691, 0.9491079123427585, 0.9914553711208126];
const K15_W = [0.2094821410847278, 0.2044329400752989, 0.1903505780647854, 0.1690047266392679,
  0.1406532597155259, 0.1047900103222502, 0.0630920926299786, 0.0229353220105292];
const G7_W = [0.4179591836734694, 0.3818300505051189, 0.2797053914892767, 0.1294849661688697];

/**
 * Adaptive Gauss–Kronrod estimate of ∫ f over [lo, hi] (sign-aware when
 * reversed; ±Infinity bounds handled by the standard rational change of
 * variables). NaN when the integral fails to settle within the subdivision
 * budget — divergence reads as "no answer", never a confident wrong one.
 */
export function quadrature(f: (x: number) => number, lo: number, hi: number): number {
  if (Number.isNaN(lo) || Number.isNaN(hi)) return NaN;
  if (lo === hi) return 0;
  if (!isFinite(lo) || !isFinite(hi)) {
    if (lo > hi) return -quadrature(f, hi, lo);
    if (lo === -Infinity && hi === Infinity) {
      // x = u/(1−u²) maps (−1, 1) onto ℝ; dx = (1+u²)/(1−u²)² du.
      return quadrature(u => {
        const d = 1 - u * u;
        return (f(u / d) * (1 + u * u)) / (d * d);
      }, -1, 1);
    }
    if (hi === Infinity) {
      // x = lo + u/(1−u) maps (0, 1) onto (lo, ∞); dx = du/(1−u)².
      return quadrature(u => {
        const d = 1 - u;
        return f(lo + u / d) / (d * d);
      }, 0, 1);
    }
    // (−∞, hi): the mirror map.
    return quadrature(u => {
      const d = 1 - u;
      return f(hi - u / d) / (d * d);
    }, 0, 1);
  }
  const sign = lo < hi ? 1 : -1;
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  const panel = (x0: number, x1: number): { k: number; err: number } => {
    const c = (x0 + x1) / 2;
    const h = (x1 - x0) / 2;
    let k15 = 0;
    let g7 = 0;
    for (let i = 0; i < 8; i++) {
      const fp = f(c + h * K15_X[i]);
      const fm = i === 0 ? fp : f(c - h * K15_X[i]);
      const s = i === 0 ? fp : fp + fm;
      k15 += K15_W[i] * s;
      // The embedded G7 rule lives on the even-index K15 nodes.
      if (i % 2 === 0) g7 += G7_W[i / 2] * s;
    }
    return { k: k15 * h, err: Math.abs((k15 - g7) * h) };
  };
  let total = 0;
  let badMass = 0;
  const stack: Array<{ x0: number; x1: number; depth: number }> = [{ x0: a, x1: b, depth: 0 }];
  let evals = 0;
  while (stack.length) {
    const { x0, x1, depth } = stack.pop()!;
    const { k, err } = panel(x0, x1);
    evals += 15;
    const tol = 1e-10 * Math.max(1, Math.abs(total)) * ((x1 - x0) / (b - a));
    // Depth 45 lets an endpoint singularity refine down to ~1e-12 widths
    // (only the singular panel keeps splitting, so the cost stays linear).
    if (err <= tol || depth >= 45 || evals > 20000) {
      if (isFinite(k)) {
        total += k;
        if (depth >= 45 || evals > 20000) badMass += err;
      }
      // Non-finite panels (a sampled singularity) contribute nothing: the
      // neighboring subdivisions already carry the finite mass.
      continue;
    }
    const mid = (x0 + x1) / 2;
    stack.push({ x0, x1: mid, depth: depth + 1 }, { x0: mid, x1, depth: depth + 1 });
  }
  if (!isFinite(total) || badMass > 1e-4 * Math.max(1, Math.abs(total))) return NaN;
  return sign * total;
}

/**
 * Check a closed-form definite value against quadrature at probe parameter
 * values — the guard against FTC across a singularity (∫₋₁¹ dv/v² is NOT
 * v⁻¹ evaluated at the ends). True only when at least one probe is judgeable
 * and every judgeable probe agrees.
 */
export function verifyDefinite(value: Expr, body: Expr, v: string, lo: Expr, hi: Expr): boolean {
  // Only the BODY's occurrences of v are bound. In `int[a..x] f(x) dx` the
  // upper bound's x is the ambient plot variable sharing the name — it (and
  // its appearances in the substituted value) must be probed like any other
  // parameter, or evaluation throws and a perfectly good closed form gets
  // discarded for the far-worse fixed-order fallback.
  const frees = new Set([...freeVars(lo), ...freeVars(hi), ...freeVars(value)]);
  for (const f of freeVars(body)) if (f !== v) frees.add(f);
  let judged = 0;
  for (const env of probeEnvs(frees)) {
    let a: number;
    let b: number;
    let want: number;
    try {
      a = evaluate(lo, env);
      b = evaluate(hi, env);
      want = evaluate(value, env);
    } catch {
      return false;
    }
    // Infinite bounds are fine (quadrature transforms them); huge FINITE
    // spans are skipped — they take forever and prove little extra.
    if (Number.isNaN(a) || Number.isNaN(b)) continue;
    if ((isFinite(a) && Math.abs(a) > 1e6) || (isFinite(b) && Math.abs(b) > 1e6)) continue;
    if (!isFinite(want)) continue;
    const got = quadrature(x => {
      try {
        return evaluate(body, { ...env, [v]: x });
      } catch {
        return NaN;
      }
    }, a, b);
    if (!isFinite(got)) continue;
    if (Math.abs(got - want) > 1e-6 * (1 + Math.abs(got))) return false;
    judged++;
  }
  return judged > 0;
}

// --- the numeric fallback as an ordinary expression ---

const GL8_X = [0.1834346424956498, 0.5255324099163290, 0.7966664774136267, 0.9602898564975363];
const GL8_W = [0.3626837833783620, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763];
const QUAD_PANELS = 5;

/** Terms one quadratureSum expands to (for resolve-time term budgets). */
export const QUAD_TERMS = QUAD_PANELS * 8;

/**
 * ∫ body dv over [lo, hi] as a composite Gauss–Legendre sum, expanded into a
 * plain Expr (5 panels × 8 points). Exactly how Σ rows expand — so the GPU
 * shaders, the worker's stack VM, sampled densities and symbolic
 * differentiation all keep working with no new node kind. Fixed-order, not
 * adaptive: smooth integrands are ~1e-12, kinks land near panel edges. lo
 * and hi may be any expressions, including the ambient plot coordinate
 * (∫₀ˣ makes a function of x).
 */
export function quadratureSum(body: Expr, v: string, lo: Expr, hi: Expr): Expr {
  const width = sub(hi, lo);
  let acc: Expr = num(0);
  for (let p = 0; p < QUAD_PANELS; p++) {
    for (let i = 0; i < 4; i++) {
      for (const s of [1, -1]) {
        const c = (p + 0.5 + (s * GL8_X[i]) / 2) / QUAD_PANELS; // node in (0, 1)
        const xi = add(lo, mul(num(c), width));
        const term = substAll(body, v, xi);
        acc = add(acc, mul(num(GL8_W[i] / (2 * QUAD_PANELS)), term));
      }
    }
  }
  return mul(width, acc);
}

/**
 * quadratureSum over a half- or fully-infinite range: the same rational
 * change of variables quadrature() uses, applied symbolically, so the result
 * is still an ordinary finite-interval Gauss–Legendre expansion. A null
 * bound means infinite on that side (callers normalize direction first).
 */
export function improperSum(body: Expr, v: string, lo: Expr | null, hi: Expr | null): Expr {
  if (lo && hi) return quadratureSum(body, v, lo, hi);
  const u = '@w';
  if (!lo && !hi) {
    // x = u/(1−u²) over (−1, 1); dx = (1+u²)/(1−u²)² du.
    const uu = mul(vr(u), vr(u));
    const d = sub(num(1), uu);
    const x = div(vr(u), d);
    const jac = div(add(num(1), uu), mul(d, d));
    return quadratureSum(mul(substAll(body, v, x), jac), u, num(-1), num(1));
  }
  // Half-infinite: x = end ± u/(1−u) over (0, 1); dx = du/(1−u)².
  const d = sub(num(1), vr(u));
  const step = div(vr(u), d);
  const x = lo ? add(lo, step) : sub(hi!, step);
  const jac = div(num(1), mul(d, d));
  return quadratureSum(mul(substAll(body, v, x), jac), u, num(0), num(1));
}

/** Substitute every free occurrence of variable v (no binders can capture:
 *  the bound variable is eliminated in the same pass). */
function substAll(e: Expr, v: string, val: Expr): Expr {
  switch (e.kind) {
    case 'num': return e;
    case 'var': return e.name === v ? val : e;
    case 'neg': return neg(substAll(e.a, v, val));
    case 'bin': return { kind: 'bin', op: e.op, a: substAll(e.a, v, val), b: substAll(e.b, v, val) };
    case 'call': return { kind: 'call', name: e.name, args: e.args.map(a => substAll(a, v, val)) };
    case 'eq': return { kind: 'eq', l: substAll(e.l, v, val), r: substAll(e.r, v, val) };
    case 'ineq': return { kind: 'ineq', op: e.op, l: substAll(e.l, v, val), r: substAll(e.r, v, val) };
    case 'vec': return { kind: 'vec', items: e.items.map(a => substAll(a, v, val)) };
    case 'list': return { kind: 'list', items: e.items.map(a => substAll(a, v, val)) };
    case 'data':
    case 'str':
    case 'text': return e;
    case 'piecewise': return {
      kind: 'piecewise',
      cases: e.cases.map(c => ({ cond: substAll(c.cond, v, val), value: substAll(c.value, v, val) })),
      otherwise: e.otherwise && substAll(e.otherwise, v, val),
    };
  }
}

// --- the rule tower ---

const MAX_DEPTH = 10;

/**
 * A verified antiderivative of e with respect to v, or null. The public
 * entry: candidates come from `anti`, and only survivors of
 * `verifyAntiderivative` escape.
 */
export function antiderivative(e: Expr, v: string): Expr | null {
  let F: Expr | null;
  try {
    F = anti(e, v, 0);
  } catch {
    return null;
  }
  if (!F) return null;
  return verifyAntiderivative(F, e, v) ? F : null;
}

function anti(e: Expr, v: string, depth: number): Expr | null {
  if (depth > MAX_DEPTH) return null;
  if (isConstIn(e, v)) return mul(e, vr(v));
  // Structural linearity keeps the current depth: splitting a sum or pulling
  // a constant multiple strictly shrinks the tree, so it cannot cycle, and
  // charging it depth would starve the real rules on longer expressions.
  switch (e.kind) {
    case 'var':
      return e.name === v ? div(pow(vr(v), num(2)), num(2)) : null;
    case 'neg': {
      const F = anti(e.a, v, depth);
      return F && neg(F);
    }
    case 'bin':
      if (e.op === '+' || e.op === '-') {
        const A = anti(e.a, v, depth);
        if (!A) break;
        const B = anti(e.b, v, depth);
        if (!B) break;
        return e.op === '+' ? add(A, B) : sub(A, B);
      }
      break;
    default:
      break;
  }

  // Constant multiples pull out of the flattened product.
  const { neg: negated, factors } = flatten(e);
  const constFs = factors.filter(f => isConstIn(f.base, v));
  const varFs = factors.filter(f => !isConstIn(f.base, v));
  if (constFs.length) {
    const coef = rebuild(constFs, negated);
    const F = anti(rebuild(varFs, false), v, depth);
    return F && mul(coef, F);
  }
  if (negated) {
    const F = anti(rebuild(varFs, false), v, depth);
    return F && neg(F);
  }

  // A sum inside a product distributes: (A ± B)·rest splits into two
  // integrals (each strictly smaller in sum-factors, so this cannot cycle).
  const sumF = varFs.find(f => f.exp === 1 && f.base.kind === 'bin'
    && (f.base.op === '+' || f.base.op === '-'));
  if (sumF && varFs.length > 1) {
    const rest = rebuild(varFs.filter(f => f !== sumF), false);
    const b = sumF.base as Expr & { kind: 'bin' };
    const A = anti(mul(b.a, rest), v, depth);
    if (A) {
      const B = anti(mul(b.b, rest), v, depth);
      if (B) return b.op === '+' ? add(A, B) : sub(A, B);
    }
  }

  // Exact numeric-coefficient polynomials and rational functions.
  const numExpr = rebuild(varFs.filter(f => f.exp > 0), false);
  const denExpr = rebuild(varFs.filter(f => f.exp < 0).map(f => ({ base: f.base, exp: -f.exp })), false);
  const P = exprToPoly(numExpr, v);
  const Q = exprToPoly(denExpr, v);
  if (P && Q) {
    const F = integrateRational(P, Q, v);
    if (F) return F;
  }

  // Symbolic-coefficient polynomials (slider coefficients stay exact).
  const symPoly = exprPolyCoeffs(e, v);
  if (symPoly) {
    let F: Expr = num(0);
    symPoly.forEach((c, i) => {
      F = add(F, mul(div(c, num(i + 1)), pow(vr(v), num(i + 1))));
    });
    return F;
  }

  const single = varFs.length === 1 ? varFs[0] : null;

  // Table forms with a linear argument: f(a·v + b) → F(u)/a.
  if (single && single.exp === 1 && single.base.kind === 'call') {
    const c = single.base;
    if (c.args.length === 1) {
      const lin = linearIn(c.args[0], v);
      if (lin) {
        const T = tableCall(c.name, c.args[0]);
        if (T) return div(T, lin.a);
      }
    }
    // normalpdf/normalcdf in their first argument (mean and sd v-free).
    if ((c.name === 'normalpdf' || c.name === 'normalcdf') && c.args.length === 3
      && isConstIn(c.args[1], v) && isConstIn(c.args[2], v)) {
      const lin = linearIn(c.args[0], v);
      if (lin) {
        const [x, m, s] = c.args;
        const T = c.name === 'normalpdf'
          ? call('normalcdf', x, m, s)
          : add(mul(sub(x, m), call('normalcdf', x, m, s)),
              mul(pow(s, num(2)), call('normalpdf', x, m, s)));
        return div(T, lin.a);
      }
    }
  }

  // Powers of a linear argument: (a·v + b)^p for any constant p (p = −1 → ln).
  if (single && single.base.kind === 'bin' && single.base.op === '^' && single.exp === 1) {
    if (isConstIn(single.base.b, v)) {
      const lin = linearIn(single.base.a, v);
      const p = single.base.b;
      if (lin) {
        if (isNum(p) && p.value === -1) return div(lnAbs(single.base.a), lin.a);
        const p1 = add(p, num(1));
        return div(pow(single.base.a, p1), mul(lin.a, p1));
      }
    }
    // c^(a·v + b) for a v-free base: c^u / (a ln c).
    const linExp = linearIn(single.base.b, v);
    if (isConstIn(single.base.a, v) && linExp) {
      return div(pow(single.base.a, single.base.b), mul(linExp.a, ln(single.base.a)));
    }
  }
  if (single && single.exp === -1) {
    const lin = linearIn(single.base, v);
    if (lin) return div(lnAbs(single.base), lin.a);
  }
  // Negative powers of a linear argument: (a·v + b)^(−k).
  if (single && single.exp < -1) {
    const lin = linearIn(single.base, v);
    if (lin) {
      const p1 = single.exp + 1;
      return div(pow(single.base, num(p1)), mul(lin.a, num(p1)));
    }
  }

  // Gaussian integrals: exp(quadratic with negative leading coefficient) → erf.
  if (single && single.exp === 1 && single.base.kind === 'call'
    && single.base.name === 'exp' && single.base.args.length === 1) {
    const q = exprPolyCoeffs(single.base.args[0], v);
    if (q && q.length === 3) {
      const c2 = constVal(q[2]);
      if (c2 !== null && c2 < 0) {
        const k = Math.sqrt(-c2);
        // exp(c₂v² + c₁v + c₀) = exp(c₀ − c₁²/4c₂) · exp(−(kv − c₁/2k)²)
        const shiftK = div(q[1], num(2 * k)); // c₁/(2k)
        const inner = sub(mul(num(k), vr(v)), shiftK);
        const amp = call('exp', add(q[0], pow(shiftK, num(2))));
        return mul(amp, mul(num(Math.sqrt(Math.PI) / (2 * k)), call('erf', inner)));
      }
    }
  }

  // Trig powers and products.
  const trig = trigRule(varFs, v, depth);
  if (trig) return trig;

  // exp(a v + b) · sin/cos(c v + d): the classic closed form.
  const expTrig = expTrigRule(varFs, v);
  if (expTrig) return expTrig;

  // Integration by parts: polynomial × table family.
  const parts = partsRule(varFs, v, depth);
  if (parts) return parts;

  // u-substitution: find u with e = g(u)·u′ structurally.
  return uSubstitution(e, varFs, v, depth);
}

// --- trig products ---

/** sin^m(u)·cos^n(u) with a shared linear argument (odd powers via the
 *  complementary substitution, even ones by power reduction / product-to-sum). */
function trigRule(factors: Factor[], v: string, depth: number): Expr | null {
  if (!factors.length) return null;
  if (!factors.every(f =>
    f.exp >= 1 && f.base.kind === 'call' && (f.base.name === 'sin' || f.base.name === 'cos')
    && f.base.args.length === 1 && linearIn(f.base.args[0], v) !== null)) return null;
  const sins = factors.filter(f => (f.base as Expr & { kind: 'call' }).name === 'sin');
  const coss = factors.filter(f => (f.base as Expr & { kind: 'call' }).name === 'cos');
  const argOf = (f: Factor): Expr => (f.base as Expr & { kind: 'call' }).args[0];

  // Distinct arguments: peel one pair with a product-to-sum identity.
  if (factors.length >= 2) {
    const argKeys = new Set(factors.map(f => key(argOf(f))));
    if (argKeys.size > 1) {
      const [f1, f2] = [factors[0], factors[1]];
      const A = argOf(f1);
      const B = argOf(f2);
      const n1 = (f1.base as Expr & { kind: 'call' }).name;
      const n2 = (f2.base as Expr & { kind: 'call' }).name;
      const rest = [
        ...(f1.exp > 1 ? [{ base: f1.base, exp: f1.exp - 1 }] : []),
        ...(f2.exp > 1 ? [{ base: f2.base, exp: f2.exp - 1 }] : []),
        ...factors.slice(2),
      ];
      // Combine the arguments through their linear coefficients so repeated
      // peels fold: cos(2x − x − x) must become the CONSTANT cos(0), not an
      // expression that still looks like it depends on v.
      const lA = linearIn(A, v)!;
      const lB = linearIn(B, v)!;
      const argSub = add(mul(sub(lA.a, lB.a), vr(v)), sub(lA.b, lB.b));
      const argAdd = add(mul(add(lA.a, lB.a), vr(v)), add(lA.b, lB.b));
      const half = (x: Expr): Expr => mul(num(0.5), x);
      let sum: Expr;
      if (n1 === 'sin' && n2 === 'sin') {
        sum = sub(half(call('cos', argSub)), half(call('cos', argAdd)));
      } else if (n1 === 'cos' && n2 === 'cos') {
        sum = add(half(call('cos', argSub)), half(call('cos', argAdd)));
      } else {
        // sin A · cos B, arranged so the sine carries A.
        const [aS, aC] = n1 === 'sin' ? [lA, lB] : [lB, lA];
        const sPlus = add(mul(add(aS.a, aC.a), vr(v)), add(aS.b, aC.b));
        const sMinus = add(mul(sub(aS.a, aC.a), vr(v)), sub(aS.b, aC.b));
        sum = add(half(call('sin', sPlus)), half(call('sin', sMinus)));
      }
      const restE = rebuild(rest, false);
      return anti(mul(sum, restE), v, depth + 1);
    }
  }

  const u = argOf(factors[0]);
  const lin = linearIn(u, v)!;
  const m = sins.reduce((s, f) => s + f.exp, 0);
  const n = coss.reduce((s, f) => s + f.exp, 0);
  if (m + n > 12) return null;

  // Odd sine power: t = cos u, sin² = 1 − t².
  if (m % 2 === 1) {
    const F = oddTrigPoly(m, n, 'cos', u);
    return div(F, lin.a);
  }
  // Odd cosine power: t = sin u.
  if (n % 2 === 1) {
    const F = oddTrigPoly(n, m, 'sin', u);
    return F && div(F, lin.a);
  }
  // Both even: reduce one sin² or cos² by its half-angle identity and recurse.
  const twoU = mul(num(2), u);
  if (m >= 2) {
    const rest = mul(
      m - 2 >= 1 ? pow(call('sin', u), num(m - 2)) : num(1),
      n >= 1 ? pow(call('cos', u), num(n)) : num(1),
    );
    const rewritten = mul(sub(num(0.5), mul(num(0.5), call('cos', twoU))), rest);
    return anti(rewritten, v, depth + 1);
  }
  if (n >= 2) {
    const rest = n - 2 >= 1 ? pow(call('cos', u), num(n - 2)) : num(1);
    const rewritten = mul(add(num(0.5), mul(num(0.5), call('cos', twoU))), rest);
    return anti(rewritten, v, depth + 1);
  }
  return null;
}

/**
 * ∫ sin^m cos^n du with m odd (or the mirror): substitute t for the OTHER
 * function, expand (1 − t²)^((m−1)/2)·t^n, and integrate the polynomial.
 * Signs: dt = −sin u du for t = cos u, dt = +cos u du for t = sin u.
 */
function oddTrigPoly(oddPow: number, evenPow: number, tFn: 'sin' | 'cos', u: Expr): Expr {
  // Polynomial in t: (1 − t²)^((odd−1)/2) · t^even.
  let poly: number[] = [1];
  const half = (oddPow - 1) / 2;
  for (let i = 0; i < half; i++) {
    const next: number[] = Array.from({ length: poly.length + 2 }, () => 0);
    poly.forEach((c, k) => {
      next[k] += c;
      next[k + 2] -= c;
    });
    poly = next;
  }
  const shifted: number[] = [...Array.from({ length: evenPow }, () => 0), ...poly];
  // Integrate termwise, then substitute t = cos u (extra −1) or t = sin u.
  const sign = tFn === 'cos' ? -1 : 1;
  let F: Expr = num(0);
  shifted.forEach((c, k) => {
    if (c === 0) return;
    F = add(F, mul(num((sign * c) / (k + 1)), pow(call(tFn, u), num(k + 1))));
  });
  return F;
}

/** e^{av+b}·sin(cv+d) or ·cos(cv+d): e^u(a·trig − ...)/(a² + c²). */
function expTrigRule(factors: Factor[], v: string): Expr | null {
  if (factors.length !== 2) return null;
  const ex = factors.find(f => f.exp === 1 && f.base.kind === 'call' && f.base.name === 'exp');
  const tr = factors.find(f => f.exp === 1 && f.base.kind === 'call'
    && (f.base.name === 'sin' || f.base.name === 'cos'));
  if (!ex || !tr) return null;
  const eArg = (ex.base as Expr & { kind: 'call' }).args[0];
  const tArg = (tr.base as Expr & { kind: 'call' }).args[0];
  const la = linearIn(eArg, v);
  const lc = linearIn(tArg, v);
  if (!la || !lc) return null;
  const a = la.a;
  const c = lc.a;
  const den = add(pow(a, num(2)), pow(c, num(2)));
  const sinT = call('sin', tArg);
  const cosT = call('cos', tArg);
  const numTerm = (tr.base as Expr & { kind: 'call' }).name === 'sin'
    ? sub(mul(a, sinT), mul(c, cosT))
    : add(mul(a, cosT), mul(c, sinT));
  return div(mul(ex.base, numTerm), den);
}

/** Call families whose DERIVATIVE is algebraic: by parts these are the u to
 *  differentiate (∫x·ln x picks u = ln x, dv = x dx). */
const PARTS_DIFF = new Set(['ln', 'log', 'atan', 'asin', 'acos', 'atanh', 'asinh', 'acosh', 'erf']);

/** Integration by parts for polynomial × one table family. The polynomial is
 *  differentiated away for exp/trig partners; the logarithmic/inverse family
 *  is differentiated instead (its derivative is algebraic), the polynomial
 *  integrated. */
function partsRule(factors: Factor[], v: string, depth: number): Expr | null {
  if (factors.length !== 2) return null;
  const polyF = factors.find(f => f.exp > 0 && f.exp <= 6 && exprPolyCoeffs(pow(f.base, num(f.exp)), v) !== null);
  const other = factors.find(f => f !== polyF);
  if (!polyF || !other || other.exp !== 1) return null;
  const p = rebuild([polyF], false);
  const g = other.base;
  if (g.kind === 'call' && PARTS_DIFF.has(g.name)) {
    // ∫p·g = P·g − ∫P·g′ with P = ∫p: g′ is algebraic, so the rest recurses
    // into the rational/root rules instead of looping back here.
    const P = anti(p, v, depth + 1);
    if (!P) return null;
    let dg: Expr;
    try {
      dg = diff(g, v);
    } catch {
      return null;
    }
    const restF = anti(mul(P, dg), v, depth + 1);
    if (!restF) return null;
    return sub(mul(P, g), restF);
  }
  const G = anti(g, v, depth + 1);
  if (!G) return null;
  let dp: Expr;
  try {
    dp = diff(p, v);
  } catch {
    return null;
  }
  const restF = anti(mul(dp, G), v, depth + 1);
  if (!restF) return null;
  return sub(mul(p, G), restF);
}

// --- u-substitution ---

/** Candidate inner functions: call arguments, non-trivial power bases and
 *  exponents, denominators. */
function subCandidates(e: Expr, v: string, out: Map<string, Expr>): void {
  const consider = (u: Expr) => {
    if (u.kind === 'var' || isConstIn(u, v)) return;
    out.set(key(u), u);
  };
  switch (e.kind) {
    case 'num':
    case 'var':
      return;
    case 'neg':
      subCandidates(e.a, v, out);
      return;
    case 'bin':
      if (e.op === '^') {
        consider(e.a);
        consider(e.b);
      }
      if (e.op === '/') consider(e.b);
      subCandidates(e.a, v, out);
      subCandidates(e.b, v, out);
      return;
    case 'call':
      consider(e); // u may be the call itself: ln(x) in ln(x)/x
      for (const a of e.args) {
        consider(a);
        subCandidates(a, v, out);
      }
      return;
    default:
      return;
  }
}

/** Structural replacement of a subexpression (by shape) with a variable. */
function replaceExpr(e: Expr, target: string, s: Expr): Expr {
  if (key(e) === target) return s;
  switch (e.kind) {
    case 'num':
    case 'var':
      return e;
    case 'neg': return neg(replaceExpr(e.a, target, s));
    case 'bin': return { kind: 'bin', op: e.op, a: replaceExpr(e.a, target, s), b: replaceExpr(e.b, target, s) };
    case 'call': return { kind: 'call', name: e.name, args: e.args.map(a => replaceExpr(a, target, s)) };
    default:
      return e;
  }
}

/**
 * Try e = g(u)·u′: for each candidate u, divide u′ out of the factor list
 * (structural cancellation, then exact polynomial division for what remains)
 * and check the quotient depends on v only through u.
 */
function uSubstitution(e: Expr, factors: Factor[], v: string, depth: number): Expr | null {
  const candidates = new Map<string, Expr>();
  subCandidates(e, v, candidates);
  for (const u of candidates.values()) {
    let du: Expr;
    try {
      du = diff(u, v);
    } catch {
      continue;
    }
    const ratio = divideOut(factors, du, v);
    if (!ratio) continue;
    const s = `@u${depth}`;
    const inS = replaceExpr(ratio, key(u), vr(s));
    if (freeVars(inS).has(v)) continue;
    const G = anti(inS, s, depth + 1);
    if (!G) continue;
    return substAll(G, s, u);
  }
  return null;
}

/** e / du as an expression, by cancelling shared factors and finishing with
 *  exact polynomial division; null when the quotient will not come clean. */
function divideOut(eFactors: Factor[], du: Expr, v: string): Expr | null {
  const { neg: duNeg, factors: duFs } = flatten(du);
  const left = eFactors.map(f => ({ ...f }));
  const still: Factor[] = [];
  let coefNum = 1;
  for (const f of duFs) {
    if (isConstIn(f.base, v)) {
      const c = constVal(f.base);
      if (c === null || c === 0) return null;
      coefNum *= Math.pow(c, f.exp);
      continue;
    }
    const hit = left.find(l => key(l.base) === key(f.base));
    if (hit && hit.exp >= f.exp) hit.exp -= f.exp;
    else still.push(f);
  }
  const remaining = left.filter(f => f.exp !== 0);
  if (!still.length) {
    return div(rebuild(remaining, duNeg), num(coefNum));
  }
  // Whatever did not cancel structurally must divide the polynomial part.
  const duRest = rebuild(still, false);
  const dP = exprToPoly(duRest, v);
  if (!dP || dP.length < 1) return null;
  const polyFs = remaining.filter(f => f.exp > 0 && exprToPoly(pow(f.base, num(f.exp)), v) !== null);
  const nonPoly = remaining.filter(f => !polyFs.includes(f));
  const eP = exprToPoly(rebuild(polyFs, false), v);
  if (!eP) return null;
  const { q, r } = fpdivmod(eP, dP);
  if (r.length) return null;
  const out = mul(fpToExpr(q, v), rebuild(nonPoly, false));
  return div(duNeg ? neg(out) : out, num(coefNum));
}
