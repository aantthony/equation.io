/**
 * The Apple app's Ask tools that answer from the language, not the graph
 * (apple/Equation Assistant.swift): check, search_functions, function_doc,
 * list_kinds, kind_examples and shape. The evals' service (apple/evals)
 * answers them with this code; the app answers the lookups (all but check)
 * with a Swift port held to this code's answers (apple/EquationCore
 * EquationAssist, apple/corpus/lookups.ts), so a change here is a change
 * there. Every answer is short: the on-device model has 8K tokens.
 * The kinds, forms, examples and notes they answer from are the reference's
 * (docs/reference, lib/reference.ts assistantData), which the app bundles as
 * assistant.json (apple/tools/app-data.ts).
 *
 * Also here: a row's status and meaning from the analyzer alone, as the
 * app's get_graph reports it, which check answers with and the evals' graph
 * reports.
 */
import { type Analysis, type RowInfo, analyzeRows } from './analysis.ts';
import { mvOfNode } from './clifford.ts';
import type { CpuPlan } from './compiler.ts';
import { type Definition, animatedConstNames, definitionDependencies } from './defs.ts';
import { canonicalName } from './expr.ts';
import type { PublicKind } from './math-object.ts';
import { publicKind } from './plot.ts';
import { LOOKUP_HINT, type Variant } from './assistant-instructions.ts';
import type { AssistantData, LabelledRows } from './reference.ts';
import { rowKind } from './row-kind.ts';
import { sliderForm } from './slider.ts';
import { splitStatements, stripNote } from './statements.ts';
import { builtinHelp, builtinNames } from './syntax-help.ts';

// MARK: rows, as get_graph and check describe them

/** What each drawn row kind looks like, in words: kind names like
 *  `implicit2d` are the MCP's public vocabulary, not words a model can reason
 *  about. The Record keeps it total: a new kind fails the typecheck here. */
export const KIND_MEANINGS: Record<PublicKind, string> = {
  implicit2d: '2D curve (the set of points satisfying an equation)',
  ineq2d: 'shaded 2D region (an inequality)',
  scalar2d: '2D scalar field, shaded by sign and size (row colour positive, its complement negative)',
  scalar3d:
    '3D scalar field, drawn as a translucent cloud denser where the field is larger in size (row colour positive, its complement negative)',
  implicit3d: '3D surface (the points satisfying an equation in x, y, z)',
  spacecurve: '3D curve where surfaces intersect',
  pcurve: 'parametric curve, traced as u runs from 0 to 1',
  psurface: 'parametric surface over u and v in 0..1',
  pregion: 'filled 2D region traced by two parameters (u, v, or intervals), each over its range',
  solid: 'solid in 3D filled by three parameters (u, v, or intervals), drawn as the faces of their range',
  projected2d: 'shaded 2D region swept by a family over an interval, like y = sin(a x) for a = interval(1, 2)',
  vfield2d: '2D vector field, drawn as flowing streamlines',
  tfield2d:
    '2D matrix (tensor) field, drawn as a grid of glyphs: each the image of a small circle under the matrix, with a spoke where e_x goes; streamlines(M), or a toggle, traces its major eigenvector instead',
  vfield3d: '3D vector field',
  point: 'a point',
  polygon: 'geometric figure (segment, polyline, vector arrow, polygon, circle, …)',
  label: 'text label at a point',
  trail: 'motion trail behind a moving point',
  orbit: 'path of a simulated state over a time range',
  geodesic: 'geodesic of a parametric surface from a start point in a direction, integrated along the surface',
  system: 'solutions of a system of equations (points or curves)',
  value:
    'number readout under the row; draws nothing on the graph, except a definite integral, which shades the area it measures',
  note: 'true/false readout under the row; draws nothing on the graph',
  tuple: 'tuple of more than 3 numbers, like sort(L) of 5 values: a readout under the row; draws nothing',
  family: 'one copy of the row per list element',
  multivector:
    'multivector or quaternion, like e_xy or quat(1, 2, 3, 4): its grades drawn as arrows, oriented discs and cubes (a rotor as the turn it makes), its value read out',
  flat: "point, line or plane of projective geometry, like join(A, B) or meet(L, M): drawn, with its equation (or an ideal point's direction) read out",
  action: 'action(M): where a matrix sends the unit square, circle and axes, with the matrix read out',
  complex2d: 'complex function shown on the plane',
  domain2d: 'domain colouring of a complex function',
  conformal2d: 'conformal map: the image of a grid under a complex function',
  fractal2d: 'escape-time fractal',
  rgb2d: 'colour field (RGB), filling the plane',
  hsl2d: 'colour field (HSL), filling the plane',
  oklch2d: 'colour field (OKLCH), filling the plane',
  sequence: 'sequence, drawn as dots at whole numbers n',
  cobweb: 'cobweb diagram of a recurrence',
  bifurcation: 'bifurcation / orbit diagram of a recurrence',
  vlist: 'list of numbers, a dot plot on the number line: each value at x = value, copies stacked upward',
  plist: 'list of points',
  dlist: 'data column, a dot plot on the number line: each value at x = value, copies stacked upward',
  dscatter: 'scatter plot of data',
  histogram: 'histogram',
  automaton:
    'cellular automaton on the integer lattice: a 1D rule draws its space-time diagram (cells across, steps down), a 2D rule one generation of its board, stepping with t',
  graph:
    'graph drawn node-link: one arrow per (from, to) element, parallel edges counted, labels on edges; laid out automatically',
  lattice: 'table of values on the integer lattice, one cell per (i, j), shaded by value and printed when zoomed in',
  density: 'probability density curve of a random variable',
  pmf: 'probability mass function (stems) of a discrete random variable',
  prob: 'probability, shaded under the density, with its value as a readout',
  expect: 'expected value readout, marked on the density',
};

/** 2D-only plots a 3D scene leaves out (web/main.ts SKIPPED_IN_3D). */
export const SKIPPED_IN_3D: ReadonlySet<CpuPlan['type']> = new Set([
  'scalar2d',
  'complex2d',
  'domain2d',
  'rgb2d',
  'hsl2d',
  'oklch2d',
  'conformal2d',
  'fractal2d',
  'ineq2d',
  'projected2d',
  'vfield2d',
  'tfield2d',
  'vlist',
  'dlist',
  'histogram',
  'sequence',
  'cobweb',
  'bifurcation',
  'automaton',
  'lattice',
  'graph',
  'density',
  'pmf',
  'prob',
  'expect',
]);

/** What get_graph says about one row, less what needs the renderer (its color and intercepts). */
export interface RowReport {
  status: 'ok' | 'error';
  error?: string;
  hint?: string;
  kind?: string;
  meaning?: string;
  value?: string;
  animated?: boolean;
  warning?: string;
}

const round6 = (v: number) => parseFloat(v.toPrecision(6));

/** Whether the graph draws in 3D: some row needs it. */
export const is3D = (analysis: Analysis): boolean => analysis.rows.some(r => !r.error && r.cls?.needs3D);

/** web/main.ts sliderOf: the slider a row's definition makes, if any. */
export function sliderOf(analysis: Analysis, eq: RowInfo) {
  const def = eq.def;
  if ((def?.kind !== 'const' && def?.kind !== 'init') || eq.error || (def.kind === 'const' && def.draw)) return null;
  const rhs = def.rhs.trim();
  const form = sliderForm(rhs, new Set(analysis.defs.fns.keys()));
  return form ? { def, rhs, form } : null;
}

/** Row `index` of `texts`, as web/main.ts rowStatus reports it; a hint names the `variant`'s lookup. */
export function describeRow(
  analysis: Analysis,
  texts: readonly string[],
  index: number,
  variant: Variant = 'text',
): RowReport {
  const eq = analysis.rows[index];
  const text = texts[index];
  const { defs } = analysis;
  if (eq.error) {
    const row: RowReport = { status: 'error', error: eq.error };
    // `surface((…))` fails as an unknown *variable* times a bracket: name the real problem.
    const unknown = /^Unknown variable: (\w+)\./.exec(eq.error)?.[1];
    const call = unknown && new RegExp(`(?<![\\w])${unknown}\\s*\\(`);
    const fns = analysis.rows.filter(o => o.def?.kind === 'fn').map(o => o.text);
    if (call && [text, ...fns].some(t => call.test(stripNote(t)))) {
      row.hint = `${unknown}(…) is not a built-in function; ${LOOKUP_HINT[variant]}`;
    }
    return row;
  }
  const row: RowReport = { status: 'ok' };
  if (!text.trim()) return row;
  row.kind = rowKind(eq, defs);
  const animated = animatedConstNames(defs);
  row.meaning = eq.comment
    ? 'group heading; draws nothing'
    : eq.def
      ? definitionMeaning(analysis, eq.def, eq, animated)
      : eq.view
        ? {
            view: 'sets the 2D window',
            camera: 'sets the 3D camera',
            grid: "sets what draws behind its panel's plots",
            split: 'starts a new panel; the rows below it draw there',
            surface: "draws its panel's 2D rows on a surface in space",
          }[eq.view.kind]
        : eq.dist
          ? row.kind
          : eq.cls
            ? KIND_MEANINGS[publicKind(eq.cls.object)] +
              (eq.cls.needs3D && !KIND_MEANINGS[publicKind(eq.cls.object)].includes('3D') ? ' (in 3D)' : '') +
              (eq.cls.animated ? '; moves with time t' : '')
            : undefined;
  const members = eq.cpu?.type === 'family' ? eq.cpu.members.map(m => m.cpu) : eq.cpu ? [eq.cpu] : [];
  if (is3D(analysis) && !!eq.cls && !eq.def && members.every(m => SKIPPED_IN_3D.has(m.type))) {
    row.warning = 'not drawn: another row makes this graph 3D, and a 3D scene leaves out 2D-only plots like this one';
  }
  if (eq.info) row.value = eq.info;
  else if (eq.def?.kind === 'const' && analysis.constEnv[eq.def.name] !== undefined)
    row.value = String(round6(analysis.constEnv[eq.def.name]));
  if (eq.cls?.animated) row.animated = true;
  const def = eq.def;
  if (
    (def?.kind === 'const' || def?.kind === 'fn') &&
    !defs.points.has(def.name) &&
    !usedElsewhere(analysis, texts, index, def.name)
  ) {
    row.warning = `this defines ${def.name}, but no other row uses it, so nothing is drawn`;
  }
  return row;
}

/** web/main.ts usedElsewhere: whether any other row reads `name`. */
function usedElsewhere(analysis: Analysis, texts: readonly string[], index: number, name: string): boolean {
  const others = analysis.rows.filter((other, i) => i !== index && !other.comment && !other.view);
  const read = definitionDependencies(
    others.flatMap(other => other.cls?.params ?? []),
    analysis.defs,
  );
  if (read.has(name)) return true;
  const word = new RegExp(`(?<![\\p{L}_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'u');
  return texts
    .filter((_, i) => i !== index && !analysis.rows[i].comment && !analysis.rows[i].view)
    .some(other => word.test(canonicalName(stripNote(other).replace(/"[^"]*"/g, '""'))));
}

/** web/main.ts definitionMeaning: what a definition row makes. */
function definitionMeaning(analysis: Analysis, def: Definition, eq: RowInfo, animated: ReadonlySet<string>): string {
  const { name } = def;
  const { defs } = analysis;
  switch (def.kind) {
    case 'init':
      return `sets where the state ${name} starts (its value at t = 0)`;
    case 'table':
      return `opens the data file ${def.file} as the table ${name}`;
    case 'regression':
      return `fits the model ${def.lhs} ~ ${def.rhs} to data, defining its parameters`;
    case 'fn':
      return `defines the function ${name}(${def.params.join(', ')}); draws nothing until another row uses it${
        def.params.length === 1 && def.params[0] === 'x' ? `, e.g. y = ${name}(x)` : ''
      }`;
  }
  const entry = defs.names.get(name);
  const b = entry?.kind === 'binding' ? entry.binding : undefined;
  const quiet = '; draws nothing by itself';
  if (!b) return `defines ${name}${quiet}`;
  switch (b.tag) {
    case 'scalar':
      if (b.role === 'state')
        return `defines ${name}: a scalar state, integrated forward in time from its derivative${quiet}`;
      if (b.role === 'complex') return `defines ${name}: a complex number${quiet}`;
      if (b.role === 'condition') return `defines ${name}: a condition, read in braces like {${name}: 1}${quiet}`;
      if (b.role === 'field')
        return `defines ${name}: a scalar field (a value at every point, e.g. a coordinate like r or theta)${quiet}`;
      if (sliderOf(analysis, eq)) return `defines ${name}: a scalar constant with a slider${quiet}`;
      return `defines ${name}: a scalar constant${animated.has(name) ? ' that changes with time (t)' : ''}${quiet}`;
    case 'vector': {
      const dim = b.role === 'state' ? b.init.length : b.components.length;
      if (b.role === 'state')
        return `defines ${name}: a ${dim}D vector state, integrated forward in time from its derivative${quiet}; a row "${name}" draws it as a moving point`;
      if (b.role === 'field') return `defines ${name}: a ${dim}D vector field${quiet}`;
      return defs.points.has(name)
        ? `defines ${name}: a named ${dim}D point, drawn on the graph`
        : `defines ${name}: a ${dim}D vector${quiet}`;
    }
    case 'fn':
      return `defines the function ${name}${quiet}`;
    case 'matrix':
      return `defines ${name}: a matrix${quiet}`;
    case 'tensor':
      return `defines ${name}: a ${b.tensor.shape.join('×')} tensor${quiet}`;
    case 'seq':
      return `defines ${name}: a list${quiet}`;
    case 'table':
      return `defines ${name}: a data table${quiet}`;
    case 'rv':
      return `defines ${name}: a random variable`;
    case 'missing':
      return `defines ${name} from a data file that is not on this device`;
    case 'multivector':
      return `defines ${name}: a ${mvOfNode(b.value)?.quat ? 'quaternion' : 'multivector'}${quiet}`;
    case 'interval':
      return `defines ${name}: a continuous interval, one hidden parameter shared by every row that uses ${name}${quiet}`;
  }
}

// MARK: check

export interface CheckedRow {
  row: string;
  kind?: string;
  meaning?: string;
  value?: string;
  error?: string;
  hint?: string;
  warning?: string;
}

/**
 * check(rows): what these rows would draw, without drawing them. The same
 * reading set_graph gives back, less the colors.
 */
export function checkRows(rows: readonly string[], variant: Variant = 'text'): CheckedRow[] {
  const texts = rows.map(r => r.trim()).filter(Boolean);
  const analysis = analyzeRows(texts, { readouts: true });
  return texts.map((row, i) => {
    const { kind, meaning, value, error, hint, warning } = describeRow(analysis, texts, i, variant);
    return { row, kind, meaning, value, error, hint, warning };
  });
}

// MARK: kinds

const DIST_KINDS = { density: 'density', pmf: 'pmf', probability: 'prob', expectation: 'expect' } as const;

/** The render kind a row draws as, by KIND_MEANINGS' names; undefined for definitions and the like. */
export function kindOf(row: RowInfo): PublicKind | undefined {
  if (row.error || row.def || row.comment || row.view) return undefined;
  if (row.dist) return DIST_KINDS[row.dist];
  return row.cls ? publicKind(row.cls.object) : undefined;
}

/**
 * list_kinds: every kind; the common ones with their smallest form and a few
 * words, the rest by topic (the reference's groups, docs/reference/index.md).
 */
export function listKinds(data: AssistantData): string {
  return [
    'One shape per row. kind: smallest form (; separates rows) | what it draws',
    ...data.groups.filter(g => !g.brief).flatMap(g => g.kinds.map(k => `${k.kind}: ${k.form} | ${k.short}`)),
    'Definitions draw nothing themselves: a = 2 (a slider), f(x) = x^2 (add y = f(x) to draw it), A = (1, 2) (a draggable point).',
    'More kinds:',
    ...data.groups.filter(g => g.brief).map(g => `${g.name.toLowerCase()}: ${g.kinds.map(k => k.kind).join(', ')}`),
    'kind_examples(kind) gives any kind with worked examples.',
  ].join('\n');
}

/** The examples menu's examples, by the kinds they draw and the functions they call (examplesIndex). */
export interface ExamplesIndex {
  kinds: Record<string, LabelledRows[]>;
  functions: Record<string, LabelledRows[]>;
}

/** Longest example (its rows' text) worth showing a model with 8K tokens. */
const EXAMPLE_CHARS = 200;

/**
 * Index the examples menu (web/examples.ts) by what each example draws: the
 * analyzer labels every row with its kind, and each kind keeps the examples
 * with the fewest rows, the menu's order (simplest first) breaking ties, and
 * one in 2D and one in 3D where the kind draws in both (a helix beside the
 * plane curves). Each function, likewise, the examples that call it.
 * Viewport rows and headings are left out: the model frames with move_view.
 */
export function examplesIndex(examples: Iterable<readonly [label: string, text: string]>, per = 3): ExamplesIndex {
  type Example = { label: string; rows: string[]; in3D?: boolean };
  const byKind = new Map<string, Example[]>();
  const byFunction = new Map<string, Example[]>();
  const names = builtinNames().filter(name => /^[a-z]\w*$/.test(name));
  for (const [label, text] of examples) {
    const all = splitStatements(text)
      .map(s => s.trim())
      .filter(Boolean);
    const analysis = analyzeRows(all);
    if (analysis.rows.some(r => r.error)) continue;
    const rows = all.filter((_, i) => !analysis.rows[i].view && !analysis.rows[i].comment);
    if (!rows.length || rows.length > 8 || rows.join('; ').length > EXAMPLE_CHARS) continue;
    const entry = { label, rows };
    for (const kind of new Set(analysis.rows.map(kindOf))) {
      const in3D = analysis.rows.some(r => kindOf(r) === kind && r.cls?.needs3D);
      if (kind) byKind.set(kind, [...(byKind.get(kind) ?? []), { ...entry, in3D }]);
    }
    const body = rows.map(r => stripNote(r).replace(/"[^"]*"/g, '""')).join('\n');
    for (const name of names) {
      if (new RegExp(`(?<![\\w.])${name}\\s*\\(`).test(body))
        byFunction.set(name, [...(byFunction.get(name) ?? []), entry]);
    }
  }
  const pick = (list: Example[], n: number) => {
    const sorted = list.sort((a, b) => a.rows.length - b.rows.length);
    const other = sorted.find(e => e.in3D !== sorted[0].in3D);
    const chosen = [sorted[0], ...(other ? [other] : [])];
    return [...chosen, ...sorted.filter(e => !chosen.includes(e))]
      .slice(0, n)
      .map(({ label, rows }) => ({ label, rows }));
  };
  const index = (map: Map<string, Example[]>, n: number) =>
    Object.fromEntries([...map].map(([key, list]) => [key, pick(list, n)]));
  return { kinds: index(byKind, per), functions: index(byFunction, 2) };
}

// The rows first and the label after: a label first ("solid cube: […]") was copied into a row.
const exampleLines = (list: LabelledRows[] = []) =>
  list.map(({ label, rows }) => `- ${JSON.stringify(rows)} (${label})`);

/** The kind a model means: a name from list_kinds or the instructions, or a kind as get_graph reports it ("pcurve", "parametric curve"). */
function findKind(data: AssistantData, query: string) {
  const q = query.trim().toLowerCase();
  const kinds = data.groups.flatMap(g => g.kinds);
  return (
    kinds.find(k => k.kind === q) ??
    kinds.find(k => k.title.toLowerCase() === q) ??
    kinds.find(k => q.startsWith(k.kind)) ??
    kinds.find(k => k.short.toLowerCase().startsWith(q) || KIND_MEANINGS[k.kind].toLowerCase().startsWith(q))
  );
}

/** kind_examples(kind): what a kind draws, its smallest form, and worked examples, each a whole graph. */
export function kindExamples(data: AssistantData, query: string): string {
  const found = findKind(data, query);
  if (!found) return `No kind "${query}". Kinds: ${data.groups.flatMap(g => g.kinds.map(k => k.kind)).join(', ')}.`;
  const { kind, form } = found;
  return [
    `${kind}: ${KIND_MEANINGS[kind]}`,
    `smallest: ${JSON.stringify(splitStatements(form).map(s => s.trim()))}`,
    ...(data.kinds[kind]?.length ? ['examples (each a whole graph, one entry per row):'] : []),
    ...exampleLines(data.kinds[kind]),
  ].join('\n');
}

// MARK: functions

const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'and', 'or', 'for', 'with', 'function', 'by']);

/** search_functions(query): the built-in functions that best match a few words, a line each. */
export function searchFunctions(query: string, limit = 6): string {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(w => w && !STOP_WORDS.has(w))
    .map(w => w.replace(/(?<=..)s$/, ''));
  if (!words.length) return 'Give a few words, e.g. "inverse sine" or "convex hull".';
  const scored = builtinNames().flatMap(name => {
    const help = builtinHelp(name);
    if (!help) return [];
    const lower = name.toLowerCase();
    const text = `${help.signature} ${help.description}`.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (lower === w) score += 10;
      else if (lower.startsWith(w)) score += 4;
      if (new RegExp(`(?<![\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(text)) score += 2;
    }
    return score ? [{ name, help, score }] : [];
  });
  if (!scored.length) return `No built-in function matches "${query}".`;
  // Only the strong matches: one word in common with many descriptions ("3D") is noise.
  const best = Math.max(...scored.map(s => s.score));
  return scored
    .filter(s => s.score * 2 > best)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ help }) => `${help.signature}: ${help.description}`)
    .join('\n');
}

/** function_doc(name): a built-in function's signature, what it does, the reference's note, and an example or two that use it. */
export function functionDoc(data: AssistantData, name: string): string {
  const bare = name.trim().replace(/\s*\(.*$/, '');
  const help = builtinHelp(bare);
  if (!help) {
    const near = searchFunctions(bare, 3);
    return `${bare} is not a built-in function.${near.startsWith('No ') ? '' : ` Close:\n${near}`}`;
  }
  const key = data.functions[bare] ? bare : bare.toLowerCase();
  const examples = data.functions[key];
  const note = data.notes[bare] ?? data.notes[bare.toLowerCase()];
  return [
    `${help.signature}: ${help.description}`,
    ...(note ? [note] : []),
    ...(examples?.length ? ['examples (each a whole graph):'] : []),
    ...exampleLines(examples),
  ].join('\n');
}

// MARK: named shapes

/** A name as shape() compares it: lower case, no accents or punctuation, no leading article. */
const shapeKey = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(?:a|an|the) /, '');

/** Edits (insert, delete, change a letter) between two strings. */
function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, k) => k);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

type ShapeData = AssistantData['shapes'][number];

/**
 * The shape a request names: by name or alias, exactly; else the longest
 * name inside the request ("a sphere of radius 2"); else a near spelling
 * ("cardiod"); else a word of a name ("lissajous", "knot").
 */
function findShape(shapes: readonly ShapeData[], query: string): ShapeData | undefined {
  const q = shapeKey(query);
  if (!q) return undefined;
  const names = shapes.flatMap(shape => [shape.name, ...shape.aliases].map(name => ({ shape, key: shapeKey(name) })));
  const exact = names.find(n => n.key === q);
  if (exact) return exact.shape;
  const inside = names
    .filter(n => new RegExp(`(?:^| )${n.key}(?:e?s)?(?: |$)`).test(q))
    .sort((a, b) => b.key.length - a.key.length)[0];
  if (inside) return inside.shape;
  const words = q.split(' ');
  const near = names
    .map(n => {
      const size = n.key.split(' ').length;
      const windows = words
        .slice(0, Math.max(1, words.length - size + 1))
        .map((_, k) => words.slice(k, k + size).join(' '));
      return { ...n, distance: Math.min(...windows.map(w => editDistance(w, n.key))) };
    })
    .filter(n => n.distance <= Math.floor(n.key.length / 5))
    .sort((a, b) => a.distance - b.distance)[0];
  if (near) return near.shape;
  return names.find(n => n.key.split(' ').some(w => w.length > 3 && words.includes(w)))?.shape;
}

/**
 * shape(name): a named curve or surface's forms in this language, each with
 * its parameters and one instance, from the reference (docs/reference/shapes.md);
 * on a miss, every name. One form only, the equation where there is one (the
 * model drew every form it was shown, as separate rows). Rows come before their kind (a `kind: rows` line was
 * copied into a row whole), and the answer ends by saying it drew nothing: the
 * model took the entry for a drawing and replied without set_graph.
 */
export function shape(data: AssistantData, name: string): string {
  const found = findShape(data.shapes, name);
  if (!found) return `No shape "${name.trim()}". Shapes: ${data.shapes.map(s => s.name.toLowerCase()).join(', ')}.`;
  const rows = (list: string[]) => JSON.stringify(list);
  const form = found.forms.find(f => f.kind.startsWith('implicit')) ?? found.forms[0];
  return [
    `${found.name}${found.aliases.length ? ` (also ${found.aliases.join(', ')})` : ''}: ${found.intro.replace(/\s+/g, ' ')}`,
    `- ${rows(form.rows)} (${form.kind})${form.note ? ` — ${form.note}` : ''}`,
    ...form.params.map(([param, meaning]) => `  ${param}: ${meaning}`),
    `  e.g. ${form.example.values ? `${form.example.values} → ` : ''}${rows(form.example.rows)}${form.example.note ? ` — ${form.example.note}` : ''}`,
    ...(found.pitfall ? [`Pitfall: ${found.pitfall}`] : []),
    'Nothing is drawn yet: adapt this form to the request and pass its rows to set_graph.',
  ].join('\n');
}
