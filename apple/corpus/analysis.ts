/**
 * Records what the site reports for whole documents, so the Swift port of the
 * language trunk (apple/EquationCore: Analysis.swift and what it stands on)
 * is held to the same answers: every example in the menu, plus cases aimed at
 * the corners — errors, redefinitions, cycles, sliders, readouts.
 *
 *   node --experimental-transform-types --no-warnings apple/corpus/analysis.ts
 *
 * Writes analysis.json (per document: its rows, and per row what
 * lib/analysis.ts says of it) and evaluate.json (lib/expr.ts evaluate and
 * the number formatting readouts are written with) beside the parser's
 * fixtures.
 */
import { writeFileSync } from 'node:fs';
import { analyzeRows } from '../../lib/analysis.ts';
import { evaluate, exprKey, parseExpr, realPow } from '../../lib/expr.ts';
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
const PORTED = new Set(['implicit2d', 'ineq2d', 'scalar2d', 'point', 'pcurve', 'vfield2d', 'value', 'note', 'none']);
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
randomDocs(600).forEach((text, k) => docs.push({ name: `case random ${k + 1}`, rows: splitStatements(text) }));

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

writeFileSync(
  new URL('evaluate.json', fixtures),
  JSON.stringify({
    evals,
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
console.log(`${evals.length} expressions × ${ENVS.length} points, ${POW.length} powers, ${NUMBERS.length} numbers`);
