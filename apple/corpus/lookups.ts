/**
 * Records what Ask's lookups (lib/assistant-tools.ts) answer, as the fixture
 * the Swift port is held to (apple/EquationCore EquationAssist,
 * LookupConformanceTests): the data the app bundles (apple/tools/app-data.ts)
 * and, over it, every kind, shape and function by each of its names, with
 * the misspellings, plurals, phrases and misses a model sends.
 *
 *   pnpm swift:lookups   (pnpm swift:corpus runs it too)
 */
import { writeFileSync } from 'node:fs';
import {
  KIND_MEANINGS,
  builtinHelp,
  builtinNames,
  functionDoc,
  kindExamples,
  listKinds,
  searchFunctions,
  shape,
} from '../../lib/assistant-tools.ts';
import { DIST_FAMILIES } from '../../lib/dist-families.ts';
import { languageData, lookupData } from '../tools/app-data.ts';

const fixtures = new URL('../EquationCore/Tests/EquationAssistTests/Fixtures/', import.meta.url);
const data = lookupData();

const capital = (s: string) => s.slice(0, 1).toUpperCase() + s.slice(1);
const words = (s: string) => s.split(/\s+/).filter(Boolean);
/** A misspelling: the middle letter gone, two swapped, or two gone. */
const typos = (s: string) => {
  const mid = s.length >> 1;
  return [
    s.slice(0, mid) + s.slice(mid + 1),
    s.slice(0, mid) + s.slice(mid + 1, mid + 2) + s.slice(mid, mid + 1) + s.slice(mid + 2),
    s.slice(0, mid) + s.slice(mid + 2),
    s.slice(1),
    s + 'x',
  ];
};

const kindQueries = [
  ...data.groups.flatMap(g =>
    g.kinds.flatMap(k => [
      k.kind,
      ` ${k.kind}\n`,
      k.kind.toUpperCase(),
      `${k.kind}s`,
      `${k.kind} curve`,
      k.title,
      capital(k.title),
      k.title.toUpperCase(),
      k.short,
      words(k.short)[0],
      words(k.short).slice(0, 2).join(' '),
      KIND_MEANINGS[k.kind],
      words(KIND_MEANINGS[k.kind]).slice(0, 2).join(' '),
      KIND_MEANINGS[k.kind].toUpperCase().slice(0, 12),
      ...typos(k.kind),
      g.name,
    ]),
  ),
  ...['', ' ', 'curve', 'parametric curve', 'surface', '3D', '2d', 'a', 'nothing like this'],
  ...['é', 'e\u0301', '"quoted"'],
];

const shapeNames = data.shapes.flatMap(s => [s.name, ...s.aliases]);
const shapeQueries = [
  ...shapeNames.flatMap(n => [
    n,
    n.toUpperCase(),
    `  ${n}. `,
    `a ${n} of radius 2`,
    `an ${n}`,
    `the ${n}s`,
    `${n}es`,
    `two ${n}es side by side`,
    `draw ${n}, please`,
    `${n}-like`,
    n.replace(/[aeiou]/, c => c + '\u0308'),
    n.replace(/ /g, '_'),
    ...typos(n),
    ...typos(n).map(t => `a big ${t} here`),
    ...words(n),
    ...words(n).map(w => `${w} thing`),
  ]),
  ...['', ' ', '?', 'a', 'the', 'the the', 'an', 'knot', 'lissajous', 'cardiod', 'Möbius', 'mobius', 'blob', 'heart'],
  ...['star', 'sphere of radius 2', 'unit', 'curve', 'with', 'İ', 'ΟΔΟΣ', '😀', 'x^2 + y^2 = 1', 'e', 's', 'es'],
];

const names = builtinNames();
const aliases = DIST_FAMILIES.flatMap(f => [f.name, ...f.aliases]);
const functionQueries = [
  ...[...names, ...aliases].flatMap(n => [
    n,
    `${n}(x)`,
    ` ${n} (a, b) `,
    `${n}\n(x)`,
    n.toUpperCase(),
    n.toLowerCase(),
    capital(n),
    ...typos(n),
  ]),
  ...['', ' ', '(', '()', 'sin(\nx)', 'a\n(b', 'a(\n(b', 'f (x) (y)', 'notafunction', 'constructor', 'toString'],
  ...['__proto__', 'N', 'n', 'Γ', 'ΟΔΟΣ', 'İ', 'ſin', 'sin\u00a0(x)', 'sin\u2028(x)', 'inverse sine', '😀(1)'],
];

const helps = names.flatMap(n => {
  const help = builtinHelp(n);
  return help ? [help] : [];
});
const searchQueries = [
  ...names,
  ...names.map(n => n.toUpperCase()),
  ...names.map(n => `${n}s`),
  ...names.flatMap(n => typos(n).slice(0, 3)),
  ...aliases,
  ...helps.flatMap(h => [
    h.signature,
    h.description,
    words(h.description).slice(0, 2).join(' '),
    words(h.description).slice(-2).join(' '),
    ...words(h.description).filter(w => w.length > 3),
  ]),
  ...['', ' ', 'the of', 'a function', 'inverse sine', 'convex hull', '3D', 'points', 'derivative of a function'],
  ...['area under curves', 'random numbers', 'absolute value', 'matrix determinant', 'sums', 'ss', 'as', 's', 'is'],
  ...['çé', 'naïve', 'sin cos tan', 'x_1', 'ΟΔΟΣ', 'İstanbul', '😀s', '😀', 'integral  from', 'sqrt(', 'log base 2'],
  ...['polygon vertices', 'lists', 'bus', '.*', 'a+b', '[x]', '\\d', 'e\u0301s', 'ǆs', '²s', 'x\u2028y', '_', '__s'],
];

type Case = [tool: string, arg: string, answer: string];
const cases: Case[] = [['list_kinds', '', listKinds(data)]];
const record = (tool: string, queries: string[], answer: (query: string) => string) => {
  for (const query of new Set(queries)) cases.push([tool, query, answer(query)]);
};
record('kind_examples', kindQueries, q => kindExamples(data, q));
record('shape', shapeQueries, q => shape(data, q));
record('function_doc', functionQueries, q => functionDoc(data, q));
record('search_functions', searchQueries, q => searchFunctions(q));

writeFileSync(new URL('assistant.json', fixtures), JSON.stringify(data) + '\n');
writeFileSync(new URL('language.json', fixtures), JSON.stringify(languageData(data)) + '\n');
writeFileSync(new URL('lookups.json', fixtures), JSON.stringify(cases) + '\n');
console.log(`Wrote ${cases.length} lookups for the Swift port`);
