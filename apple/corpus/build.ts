/**
 * Collects what the TypeScript suite asked the parser (record-parses.ts) and
 * the GLSL emitter (record-glsl.ts) into the Swift conformance fixtures: one
 * entry per distinct input, sorted so a re-record diffs cleanly.
 *
 *   pnpm swift:corpus
 */
import { closeSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { type Expr, parseExpr } from '../../lib/expr.ts';
import { GLSL_PRELUDE, declareHelper, shaderTables, toGLSL, uniformName, withHelpers } from '../../lib/glsl.ts';
import { encodePayload } from '../../lib/link.ts';

const out = new URL('./out/', import.meta.url);
const fixtures = new URL('../EquationCore/Tests/EquationCoreTests/Fixtures/', import.meta.url);

/** Each record of the files a recorder wrote, a line at a time. */
function* records<T>(prefix: string): Generator<T> {
  for (const name of readdirSync(out)) {
    if (!name.startsWith(prefix)) continue;
    for (const line of readFileSync(new URL(name, out), 'utf8').split('\n')) if (line) yield JSON.parse(line) as T;
  }
}

// A num node's value is written as text, the way JavaScript prints it: JSON
// has no spelling for a non-finite number or for -0, and Foundation's JSON
// reader rounds a 17-digit number to a neighbouring double now and then.
const replacer = (key: string, value: unknown): unknown =>
  typeof value !== 'number' || (key !== 'value' && key !== 'slopeScale' && Number.isFinite(value))
    ? value
    : Object.is(value, -0)
      ? '-0'
      : String(value);

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sorted = <T>(map: Map<string, T>): T[] => [...map.entries()].sort(([a], [b]) => byText(a, b)).map(([, e]) => e);

interface Entry {
  src: string;
  userFns: string[];
  listNames: string[];
  valueNames: string[];
  expr?: unknown;
  error?: string;
  errorType?: string;
}

const byKey = new Map<string, Entry>();
for (const e of records<Entry>('parses-')) {
  e.userFns.sort();
  e.listNames.sort();
  e.valueNames.sort();
  const key = JSON.stringify([e.src, e.userFns, e.listNames, e.valueNames]);
  const seen = byKey.get(key);
  if (seen && JSON.stringify(seen) !== JSON.stringify(e)) throw new Error(`Nondeterministic parse: ${key}`);
  byKey.set(key, e);
}

const entries = sorted(byKey);
writeFileSync(new URL('parse-corpus.json', fixtures), JSON.stringify(entries, replacer) + '\n');

// Every prefix of every input, as typing produces them: half-written rows are
// where auto-closing brackets and most of the errors live. An input's
// prefixes cost its length squared (each is parsed, and its tree written),
// so a generated one is typed only as far as PREFIX_LIMIT: the suite's
// 57,000-character composition alone would be gigabytes of trees. Each is
// written as it is parsed, so none is held.
const PREFIX_LIMIT = 600;
const prefixFile = openSync(new URL('parse-prefixes.json', fixtures), 'w');
const seenPrefixes = new Set<string>();
let prefixErrors = 0;
for (const e of entries) {
  const units = Math.min(e.src.length, PREFIX_LIMIT + 1);
  for (let n = 1; n < units; n++) {
    const src = e.src.slice(0, n);
    const key = JSON.stringify([src, e.userFns, e.listNames, e.valueNames]);
    if (byKey.has(key) || seenPrefixes.has(key)) continue;
    const input = { src, userFns: e.userFns, listNames: e.listNames, valueNames: e.valueNames };
    let entry: string;
    try {
      const expr = parseExpr(src, new Set(e.userFns), new Set(e.listNames), new Set(e.valueNames));
      entry = JSON.stringify({ ...input, expr }, replacer);
    } catch (err) {
      entry = JSON.stringify({ ...input, error: (err as Error).message, errorType: (err as Error).constructor.name });
      prefixErrors++;
    }
    writeSync(prefixFile, (seenPrefixes.size ? ',' : '[') + entry);
    seenPrefixes.add(key);
  }
}
writeSync(prefixFile, (seenPrefixes.size ? '' : '[') + ']\n');
closeSync(prefixFile);
console.log(`${seenPrefixes.size} prefixes, ${prefixErrors} errors`);

// Share links: each input alone, runs of three as one graph, and the cases
// the codec exists for (a `;` or `%` inside a row, blank rows, unicode).
const sources = entries.map(e => e.src);
const graphs = [
  ...sources.map(s => [s]),
  ...sources.flatMap((_, k) => (k % 3 === 0 ? [sources.slice(k, k + 3)] : [])),
  ['people[people.city == "a;b"]', 'y = x'],
  ['y = 50% x', 'a = 2; b = 3'],
  ['  y = x  ', '', '\t', 'y = sin(x) # a (note)!'],
  ["y = x'", 'θ = π/4', 'f(x) = x² · e^x', '🙂 = 1'],
  [],
];
const links = graphs.map(rows => ({ rows, payload: encodePayload(rows) }));
writeFileSync(new URL('link-corpus.json', fixtures), JSON.stringify(links) + '\n');
console.log(`${links.length} share links`);

const errors = entries.filter(e => e.error !== undefined);
const types = Object.groupBy(errors, e => e.errorType ?? '?');
console.log(`${entries.length} distinct parses, ${errors.length} errors:`);
for (const [type, list] of Object.entries(types)) console.log(`  ${type}: ${list!.length}`);

// The GLSL emitter (lib/glsl.ts): what the suite compiled, and the cases
// below that it has no reason to. `revive` reads back a number the recorder
// wrote as text (a non-finite one, -0).
interface GlslCall {
  fn: 'toGLSL' | 'fourierGraphGLSL' | 'uniformName' | 'declareHelper';
  expr?: unknown;
  p?: string;
  source?: string;
  table?: Array<number | string> | null;
  diffs?: unknown[];
  out?: unknown;
  error?: string;
}
const revive = (text: string): Expr =>
  JSON.parse(text, (key, node: { kind?: string; value?: unknown } | null) =>
    node?.kind === 'num' && typeof node.value === 'string' ? { kind: 'num', value: Number(node.value) } : node,
  );
const packed = (text: string): boolean => text.includes('"[packed]"');

const calls = new Map<string, GlslCall>();
for (const call of records<GlslCall>('glsl-')) {
  const key = JSON.stringify({ ...call, out: undefined, error: undefined, diffs: undefined });
  const seen = calls.get(key);
  // Two packed columns read alike here, and may well compile differently.
  if (seen && !packed(key) && JSON.stringify(seen) !== JSON.stringify(call))
    throw new Error(`Nondeterministic ${call.fn}: ${key.slice(0, 400)}`);
  if (!seen) calls.set(key, call);
}
rmSync(out, { recursive: true });

// What the suite never compiles as it stands: each refusal, the powers on
// either side of every rule, and Fourier sums that are and are not a loop.
const gate = (n: number, value: string): string => `{k >= ${n}: ${value}, 0}`;
const series = [
  gate(1, '2 cos(3 u) + sin(3 u)'),
  gate(2, 'cos(u)'),
  gate(4, '0.5 sin(2.5 u)'),
  gate(7, 'cos(u) + cos(u)'),
];
const sum = series.join(' + ');
const written = [
  ...['1..3', 'L[2]', 'x == 2', 'x != "a"', 'y < x', '(1, 2)', '[1, 2]', '"a"', 'sum(n=1..3, n x)', 'prod(n=1..3, n)'],
  ...['{y: 1}', '{sin(x): 1, 2}', '{0 < x <= y < 3: x, y}', '{x > 0: (1, 2)}', '{x > 0: 1, y < "a": 2}', 'y = x!'],
  ...['x^1', '(x + 1)^1', '2^3', 'x^8', 'x^9', 'x^0', 'x^2.5', '(x y)^2', '(x y)^8', 'x^-2', 'sin(x)^2', 'x^y^2'],
  ...['min(x, y, 1)', 'atan2(y, x) + ln(x) + log(x) + log2(x)', '|x| + -x', 'y = 1000000000000000000000 x - 0.0000001'],
  ...[sum, `1.5 + ${sum}`, `(${sum})^2 + x`, `y = ${sum} + ${gate(9, '3 sin(x)')}`, series.slice(0, 3).join(' + ')],
  ...[`${sum} + ${gate(7, 'cos(u)')}`, `${sum} + ${gate(8, 'cos(u)')} + ${gate(9, 'tan(u)')}`, `x + ${sum}`],
  ...[`${sum} + {j >= 9: cos(u), 0}`, `${sum} + {k >= 9: cos(u), 1}`, `${sum} + {k >= 129: cos(u), 0}`],
  ...[`${sum} + {k >= 8.5: cos(u), 0}`, `${sum} + ${gate(8, '2 cos(3 u) + sin(4 u)')}`, `${sum} + {k > 8: cos(u), 0}`],
];
for (const src of written) {
  const expr = parseExpr(src, new Set(), new Set(['L']));
  const call: GlslCall = { fn: 'toGLSL', expr: JSON.parse(JSON.stringify(expr)) };
  try {
    call.out = toGLSL(expr);
  } catch (err) {
    call.error = (err as Error).message;
  }
  calls.set(JSON.stringify({ fn: call.fn, expr: call.expr }), call);
}
const of = (fn: GlslCall['fn']): GlslCall[] => sorted(calls).filter(c => c.fn === fn);

// Number formatting is JavaScript's String(number), which Swift has to
// reproduce digit for digit: the edges of each notation, then doubles drawn
// across every magnitude, short decimals, and float32 values (a helper's
// coefficient table prints those).
const numbers: number[] = [0, -0, 1, -1, 0.1, 0.5, 1 / 3, 2 / 3, 100, 1e21, 1e-7, 123456789012345680000, NaN];
numbers.push(Infinity, -Infinity, Number.MAX_VALUE, Number.MIN_VALUE, Number.EPSILON, 2 ** 53, 2 ** 53 + 2, 5e-324);
for (let e = -330; e <= 310; e++) for (const m of ['1', '9.999999999999999', '1.5', '4.35']) numbers.push(+`${m}e${e}`);
let seed = 0x2545f491;
const random32 = (): number => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 0;
};
const bits = new DataView(new ArrayBuffer(8));
for (let k = 0; k < 20000; k++) {
  bits.setUint32(0, random32());
  bits.setUint32(4, random32());
  const value = bits.getFloat64(0);
  numbers.push(value, Math.fround(value), +((random32() % 2e6) / 10 ** (random32() % 9)).toPrecision(1 + (k % 9)));
}
const numberCases = numbers.map(value => {
  bits.setFloat64(0, value);
  const hex = bits.getBigUint64(0).toString(16).padStart(16, '0');
  try {
    return { bits: hex, text: String(value), glsl: toGLSL({ kind: 'num', value }) };
  } catch (err) {
    return { bits: hex, text: String(value), error: (err as Error).message };
  }
});

const names = new Set(of('uniformName').map(c => c.p!));
for (const p of ['a', '_a', 'a__b', 'a_b', 'zz', 'zzz', 'z', 'θ', 'T₀', 'A9', '', '🙂', 'x.y', 'a b']) names.add(p);
const uniforms = [...names].sort(byText).map(p => ({ p, out: uniformName(p) }));

// Linking (withHelpers, shaderTables) reads the helpers a process has
// declared, so each case carries what to declare first: the helpers the
// suite declared by hand (lib/complex.ts's loops), and the expressions
// whose compiling declares a Fourier loop. Each links twice: with its
// tables as uniforms, and on a device with no room for them.
const helpers = of('declareHelper').map(c => ({ source: c.source!, table: c.table ?? null, name: c.out as string }));
const helperByName = new Map(helpers.map(h => [h.name, h]));
for (const h of helpers) {
  const name = declareHelper(h.source, h.table ? Float32Array.from(h.table, Number) : undefined);
  if (name !== h.name) throw new Error(`A helper is named ${h.name} in the suite and ${name} here.`);
}
const HELPER_NAME = /\beq_loop_[0-9a-f]+\b/g;
/** The hand-declared helpers `text` reaches, dependencies first; null when
 *  one it names was declared some other way (by compiling an expression). */
function reached(text: string, seen = new Set<string>()): typeof helpers | null {
  const order: typeof helpers = [];
  for (const [name] of text.matchAll(HELPER_NAME)) {
    if (seen.has(name)) continue;
    seen.add(name);
    const helper = helperByName.get(name);
    const inner = helper && reached(helper.source, seen);
    if (!helper || !inner) return null;
    order.push(...inner, helper);
  }
  return order;
}
const linkCases: object[] = [];
function link(declare: typeof helpers, exprs: unknown[], shader: string): void {
  for (const budget of [null, 0]) {
    try {
      const linked = withHelpers(shader, budget ?? Infinity);
      const tables = shaderTables(linked).map(t => ({ name: t.name, values: [...t.values] }));
      linkCases.push({ declare, exprs, shader, budget, out: linked, tables });
    } catch (err) {
      linkCases.push({ declare, exprs, shader, budget, error: (err as Error).message });
    }
  }
}
const field = (code: string): string => `${GLSL_PRELUDE}\nfloat F(float x, float y) { return ${code}; }`;
for (const h of helpers) {
  const declare = reached(h.name);
  if (!declare) continue;
  link(declare, [], field(`${h.name}(x)`));
  // Without the prelude there is nowhere to declare them.
  link(declare, [], `float F(float x, float y) { return ${h.name}(x); }`);
}
for (const call of of('toGLSL')) {
  const text = JSON.stringify(call.expr);
  if (typeof call.out !== 'string' || !call.out.includes('eq_loop_') || packed(text)) continue;
  // Compiling it again here declares its loops in this process.
  if (toGLSL(revive(text)) !== call.out) throw new Error(`Compiled differently here: ${text.slice(0, 400)}`);
  link([], [call.expr], field(call.out));
  link([], [call.expr], `${GLSL_PRELUDE}\n${call.out} + ${call.out}`);
}
// A name is a whole word: none of these is a helper, and the last was never declared.
link([], [], `${GLSL_PRELUDE}\n// xeq_loop_12 eq_loop_12g eq_loop_12_terms eq_loop_ eq_loop_G1`);
link([], [], '// no prelude: eq_loop_ffffffffff');
link([], [], field('eq_loop_ffffffffff(x)'));

const glsl = {
  prelude: GLSL_PRELUDE,
  emits: of('toGLSL').map(({ expr, out: code, error }) => ({ expr, out: code, error })),
  graphs: of('fourierGraphGLSL').map(({ expr, diffs, out: graph, error }) => ({ expr, diffs, out: graph, error })),
  uniforms,
  helpers,
  links: linkCases,
  numbers: numberCases,
};
writeFileSync(new URL('glsl-corpus.json', fixtures), JSON.stringify(glsl, replacer) + '\n');
console.log(
  `${glsl.emits.length} toGLSL calls (${glsl.emits.filter(e => e.error !== undefined).length} errors), ` +
    `${glsl.graphs.length} Fourier graphs, ${uniforms.length} uniform names, ${helpers.length} helpers, ` +
    `${linkCases.length} links, ${numberCases.length} numbers`,
);
