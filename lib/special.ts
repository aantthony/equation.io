/**
 * Special points of a 2D implicit curve F(x, y) = 0 for hover display: the
 * axis intercepts, i.e. the roots of the two univariate restrictions
 * F(x, 0) and F(0, y). Each point carries its multiplicity — the result is
 * the multiset of intercepts, enumerated solidly by roots.ts/poly.ts.
 */
import { usesComplex } from './complex.ts';
import { type Expr, substVars } from './expr.ts';
import { type FoundRoot, findRoots } from './roots.ts';

export interface SpecialPoint {
  x: number;
  y: number;
  /** Tooltip lines, e.g. ['x-intercept', 'x = 1.41421356237', 'double root']. */
  lines: string[];
}

const NUM0: Expr = { kind: 'num', value: 0 };

/** Display a root with ~12 significant digits, trimmed. */
export function fmtRoot(v: number): string {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e9 || a < 1e-6) return v.toExponential(6);
  return String(parseFloat(v.toPrecision(12)));
}

function multText(m: number): string | null {
  if (m <= 1) return null;
  if (m === 2) return 'double root';
  if (m === 3) return 'triple root';
  return `root of multiplicity ${m}`;
}

/**
 * Recognize a numeric root as a small rational multiple of π ("π", "-π/2",
 * "3π/4"). Only used for roots found numerically — a tight tolerance plus
 * small numerator/denominator keeps false positives implausible.
 */
function piMultiple(x: number): string | null {
  const r = x / Math.PI;
  if (r === 0 || !isFinite(r) || Math.abs(r) > 60) return null;
  // Best small-denominator rational for r via continued fractions.
  let p0 = 1,
    q0 = 0,
    p1 = Math.floor(r),
    q1 = 1;
  let frac = r - p1;
  for (let i = 0; i < 24 && frac > 1e-12; i++) {
    const v = 1 / frac;
    const a = Math.floor(v);
    const p2 = a * p1 + p0;
    const q2 = a * q1 + q0;
    if (q2 > 48) break;
    p0 = p1;
    q0 = q1;
    p1 = p2;
    q1 = q2;
    frac = v - a;
  }
  if (p1 === 0 || Math.abs(p1) > 60) return null;
  if (Math.abs(x - (p1 / q1) * Math.PI) > 1e-10 * Math.max(1, Math.abs(x))) return null;
  const mag = Math.abs(p1) === 1 ? 'π' : `${Math.abs(p1)}π`;
  return `${p1 < 0 ? '-' : ''}${mag}${q1 === 1 ? '' : `/${q1}`}`;
}

/** The value line(s): exact symbolic form first when known, decimal after.
 *  Roots with no radical form show their defining polynomial — the exact
 *  representation the finder actually holds. */
function valueLines(v: string, r: FoundRoot): string[] {
  const sym = r.sym ?? (r.exact ? undefined : (piMultiple(r.x) ?? undefined));
  if (sym) return [`${v} = ${sym}`, `≈ ${fmtRoot(r.x)}`];
  if (r.rootOf) return [`${v} ≈ ${fmtRoot(r.x)}`, `root of ${r.rootOf}`];
  return [`${v} = ${fmtRoot(r.x)}`];
}

/**
 * Axis intercepts of the plotted curve within the given view ranges.
 *
 * expr is the plotted expression — an equation, or a bare scalar in x
 * meaning y = expr — with user constants already substituted, so its free
 * variables are only x and/or y. For a bare scalar the x-intercepts are
 * labelled as roots of the function.
 */
export function specialPoints(expr: Expr, xlo: number, xhi: number, ylo: number, yhi: number): SpecialPoint[] {
  if (usesComplex(expr)) return [];
  const isFn = expr.kind !== 'eq';
  const F: Expr = isFn ? { kind: 'eq', l: { kind: 'var', name: 'y' }, r: expr } : expr;
  const pts: SpecialPoint[] = [];

  let xr: ReturnType<typeof findRoots> = [];
  let yr: ReturnType<typeof findRoots> = [];
  try {
    xr = findRoots(substVars(F, { y: NUM0 }), 'x', xlo, xhi);
    yr = findRoots(substVars(F, { x: NUM0 }), 'y', ylo, yhi);
  } catch {
    return [];
  }

  if (xr !== 'zero') {
    for (const r of xr) {
      const lines = [isFn ? 'root' : 'x-intercept', ...valueLines('x', r)];
      const m = multText(r.mult);
      if (m) lines.push(m);
      pts.push({ x: r.x, y: 0, lines });
    }
  }
  if (yr !== 'zero') {
    const epsX = (xhi - xlo) * 1e-9;
    const epsY = (yhi - ylo) * 1e-9;
    for (const r of yr) {
      // The origin shows up on both axes; keep the x-intercept's version.
      if (Math.abs(r.x) <= epsY && pts.some(p => Math.abs(p.x) <= epsX && p.y === 0)) continue;
      const lines = ['y-intercept', ...valueLines('y', r)];
      const m = multText(r.mult);
      if (m) lines.push(m);
      pts.push({ x: 0, y: r.x, lines });
    }
  }
  return pts;
}
