/**
 * Runs lib/diff.ts over a broad corpus and writes what it returns or throws
 * as the Swift port's conformance fixture (DiffConformanceTests.swift): the
 * shaders are written from the derivative's tree, so the Swift must build
 * the same tree, node for node.
 *
 *   pnpm swift:diff-corpus
 *
 * Each entry carries the input as a tree, not only as text, so the Swift
 * differentiator is held to this fixture whatever its parser does, and the
 * internal calls nobody can write ([angle], [interval], a three-argument
 * normalpdf) are covered too.
 */
import { writeFileSync } from 'node:fs';
import { diff } from '../../lib/diff.ts';
import { ANGLE_FN, ANGLE_RATE_FN, type Expr, INTERVAL, parseExpr, RECUR } from '../../lib/expr.ts';
import { splitStatements, stripNote } from '../../lib/statements.ts';
import { EXAMPLES } from '../../web/examples.ts';

const fixtures = new URL('../EquationCore/Tests/EquationCoreTests/Fixtures/', import.meta.url);

interface Entry {
  src: string;
  variable: string;
  input: unknown;
  expr?: unknown;
  error?: string;
  errorType?: string;
}

// Every number is written as text, digits as JavaScript prints them (the
// shortest that read back to the same double): non-finite numbers and -0 have
// no JSON spelling, and Foundation's JSON reader gets the last digit of some
// that do wrong (-6/5040, a sinc′ coefficient, for one). A packed column (a
// Float64Array) is written as the list of its numbers.
const replacer = (key: string, value: unknown): unknown => {
  if (key === 'axes' || key === 'origin') return undefined;
  if (ArrayBuffer.isView(value)) return Array.from(value as Float64Array);
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
  return value;
};
const json = (value: unknown): string => JSON.stringify(value, replacer);

const entries = new Map<string, Entry>();
let oversize = 0;
const MAX_ENTRY = 12_000;

/** Record d(input)/d(variable); returns the derivative when there is one. */
function record(src: string, input: Expr, variable: string): Expr | undefined {
  const key = json([input, variable]);
  let result: Expr | undefined;
  let entry: Entry;
  try {
    result = diff(input, variable);
    entry = { src, variable, input, expr: result };
  } catch (err) {
    if (result) throw err;
    entry = { src, variable, input, error: (err as Error).message, errorType: (err as Error).constructor.name };
  }
  // A derivative of a derivative of a long product is megabytes; past a size
  // the tree only repeats rules the shorter entries already hold.
  const written = json(entry);
  if (written.length > MAX_ENTRY) {
    oversize++;
    return undefined;
  }
  if (!entries.has(key)) entries.set(key, JSON.parse(written) as Entry);
  return result;
}

/** A written input: its derivative in each variable, and optionally those derivatives' own. */
function text(src: string, variables: string[], again = false): void {
  let input: Expr;
  try {
    input = parseExpr(src);
  } catch {
    return;
  }
  for (const v of variables) {
    const d = record(src, input, v);
    if (!d || !again) continue;
    const d2 = record(`d/d${v} (${src})`, d, v);
    if (d2) record(`d²/d${v}² (${src})`, d2, v);
  }
}

// What lib/diff.test.ts differentiates.
for (const src of [
  'x^2',
  'x^3 - 2x',
  '5',
  'x sin(x)',
  'sin(x^2)',
  '1/x',
  'e^x',
  'ln(x)',
  'sqrt(x)',
  'x^x',
  'u v',
  'cos(2pi v)',
  'sech(x)',
  'asinh(x)',
  'acosh(x)',
  'atanh(x)',
  '|x^2-1|',
  'sinc(x)',
  'min(x, 1)',
  'max(x^2, 3x, 1)',
  'min(max(x^2, 0), 1)',
  'min(max(a, 0), 2)',
  'floor(x)',
  '(cos(2pi u), sin(2pi u), v)',
  '(u, v, floor(4u))',
  '(u, v, max(u, v)^2)',
  'cos(2pi u)',
  'sin(2pi u)',
  'max(u, v)^2',
  'floor(4u)',
  Array.from({ length: 20 }, (_, k) => `sin(${k + 2}u + v)`).join(' '),
  'x^2+y^2+z^2=9',
  'x^2+y^2+z^2-9',
]) {
  text(src, ['x', 'y', 'z', 'u', 'v'], true);
}

// Every statement of every example that parses on its own, and each side of
// an equation or definition among them.
for (const [, items] of EXAMPLES) {
  for (const [, source] of items) {
    for (const statement of splitStatements(source)) {
      const row = stripNote(statement).trim();
      if (!row) continue;
      text(row, ['x', 'y']);
      const at = row.indexOf('=');
      if (at > 0 && !/[<>=!]/.test(row[at - 1] + row[at + 1])) {
        text(row.slice(at + 1), ['x', 'y', 't', 'u', 'v'], true);
      }
    }
  }
}

// Every builtin with a derivative rule, around arguments that are the
// variable, a function of it, constant in it, and a number.
const UNARY = [
  ...['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'sech', 'asinh', 'acosh', 'atanh'],
  ...['exp', 'ln', 'log', 'sqrt', 'abs', 'erf', 'sinc', 'coth'],
  // And those without one.
  ...['floor', 'ceil', 'round', 'sign', 'gamma', 'sec', 'csc', 'cot', 'trunc', 'frac', 'cbrt', 'log2', 'erfc'],
];
const ARGS = ['x', 'x^2 + 1', '3x', '-x', 'a', '2', 'x y', 'sin(x)', 'x/y', '0'];
for (const fn of UNARY) {
  for (const arg of ARGS) text(`${fn}(${arg})`, ['x', 'y'], true);
  for (const outer of ['sin', 'ln', 'sqrt', 'abs', 'sinc']) text(`${outer}(${fn}(x) + y)`, ['x', 'y']);
  text(`x ${fn}(x)`, ['x']);
  text(`${fn}(x)/x`, ['x']);
  text(`${fn}(x)^2`, ['x']);
  text(`${fn}(x)^y`, ['x', 'y']);
  text(`2^${fn}(x)`, ['x']);
}

// The simplifier's folds, powers, and everything with a rule of its own.
for (const src of [
  ...['0', '1', 'x', 'y', '-x', '--x', '-(-x)', '-3', '-(2)', 'x + 0', '0 + x', 'x - 0', '0 - x', '0 - 3'],
  ...['2 + 3', '2 - 3', '2*3', '6/3', '1/0', '0/0', '0/x', 'x/1', 'x/0', '0*x', 'x*0', '1*x', 'x*1', '2*3*x'],
  ...['x*2*3', '2x', 'x 2', '3x^2', 'x^0', 'x^1', 'x^2', 'x^3', 'x^-1', 'x^(-1)', 'x^0.5', 'x^(1/2)', 'x^1.5'],
  ...['x^y', 'y^x', '2^x', '0^x', '1^x', '(-2)^x', '10^x', '0.5^x', 'e^x', 'e^(x^2)', 'e^(-x^2/2)', 'pi^x'],
  ...['x^x^x', '(x^x)^x', '(x^2)^3', '(x + 1)^(y + 1)', '(x y)^(x/y)', 'x^(2y)', '2^(x y)', 'x^pi', 'x^e'],
  ...['x + y', 'x - y', 'x y', 'x/y', 'y/x', '(x + 1)/(x - 1)', '(x + y)/(x - y)', '1/(x^2 + y^2)', 'x/x'],
  ...['x - x', 'x + x', 'x x', 'x^2 y^3', '3x^2 y - 2x y^2 + y', 'a x^2 + b x + c', '(x + 1)(x - 1)', '5x - 5x'],
  ...['x · y', 'x × y', '(x, y) · (y, x)'],
  ...['atan2(y, x)', 'atan2(x, y)', 'atan2(x^2, 3)', 'atan2(2, 3)', 'atan(y, x)', 'atan(x)', 'atan2(sin(x), cos(x))'],
  ...['min(x, y)', 'max(x, y)', 'min(x, y, 1)', 'max(x, y, x y, 2)', 'min(1, 2)', 'min(a, b)', 'max(x^2, x)'],
  ...['min(x)', 'max(x)', 'min(max(x, 0), 1)', 'max(min(x, y), min(x^2, y^2))', 'clamp(x, 0, 1)'],
  ...['normalpdf(x)', 'normalcdf(x)', 'normalpdf(x, 0, 1)', 'normalcdf(x, 1, 2)', 'normalpdf(x, y, 2)'],
  ...['normalpdf(1, x, y)', 'normalcdf(x^2, y, x)', 'normalpdf(2, 0, 1)', 'normalcdf(a, b, c)'],
  ...['mod(x, 2)', 'floor(x) + x', 'x + floor(x)', 'x floor(y)', 'pow(x, 2)', 'hypot(x, y)', 'x!', 'x!!'],
  ...['|x|', '|x| + |y|', '||x| - 1|', 'abs(x y)', 'sign(x)', 'sign(x) x', 'abs(sin(x))'],
  ...['{x < 0: -x, x >= 0: x^2}', '{x < 0: -x, x^2}', '{-2 < x < 2: x^2}', '{x > 0}', '{x > 0, y > 0}'],
  ...['{x > 0: 1}', '{x > 0: floor(x), x}', '{x > 0: x, floor(x)}', '{x > y: x, y}^2', 'x {x > 0: x, 0}'],
  ...['{x > 0: {y > 0: x y, x - y}, sin(x)}', '{x > 0, x < 1: x^2}', '{x = 0: 1, sin(x)/x}', '{x > 0: (x, y)}'],
  ...['sinc(x)', 'sinc(2x)', 'sinc(x^2 + y^2)', 'sinc(sinc(x))', 'x sinc(x)', 'sinc(x)/x', 'sinc(a)'],
  ...['sin(cos(tan(x)))', 'ln(ln(ln(x)))', 'sqrt(sqrt(x))', 'exp(exp(x))', 'sin(x)^cos(x)', 'ln(sin(x)^2)'],
  ...['sqrt(1 - x^2)', 'sqrt(x^2 + y^2)', 'ln(x^2 + y^2)/2', 'exp(-(x^2 + y^2))', 'sin(x) cos(y)', 'tanh(x y)'],
  ...['erf(x/sqrt(2))', 'log(x^2)', 'log(10^x)', 'asin(x/y)', 'acos(2x - 1)', 'atan(y/x)', 'sech(x)^2'],
  ...['y = x^2', 'x^2 + y^2 = 4', 'y = sin(x) + floor(x)', 'x = y', '0 = 0', 'y = (x, 1)', 'sin(x) = cos(y)'],
  ...['y < x', 'y <= x^2', '0 < y < x', '(x > 0)', 'x == y', 'x != 1'],
  ...['(x, y)', '(x, y, x y)', '(1, 2)', '[x, x^2]', '[1, 2, 3]', '[]', '[x]', '[x, [y, x]]', '[(x, y)]'],
  ...['[1..10]', '[x, 1..3]', '[floor(x)]', '[x, y < 1]', '1..x', 'L[1]', 'L[x]', '[x, x^2][2]', '"text"'],
  ...['["a", "b"]', 'x + "a"', 'sum(n = 1..5, x^n)', 'prod(n = 1..3, x + n)', 'int(x^2, 0, 1)', 'f(x)', 'f(x, y)'],
  ...['d/dx x^2', "f'(x)", 'x_1', 'x_1^2', 'theta', 'r', 'r cos(theta)', 'i x', 'pi x', 'e x', 'tau', 'inf x'],
  ...['random()', 'x%', '50% x', 'x mod 2', 'gcd(x, 2)', 'nCr(x, 2)', 'lerp(x, y, 0.5)', 'step(x)', 'x°'],
  ...['1e300 * 1e300 * x', '1e300 x * 1e300', 'x^1e308', 'x^(1e-320)', '1e400 x', '(1e400 - 1e400) x', 'x/1e400'],
]) {
  text(src, ['x', 'y'], true);
}

// d(c^x) folds ln c, so the Swift must take the logarithm JavaScript does:
// constants of every size, and plenty with no pattern to them.
const constants = [0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999999, 1.000001, 1.01, 1.1, 1.5, 2, 2.5, 3, 4, 5, 7, 8, 9];
constants.push(10, 16, 100, 1000, 1024, 1e6, 1e-6, 1e-300, 1e300, 5e-324, 2.2250738585072014e-308, 1e-310);
constants.push(Number.MAX_VALUE, Math.E, Math.PI, Math.SQRT2, Math.SQRT1_2, 0.7071, 1.4142, 0.693, 1 + 2 ** -20);
constants.push(1 - 2 ** -21, 1 + 2 ** -52, 1 - 2 ** -53, Infinity, NaN, -1, -2.5, -Infinity);
let seed = 0x2545f491;
const random = (): number => {
  // xorshift32: the same constants on every run.
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 2 ** 32;
};
for (let k = 0; k < 2000; k++) constants.push(2 ** (random() * 80 - 40) * (1 + random()));
for (let k = 0; k < 200; k++) constants.push(2 ** (random() * 2140 - 1070) * (1 + random()));
for (let k = 0; k < 400; k++) constants.push(1 + (random() - 0.5) * 2 ** -(k % 30));
for (const c of constants) {
  const input: Expr = { kind: 'bin', op: '^', a: { kind: 'num', value: c }, b: { kind: 'var', name: 'x' } };
  record(`${c}^x`, input, 'x');
}

// Trees no text parses to: the internal calls lowering makes, numbers the
// parser never writes, and calls with the wrong number of arguments.
const n = (value: number): Expr => ({ kind: 'num', value });
const x: Expr = { kind: 'var', name: 'x' };
const y: Expr = { kind: 'var', name: 'y' };
const a: Expr = { kind: 'var', name: 'a' };
const call = (name: string, ...args: Expr[]): Expr => ({ kind: 'call', name, args });
const bin = (op: '+' | '-' | '*' | '/' | '^', l: Expr, r: Expr): Expr => ({ kind: 'bin', op, a: l, b: r });
const sq = (e: Expr): Expr => bin('^', e, n(2));
const built: [string, Expr][] = [
  ['[interval](x)', call(INTERVAL, x)],
  ['[interval]() x', bin('*', call(INTERVAL), x)],
  ['[angle](1, 0, x, y)', call(ANGLE_FN, n(1), n(0), x, y)],
  ['[angle](x, y, 1, 0)', call(ANGLE_FN, x, y, n(1), n(0))],
  ['[angle](x, x^2, y, x y)', call(ANGLE_FN, x, sq(x), y, bin('*', x, y))],
  ['[angle](a, 1, 2, a)', call(ANGLE_FN, a, n(1), n(2), a)],
  ['[angle](x, floor(x), 1, 0)', call(ANGLE_FN, x, call('floor', x), n(1), n(0))],
  ['[angle](x, y, 1)', call(ANGLE_FN, x, y, n(1))],
  ['[angle](x)', call(ANGLE_FN, x)],
  ['[angle′](x, y, 1, 0)', call(ANGLE_RATE_FN, x, y, n(1), n(0))],
  ['[angle′](x, x^2, 1, 2x)', call(ANGLE_RATE_FN, x, sq(x), n(1), bin('*', n(2), x))],
  ['[angle′](x, y)', call(ANGLE_RATE_FN, x, y)],
  ['[angle′](x)', call(ANGLE_RATE_FN, x)],
  ['[polygon](x, y)', call('[polygon]', x, y)],
  ['[trail](x)', call('[trail]', x)],
  ['[](x)', call('[]', x)],
  ['[(x)', call('[', x)],
  ['atan2(x)', call('atan2', x)],
  ['atan2(a)', call('atan2', a)],
  ['atan2()', call('atan2')],
  ['atan2(y, x, 1)', call('atan2', y, x, n(1))],
  ['atan()', call('atan')],
  ['atan(y, x, 1)', call('atan', y, x, n(1))],
  ['sin()', call('sin')],
  ['sin(x, y)', call('sin', x, y)],
  ['min()', call('min')],
  ['max(x, floor(x))', call('max', x, call('floor', x))],
  ['normalpdf(x, y)', call('normalpdf', x, y)],
  ['normalcdf(x, 0, y, 1)', call('normalcdf', x, n(0), y, n(1))],
  ['normalpdf(x, floor(x), 1)', call('normalpdf', x, call('floor', x), n(1))],
  ['-(NaN)', { kind: 'neg', a: n(NaN) }],
  ['-(Infinity)', { kind: 'neg', a: n(Infinity) }],
  ['NaN x', bin('*', n(NaN), x)],
  ['x NaN', bin('*', x, n(NaN))],
  ['Infinity x', bin('*', n(Infinity), x)],
  ['x^NaN', bin('^', x, n(NaN))],
  ['x^Infinity', bin('^', x, n(Infinity))],
  ['x/NaN', bin('/', x, n(NaN))],
  ['-(-x) as written', { kind: 'neg', a: { kind: 'neg', a: x } }],
  ['-(x) - -(x)', bin('-', { kind: 'neg', a: x }, { kind: 'neg', a: x })],
  ['x ⊗ y', { kind: 'bin', op: '*', a: x, b: y, glyph: 'outer' }],
  ['x[1]', { kind: 'index', args: [x, n(1)] }],
  ['1..x', { kind: 'range', args: [n(1), x] }],
  ['x == 1', { kind: 'eqtest', op: '==', args: [x, n(1)] }],
  ['x != 1', { kind: 'eqtest', op: '!=', args: [x, n(1)] }],
  ['[x, 1..2]', { kind: 'list', items: [x, { kind: 'range', args: [n(1), n(2)] }] }],
  ['[floor(x), 1..2]', { kind: 'list', items: [call('floor', x), { kind: 'range', args: [n(1), n(2)] }] }],
  ['sin([x, x^2])', call('sin', { kind: 'list', items: [x, sq(x)] })],
  ['"a"', { kind: 'str', value: 'a' }],
  [
    '{x > 0} (bare)',
    { kind: 'piecewise', cases: [{ cond: { kind: 'ineq', op: '>', l: x, r: n(0) }, value: sq(x), bare: true }] },
  ],
  [
    '{x > 0: x, "a"}',
    {
      kind: 'piecewise',
      cases: [{ cond: { kind: 'ineq', op: '>', l: x, r: n(0) }, value: x }],
      otherwise: { kind: 'str', value: 'a' },
    },
  ],
  ['{} with no cases', { kind: 'piecewise', cases: [] }],
  ['{: x^2}', { kind: 'piecewise', cases: [], otherwise: sq(x) }],
  ['(x > 0) grouped', { kind: 'ineq', op: '>', l: x, r: n(0), grouped: true }],
  ['() empty vec', { kind: 'vec', items: [] }],
  // The kinds only lowering writes.
  ['f(P) of a tuple', { kind: 'comp', value: { kind: 'vec', items: [x, y] }, index: 0, arity: 2, functionName: 'f' }],
  ['f(P) of x^2', { kind: 'comp', value: sq(x), index: 1, arity: 2, functionName: 'f' }],
  ['f(P) of a constant', { kind: 'comp', value: a, index: 0, arity: 0, functionName: 'p.x' }],
  ['f(P) of floor(x)', { kind: 'comp', value: call('floor', x), index: 0, arity: 2, functionName: 'f' }],
  ['sin(f(P))', call('sin', { kind: 'comp', value: sq(x), index: 0, arity: 2, functionName: 'f' })],
  ['a polygon', { kind: 'figure', form: 'polygon', dimension: 2, vertices: [x, n(0), n(1), y] }],
  [
    'a packed polyline',
    {
      kind: 'figure',
      form: 'polyline',
      dimension: 2,
      vertices: [{ kind: 'var', name: '@a' }, x],
      over: [{ name: '@a', values: Float64Array.of(1, 2.5) }],
    },
  ],
  ['a trail', { kind: 'trail', coordinates: [x, y] }],
  ['a label', { kind: 'label', coordinates: [x, y], text: 'here' }],
  ['a histogram', { kind: 'hist', centers: Float64Array.of(0.5, 1.5), counts: Float64Array.of(2, 1), width: 1 }],
  ['a family', { kind: 'family', members: [sq(x), y] }],
  ['a packed list', { kind: 'data', values: Float64Array.of(1, 2, 3) }],
  ['x + a packed list', bin('+', x, { kind: 'data', values: Float64Array.of(1, 2, 3) })],
  [
    'a lazy list',
    {
      kind: 'lazy',
      cols: [{ name: '@a', values: Float64Array.of(1, 2) }],
      body: bin('*', x, { kind: 'var', name: '@a' }),
    },
  ],
  ['a text column', { kind: 'text', values: ['a', 'b'] }],
  [
    'a loop',
    {
      kind: 'loop',
      params: ['s', 'k'],
      seeds: [x, n(0)],
      body: {
        kind: 'piecewise',
        cases: [{ cond: { kind: 'ineq', op: '>=', l: { kind: 'var', name: 'k' }, r: n(3) }, value: x }],
        otherwise: call(RECUR, sq({ kind: 'var', name: 's' }), bin('+', { kind: 'var', name: 'k' }, n(1))),
      },
      limit: 250,
    },
  ],
];
for (const [src, input] of built) {
  for (const v of ['x', 'y']) {
    const d = record(src, input, v);
    if (d) record(`d/d${v} (${src})`, d, v);
  }
}

const list = [...entries.values()];
writeFileSync(new URL('diff-corpus.json', fixtures), JSON.stringify(list) + '\n');
const errors = list.filter(e => e.error !== undefined);
console.log(`${list.length} derivatives, ${errors.length} errors; left out: ${oversize} too long`);
for (const [message, group] of Object.entries(Object.groupBy(errors, e => `${e.errorType}: ${e.error}`))) {
  console.log(`  ${group!.length}  ${message}`);
}
