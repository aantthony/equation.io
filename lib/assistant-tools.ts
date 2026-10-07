/**
 * The Apple app's Ask tools that answer from the language, not the graph
 * (apple/Equation Assistant.swift): check, search_functions, function_doc,
 * list_kinds and kind_examples. The app's renderer answers them through its
 * bridge (web/native-app.ts), and the evals' service (apple/evals) with this
 * same code. Every answer is short: the on-device model has 8K tokens.
 *
 * Also here: a row's status and meaning from the analyzer alone, as voice
 * mode's get_graph reports it (web/main.ts rowStatus), which check answers
 * with and the evals' graph reports.
 */
import { type Analysis, type RowInfo, analyzeRows } from './analysis.ts';
import { mvOfNode } from './clifford.ts';
import type { CpuPlan } from './compiler.ts';
import { type Definition, animatedConstNames, definitionDependencies } from './defs.ts';
import { canonicalName } from './expr.ts';
import type { PublicKind } from './math-object.ts';
import { publicKind } from './plot.ts';
import { KIND_FORMS, KIND_MEANINGS, rowKind } from './row-kind.ts';
import { sliderForm } from './slider.ts';
import { splitStatements, stripNote } from './statements.ts';
import { builtinHelp, builtinNames } from './syntax-help.ts';

// MARK: rows, as get_graph and check describe them

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

/** Row `index` of `texts`, as web/main.ts rowStatus reports it. */
export function describeRow(analysis: Analysis, texts: readonly string[], index: number): RowReport {
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
      row.hint = `${unknown}(…) is not a built-in function; call search_functions to find the right form`;
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
export function checkRows(rows: readonly string[]): CheckedRow[] {
  const texts = rows.map(r => r.trim()).filter(Boolean);
  const analysis = analyzeRows(texts, { readouts: true });
  return texts.map((row, i) => {
    const { kind, meaning, value, error, hint, warning } = describeRow(analysis, texts, i);
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

/** Kinds list_kinds names without their forms, by topic, to keep it short: kind_examples has the rest. */
const SPECIALISED: Record<string, PublicKind[]> = {
  'sequences and simulations': ['sequence', 'cobweb', 'bifurcation', 'orbit', 'automaton'],
  'lists and data': ['vlist', 'plist', 'histogram', 'dlist', 'dscatter', 'tuple'],
  probability: ['density', 'pmf', 'prob', 'expect'],
  'complex functions': ['complex2d', 'domain2d', 'conformal2d', 'fractal2d'],
  'colour fields': ['rgb2d', 'hsl2d', 'oklch2d'],
  algebra: ['tfield2d', 'multivector', 'flat', 'action', 'graph', 'lattice'],
};

/** list_kinds: every kind; the common ones with their smallest form and a few words. */
export function listKinds(): string {
  const specialised = new Set(Object.values(SPECIALISED).flat());
  const common = (Object.keys(KIND_FORMS) as PublicKind[]).filter(kind => !specialised.has(kind));
  return [
    'One shape per row. kind: smallest form (; separates rows) | what it draws',
    ...common.map(kind => `${kind}: ${KIND_FORMS[kind][0]} | ${KIND_FORMS[kind][1]}`),
    'Definitions draw nothing themselves: a = 2 (a slider), f(x) = x^2 (add y = f(x) to draw it), A = (1, 2) (a draggable point).',
    'More kinds:',
    ...Object.entries(SPECIALISED).map(([topic, kinds]) => `${topic}: ${kinds.join(', ')}`),
    'kind_examples(kind) gives any kind with worked examples.',
  ].join('\n');
}

/** Worked examples, by kind and by function: generated from the examples menu (examplesIndex). */
export interface ExamplesIndex {
  kinds: Record<string, { label: string; rows: string[] }[]>;
  functions: Record<string, { label: string; rows: string[] }[]>;
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
const exampleLines = (list: { label: string; rows: string[] }[] = []) =>
  list.map(({ label, rows }) => `- ${JSON.stringify(rows)} (${label})`);

/** The kind a model means: a name from list_kinds, or a kind as get_graph reports it ("pcurve", "parametric curve"). */
function findKind(query: string): PublicKind | undefined {
  const q = query.trim().toLowerCase();
  const kinds = Object.keys(KIND_FORMS) as PublicKind[];
  return (
    kinds.find(k => k === q) ??
    kinds.find(k => q.startsWith(k)) ??
    kinds.find(k => KIND_FORMS[k][1].toLowerCase().startsWith(q) || KIND_MEANINGS[k].toLowerCase().startsWith(q))
  );
}

/** kind_examples(kind): what a kind draws, its smallest form, and worked examples, each a whole graph. */
export function kindExamples(index: ExamplesIndex, query: string): string {
  const kind = findKind(query);
  if (!kind) return `No kind "${query}". Kinds: ${Object.keys(KIND_FORMS).join(', ')}.`;
  const [form] = KIND_FORMS[kind];
  return [
    `${kind}: ${KIND_MEANINGS[kind]}`,
    `smallest: ${JSON.stringify(splitStatements(form).map(s => s.trim()))}`,
    ...(index.kinds[kind]?.length ? ['examples (each a whole graph, one entry per row):'] : []),
    ...exampleLines(index.kinds[kind]),
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

/** function_doc(name): a built-in function's signature, what it does, and an example or two that use it. */
export function functionDoc(index: ExamplesIndex, name: string): string {
  const bare = name.trim().replace(/\s*\(.*$/, '');
  const help = builtinHelp(bare);
  if (!help) {
    const near = searchFunctions(bare, 3);
    return `${bare} is not a built-in function.${near.startsWith('No ') ? '' : ` Close:\n${near}`}`;
  }
  const examples = index.functions[bare] ?? index.functions[bare.toLowerCase()];
  return [
    `${help.signature}: ${help.description}`,
    ...(examples?.length ? ['examples (each a whole graph):'] : []),
    ...exampleLines(examples),
  ].join('\n');
}
