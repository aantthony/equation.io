/**
 * Records what `check` answers (lib/assistant-tools.ts checkRows, the row
 * report get_graph and set_graph give too) for every example in the menu and
 * a set of documents written for it, so the Swift port
 * (EquationRender/RowReport.swift, which the app's Ask answers with) is held
 * to the same words: the Ask evals read them.
 *
 *   node --experimental-transform-types --no-warnings apple/corpus/reports.ts
 */
import { writeFileSync } from 'node:fs';
import { KIND_MEANINGS, checkRows } from '../../lib/assistant-tools.ts';
import { splitStatements } from '../../lib/statements.ts';
import { EXAMPLES } from '../../web/examples.ts';

/** Documents for what the examples do not say: errors and their hints, warnings, values, every definition. */
const CASES: string[] = [
  'a = 1; y = a sin(x); b = 2; surface(x)',
  'z = x y; y < x',
  'f(x) = surface(x); y = f(x)',
  'y = foo(x)',
  'y = foo x',
  'a = 2; b = 3; y = 2ab x',
  'a = 2; b = 3; c = ab; y = c x',
  'a = 2; y = tan(x)',
  'a = 2 # the slope; y = a x # a line',
  'k = 3; "k" = 4',
  'f(x) = x^2',
  'f(x) = x^2; y = f(x)',
  'g(x, y) = x y; g(x, y) = 1',
  'A = (1, 2)',
  'A = (1, 2, 3)',
  'A = (1, 2); B = (3, 4); segment(A, B)',
  'a = sin(t); y = a x',
  'a = 3; b = a + 1; y = b',
  'a = 3; b = a + 1',
  'M = ((1, 2), (3, 4)); action(M)',
  'L = [1, 2, 3]; L',
  'L = [1..5]; y = L x',
  's = interval(0, 1); (s, s^2)',
  "th' = om; om' = -sin(th); th(0) = 3; (th, om)",
  "r' = (r_2, -r_1); r(0) = (1, 0); r",
  'w = 1 + 2i; w',
  'r = sqrt(x^2 + y^2); r = 2',
  '# heading; y = x; view(x = -1..1, y = -1..1); grid(off); ---; y = x^2',
  'camera(0, 0.5, 10); z = x^2 + y^2',
  'z = x^2 + y^2; y = sin(x); y > x; (1, 2); [1, 2, 3]',
  'y = sin(x - t)',
  '2 + 3',
  'sin(pi/6) > 0.4',
  'X ~ Normal(0, 1); P(X > 1); E(X)',
  'N ~ Binomial(10, 0.3); P(N = 3)',
  'a_{n+1} = a_n/2 + 1; a_0 = 1',
  'a_n = 1/n^2',
  '(cos(t), sin(t))',
  'trail((cos(t), sin(2t)))',
  'x^2 + y^2 = c; c = 4',
  '(y, -x)',
  '(y, -x, z)',
  'y = x +',
  'y = (x',
  '',
  'n = 5; sum(k, 1, n, k^2)',
  'a = [1..33]; y = a x',
  'y = a x',
];

const docs = [
  ...EXAMPLES.flatMap(([category, items]) => items.map(([label, text]) => ({ name: `${category} / ${label}`, text }))),
  ...CASES.map((text, k) => ({ name: `case ${k + 1}`, text })),
];
const recorded = docs.map(({ name, text }) => {
  // As set_graph and check take them: trimmed, the empty ones dropped.
  const rows = splitStatements(text)
    .map(r => r.trim())
    .filter(Boolean);
  return { name, rows, report: checkRows(rows) };
});
writeFileSync(
  new URL('../EquationCore/Tests/EquationRenderTests/Scenes/reports.json', import.meta.url),
  JSON.stringify({ meanings: KIND_MEANINGS, documents: recorded }) + '\n',
);
console.log(`${recorded.length} documents' row reports`);
