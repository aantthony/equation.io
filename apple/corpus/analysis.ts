/**
 * Records what the site reports for whole documents, so the Swift port of the
 * language trunk (apple/EquationCore: Analysis.swift and what it stands on)
 * is held to the same answers: every example in the menu, plus cases aimed at
 * the corners — errors, redefinitions, cycles, sliders, readouts.
 *
 *   node --experimental-transform-types --no-warnings apple/corpus/analysis.ts
 *
 * Writes analysis.json (per document: its rows, and per row what
 * lib/analysis.ts says of it) and evaluate.json (lib/expr.ts evaluate, what
 * it and its neighbours make of the kinds no row can write, and
 * the number formatting readouts are written with) beside the parser's
 * fixtures.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { analyzeRows } from '../../lib/analysis.ts';
import { definitionHead } from '../../lib/defs.ts';
import { diff } from '../../lib/diff.ts';
import { type PmfStems, type RVSystem, markerHeight, shadePolygon } from '../../lib/dist.ts';
import { runPaths, shadeNames, shadeRuns } from '../../lib/intshade.ts';
import {
  childrenOf,
  type Expr,
  evaluate,
  exprKey,
  freeVars,
  mapChildren,
  parseExpr,
  realPow,
  RECUR,
  structuralDiagnostic,
  substVars,
  TERM_AT_FN,
} from '../../lib/expr.ts';
import { ESCAPES, typedEscape } from '../../lib/escapes.ts';
import { realFourier, reconstructSeries, spectrumPoints } from '../../lib/fourier.ts';
import { toGLSL } from '../../lib/glsl.ts';
import { takesColor } from '../../lib/palette.ts';
import { valueReadout } from '../../lib/plot.ts';
import { fitRegression, formatFit } from '../../lib/regression.ts';
import { rowKind } from '../../lib/row-kind.ts';
import { sliderBounds, sliderForm, sliderValue, writeSlider } from '../../lib/slider.ts';
import { keepNote, noteStart, splitStatements, stripNote } from '../../lib/statements.ts';
import { EXAMPLES } from '../../web/examples.ts';
import { ALGEBRA_CASES } from './cases-algebra.ts';
import { DEFINE_CASES } from './cases-define.ts';
import { DISCRETE_CASES } from './cases-discrete.ts';
import { FITS_CASES } from './cases-fits.ts';
import { INTEGRAL_CASES } from './cases-integrals.ts';
import { INTERVAL_CASES } from './cases-intervals.ts';
import { PANEL_CASES, recordGridFields, recordStates } from './cases-panels.ts';
import { SURFACE_CASES } from './cases-surfaces.ts';
import { LEFTOVER_CASES, recordData } from './cases-leftovers.ts';
import { SAMPLED_CASES } from './cases-sampled.ts';
import * as planeMap from '../../lib/plane-map.ts';
import { PLANE_CASES, recordPlanes } from './cases-planes.ts';
import { MEASURE_CASES } from './cases-measure.ts';

const fixtures = new URL('../EquationCore/Tests/EquationCoreTests/Fixtures/', import.meta.url);

/** JSON has no NaN or ±Infinity, and Foundation's JSON reader rounds some
 *  decimals an ulp off: every number but a whole one travels as its text. */
const replacer = (_key: string, value: unknown): unknown =>
  typeof value === 'number' && !Number.isSafeInteger(value)
    ? String(value)
    : value instanceof Float64Array || value instanceof Float32Array
      ? // A packed column travels as its numbers while it is short enough to.
        value.length <= 4096
        ? Array.from(value)
        : { packed: value.length }
      : value;

/** web/render2d.ts niceSpacing's major step (that module needs a browser). */
function niceMajor(upp: number, minPx: number): number {
  const target = upp * minPx;
  const base = Math.pow(10, Math.floor(Math.log10(target)));
  for (const m of [1, 2, 5, 10]) if (m * base >= target) return m * base;
  return 10 * base;
}

const fmtNum = (v: number) => String(parseFloat(v.toPrecision(6)));

/** The plan kinds the Swift port compiles: their plans are recorded whole.
 *  Of the rest (and of a plan too long to be worth carrying) only the type. */
const PORTED = new Set([
  'implicit2d',
  'ineq2d',
  'scalar2d',
  'point',
  'pcurve',
  'vfield2d',
  'value',
  'note',
  'none',
  'complex2d',
  'domain2d',
  'conformal2d',
  'fractal2d',
  'rgb2d',
  'hsl2d',
  'oklch2d',
  'orbit',
  'trail',
]);
// Geometry (lib/geom.ts): figures and labels; matrices and tensors read out, and matrix fields.
for (const type of ['polygon', 'label', 'tuple', 'tfield2d']) PORTED.add(type);
for (const type of ['sequence', 'cobweb', 'bifurcation', 'automaton', 'lattice']) PORTED.add(type);
// In space.
for (const type of ['implicit3d', 'scalar3d', 'spacecurve', 'system', 'vfield3d', 'psurface', 'pregion'])
  PORTED.add(type);
// Random variables (lib/dist.ts): what the CPU draws of one, by its name.
for (const type of ['density', 'pmf', 'expect', 'prob']) PORTED.add(type);
// Lists and families (Lists.swift, ObjectLists.swift, ListPlans.swift).
for (const type of ['vlist', 'plist', 'dlist', 'dscatter', 'histogram', 'family']) PORTED.add(type);
// A family over an interval (ClassifyIntervals.swift).
PORTED.add('projected2d');
// Geodesics of a surface (Geodesic.swift).
PORTED.add('geodesic');
function slim(plan: { type: string } | undefined): unknown {
  if (!plan) return null;
  if (!PORTED.has(plan.type)) return { type: plan.type, omitted: true };
  const text = JSON.stringify(plan, replacer);
  return text.length > 20_000 ? { type: plan.type, omitted: true } : plan;
}

/** What web/scene.ts draws of a random variable's plan, from lib/dist.ts: a pmf's stems (the whole law, and
 *  through a window), the stems or the polygon a P(…) row selects, a density's curve by whichever tier draws
 *  it (whole, and as a view deep inside it is given), what its readout would say, and an E(…) row's marker. */
function drawnOf(plan: { type: string } | undefined, rvs: RVSystem, constEnv: Record<string, number>): unknown {
  const env = { ...constEnv, t: 0 };
  const window = { lo: -2.5, hi: 9.25 };
  const attempt = (run: () => unknown): unknown => {
    try {
      return run() ?? null;
    } catch {
      return 'error';
    }
  };
  const runs = (found: PmfStems[] | null): unknown =>
    found && found.map(s => ({ ks: [...s.ks], ps: [...s.ps], envelope: s.envelope, step: s.step ?? null }));
  const curveOf = (rv: string, view?: { lo: number; hi: number }) => {
    const c = rvs.curve(rv, env, view);
    return (
      c && { pts: [...c.pts], atoms: c.atoms ?? null, mean: c.mean, sd: c.sd, mass: c.mass, robust: c.robust ?? null }
    );
  };
  const cpu = plan as import('../../lib/compiler.ts').CpuPlan | undefined;
  switch (cpu?.type) {
    case 'pmf':
      return {
        all: attempt(() => runs(rvs.pmfRuns(cpu.rv, env))),
        window: attempt(() => runs(rvs.pmfRuns(cpu.rv, env, window))),
      };
    case 'density':
      return {
        curve: attempt(() => curveOf(cpu.rv)),
        // A view a twentieth of the curve wide, in its middle: the quadrature tier draws that stretch afresh.
        zoomed: attempt(() => {
          const pts = rvs.curve(cpu.rv, env)?.pts ?? [];
          if (pts.length < 4) return null;
          const span = pts[pts.length - 2] - pts[0];
          const view = { lo: pts[0] + 0.47 * span, hi: pts[0] + 0.52 * span };
          return { view, curve: curveOf(cpu.rv, view) };
        }),
        moments: attempt(() => rvs.moments(cpu.rv, env)),
      };
    case 'prob': {
      const shade = cpu.shade;
      if (!shade) return null;
      return {
        all: attempt(() => runs(rvs.pmfRuns(shade.rv, env, undefined, shade))),
        window: attempt(() => runs(rvs.pmfRuns(shade.rv, env, window, shade))),
        polygon: attempt(() => {
          const c = rvs.curve(shade.rv, env);
          const lo = shade.lo ? evaluate(shade.lo, env) : undefined;
          const hi = shade.hi ? evaluate(shade.hi, env) : undefined;
          return c && shadePolygon(c, lo, hi);
        }),
      };
    }
    case 'expect':
      return { mark: attempt(() => markerHeight(rvs, cpu.rv, env)) };
    case 'value': {
      // The area a definite integral's row shades (lib/intshade.ts), through a window.
      const shade = cpu.shade;
      if (!shade) return null;
      return {
        names: shadeNames(shade),
        runs: attempt(() => shadeRuns(shade, env, window.lo, window.hi)),
        paths: attempt(() => shadeRuns(shade, env, window.lo, window.hi).map(run => runPaths(run, -1.5, 2.5))),
      };
    }
    default:
      return null;
  }
}

/** Targeted documents: one concern each, rows separated as the examples' are. */
const CASES: string[] = [
  ...PANEL_CASES,
  // Curves, constants as params, level sets.
  'y = sin(x)',
  'a = 2; y = a sin(x)',
  'a = 2; b = a^2 + 1; y = b x + a',
  'x^2 + y^2 = 9',
  'r = 3; x^2 + y^2 = r',
  'c = 1; y = c',
  'c = 1; c = y - x^2',
  'k = 2; abs(x) + abs(y) = k',
  'k = 2; atan2(y, x) = k',
  'k = 2; floor(x) + y = k',
  'y = x^2 # parabola',
  'y = x^2 #e24',
  'y = x^2 #1f77b4 a note',
  '# heading; y = x; ; z',
  'y = {x > 0: x, 0}',
  'y = {0 < x < 1: 1, x >= 1: 2}',
  'y = {x > 0, 2}',
  'y = max(x, 0); y = min(x, 1); y = clamp(x, -1, 1)',
  'y = x^0.5; y = x^3; y = (x + 1)^2; y = (x+1)^5; y = 2^x; y = x^x',
  'y = sqrt(x) + abs(x) + exp(x) + ln(x) + log(x) + log2(x)',
  'y = tan(x); y = sinh(x) + cosh(x) + tanh(x) + sech(x) + coth(x)',
  'y = asin(x) + acos(x) + atan(x); y = asinh(x); y = acosh(x); y = atanh(x)',
  'y = floor(x); y = ceil(x); y = round(x); y = sign(x); y = fract(x); y = mod(x, 2)',
  'y = erf(x); y = gamma(x); y = x!; y = sinc(x); y = gcd(x, 4); y = isprime(x)',
  'y = normalpdf(x, 0, 1); y = normalcdf(x, 0, 1)',
  'y = atan2(x, 1); y = atan(x, 1)',
  'y = 1/0; y = 0/0 x',
  'y = x·2; y = 2 × x',
  'y = pi x; y = e^x',
  'x = 1; x = y^2; y = y; x = x',
  'y = sin(x - t); a = t; y = a x',
  // Inequalities.
  'y < x; y <= x^2; y > 0; x >= 1',
  '0 < y < x; 0 <= y <= 1; x^2 + y^2 < 4',
  '0 < y > x; y < x < z',
  'a = 1; y < a x',
  // Scalar fields, hints.
  'sin(x) y; x^2 + y^2; sin(x); cos(y); x y z; x + z',
  'a = 2; a x y',
  // Values and notes.
  '1 + 1; sqrt(2); 1/3; 1/0; 0/0; -1/0; 10^21; 1e3; 2^0.5; 0.001234567; 0.0001234567; 123456789',
  'a = 2; a + 1; a^10; t; sin(t)',
  '2 + 2 = 4; 2 + 2 = 5; 1 < 2; 2 < 1; 0 < 1 < 2; 1 < 0 < 2; 1/0 = 1',
  'a = 2; a = 3; a > 1; t > 1',
  'e = 0.6; pi = 3; i = 2; d = 1; e = e; d(x) = x',
  't = 3; t = t',
  'sin(x)^2 + cos(x)^2 = 1; x + y = y + x; sin(x)^2 + cos(x)^2 = 1.0001; min(x, 10) = x',
  // Points and vector fields.
  '(1, 2); (0, 0); (1, 2, 3); (1, 2, 3, 4); (a, 1)',
  'a = 1; (a, a^2); (cos(t), sin(t))',
  'A = (1, 2); A; B = A + (1, 1); B; C = 2 A; C; D = (A + B)/2; -A',
  'A = (1, 2); B = (3, 4); A + B; A - B; A B; A + 1; A/B; A^2; (A, 1); y = A_x x + A_y',
  'A = (1, 2); B = A; C = B_x + A_y; (C, 1)',
  'P = (x, y); s = (x, 0); Q = (1, 2, 3); Q',
  'A = (1, 2); A_x = 3',
  'C = A + (1, 0); A = (1, 2)',
  '(y, -x); (1, x); (x, y, 0); (sin(y), cos(x) + t)',
  "y' = x - y; dy/dx = x; dx/dy = y; (x', y') = (y, -x); (x', y') = 3; (x', y') = (1, 2, 3); y' + 1",
  "a = 1; y' = a x",
  '(u, v); (cos(u), sin(u)); (u, v, u v); u; u + 1; (x, u); (v, 1)',
  // Definitions: functions, fields, conditions, errors.
  'f(x) = x^2; y = f(x); y = f(x + 1); f(2); f(1, 2); f()',
  'f(x, y) = x y; f(1, 2); f((1, 2)); f((1, 2, 3)); z = f(x, y); f(x, y) = 1',
  'g(a, b) = a + b; h(x) = g(x, 1) + g(1, x); y = h(x)',
  'f(x) = g(x); g(x) = f(x); y = f(x)',
  'f(x) = f(x - 1); y = f(x)',
  'f(x, x) = x; y = f(1, 2)',
  'f(x) = x +; y = f(x)',
  'f(x) = a x; a = 2; y = f(x); f(3)',
  'f(x) = x^2; f(x) = x^3; f = 2',
  'a = 1; a = 2; y = a x',
  'a = b; b = a; y = a x',
  'a = a + 1; y = a',
  'a = b + 1; y = a x',
  'a = 2 b; b = 3; a',
  'a = sin(; y = a x',
  'c = b + 1; d2 = c + 1; y = d2',
  'r = sqrt(x^2 + y^2); r = 2; r < 1; r; th = atan2(y, x); th = 1; y = r',
  'r = sqrt(x^2 + y^2); f(q) = q r; f(2) = 1; s = r + q0',
  'r = sqrt(x^2 + y^2); r = sqrt(x^2 + y^2)',
  'k = u^2; k = 2; m = x + u',
  'g = x^2 + y^2; d/dx g; y = d/dx (x^3); y = d/dx sin(x) x; y = d^2/dx^2 x^4; (d/dx)(x^2); y = d/dx floor(x)',
  'y = d/dx abs(x); a = 2; y = d/dx (a x^2); y = d/da (a x^2); y = d/dx x^a',
  'within = x > 0; y = {within: 1, 0}; within; 1 + within; ok = within; y = {ok: x}',
  'near = r < 2; r = sqrt(x^2 + y^2); {near: 1}; big = a > 1; a = 2; b = {big: 1, 0}; b',
  'y = {x: 1}; y = {x = 1: 2}; a = 2; {a = 2: 1, 0}; {a = 3: 1, 0}',
  'total = 3; y = total (x + 1); gamma = 2; y = gamma x',
  'sin = 2; y = 1; x_1 = 2; y = x_1 x; T_c = 300; T_c; k_B = 1.5; k_B',
  'u_a = 1; α = 2; y = α x; θ₁ = 1; y = θ₁ + x; T₀ = 2; y = T₀',
  'a_n = 1/n; a_1 = 2; a_{0} = 1; b_j = 3; b_j x = y',
  'n = 5; y = n x',
  // Sliders.
  'a = 0.4; b = clamp(0.4, 0, 1); n = round(5); r = round(clamp(30, 0, 255)); c = -3.5; d1 = .5; e1 = 12.',
  'a = 25; b = -40; c = clamp(5, 0, 1); lo = 1; hi = 3; m = clamp(2, lo, hi); q = clamp(2, hi, lo)',
  'a = 1 + 1; b = floor(2.5); clamp(x) = x; c = clamp(3); k = ceil(clamp(2.2, 1, 9)) # steps',
  'a = 1e3; b = 2 # two',
  // Views, dividers, grids.
  'view(x = -5..5, y = -2..2); y = x',
  'view(x = -5..5); view(y = 0..1)',
  'a = 2; view(x = -a..a, y = -pi..pi, ratio = 2, locked)',
  'view(x = 1..0); view(); view(x = 1); view(ratio = 0, x = 0..1); view(x = 0..b)',
  'camera(0.5, 0.3); camera(0, 0, 10, (1, 2, 3), spin = 0.5, locked); camera(1); camera(0, 0, -1)',
  'y = x; ---; y = x^2; --- right 40%, shared x; view(x = 0..1); --- inset top left 30%; --- sideways; ---x',
  'grid(off); grid(axes); ---; grid(on); grid(none); ---; grid(); grid(r, theta)',
  'view(x = 1..100, x = 10^X); y = x',
  'view(i = 0..10, n = 0..5)',
  'on((X, Y, Z) = (x, y, 0), x = 0..1, y = 0..1); y = x',
  'view(x) = x; view(2)',
  // Outside the port: lists, sums, complex, 3D, data, randomness.
  'L = [1, 2, 3]; L; y = L x; b = L[1]; b + 1; y = b x',
  'y = sum(n=1..5, x^n); int[0..1] x^2 dx; mean([1, 2, 3])',
  'z = x^2 + y^2; x^2 + y^2 + z^2 = 1; (cos(u), sin(u), u)',
  'w^2; i; a = e^(i pi/3); a; (1, i)',
  'X ~ Normal(0, 1); P(X > 1); E(X); Y = X^2; y = x; P(1 > 0)',
  'P(1 > 0); E(2)',
  "a' = -a; a(0) = 1; y = a x; y = x",
  'segment((0, 0), (1, 1)); circle((0, 0), 1); polygon((0,0), (1,0), (0,1)); label((1, 2), "hi")',
  'p = open("a.csv"); p.x; y = x',
  'M = ((1, 2), (3, 4)); det(M); y = x',
  'q = interval(0, 1); y = q x; y = x',
  'rgb(x, y, 0); domain(w); iter(z^2 + w)',
  'y = e_x; e_x; a ∈ [1, 2]; y = a x',
  'graph((1, 2)); mark(3); lightcones; tidal; ds^2 = dx^2 + dy^2',
  'y = x..2; 1..5; y = "text"; y = x == 1',
  // Lists: literals, ranges, names, broadcasting.
  '[1, 2, 3]; [1..5]; [0, 0.5..2]; [10..1]; [1, 3..10]; []; [2, 2, 3, 3, 3]; [1.5, 1/3, pi]',
  'L = [1, 2, 3]; L; 2 L; L + 1; L^2; sin(L); -L; L L; L + L; L/2; {L > 1: L}; max(L, 2); mod(L, 2); atan2(L, 1)',
  'a = 2; [a, 2a, a^2]; [1..a]; [a..1]; [0, a..7]; b = 0.5; [0, b..2]; [t, 2t]; [x, 1]; [a, t]; a [1, 2] + t',
  '[1..3] + [10, 20]; ([1, 2], [3, 4]); L = [1, 2]; (L, L); (L, L^2); M = [3, 4]; (L, M); L + M; (L, M, L); (L, 1)',
  '[1, 2..1]; [1..t]; [1..q]; [0, 0..5]; [5, 4..9]; [1..20000]; [1/0, 2]; [1, (2, 3)]; [1, [2, 3], 4]; [[1, 2], [3]]',
  'L = [1..200]; L; 2 L; a = 2; a L; (L, L^2); (L, a L); sin(a L); mean(a L); L[L > 150]; count(L); total(L)',
  // Lists of points, their coordinates, and arithmetic on them.
  '[(1, 2), (3, 4)]; P = [(0, 0), (1, 1), (2, 0)]; P; P.x; P.y; (P.x, P.y + 1); P.z; P[1]; P[3]; count(P); mean(P)',
  'P = [(0, 0), (1, 2)]; total(P); P + (1, 0); 2 P; -P; P + P; Q = P + (1, 1); Q; (Q.x, P.y); P/2; P (1, 2); P^2',
  'A = (1, 2); B = (3, 4); [A, B]; [A, B, (0, 0)]; L = [A, B]; L; L.x; [A, 1]; [(1, 2), (1, 2, 3)]; mean([A, B])',
  'P = [(0, 0), (1, 2)]; f(x, y) = x + y; f(P); g(p) = p.x; g(P); h(x, y) = (y, x); h(P); k(a, b, c) = a; k(P)',
  '[(1, 2, 3), (4, 5, 6)]; ([1, 2], [3, 4], 0); [(t, 1), (2, t)]; a = 2; [(a, 1), (1, a)]; [(x, 1)]; [(u, 1), (u, 2)]',
  // Reductions and sorting.
  'L = [3, 1, 2]; mean(L); total(L); count(L); min(L); max(L); stdev(L); median(L); sort(L); sort(L)[1]; L[1]',
  'mean([1, 2, 3, 4]); total([]); mean([]); count([]); stdev([1]); median([1, 2, 3, 4]); min([4, 2]); max([t, 1])',
  'mean([t, 2t]); mean(5); total(2, 3); mean(q); count((1, 2)); sort([3, 1], [1, 2]); sort(3); stdev([t, 1]); median([1, a])',
  'L = [3, 1, 2]; T = sort(L); T; T[2]; T[1..2]; T[0]; T[4]; T[1.5]; T[[1, 3]]; n = 2; T[n]; T + T; T[T > 1]; 2 T',
  'P = [(2, 0), (1, 1), (3, 5)]; sort(P, P.x); sort(P, P.y)[1]; sort(P); sort(P, [1, 2, 3]); S = sort(P, -P.x); S; S[1]',
  'L = [1, 2, 3, 4]; mean(L) + 1; total(L^2); y = mean(L) x; y = total(L x); max(L) - min(L); mean(L, 2); count(L, L)',
  // Filters, and comparisons as values.
  'L = [1..10]; L[L > 5]; L[L == 3]; L[L != 3]; L[2 < L < 6]; L > 5; L == 2; L[1 < 2]; L[L > t]; L[L > q]',
  'L = [1..6]; M = L[L > 2]; M; (M, M^2); count(M); (L[L > 2], L[L > 2]^2); big = L > 3; big; {big: 1}; L[mean(L) > 0]',
  'L = [1, 2, 3]; M = [1, 2]; L[M > 1]; L < M; L^2 < 5; (L > 1) > 2; L[L]; L[M]; L[[3, 1]]; L[5]; L[x]; x[1]; 3[1]',
  'P = [(0, 1), (2, 3), (4, 5)]; P[P.x > 1]; P.x > 1; P.y[P.x > 1]; count(P[P.x > 1]); P[1 < P.x < 5]',
  // Tuples.
  '(1, 2, 3, 4); (1, 2, 3, 4, 5, 6, 7, 8, 9, 10); T = (3, 1, 2, 5); T; T[2]; total(T); sort([3, 1, 2, 4]); (1, [2, 3], 4, 5)',
  'sort([2, 1]); sort([3, 1, 2]); A = (3, 1, 2); A[2]; A[1] + A[3]; B = (1, 2); B[1]; B[3]; [(1, 2, 3, 4), (5, 6, 7, 8)]',
  'T = (1, 2, 3, 4); 2 T; T + T; T + (1, 1, 1, 1); T + (1, 2); mean(T); count(T); T[2..3]; [T, T]; [T, 1]; (T, T)',
  'M = [(1, 2, 3, 4), (5, 6, 7, 8)]; M; M[2]; count(M); total(M); mean(M); sort(M); max(M); L = sort([1..12]); L; L[3]',
  // Families.
  'y = [1, 2, 3] x; a = [1..3]; y = a x; y < a; x^2 + y^2 = a^2; (a, a^2); a x; (cos(a u), sin(u)); y = a x + [0, 1]',
  'k = [1..40]; y = k x; b = [1, 2]; (y, -b x); y = {b > 1: x, -x}; b + x = y; b; b x y; (b u, u); y = sin(b x) + t',
  'i = [0..3]; e = [1, 2]; t = [1, 2]; d = [1, 2]',
  'c = [1, 2]; s = 2; y = c x + s; y = c x^s; (c, s) + (x, y); x = c; y > c x; c < x < c + 1; y = c; c = y',
  'a = [1, 2]; b = [3, 4]; y = a x + b; y = a x + a; (a, b); (a, a); x^2/a + y^2/b = 1; a + b; a b = 3',
  // Functions per member.
  'avg(s) = mean(s); avg([1, 2, 3]); L = [1, 2, 3]; avg(L); f(m) = total(L m); f(L); f(2); g(a) = [a, 2a]; (g(1), g(2))',
  'h(a) = [1, 2] + a; (h(1), h(2)); h(3); L = [1, 2]; h(L); g(a) = [a, 2a]; g(L); (g(1), g(1)); c(m) = count(m); c(L); c(3)',
  'f(x) = (x, x^2); f([1, 2, 3]); g(x, y) = x + y; g([(1, 2), (3, 4)]); L = [1, 2]; f(L); (f(L), 1); f(L) + (1, 1)',
  'm(p) = mean(p); P = [(0, 0), (2, 4)]; m(P); d2(x, y) = total(x) + y; d2(P); w2(p) = p.x + count(p); w2(P)',
  // Histograms.
  'L = [1, 2, 2, 3, 3, 3, 4]; hist(L); hist(L, 3); hist(L)/2; 2 hist(L); hist(L) + 1; h = hist(L); hist(L, 1); hist(L, 2.5)',
  'hist([2, 2]); hist(3); hist([1, 2, 3], 3, 4); hist([]); hist([1/0, 1]); hist([t, 1]); hist([(1, 2)]); hist(x)',
  'n = 4; L = [1..20]; hist(L, n); m = 3; L[m]; k = 2.5; L[k]; j = 2; sort(L)[j]; i2 = 1; y = i2 x',
  // Cases over lists, and members with no value.
  'L = [1..5]; {L > 2: L}; {L > 2: L, 0}; M = {L > 2: L}; M; count(M); mean(M); {L = 3: 1, 0}; {L > t: 1, 0}; (L, M)',
  'L = [1, 2, 3]; y = {L > 1: x, -x}; {x > 0: L, 0}; {L > 1: (L, 1)}; sort({L > 1: L}); total({L > 1: L}); {L: 1}',
  // Text, and what a list cannot do.
  '"a"; ["a", "b"]; L = [1, 2]; L == "a"; L + "a"; y = L == 1; x == 1; [1, 2] = [1, 2]; L = 3; count(["a", "b"]); mean(["a"])',
  'L = [1, 2]; y = L[1] x; y = L; L = y; L < y; (L, x); [1, 2] x y; L x; [x, y]; N = [x, 1]; N; K = [q0, 1]; K',
  // Binders.
  'p ∈ [1, 2, 3]; p; y = p x; q ∈ [0, 1]; (p, q); r ∈ 3; r; s ∈ x; w2 ∈ [1, 5]; (w2, w2)',
  'A = [1, 2]; p ∈ A; q ∈ A; (p, q); (A, A); (p, A); T = sort(A); k ∈ T; k; c ∈ p > 1; e ∈ [1, 2]; x ∈ [1, 2]',
  // Definitions in and out of order.
  'y = L x; L = [1, 2]; b = L[1]; c = M[1]; M = [1, 2]; a = M; a; M = [3]; d1 = [1, 2] + q9',
  'L = [1, 2, 3]; L[1]; L[L > 1][1]; [1, 2, 3][2]; sort(L)[4]; [(1, 2), (3, 4)][1]; L[2] x = y; sort([3, 1])[1]',
  'y = d/dx [x, x^2]; L = [1, 2]; y = d/dx (L x); a = 2; b = [a, 1]; b; c = mean(b); c; y = c x',
  'L = [1, 2]; f(x) = L x; f(2); y = f(x); g(x) = mean(L) x; y = g(x); h(x) = L[1] x; y = h(x); s(L) = L + 1; s(2)',
  // Point arithmetic and points through functions and cases.
  'A = (1+1, 2 0.5); A; 2 A + (0, 0); A - A; 0 A; A/1; -A; A 2; (A_x, A_y + 1)',
  'A = (1, 2); y = {x > 0: (1, 2), (3, 4)}; {t > 0: A, (0, 0)}; {t > 0: A, 1}; {A: 1}; x = A; (1, 2) = A',
  'A = (1, 2); f(p) = p.x + p.y; f(A); f((3, 4)); y = f(x); f((1, 2, 3)); g(p) = p.z; g(A); A.x + A.y; A.z',
  'v = (1, 2, 3); u = (1, 2); t = (1, 2); e = (1, 2); A = (1, 2); A = (3, 4)',
  'y = 2 + 3; (1 + 1, 2 3); y = -(-x); y = x - -1; y = (x); y = ((x + 1))',
  // Parametric curves in the plane.
  '(cos(2 pi u), sin(2 pi u)); a = 2; (a u, u^2); (floor(3 u), u); (u, abs(u - 0.5)); (u, t); (u, gamma(u))',
  'c = (cos(2 pi u), sin(2 pi u)); c; 2 c; c + (1, 0); k = u^2; (u, k); (k, x); (u, sinc(u)); (mod(u, 0.3), u)',
  // Complex numbers: values, claims, and what typing refuses.
  'i; i^2; 1 + 2i; e^(i pi); (1 + i)/(1 - i); sqrt(i); ln(i); i^i; 2^i; conj(1 + i); re(1 + 2i); im(1 + 2i)',
  'abs(3 + 4i); arg(i); sin(i); cos(1 + i); tan(i); sinh(i); cosh(i); tanh(1 + i); log(i); exp(i); -i; i^-3; i^20',
  'i^2 = -1; e^(i pi) = -1; i = 1; i^2 = 1; (1 + i)^2 = 2i; abs(i) < 2; i < 1; 1/(i - i) = 1; re(i) = 0',
  're(2); im(2); arg(-1); conj(2); abs(-2); re(1, 2); conj(); re(); floor(i); max(i, 1); atan2(i, 1); i!; mod(i, 2)',
  'a = 2; a i; a + t i; t i; sin(t) + i cos(t); {a > 1: i, 1}; {i > 1: 1}; {abs(i) > 0: 2}',
  // Fields of w = x + iy.
  'w^2; 1/w; ln(w - 1) - ln(w + 1); re(w^2); im(w^2); abs(w); arg(w); conj(w); w conj(w); exp(w); sqrt(w)',
  'y = re(w^2); im(ln(w)) = 1; abs(w) = 2; abs(w - 1) < 1; re(w) > im(w); w = 1; w^2 = 1; y = w; w < 1; y = im(w)',
  'w^0.5; w^w; w^9; w^-2; w^8; 2^w; sin(w) + t; a = 2; a w + 1; w + z; z w; w^2 + u; cosh(w)/sinh(w); tan(w); log(w)',
  '{x > 0: w, 1}; {abs(w) < 1: w^2, i}; {w > 0: 1}; {x > 0: re(w)}; r = abs(w); r = 1; r; q = w^2; q; re(q) = 1',
  'k = 1; re(w^2) = k; k = im(w^2); abs(w) + arg(w) = k; y = arg(w) + k',
  // domain(…), conformal(…).
  'domain(w^2); domain((w - 1)/(w + 1)); domain(x); domain(w, 2); domain(); domain(z); domain(u w); 1 + domain(w)',
  'conformal(w^2); conformal(w + 1/w); conformal(1); a = 2; conformal(w^a); conformal(exp(w) + t); conformal(i)',
  'sin(rgb(x, y, 0)); domain(domain(w)); y = iter(z); domain(w) = 1; (domain(w), 1); f(q) = domain(q); f(w)',
  // iter(…): escape-time fractals.
  'iter(z^2 + w); iter(z^2 - 0.8 + 0.156i); iter(z^2 + w, 100); iter(z^2 + w, 0); iter(z^2 + w, x); iter()',
  'iter(z^2 + w, 1e9); iter((abs(re(z)) + i abs(im(z)))^2 + w); iter(x + y); c = 0.3; iter(z^2 + c); iter(z^3 + w, 50.4)',
  'iter(sin(z) + w); iter(z^2 + w, 2, 3); iter(z); iter(1); iter(z^2 + u); iter({abs(z) < 1: z^2 + w, z}); iter(z < 1)',
  'c = -0.8 + 0.156i; iter(z^2 + c); k = 3; iter(z^k + w t); iter(conj(z)^2 + w, 60)',
  // Colour fields.
  'rgb(x, y, 0); rgb(x, y, 0, 0.5); hsl(arg(w), 1, 0.5); oklch(0.7, 0.1, arg(w)); rgb(1, 2); rgb(w, 0, 0)',
  'rgb(x > 0, 0, 0); hsl(atan2(y, x), 1, {x^2 + y^2 < 4: 0.5, 1}); rgb(re(w^2), re(w^2), im(w^2)); rgb(1, 0, 0)',
  'a = 2; rgb(a x, a x, t); c = rgb(1, 0, 0); rgb(u, 0, 0); rgb(z, 0, 0); f(q) = rgb(q, q, q); rgb(x, y, 0, 0, 0)',
  'q = (w - 1)/(w + 1); hsl(arg(q), 1, abs(q)/(1 + abs(q))); oklch(abs(q), 0.1, arg(q^2), {abs(q) < 1: 1, 0.5})',
  'rgb(sin(x)^2, sin(x)^2, (sin(x)^2)^2); rgb(x = 1, 0, 0); hsl(i, 1, 1); rgb(x y, x y + 1, {x y > 0: x y, -x y})',
  // Complex constants.
  'a = e^(i pi/3); a; c = 2a; c; b = abs(a); b; q = w - a; domain(q); a^2; y = re(a) x; a = 1',
  'a = 1 + i; f(z) = z^2 + a; f(i); domain(f(w)); g(a) = a^2; g(2); ok = abs(a) < 2; {ok: 1, 0}; bad = a < 2',
  'A = (1, i); A; s = (x, w); s; B = (re(i), 2); B; n = im(1 + 2i); n; m = clamp(n, 0, 3); k = i^2; k; y = k x',
  'a = i; b = a^2; c = b a; d1 = c + t; a; b; c; d1; p = a + x; p; a x; view(x = -abs(a)..abs(a))',
  'a = i; a1 = (a + 1)^16; a2 = (a1 + 1)^16; a3 = (a2 + 1)^16; a4 = (a3 + 1)^16; a4; a2',
  // Complex paths.
  'exp(i 2 pi u); u + i u^2; abs(exp(i u)); exp(i u) + v; (u, i); cos(u) + i; exp(i 2 pi u) + t; w + u; exp(i u) = 1',
  'a = 2; a exp(2 pi i u); c = e^(i pi/4); c u; sqrt(u - 0.5 + 0 i); (u + i)^3; ln(u + i); {u < 0.5: u, i}; i floor(3u)',
  // Complex values where they have no reading.
  '(1, i); (w, 1); (i, i); (x, y) = (w, 1); (w, w) = (1, 1); (i, 1, 2, 3, 4); (cos(u), i)',
  // Recursive functions: loops.
  'f(n) = {n <= 1: 1, f(n - 1)}; f(5); y = f(x); f(x) < y; f(x) y; (f(2), f(3)); (u, f(4 u))',
  'fact(n, acc) = {n <= 1: acc, fact(n - 1, n acc)}; fact(5, 1); y = fact(floor(x), 1); fact(5); fact((4, 1))',
  'f(n) = n f(n - 1); f(3)',
  'f(n) = {f(n - 1) > 0: 1, 0}; f(1)',
  'f(n) = {n > 0: 1 + f(n - 1), 0}; y = f(x)',
  'g(z, c, k) = {abs(z) > 2: k, k >= 50: k, g(z^2 + c, c, k + 1)}; g(0, w, 0); rgb(g(0, w, 0)/50, 0, 0); y = g(0, x, 0)',
  'g(z, c, k) = {abs(z) > 2: k, k >= 50: k, g(z^2 + c, c, k + 1)}; g(0, 0.3 + 0.5i, 0); g(0, 0.3, 0); g(0, 3, 0) = 1',
  'h(k) = {k >= 600: k, h(k + 1)}; h(0); h2(k) = {6000 < k: k, h2(1 + k)}; h2(0); h3(k) = {k > 2.5: k, h3(k + 2)}; h3(0)',
  'collatz(n, k) = {n <= 1: k, mod(n, 2) < 0.5: collatz(n/2, k + 1), collatz(3n + 1, k + 1)}; collatz(27, 0); collatz(x, 0)',
  'f(a, b) = {a > b: a, f(a + 1)}; f(0, 3)',
  'f(a, b) = {a > b: a, f((a + 1, b))}; f(0, 3); f((0, 3)); f((1, 2, 3))',
  'P = (1, 2); f(a, b, k) = {k > 3: a + b, f((a, b) + P, k + 1)}; f(0, 0, 0); g(a, k) = {k > 3: a, g(P, k)}; g(0, 0)',
  'P = (1, 2); f(a, k) = {k > 3: a, f(a + P, k + 1)}; f(0, 0); g(a) = {a > 3: P, g(a + 1)}; g(0)',
  'f(n) = {n < 1: 0, g(n - 1)}; g(n) = f(n); f(3)',
  'f(n) = {n <= 0: 0, f(n - 1)}; g(n) = {n <= 0: f(n), g(n - 1)}; g(3); h(n) = {n <= 0: 1, h(f(n) - 1)}; h(2)',
  'm(z, k) = {k >= 3: z, m(z^2 + i, k + 1)}; m(0, 0); domain(m(w, 0)); m(w, 0); abs(m(w, 0)) = 1; m(u, 0)',
  'm(z, k) = {k >= 3: z, m(z^2 + i, k + 1)}; a = m(0, 0); a; b = abs(m(1, 0)); b; y = b x; conformal(m(w, 1))',
  'gg(a, b) = {b < 0.5: a, gg(b, mod(a, b))}; gg(12, 18); y = gg(floor(x), 6); a = 2; y = d/dx gg(x, a); gg(t, 1)',
  'f(n) = {n <= 1: 1, f(n - 1)}; g(x) = f(x) + f(2 x); y = g(x); f(f(3)); y = {f(x) > 0: f(x)}; r = f(x) + y; r = 1',
  'f(z) = {abs(z) > 4: z, re(z) > 9: i, f(z^2 + 1)}; f(w); f(i); f(2); s(z) = {z > 1: 1, s(z + i)}; s(0)',
  'f(n) = {n <= 1: 1, f(n - 1)}; f(n) = 2; n = 3; f(n)',
  'f(k) = {k > 3: k}; f(5); f(1); lo(n) = lo(n); lo(1); y = lo(x)',
  // A hand-written gated series is the Fourier loop a reconstruction compiles to.
  'N = 4; y = 1 + {N >= 1: 2 cos(3 x), 0} + {N >= 2: 0.5 sin(6 x), 0} + {N >= 3: cos(9 x) + sin(9 x), 0} + {N >= 4: 0.25 cos(12 x), 0}',
  'N = 4; y = {N >= 1: 2 cos(x), 0} + {N >= 2: sin(2 x), 0} + {N >= 3: cos(3 x), 0} + {N >= 4: cos(4 x), 0}; y = x + {N >= 1: 2 cos(x), 0} + {N >= 2: sin(2 x), 0} + {N >= 3: cos(3 x), 0} + {N >= 4: cos(4 x), 0}',
  // Geometry (lib/geom.ts): figures.
  'A = (0, 0); B = (3, 1); C = (1, 2); segment(A, B); polyline(A, B, C); polygon(A, B, C); vector(A, B); vector(B)',
  'A = (0, 0); B = (3, 1); square(A, B); hull(A, B, (1, 2), (1, 0.5)); line(A, B); circle(A, 2); circle((1, 2), B_x)',
  'segment((0, 0), (1, 1)); segment(0, 0, 1, 1); polygon((0,0), (1,0), (0,1)); polyline(0, 0, 1, 1, 2, 0); vector(1, 2)',
  'a = 2; segment((0, 0), (a, a^2)); polygon((0, 0), (cos(t), sin(t)), (a, 0)); vector((a, 1), (1, a)); hull((0, 0), (a, 0), (0, a))',
  'segment((0, 0)); segment((0, 0), (1, 1), (2, 2)); polygon((0, 0), (1, 1)); polyline((0, 0)); hull((0, 0), (1, 1)); vector()',
  'vector(1, 2, 3); vector((0, 0), (1, 1), (2, 2)); square((0, 0)); line((0, 0)); circle((0, 0)); circle(1); circle((0, 0), (1, 1))',
  'segment((0, 0), (x, 1)); polygon((0, 0), (u, 1), (1, 1)); segment((0, 0), (1, 2, 3)); segment(1, (2, 3)); circle((1, 2, 3), 1)',
  'segment((0, 0, 0), (1, 1, 1)); polygon((0, 0, 0), (1, 0, 0), (0, 1, 0)); vector((1, 2, 3)); hull((0,0,0), (1,0,0), (0,1,0), (0,0,1))',
  'P = (1, 2, 3); Q = (0, 0, 1); segment(P, Q); polyline(P, Q, (0, 0, 0)); square(P, Q); line((0, 0, 0), (1, 1)); vector(P, Q)',
  '1 + segment((0, 0), (1, 1)); y = circle((0, 0), 1); (segment((0, 0), (1, 1)), 1); S = segment((0, 0), (1, 1)); S; c = circle((0, 0), 1); c',
  'A = (1, 2); L = line(A, (0, 0)); L; y = line(A, (0, 0)); line(A, (0, 0)) = 1; f(p, q) = segment(p, q); f(A, (0, 0))',
  // A transformed figure is the figure of the transformed points; a tuple of points is its points.
  'A = (0, 0); B = (3, 1); C = (1, 2); polygon(A, B, C) + (1, 0); 2 segment(A, B); -polygon(A, B, C); segment(A, B)/2; (1, 1) - segment(A, B)',
  'A = (0, 0); B = (3, 1); C = (1, 2); rotate(polygon(A, B, C), t); rotate(hull(A, B, C), 1, C); 2 rotate(segment(A, B), 0.5) + (1, 1); vector(B) + A',
  'A = (0, 0); B = (3, 1); C = (1, 2); segment(A, B) + segment(B, C); segment(A, B)^2; 2/segment(A, B); 1 + segment(A, B); segment(A, B) + 1; vector(A, B) + C',
  'A = (0, 0); B = (3, 1); C = (1, 2); polygon((A, B, C)); polyline(((0, 0), (1, 1), (2, 0))); hull((A, B, C, (2, 2))); polyline((A, B)); polygon((A, 1)); segment((A, B))',
  'A = (0, 0); B = (3, 1); C = (1, 2); S = polygon(A, B, C) + (1, 0); S; T = polygon((A, B, C)); sin(segment(A, B)); rotate(1, segment(A, B)); polygon((A, B)) + (1, 1)',
  'P = (0, 0, 0); Q = (1, 0, 0); R = (0, 1, 0); rotate(polygon(P, Q, R), t); rotate(hull(P, Q, R, (0, 0, 1)), t, (1, 1, 1)); polygon(P, Q, R) + (0, 0, 1); 2 segment(P, Q)',
  // Point functions.
  'A = (1, 2); B = (3, -1); dot(A, B); A · B; cross(A, B); A × B; midpoint(A, B); perp(A); unit(B); |A|; abs(A - B); |(3, 4)|',
  'A = (1, 2); B = (3, -1); distance(A, B); distance(A, (0, 0)); distance((0, 0), (3, 4)); distance(0, 0, 3, 4); angle(A, (0, 0), B); angle(A, B)',
  'A = (1, 2, 2); B = (0, 1, 0); dot(A, B); cross(A, B); |A|; distance(A, B); angle(A, B); angle(A, (0, 0, 0), B); unit(A); midpoint(A, B); perp(A)',
  'A = (1, 2); B = (1, 2, 3); dot(A, B); cross(A); cross(A, B); midpoint(A); perp(A, A); unit(1); dot(1, 2, 3); distance(A); distance(A, B); angle(A)',
  'A = (1, 2); B = (1, 2, 3); angle(A, B); angle(A, A, A, A); dot(A, 1); abs(A, A); abs(1, 2, 3); sin(A); max(A, 1); distance(1, 2, 3)',
  'A = (1, 2); a = 0.5; rotate(A, a); rotate(A, a, (1, 1)); rotate((1, 0), pi/2); rotate(A, t); rotate(A); rotate(A, a, 1); rotate(1, 2, 3, 4, 5, 6)',
  'P = (1, 2, 3); a = 0.5; rotate(P, a); rotate(P, a, (0, 1, 0)); rotate(P, a, (1, 1, 1)); n = (0, a, 1); rotate(P, t, n); rotate(P, a, (0, 0, 0))',
  'A = (1, 2); B = (3, -1); M = midpoint(A, B); M; N = perp(B - A) + M; N; U = unit(B - A); segment(M, N); d = distance(A, B); d; d + 1',
  'A = (1, 2); B = (3, -1); R = rotate(B, t, A); R; segment(A, R); th = angle(B, A, R); th; C = A + 2 unit(B - A); circle(C, |A - B|/2)',
  'A = (1, 2); y = dot((x, y), A); dot((x, y), (x, y)) = 4; distance((x, y), A) < 2; |(x, y) - A| = 1; angle((x, y), A) = 1; y = |A| x',
  's = (x, y); A = (1, 2); dot(s, s) = 1; |s - A| = 2; cross(s, A); perp(s); unit(s); (x, y) · A; distance(s, A) = distance(s, (0, 0))',
  // Points through functions: f(P), p.x of computed points.
  'f(a, b) = a + b; A = (1, 2); B = (3, 4); f(A); f(A + B); f(2 A); f(midpoint(A, B)); f(perp(A)); f(dot(A, B)); f(A, B)',
  'f(a, b) = a b; g(a, b, c) = a + b + c; A = (1, 2); P = (1, 2, 3); f(P); g(A); g(P); g(cross(P, P)); f(1); f(A_x); y = f(A + (x, 0))',
  'h(p) = p.x + p.y; A = (1, 2); B = (3, 4); h(A + B); h(2 A); h(midpoint(A, B)); h(unit(A)); h(3); h(A.x); k(p) = p.z; k(A + B); k((1, 2, 3) + (1, 1, 1))',
  'd(p, q) = |p - q|; m(p, q) = (p + q)/2; A = (1, 2); B = (3, 4); m(A, B); |m(A, B)|; segment(A, m(A, B)); w(p) = (p.y, p.x); w(A + B); w(A)',
  // Labels.
  'A = (1, 2); label(A, "vertex"); label((1, 2), "peak"); label((cos(t), sin(t)), "moving"); label(A + (1, 0), "a \\"b\\""); label((1, 2, 3), "up")',
  'A = (1, 2); label(A); label("a", A); label(A, "a", "b"); label((x, 1), "x"); label(1, "one"); label((u, 1), "u"); c = label(A, "x"); 1 + label(A, "y")',
  // Matrices (lib/mat.ts): definitions, algebra, det, trace, solve, the matvec.
  'M = ((1, 2), (3, 4)); M; det(M); trace(M); M (1, 1); M (x, y); y = det(M) x; solve(M, (1, 2)); solve(M, 1, 2); transpose(M); M^-1; M^2; M M',
  'a = 2; M = ((a, 1), (0, a t)); M; det(M); N = 2 M; N; N (1, 0); M + N; M - N; M N; -M; M/2; a M; M a; M^0; M^3; M^9; M^0.5; M + 1; 1/M; M/M',
  'J = ((0, -1), (1, 0)); a = 0.5; R = e^(a J); R; R (1, 0); e^(t J) (1, 0); exp(a J) (x, y); (e^(a J)) (1, 2); segment((0, 0), R (2, 0)); 2^J; e^J',
  'A = ((1, 2), (0, 1)); e^(t A) (1, 1); e^A; exp(A) (1, 0); B = ((2, 0), (0, 3)); e^(t B) (x, y); S = ((0, 1), (1, 0)); e^S (1, 2)',
  'M = ((1, 2, 3), (0, 1, 4), (5, 6, 0)); M; det(M); trace(M); M (1, 0, 0); solve(M, (1, 2, 3)); M^-1; transpose(M) (1, 1, 1); M (1, 2); M^2 (1, 0, 0)',
  'n = (0, 0, 1); K = cross(n); K; e^(t K) (1, 0, 0); a = 1; e^(a cross((1, 1, 1))) (1, 0, 0); cross((1, 2)); e^(a cross(n)); cross(n) (0, 1, 0); W = ((1, 2, 3), (4, 5, 6), (7, 8, 9)); e^W',
  'A = (1, 2); B = (3, 4); M = (A, B); M; det(M); M (1, 1); (A, B); (A, B) (1, 1); det((A, B)); det(((1, 2), (3, 4))); ((1, 2), (3, 4)) (1, 1); (A, 1)',
  'M = ((1, 2), (3, 4)); M + (1, 1); (1, 1) - M; M + (1, 2, 3); M (1, 2, 3); (1, 2) M; sin(M); M; M < 1; y = M; M = 2; {x > 0: M}; f(v) = M v; f((1, 2))',
  'M = ((1, 2), (3, 4)); det(M, M); det(); det(2); trace(1); solve(M); solve(M, (1, 2, 3)); solve(M, 1); solve(2, (1, 2)); transpose(M) (1, 0); transpose(2); transpose(M, M)',
  'N = M + ((1, 0), (0, 1)); M = ((1, 2), (3, 4)); N; d1 = det(M); d1; d1 + 1; v = M (1, 2); v; w = solve(M, v); w; segment(v, w); T = transpose(M); T',
  'M = ((x, y), (y, -x)); M; M (1, 0); det(M) = 1; streamlines(M); streamlines(((x, 1), (1, y))); a = 2; ((a x, 0), (0, y)); ((1, x), (0, 1)) + ((1, 0), (0, 1))',
  'streamlines(); streamlines(1); streamlines(((1, 2), (3, 4))); 1 + streamlines(((x, y), (y, x))); ((x, y, 0), (0, 1, 0), (0, 0, 1)); ((u, 0), (0, 1)); ((x, z), (0, 1))',
  'M = ((1, 2), (3, 4)); polygon(M); a = 0.3; R = e^(a J); J = ((0, -1), (1, 0)); R polygon((0, 0), (1, 0), (0, 1)); M segment((0, 0), (1, 1)); hull(((0, 0, 0), (1, 0, 0), (0, 1, 0)))',
  'J = ((0, -1), (1, 0)); a = 0.3; R = e^(a J); R polygon((0, 0), (1, 0), (0, 1)); 2 R segment((0, 0), (1, 1)); R (R (1, 0)); R^2 (1, 0); P = R (1, 0); P; f(p, q) = p + q; f(R (1, 0)); f(M)',
  // Tensors (lib/tensor.ts): ⊗, ∧, contract, shapes that are no matrix.
  'a = (1, 2); b = (3, 4); a ⊗ b; outer(a, b); a ∧ b; wedge(a, b); contract(a ⊗ b, 1, 2); T = a ⊗ b; T; T (1, 0); det(T); (a ⊗ b) (1, 1); a ⊗ b ⊗ a',
  'T = ((1, 2, 3), (4, 5, 6)); T; T (1, 0, 0); (1, 2) T; T + T; 2 T; T/2; -T; T T; contract(T, 1, 2); R = ((1, 2, 3, 4), (5, 6, 7, 8)); R; R + T',
  'u = (1, 0, 0); v = (0, 1, 0); w = (0, 0, 1); u ∧ v; u ∧ v ∧ w; V = u ∧ v ∧ w; V; contract(u ⊗ v, 1, 2); outer(u); contract(u ⊗ v); contract(u ⊗ v, 1, 1); contract(u ⊗ v, 1, 5); contract(u, 1, 2)',
  'n = (0.6, 0.8); I = ((1, 0), (0, 1)); H = I - 2 n ⊗ n; H; H (1, 0); det(H); n ⊗ n; (n ⊗ n) n; ((1, 2), (3, 4, 5)); (1, 2, 3, 4) ⊗ (1, 2); a = 2; a ∧ n; n ∧ a',
  '(1, 2, 3, 4); (1, 2, 3, 4, 5, 6, 7, 8, 9, 10); a = 2; (a, a^2, a^3, sqrt(a)); (1, 2, 3, x); (t, 1, 2, 3); ((1, 2, 3, 4), (5, 6, 7, 8)); ((1, 2), (3, 4), (5, 6))',
  // What geometry leaves alone: multivectors, projective geometry.
  'A = (1, 2); B = (3, 4); (A, B); cross((0, 0, 1)); det(((1, 2), (3, 4))); ((1, 2), (3, 4)) (1, 1); join(A, B); meet(line(A, B), line(A, (0, 0)))',
  'A = (1, 2); rotate(A, quat(1, 0, 0, 0)); gp(A, A); A ⟑ A; distance(A, line(A, (0, 0))); outer(A, A); A ∧ A; transpose(((1, 2), (3, 4)))',
  // In space: surfaces, clouds, curves and tubes, points, fields, intersections and systems.
  'z = sin(x) cos(y); x^2 + y^2 + z^2 = 9; a = 2; z = a x y; x y z = 1; z^2 = x^2 + y^2; f(x, y) = x^2 - y^2; z = f(x, y)',
  'z = z; x + z = z + x; z = x^2 + z; x = z; z = {x > 0: x, y}; z = abs(x) + floor(y); z = gamma(x); z < x; z; z + 1 > 0',
  'r = sqrt(x^2 + y^2 + z^2); r = 2; r; 1/r; e^(-r^2); rho = sqrt(x^2 + y^2); z = rho; z = sin(rho - t)',
  'x y z; sin(x) + z; a = 2; a z - x^2; z t; mod(z, 2); x^2 + y^2 + z^2 - 1; z = d/dx (x^2 y); d/dz (z^2 x)',
  '(cos(2 pi u), sin(2 pi u), u); a = 3; (a u, u^2, t u); (u, u, floor(4 u)); (u, 0, gamma(u)); (u, 1, x); (v, v, v)',
  '(u, v, u v); (cos(2 pi u) sin(pi v), sin(2 pi u) sin(pi v), cos(pi v)); a = 2; (a u, v, sin(t + u)); (u, v, mod(u, 0.3))',
  '(u, v, x); (u, v); (u v, 1, 2); (u, v, floor(3 u) + gamma(v)); (u, v, {u > v: 1, 0}); (v, 1, 2)',
  'tube((cos(2 pi u), sin(2 pi u), u)); tube(cos(u), sin(u), u/4, 0.3); a = 0.2; tube((u, u^2, u^3), a); tube((u, u, u), a t)',
  'tube((1, 2, 3)); tube((u, u)); tube((u, u, u), -1); tube((u, u, u), x); tube((u, v, u)); tube(u, u, u, (1, 2)); tube()',
  'C = (cos(u), sin(u), u); C; tube(C); 2 C; C + (0, 0, 1); 1 + tube((u, u, u)); tube(tube(u, u, u), 1, 2); y = tube(u, u, u)',
  'revolve(sqrt(x)); revolve(y^2, y); revolve(sin(z) + 2, z); f(x) = x^2 + 1; revolve(f); revolve(f, y); revolve(2 f)',
  'revolve(z, x); revolve(x, w); revolve(); revolve((1, 2)); revolve(x = 1); 1 + revolve(x); a = 2; revolve(a x); g(x, y) = x y',
  'revolve(g); revolve(u); revolve(x, 2); revolve(sin(x) + t); h = revolve(x); y = revolve(x)',
  '(1, 2, 3); a = 1; (a, t, a + t); A = (1, 2, 3); A; B = 2 A + (0, 0, 1); B; A - B; (A_x, A_y, A_z + 1); A_z; z = A_z',
  'A = (1, 2, 3); B = (1, 2); A + B; A B; (A, 1); f(p) = p.x + p.z; f(A); g(a, b, c) = a b c; g(A); g(B)',
  '(y, -x, z); (x, y, z); (0, 0, 1) + (x, 0, 0); a = 2; (a y, sin(t) x, z); (x, y, gamma(z)); (z, x); (x, y, u)',
  "(x', y', z') = (y, -x, 1); (x', y', z') = (10 (y - x), x (28 - z) - y, x y - 8/3 z); (x', y', z') = (1, 2); (x', y', z') = 3",
  '(x^2 + y^2 + z^2, z) = (4, 1); (x + y + z, x - y) = (1, 0); a = 1; (x y, z) = (a, t); (atan2(y, x), z) = (1, 0)',
  '(x + y + z, x - y, z) = (1, 0, 2); (x^2 + y^2 + z^2, x - y, z) = (4, 0, 1); (x, y z) = (1, 2, 3); (x + z, y) = 1',
  '(x + y + z) = (1); (x + z, y, 1) = (1, 2); (atan2(y, x), x^2 + y^2, z) = (1, 4, 0); (x + y, x - y) = (1, 0); (x + u, y) = (1, 2)',
  '(x + u, y, z) = (1, 2, 3); (x - cos(2 pi u), y - sin(2 pi u), z - u) = (0, 0, 0); (x + z, y + z, x) = (u, v, 1)',
  'z = x^2 + y^2; y = x; (1, 2); (cos(u), sin(u)); x^2 + y^2 < 1; x y; (y, -x); 1 + 1; camera(0.5, 0.3, 9); grid(off)',
  'camera(-pi/3, 0.5, 9); z = x y; ---; y = x; camera(1, 1); ---; (1, 2, 3); view(x = -1..1)',
  // Three coordinates named on the left: a position in space, or the curve it traces.
  'rho = sqrt(x^2 + y^2 + z^2); theta = atan2(y, x); phi = acos(z/rho); (rho, theta, phi) = (2, pi/4, pi/3); (rho, theta, phi) = (2, 12 pi u, pi u)',
  'r = sqrt(x^2 + y^2); theta = atan2(y, x); (r, theta, z) = (2.5, 6 pi u, 6 u - 3); (r, theta, z) = (1, 2); (r, r, z) = (1, 2, 3); (r, theta, z) = 2',
  "(x, y, z) = (1, 2, 3); (z, y, x) = (u, u, u); a = 1; (x, y, z) = (a, t, 0); (x, y, z) = (u, v, 1); r = sqrt(x^2 + y^2); (r', theta', z') = (0, 1, 0.5)",
  // A surface coloured by its curvature, and curvature read at a point of it.
  'S = (u, v, u^2 - v^2); gaussian(S); meancurvature(S); gaussian(S, 0.5, 0.25); gaussian(S, (0.5, 0.25)); 2 gaussian(S)',
  'a = 2; S = (cos(2 pi u) sin(pi v), sin(2 pi u) sin(pi v), a cos(pi v) + t); gaussian(S); meancurvature(S, 0.3, a)',
  'f(a, b) = (a, b, a b); gaussian(f); gaussian(f, 1, 2); g(a) = a; gaussian(g); P = (1, 2); gaussian(P); gaussian(f, P)',
  'S = (u, v, u v); gaussian(1, 2); gaussian(S, 1); gaussian((u, u, u)); gaussian(T); gaussian((u, v, x)); gaussian((1, 2))',
  'gaussian((u, v, u v)); gaussian((u, v, u v), 0, 0); S = (u, v, floor(u) v); gaussian(S); gaussian(S, 1, 2, 3); gaussian(S, 1, 2, 3, 4)',
  'k = u v; S = (u, v, k); gaussian(S); C = (u, u, u); gaussian(C); A = (1, 2, 3); meancurvature(A); gaussian(x) = x; gaussian(2)',
  // Random variables: declarations of every family, their aliases and defaults.
  'X ~ Normal(0, 1); Y ~ N; Z ~ normal(1, 2); U ~ Uniform(0, 2); V ~ U; W ~ Exponential(2); Q ~ Exp; R ~ exp',
  'A ~ Gamma(2, 1); B ~ Beta(2, 3); C ~ ChiSquared(3); D ~ ChiSq(2); F ~ Chi2(4); G ~ StudentT(3); H ~ T(5)',
  'A ~ LogNormal(0, 0.5); B ~ LogNormal; C ~ Cauchy(0, 1); D ~ Cauchy; F ~ Weibull(2, 1); G ~ Weibull(0.5, 2)',
  'A ~ Binomial(10, 0.3); B ~ Binom(4, 1); C ~ Poisson(4); D ~ Pois(0.5); F ~ Geometric(0.25); G ~ Geom(1)',
  'A ~ NegativeBinomial(3, 0.5); B ~ NegBin(1.5, 0.2); C ~ Bernoulli(0.3); D ~ DiscreteUniform(1, 6); F ~ Bernoulli(1)',
  // What a declaration refuses.
  'X ~ Foo(1); X2 ~ Normal(0, 1, 2); X3 ~ Normal(0); X4 ~ Gamma; X5 ~ Normal(0, -1); X6 ~ Uniform(2, 1); X7 ~ 3',
  'X ~ Binomial(2.5, 0.5); X2 ~ Binomial(-1, 0.5); X3 ~ Binomial(3, 1.5); X4 ~ Geometric(0); X5 ~ Poisson(0)',
  'X ~ DiscreteUniform(1.5, 3); X2 ~ DiscreteUniform(3, 1); X3 ~ Normal(); X4 ~ Normal(0, 1) + 2; X5 ~ Normal(1,; X6 ~',
  'x ~ Normal(0, 1); e ~ Normal(0, 1); sin ~ Normal(0, 1); gamma ~ Normal(0, 1); X ~ Normal(0, 1); X ~ Uniform(0, 1)',
  'a = 2; a ~ Normal(0, 1); f(x) = x; f ~ Normal(0, 1); X ~ Normal(Y, 1); Y ~ Normal(0, 1); Z ~ Normal(x, 1)',
  'X ~ Normal(q, 1); Y ~ Normal(0, (1, 2)); Z ~ Normal(i, 1); W ~ Normal(0, 1) # the bell',
  // Parameters that are sliders, and ones that move.
  'a = 1; b = 0.5; X ~ Normal(0, a); P(X < b); E(X); X + b; 2 X',
  'a = -1; X ~ Gamma(a, 1); E(X); P(X > 1); G ~ Normal(0, a); E(G); P(G < 1); U ~ Uniform(1, a); E(U); P(U < 2)',
  'a = -1; N ~ Poisson(a); E(N); P(N < 2); B ~ Binomial(2.5 + 0 a, 0.5); E(B); W ~ Weibull(a, 1); E(W)',
  'X ~ Normal(0, sin(t)); E(X); P(X < 1); a = 2 t; Y ~ Normal(a, 1); E(Y); P(Y > a); Z ~ Poisson(1 + t); E(Z); P(Z < 2)',
  'n = 20; p = 0.3; X ~ Binomial(n, p); P(X <= 4); E(X); m = 4; Y ~ Poisson(m); k = 3; Z ~ DiscreteUniform(1, k)',
  'n = 0.1 30; X ~ Binomial(n, 0.5); E(X); P(X < n); P(X <= n)',
  // Derived variables with a closed law.
  'X ~ Normal(0, 1); Y ~ Normal(1, 2); Z = 2 X + 1; W = X + Y; V = X - Y; S = X + X; R = -X; Q = X/2; T = 3; T2 = Z + 1',
  'X ~ Normal(0, 1); Y = X^2; Y2 = X X; Y3 = X^2 + 1; C ~ Normal(1, 1); Y4 = C^2; P(Y < 1); E(Y); P(0.5 < Y < 2)',
  'U ~ Uniform(0, 1); A = 2 U + 1; B = -U; a = 3; C = a U; P(A < 2); E(A); E(B); P(C > 1)',
  'X ~ Exponential(2); A = 3 X; B = X + 1; C = -X; a = 2; D = a X; E(A); P(A > 1)',
  'L ~ LogNormal(0, 1); A = 2 L; B = L + 1; E(A); P(A < 3); C1 ~ Cauchy(0, 1); C2 ~ Cauchy(1, 2); D = C1 - 2 C2; E(D); P(D > 0)',
  'a = 2; b = 1; X ~ Gamma(a, b); Y ~ Exponential(b); S = X + Y; P(X > 4); E(S); P(S < 3); K ~ ChiSquared(3); K + K',
  'G1 ~ Gamma(2, 1); G2 ~ Gamma(3, 2); G1 + G2; G1 + 2 G2; X1 ~ Exponential(1); X2 ~ Exponential(1); X1 + X2; E(X1 + X2)',
  'A ~ Poisson(2); B ~ Poisson(3); S = A + B; P(S <= 4); E(S); P(S = 5); P(S != 5); P(2 <= S < 6); S2 = A + A',
  'A ~ Binomial(3, 0.5); B ~ Bernoulli(0.5); C ~ Binomial(4, 0.2); S = A + B; S; T = A + C; E(S); P(S >= 2)',
  'A ~ NegativeBinomial(2, 0.5); B ~ NegativeBinomial(1.5, 0.5); S = A + B; E(S); P(S > 3); G ~ Geometric(0.5); G + G',
  // Sums of uniforms: an exact piecewise polynomial.
  'X ~ Uniform(0, 1); Y ~ Uniform(0, 1); X + Y; S = X + Y; P(S > 1.5); E(S); P(0.5 < S < 1); P(X + Y < 0.5); E(X - Y)',
  'X1 ~ Uniform(0, 1); X2 ~ Uniform(0, 1); X3 ~ Uniform(0, 1); X4 ~ Uniform(0, 1); S = X1 + X2 + X3 + X4; P(S > 3); E(S)',
  'a = 2; X ~ Uniform(0, a); Y ~ Uniform(-1, 1); S = 2 X - Y + 1; P(S < 2); E(S); T = a X + Y; E(T); P(T > 1)',
  // Probabilities: bounds, chains, strictness, what P refuses.
  'X ~ Normal(0, 1); P(X > 1); P(1 < X); P(X < -1); P(-1 < X < 2); P(2 > X > -1); P(-1 <= X <= 2); P(X < 1 < 2)',
  'X ~ Normal(0, 1); P(X); P(X + 1); P(X = 1); P(1 > 0); P(x < X); P(X < y); P(0 < X > 1); P((X, 1) < 2); P()',
  'X ~ Normal(0, 1); P(2 X + 1 < 3); P(0 < X^2 < 1); P(-X > 1); P(X < q); P(1 < 2 < X); P(X < 1, X > 0)',
  'D ~ DiscreteUniform(1, 6); P(2 < D <= 5); E(D); P(D = 3); P(D < 3); P(D <= 3); P(D > 6); P(D >= 1); P(D < 2.5); P(3 = D)',
  'X ~ Poisson(4); P(X < 3); P(X <= 3); P(X = 3); P(X = 2.5); P(X > 100); P(3 < X < 4); P(X >= 0)',
  'p = 0.25; G ~ Geometric(p); W ~ NegativeBinomial(3, p); P(G > 4); E(G); E(W); P(W <= 2); P(G = 1); B ~ Binomial(1000, 0.3); P(B < 300)',
  'X ~ Beta(0.5, 0.5); P(X < 0.2); E(X); T ~ T(2); P(T > 2); E(T); T1 ~ T(1); E(T1); T3 ~ T(3); E(T3); P(-1 < T3 < 1)',
  'X ~ LogNormal(0, 0.5); Y ~ Weibull(2, 1); P(X > 2); P(Y < 1); E(X); E(Y); C ~ ChiSquared(3); P(C > 7.81); E(C)',
  'X ~ Gamma(50, 2); P(X > 30); E(X); Y ~ Beta(30, 40); P(Y < 0.4); Z ~ T(2000000); P(Z > 1.96); G ~ Gamma(2000000, 1); P(G < 2000000)',
  // Expectations.
  'X ~ Normal(1, 2); E(X); E(2 X + 1); E(X + X); E(x); E(X < 1); E((X, 1)); E(1); E(); E(X + q); U ~ Uniform(0, 4); E(U)',
  'C ~ Cauchy(0, 1); E(C); E(2 C + 1); W ~ Weibull(0.01, 1); E(W); L ~ LogNormal(0, 30); E(L)',
  // The names P and E when the document defines them.
  'P = 2; X ~ Normal(0, 1); P(X > 1); E(x) = x^2; E(X); E(3)',
  'P(x) = x + 1; P(2); X ~ Normal(0, 1); P(X > 1); E = (1, 2); E(X)',
  // Derived rows, cycles and failures.
  'Y = X + 1; X ~ Normal(0, 1); Z = Y + W; W = Z; V = Q + 1; Q ~ Foo; A = X + nope; B = (X, 1); C = X < 1',
  'X ~ Normal(0, 1); Y = X; Y = 2 X; e = X; t = X; f(x) = X + x; y = X; X = 3; 2X; X2; X_1 = X',
  'X ~ Normal(0, 1); X < 1; X + x; X + u; (X, 1); y = X x; X; -X; X + 1; X - X; 0 X',
  // What the port does not answer yet: quadrature, enumeration, samples.
  'X ~ Normal(0, 1); Y = sin(X); Y; P(Y > 0); E(Y); P(X > Y); Z = {X > 0: X^2, 1}; E(X^2); X Y; E(X^3)',
  'D ~ DiscreteUniform(1, 6); F ~ DiscreteUniform(1, 6); S = D + F; P(S >= 10); P(D > F); E(S); D / 2; D^2; E(D^2); P(D^2 <= 9)',
  'N ~ Poisson(3); Z ~ Normal(0, 0.25); Y = N + Z; P(Y < 2.5); E(Y); U ~ Uniform(0, 1); V = U^2; E(V); E(U + V)',
  // Arithmetic on discrete variables: atoms enumerated over the joint of the bases.
  'D ~ DiscreteUniform(1, 6); F ~ DiscreteUniform(1, 6); S = D + F; S - D; D - D; D F; D/F; D^F; -D; abs(D - F); max(D, F)',
  'D ~ DiscreteUniform(1, 6); F ~ DiscreteUniform(1, 6); min(D, F) + 1; {D > F: D, F}; mod(D, 2); D + F + D; {D > 3: 1}; D + 0.5',
  'D ~ DiscreteUniform(1, 6); F ~ DiscreteUniform(1, 6); P(D > F); P(D >= F); P(D = F); P(D != F); P(D + F = 7); P(D + F > 9)',
  'D ~ DiscreteUniform(1, 6); F ~ DiscreteUniform(1, 6); P(2 < D + F <= 5); P(D < F < 5); P(D F > 10); E(D F); E(D/F); P(D - D = 0)',
  'D ~ DiscreteUniform(1, 6); E(1/(D - 3)); 1/(D - 3); P(1/(D - 3) > 0); sqrt(D - 3); E(sqrt(D - 3)); P(D^2 <= 9); P(D^2 != 9); P(3 < D^2)',
  'X ~ Poisson(4); Y ~ Geometric(0.25); X Y; X^2; 2^Y; E(2^Y); E(X^2); P(X^2 < 10); P(X > Y); E(1.5^Y); 1/X; E(1/X); P(1/X > 0.3)',
  'N ~ Binomial(5, 0.5); 0.1 N; 0.1 N + 0.2 N; P(0.1 N + 0.2 N = 0.3); P(0.1 N + 0.2 N <= 0.3); P(0.1 N < 0.3); N/3; (N/3) 3; sin(N)',
  'a = 2; D ~ DiscreteUniform(1, 6); T = a D + 1; P(T > 5); E(T); S = D + t; E(S); B ~ Binomial(3, a/4); B^2; E(B^2); P(B^2 = 4)',
  'D0 ~ DiscreteUniform(1, 6); D1 ~ DiscreteUniform(1, 6); D2 ~ DiscreteUniform(1, 6); D3 ~ DiscreteUniform(1, 6); ' +
    'D4 ~ DiscreteUniform(1, 6); T = D0 + D1 + D2 + D3 + D4; T + D0; P(T > 20); E(T D0); P(T > 3 D0); T^2; W = T - D1; P(W = T)',
  'X ~ Poisson(1000000); X^2; E(X^2); Y ~ Geometric(0.000001); P(X > Y); Y + Y; A ~ Poisson(300); B ~ Poisson(300); A B; P(A < B)',
  'G ~ Geometric(0.5); 3^G; E(3^G); 1.9^G; E(1.9^G); 1.3^G; E(1.3^G); G^2; H ~ NegativeBinomial(2.5, 0.3); H/2; P(H/2 <= 1.5)',
  // u and v alone: the density of the row's values.
  'u; 2 u + 1; u + v; u - v; a = 2; a u; u^2; u v; (u, v); u + x; u < 0.5; sin(u); 1 - u; u + u; u/2 + v/2 + 1',
  // Fits, which need lists.
  'P = [(0, 1), (1, 3), (2, 5)]; P.y ~ m P.x + b; y = m x + b; y = x',
  'Y = [1, 2, 3]; X = [0, 1, 2]; Y ~ a X + c; Y ~ exp(a X); Y ~ exp; Y ~ gamma; Y ~ Normal(0, 1); y = 2 x; 2 ~ 3',
];

/** Small documents written at random from the ported core's own words, so
 *  what no example happens to say is still compared: definitions that reach
 *  one another (or fail to), then rows of every shape over them. Seeded, so
 *  the corpus is the same every run. */
function randomDocs(count: number): string[] {
  let seed = 0x2f6e2b1;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const FNS = [
    'sin',
    'cos',
    'tan',
    'sqrt',
    'abs',
    'exp',
    'ln',
    'floor',
    'sign',
    'atan',
    'sinh',
    'erf',
    'sinc',
    'round',
  ];
  // (`calls`: the document's functions the expression may call; a body calls
  // its own only now and then, since a recursive one is not ported.)
  const expr = (atoms: readonly string[], depth: number, calls = 'fg'): string => {
    if (depth <= 0 || random() < 0.25) return pick(atoms);
    const a = () => expr(atoms, depth - 1, calls);
    switch (Math.floor(random() * 14)) {
      case 0:
        return `${a()} + ${a()}`;
      case 1:
        return `${a()} - ${a()}`;
      case 2:
        return `${a()} ${a()}`;
      case 3:
        return `(${a()})/(${a()})`;
      case 4:
        return `(${a()})^${pick(['2', '3', '0.5', '(1/3)', '-1', 'a', '9'])}`;
      case 5:
        return `-${a()}`;
      case 6:
        return `${pick(FNS)}(${a()})`;
      case 7:
        return `(${a()})`;
      case 8:
        return `${pick(['min', 'max', 'mod', 'atan2'])}(${a()}, ${a()})`;
      case 9:
        return `{${a()} ${pick(['<', '>', '<=', '>='])} ${a()}: ${a()}, ${a()}}`;
      case 10:
        return calls.includes('f') ? `f(${a()})` : a();
      case 11:
        return calls.includes('g') ? `g(${a()}, ${a()})` : a();
      case 12:
        return `d/dx (${a()})`;
      default:
        return `clamp(${a()}, 0, 1)`;
    }
  };
  const NUMS = ['0', '1', '2', '3', '0.5', '-1', '10', 'pi', 'e'];
  const EDGES = [
    'L = [1, 2, 3]',
    'y = L x',
    'b = [a, 2]',
    'sum(n=1..3, x^n)',
    'y = sum(n=1..a, n x)',
    'w^2',
    'i a',
    '(1, 2, 3)',
    'z = x y',
    'X ~ Normal(0, 1)',
    'a ~ b x + c',
    'a_n = n a',
    'b_k = 3',
    "p' = -p",
    "a' = b",
    'a(0) = 1',
    'view(x = -a..a)',
    'view(y = -1..b, ratio = 2)',
    '---',
    '--- right',
    'grid(off)',
    'e_x',
    'y = e_y x',
    'total = 2',
    'gamma = 3',
    'mean(x)',
    'min(a)',
    'max(b)',
    'count(c)',
    'f(A)',
    'g(A)',
    'g((1, 2))',
    'A.x',
    'A.y + r',
    'c[1]',
    'A[1]',
    '{a = 2: 1, 0}',
    '{b = c: x, y}',
    'd/da (a x)',
    'y = d/dt sin(t x)',
    'y = d^2/dx^2 f(x)',
    'dy/dx = y a',
    "x' = y",
    "(x', y') = (y, -a x)",
    'N = 3',
    'y = N x',
    'c = interval(0, 1)',
    'b ∈ [1, 2]',
    'abs(A)',
    'A · A',
    'A × (1, 0)',
    'dot(A, A)',
    'segment(A, (0, 0))',
    'P(a > 1)',
    'E(a)',
    'u',
    'u a',
    'v + x',
    'a = x',
    'b = y a',
    'f(x) = x',
    'g = 2',
    'r(x) = x',
    'A = 3',
    'A_x = 1',
    'y = A_z',
    't = a',
    'e = a',
    'd = 2',
    'x = a',
    'y = b',
    'x = y',
    '# note',
    'y = x # a',
    'a = 3 #f00',
    '',
    'y =',
    'sin(',
    'y = )',
    'a = ',
    '1 +',
    'c = clamp(a, 0)',
    'y = sin(x, y)',
    'y = atan(y, x)',
    'log2(a)',
    'a!',
    'x!',
    '2^3!',
    'r_0 = 1',
    'q = {a > 0: b}',
    'within = a > 0',
    'within = x > a',
    '{within: 1, 0}',
    'y = {c > 0: x}',
    'inf',
    'y = inf',
    'int[0..1] x dx',
    'domain(a w)',
    'conformal(w^2 + b)',
    'iter(z^2 + w)',
    'iter(z^2 + a)',
    'rgb(x, a, b)',
    'hsl(arg(w), 1, c)',
    'exp(i a u)',
    'i^2 = -1',
    're(w^2) = a',
    'abs(w - a) < b',
    'a + b i',
    'f(w)',
    'g(w, i)',
    'c = a i',
    'r = w + a',
    'domain(f(w))',
    'rgb(f(x), g(x, y), 0)',
    'q(n) = {n > a: n, q(n + 1)}',
    'q(x)',
    'y = q(b)',
  ];
  const out: string[] = [];
  for (let k = 0; k < count; k++) {
    const consts = [...NUMS, 'a', 'b', pick(['c', 'q', 't'])];
    const plane = [...NUMS, 'x', 'y', 'x', 'y', 'a', 'b', 'c', 't', pick(['r', 'A_x', 'A_y', 'q', 'z', 'u'])];
    const defs = [
      `a = ${pick(['2', '0.5', '-3', 'clamp(1, 0, 5)', 'round(4)', expr(consts, 1)])}`,
      `b = ${expr(consts, 2)}`,
      `c = ${expr(consts, 2)}`,
      `f(s) = ${expr([...NUMS, 's', 's', 'a', pick(['x', 'b', 't'])], 2, random() < 0.1 ? 'fg' : 'g')}`,
      `g(m, n) = ${expr([...NUMS, 'm', 'n', 'a'], 2, random() < 0.1 ? 'f' : '')}`,
      `r = ${expr([...NUMS, 'x', 'y', 'a'], 2)}`,
      `A = (${expr(consts, 1)}, ${expr(consts, 1)})`,
    ].filter(() => random() < 0.75);
    const rows = Array.from({ length: 4 }, () => {
      const e = () => expr(plane, 2);
      switch (Math.floor(random() * 9)) {
        case 0:
          return `y = ${e()}`;
        case 1:
          return `${e()} = ${e()}`;
        case 2:
          return `${e()} ${pick(['<', '>', '<=', '>='])} ${e()}`;
        case 3:
          return `${e()} < ${e()} < ${e()}`;
        case 4:
          return e();
        case 5:
          return `(${e()}, ${e()})`;
        case 6:
          return expr(consts, 3);
        case 7:
          return `${expr(consts, 2)} ${pick(['=', '<', '>'])} ${expr(consts, 2)}`;
        default:
          return pick([
            'A',
            'A + (1, 1)',
            'r = 1',
            'r < a',
            "y' = " + e(),
            'r',
            '2 A',
            'b',
            'c + a',
            `(${expr([...NUMS, 'u', 'u', 'a', 't'], 2)}, ${expr([...NUMS, 'u', 'u', 'b'], 2)})`,
          ]);
      }
    });
    // Now and then, a row from outside the ported core, or at its edge: the
    // rows around it must come out the same, or say they are not supported.
    while (random() < 0.3) rows.splice(Math.floor(random() * rows.length), 0, pick(EDGES));
    // Definitions above the rows, below them, or among them.
    const order = random();
    out.push(
      (order < 0.5 ? [...defs, ...rows] : order < 0.75 ? [...rows, ...defs] : [...defs].reverse().concat(rows)).join(
        '; ',
      ),
    );
  }
  return out;
}

/** Small documents written at random from lists: a few lists and points
 *  defined, then rows that combine, reduce, index and draw them. Seeded, and
 *  apart from randomDocs so each corpus stays the one it was. */
function randomListDocs(count: number): string[] {
  // (RANDOM_LIST_SEED and RANDOM_LIST_DOCS widen the search when hunting for a difference.)
  let seed = Number(process.env.RANDOM_LIST_SEED ?? 0x51ed27);
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const NUM = ['1', '2', '3', '0.5', '-1', 'a', 'n', 't', '10'];
  const list = (): string =>
    pick([
      '[1, 2, 3]',
      '[1..4]',
      '[0, 0.5..2]',
      'L',
      'L',
      'M',
      'M',
      'T',
      '[a, 2]',
      '[1..n]',
      'L[L > 1]',
      'sort(M)',
      '2 L',
      'L + 1',
      'P.x',
      'P.y',
      '[t, 1]',
      '[3, 1, 2]',
      '[]',
      'L[2..3]',
      'M^2',
      '-L',
      'sin(L)',
      '[L, 5]',
      'p',
      'q',
    ]);
  const scalar = (): string =>
    pick([
      ...NUM,
      'mean(' + list() + ')',
      'total(' + list() + ')',
      'count(' + list() + ')',
      'max(' + list() + ')',
      'min(' + list() + ')',
      'median(' + list() + ')',
      'stdev(' + list() + ')',
      'T[1]',
      'T[n]',
      'sort(L)[2]',
      'L[1]',
      'A_x',
      'f(2)',
      'avg(' + list() + ')',
    ]);
  const value = (): string => (random() < 0.5 ? list() : scalar());
  const op = (): string => pick(['+', '-', '', '/', '^']);
  const row = (): string => {
    switch (Math.floor(random() * 17)) {
      case 0:
        return list();
      case 1:
        return `${value()} ${op()} ${value()}`;
      case 2:
        return `(${value()}, ${value()})`;
      case 3:
        return `y = ${value()} x ${pick(['+', '-'])} ${value()}`;
      case 4:
        return scalar();
      case 5:
        return `${list()}[${pick(['1', '2', 'n', '0', '9', 'L > 1', 'M < 3', 'L == 2', '1..2', '[1, 2]', 't', '1.5'])}]`;
      case 6:
        return `${pick(['sort', 'hist', 'mean', 'total', 'count', 'f', 'g', 'avg', 'abs', 'floor'])}(${value()})`;
      case 7:
        return `{${list()} ${pick(['<', '>', '<=', '='])} ${scalar()}: ${value()}${pick(['', ', 0', ', ' + list()])}}`;
      case 8:
        return `${list()} ${pick(['<', '>', '==', '!=', '<='])} ${value()}`;
      case 9:
        return pick([
          'P',
          'P + (1, 0)',
          '2 P',
          'g(P)',
          'P[1]',
          'P[P.x > 0]',
          'sort(P, P.x)',
          'mean(P)',
          '(P.x, P.y^2)',
          '[A, (0, 0)]',
          'count(P)',
          'P - A',
          '(p, q)',
          '(p, p)',
          '(L, p)',
        ]);
      case 10:
        return `(${value()}, ${value()}, ${value()}${pick(['', ', ' + value()])})`;
      case 11:
        return `${pick(['y', 'x', 'x^2 + y^2', 'y - x'])} ${pick(['=', '<', '>'])} ${value()}`;
      case 12:
        return `hist(${list()}${pick(['', ', 3', ', n', ', 1'])})${pick(['', '/2', ''])}`;
      case 13:
        return `(${value()} u, ${pick(['u', 'u^2', value()])})`;
      case 14:
        return `sort(${list()}${pick(['', ', ' + list()])})${pick(['', '[1]', '[n]'])}`;
      case 15:
        // Lists beside the kinds around them: sums, figures, matrices, complex numbers.
        return pick([
          'sum(k=1..n, L k)',
          'sum(k=1..3, [k, 1])',
          'y = sum(k=1..M, x^k)',
          'sum(k=1..L, k)',
          'prod(k=1..2, L + k)',
          'segment(A, P)',
          'polygon(P)',
          'polyline(sort(P, P.x))',
          'hull(P)',
          'circle(A, L)',
          'segment((0, 0), (L, 1))',
          'vector(P)',
          'polyline(P)',
          'distance(P, A)',
          'dot(P, A)',
          'midpoint(P, A)',
          'abs(P - A)',
          'R P',
          'R A',
          'hull(R P)',
          'R L',
          'R[1]',
          'L i',
          '[i, 1]',
          'e^(i L)',
          'abs(e^(i L))',
          'sort([i, 1])',
          '(L, L, 1)',
          'polygon(P + (1, 0))',
          '2 hull(P)',
          'rotate(hull(P), L)',
          'circle((p, 0), 1)',
          'segment(A, (p, q))',
          'polyline((L, L^2))',
          'polygon(sort(P, P.y)) + (1, 1)',
          'count(R)',
          'T (1, 0)',
          'R T',
          'label(A, "a")',
          // …and space, states, random variables, sequences, integrals and derivatives.
          'z = L x',
          'x^2 + y^2 + z^2 = L',
          '(u, L u, v)',
          '(cos(u), sin(u), L)',
          'trail((p, t))',
          'trail(P)',
          'X0 ~ Normal(L, 1)',
          'P(X0 > L)',
          'E(L)',
          'a_n = L[n]',
          'b_n = total(L) n',
          "s' = L",
          's(0) = L',
          'int[0..1] L x dx',
          'int[0..L] x dx',
          'y = d/dx (L x)',
          'y = d/dx (x^L)',
          'L x y z',
          '(x, L y)',
          '(L y, -x)',
          'tube((cos(u), sin(u), L))',
          'L x y',
          'mean(X0)',
          'y = L normalpdf(x, 0, 1)',
          "y' = L y",
          '(L, 2, 3)',
          '[(1, 2, 3), (0, 0, p)]',
          'P + (0, 0, 1)',
          'z = p',
          'segment((0, 0, 0), (L, 1, 1))',
        ]);
      default:
        return `${pick(['f', 'g', 'avg'])}(${value()}${pick(['', ', ' + value()])})`;
    }
  };
  const out: string[] = [];
  for (let k = 0; k < count; k++) {
    const defs = [
      `a = ${pick(['2', '0.5', '3'])}`,
      `n = ${pick(['2', '3', 'round(2)', '1'])}`,
      `L = ${pick(['[1, 2, 3]', '[1..4]', '[3, 1, 2]', '[a, 1, 2]', '[1..n]'])}`,
      `M = ${pick(['[1, 2]', 'L^2', '[2, 3, 4]', 'L[L > 1]', '2 L', '[t, 1]'])}`,
      `T = ${pick(['sort(L)', '(1, 2, 3, 4)', 'sort([2, 1])', '(3, 1, 2)'])}`,
      `P = ${pick(['[(0, 0), (1, 2)]', '(L, L^2)', '[(1, 1), (2, 3), (0, 1)]', '[A, (2, 2)]'])}`,
      'A = (1, 2)',
      `f(s) = ${pick(['s^2', '(s, s + 1)', 'mean(s)', 's + total(L)', '[s, 2 s]', 'L s'])}`,
      `g(u1, v1) = ${pick(['u1 + v1', '(v1, u1)', 'u1 total(v1)'])}`,
      'avg(s) = mean(s)',
      'R = ((0, -1), (1, 0))',
      'X0 ~ Normal(0, 1)',
      `p ∈ ${pick(['[1, 2]', 'L', '[0, 1, 2]'])}`,
      `q ∈ ${pick(['[1, 2]', 'L', 'M'])}`,
    ].filter(() => random() < 0.8);
    const rows = Array.from({ length: 5 }, row);
    out.push((random() < 0.8 ? [...defs, ...rows] : [...rows, ...defs]).join('; '));
  }
  return out;
}

interface Doc {
  name: string;
  rows: string[];
}

const docs: Doc[] = [];
for (const [category, items] of EXAMPLES)
  for (const [label, text] of items) docs.push({ name: `${category} / ${label}`, rows: splitStatements(text) });
CASES.forEach((text, k) => docs.push({ name: `case ${k + 1}`, rows: splitStatements(text) }));
DISCRETE_CASES.forEach((text, k) => docs.push({ name: `case discrete ${k + 1}`, rows: splitStatements(text) }));
FITS_CASES.forEach((text, k) => docs.push({ name: `case fits ${k + 1}`, rows: splitStatements(text) }));
ALGEBRA_CASES.forEach((text, k) => docs.push({ name: `case algebra ${k + 1}`, rows: splitStatements(text) }));
INTEGRAL_CASES.forEach((text, k) => docs.push({ name: `case integral ${k + 1}`, rows: splitStatements(text) }));
SURFACE_CASES.forEach((text, k) => docs.push({ name: `case surfaces ${k + 1}`, rows: splitStatements(text) }));
DEFINE_CASES.forEach((text, k) => docs.push({ name: `case define ${k + 1}`, rows: splitStatements(text) }));
LEFTOVER_CASES.forEach((text, k) => docs.push({ name: `case leftover ${k + 1}`, rows: splitStatements(text) }));
INTERVAL_CASES.forEach((text, k) => docs.push({ name: `case intervals ${k + 1}`, rows: splitStatements(text) }));
SAMPLED_CASES.forEach((text, k) => docs.push({ name: `case sampled ${k + 1}`, rows: splitStatements(text) }));
PLANE_CASES.forEach((text, k) => docs.push({ name: `case planes ${k + 1}`, rows: splitStatements(text) }));
MEASURE_CASES.forEach((text, k) => docs.push({ name: `case measure ${k + 1}`, rows: splitStatements(text) }));
randomDocs(Number(process.env.RANDOM_DOCS ?? 600)).forEach((text, k) =>
  docs.push({ name: `case random ${k + 1}`, rows: splitStatements(text) }),
);
randomListDocs(Number(process.env.RANDOM_LIST_DOCS ?? 400)).forEach((text, k) =>
  docs.push({ name: `case random list ${k + 1}`, rows: splitStatements(text) }),
);

const recorded = docs.map(({ name, rows }) => {
  const analysis = analyzeRows(rows);
  const fns = new Set(analysis.defs.fns.keys());
  const sumBound = analysis.document.sumBoundConsts;
  return {
    name,
    rows,
    env: analysis.constEnv,
    gridFields: recordGridFields(analysis),
    states: recordStates(analysis),
    results: analysis.rows.map((row, i) => {
      const def = row.def;
      // web/main.ts sliderOf, sliderRange and moveSlider, without the DOM.
      let slider: Record<string, unknown> | undefined;
      let moved: string | undefined;
      if (def?.kind === 'const' && !def.draw && !row.error) {
        const rhs = def.rhs.trim();
        const form = sliderForm(rhs, fns);
        if (form) {
          const bounds = sliderBounds(form, analysis.constEnv, fns, analysis.document.valueNames);
          let value = form.literal;
          let lo: number, hi: number;
          if (bounds) {
            [lo, hi] = bounds;
            value = sliderValue(form, value, bounds);
          } else {
            lo = Math.min(-10, Math.floor(value));
            hi = Math.max(10, Math.ceil(value));
          }
          // (A whole-number parameter of a discrete law steps in whole numbers too.)
          const whole = form.whole || sumBound.has(def.name) || analysis.rvs.wholeParamNames().has(def.name);
          slider = { min: lo, max: hi, step: whole ? 1 : niceMajor((hi - lo) / 400, 1), value };
          // Where the slider lands when dragged to a third of the way along.
          const target = lo + (hi - lo) / 3;
          const held = sliderValue(form, target, bounds);
          moved = keepNote(
            rows[i],
            `${definitionHead(def, stripNote(rows[i]))} ${writeSlider(rhs, form, fmtNum(held))}`,
          );
        }
      }
      return {
        text: row.text,
        noteStart: noteStart(rows[i]),
        comment: !!row.comment,
        def: def ? { kind: def.kind, name: def.name } : null,
        view: row.view ?? null,
        error: row.error ?? null,
        info: row.info ?? null,
        dist: row.dist ?? null,
        dataLocal: row.dataLocal ?? null,
        kind: row.error ? null : (rowKind(row, analysis.defs) ?? null),
        slider: slider ?? null,
        moved: moved ?? null,
        takesColor: takesColor({
          ...row,
          text: rows[i],
          point: row.def?.kind === 'const' && analysis.defs.points.has(row.def.name),
        }),
        cls: row.cls ? { animated: row.cls.animated, needs3D: row.cls.needs3D, params: row.cls.params } : null,
        cpu: slim(row.cpu),
        gpu: slim(row.gpu),
        drawn: drawnOf(row.cpu, analysis.rvs, analysis.constEnv),
      };
    }),
  };
});
writeFileSync(new URL('analysis.json', fixtures), JSON.stringify(recorded, replacer) + '\n');
writeFileSync(
  new URL('data.json', fixtures),
  JSON.stringify(recordData(bytes => createHash('sha256').update(bytes).digest('hex'))) + '\n',
);
writeFileSync(new URL('planes.json', fixtures), JSON.stringify(recordPlanes(planeMap), replacer) + '\n');
const rowCount = recorded.reduce((n, d) => n + d.rows.length, 0);
console.log(`${recorded.length} documents (${EXAMPLES.flatMap(c => c[1]).length} examples), ${rowCount} rows`);

// --- evaluate ---

const EXPRS = [
  'x + y',
  'x - y',
  'x y',
  'x / y',
  'x^y',
  '-x',
  'x^2',
  'x^3',
  'x^(1/3)',
  'x^(2/3)',
  'x^(1/2)',
  'x^0.33333',
  'x^-1',
  '(-8)^(1/3)',
  '(-8)^(2/3)',
  '(-4)^(1/2)',
  '(-2)^3',
  '(-2)^0.5',
  '0^0',
  '0^-1',
  '2^0.5',
  'x^(y/3)',
  'x^(1/12)',
  'x^(5/7)',
  'sin(x)',
  'cos(x)',
  'tan(x)',
  'asin(x)',
  'acos(x)',
  'atan(x)',
  'atan2(y, x)',
  'atan(y, x)',
  'sinh(x)',
  'cosh(x)',
  'tanh(x)',
  'sech(x)',
  'coth(x)',
  'asinh(x)',
  'acosh(x)',
  'atanh(x)',
  'sqrt(x)',
  'abs(x)',
  'exp(x)',
  'ln(x)',
  'log(x)',
  'log2(x)',
  'floor(x)',
  'ceil(x)',
  'round(x)',
  'sign(x)',
  'fract(x)',
  'mod(x, y)',
  'mod(x, 0)',
  'min(x, y)',
  'max(x, y)',
  'min(x, y, 0)',
  'max(x, y, 0, 1)',
  'erf(x)',
  'normalpdf(x, 0, 1)',
  'normalpdf(x, y, 2)',
  'normalcdf(x, 0, 1)',
  'normalcdf(x, 1, y)',
  'gcd(x, y)',
  'gcd(12, 18)',
  'gcd(x, 0)',
  'isprime(x)',
  'isprime(97)',
  'isprime(91)',
  'isprime(4194303)',
  'isprime(4194304)',
  'gamma(x)',
  'gamma(5)',
  'gamma(0.5)',
  'gamma(-1.5)',
  'gamma(-2)',
  'gamma(171)',
  'gamma(172)',
  'x!',
  '5!',
  '170!',
  '171!',
  '(-1)!',
  '0.5!',
  'sinc(x)',
  'sinc(0)',
  '{x > 0: 1, 0}',
  '{x > 0: 1}',
  '{0 < x < 1: x, x >= 1: 2, -1}',
  '{x > y: x, y}',
  '{x >= y, 2}',
  'pi',
  'e',
  '2 pi x',
  '1/0',
  '-1/0',
  '0/0',
  '1/x',
  'x/0',
  'sqrt(-1)',
  'ln(0)',
  'ln(-1)',
  'x = y',
  'x^2 + y^2 = 1',
  'sin(x)^2 + cos(x)^2',
  'e^(-x^2)',
  'x·y',
  '(x + y)(x - y)',
  '1/2x',
  'x/2 y',
  '2^3!',
  '-x^2',
  'x^-2',
  // What evaluate refuses.
  'x < y',
  '(x, y)',
  '[x, y]',
  'q',
  'x..y',
  're(x)',
  'sum(n=1..3, n x)',
  'prod(n=1..4, n)',
  'sum(n=1..1000, n)',
  '{x: 1}',
  '"a"',
  'L[1]',
  'x == 1',
];
const VALUES = [
  0,
  -0,
  1,
  -1,
  2,
  -2,
  0.5,
  -0.5,
  3,
  -8,
  1.5,
  2.5,
  -2.5,
  10,
  1e-7,
  1e21,
  123.456,
  NaN,
  Infinity,
  -Infinity,
];
const ENVS: Array<[number, number]> = [];
for (const x of VALUES) for (const y of [2, -3, 0.5, 0, x]) ENVS.push([x, y]);

const num = (v: number): number | string => (Object.is(v, -0) ? '-0' : Number.isSafeInteger(v) ? v : String(v));
const evals = EXPRS.map(src => {
  let expr;
  try {
    expr = parseExpr(src);
  } catch (err) {
    return { src, parseError: (err as Error).message };
  }
  return {
    src,
    key: exprKey(expr),
    cases: ENVS.map(([x, y]) => {
      try {
        return { x: num(x), y: num(y), value: num(evaluate(expr, { x, y })) };
      } catch (err) {
        return { x: num(x), y: num(y), error: (err as Error).message };
      }
    }),
  };
});

// --- the kinds only lowering writes ---
//
// No row parses to one, so each is built here, and everything the language
// reads of a tree is recorded for it: its key, children and free variables,
// a substitution, its value, its derivative and its shader text.

const nm = (value: number): Expr => ({ kind: 'num', value });
const vr = (name: string): Expr => ({ kind: 'var', name });
const op = (o: '+' | '-' | '*' | '/' | '^', a: Expr, b: Expr): Expr => ({ kind: 'bin', op: o, a, b });
const fn = (name: string, ...args: Expr[]): Expr => ({ kind: 'call', name, args });
const when = (l: Expr, o: '<' | '<=' | '>' | '>=', r: Expr, value: Expr) => ({
  cond: { kind: 'ineq', op: o, l, r } as Expr,
  value,
});
const cases = (list: Array<{ cond: Expr; value: Expr }>, otherwise?: Expr): Expr => ({
  kind: 'piecewise',
  cases: list,
  ...(otherwise ? { otherwise } : {}),
});
const loop = (body: Expr, limit = 250, seeds: Expr[] = [vr('x'), nm(0)]): Expr => ({
  kind: 'loop',
  params: ['s', 'k'],
  seeds,
  body,
  limit,
});
const column = { name: '@a', values: Float64Array.of(1, 2.5, NaN) };
const [X, Y, S, K] = [vr('x'), vr('y'), vr('s'), vr('k')];
const next = fn(RECUR, op('+', S, Y), op('+', K, nm(1)));
const polygon: Expr = { kind: 'figure', form: 'polygon', dimension: 2, vertices: [X, nm(1), vr('a'), Y] };
const STRUCTURES: Array<[string, Expr]> = [
  ['f(P), a tuple', { kind: 'comp', value: { kind: 'vec', items: [X, Y] }, index: 1, arity: 2, functionName: 'f' }],
  ['p.x of a name', { kind: 'comp', value: vr('P'), index: 0, arity: 0, functionName: 'p.x' }],
  ['f(P), a product', { kind: 'comp', value: op('*', X, X), index: 0, arity: 3, functionName: 'f' }],
  ['a polygon', polygon],
  [
    'a packed polyline',
    {
      kind: 'figure',
      form: 'polyline',
      dimension: 2,
      vertices: [vr('@a'), op('*', vr('a'), vr('@a'))],
      over: [column],
    },
  ],
  ['a segment in space', { kind: 'figure', form: 'segment', dimension: 3, vertices: [X, Y, nm(0), nm(1), nm(2), X] }],
  ['a trail', { kind: 'trail', coordinates: [X, vr('t')] }],
  ['a label', { kind: 'label', coordinates: [X, Y], text: 'a "b" \\ c' }],
  ['a histogram', { kind: 'hist', centers: Float64Array.of(0.5, 1.5), counts: Float64Array.of(2, 0), width: 1 }],
  ['a family', { kind: 'family', members: [{ kind: 'eq', l: Y, r: X }, polygon] }],
  ['a packed list', { kind: 'data', values: Float64Array.of(1, -0, Infinity, 0.1, NaN) }],
  ['an empty packed list', { kind: 'data', values: new Float64Array(0) }],
  ['a lazy list', { kind: 'lazy', cols: [column], body: fn('sin', op('*', vr('a'), vr('@a'))) }],
  ['a text column', { kind: 'text', values: ['NYC', 'a"b', ''] }],
  ['a loop', loop(cases([when(K, '>=', nm(5), S)], next))],
  ['a loop out of passes', loop(cases([when(K, '>=', nm(5), S)], next), 3)],
  ['a loop of no passes', loop(cases([when(K, '>=', nm(5), S)], next), 0)],
  ['a loop with no case holding', loop(cases([when(K, '<', nm(0), S)]))],
  ['a loop of nested cases', loop(cases([when(K, '<', nm(4), cases([when(S, '>', nm(50), K)], next))], op('*', S, K)))],
  ['a loop that is one leaf', loop(op('+', S, nm(1)))],
  ['a loop that only recurs', loop(next, 7)],
  [
    'a loop leaving the finite range',
    loop(cases([when(K, '>=', nm(40), S)], fn(RECUR, op('^', S, nm(9)), op('+', K, nm(1))))),
  ],
  ['a loop of a chained condition', loop(cases([when({ kind: 'ineq', op: '<', l: nm(2), r: K }, '<', S, K)], next))],
  ['a loop testing a name', loop(cases([{ cond: K, value: S }], next))],
  ['a loop short of seeds', loop(cases([when(K, '>=', nm(5), S)], next), 250, [X])],
  ['a loop reading outside itself', loop(cases([when(K, '>=', vr('a'), op('+', S, vr('t')))], next))],
  ['a loop in a sum', op('+', loop(cases([when(K, '>=', nm(2), S)], next)), K)],
  ['a term of a recurrence', fn(TERM_AT_FN, { kind: 'str', value: 'seq_' }, X, Y)],
  ['a term past its chain', fn(TERM_AT_FN, { kind: 'str', value: 'seq_' }, op('+', X, nm(40)))],
  ['a term of no chain', fn(TERM_AT_FN, X, X)],
  ['a packed list in arithmetic', op('+', X, { kind: 'data', values: Float64Array.of(1, 2) })],
  ['a point passed in a call', fn('sin', { kind: 'comp', value: vr('P'), index: 0, arity: 2, functionName: 'g' })],
  ['text in a case', cases([when(X, '>', nm(0), { kind: 'text', values: ['a'] })], polygon)],
];
const SUBSTITUTION: Record<string, Expr> = { x: op('+', vr('t'), nm(1)), y: S, s: K, k: S, a: K, '@a': nm(9), P: Y };
const STRUCTURE_ENVS: Array<Record<string, number>> = [
  { x: 1, y: 2, a: 3, t: 0.5, P: 4, seq_1: 7, seq_2: 8, k: 100, s: -1 },
  { x: 2, y: -0.5, a: 1, t: 0, P: 0, seq_1: 7, seq_2: 8 },
  { x: 2.5, y: 1e300, a: 2, t: 1, seq_1: 7 },
];
/** A tree as the fixtures carry one: a packed column as the list of its numbers. */
const tree = (e: Expr): unknown =>
  JSON.parse(
    JSON.stringify(e, (_key, value: unknown) =>
      ArrayBuffer.isView(value) ? Array.from(value as Float64Array) : typeof value === 'number' ? num(value) : value,
    ),
  );
const attempt = (run: () => unknown): unknown => {
  try {
    return { out: run() };
  } catch (err) {
    return { error: (err as Error).message, errorType: (err as Error).constructor.name };
  }
};
const structures = STRUCTURES.map(([name, expr]) => ({
  name,
  expr: tree(expr),
  key: exprKey(expr),
  kind: expr.kind,
  children: childrenOf(expr).map(exprKey),
  mapped: exprKey(mapChildren(expr, child => ({ kind: 'neg', a: child }))),
  free: [...freeVars(expr)],
  substituted: exprKey(substVars(expr, SUBSTITUTION)),
  diagnostic: structuralDiagnostic(expr),
  values: STRUCTURE_ENVS.map(env => attempt(() => num(evaluate(expr, { ...env })))),
  derivative: attempt(() => exprKey(diff(expr, 'x'))),
  glsl: attempt(() => toGLSL(expr)),
}));

// --- fits (lib/regression.ts) ---
//
// A fit reaches fitRegression through list lowering, which the Swift port does not have: the lists are written
// out here, one model per observation with X (and Z) replaced by its numbers.

const X5 = [0, 1, 2, 3, 4];
const FITS: Array<{
  y: number[];
  x?: number[];
  z?: number[];
  model: string;
  params: string[];
  fixed?: Record<string, number>;
}> = [
  { y: [1.1, 2.9, 5.2, 6.8, 9.1], x: X5, model: 'm X + b', params: ['m', 'b'] },
  { y: [9, 2, 1, 6, 17], x: [-2, -1, 0, 1, 2], model: 'a X^2 + b X + c', params: ['a', 'b', 'c'] },
  { y: [2, 2.84, 4.03, 5.72, 8.11], x: [0, 0.5, 1, 1.5, 2], model: 'a exp(b X)', params: ['a', 'b'] },
  { y: [1, 2, 3, 4, 5], x: X5, model: 'm X + k', params: ['m'], fixed: { k: 1 } },
  { y: [3, 3, 3, 3, 3], x: X5, model: 'c', params: ['c'] },
  { y: [1, 2, 3, 4, 5], x: X5, model: 'a X + b X', params: ['a', 'b'] },
  { y: [1, 2, 3, 4, 5], x: X5, model: 'a b X', params: ['a', 'b'] },
  { y: [1, 2, NaN, 4, 5], x: [0, 1, 2, NaN, 4], model: 'm X + b', params: ['m', 'b'] },
  { y: [1, 2], x: [0, 1], model: 'a X^2 + b X + c', params: ['a', 'b', 'c'] },
  { y: [1, 2, 3], x: [0, 1], model: 'm X', params: ['m'] },
  { y: [1, 2, 3], x: [0, 1, 2], model: 'k X', params: [] },
  { y: [1, 2, 3], x: [0, 1, 2], model: 'm ln(X - 1)', params: ['m'] },
  { y: [1, 2, 3], x: [0, 1, 2], model: 'floor(m X)', params: ['m'] },
  { y: [1, 2, 3], x: [0, 1, 2], model: 'm abs(X) + b', params: ['m', 'b'] },
  { y: [0.1, 0.9, 2.1, 2.9, 4.2], x: X5, z: [1, 0, 2, 1, 3], model: 'a X + b Z + c', params: ['a', 'b', 'c'] },
  { y: [0, 0.84, 0.91, 0.14, -0.76], x: X5, model: 'a sin(b X)', params: ['a', 'b'] },
  { y: [5, 2.7, 1.6, 1.1, 0.9], x: X5, model: 'a exp(-b X) + c', params: ['a', 'b', 'c'] },
  { y: [1, 4, 9, 16, 25], x: [1, 2, 3, 4, 5], model: 'a X^p', params: ['a', 'p'] },
  { y: [1e200, 2e200, 3e200], x: [1, 2, 3], model: 'm X', params: ['m'] },
  { y: [1, 2, 3], x: [1, 2, 3], model: 'a/(X - b)', params: ['a', 'b'] },
  {
    y: [2.1, 3.9, 6.2, 7.8],
    x: [1, 2, 3, 4],
    model: 'a X + b + c + d + f + g + h + j + k',
    params: ['a', 'b', 'c', 'd', 'f', 'g', 'h', 'j', 'k'],
  },
  { y: [0.5, 0.62, 0.73, 0.82, 0.88], x: X5, model: '1/(1 + exp(-(a + b X)))', params: ['a', 'b'] },
];
const fits = FITS.map(({ y, x = [], z = [], model, params, fixed = {} }) => {
  const parsed = parseExpr(model);
  const models = Array.from({ length: x.length || y.length }, (_, k) =>
    substVars(parsed, { X: nm(x[k] ?? NaN), Z: nm(z[k] ?? NaN) }),
  );
  let result: unknown;
  try {
    const fit = fitRegression(y, models, params, fixed);
    result = {
      coefficients: Object.entries(fit.coefficients).map(([name, value]) => ({ name, value: num(value) })),
      count: fit.count,
      skipped: fit.skipped,
      rmse: num(fit.rmse),
      r2: fit.r2 === null ? null : num(fit.r2),
      nonlinear: fit.nonlinear,
      text: formatFit(fit),
    };
  } catch (err) {
    result = { error: (err as Error).message };
  }
  return { y: y.map(num), models: models.map(tree), params, fixed, result };
});

const POW: Array<[number, number]> = [];
for (const a of [0, -0, 1, -1, 2, -2, -8, 0.5, -0.5, 10, NaN, Infinity, -Infinity])
  for (const b of [
    0,
    1,
    -1,
    2,
    3,
    0.5,
    1 / 3,
    2 / 3,
    0.33333,
    1 / 7,
    5 / 12,
    1 / 13,
    -1 / 3,
    2.5,
    NaN,
    Infinity,
    -Infinity,
  ])
    POW.push([a, b]);

const NUMBERS = [
  0,
  -0,
  1,
  -1,
  0.1,
  0.5,
  1.5,
  2.5,
  -2.5,
  1 / 3,
  2 / 3,
  Math.SQRT2,
  Math.PI,
  Math.E,
  100,
  123456,
  1234567,
  123456789,
  0.000001,
  0.0000001,
  1.2e-7,
  0.00012345678,
  0.0012345678,
  0.001,
  0.0009999999,
  999999.5,
  999999.4,
  9999995,
  1e21,
  1e20,
  1.5e21,
  1e-300,
  5e-324,
  1.7976931348623157e308,
  0.30000000000000004,
  4.35,
  1.005,
  8.345,
  0.000001005,
  1e6,
  12345.6789,
  -0.00001,
  25,
  1e100,
  2 ** 53,
  0.1 + 0.2,
  1e-5,
  123.456,
  -1e21,
  NaN,
  Infinity,
  -Infinity,
];

// --- input escapes (lib/escapes.ts) ---
//
// Each text is typed a character at a time, and what each keystroke rewrites
// is recorded (the rewrite is not applied: the next keystroke lands in the
// text as written).

const TYPED = [
  '\\pi',
  '\\pi ',
  '\\sin(',
  '\\sinh',
  '\\sinh(',
  '\\inf ',
  '\\infty',
  '\\in ',
  '\\int',
  '\\\\',
  '\\\\pi',
  '"C:\\pi"',
  "f'\\pi",
  "'a\\pi'",
  'x\\theta+',
  '\\Gamma',
  '\\gamma',
  '\\nope ',
  '\\arcsin(',
  '\\view(',
  '\\open(',
  '\\le',
  '\\leq',
  '\\le ',
  '2\\cdot 3',
  'αβ\\pi',
  '\\',
  '\\1',
  '\\sum',
  '\\Sigma',
  '"a" \\tau',
  "x'' \\mu",
  '\\trail(',
  '\\rgb(',
  '\\e',
  '\\eta',
  '\\epsilon',
  '\\varepsilon',
];
const typed = TYPED.map(text => ({
  text,
  edits: Array.from(text, (_, k) => typedEscape(text.slice(0, k + 1), k + 1, text[k])),
}));

// --- Fourier analysis (lib/fourier.ts) ---

const SIGNALS: Array<[string, number[], number, number]> = [
  ['a square wave', Array.from({ length: 256 }, (_, k) => Math.sign(Math.sin((2 * Math.PI * (k + 0.5)) / 256))), 0, 1],
  ['eight samples', [1, 2, 3, 4, 3, 2, 1, 0], -1, 4],
  ['five samples', [0, 1, 0, -1, 0.5], 0, 2 * Math.PI],
  [
    'twelve samples',
    Array.from({ length: 12 }, (_, k) => Math.cos((2 * Math.PI * k) / 12) + 0.25 * Math.sin((6 * Math.PI * k) / 12)),
    2,
    3,
  ],
  ['a hundred samples', Array.from({ length: 100 }, (_, k) => ((k * 37) % 11) - 5 + 1e-3 * k), 0, 10],
  ['a constant', [2, 2, 2, 2, 2, 2], 0, 1],
  ['two samples', [1, -1], 0, 1],
  ['small values', [1e-9, 2e-9, -1e-9, 0, 3e-9, 1e-9, 0], 0, 1],
  ['one sample', [1], 0, 1],
  ['a missing sample', [1, NaN, 2, 3], 0, 1],
  ['an overflow', [1e308, -1e308, 1e308, -1e308], 0, 1],
];
const fourier = SIGNALS.map(([name, samples, lo, period]) => {
  try {
    const c = realFourier(Float64Array.from(samples));
    const harmonics = Math.min(c.cosine.length - 1, 12);
    const count: Expr = { kind: 'var', name: 'N' };
    const plain = reconstructSeries(c, harmonics, lo, period);
    const gated = reconstructSeries(c, harmonics, lo, period, count);
    const xs = [-1.3, 0, 0.21, 1, 2.75];
    return {
      name,
      samples: samples.map(num),
      lo: num(lo),
      period: num(period),
      cosine: Array.from(c.cosine, num),
      sine: Array.from(c.sine, num),
      spectrum: spectrumPoints(c, period).map(p =>
        (p as Expr & { kind: 'vec' }).items.map(it => num(evaluate(it, {}))),
      ),
      harmonics,
      plain: xs.map(x => num(evaluate(plain, { x }))),
      gated: [0, 1, 2.5, 7, 200].map(N => xs.map(x => num(evaluate(gated, { x, N })))),
      gatedIsLoop: attempt(() => toGLSL(gated).includes('eq_loop_')),
    };
  } catch (err) {
    return { name, samples: samples.map(num), lo: num(lo), period: num(period), error: (err as Error).message };
  }
});

writeFileSync(
  new URL('evaluate.json', fixtures),
  JSON.stringify({
    escapes: { table: ESCAPES, typed },
    fourier,
    evals,
    substitution: Object.fromEntries(Object.entries(SUBSTITUTION).map(([name, e]) => [name, tree(e)])),
    structureEnvs: STRUCTURE_ENVS.map(env => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, num(v)]))),
    structures,
    fits,
    pow: POW.map(([a, b]) => ({ a: num(a), b: num(b), value: num(realPow(a, b)) })),
    numbers: NUMBERS.map(v => ({
      v: num(v),
      string: String(v),
      precision6: v.toPrecision(6),
      precision1: v.toPrecision(1),
      precision17: v.toPrecision(17),
      fixed6: v.toFixed(6),
      fixed0: v.toFixed(0),
      fixed2: v.toFixed(2),
      slider: fmtNum(v),
      readout: valueReadout(v),
    })),
  }) + '\n',
);
console.log(
  `${evals.length} expressions × ${ENVS.length} points, ${structures.length} built trees, ${POW.length} powers, ` +
    `${NUMBERS.length} numbers`,
);
