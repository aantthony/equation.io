/**
 * Root finding over a real interval for arbitrary scalar expressions.
 *
 * Polynomial expressions go through the exact multiset machinery in poly.ts
 * (solid enumeration: every root once, with its true multiplicity). Anything
 * else falls back to dense sampling + safeguarded Newton/bisection: sign
 * changes give odd-multiplicity roots, near-zero local minima of |f| give
 * tangential (even-multiplicity) roots, and poles are rejected by checking
 * the residual. Multiplicity in the numeric path is a log-slope estimate:
 * near a root of multiplicity m, |f(x0+h)| ≈ C·h^m.
 */
import { diff } from './diff.ts';
import { type Expr, evaluate } from './expr.ts';
import { polynomialRoots } from './poly.ts';

export interface FoundRoot {
  x: number;
  mult: number;
  /** True when the root came from the exact polynomial path. */
  exact: boolean;
  /** Exact symbolic form ("√2", "1/3", "(1+√5)/2") when one exists. */
  sym?: string;
  /** Defining polynomial ("x⁷ - x - 2") when no radical form exists. */
  rootOf?: string;
}

const SAMPLES = 1536;

/** All roots of f(v) in [lo, hi]. 'zero' means f is identically zero. */
export function findRoots(f: Expr, v: string, lo: number, hi: number): FoundRoot[] | 'zero' {
  if (!(hi > lo) || !isFinite(lo) || !isFinite(hi)) return [];
  const exact = polynomialRoots(f, v);
  if (exact === 'zero') return 'zero';
  if (exact) {
    return exact
      .filter(r => r.x >= lo && r.x <= hi)
      .map(r => ({ x: r.x, mult: r.mult, exact: true, sym: r.sym, rootOf: r.rootOf }));
  }
  return numericRoots(f, v, lo, hi);
}

function numericRoots(f: Expr, v: string, lo: number, hi: number): FoundRoot[] | 'zero' {
  const ev = (x: number): number => {
    try {
      const y = evaluate(f, { [v]: x });
      return typeof y === 'number' ? y : NaN;
    } catch {
      return NaN;
    }
  };
  let dfExpr: Expr | null = null;
  try {
    dfExpr = diff(f, v);
  } catch {
    dfExpr = null;
  }
  const dev = (x: number): number => {
    if (dfExpr) {
      try {
        return evaluate(dfExpr, { [v]: x });
      } catch { /* fall through to finite differences */ }
    }
    const h = 6e-6 * (1 + Math.abs(x));
    return (ev(x + h) - ev(x - h)) / (2 * h);
  };

  const xs = new Float64Array(SAMPLES + 1);
  const ys = new Float64Array(SAMPLES + 1);
  let maxAbs = 0;
  let finiteCount = 0;
  for (let i = 0; i <= SAMPLES; i++) {
    const x = lo + ((hi - lo) * i) / SAMPLES;
    const y = ev(x);
    xs[i] = x;
    ys[i] = y;
    if (isFinite(y)) {
      finiteCount++;
      maxAbs = Math.max(maxAbs, Math.abs(y));
    }
  }
  if (!finiteCount) return [];
  if (maxAbs === 0) return 'zero';
  const residualTol = 1e-7 * maxAbs;

  const out: FoundRoot[] = [];
  const minSep = (hi - lo) * 1e-9;
  const push = (x: number, mult: number) => {
    for (const r of out) if (Math.abs(r.x - x) <= Math.max(minSep, 1e-13 * (1 + Math.abs(x)))) return;
    out.push({ x, mult, exact: false });
  };

  for (let i = 0; i < SAMPLES; i++) {
    const y0 = ys[i];
    const y1 = ys[i + 1];
    if (!isFinite(y0) || !isFinite(y1)) continue;
    if (y0 === 0) {
      push(xs[i], multiplicityEstimate(ev, xs[i], hi - lo, true));
      continue;
    }
    if (y0 * y1 < 0) {
      const x = refineBracket(ev, dev, xs[i], xs[i + 1], y0);
      // A pole (tan at π/2) also flips sign; a genuine root has a tiny residual.
      const fx = ev(x);
      if (isFinite(fx) && Math.abs(fx) <= residualTol) {
        push(x, multiplicityEstimate(ev, x, hi - lo, true));
      }
      continue;
    }
    // Tangential root candidate: an interior local minimum of |f| that dips
    // near zero without a sign change.
    if (i > 0 && isFinite(ys[i - 1])
      && Math.abs(y0) <= Math.abs(ys[i - 1]) && Math.abs(y0) <= Math.abs(y1)
      && Math.abs(y0) < 1e-3 * maxAbs) {
      const x = refineExtremum(ev, dev, xs[i - 1], xs[i + 1]);
      const fx = ev(x);
      if (isFinite(fx) && Math.abs(fx) <= 1e-10 * maxAbs) {
        push(x, multiplicityEstimate(ev, x, hi - lo, false));
      }
    }
  }
  if (ys[SAMPLES] === 0) push(xs[SAMPLES], multiplicityEstimate(ev, xs[SAMPLES], hi - lo, true));
  out.sort((a, b) => a.x - b.x);
  return out;
}

/** Safeguarded Newton within a sign-change bracket. */
function refineBracket(
  ev: (x: number) => number,
  dev: (x: number) => number,
  a: number,
  b: number,
  fa: number,
): number {
  let x = (a + b) / 2;
  for (let iter = 0; iter < 80; iter++) {
    const fx = ev(x);
    if (fx === 0 || !isFinite(fx)) break;
    if (Math.sign(fx) === Math.sign(fa)) { a = x; fa = fx; }
    else b = x;
    const d = dev(x);
    let nx = x - fx / d;
    if (!isFinite(nx) || nx <= a || nx >= b) nx = (a + b) / 2;
    if (Math.abs(nx - x) <= 2e-16 * (1 + Math.abs(x))) return nx;
    x = nx;
  }
  return x;
}

/** Locate the extremum of f in (a, b) by bisecting the derivative's sign
 *  change, falling back to golden-section on |f|. */
function refineExtremum(
  ev: (x: number) => number,
  dev: (x: number) => number,
  a: number,
  b: number,
): number {
  const da = dev(a);
  const db = dev(b);
  if (isFinite(da) && isFinite(db) && da * db < 0) {
    return refineBracket(dev, x => {
      const h = 1e-6 * (1 + Math.abs(x));
      return (dev(x + h) - dev(x - h)) / (2 * h);
    }, a, b, da);
  }
  // Golden-section on |f|.
  const phi = (Math.sqrt(5) - 1) / 2;
  let x1 = b - phi * (b - a);
  let x2 = a + phi * (b - a);
  let f1 = Math.abs(ev(x1));
  let f2 = Math.abs(ev(x2));
  for (let i = 0; i < 60 && b - a > 1e-15 * (1 + Math.abs(a)); i++) {
    if (f1 <= f2) {
      b = x2; x2 = x1; f2 = f1;
      x1 = b - phi * (b - a); f1 = Math.abs(ev(x1));
    } else {
      a = x1; x1 = x2; f1 = f2;
      x2 = a + phi * (b - a); f2 = Math.abs(ev(x2));
    }
  }
  return (a + b) / 2;
}

/**
 * Estimate root multiplicity from the local growth rate of |f|:
 * m ≈ log2(|f(x0+h)| / |f(x0+h/2)|). Crossing roots are forced odd,
 * tangential ones even; unusable data defaults to 1 or 2.
 */
function multiplicityEstimate(
  ev: (x: number) => number,
  x0: number,
  span: number,
  crossing: boolean,
): number {
  const ests: number[] = [];
  for (const dir of [1, -1]) {
    const h = dir * Math.max(span * 1e-4, 1e-7 * (1 + Math.abs(x0)));
    const fa = Math.abs(ev(x0 + h));
    const fb = Math.abs(ev(x0 + h / 2));
    if (fa > 0 && fb > 0 && isFinite(fa) && isFinite(fb)) {
      const m = Math.log2(fa / fb);
      if (isFinite(m) && m > 0.4 && m < 9.5) ests.push(m);
    }
  }
  const fallback = crossing ? 1 : 2;
  if (!ests.length) return fallback;
  let m = Math.round(ests.reduce((s, e) => s + e, 0) / ests.length);
  if (crossing && m % 2 === 0) m += m > 1 ? -1 : 1;
  if (!crossing && m % 2 === 1) m += 1;
  return Math.max(crossing ? 1 : 2, Math.min(9, m));
}
