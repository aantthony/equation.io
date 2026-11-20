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
import { writeFileSync } from 'node:fs';
import { analyzeRows } from '../../lib/analysis.ts';
import { diff } from '../../lib/diff.ts';
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
import { rowKind } from '../../lib/row-kind.ts';
import { sliderBounds, sliderForm, sliderValue, writeSlider } from '../../lib/slider.ts';
import { keepNote, noteStart, splitStatements } from '../../lib/statements.ts';
import { EXAMPLES } from '../../web/examples.ts';

const fixtures = new URL('../EquationCore/Tests/EquationCoreTests/Fixtures/', import.meta.url);

/** JSON has no NaN or ±Infinity, and Foundation's JSON reader rounds some
 *  decimals an ulp off: every number but a whole one travels as its text. */
const replacer = (_key: string, value: unknown): unknown =>
  typeof value === 'number' && !Number.isSafeInteger(value)
    ? String(value)
    : value instanceof Float64Array || value instanceof Float32Array
      ? { packed: value.length }
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
  'implicit2d', 'ineq2d', 'scalar2d', 'point', 'pcurve', 'vfield2d', 'value', 'note', 'none',
  'complex2d', 'domain2d', 'conformal2d', 'fractal2d', 'rgb2d', 'hsl2d', 'oklch2d',
]);
function slim(plan: { type: string } | undefined): unknown {
  if (!plan) return null;
  if (!PORTED.has(plan.type)) return { type: plan.type, omitted: true };
  const text = JSON.stringify(plan, replacer);
  return text.length > 20_000 ? { type: plan.type, omitted: true } : plan;
}

/** Targeted documents: one concern each, rows separated as the examples' are. */
const CASES: string[] = [
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
  const FNS = ['sin', 'cos', 'tan', 'sqrt', 'abs', 'exp', 'ln', 'floor', 'sign', 'atan', 'sinh', 'erf', 'sinc', 'round'];
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
    'L = [1, 2, 3]', 'y = L x', 'b = [a, 2]', 'sum(n=1..3, x^n)', 'y = sum(n=1..a, n x)', 'w^2', 'i a', '(1, 2, 3)',
    'z = x y', 'X ~ Normal(0, 1)', 'a ~ b x + c', 'a_n = n a', 'b_k = 3', "p' = -p", "a' = b", 'a(0) = 1',
    'view(x = -a..a)', 'view(y = -1..b, ratio = 2)', '---', '--- right', 'grid(off)', 'e_x', 'y = e_y x',
    'total = 2', 'gamma = 3', 'mean(x)', 'min(a)', 'max(b)', 'count(c)', 'f(A)', 'g(A)', 'g((1, 2))', 'A.x', 'A.y + r',
    'c[1]', 'A[1]', '{a = 2: 1, 0}', '{b = c: x, y}', 'd/da (a x)', 'y = d/dt sin(t x)', 'y = d^2/dx^2 f(x)',
    'dy/dx = y a', "x' = y", "(x', y') = (y, -a x)", 'N = 3', 'y = N x', 'c = interval(0, 1)', 'b ∈ [1, 2]',
    'abs(A)', 'A · A', 'A × (1, 0)', 'dot(A, A)', 'segment(A, (0, 0))', 'P(a > 1)', 'E(a)', 'u', 'u a', 'v + x',
    'a = x', 'b = y a', 'f(x) = x', 'g = 2', 'r(x) = x', 'A = 3', 'A_x = 1', 'y = A_z', 't = a', 'e = a', 'd = 2',
    'x = a', 'y = b', 'x = y', '# note', 'y = x # a', 'a = 3 #f00', '', 'y =', 'sin(', 'y = )', 'a = ', '1 +',
    'c = clamp(a, 0)', 'y = sin(x, y)', 'y = atan(y, x)', 'log2(a)', 'a!', 'x!', '2^3!', 'r_0 = 1', 'q = {a > 0: b}',
    'within = a > 0', 'within = x > a', '{within: 1, 0}', 'y = {c > 0: x}', 'inf', 'y = inf', 'int[0..1] x dx',
    'domain(a w)', 'conformal(w^2 + b)', 'iter(z^2 + w)', 'iter(z^2 + a)', 'rgb(x, a, b)', 'hsl(arg(w), 1, c)',
    'exp(i a u)', 'i^2 = -1', 're(w^2) = a', 'abs(w - a) < b', 'a + b i', 'f(w)', 'g(w, i)', 'c = a i', 'r = w + a',
    'domain(f(w))', 'rgb(f(x), g(x, y), 0)', 'q(n) = {n > a: n, q(n + 1)}', 'q(x)', 'y = q(b)',
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
    out.push((order < 0.5 ? [...defs, ...rows] : order < 0.75 ? [...rows, ...defs] : [...defs].reverse().concat(rows)).join('; '));
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
randomDocs(Number(process.env.RANDOM_DOCS ?? 600)).forEach((text, k) => docs.push({ name: `case random ${k + 1}`, rows: splitStatements(text) }));

const recorded = docs.map(({ name, rows }) => {
  const analysis = analyzeRows(rows);
  const fns = new Set(analysis.defs.fns.keys());
  const sumBound = analysis.document.sumBoundConsts;
  return {
    name,
    rows,
    env: analysis.constEnv,
    results: analysis.rows.map((row, i) => {
      const def = row.def;
      // web/main.ts sliderOf, sliderRange and moveSlider, without the DOM.
      let slider: Record<string, unknown> | undefined;
      let moved: string | undefined;
      if (def?.kind === 'const' && !def.draw && !row.error) {
        const rhs = def.rhs.trim();
        const form = sliderForm(rhs, fns);
        if (form) {
          const bounds = sliderBounds(form, analysis.constEnv, fns);
          let value = form.literal;
          let lo: number, hi: number;
          if (bounds) {
            [lo, hi] = bounds;
            value = sliderValue(form, value, bounds);
          } else {
            lo = Math.min(-10, Math.floor(value));
            hi = Math.max(10, Math.ceil(value));
          }
          const whole = form.whole || sumBound.has(def.name);
          slider = { min: lo, max: hi, step: whole ? 1 : niceMajor((hi - lo) / 400, 1), value };
          // Where the slider lands when dragged to a third of the way along.
          const target = lo + (hi - lo) / 3;
          const held = sliderValue(form, target, bounds);
          moved = keepNote(rows[i], `${def.name} = ${writeSlider(rhs, form, fmtNum(held))}`);
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
      };
    }),
  };
});
writeFileSync(new URL('analysis.json', fixtures), JSON.stringify(recorded, replacer) + '\n');
const rowCount = recorded.reduce((n, d) => n + d.rows.length, 0);
console.log(`${recorded.length} documents (${EXAMPLES.flatMap(c => c[1]).length} examples), ${rowCount} rows`);

// --- evaluate ---

const EXPRS = [
  'x + y', 'x - y', 'x y', 'x / y', 'x^y', '-x', 'x^2', 'x^3', 'x^(1/3)', 'x^(2/3)', 'x^(1/2)', 'x^0.33333', 'x^-1',
  '(-8)^(1/3)', '(-8)^(2/3)', '(-4)^(1/2)', '(-2)^3', '(-2)^0.5', '0^0', '0^-1', '2^0.5', 'x^(y/3)', 'x^(1/12)',
  'x^(5/7)', 'sin(x)', 'cos(x)', 'tan(x)', 'asin(x)', 'acos(x)', 'atan(x)', 'atan2(y, x)', 'atan(y, x)', 'sinh(x)',
  'cosh(x)', 'tanh(x)', 'sech(x)', 'coth(x)', 'asinh(x)', 'acosh(x)', 'atanh(x)', 'sqrt(x)', 'abs(x)', 'exp(x)',
  'ln(x)', 'log(x)', 'log2(x)', 'floor(x)', 'ceil(x)', 'round(x)', 'sign(x)', 'fract(x)', 'mod(x, y)', 'mod(x, 0)',
  'min(x, y)', 'max(x, y)', 'min(x, y, 0)', 'max(x, y, 0, 1)', 'erf(x)', 'normalpdf(x, 0, 1)', 'normalpdf(x, y, 2)',
  'normalcdf(x, 0, 1)', 'normalcdf(x, 1, y)', 'gcd(x, y)', 'gcd(12, 18)', 'gcd(x, 0)', 'isprime(x)', 'isprime(97)',
  'isprime(91)', 'isprime(4194303)', 'isprime(4194304)', 'gamma(x)', 'gamma(5)', 'gamma(0.5)', 'gamma(-1.5)',
  'gamma(-2)', 'gamma(171)', 'gamma(172)', 'x!', '5!', '170!', '171!', '(-1)!', '0.5!', 'sinc(x)', 'sinc(0)',
  '{x > 0: 1, 0}', '{x > 0: 1}', '{0 < x < 1: x, x >= 1: 2, -1}', '{x > y: x, y}', '{x >= y, 2}', 'pi', 'e',
  '2 pi x', '1/0', '-1/0', '0/0', '1/x', 'x/0', 'sqrt(-1)', 'ln(0)', 'ln(-1)', 'x = y', 'x^2 + y^2 = 1',
  'sin(x)^2 + cos(x)^2', 'e^(-x^2)', 'x·y', '(x + y)(x - y)', '1/2x', 'x/2 y', '2^3!', '-x^2', 'x^-2',
  // What evaluate refuses.
  'x < y', '(x, y)', '[x, y]', 'q', 'x..y', 're(x)', 'sum(n=1..3, n x)', 'prod(n=1..4, n)', 'sum(n=1..1000, n)',
  '{x: 1}', '"a"', 'L[1]', 'x == 1',
];
const VALUES = [0, -0, 1, -1, 2, -2, 0.5, -0.5, 3, -8, 1.5, 2.5, -2.5, 10, 1e-7, 1e21, 123.456, NaN, Infinity, -Infinity];
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

const POW: Array<[number, number]> = [];
for (const a of [0, -0, 1, -1, 2, -2, -8, 0.5, -0.5, 10, NaN, Infinity, -Infinity])
  for (const b of [0, 1, -1, 2, 3, 0.5, 1 / 3, 2 / 3, 0.33333, 1 / 7, 5 / 12, 1 / 13, -1 / 3, 2.5, NaN, Infinity, -Infinity])
    POW.push([a, b]);

const NUMBERS = [
  0, -0, 1, -1, 0.1, 0.5, 1.5, 2.5, -2.5, 1 / 3, 2 / 3, Math.SQRT2, Math.PI, Math.E, 100, 123456, 1234567, 123456789,
  0.000001, 0.0000001, 1.2e-7, 0.00012345678, 0.0012345678, 0.001, 0.0009999999, 999999.5, 999999.4, 9999995, 1e21,
  1e20, 1.5e21, 1e-300, 5e-324, 1.7976931348623157e308, 0.30000000000000004, 4.35, 1.005, 8.345, 0.000001005, 1e6,
  12345.6789, -0.00001, 25, 1e100, 2 ** 53, 0.1 + 0.2, 1e-5, 123.456, -1e21, NaN, Infinity, -Infinity,
];

// --- input escapes (lib/escapes.ts) ---
//
// Each text is typed a character at a time, and what each keystroke rewrites
// is recorded (the rewrite is not applied: the next keystroke lands in the
// text as written).

const TYPED = [
  '\\pi', '\\pi ', '\\sin(', '\\sinh', '\\sinh(', '\\inf ', '\\infty', '\\in ', '\\int', '\\\\', '\\\\pi',
  '"C:\\pi"', "f'\\pi", "'a\\pi'", 'x\\theta+', '\\Gamma', '\\gamma', '\\nope ', '\\arcsin(', '\\view(',
  '\\open(', '\\le', '\\leq', '\\le ', '2\\cdot 3', 'αβ\\pi', '\\', '\\1', '\\sum', '\\Sigma', '"a" \\tau',
  "x'' \\mu", '\\trail(', '\\rgb(', '\\e', '\\eta', '\\epsilon', '\\varepsilon',
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
  ['twelve samples', Array.from({ length: 12 }, (_, k) => Math.cos((2 * Math.PI * k) / 12) + 0.25 * Math.sin((6 * Math.PI * k) / 12)), 2, 3],
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
      spectrum: spectrumPoints(c, period).map(p => (p as Expr & { kind: 'vec' }).items.map(it => num(evaluate(it, {})))),
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
