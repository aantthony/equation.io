/**
 * Records what the site makes of documents' syntax colors and row colors, as
 * the Swift conformance fixture for Highlight.swift and Palette.swift: every
 * example in the Examples menu, edge cases, and rows as they are typed.
 *
 *   pnpm swift:highlight
 *
 * Each document carries the names its built definitions bind (what
 * lib/highlight.ts reads of the Env), so the Swift highlighter is held to the
 * site's spans exactly, whatever the state of the definitions port.
 */
import { writeFileSync } from 'node:fs';
import { analyzeRows, prepareDocument } from '../../lib/analysis.ts';
import { DIST_FAMILIES } from '../../lib/dist-families.ts';
import { type Env, lookupValue } from '../../lib/env.ts';
import { CONSTANTS, FUNCTIONS } from '../../lib/expr.ts';
import { highlightSpans } from '../../lib/highlight.ts';
import { DARK_PALETTE, LIGHT_PALETTE, assignColors, takesColor } from '../../lib/palette.ts';
import { noteColor, noteStart, splitStatements } from '../../lib/statements.ts';
import { builtinNames } from '../../lib/assistant-tools.ts';
import { EXAMPLES } from '../../web/examples.ts';

const fixtures = new URL('../EquationCore/Tests/EquationCoreTests/Fixtures/', import.meta.url);

/** Documents the examples don't cover: one per line, rows separated by `;;`. */
const EDGE_DOCUMENTS = `
y = x^2 # parabola
y = x^2 #e24
y = x^2 #1f77b4 the blue one;;y = 2x #bad;;y = 3x #100;;y = 4x # fed;;y = 5x #12345
# a heading;;  # an indented heading;;y = sin(x)
y = sin(x) + "# not a note" # but this is
a = 2;;y = a x;;y = b x
f(x) = x^2;;g(x, k) = k f(x);;y = g(x, 3);;y = h(x)
f(x) = x^2;;y = f'(x);;y = f''(x) + f(x)'
T₀ = 300;;y = T₀ x + T_0;;θ₁₂ = 2;;y = θ₁₂ + θ_12
α = 2;;β = α^2;;y = α x + β;;Δx = 0.1;;y = Δx + δ
y = πx + 2π r;;y = ∞;;Σ(n=1..5, n);;∑(k=1..3, k^2);;∏(k=1..3, k);;∫(x, 0..1);;∇(x y)
τ = 2π;;y = sin(τ x);;µ = 3;;y = µ x
y = x² + x³ - x⁻¹;;y = 2x¹⁰
A = (1, 2);;B = (3, 4);;A.x + B.y;;A_x + B_y;;C.x;;segment(A, B)
P = (1, 2, 3);;P.z + P_z;;|P|
person = open("people.csv");;y = person.age;;mean(person.height);;other.col
L = [1, 2, 3];;mean(L);;L[2];;total(L);;y = L x
mean = [1, 2];;mean;;mean(3)
total = 3;;y = total(x + 1);;count = 2;;count
a_n = 1/n;;a_3;;a_k;;y = a_n
a_{n+1} = a_n / 2;;a_0 = 1;;a_{n};;b_{n+1} = b_n + a_n;;b_0 = 0
a_j = 1/j^2;;T_c = 300;;k_B = 1.38;;y = T_c x + k_B
c_{n+1}[i] = c_n[i-1] + c_n[i+1];;c_0[i] = {i = 0: 1, 0}
X ~ Normal(0, 1);;Y ~ N(2, 3);;Z = X + Y;;P(X > 1);;E(Z);;n + N;;Uniform;;U ~ Uniform(0, 1)
y = Sin(x) + COS(x) + sIn;;y = sin + cos x
x' = y;;y' = -x;;a' = -a;;a(0) = 1;;r' = (1, 2);;r(0) = (0, 0);;y = a + r_1
p = "text" + 'more';;q = 'unclosed;;r = "also unclosed
f'(x) + a' + x'';;y = f(x)' ;;(x)'a'
1..N;;[1..5];;sum(n=1..10, n);;0..1;;.5 + 0.5 + 5. + 1.2.3;;[.5..2]
x <= y;;x >= y;;a := 3;;x ≤ y ≥ z ≠ w;;p ∈ L;;X ~ Normal;;y == x;;{x > 0: x, 2}
view(-1, 1, -1, 1);;camera(1, 2, 3);;grid(polar);;on(S);;grid(x) = x^2;;y = grid(x);;view = 3;;View(0, 1)
---;;--- right 40%;;--- x;;---x;;----;;--- inset top left;;--- bogus;;--- shared x
e = 2;;i = 3;;pi = 4;;d = 5;;x = 2;;inf;;e_x + e_y + e_z + e_xy + e_xyz + e_w
d/dx x^2;;dy/dx = y;;int(x^2, dx);;dx + dy + dz + dt + du + dv + dw + da + d
z = x + i y;;w^2;;u + v;;(cos(u), sin(u));;(u, v, u v)
u = interval(0, 2pi);;v = interval(0, pi);;(u, v, 1);;I = interval(0, 1)
sum[n=1..N] n;;prod(k=1..N, k);;[j = 1..3] j;;N = 5
y = (;;y = sin(;;f(x =;;f(x, =;;a =;;= 3;;y = "
y = x == 2;;f(x) == 3;;a == b
M = [[1, 2], [3, 4]];;det(M);;M[1];;transpose(M) v
a = b;;b = c;;c = a
a = 1;;a = 2;;y = a
k = 3 # slider;;y = k x # line through the origin;;# note = 2
   y = x   ;;	y = 2x;;y  =  3 x
y = 🙂 + x;;名前 = 3;;y = x · 2;;y = x × 3;;y = é
A = (1, 2);;A = (3, 4);;(1, 2);;(1, 2) # dot;;B = (t, 2)
sin;;sin(;;sin (x);;f (x);;N (0, 1);;P (X);;view (1)
r = sqrt(x^2 + y^2);;r = 2;;theta = atan2(y, x);;r = 1 + cos(theta)
x_1 = 2;;y = x_1 + x_2;;v_x = 3;;u_time
a := 2;;f(x) := x^2;;y = f(x) + a;;b' := -b;;b(0) := 1;;A := (1, 2);;A.x
e := 0.6;;y = e x + e^x;;pi := 3;;y = sin(pi x) + π;;2e
i := 3;;w := x - y;;t := 2;;y = i x + w + t;;e + pi
f(e) := e^2;;f(3) + e;;g(i, t) := i t;;x := 3;;e(x) := x
a_n := n^2;;a_3;;b_0 := 1;;b_{n+1} := 2 b_n;;X ~ Normal(0, 1);;Y := 2X
label((0, 0), "a := b");;y = 1 + (a := 2);;a := "x := y";;c :=;;:= 2
`
  .trim()
  .split('\n')
  .map(line => line.split(';;'));

/** Rows typed a character at a time, alone and under a few definitions. */
const TYPED: { above: string[]; row: string }[] = [
  { above: [], row: 'y = sin(2πx) + a_n x² # wave' },
  { above: ['f(x) = x^2', 'a = 2', 'A = (1, 2)'], row: "g(x, k) = k f'(x) + a A.x + A_y - 'text' #e24 note" },
  { above: ['a_{n+1} = a_n / 2', 'a_0 = 1'], row: 'b_{n+1} = b_n + a_n + sum(k=1..n, a_k)' },
  { above: ['L = [1, 2, 3]'], row: 'T₀ = mean(L) + θ₁ ≤ 1..N' },
  { above: ['X ~ Normal(0, 1)'], row: 'P(X > 1.5) + E(X) ~ Uniform(0, 1)' },
  { above: [], row: 'view(-10, 10, -10, 10)' },
  { above: [], row: '--- right 40% shared x' },
  { above: [], row: 'person = open("people.csv", 3a7f9c21)' },
];

interface Names {
  values: string[];
  functions: string[];
  sequences: { name: string; index: string; cell?: string; cell2?: string }[];
}

/** What lib/highlight.ts reads of the definitions: which names are bound, which of them are functions, and the
 *  document's sequences. */
function namesOf(env: Env): Names {
  const values: string[] = [];
  const functions: string[] = [];
  for (const name of env.names.keys()) (lookupValue(env, name)?.tag === 'fn' ? functions : values).push(name);
  const sequences = [...env.sequences.values()].map(({ name, index, cell, cell2 }) => ({ name, index, cell, cell2 }));
  return { values: values.sort(), functions: functions.sort(), sequences };
}

/** web/main.ts rowSpans: a row whose colors throw has none. */
function rowSpans(text: string, env: Env): unknown[] {
  try {
    return highlightSpans(text, env).map(({ start, end, cls, name, called }) => ({ start, end, cls, name, called }));
  } catch {
    return [];
  }
}

function highlighted(name: string, rows: string[]) {
  const env = prepareDocument(rows).defs;
  return {
    name,
    rows,
    names: namesOf(env),
    spans: rows.map(text => rowSpans(text, env)),
    notes: rows.map(noteStart),
    noteColors: rows.map(noteColor),
  };
}

/** Each row's color facts and slot, as the site gives a freshly loaded document (web/main.ts recompileAll). */
function colored(rows: string[]) {
  const analysis = analyzeRows(rows);
  const facts = analysis.rows.map((row, i) => ({
    text: rows[i],
    comment: !!row.comment,
    def: !!row.def,
    point: row.def?.kind === 'const' && analysis.defs.points.has(row.def.name),
    view: !!row.view,
    plan: row.cpu?.type ?? null,
    shade: row.cpu?.type === 'value' && !!row.cpu.shade,
  }));
  const takes = analysis.rows.map((row, i) =>
    takesColor({
      text: rows[i],
      comment: row.comment,
      def: row.def,
      point: facts[i].point,
      view: row.view,
      cpu: row.cpu,
    }),
  );
  const slots = rows.map(() => ({ colorIndex: -1 }));
  assignColors(slots, takes, LIGHT_PALETTE.length);
  return { facts, takes, slots: slots.map(s => s.colorIndex) };
}

const documents: unknown[] = [];
for (const [category, examples] of EXAMPLES) {
  for (const [name, text] of examples) {
    const rows = splitStatements(text)
      .map(s => s.trim())
      .filter(Boolean);
    documents.push({ ...highlighted(`${category}: ${name}`, rows), colors: colored(rows) });
    // The last row as it was typed, a few characters at a time, under the rows above it.
    const last = rows.at(-1) ?? '';
    for (let n = 1; n < last.length; n += 3) {
      const typing = [...rows.slice(0, -1), last.slice(0, n)];
      documents.push(highlighted(`typing ${category}: ${name} (${n})`, typing));
    }
  }
}
for (const rows of [[], [''], ['', '   ', 'y = x', ''], ...EDGE_DOCUMENTS]) {
  documents.push({ ...highlighted(`edge: ${rows.join('; ')}`, rows), colors: colored(rows) });
}
for (const { above, row } of TYPED) {
  for (let n = 1; n <= row.length; n++) {
    const rows = [...above, row.slice(0, n)];
    documents.push(highlighted(`typed: ${rows.join('; ')}`, rows));
  }
}

/** Slot assignment over documents mid-edit: rows already colored, rows that stopped taking a color, new rows. */
function assignments(): unknown[] {
  let seed = 0x9e3779b9;
  const random = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const cases: unknown[] = [];
  for (let k = 0; k < 400; k++) {
    const size = k % 5 === 0 ? 1 + Math.floor(random() * 8) : LIGHT_PALETTE.length;
    const length = Math.floor(random() * 16);
    // Slots out of range (a palette that shrank) are cleared like any row that takes none.
    const before = Array.from({ length }, () => (random() < 0.5 ? -1 : Math.floor(random() * (size + 2))));
    const takes = Array.from({ length }, () => random() < 0.75);
    const rows = before.map(colorIndex => ({ colorIndex }));
    assignColors(rows, takes, size);
    cases.push({ before, takes, size, after: rows.map(r => r.colorIndex) });
  }
  return cases;
}

const fixture = {
  tables: {
    functions: [...FUNCTIONS].sort(),
    callForms: builtinNames()
      .filter(n => !FUNCTIONS.has(n))
      .sort(),
    distributions: DIST_FAMILIES.flatMap(f => [f.name, ...f.aliases])
      .map(n => n.toLowerCase())
      .sort(),
    constants: Object.keys(CONSTANTS).sort(),
    lightPalette: LIGHT_PALETTE,
    darkPalette: DARK_PALETTE,
  },
  documents,
  assignments: assignments(),
};
writeFileSync(new URL('highlight.json', fixtures), JSON.stringify(fixture) + '\n');
console.log(`${documents.length} documents, ${fixture.assignments.length} assignments`);
