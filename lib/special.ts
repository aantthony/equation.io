/**
 * Special points of a 2D implicit curve F(x, y) = 0 for hover display:
 *
 * - the axis intercepts, i.e. the roots of the two univariate restrictions
 *   F(x, 0) and F(0, y), each with its multiplicity — the multiset of
 *   intercepts, enumerated solidly by roots.ts/poly.ts;
 * - the extrema: for a graph y = f(x) the roots of f′ (same machinery, so
 *   polynomial extrema get exact forms) and the inflection points, the roots
 *   of f″ where it changes sign; for any other curve the horizontal tangents
 *   F = ∂F/∂x = 0, found by a budgeted seeded Newton search.
 *
 * curveTracer covers the rest of the curve: it projects the pointer onto it.
 */
import { type AxisMap, type AxisMaps, toWorld } from './axis-map.ts';
import { usesComplex } from './complex.ts';
import { diff } from './diff.ts';
import { type Expr, evaluate, freeVars, substVars } from './expr.ts';
import { fieldEvaluator } from './flow.ts';
import { type FoundRoot, findRoots } from './roots.ts';

export interface SpecialPoint {
  x: number;
  y: number;
  /** Tooltip lines, e.g. ['x-intercept', 'x = 1.41421356237', 'double root']. */
  lines: string[];
}

const NUM0: Expr = { kind: 'num', value: 0 };
const isY = (e: Expr) => e.kind === 'var' && e.name === 'y';

/** f when F is the graph y = f(x) (either way round), else null. */
export function graphRhs(F: Expr): Expr | null {
  if (F.kind !== 'eq') return null;
  const rhs = isY(F.l) ? F.r : isY(F.r) ? F.l : null;
  return rhs && !freeVars(rhs).has('y') ? rhs : null;
}

/** F as a residual expression, zero on the curve. */
const residualOf = (F: Expr): Expr => (F.kind === 'eq' ? { kind: 'bin', op: '-', a: F.l, b: F.r } : F);

const evalAt = (e: Expr, env: Record<string, number>): number => {
  try {
    const v = evaluate(e, env);
    return typeof v === 'number' ? v : NaN;
  } catch {
    return NaN;
  }
};

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
 * F is the plotted equation with user constants already substituted, so its
 * free variables are only x and/or y.
 */
export function specialPoints(F: Expr, xlo: number, xhi: number, ylo: number, yhi: number): SpecialPoint[] {
  if (usesComplex(F)) return [];
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
      const lines = ['x-intercept', ...valueLines('x', r)];
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
  for (const p of extremaPoints(F, xlo, xhi, ylo, yhi)) mergePoint(pts, p, xhi - xlo, yhi - ylo);
  return pts;
}

/** Add p, or fold its heading into a point already there (a minimum that is
 *  also an x-intercept reads "x-intercept, local minimum"). */
function mergePoint(pts: SpecialPoint[], p: SpecialPoint, w: number, h: number) {
  const same = pts.find(q => Math.abs(q.x - p.x) <= w * 1e-9 && Math.abs(q.y - p.y) <= h * 1e-9);
  if (!same) pts.push(p);
  else if (!same.lines[0].includes(p.lines[0])) same.lines[0] += `, ${p.lines[0]}`;
}

/** Sign of g just left and right of x, stepping a little short of the
 *  neighbouring roots so the test never straddles one. */
function sidesOf(g: Expr, x: number, gap: number): [number, number] {
  const h = Math.min(gap / 4, 1e-4 * (1 + Math.abs(x)));
  return [Math.sign(evalAt(g, { x: x - h })), Math.sign(evalAt(g, { x: x + h }))];
}

/** Root list of e over [lo, hi], or [] when that fails or e ≡ 0. */
function rootsOf(e: Expr, v: string, lo: number, hi: number): FoundRoot[] {
  try {
    const r = findRoots(e, v, lo, hi);
    return r === 'zero' ? [] : r;
  } catch {
    return [];
  }
}

/** Distance from each root to its nearest neighbour (or the span). */
function gaps(rs: readonly FoundRoot[], span: number): number[] {
  return rs.map((r, i) =>
    Math.min(span, i > 0 ? r.x - rs[i - 1].x : span, i + 1 < rs.length ? rs[i + 1].x - r.x : span),
  );
}

function extremaPoints(F: Expr, xlo: number, xhi: number, ylo: number, yhi: number): SpecialPoint[] {
  const f = graphRhs(F);
  if (f) return graphExtrema(f, xlo, xhi, ylo, yhi);
  return implicitExtrema(residualOf(F), xlo, xhi, ylo, yhi);
}

/** Local maxima/minima and inflection points of y = f(x). */
function graphExtrema(f: Expr, xlo: number, xhi: number, ylo: number, yhi: number): SpecialPoint[] {
  const vars = freeVars(f);
  if (vars.size && !(vars.size === 1 && vars.has('x'))) return [];
  let d1: Expr, d2: Expr | null;
  try {
    d1 = diff(f, 'x');
  } catch {
    return [];
  }
  try {
    d2 = diff(d1, 'x');
  } catch {
    d2 = null;
  }
  const out: SpecialPoint[] = [];
  const at = (r: FoundRoot, kind: string) => {
    const y = evalAt(f, { x: r.x });
    if (!isFinite(y) || y < ylo || y > yhi) return;
    out.push({ x: r.x, y, lines: [kind, ...valueLines('x', r), `y = ${fmtRoot(y)}`] });
  };
  const stationary = rootsOf(d1, 'x', xlo, xhi);
  const g1 = gaps(stationary, xhi - xlo);
  stationary.forEach((r, i) => {
    const [l, rt] = sidesOf(d1, r.x, g1[i]);
    if (l > 0 && rt < 0) at(r, 'local maximum');
    else if (l < 0 && rt > 0) at(r, 'local minimum');
    else if (l && l === rt) at(r, 'stationary inflection point');
  });
  if (d2) {
    const bends = rootsOf(d2, 'x', xlo, xhi);
    const g2 = gaps(bends, xhi - xlo);
    bends.forEach((r, i) => {
      if (stationary.some(s => Math.abs(s.x - r.x) <= (xhi - xlo) * 1e-9)) return;
      const [l, rt] = sidesOf(d2, r.x, g2[i]);
      if (l && rt && l !== rt) at(r, 'inflection point');
    });
  }
  return out;
}

/** Lattice divisions per axis for the horizontal-tangent search. */
const EXTREMA_LATTICE = 24;
/** Field evaluations the search may spend before it gives up on the row. */
const EXTREMA_BUDGET = 40000;
/** More horizontal tangents than this in view: too many to hover, and the
 *  search can no longer claim to have found them all. */
const MAX_EXTREMA = 64;

/** Deterministic jitter in [0, 1) for seed i (the same every run, so the
 *  markers never shuffle between recomputes). */
function jitter(i: number): number {
  let h = Math.imul(i + 1, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/**
 * Horizontal tangents of F(x, y) = 0 that are local extrema of y:
 * F = Fx = 0 with Fy ≠ 0, so y″ = −Fxx/Fy decides which.
 *
 * Damped Newton on (F, Fx) from a lattice of seeds, on compiled programs and
 * under a fixed evaluation budget, so a hard curve costs a bounded few
 * milliseconds. All or nothing: a search that runs out of budget, or finds
 * more than MAX_EXTREMA points, returns none rather than whichever part of
 * the view its seeds happened to reach first.
 */
function implicitExtrema(R: Expr, xlo: number, xhi: number, ylo: number, yhi: number): SpecialPoint[] {
  const vars = freeVars(R);
  if (![...vars].every(v => v === 'x' || v === 'y') || !vars.has('x') || !vars.has('y')) return [];
  let field: (p: number[]) => number[];
  try {
    const Fx = diff(R, 'x');
    const Fy = diff(R, 'y');
    field = fieldEvaluator([R, Fx, Fy, diff(Fx, 'x'), diff(Fx, 'y'), diff(Fy, 'y')]);
  } catch {
    return [];
  }
  let budget = EXTREMA_BUDGET;
  const at = (x: number, y: number): number[] | null => {
    if (--budget < 0) return null;
    const v = field([x, y]);
    return v.every(isFinite) ? v : null;
  };

  /** Newton from a seed to F = Fx = 0; null when it fails or wanders off. */
  const refine = (x: number, y: number): [number, number] | null => {
    let v = at(x, y);
    if (!v) return null;
    let rn = Math.hypot(v[0], v[1]);
    // Few iterations: a regular root converges quadratically well within
    // them, while seeds drawn to a singular point (the folium's node)
    // crawl in linearly and would spend the budget.
    for (let it = 0; it < 24; it++) {
      if (rn === 0) return [x, y];
      const [f, fx, fy, fxx, fxy] = v;
      const det = fx * fxy - fy * fxx;
      if (!det) return null;
      const dx = (fxy * f - fy * fx) / det;
      const dy = (fx * fx - fxx * f) / det;
      let scale = 1;
      let next: number[] | null = null;
      for (let k = 0; k < 10; k++, scale /= 2) {
        const nv = at(x - scale * dx, y - scale * dy);
        if (budget < 0) return null;
        if (nv && Math.hypot(nv[0], nv[1]) < rn) {
          next = nv;
          break;
        }
      }
      const small = Math.hypot(dx, dy) <= 1e-12 * (1 + Math.hypot(x, y));
      if (!next) return small ? [x, y] : null;
      x -= scale * dx;
      y -= scale * dy;
      v = next;
      rn = Math.hypot(v[0], v[1]);
      if (small) return [x, y];
      if (x < xlo - (xhi - xlo) || x > xhi + (xhi - xlo) || y < ylo - (yhi - ylo) || y > yhi + (yhi - ylo)) return null;
    }
    return null;
  };

  const n = EXTREMA_LATTICE;
  const found: Array<[number, number]> = [];
  const same = (a: number, b: number) => Math.abs(a - b) <= 1e-7 * (1 + Math.max(Math.abs(a), Math.abs(b)));
  for (let i = 0; i < n * n; i++) {
    const sx = xlo + ((xhi - xlo) * ((i % n) + 0.5 + 0.32 * (jitter(2 * i) - 0.5))) / n;
    const sy = ylo + ((yhi - ylo) * (Math.floor(i / n) + 0.5 + 0.32 * (jitter(2 * i + 1) - 0.5))) / n;
    const sol = refine(sx, sy);
    if (budget < 0) return [];
    if (!sol) continue;
    const [x, y] = sol;
    if (x < xlo || x > xhi || y < ylo || y > yhi) continue;
    if (found.some(([fx, fy]) => same(fx, x) && same(fy, y))) continue;
    found.push(sol);
    if (found.length > MAX_EXTREMA) return [];
  }

  const out: SpecialPoint[] = [];
  const num = (v: number): FoundRoot => ({ x: v, mult: 1, exact: false });
  for (const [x, y] of found.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const v = field([x, y]);
    const [, , fy, fxx, fxy, fyy] = v;
    // A crossing or cusp has Fy = 0 as well. Newton cannot pin such a point
    // exactly (the system is singular there), so Fy is judged against the
    // curvature of F, not against an absolute zero.
    const curvature = (Math.abs(fxx) + 2 * Math.abs(fxy) + Math.abs(fyy)) * Math.max(1, Math.abs(x), Math.abs(y));
    if (!v.every(isFinite) || fxx === 0 || Math.abs(fy) <= 1e-6 * curvature) continue;
    out.push({
      x,
      y,
      lines: [
        -fxx / fy < 0 ? 'local maximum' : 'local minimum',
        ...valueLines('x', num(x)),
        ...valueLines('y', num(y)),
      ],
    });
  }
  return out;
}

/** A point traced on a curve: the pointer projected onto it. */
export interface TracedPoint {
  x: number;
  y: number;
  /** Distance from the pointer, in pixels. */
  dist: number;
}

/**
 * The curve F = 0 as a pointer tracer: `trace(mx, my, sx, sy)` returns the
 * point of the curve nearest to (mx, my), measured in pixels where one pixel
 * is sx world units across and sy up (the view may be anisotropic), or null
 * when the curve is nowhere near. Newton's method projects the pointer onto
 * the curve, then slides along the tangent towards the pointer and projects
 * again until the foot point settles.
 *
 * For a graph y = f(x) the traced x is rounded to the digits fmtTraced shows
 * and y is f of that rounded x: the readout is an exact pair, not two rounded
 * ones.
 */
export function curveTracer(
  F: Expr,
  env: Record<string, number> = {},
): ((mx: number, my: number, sx: number, sy: number) => TracedPoint | null) | null {
  if (usesComplex(F)) return null;
  const R = residualOf(F);
  let field: ((p: number[]) => number[]) | null;
  try {
    field = fieldEvaluator([R, diff(R, 'x'), diff(R, 'y')], env);
  } catch {
    // No symbolic gradient, or one too large to compile: central
    // differences of F alone.
    field = null;
  }
  if (!field) {
    let ev: (p: number[]) => number[];
    try {
      ev = fieldEvaluator([R], env);
    } catch {
      return null;
    }
    field = ([x, y]) => {
      const f = ev([x, y])[0];
      const hx = 1e-6 * (1 + Math.abs(x));
      const hy = 1e-6 * (1 + Math.abs(y));
      return [
        f,
        (ev([x + hx, y])[0] - ev([x - hx, y])[0]) / (2 * hx),
        (ev([x, y + hy])[0] - ev([x, y - hy])[0]) / (2 * hy),
      ];
    };
  }
  const evalField = field;
  const rhs = graphRhs(F);
  let graph: ((x: number) => number) | null = null;
  if (rhs) {
    try {
      const ev = fieldEvaluator([rhs], env);
      graph = x => ev([x, 0])[0];
    } catch {
      graph = null;
    }
  }

  return (mx, my, sx, sy) => {
    if (!(sx > 0) || !(sy > 0)) return null;
    let x = mx;
    let y = my;
    /** Newton onto F = 0 in pixel units; false when it fails or wanders. */
    const project = (): boolean => {
      for (let i = 0; i < 24; i++) {
        const [f, fx, fy] = evalField([x, y]);
        const gx = fx * sx;
        const gy = fy * sy;
        const g2 = gx * gx + gy * gy;
        if (!isFinite(f) || !(g2 > 0) || !isFinite(g2)) return false;
        const k = f / g2;
        x -= k * gx * sx;
        y -= k * gy * sy;
        if (Math.abs(k) * Math.sqrt(g2) < 1e-7) return true;
        if (Math.hypot((x - mx) / sx, (y - my) / sy) > 400) return false;
      }
      const [f, fx, fy] = evalField([x, y]);
      return Math.abs(f) / Math.hypot(fx * sx, fy * sy) < 0.05;
    };
    if (!project()) return null;
    for (let i = 0; i < 6; i++) {
      const [, fx, fy] = evalField([x, y]);
      const gx = fx * sx;
      const gy = fy * sy;
      const g = Math.hypot(gx, gy);
      if (!(g > 0)) break;
      // Unit tangent in pixel space, and the pointer's offset along it.
      const tx = -gy / g;
      const ty = gx / g;
      const along = ((mx - x) / sx) * tx + ((my - y) / sy) * ty;
      if (Math.abs(along) < 1e-3) break;
      const px = x;
      const py = y;
      x += along * tx * sx;
      y += along * ty * sy;
      if (!project()) {
        x = px;
        y = py;
        break;
      }
    }
    if (graph) {
      // x exactly as the tooltip shows it, and y = f of that x.
      const xs = roundTraced(x, sx);
      const ys = graph(xs);
      if (isFinite(ys) && Math.abs(ys - y) / sy < 1) {
        x = xs;
        y = ys;
      }
    }
    if (!isFinite(x) || !isFinite(y)) return null;
    return { x, y, dist: Math.hypot((x - mx) / sx, (y - my) / sy) };
  };
}

/**
 * A traced coordinate at the view's precision: one digit finer than a pixel
 * (unit = world units per pixel), trailing zeros trimmed. Anything under a
 * twentieth of a pixel from zero reads 0, whatever its exponent.
 */
export function fmtTraced(v: number, unit: number): string {
  if (!isFinite(v) || !isFinite(unit) || !(unit > 0)) return fmtRoot(v);
  const a = Math.abs(v);
  if (a < unit / 20) return '0';
  const decimals = Math.ceil(-Math.log10(unit)) + 1;
  if (decimals <= 14 && a < 1e15) {
    const s = v.toFixed(Math.max(0, decimals));
    return decimals > 0 ? s.replace(/\.?0+$/, '') : s;
  }
  // Pixels finer than toFixed reaches, or huge values: significant digits
  // down to the same tenth of a pixel.
  const digits = Math.min(15, Math.max(1, Math.ceil(Math.log10(a / unit)) + 1));
  return String(parseFloat(v.toPrecision(digits)));
}

/** v rounded to exactly what fmtTraced shows. */
export const roundTraced = (v: number, unit: number): number => parseFloat(fmtTraced(v, unit));

/**
 * A mapped panel's row (lib/axis-map.ts) is drawn rewritten in screen
 * coordinates, and searched there too, evenly as a log axis needs: an
 * increasing map keeps extrema extrema, while inflection points are the
 * drawn curve's (where it bends on the screen). Positions stay on the
 * screen; the tooltip reads x and y. An intercept is kept only where the
 * screen's axis is x = 0 or y = 0 (on a log axis neither shows).
 */
export function mappedSpecialPoints(expr: Expr, maps: AxisMaps, xlo: number, xhi: number, ylo: number, yhi: number) {
  const atZero = (map: AxisMap | undefined) => !map || Math.abs(toWorld(map, 0)) < 1e-12;
  const shown: Record<string, boolean> = { 'x-intercept': atZero(maps.y), 'y-intercept': atZero(maps.x) };
  return specialPoints(expr, xlo, xhi, ylo, yhi).flatMap((p): SpecialPoint[] => {
    const heading = p.lines[0]
      .split(', ')
      .filter(h => shown[h] ?? true)
      .join(', ');
    const [x, y] = [maps.x ? toWorld(maps.x, p.x) : p.x, maps.y ? toWorld(maps.y, p.y) : p.y];
    if (!heading || !isFinite(x) || !isFinite(y)) return [];
    return [{ ...p, lines: [heading, `x = ${fmtRoot(x)}`, `y = ${fmtRoot(y)}`] }];
  });
}
