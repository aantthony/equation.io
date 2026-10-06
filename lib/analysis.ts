/** Shared document preparation and runtime-aware mathematical analysis. */
import { compileCpu, compileGpu, type CpuPlan, type GpuPlan } from './compiler.ts';
import type { LevelSetSpec, MathObject } from './math-object.ts';
import { type Env, evaluateFrame, nameTaken } from './env.ts';
import { lowerObjects } from './object-lists.ts';
import {
  animatedConstNames,
  badTableRow,
  buildDefs,
  compsOf,
  defKey,
  listGetter,
  listNamesOf,
  indexNamesOf,
  isListName,
  indexIssue,
  MissingDataError,
  resolveExpr,
  resolveRow,
  shadowedFnNames,
  scanDefinition,
  takenBinder,
  takenDefinitionName,
  takenNameHint,
  timeDifferentiator,
  type Definition,
  type TableSource,
  pointComponentNames,
} from './defs.ts';
import {
  NO_MEAN_INFO,
  RVSystem,
  buildRVDeclarations,
  type BaseDist,
  type BuiltRVs,
  checkDerived,
  lowerProbBody,
  matchExpectation,
  matchProbability,
  momentsReadout,
  readoutNumber,
  probabilityValue,
  randomNameIn,
  regionExpr,
  scanRandomRows,
  toExpectation,
  toProbability,
  variableRow,
} from './dist.ts';
import { type Expr, MAP, childrenOf, freeVars, parseExpr, substVars } from './expr.ts';
import { usesComplex } from './complex.ts';
import { intervalsIn, lengthOf, replaceIntervals } from './interval.ts';
import { lowerGeom } from './geom.ts';
import { lowerLists, reducesMembers, SCALAR_REDUCTIONS } from './list.ts';
import { type Classified, checkSolid, classify, classifyRow, plotReadout } from './plot.ts';
import { scanRegressions, formatFit } from './regression.ts';
import { type SeqScan, classifySeqRec, scanSequences, sequenceResolver } from './seq.ts';
import { classifyAutomatonRow, exactCases } from './automaton.ts';
import { graphObject, wholeCall } from './graph.ts';
import { buildStateSystem, initialState } from './state.ts';
import { stripNote } from './statements.ts';
import { overParams, planarField } from './grid.ts';
import { type ViewSpec, parseViewRow } from './view.ts';
import { MAX_PANELS, gridCoordinateProblem, isDividerRow } from './panels.ts';
import { type AxisMaps, UNMAPPED_MESSAGE, axisMapping, inlineFields, mapRowExpr } from './axis-map.ts';

export interface RowSource {
  id?: string | number;
  text: string;
}

/** Lexical candidates preserve source identity; document binding settles them. */
export interface StatementScan {
  source: RowSource;
  kind: 'blank' | 'comment' | 'viewport' | 'sequence' | 'distribution' | 'definition' | 'expression';
}

export interface RowInfo extends RowSource {
  /** Set for definition rows (constants, functions, coordinate fields). */
  def?: Definition;
  /** Set for viewport rows (view(...) / camera(...)). */
  view?: ViewSpec;
  /** Set for plot rows that classified successfully. */
  cls?: Classified;
  /** Executable backend products, derived only from cls.object. */
  cpu?: CpuPlan;
  gpu?: GpuPlan;
  /** Set for `# label` comment rows (group headings in the app; not plotted). */
  comment?: boolean;
  /** Set for probability rows: `X ~ …` plots a density, `P(…)` a shaded
   *  area, `E(…)` a mean marker. */
  dist?: 'density' | 'pmf' | 'probability' | 'expectation';
  /** Set for `mark(v)` rows: v's value is highlighted as a vertex of the
   *  graphs in the row's panel (lib/graph.ts). */
  mark?: true;
  /** Readout shown under the row in the app (the numeric value of a P(…) or E(…) row). */
  info?: string;
  /** A remark on how the row reads, kept after `info` as the readout changes
   *  (a call applied per member that looks like a wrapper, perMemberNote). */
  note?: string;
  /** Set when the row reads a local data file (`open(…)`) that is not on this
   *  machine: the row is valid, but nothing server-side can draw it. */
  dataLocal?: string;
  needsFile?: boolean;
  error?: string;
}

export interface AnalyzeOpts {
  backend?: 'cpu' | 'gpu' | 'both';
  /** Compute the rows' numeric readouts (`info`): P(…) and E(…) values, a
   *  derived pmf's μ and σ. They are what MCP validation reports, and they are
   *  the expensive part — a joint enumeration, or a 131072-point sample, per
   *  row — so a caller that only draws (the og image) says false. */
  readouts?: boolean;
}

export interface PrepareOptions {
  tables?: TableSource;
}

export interface PreparedDocument {
  rows: RowInfo[];
  statements: StatementScan[];
  /** Each row's sequence reading, decided across the document (scanSequences). */
  seqScans: (SeqScan | null)[];
  raw: Definition[];
  built: ReturnType<typeof buildDefs>;
  defs: Env;
  rvScan: ReturnType<typeof scanRandomRows>;
  builtRVs: Omit<BuiltRVs, 'declarations'>;
  stateSystem: ReturnType<typeof buildStateSystem>;
  sumBoundConsts: Set<string>;
  constNames: Set<string>;
  fieldEnv: Record<string, Expr>;
  fnNames: Set<string>;
  listNames: ReturnType<typeof listNamesOf>;
  valueNames: ReturnType<typeof shadowedFnNames>;
  getFn: (name: string) => ReturnType<Env['fns']['get']>;
  getList: ReturnType<typeof listGetter>;
  boundVals: Record<string, number>;
  /** Numeric values read while resolving plot structure (not runtime readouts). */
  structuralConsts: Set<string>;
  ropts: import('./defs.ts').ResolveOpts;
  gridFields: LevelSetSpec[];
}

export interface AnalysisContext {
  backend?: 'cpu' | 'gpu' | 'both';
  /** Caller-owned integrated values. Analysis never resets or mutates them. */
  stateValues?: Record<string, number>;
  /** Reuse this engine across recompiles to retain numerical sample caches. */
  rvs?: RVSystem;
  time?: number;
  readouts?: boolean;
  /** static preserves browser readouts that omit live state-dependent values. */
  readoutPolicy?: 'frame' | 'static';
}

export interface Analysis {
  rows: RowInfo[];
  defs: Env;
  constEnv: Record<string, number>;
  rvs: RVSystem;
  rvNames: ReadonlySet<string>;
  gridFields: LevelSetSpec[];
  document: PreparedDocument;
}

/** A viewport row by its text: a `---` divider, or a view/camera/grid call
 *  that is not the definition of a function by that name (`grid(x) = …`). */
export const isViewportText = (text: string): boolean =>
  isDividerRow(text) || (/^(view|camera|grid)\s*\(/i.test(text) && !scanDefinition(text));

/** No source splitting here: one input row remains one result, including blanks. */
export function prepareDocument(
  sources: readonly (string | RowSource)[],
  { tables }: PrepareOptions = {},
): PreparedDocument {
  // A trailing `# note` is prose for the reader; the math is what precedes it.
  const rows: RowInfo[] = sources.map(source =>
    typeof source === 'string'
      ? { text: stripNote(source).trim() }
      : { ...source, text: stripNote(source.text).trim() },
  );
  const texts = rows.map(row => row.text);
  const seqScans = scanSequences(texts);
  const statements: StatementScan[] = rows.map((source, i) => ({
    source,
    kind: !source.text
      ? 'blank'
      : source.text.startsWith('#')
        ? 'comment'
        : isViewportText(source.text)
          ? 'viewport'
          : seqScans[i]
            ? 'sequence'
            : source.text.includes('~')
              ? 'distribution'
              : scanDefinition(source.text)
                ? 'definition'
                : 'expression',
  }));

  // Random-variable rows (`X ~ …`, and `Y = X^2` referencing one) resolve
  // outside the definition system — mirror of web/main.ts recompileAll.
  const regressions = scanRegressions(texts);
  const rvScan = scanRandomRows(
    rows.map((r, i) => (regressions.has(i) || !r.text || r.text.startsWith('#') || seqScans[i] ? null : r.text)),
  );
  const rvRowIdx = new Set([...rvScan.base.keys(), ...rvScan.derived.keys()]);

  // Pass 1: definitions. A duplicate coordinate-field row (r = 1 + cos(theta)
  // after r = sqrt(x^2+y^2)) is a plot in that coordinate system, not an error.
  const raw: Definition[] = [];
  const defNames = new Set<string>();
  const dupRows: RowInfo[] = [];
  for (const [i, row] of rows.entries()) {
    if (!row.text) continue;
    // `# label` rows are comments (collapsible group headings in the app).
    if (row.text.startsWith('#')) {
      row.comment = true;
      continue;
    }
    if (rvRowIdx.has(i)) continue;
    // Sequence/recurrence rows (a_n = …, a_{n+1} = …) are plots, not definitions.
    if (seqScans[i]) continue;
    const d = regressions.get(i) ?? scanDefinition(row.text);
    if (!d) continue;
    row.def = d;
    if (defNames.has(defKey(d))) {
      dupRows.push(row);
      continue;
    }
    defNames.add(defKey(d));
    raw.push(d);
  }

  // An automaton's letter names rows of cells, not scalar terms (automaton.ts).
  const built = buildDefs(
    raw,
    tables,
    seqScans.filter((s): s is SeqScan => s !== null && !s.lattice),
  );
  const defs = built.defs;
  for (const [key, fit] of built.fits) {
    const row = rows.find(r => r.def && defKey(r.def) === key);
    if (row) row.info = formatFit(fit);
  }
  for (const [key, message] of built.errors) {
    const row = rows.find(r => r.def && defKey(r.def) === key);
    if (!row) continue;
    // A definition that only wants a dropped CSV (`ages = person.age / 2`)
    // is not a broken row — the bytes never travelled in the link. Same
    // distinction the plot-row catch below makes.
    if (built.needsFile.has(key)) {
      row.dataLocal = message;
      row.needsFile = true;
    } else row.error = message;
  }
  // `p ∈ X` draws from a list, and a random variable is not one: say so,
  // rather than that p may only use constants and t.
  const rvNames = new Set([...rvScan.base.values(), ...rvScan.derived.values()].map(r => r.name));
  for (const row of rows) {
    if (row.def?.kind !== 'const' || !row.def.draw) continue;
    const rv = randomNameIn(row.def.rhs, rvNames);
    if (!rv) continue;
    // A bare `p ∈ X` over a declared X has a spelling that works today.
    const law = row.def.rhs.trim() === rv ? [...rvScan.base.values()].find(r => r.name === rv)?.rhs.trim() : undefined;
    row.error =
      `${row.def.name} ∈ … draws from a list; ${rv} is a random variable.` +
      (law ? ` For an independent copy of ${rv}, write ${row.def.name} ~ ${law}.` : '');
  }
  for (const row of dupRows) {
    const { name, kind } = row.def!;
    const original = rows.find(r => r.def && defKey(r.def) === defKey(row.def!));
    const levelSet = kind === 'fn' && defs.fns.has(name) && row.text !== original?.text;
    // `r = sqrt(x^2 + y^2); r = 2` is a level set of r. A field over u, v has
    // no level sets in the plane, so a second `k = …` is a redefinition.
    const field = defs.fields.get(name);
    if ((field && !overParams(field)) || levelSet) row.def = undefined;
    else row.error = `${defKey(row.def!)} is already defined.`;
  }

  for (const [name, table] of defs.tables) {
    const row = rows.find(r => r.def && defKey(r.def) === name);
    if (!row || row.error || !table.data) continue;
    const cols = table.data.columns.map(c => (c.type === 'num' ? c.name : `${c.name} (text)`));
    row.info = [`${table.data.rows} rows`, cols.join(', '), ...table.data.warnings].join(' · ');
  }
  const stateSystem = buildStateSystem(defs);
  // Only static constants can affect compilation. Dummy states permit evaluating
  // unrelated constants; every state and dependent constant is removed below.
  let constEnv: Record<string, number> = {};
  try {
    constEnv = evaluateFrame(defs, 0, Object.fromEntries([...defs.states.keys()].map(n => [n, 0])));
  } catch {
    /* failed definitions already carry diagnostics */
  }

  // Pass 2: viewport rows and plots. States are constants to every consumer.
  const constNames = new Set([...defs.consts.keys(), ...defs.states.keys()]);
  // A named condition is written into a row as a field is (`{within: 1}`
  // from a function body, `within` as a row of its own).
  const fieldEnv = Object.fromEntries([...defs.fields, ...defs.conditions]);
  const fnNames = new Set(raw.filter(d => d.kind === 'fn').map(d => d.name));
  const listNames = listNamesOf(defs);
  // Names this document binds that a late-addition builtin would otherwise
  // claim (`total = 3` followed by `total(x + 1)`), as in web/main.ts.
  const valueNames = shadowedFnNames([
    ...raw.filter(d => d.kind !== 'fn').map(d => d.name),
    ...[...rvScan.base.values()].map(s => s.name),
    ...[...rvScan.derived.values()].map(s => s.name),
  ]);
  const getList = listGetter(defs);
  const getFn = (name: string) => {
    const fn = defs.fns.get(name);
    if (!fn && fnNames.has(name)) throw new Error(`${name} has an error in its definition.`);
    return fn;
  };
  // Σ/Π bounds in plot rows expand against the constants' values at t = 0, as
  // in web/main.ts (animated constants and states excluded: expansion is
  // static, so their bounds have no fixed value).
  const boundVals = { ...constEnv };
  for (const name of animatedConstNames(defs)) delete boundVals[name];
  for (const name of defs.states.keys()) delete boundVals[name];
  const structuralConsts = new Set<string>();
  const ropts: import('./defs.ts').ResolveOpts = {
    consts: new Proxy(boundVals, {
      get(target, name, receiver) {
        if (typeof name === 'string' && Object.hasOwn(target, name)) structuralConsts.add(name);
        return Reflect.get(target, name, receiver);
      },
    }),
    boundConsts: built.sumBoundConsts,
    isList: (n: string) => isListName(listNames, n),
    getList,
    indexIssue: (idx: Expr, target: Expr) => indexIssue(idx, defs, target),
    // A state stands for itself: defined, and constant across space.
    definition: (n: string): Expr | undefined =>
      defs.fields.get(n) ??
      defs.conditions.get(n) ??
      defs.consts.get(n) ??
      (defs.states.has(n) ? { kind: 'var', name: n } : undefined),
    comps: (n: string) => compsOf(defs, n),
    interval: (n: string) => defs.intervals.get(n),
    multivector: (n: string) => defs.multivectors.get(n),
    complex: (n: string) => defs.complexes.get(n),
    documentNames: new Set([
      ...raw.map(d => d.name),
      ...[...rvScan.base.values()].map(s => s.name),
      ...[...rvScan.derived.values()].map(s => s.name),
    ]),
  };
  ropts.sequenceTerm = sequenceResolver(defs, getFn, ropts, constNames, new Set(raw.map(d => d.name)));

  const { declarations, ...builtRVs } = buildRVDeclarations(rvScan, {
    fnNames,
    getFn,
    ropts,
    constNames,
    taken: n => nameTaken(defs, n),
  });
  for (const [name, declaration] of declarations) defs.bind(name, { tag: 'rv', declaration });

  const gridFields: LevelSetSpec[] = [];
  const skipGrid = pointComponentNames(defs);
  for (const [name, expr] of defs.fields) {
    if (skipGrid.has(name) || !planarField(expr)) continue;
    try {
      gridFields.push({ name, expr, params: [...freeVars(expr)].filter(n => constNames.has(n)).sort() });
    } catch (e) {
      const row = rows.find(r => r.def && defKey(r.def) === name);
      if (row && !row.error) row.error = e instanceof Error ? e.message : String(e);
    }
  }
  return {
    rows,
    statements,
    seqScans,
    raw,
    built,
    defs,
    rvScan,
    builtRVs,
    stateSystem,
    sumBoundConsts: built.sumBoundConsts,
    constNames,
    fieldEnv,
    fnNames,
    // What parses as an index: the lists and the named points (T[2]).
    listNames: indexNamesOf(defs),
    valueNames,
    getFn,
    getList,
    boundVals,
    structuralConsts,
    ropts,
    gridFields,
  };
}

/** Resolve/classify with caller-owned runtime; preparation diagnostics stay reusable. */
/** `value(from..to)`: the orbit of a state (or anything drawn from states),
 *  one path per run when the value is a family's list. */
function classifyOrbit(value: Expr, [from, to]: [Expr, Expr], defs: Env, constNames: ReadonlySet<string>): Classified {
  const moving = new Set([...animatedConstNames(defs), ...defs.states.keys(), 't']);
  for (const bound of [from, to]) {
    if (bound.kind === 'vec' || bound.kind === 'list')
      throw new Error('An orbit runs between two times, like p(0..50).');
    const v = [...freeVars(bound)].find(n => moving.has(n) || !constNames.has(n));
    if (v) throw new Error(`An orbit's time range must hold still (found ${v}).`);
  }
  const items = value.kind === 'list' ? value.items : [value];
  const series = items.every(it => it.kind !== 'vec');
  const paths = items.map(it => {
    if (it.kind === 'vec') {
      if (series || (it.items.length !== 2 && it.items.length !== 3))
        throw new Error('An orbit draws a 2D or 3D point, or one number against t.');
      return it.items;
    }
    if (it.kind === 'eq' || it.kind === 'ineq' || it.kind === 'data' || it.kind === 'list')
      throw new Error('An orbit draws a state, like p(0..50).');
    return [it];
  });
  if (!series && new Set(paths.map(p => p.length)).size > 1)
    throw new Error('All points in an orbit need the same number of coordinates.');
  const params = new Set<string>();
  for (const e of [...paths.flat(), from, to]) {
    for (const n of freeVars(e)) {
      if (n === 't') continue;
      if (!constNames.has(n)) throw new Error(`An orbit draws states, constants and t (found ${n}).`);
      params.add(n);
    }
  }
  const object = { kind: 'orbit', paths, series, from, to } as const;
  return { object, animated: false, needs3D: !series && paths[0].length === 3, params: [...params].sort() };
}

/**
 * u and v in a real row with no x, y or z, as independent Uniform(0, 1) base
 * variables under internal names — or null when the row is not one, or the
 * random-variable engine cannot take it (a tuple, a complex path, a list),
 * which leaves the row to classify, where u and v trace curves.
 *
 * A continuous interval (lib/interval.ts) is a uniform draw over its bounds.
 * Its multiplicity is length, not probability (docs/multisets.md §5), so the
 * density is drawn times `mass`, the product of the intervals' lengths:
 * interval(0, 10) stands at height 1, as u does.
 */
function uniformDraws(
  e: Expr,
  constNames: ReadonlySet<string>,
  rvNames: ReadonlySet<string>,
  id: string,
  /** The row's value once point arithmetic has run — lowerObjects. */
  lower: (e: Expr) => Expr,
): { expr: Expr; bases: Record<string, BaseDist>; mass?: Expr } | null {
  if (e.kind === 'eq' || e.kind === 'ineq' || usesComplex(e)) return null;
  const free = [...freeVars(e)].filter(n => !constNames.has(n));
  const params = free.filter(n => n === 'u' || n === 'v');
  const hidden = intervalsIn(e);
  if ((!params.length && !hidden.length) || free.some(n => n === 'x' || n === 'y' || n === 'z' || n === 'w'))
    return null;
  // Numbers have a density; a point does not. Which one the row is depends on
  // its value, not its spelling: `(0,0,1) u` and `u e_z` are the tuple
  // (0, 0, u), a curve, though no tuple sits at the top of the row. Only the
  // lowered row says so.
  if (pointValued(e, lower)) return null;
  const uniform: BaseDist = {
    kind: 'uniform',
    args: [
      { kind: 'num', value: 0 },
      { kind: 'num', value: 1 },
    ],
  };
  const bases: Record<string, BaseDist> = {};
  const names: Record<string, Expr> = {};
  for (const p of params) {
    bases[`@${p}${id}`] = uniform;
    names[p] = { kind: 'var', name: `@${p}${id}` };
  }
  const drawn = new Map(hidden.map((h, k) => [h.key, `@iv${k}${id}`]));
  for (const h of hidden) bases[drawn.get(h.key)!] = { kind: 'uniform', args: [h.lo, h.hi] };
  const expr = replaceIntervals(substVars(e, names), h => ({ kind: 'var', name: drawn.get(h.key)! }));
  try {
    checkDerived(expr, new Set([...rvNames, ...Object.keys(bases)]), constNames);
  } catch {
    return null;
  }
  const mass = hidden
    .map(lengthOf)
    .reduce<Expr | undefined>(
      (m, l) =>
        !m
          ? l
          : m.kind === 'num' && l.kind === 'num'
            ? { kind: 'num', value: m.value * l.value }
            : { kind: 'bin', op: '*', a: m, b: l },
      undefined,
    );
  // Unit length (u, v, interval(0, 1)) leaves the probability as it is.
  return { expr, bases, ...(mass && !(mass.kind === 'num' && mass.value === 1) ? { mass } : {}) };
}

/** Whether a row's value is a point, points, or a figure through them —
 *  anything classify draws by position rather than as numbers. A row that
 *  does not lower is left to the density path, which reports it. */
function pointValued(e: Expr, lower: (e: Expr) => Expr): boolean {
  let value: Expr;
  try {
    value = lower(e);
  } catch {
    return false;
  }
  switch (value.kind) {
    case 'vec':
    case 'figure':
    case 'family':
      return true;
    case 'list':
      return value.items.some(it => it.kind === 'vec');
    case 'lazy':
      return value.body.kind === 'vec';
    default:
      return false;
  }
}

/** A scalar field in x alone (or y alone) is most often a curve meant as
 *  `y = …`: the row says how to write that, since it now draws a field. */
function curveHint(object: MathObject, text: string): string | null {
  if (object.kind !== 'scalar-field' || object.dimension === 3) return null;
  const vars = freeVars(object.expr);
  const [free, other] = vars.has('x') ? ['x', 'y'] : ['y', 'x'];
  if (!vars.has(free) || vars.has(other)) return null;
  return `scalar field — for the curve write ${other} = ${text}`;
}

/**
 * A note for a call that applies per member ([map], docs/multisets.md §0)
 * where a reduction in its body sees nothing but the member: `avg(s) =
 * mean(s)`; `avg(L)` is L, each member reduced alone, which reads like a
 * wrapper for mean(L). A reduction that also takes a list of the body's own
 * (`f(m) = total(L m)`) is the rule's point, and says nothing.
 */
/**
 * A note for `p ∈ [a, b]` with a < b: the notation reads as the interval
 * from a to b, and here it is the two members a and b. (A family of two is
 * a fine thing to draw, so this is a note, not an error.)
 */
function pairDrawNote(name: string, rhs: string): string | null {
  const m = /^\s*\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]\s*$/.exec(rhs);
  if (!m || !(Number(m[1]) < Number(m[2]))) return null;
  return `${name} is ${m[1]} or ${m[2]}, the list's two members; for every number from ${m[1]} to ${m[2]}, write ${name} = interval(${m[1]}, ${m[2]})`;
}

/** A readout followed by the row's note. */
export const withNote = (info: string | null | undefined, note: string | undefined): string | undefined =>
  note ? (info ? `${info} · ${note}` : note) : (info ?? undefined);

function perMemberNote(e: Expr, isList: (name: string) => boolean): string | null {
  if (e.kind === 'call' && e.name === MAP && e.args[0]?.kind === 'str') {
    const members = new Set(e.args.slice(2).flatMap(a => (a.kind === 'str' ? a.value.split(',') : [])));
    const listFree = (x: Expr): boolean =>
      x.kind !== 'list' &&
      x.kind !== 'data' &&
      (x.kind !== 'var' || !isList(x.name.split('.')[0])) &&
      childrenOf(x).every(listFree);
    let lone: string | null = null;
    const walk = (x: Expr): void => {
      if (lone) return;
      if (x.kind === 'call' && reducesMembers(x.name, x.args.length)) {
        const vars = x.args.flatMap(a => [...freeVars(a)].map(v => v.split('.')[0]));
        if (vars.some(v => members.has(v)) && x.args.every(listFree)) lone = x.name;
        return;
      }
      childrenOf(x).forEach(walk);
    };
    walk(e.args[1]);
    if (lone)
      return `${e.args[0].value} applies per member, so its ${lone} sees one member at a time; for the whole list, write ${lone}(…) in the row`;
  }
  for (const c of childrenOf(e)) {
    const note = perMemberNote(c, isList);
    if (note) return note;
  }
  return null;
}

/**
 * The operator of a row that is curvature(C) or torsion(C) along the curve
 * (no point given), bare or with a number (1/curvature(C)) — unless the
 * document defines its own.
 */
function alongCurve(e: Expr, getFn: (name: string) => unknown): string | null {
  const bare = (c: Expr): string | null =>
    c.kind === 'call' && (c.name === 'curvature' || c.name === 'torsion') && c.args.length === 1 && !getFn(c.name)
      ? c.name
      : null;
  if (e.kind === 'bin') return (e.a.kind === 'num' && bare(e.b)) || (e.b.kind === 'num' && bare(e.a)) || null;
  return bare(e);
}

export function analyzePrepared(document: PreparedDocument, context: AnalysisContext = {}): Analysis {
  const { defs, constNames, fieldEnv, fnNames, listNames, valueNames, getFn, getList, ropts, gridFields } = document;
  const rows = document.rows.map(row => ({ ...row }));
  /** Rows whose calls apply per member in a way that reads like a wrapper (perMemberNote). */
  const memberNotes = new Map<(typeof rows)[number], string>();
  const { stateValues: stateVals = {}, time = 0, readouts = true, readoutPolicy = 'frame', backend = 'both' } = context;
  let constEnv: Record<string, number> = { ...stateVals };
  try {
    constEnv = evaluateFrame(defs, time, stateVals);
  } catch {
    /* definition diagnostics remain on rows */
  }
  let readoutEnv: Record<string, number> = constEnv;
  if (readoutPolicy === 'static') {
    readoutEnv = {};
    try {
      readoutEnv = evaluateFrame(defs, 0);
    } catch {
      /* browser readouts omit unseeded state values */
    }
  }

  // Random variables next, so P(…) and bare-expression rows can reference
  // them regardless of row order.
  const rvs = context.rvs ?? new RVSystem();
  rvs.useDeclarations(defs.rvs);
  const builtRVs = document.builtRVs;
  const rvNames = builtRVs.names;
  // How a variable's row draws is lib's (variableRow), shared with the app.
  // `mass` scales the curve from a probability to the measure of the row's
  // intervals (see uniformDraws).
  const classifyVariable = (row: RowInfo, name: string, mass?: Expr): void => {
    const shape = variableRow(rvs, name);
    row.dist = shape.kind === 'pmf' ? 'pmf' : 'density';
    if (shape.kind === 'exact') {
      const d = shape.density as Expr & { kind: 'eq' };
      row.cls = classify(mass ? { ...d, r: { kind: 'bin', op: '*', a: mass, b: d.r } } : d, constNames);
    } else if (mass && shape.cls.object.kind === 'distribution' && shape.cls.object.form !== 'prob') {
      row.cls = { ...shape.cls, object: { ...shape.cls.object, mass } };
    } else row.cls = shape.cls;
    if ((shape.kind === 'pmf' || readoutPolicy === 'static') && rvs.get(name)?.kind === 'derived') pmfInfo(row, name);
  };
  // A derived pmf row reads out as in the app — exact μ, σ where the joint
  // was enumerated, "(sampled)" where it was too large to be.
  const pmfInfo = (row: RowInfo, name: string): void => {
    if (!readouts) return;
    try {
      const m = rvs.moments(name, readoutEnv);
      if (m) row.info = momentsReadout(m);
    } catch {
      /* not computable at t = 0 (animated): no readout */
    }
  };
  const movingConsts = new Set([...animatedConstNames(defs), ...Object.keys(stateVals)]);
  for (const [i, name] of builtRVs.rowRV) {
    const row = rows[i];
    const message = builtRVs.errors.get(i);
    if (message) {
      row.error = message;
      continue;
    }
    // Labelled from the family, before anything can fail: a discrete
    // declaration whose parameter is bad is still a pmf row with an error.
    row.dist = rvs.isDiscreteVar(name) ? 'pmf' : 'density';
    // Parameters that are constants are judged at their values: a = -1 then
    // X ~ Gamma(a, 1) is no distribution (mirror of web/main.ts).
    const problem = rvs.paramProblem(name, readoutEnv, movingConsts);
    if (problem) {
      row.error = problem;
      continue;
    }
    classifyVariable(row, name);
  }

  // The body of a P(…)/E(…) row, read exactly as a plot row is read — with the
  // list names, and lowered — so `P(X < mean(L))` sees the list two rows above
  // rather than reporting it unknown (mirror of web/main.ts).
  const parseRowBody = (
    body: string,
    top: (e: Expr, lower: (e: Expr) => Expr) => Expr = (e, lower) => lower(e),
  ): Expr =>
    top(
      resolveExpr(parseExpr(body, fnNames, listNames, valueNames), getFn, ropts),
      // Points first, as in a plot row: `P(X < g(A))` reads g at the point A.
      // (What geometry refuses keeps the message this body always gave.)
      e => {
        try {
          e = lowerGeom(
            e,
            n => compsOf(defs, n),
            n => defs.mats.get(n) ?? null,
            n => getList(n) !== null,
          );
        } catch {
          /* as written */
        }
        return lowerLists(e, getList, ropts);
      },
    );

  // Each panel's axis maps, from its view(…) row wherever in the panel it
  // sits (lib/axis-map.ts); a malformed row is reported by the loop below.
  const panelMaps: AxisMaps[] = [];
  {
    let at = 0;
    for (const row of rows) {
      if (!row.text || row.def || row.comment) continue;
      if (isDividerRow(row.text)) at++;
      else if (/^\s*view\s*\(/.test(row.text) && !fnNames.has('view'))
        try {
          const spec = parseViewRow(row.text, ropts.consts!);
          if (spec?.kind === 'view' && spec.maps) panelMaps[at] ??= spec.maps;
        } catch {
          /* the row's own error */
        }
    }
  }
  const seenViewKinds = new Set<string>();
  let panel = 0;
  for (const [ri, row] of rows.entries()) {
    if (row.def && !row.error && defs.pointDims.get(row.def.name) === 3) {
      const comps = compsOf(defs, row.def.name)!;
      if (comps.every(c => constNames.has(c))) {
        const expr: Expr = { kind: 'vec', items: comps.map(name => ({ kind: 'var', name })) };
        row.cls = classify(expr, constNames);
      }
    }
    if (row.def || row.comment || row.error || row.cls || !row.text) continue;
    try {
      const badRow = badTableRow(row.text);
      if (badRow) throw new Error(badRow);
      // A call to the user's own view/camera/grid function is theirs.
      const head = /^\s*(view|camera|grid)\s*\(/.exec(row.text);
      const view = head && fnNames.has(head[1]) ? null : parseViewRow(row.text, ropts.consts!);
      if (view) {
        // Each panel frames itself: a divider starts a fresh set.
        if (view.kind === 'split') {
          if (++panel >= MAX_PANELS) throw new Error(`A graph splits into at most ${MAX_PANELS} panels.`);
          seenViewKinds.clear();
        } else if (seenViewKinds.has(view.kind)) {
          throw new Error(
            `${view.kind} is already set by another row${panel ? ' in this panel' : ''}` +
              (panel ? '.' : ' — a --- row starts a new panel with its own.'),
          );
        }
        if (view.kind === 'grid')
          for (const name of view.coords ?? []) {
            const problem = gridCoordinateProblem(name, gridFields, defs.fields);
            if (problem) throw new Error(problem);
          }
        seenViewKinds.add(view.kind);
        row.view = view;
        continue;
      }
      // `P(…)` shades an area under a declared density — unless the user has
      // defined P themselves as something P(…) could apply (a number, a
      // function, a matrix or a tensor), in which case the row is theirs. (A
      // list or point named P leaves P(X > 1) the probability it reads as.)
      const userDefined = (n: string) =>
        defs.consts.has(n) || defs.fns.has(n) || defs.mats.has(n) || defs.tensors.has(n);
      const probBody = userDefined('P') ? null : matchProbability(row.text);
      if (probBody !== null) {
        if (!rvNames.size) throw new Error('Define a random variable first, e.g. X ~ Normal(0, 1).');
        const p = toProbability(parseRowBody(probBody, lowerProbBody), rvNames);
        for (const name of p.rvs) {
          if (!rvs.has(name)) throw new Error(`${name} has an error in its definition.`);
        }
        // Point events only of discrete variables.
        rvs.checkProbability(p);
        row.dist = 'probability';
        // Inline bounded expressions become anonymous derived variables, so
        // shading and exact laws apply — mirror of web/main.ts.
        let single = p.single;
        if (!single && p.inline) {
          checkDerived(p.inline.e, rvNames, constNames);
          const anon = `@P${row.id ?? ri}`;
          rvs.addAnonymous({ name: anon, kind: 'derived', expr: p.inline.e });
          const { e: _body, ...bounds } = p.inline;
          single = { rv: anon, ...bounds };
        }
        // Constant bounds on one variable with a closed form get the exact
        // CDF and the shader-drawn region; the rest estimate over samples.
        const exact = single ? rvs.exactDist(single.rv) : null;
        if (single && exact) {
          const region = regionExpr(exact, single.lo, single.hi);
          row.cls = classify(region, constNames);
          if (readouts)
            try {
              const value = probabilityValue(exact, single.lo, single.hi, readoutEnv);
              if (isFinite(value)) row.info = `≈ ${value.toFixed(4)}`;
            } catch {
              // Not numerically computable at t = 0 (e.g. animated); no readout.
            }
        } else {
          const ps = rvs.bodyParams(p.body);
          row.cls = {
            object: { kind: 'distribution', form: 'prob', body: p.body, shade: single },
            animated: ps.has('t'),
            needs3D: false,
            params: [...ps].filter(v => v !== 't'),
          };
          if (readouts)
            try {
              // A uniform-sum law still gets its exact value, and an event over
              // discrete variables is enumerated (mirror of the app's readout);
              // everything else estimates over joint samples.
              const { value, exact: settled } = rvs.eventProbability(p.body, single, readoutEnv);
              if (isFinite(value)) row.info = `≈ ${value.toFixed(settled ? 4 : 3)}`;
            } catch {
              /* animated or broken: no readout */
            }
        }
        continue;
      }
      // `E(…)` is the mean of an expression in random variables — unless the
      // user has defined E themselves. Mirror of web/main.ts.
      const expectBody = userDefined('E') ? null : matchExpectation(row.text);
      if (expectBody !== null) {
        if (!rvNames.size) throw new Error('Define a random variable first, e.g. X ~ Normal(0, 1).');
        const ex = toExpectation(parseRowBody(expectBody), rvNames);
        for (const name of ex.rvs) {
          if (!rvs.has(name)) throw new Error(`${name} has an error in its definition.`);
        }
        row.dist = 'expectation';
        // A bare name is the variable itself; anything else registers as an
        // anonymous derived variable, so exact laws apply unchanged.
        let name: string;
        if (ex.body.kind === 'var' && rvs.has(ex.body.name)) {
          name = ex.body.name;
        } else {
          checkDerived(ex.body, rvNames, constNames);
          name = `@E${row.id ?? ri}`;
          rvs.addAnonymous({ name, kind: 'derived', expr: ex.body });
        }
        const ps = rvs.bodyParams(ex.body);
        row.cls = {
          object: { kind: 'distribution', form: 'expect', rv: name },
          animated: ps.has('t'),
          needs3D: false,
          params: [...ps].filter(p => p !== 't'),
        };
        if (readouts)
          try {
            // Closed form and quadrature both earn full display precision;
            // only the Monte Carlo fallback rounds to its noise floor.
            const m = rvs.exactMoments(name, readoutEnv) ?? rvs.quadMoments(name, readoutEnv);
            const value = m ? m.mean : rvs.mean(name, readoutEnv);
            if (isFinite(value)) row.info = `≈ ${readoutNumber(value, m ? 4 : 3)}`;
            else if (rvs.meanUnstable(name, readoutEnv)) row.info = NO_MEAN_INFO;
          } catch {
            /* animated or broken: no readout */
          }
        continue;
      }
      const seq = document.seqScans[ri];
      if (seq?.lattice) {
        const cls = classifyAutomatonRow(document.seqScans, ri, fnNames, getFn, constNames, ropts);
        if (cls) row.cls = cls;
        continue;
      }
      if (seq) {
        const first = document.seqScans.findIndex(s => s?.name === seq.name);
        if (first < ri) throw new Error(`Sequence ${seq.name} is already defined.`);
        row.cls = classifySeqRec(
          seq,
          fnNames,
          getFn,
          constNames,
          ropts,
          new Set(defs.sequences.keys()),
          document.listNames,
        );
        continue;
      }
      // `d = 1` is no definition (d starts d/dx), and would otherwise fail
      // with advice about derivatives that the author never wrote.
      if (takenDefinitionName(row.text) === 'd') {
        throw new Error(
          'd is taken by derivatives (d/dx), so it cannot name a slider or function. Pick another name, like k.',
        );
      }
      // graph(from, to, label) reads as the tuple of its arguments: one edge
      // per element of its multiset (lib/graph.ts).
      // (A document's own graph or mark function is that function.)
      const graphArgs = fnNames.has('graph') ? null : wholeCall('graph', row.text);
      // mark(v) is v, highlighted in the panel's graphs.
      const markArg = fnNames.has('mark') ? null : wholeCall('mark', row.text);
      const source = graphArgs !== null ? `(${graphArgs})` : markArg !== null ? `(${markArg})` : row.text;
      const takenName = takenBinder(row.text);
      if (takenName) throw new Error(takenName);
      const rawParsed = parseExpr(source, fnNames, listNames, valueNames);
      // `p(50..400)`: where p goes over that time — a range in call position,
      // which nothing else accepts.
      if (rawParsed.kind === 'bin' && rawParsed.op === '*' && rawParsed.b.kind === 'range') {
        const lower = (e: Expr): Expr => lowerObjects(resolveRow(e, getFn, ropts).expr, defs, ropts);
        row.cls = classifyOrbit(lower(rawParsed.a), rawParsed.b.args.map(lower) as [Expr, Expr], defs, constNames);
        continue;
      }
      // A graph's vertices are whole numbers, so its cases may test equality,
      // and so may any row not drawn over the plane: `f(2)`, `mark(c(4))`
      // with c(m) = {mod(m, 2) = 0: …}. Only a case at x, y or z is refused
      // (it would be a curve's sliver), here on the row that draws it.
      const plane = (e: Expr) => ['x', 'y', 'z'].some(v => freeVars(e).has(v));
      const exact = graphArgs !== null || !plane(rawParsed);
      const resolved = resolveRow(
        graphArgs !== null ? exactCases(rawParsed) : rawParsed,
        getFn,
        exact ? { ...ropts, exactConditions: true } : ropts,
      );
      const note = perMemberNote(resolved.expr, ropts.isList ?? (() => false));
      if (note) memberNotes.set(row, note);
      if (exact && graphArgs === null) {
        // Over numbers a case is the tolerance form the evaluator runs; one
        // whose side is a list stays an equation, for list lowering to decide
        // member by member. (A list inside a reduction is one number.)
        const isListReduction = (c: Expr & { kind: 'call' }): boolean =>
          SCALAR_REDUCTIONS.has(c.name) || ((c.name === 'min' || c.name === 'max') && c.args.length === 1);
        const listy = (side: Expr): boolean =>
          side.kind === 'list' ||
          side.kind === 'data' ||
          (side.kind === 'var' && isListName(listNames, side.name)) ||
          (!(side.kind === 'call' && isListReduction(side)) && childrenOf(side).some(listy));
        const cases = exactCases(resolved.expr, listy);
        if (cases !== resolved.expr && plane(resolved.expr))
          throw new Error(
            'A condition like y = x^2 is a filter for a reduction, like count({y = x^2, 0 < x < 1}); piecewise conditions are inequalities.',
          );
        resolved.expr = cases;
      }
      let parsed = resolved.expr;
      // A real row in u and v alone does not depend on the screen, so it is
      // drawn as its values (docs/multisets.md §5): u and v are each [0, 1],
      // and the row is a multiset of numbers with a density. That is the
      // object an expression in random variables already is, with u and v
      // independent Uniform(0, 1) draws — so `u` draws height 1 over [0, 1].
      const draws = uniformDraws(parsed, constNames, rvNames, `${row.id ?? ri}`, e => lowerObjects(e, defs, ropts));
      // curvature(C) is κ along the curve, a number per u — which as such a
      // row (or 1/curvature(C)) would draw the density of its values. Say
      // how to show it.
      const along = draws && alongCurve(rawParsed, getFn);
      if (along) {
        throw new Error(
          `${along}(C) is a function of u along the curve: plot it with (u, ${along}(C)), or read it at a point with ${along}(C, 0.25).`,
        );
      }
      const known = draws ? new Set([...rvNames, ...Object.keys(draws.bases)]) : rvNames;
      if (draws) {
        for (const [name, dist] of Object.entries(draws.bases)) rvs.addAnonymous({ name, kind: 'base', dist });
        parsed = draws.expr;
      }
      // A bare expression in random variables plots that derived density.
      const rvRefs = [...freeVars(parsed)].filter(n => known.has(n));
      if (rvRefs.length) {
        for (const n of rvRefs) {
          if (!rvs.has(n)) throw new Error(`${n} has an error in its definition.`);
        }
        if (parsed.kind === 'ineq') {
          throw new Error(`An inequality in random variables is a probability: try P(${row.text}).`);
        }
        checkDerived(parsed, known, constNames);
        const name = `@${row.id ?? ri}`;
        rvs.addAnonymous({ name, kind: 'derived', expr: parsed });
        classifyVariable(row, name, draws?.mass);
        continue;
      }
      // Expand point arithmetic and geometry statements (segment, polygon, …)
      // into scalar expressions; a point name A becomes (A_x, A_y).
      // Lists then broadcast/reduce away (mirror of web/main.ts).
      const lower = (e: Expr): Expr => lowerObjects(e, defs, ropts);
      const maps = panelMaps[panel];
      row.cls = classifyRow(
        maps ? { ...resolved, integral: null } : resolved,
        lower,
        constNames,
        fieldEnv,
        timeDifferentiator(defs),
      ).cls;
      if (maps) {
        // A mapped panel draws per-pixel rows in its screen coordinates, and
        // carries what places points there as it is drawn (lib/axis-map.ts).
        const how = row.cls.needs3D ? null : axisMapping(row.cls.object);
        if (!how) throw new Error(UNMAPPED_MESSAGE);
        if (how === 'substitute')
          row.cls = classifyRow(
            { ...resolved, integral: null },
            e => mapRowExpr(inlineFields(lower(e), fieldEnv), maps),
            constNames,
            fieldEnv,
            timeDifferentiator(defs),
          ).cls;
      }
      if (graphArgs !== null) {
        row.cls = graphObject(row.cls);
        continue;
      }
      if (markArg !== null) {
        if (row.cls.object.kind !== 'value')
          throw new Error('mark(v) highlights the vertex v of the graphs in its panel: give it one number.');
        row.mark = true;
        continue;
      }
      // A solid whose shape reads sliders is checked for folds at their values.
      checkSolid(row.cls.object, ropts.consts!);
      const hint = curveHint(row.cls.object, row.text);
      if (hint) row.info = hint;
      // `e = 0.6` parsed with e already a number; only the text still says e.
      // `i = [0..9]` is a family of such claims, one per member.
      const taken = takenDefinitionName(row.text);
      const object = row.cls.object;
      if (taken && object.kind === 'note') row.cls = { ...row.cls, object: { ...object, constant: taken } };
      else if (taken && object.kind === 'family' && object.members.every(m => m.object.kind === 'note')) {
        const members = object.members.map(m => ({ ...m, object: { ...m.object, constant: taken } as MathObject }));
        row.cls = { ...row.cls, object: { ...object, members } };
      }
    } catch (e) {
      // A row reading a dropped CSV is not broken here — the bytes simply
      // live on the device that made the graph, and never travelled in the
      // link. Report that as a gap in this render, not as a bad row.
      if (e instanceof MissingDataError) {
        row.dataLocal = e.message;
        row.needsFile = true;
      } else {
        row.error = e instanceof Error ? e.message : String(e);
        // `i = [0..239]` fails as a claim about i (too many members); the
        // author meant a definition, so say why it is not one.
        const taken = takenDefinitionName(row.text);
        if (taken && taken !== 'd') row.error = `${row.error.replace(/\.$/, '')} — ${takenNameHint(taken)}.`;
      }
    }
  }

  // Backend compilation is explicit and never changes the semantic object.
  // OG requests only CPU plans; readouts do not enter compilation identity.
  for (const row of rows) {
    if (!row.cls || row.error || row.dataLocal) continue;
    try {
      if (backend !== 'gpu' || readouts) row.cpu = compileCpu(row.cls);
      if (backend !== 'cpu') row.gpu = compileGpu(row.cls);
      if (readouts && row.cpu) {
        try {
          const info = plotReadout(row.cpu, {
            ...readoutEnv,
            ...document.boundVals,
            t: readoutPolicy === 'static' ? 0 : time,
          });
          if (info !== null) row.info = info;
        } catch {
          if (readoutPolicy === 'static' && row.cpu.type === 'value') row.info = '= …';
        }
      }
      const note = memberNotes.get(row);
      if (note) {
        row.note = note;
        row.info = withNote(row.info, note);
      }
    } catch (error) {
      row.error = error instanceof Error ? error.message : String(error);
      row.cpu = undefined;
      row.gpu = undefined;
    }
  }

  // A binder has no readout of its own: its note is its info.
  for (const row of rows) {
    if (row.error || row.def?.kind !== 'const' || !row.def.draw) continue;
    const note = pairDrawNote(row.def.name, row.def.rhs);
    if (note) row.info = row.note = note;
  }

  // A view naming index axes (one, as a panel sharing the other writes it)
  // needs a lattice in its panel with those axes; on the plane it is a slip
  // for x and y: `view(X = -1..1, Y = -2..2)`.
  let panelAt = 0;
  const latticeAxes: string[][] = [[]];
  const indexViews: Array<[(typeof rows)[number], number, string[]]> = [];
  for (const row of rows) {
    if (row.view?.kind === 'split') latticeAxes[++panelAt] = [];
    const cpu = row.cpu;
    if (cpu?.type === 'automaton' || cpu?.type === 'lattice') latticeAxes[panelAt].push(...cpu.axes);
    if (row.view?.kind === 'view' && row.view.axes) indexViews.push([row, panelAt, row.view.axes.filter(Boolean)]);
  }
  for (const [row, at, axes] of indexViews)
    if (!axes.every(a => latticeAxes[at].includes(a))) {
      row.error = 'view(…) frames the plane with x and y; an index axis names a lattice in this panel.';
      row.view = undefined;
    }

  try {
    constEnv = evaluateFrame(defs, time, stateVals);
  } catch {
    /* row errors already reported */
  }
  rvs.prune();
  return { rows, defs, constEnv, rvs, rvNames, gridFields, document };
}

/** Worker/preview convenience: initial state at t=0, with a fresh sampler. */
export function analyzeRows(
  sources: readonly (string | RowSource)[],
  options: AnalyzeOpts & PrepareOptions = {},
): Analysis {
  const document = prepareDocument(sources, options);
  const stateValues = document.stateSystem ? initialState(document.defs, document.stateSystem) : {};
  return analyzePrepared(document, { stateValues, readouts: options.readouts, backend: options.backend });
}
