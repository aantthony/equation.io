/** Shared document preparation and runtime-aware mathematical analysis. */
import { compileCpu, compileGpu, type CpuPlan, type GpuPlan } from './compiler.ts';
import type { LevelSetSpec } from './math-object.ts';
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
  isListName,
  indexIssue,
  MissingDataError,
  resolveExpr,
  resolveRow,
  shadowedFnNames,
  scanDefinition,
  takenDefinitionName,
  timeDifferentiator,
  type Definition,
  type TableSource,
  pointComponentNames,
} from './defs.ts';
import {
  NO_MEAN_INFO,
  RVSystem,
  buildRVDeclarations,
  type BuiltRVs,
  checkDerived,
  lowerProbBody,
  matchExpectation,
  matchProbability,
  momentsReadout,
  readoutNumber,
  probabilityValue,
  regionExpr,
  scanRandomRows,
  toExpectation,
  toProbability,
  variableRow,
} from './dist.ts';
import { type Expr, freeVars, parseExpr } from './expr.ts';
import { lowerGeom } from './geom.ts';
import { lowerLists } from './list.ts';
import { type Classified, classify, classifyRow, plotReadout } from './plot.ts';
import { scanRegressions, formatFit } from './regression.ts';
import { type SeqScan, classifySeqRec, scanSequences, sequenceResolver } from './seq.ts';
import { classifyAutomatonRow } from './automaton.ts';
import { buildStateSystem, initialState } from './state.ts';
import { stripNote } from './statements.ts';
import { overParams, planarField } from './grid.ts';
import { type ViewSpec, parseViewRow } from './view.ts';

export interface RowSource { id?: string | number; text: string }

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
  /** Readout shown under the row in the app (the numeric value of a P(…) or E(…) row). */
  info?: string;
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

export interface PrepareOptions { tables?: TableSource }

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

/** No source splitting here: one input row remains one result, including blanks. */
export function prepareDocument(sources: readonly (string | RowSource)[], { tables }: PrepareOptions = {}): PreparedDocument {
  // A trailing `# note` is prose for the reader; the math is what precedes it.
  const rows: RowInfo[] = sources.map(source => typeof source === 'string'
    ? { text: stripNote(source).trim() } : { ...source, text: stripNote(source.text).trim() });
  const texts = rows.map(row => row.text);
  const seqScans = scanSequences(texts);
  const statements: StatementScan[] = rows.map((source, i) => ({ source, kind:
    !source.text ? 'blank' : source.text.startsWith('#') ? 'comment'
      : /^(view|camera)\s*\(/i.test(source.text) ? 'viewport'
      : seqScans[i] ? 'sequence'
      : source.text.includes('~') ? 'distribution'
      : scanDefinition(source.text) ? 'definition' : 'expression',
  }));

  // Random-variable rows (`X ~ …`, and `Y = X^2` referencing one) resolve
  // outside the definition system — mirror of web/main.ts recompileAll.
  const regressions = scanRegressions(texts);
  const rvScan = scanRandomRows(rows.map((r, i) =>
    regressions.has(i) || !r.text || r.text.startsWith('#') || seqScans[i] ? null : r.text));
  const rvRowIdx = new Set([...rvScan.base.keys(), ...rvScan.derived.keys()]);

  // Pass 1: definitions. A duplicate coordinate-field row (r = 1 + cos(theta)
  // after r = sqrt(x^2+y^2)) is a plot in that coordinate system, not an error.
  const raw: Definition[] = [];
  const defNames = new Set<string>();
  const dupRows: RowInfo[] = [];
  for (const [i, row] of rows.entries()) {
    if (!row.text) continue;
    // `# label` rows are comments (collapsible group headings in the app).
    if (row.text.startsWith('#')) { row.comment = true; continue; }
    if (rvRowIdx.has(i)) continue;
    // Sequence/recurrence rows (a_n = …, a_{n+1} = …) are plots, not definitions.
    if (seqScans[i]) continue;
    const d = regressions.get(i) ?? scanDefinition(row.text);
    if (!d) continue;
    row.def = d;
    if (defNames.has(defKey(d))) { dupRows.push(row); continue; }
    defNames.add(defKey(d));
    raw.push(d);
  }

  // An automaton's letter names rows of cells, not scalar terms (automaton.ts).
  const built = buildDefs(raw, tables, seqScans.filter((s): s is SeqScan => s !== null && !s.cell));
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
    if (built.needsFile.has(key)) { row.dataLocal = message; row.needsFile = true; }
    else row.error = message;
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
    const cols = table.data.columns.map(c => c.type === 'num' ? c.name : `${c.name} (text)`);
    row.info = [`${table.data.rows} rows`, cols.join(', '), ...table.data.warnings].join(' · ');
  }
  const stateSystem = buildStateSystem(defs);
  // Only static constants can affect compilation. Dummy states permit evaluating
  // unrelated constants; every state and dependent constant is removed below.
  let constEnv: Record<string, number> = {};
  try { constEnv = evaluateFrame(defs, 0, Object.fromEntries([...defs.states.keys()].map(n => [n, 0]))); }
  catch { /* failed definitions already carry diagnostics */ }

  // Pass 2: viewport rows and plots. States are constants to every consumer.
  const constNames = new Set([...defs.consts.keys(), ...defs.states.keys()]);
  const fieldEnv = Object.fromEntries(defs.fields);
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
    indexIssue: (idx: Expr) => indexIssue(idx, defs),
  };
  ropts.sequenceTerm = sequenceResolver(defs, getFn, ropts, constNames, new Set(raw.map(d => d.name)));

  const { declarations, ...builtRVs } = buildRVDeclarations(rvScan, {
    fnNames, getFn, ropts, constNames, taken: n => nameTaken(defs, n),
  });
  for (const [name, declaration] of declarations) defs.bind(name, { tag: 'rv', declaration });

  const gridFields: LevelSetSpec[] = [];
  const skipGrid = pointComponentNames(defs);
  for (const [name, expr] of defs.fields) {
    if (skipGrid.has(name) || !planarField(expr)) continue;
    try { gridFields.push({ name, expr, params: [...freeVars(expr)].filter(n => constNames.has(n)).sort() }); }
    catch (e) {
      const row = rows.find(r => r.def && defKey(r.def) === name);
      if (row && !row.error) row.error = e instanceof Error ? e.message : String(e);
    }
  }
  return { rows, statements, seqScans, raw, built, defs, rvScan, builtRVs, stateSystem,
    sumBoundConsts: built.sumBoundConsts, constNames, fieldEnv, fnNames,
    listNames, valueNames, getFn, getList, boundVals, structuralConsts, ropts, gridFields };
}

/** Resolve/classify with caller-owned runtime; preparation diagnostics stay reusable. */
/** `value(from..to)`: the orbit of a state (or anything drawn from states),
 *  one path per run when the value is a family's list. */
function classifyOrbit(value: Expr, [from, to]: [Expr, Expr], defs: Env, constNames: ReadonlySet<string>): Classified {
  const moving = new Set([...animatedConstNames(defs), ...defs.states.keys(), 't']);
  for (const bound of [from, to]) {
    if (bound.kind === 'vec' || bound.kind === 'list') throw new Error('An orbit runs between two times, like p(0..50).');
    const v = [...freeVars(bound)].find(n => moving.has(n) || !constNames.has(n));
    if (v) throw new Error(`An orbit's time range must hold still (found ${v}).`);
  }
  const items = value.kind === 'list' ? value.items : [value];
  const series = items.every(it => it.kind !== 'vec');
  const paths = items.map(it => {
    if (it.kind === 'vec') {
      if (series || (it.items.length !== 2 && it.items.length !== 3)) throw new Error('An orbit draws a 2D or 3D point, or one number against t.');
      return it.items;
    }
    if (it.kind === 'eq' || it.kind === 'ineq' || it.kind === 'data' || it.kind === 'list') throw new Error('An orbit draws a state, like p(0..50).');
    return [it];
  });
  if (!series && new Set(paths.map(p => p.length)).size > 1) throw new Error('All points in an orbit need the same number of coordinates.');
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

export function analyzePrepared(document: PreparedDocument, context: AnalysisContext = {}): Analysis {
  const { defs, constNames, fieldEnv, fnNames, listNames, valueNames, getFn, getList, ropts, gridFields } = document;
  const rows = document.rows.map(row => ({ ...row }));
  const { stateValues: stateVals = {}, time = 0, readouts = true, readoutPolicy = 'frame', backend = 'both' } = context;
  let constEnv: Record<string, number> = { ...stateVals };
  try { constEnv = evaluateFrame(defs, time, stateVals); } catch { /* definition diagnostics remain on rows */ }
  let readoutEnv: Record<string, number> = constEnv;
  if (readoutPolicy === 'static') {
    readoutEnv = {};
    try { readoutEnv = evaluateFrame(defs, 0); } catch { /* browser readouts omit unseeded state values */ }
  }

  // Random variables next, so P(…) and bare-expression rows can reference
  // them regardless of row order.
  const rvs = context.rvs ?? new RVSystem();
  rvs.useDeclarations(defs.rvs);
  const builtRVs = document.builtRVs;
  const rvNames = builtRVs.names;
  // How a variable's row draws is lib's (variableRow), shared with the app.
  const classifyVariable = (row: RowInfo, name: string): void => {
    const shape = variableRow(rvs, name);
    row.dist = shape.kind === 'pmf' ? 'pmf' : 'density';
    if (shape.kind === 'exact') {
      row.cls = classify(shape.density, constNames);
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
    } catch { /* not computable at t = 0 (animated): no readout */ }
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
  const parseRowBody = (body: string, top: (e: Expr, lower: (e: Expr) => Expr) => Expr = (e, lower) => lower(e)): Expr => top(
    resolveExpr(parseExpr(body, fnNames, listNames, valueNames), getFn, ropts),
    // Points first, as in a plot row: `P(X < g(A))` reads g at the point A.
    // (What geometry refuses keeps the message this body always gave.)
    e => {
      try { e = lowerGeom(e, n => compsOf(defs, n), n => defs.mats.get(n) ?? null, n => getList(n) !== null); } catch { /* as written */ }
      return lowerLists(e, getList, ropts);
    },
  );

  const seenViewKinds = new Set<string>();
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
      const view = parseViewRow(row.text, ropts.consts!);
      if (view) {
        if (seenViewKinds.has(view.kind)) throw new Error(`${view.kind} is already set by another row.`);
        seenViewKinds.add(view.kind);
        row.view = view;
        continue;
      }
      // `P(…)` shades an area under a declared density — unless the user has
      // defined P themselves, in which case the row is theirs.
      const probBody = defs.consts.has('P') || defs.fns.has('P') ? null : matchProbability(row.text);
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
          if (readouts) try {
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
          if (readouts) try {
            // A uniform-sum law still gets its exact value, and an event over
            // discrete variables is enumerated (mirror of the app's readout);
            // everything else estimates over joint samples.
            const { value, exact: settled } = rvs.eventProbability(p.body, single, readoutEnv);
            if (isFinite(value)) row.info = `≈ ${value.toFixed(settled ? 4 : 3)}`;
          } catch { /* animated or broken: no readout */ }
        }
        continue;
      }
      // `E(…)` is the mean of an expression in random variables — unless the
      // user has defined E themselves. Mirror of web/main.ts.
      const expectBody = defs.consts.has('E') || defs.fns.has('E') ? null : matchExpectation(row.text);
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
        if (readouts) try {
          // Closed form and quadrature both earn full display precision;
          // only the Monte Carlo fallback rounds to its noise floor.
          const m = rvs.exactMoments(name, readoutEnv) ?? rvs.quadMoments(name, readoutEnv);
          const value = m ? m.mean : rvs.mean(name, readoutEnv);
          if (isFinite(value)) row.info = `≈ ${readoutNumber(value, m ? 4 : 3)}`;
          else if (rvs.meanUnstable(name, readoutEnv)) row.info = NO_MEAN_INFO;
        } catch { /* animated or broken: no readout */ }
        continue;
      }
      const seq = document.seqScans[ri];
      if (seq?.cell) {
        const cls = classifyAutomatonRow(document.seqScans, ri, fnNames, getFn, constNames, ropts);
        if (cls) row.cls = cls;
        continue;
      }
      if (seq) {
        const first = document.seqScans.findIndex(s => s?.name === seq.name);
        if (first < ri) throw new Error(`Sequence ${seq.name} is already defined.`);
        row.cls = classifySeqRec(seq, fnNames, getFn, constNames, ropts, new Set(defs.sequences.keys()));
        continue;
      }
      // `d = 1` is no definition (d starts d/dx), and would otherwise fail
      // with advice about derivatives that the author never wrote.
      if (takenDefinitionName(row.text) === 'd') {
        throw new Error('d is taken by derivatives (d/dx), so it cannot name a slider or function. Pick another name, like k.');
      }
      const rawParsed = parseExpr(row.text, fnNames, listNames, valueNames);
      // `p(50..400)`: where p goes over that time — a range in call position,
      // which nothing else accepts.
      if (rawParsed.kind === 'bin' && rawParsed.op === '*' && rawParsed.b.kind === 'range') {
        const lower = (e: Expr): Expr => lowerObjects(resolveRow(e, getFn, ropts).expr, defs, ropts);
        row.cls = classifyOrbit(lower(rawParsed.a), rawParsed.b.args.map(lower) as [Expr, Expr], defs, constNames);
        continue;
      }
      const resolved = resolveRow(rawParsed, getFn, ropts);
      let parsed = resolved.expr;
      // A bare expression in random variables plots that derived density.
      const rvRefs = [...freeVars(parsed)].filter(n => rvNames.has(n));
      if (rvRefs.length) {
        for (const n of rvRefs) {
          if (!rvs.has(n)) throw new Error(`${n} has an error in its definition.`);
        }
        if (parsed.kind === 'ineq') {
          throw new Error(`An inequality in random variables is a probability: try P(${row.text}).`);
        }
        checkDerived(parsed, rvNames, constNames);
        const name = `@${row.id ?? ri}`;
        rvs.addAnonymous({ name, kind: 'derived', expr: parsed });
        classifyVariable(row, name);
        continue;
      }
      // Expand point arithmetic and geometry statements (segment, polygon, …)
      // into scalar expressions; a point name A becomes (A_x, A_y).
      // Lists then broadcast/reduce away (mirror of web/main.ts).
      const lower = (e: Expr): Expr => lowerObjects(e, defs, ropts);
      row.cls = classifyRow(resolved, lower, constNames, fieldEnv, timeDifferentiator(defs)).cls;
      // `e = 0.6` parsed with e already a number; only the text still says e.
      const taken = row.cls.object.kind === 'note' ? takenDefinitionName(row.text) : null;
      if (taken && row.cls.object.kind === 'note') row.cls = { ...row.cls, object: { ...row.cls.object, constant: taken } };

    } catch (e) {
      // A row reading a dropped CSV is not broken here — the bytes simply
      // live on the device that made the graph, and never travelled in the
      // link. Report that as a gap in this render, not as a bad row.
      if (e instanceof MissingDataError) { row.dataLocal = e.message; row.needsFile = true; }
      else row.error = e instanceof Error ? e.message : String(e);
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
          const info = plotReadout(row.cpu, { ...readoutEnv, ...document.boundVals, t: readoutPolicy === 'static' ? 0 : time });
          if (info !== null) row.info = info;
        } catch { if (readoutPolicy === 'static' && row.cpu.type === 'value') row.info = '= …'; }
      }
    } catch (error) {
      row.error = error instanceof Error ? error.message : String(error);
      row.cpu = undefined;
      row.gpu = undefined;
    }
  }

  try { constEnv = evaluateFrame(defs, time, stateVals); } catch { /* row errors already reported */ }
  rvs.prune();
  return { rows, defs, constEnv, rvs, rvNames, gridFields, document };
}

/** Worker/preview convenience: initial state at t=0, with a fresh sampler. */
export function analyzeRows(sources: readonly (string | RowSource)[], options: AnalyzeOpts & PrepareOptions = {}): Analysis {
  const document = prepareDocument(sources, options);
  const stateValues = document.stateSystem ? initialState(document.defs, document.stateSystem) : {};
  return analyzePrepared(document, { stateValues, readouts: options.readouts, backend: options.backend });
}
