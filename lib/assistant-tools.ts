/**
 * The Apple app's Ask tools that answer from the language, not the graph
 * (apple/Equation Assistant.swift): check. The app's renderer answers it
 * through its bridge (web/native-app.ts), and the evals' service
 * (apple/evals) with this same code. Every answer is short: the on-device
 * model has 8K tokens.
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
import { publicKind } from './plot.ts';
import { KIND_MEANINGS, rowKind } from './row-kind.ts';
import { sliderForm } from './slider.ts';
import { stripNote } from './statements.ts';

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
      row.hint = `${unknown}(…) is not a built-in function; call read_syntax to find the right form`;
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
