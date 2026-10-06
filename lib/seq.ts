import { Env, type ValueDefinitions } from './env.ts';
/**
 * Sequences and recurrences.
 *
 * - `a_n = 1/n^2` is an explicit sequence: dots at integer abscissae
 *   (n = 0, 1, 2, …; non-finite terms are skipped). The UI offers a
 *   partial-sum toggle that plots S_N = Σ a_n instead.
 * - `a_{n+1} = r a_n (1 - a_n)` (also `a_(n+1)`) is a recurrence. With no
 *   other free variables it draws a cobweb diagram: the curve y = f(x), the
 *   diagonal y = x, and the iterated path from the seed. With `x` free in the
 *   right side, x becomes the parameter axis and the plot is the orbit
 *   diagram (e.g. the logistic bifurcation for x a_n (1 - a_n)).
 * - A recurrence whose step also reads n, another sequence at n, or a tuple
 *   at a position in n (`q_{n+1} = step(q_n, D[n + 1])`) is no single map:
 *   it draws its terms as dots, computed term by term.
 * - The seed is the constant `a_0` when defined (sliders work), else 1/2.
 *
 * The whole subscripted symbol (`a_n`) is one token, so these rows are
 * recognized by regex before definition scanning, like defs.ts does.
 */
import { exactCases } from './automaton.ts';
import { usesComplex } from './complex.ts';
import { type GetFn, RESERVED, type ResolveOpts, STACK_FNS, resolveExpr, substIdx, tupleExpr } from './defs.ts';
import { pointComps } from './geom.ts';
import { axesOf, isTuple, lowerLists, withAxes } from './list.ts';
import { indexNamesOf, listGetter } from './defs.ts';
import {
  GREEK_NAME_CHARS,
  TERM_AT_FN,
  WRITTEN_NAME_CHARS,
  type Expr,
  childrenOf,
  mapChildren,
  evaluate,
  freeVars,
  ineqComparisons,
  parseExpr,
  sameNumber,
  substVars,
} from './expr.ts';
import { type Classified } from './math-object.ts';

export interface SeqScan {
  /** True for a_{n+1} = … (recurrence); false for a_n = … (explicit term). */
  rec: boolean;
  name: string;
  index: string;
  rhs: string;
  /** Set for the rows that draw on the integer lattice (lib/automaton.ts):
   *  an automaton's rule and seed, and a table `T[i, j] = …`. Their letter
   *  names cells, not scalar terms. */
  lattice?: true;
  /** A cellular automaton's rows, `c_{n+1}[i] = …` and its seed `c_0[i] = …`,
   *  and a table's: the cell index they are written in. */
  cell?: string;
  /** The second cell index of a 2D automaton (`L_{n+1}[i, j]`) or a table. */
  cell2?: string;
  /** The seed row `c_0[i] = …` (with `cell`; its `index` is empty). */
  seed?: boolean;
  /** A seed written as a multiset of live cells, `L_0 = [(0, 0), (1, 0)]`. */
  seedList?: true;
  /** A table `T[i, j] = …`: a function on the integer lattice. */
  table?: true;
  /** On a recurrence: its seed row is `s_0 = ()`, the empty tuple. */
  emptySeed?: true;
  /** The row `s_0 = ()` itself, which only a tuple-valued recurrence reads. */
  emptyTuple?: true;
}

/** A sequence letter: one Latin or Greek letter (a_n, θ_n). */
const L = `[A-Za-z${GREEK_NAME_CHARS}]`;
/** A term reference by literal index: a_3 (or a₃, canonicalized), θ_2. */
const TERM_RE = new RegExp(`^(${L})_(\\d+)$`);
/** A term reference by a named index: a_k (a slider) or a_N (a list). */
const NAMED_RE = new RegExp(`^(${L})_([A-Za-z${GREEK_NAME_CHARS}]\\w*)$`);
/** a_n = …, also written a_{n} = … or a_(n) = …. */
const SEQ_RE = new RegExp(String.raw`^\s*(${L})_(?:(${L})|\{\s*(${L})\s*\}|\(\s*(${L})\s*\))\s*=(?!=)([\s\S]+)$`);
const REC_RE = new RegExp(
  String.raw`^\s*(${L})_(?:\{\s*(${L})\s*\+\s*1\s*\}|\(\s*(${L})\s*\+\s*1\s*\))\s*=(?!=)([\s\S]+)$`,
);
/** `[i]` or `[i, j]`: the cells an automaton row is written over. */
const CELLS = String.raw`\[\s*(${L})\s*(?:,\s*(${L})\s*)?\]`;
/** c_{n+1}[i] = … (or L_{n+1}[i, j] = …): cells stepping from the generation before. */
const CELL_REC_RE = new RegExp(
  String.raw`^\s*(${L})_(?:\{\s*(${L})\s*\+\s*1\s*\}|\(\s*(${L})\s*\+\s*1\s*\))\s*${CELLS}\s*=(?!=)([\s\S]+)$`,
);
/** c_0[i] = …: the generation an automaton starts from. */
const CELL_SEED_RE = new RegExp(String.raw`^\s*(${L})_(?:0|\{\s*0\s*\}|\(\s*0\s*\))\s*${CELLS}\s*=(?!=)([\s\S]+)$`);
/** L_0 = [(0, 0), (1, 0)]: a seed as the multiset of its live cells. Only an
 *  automaton's seed when the letter has a rule (scanSequences). */
const CELL_SET_RE = new RegExp(String.raw`^\s*(${L})_(?:0|\{\s*0\s*\}|\(\s*0\s*\))\s*=(?!=)\s*(\[[\s\S]*)$`);
/** s_0 = (): a tuple-valued recurrence starting from the empty tuple. */
const EMPTY_SEED_RE = new RegExp(String.raw`^\s*(${L})_(?:0|\{\s*0\s*\}|\(\s*0\s*\))\s*=(?!=)\s*\(\s*\)\s*$`);
/** T[i, j] = …: a function on the integer lattice. */
const TABLE_RE = new RegExp(String.raw`^\s*(${L})\s*\[\s*(${L})\s*,\s*(${L})\s*\]\s*=(?!=)([\s\S]+)$`);

/** The last term a sequence computes. */
const SEQ_MAX = 1000;
/** The longest tuple a tuple-valued recurrence's term may be. */
const TUPLE_MAX = 10000;

/** A tuple-valued recurrence's terms, computed as numbers from its seed on
 *  (ResolveOpts.tupleRun). `point` is its seed's dimension when the seed is
 *  a point, (0.5, 0) or (1, 2, 3). */
export interface TupleRun {
  readonly terms: readonly (readonly number[])[];
  readonly point?: 2 | 3;
}

/** A value inside a tuple-valued recurrence's step: one number, or a tuple. */
type TupleValue = number | number[];

/** A run stopped by its own rules rather than broken: off the end of its
 *  input or its stack, or at a step with no case that holds (a machine with
 *  no move). Drawn, the run just ends there. */
const HALTS = /out of range|no case/i;

/** Whether `e` is built from tuples: a tuple, push or pop. */
const tupleish = (e: Expr): boolean =>
  e.kind === 'vec' ||
  (e.kind === 'list' && isTuple(e)) ||
  (e.kind === 'call' && STACK_FNS.has(e.name)) ||
  childrenOf(e).some(tupleish);

/** Whether `e` still holds a stack call: one on a tuple not known yet when
 *  it resolved, or on the empty tuple in a case that may not hold. */
const stackCalls = (e: Expr): boolean => (e.kind === 'call' && STACK_FNS.has(e.name)) || childrenOf(e).some(stackCalls);

/**
 * A tuple-valued recurrence's step, resolved at one n, run to its value.
 * Tuples are numbers here, so a case may hold tuples of different lengths
 * and only the case that holds is run (a stack that grows on one symbol and
 * shrinks on another). What no tuple touches goes to `leaf`, one number.
 */
function runTuple(e: Expr, leaf: (e: Expr) => TupleValue): TupleValue {
  // Terms already computed arrive as numbers: read them as they are.
  if (e.kind === 'num') return e.value;
  if (!tupleish(e)) return leaf(e);
  const one = (x: Expr): number => {
    const v = runTuple(x, leaf);
    if (typeof v !== 'number')
      throw new Error('A tuple is not one number: read one element of it, like top(s) or s[1].');
    return v;
  };
  const tuple = (x: Expr): number[] => {
    const v = runTuple(x, leaf);
    return typeof v === 'number' ? [v] : v;
  };
  const holds = (cond: Expr): boolean => {
    if (cond.kind === 'eq') return sameNumber(one(cond.l), one(cond.r));
    if (cond.kind === 'ineq')
      return ineqComparisons(cond).every(({ op, l, r }) => {
        const [a, b] = [one(l), one(r)];
        return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
      });
    return (
      leaf({
        kind: 'piecewise',
        cases: [{ cond, value: { kind: 'num', value: 1 } }],
        otherwise: { kind: 'num', value: 0 },
      }) === 1
    );
  };
  switch (e.kind) {
    case 'vec':
    case 'list':
      return e.items.map(one);
    case 'piecewise': {
      for (const c of e.cases) if (holds(c.cond)) return runTuple(c.value, leaf);
      if (e.otherwise) return runTuple(e.otherwise, leaf);
      throw new Error('No case of the step holds.');
    }
    case 'call': {
      if (e.name === 'push') {
        if (!e.args.length) throw new Error('push takes a tuple and what to push onto it: push(s, a).');
        return [...tuple(e.args[0]), ...e.args.slice(1).flatMap(tuple)];
      }
      if (e.name === 'pop' || e.name === 'top' || e.name === 'count') {
        if (e.args.length !== 1) throw new Error(`${e.name} takes one tuple: ${e.name}(s).`);
        const s = tuple(e.args[0]);
        if (e.name === 'count') return s.length;
        if (!s.length) throw new Error(`${e.name}(…) of the empty tuple is out of range.`);
        return e.name === 'top' ? s[s.length - 1] : s.slice(0, -1);
      }
      return evaluate({ ...e, args: e.args.map((a): Expr => ({ kind: 'num', value: one(a) })) }, {});
    }
    case 'index': {
      const s = tuple(e.args[0]);
      const k = one(e.args[1]);
      if (!Number.isInteger(k) || k < 1 || k > s.length)
        throw new Error(
          `Position ${k} is out of range: the tuple has ${s.length} element${s.length === 1 ? '' : 's'}.`,
        );
      return s[k - 1];
    }
    case 'neg': {
      const a = runTuple(e.a, leaf);
      return typeof a === 'number' ? -a : a.map(x => -x);
    }
    case 'bin': {
      const a = runTuple(e.a, leaf);
      const b = runTuple(e.b, leaf);
      const op = (x: number, y: number) =>
        evaluate({ kind: 'bin', op: e.op, a: { kind: 'num', value: x }, b: { kind: 'num', value: y } }, {});
      if (typeof a === 'number' && typeof b === 'number') return op(a, b);
      if (typeof a !== 'number' && typeof b !== 'number') {
        if ((e.op !== '+' && e.op !== '-') || a.length !== b.length)
          throw new Error('Tuples add and subtract position by position, and only when they are the same length.');
        return a.map((x, k) => op(x, b[k]));
      }
      if (typeof a === 'number' && e.op === '*') return (b as number[]).map(y => op(a, y));
      if (typeof b === 'number' && (e.op === '*' || e.op === '/')) return (a as number[]).map(x => op(x, b));
      throw new Error('A tuple scales by a number (2 s, s/2); push(s, a) adds to it.');
    }
    default:
      throw new Error(`A tuple cannot be read here: ${e.kind}.`);
  }
}

/** Indices that read as a sequence on sight, so `a_n = 5` is the constant
 *  sequence rather than a constant named a_n. */
const SEQ_INDICES = new Set(['n', 'k', 'm']);

/** The index as a standalone identifier in the term: `a_j = 1/j^2` is a
 *  sequence, but `T_c = 300` and `k_B = 1.38` are subscripted constants. */
const usesIndex = (rhs: string, index: string): boolean =>
  // Written classes on purpose: in `c₁n` the n is part of a name (c_1n),
  // not the standalone index, and only the written class can see that.
  new RegExp(`(?<![${WRITTEN_NAME_CHARS}])${index}(?![${WRITTEN_NAME_CHARS}])`).test(rhs);

/** The names a term reads by position (`w` in `w[n+1]`): tuples and lists,
 *  which a step that reads n indexes term by term. */
function indexedNames(e: Expr, out = new Set<string>()): Set<string> {
  if (e.kind === 'index' && e.args[0].kind === 'var') out.add(e.args[0].name);
  for (const c of childrenOf(e)) indexedNames(c, out);
  return out;
}

/** `[term]("…_a_", k)` at a whole k, once a step's n is a number: the chain
 *  constant itself, which a constant (unlike a plotted term) can depend on.
 *  `at` gives it, computing it first if the chain does not hold it yet. */
function pinTerms(e: Expr, at: (chain: string, k: number) => Expr): Expr {
  if (e.kind === 'call' && e.name === TERM_AT_FN) {
    const [chain, index] = e.args;
    if (chain.kind === 'str' && freeVars(index).size === 0) {
      const k = evaluate(index, {});
      return Number.isInteger(k) && k >= 0 && k <= SEQ_MAX ? at(chain.value, k) : { kind: 'num', value: NaN };
    }
  }
  return mapChildren(e, c => pinTerms(c, at));
}

/** Detect a sequence/recurrence row before definition scanning. */
export function scanSeqRec(text: string): SeqScan | null {
  let m = CELL_REC_RE.exec(text);
  if (m)
    return {
      rec: true,
      lattice: true,
      name: m[1],
      index: m[2] ?? m[3],
      cell: m[4],
      ...(m[5] ? { cell2: m[5] } : {}),
      rhs: m[6],
    };
  m = CELL_SEED_RE.exec(text);
  if (m)
    return {
      rec: false,
      lattice: true,
      seed: true,
      name: m[1],
      index: '',
      cell: m[2],
      ...(m[3] ? { cell2: m[3] } : {}),
      rhs: m[4],
    };
  m = TABLE_RE.exec(text);
  if (m) return { rec: false, lattice: true, table: true, name: m[1], index: '', cell: m[2], cell2: m[3], rhs: m[4] };
  m = REC_RE.exec(text);
  if (m) return { rec: true, name: m[1], index: m[2] ?? m[3], rhs: m[4] };
  m = SEQ_RE.exec(text);
  if (m) {
    // Every letter_letter row used to be a sequence, which stole the
    // subscripted constants physics and chemistry are written with (T_c,
    // k_B, v_x). Require a conventional index or one the term actually uses.
    const [, name, plain, braced, paren, rhs] = m;
    const index = plain ?? braced ?? paren;
    if (SEQ_INDICES.has(index) || (!RESERVED.has(index) && usesIndex(rhs, index))) {
      return { rec: false, name, index, rhs };
    }
  }
  return null;
}

/**
 * scanSeqRec over a whole document. A letter can be a sequence once: beside
 * `a_n = 1/n`, a row like `a_k = 7` that never uses its k is the constant
 * a_k (as `T_c = 300` is), not a second definition of a.
 */
export function scanSequences(texts: readonly string[]): (SeqScan | null)[] {
  const scans = texts.map(scanSeqRec);
  const owners = new Set(scans.filter(s => s && (s.rec || usesIndex(s.rhs, s.index))).map(s => s!.name));
  // `L_0 = [(0, 0), …]` is the constant L_0 unless L is an automaton.
  const automata = new Set(scans.filter(s => s?.cell && s.rec).map(s => s!.name));
  // `s_0 = ()` is no constant (there is no empty value to name) but the
  // empty tuple a recurrence s starts from.
  const recurrences = new Set(scans.filter(s => s?.rec && !s.lattice).map(s => s!.name));
  const empty = new Set(
    texts.flatMap(t => {
      const m = EMPTY_SEED_RE.exec(t);
      return m && recurrences.has(m[1]) ? [m[1]] : [];
    }),
  );
  return scans.map((s, k) => {
    if (!s) {
      const m = CELL_SET_RE.exec(texts[k]);
      if (m && automata.has(m[1]))
        return { rec: false, lattice: true, seed: true, seedList: true, name: m[1], index: '', rhs: m[2] };
      const e = EMPTY_SEED_RE.exec(texts[k]);
      return e && empty.has(e[1]) ? { rec: false, emptyTuple: true, name: e[1], index: '', rhs: '()' } : null;
    }
    if (s.rec && !s.lattice && empty.has(s.name)) return { ...s, emptySeed: true };
    return !s.rec && !s.lattice && owners.has(s.name) && !usesIndex(s.rhs, s.index) ? null : s;
  });
}

export function classifySeqRec(
  scan: SeqScan,
  fnNames: ReadonlySet<string>,
  getFn: GetFn,
  constNames: ReadonlySet<string>,
  ropts: ResolveOpts = {},
  /** Every sequence in the document, so b_n and b_[n+1] read as its terms. */
  sequences: ReadonlySet<string> = new Set(),
  /** The document's tuples and lists, so T[n + 1] reads as an index. */
  indexNames: ReadonlySet<string> = new Set(),
): Classified {
  const { name, index, rhs } = scan;
  if (RESERVED.has(index)) {
    throw new Error(`"${index}" is reserved; index sequences with n, k, or m.`);
  }
  const run = scan.rec ? ropts.tupleRun?.(name) : null;
  if (run) return classifyTupleRun(scan, run, fnNames, constNames);
  // Σ/Π with constant bounds expand here, as anywhere else. A bound that uses
  // the index (a_n = Σ(s=1..n, s)) stays a sum; evaluate() runs it at each n.
  const openVars = new Set(ropts.openVars);
  openVars.add(index);
  const source = parseExpr(rhs, fnNames, new Set([...indexNames, ...[...sequences].map(s => s + '_')]));
  // A recurrence's own a_n (a_{n}, a_(n)) is its previous term, the variable
  // the map steps — not a lookup into the terms it is defining.
  const recVar = `${name}_${index}`;
  const lookup = ropts.sequenceTerm;
  const sequenceTerm: ResolveOpts['sequenceTerm'] =
    scan.rec && lookup
      ? (symbol, at, open) =>
          symbol === recVar || (symbol === `${name}_` && at?.kind === 'var' && at.name === index)
            ? { kind: 'var', name: recVar }
            : lookup(symbol, at, open)
      : lookup;
  // Terms are at whole n, so a case may test equality: {mod(n, 2) = 0: …}.
  const parsed = exactCases(resolveExpr(source, getFn, { ...ropts, openVars, sequenceTerm, exactConditions: true }));
  // A list may be named w, which is otherwise the complex variable.
  const lists = [...freeVars(parsed)].filter(v => ropts.isList?.(v) || indexedNames(parsed).has(v));
  const zeroLists = Object.fromEntries(lists.map(v => [v, { kind: 'num', value: 0 } as Expr]));
  if (usesComplex(substVars(parsed, zeroLists))) throw new Error('Sequences are real-valued; use re(…) or im(…).');

  const vars = freeVars(parsed);
  const params: string[] = [];
  for (const v of [...vars]) {
    if (constNames.has(v)) {
      params.push(v);
      vars.delete(v);
    }
  }
  const animated = vars.delete('t');

  // The seed constant (a_0), when the user defined one. Listed in params so
  // slider drags and animated definitions re-render, though it reaches the
  // renderers as a dedicated seed value rather than through the field.
  const a0Name = constNames.has(`${name}_0`) ? `${name}_0` : undefined;

  if (!scan.rec) {
    vars.delete(index);
    for (const v of vars) {
      const tuple = v.endsWith('_') && sequences.has(v.slice(0, -1)) ? v.slice(0, -1) : null;
      if (tuple)
        throw new Error(
          `${tuple}'s terms are tuples, with no formula in ${index} to draw: read one at a number (count(${tuple}_3), top(${tuple}_k)), or in a recurrence's step (q_{${index}+1} = f(q_${index}, top(${tuple}_${index}))).`,
        );
      throw new Error(`A sequence term may only use ${index}, t, and constants (found ${v}).`);
    }
    params.sort();
    return { object: { kind: 'sequence', form: 'explicit', term: parsed, index }, animated, needs3D: false, params };
  }

  const bifurcation = vars.delete('x');
  vars.delete(recVar);
  if (vars.has('y')) throw new Error('Put the recurrence parameter on the x-axis (use x, not y).');
  // A step that reads n (directly, through another sequence's term at n, or
  // as a position in a tuple, w[n+1]) is no single map to draw as a cobweb:
  // the row draws its terms instead, read from the chain that computes them.
  const stepped = vars.delete(index) || lists.length > 0;
  for (const v of lists) vars.delete(v);
  if (stepped) {
    if (bifurcation)
      throw new Error(`A recurrence that reads ${index} or a tuple draws its terms; it cannot also take x.`);
    for (const v of vars) {
      throw new Error(`Unknown variable: ${v}. Define "${v} = 1" to make a slider.`);
    }
    const term = lookup?.(`${name}_`, { kind: 'var', name: index }, openVars);
    if (!term) throw new Error(`Recurrence ${name} needs the rest of the document to compute its terms.`);
    if (a0Name) params.push(a0Name);
    params.sort();
    return { object: { kind: 'sequence', form: 'explicit', term, index }, animated, needs3D: false, params };
  }
  for (const v of vars) {
    throw new Error(`Unknown variable: ${v}. Define "${v} = 1" to make a slider.`);
  }
  if (a0Name) params.push(a0Name);
  params.sort();

  return {
    object: {
      kind: 'sequence',
      form: bifurcation ? 'bifurcation' : 'cobweb',
      expr: parsed,
      variable: recVar,
      seedName: a0Name,
    },
    animated,
    needs3D: false,
    params,
  };
}

/**
 * A tuple-valued recurrence's row: its terms, one per row of a lattice (row
 * n, position h across, from 1), as a stack is drawn over time — or, when it
 * starts from a point and every term is one, the points of its orbit.
 */
function classifyTupleRun(
  scan: SeqScan,
  run: TupleRun,
  fnNames: ReadonlySet<string>,
  constNames: ReadonlySet<string>,
): Classified {
  const { name, index } = scan;
  // The run is computed once, at these values: a slider recomputes it.
  const params = [...freeVars(parseExpr(scan.rhs, fnNames))].filter(v => constNames.has(v));
  if (constNames.has(`${name}_0`)) params.push(`${name}_0`);
  params.sort();
  const { terms, point } = run;
  if (point && terms.length && terms.every(t => t.length === point))
    return {
      object: {
        kind: 'list',
        element: 'point',
        storage: 'packed',
        dimension: point,
        coordinates: Array.from({ length: point }, (_, c) => Float64Array.from(terms, t => t[c])),
      },
      animated: false,
      needs3D: point === 3,
      params,
    };
  const across = index === 'h' ? 'k' : 'h';
  return {
    object: { kind: 'lattice', expr: { kind: 'num', value: NaN }, axes: [across, index], rows: terms },
    animated: false,
    needs3D: false,
    params,
  };
}

/** Sequence values share the same scalar/list pipeline as CSV columns.
 * Recurrences form a linear chain of computed constants rather than an
 * exponentially duplicated expression. Those constants become uniforms. */
export function sequenceResolver(
  defs: ValueDefinitions,
  getFn: GetFn,
  opts: ResolveOpts,
  known: Set<string>,
  protectedNames: ReadonlySet<string> = new Set(),
  defineConstant: (name: string, expr: Expr) => void = (name, expr) => {
    if (!(defs instanceof Env)) throw new Error('Sequence construction needs a binding writer.');
    defs.bind(name, { tag: 'scalar', role: 'const', expr });
  },
) {
  const resolving = new Set<string>();
  /** A sequence's source resolved: at whole n, a case may test equality. */
  const resolveSeq = (e: Expr, extra: ResolveOpts = {}): Expr =>
    exactCases(resolveExpr(e, getFn, { ...opts, ...extra, exactConditions: true }));
  const chained = (name: string, i: number) => `${defs.sequencePrefix}_${name}_${i}`;

  /** Whether recurrence `name` is tuple-valued: it starts from a tuple
   *  (`s_0 = ()`, `p_0 = (0.1, 0)`) or its step pushes or pops. */
  const tupleValued = new Map<string, boolean>();
  const usesStack = (e: Expr, seen: Set<string>): boolean => {
    if (e.kind === 'call' && (e.name === 'push' || e.name === 'pop')) return true;
    if (e.kind === 'call' && !seen.has(e.name)) {
      seen.add(e.name);
      try {
        const fn = getFn(e.name);
        if (fn && usesStack(fn.body, seen)) return true;
      } catch {
        /* a broken function says so where it is called */
      }
    }
    return childrenOf(e).some(c => usesStack(c, seen));
  };
  const isTupleSeq = (name: string): boolean => {
    const known = tupleValued.get(name);
    if (known !== undefined) return known;
    const scan = defs.sequences.get(name);
    let tuple = false;
    if (scan?.rec && !scan.lattice) {
      const seed = `${name}_0`;
      const list = defs.lists.get(seed);
      tuple = !!scan.emptySeed || defs.pointDims.has(seed) || (!!list && isTuple(list));
      if (!tuple)
        try {
          tuple = usesStack(parseExpr(scan.rhs, new Set(defs.fns.keys()), indexNames()), new Set());
        } catch {
          /* its row reports the parse error */
        }
    }
    tupleValued.set(name, tuple);
    return tuple;
  };
  /** Tuple-valued recurrences' terms so far, and the error a run stopped at. */
  const runs = new Map<string, { terms: number[][]; end?: Error }>();
  const computing = new Set<string>();
  /** One number a tuple-valued step reads, with every name a constant. */
  const tupleLeaf =
    (name: string) =>
    (e: Expr): TupleValue => {
      const value = lowerLists(exactCases(e), listGetter(defs), opts);
      const env = opts.consts ?? {};
      for (const v of freeVars(value)) {
        if (v === 't')
          throw new Error(`${name}'s step reads a tuple, so it runs once, not over time: it cannot read t.`);
        if (env[v] === undefined) throw new Error(`Sequence ${name} terms need constant parameters (found ${v}).`);
      }
      // A tuple the document names (D, sort(L)) is a tuple here too.
      if ((value.kind === 'list' || value.kind === 'data') && isTuple(value))
        return value.kind === 'data' ? Array.from(value.values) : value.items.map(x => evaluate(x, env));
      if (value.kind === 'list' || value.kind === 'data')
        throw new Error(`Each element of ${name}'s terms must be one number, not a list.`);
      return evaluate(value, env);
    };
  /** The tuple a tuple-valued recurrence starts from: its seed `s_0`, or the
   *  empty tuple. */
  const tupleSeed = (name: string): number[] => {
    const seed = `${name}_0`;
    const scan = defs.sequences.get(name)!;
    if (scan.emptySeed) return [];
    const leaf = tupleLeaf(name);
    const dim = defs.pointDims.get(seed);
    if (dim) return pointComps(seed, dim).flatMap(c => leaf({ kind: 'var', name: c }));
    if (defs.lists.has(seed) || defs.consts.has(seed)) {
      const value = leaf({ kind: 'var', name: seed });
      return typeof value === 'number' ? [value] : value;
    }
    if (protectedNames.has(seed)) throw new Error(`${seed} has an error in its definition.`);
    return [];
  };
  /** Term k of tuple-valued recurrence `name`, as numbers: null past where
   *  its run stops when `partial`, else that stop's error. */
  const tupleTerm = (name: string, k: number, partial = false): number[] | null => {
    let run = runs.get(name);
    if (!run) runs.set(name, (run = { terms: [] }));
    if (k < run.terms.length) return run.terms[k];
    if (run.end) {
      if (partial) return null;
      throw run.end;
    }
    if (computing.has(name)) throw new Error(`Sequence ${name} depends on itself outside its recurrence.`);
    computing.add(name);
    try {
      const scan = defs.sequences.get(name)!;
      const leaf = tupleLeaf(name);
      while (run.terms.length <= k) {
        const i = run.terms.length;
        let next: number[];
        try {
          if (i === 0) next = tupleSeed(name);
          else {
            // The step at n = i − 1: its own s_n is the term just computed,
            // read (like any term at a number) through term() below.
            const parsed = parseExpr(scan.rhs, new Set(defs.fns.keys()), indexNames());
            const at = substIdx(parsed, scan.index, { kind: 'num', value: i - 1 });
            const value = runTuple(resolveSeq(at), leaf);
            next = typeof value === 'number' ? [value] : value;
          }
          if (next.length > TUPLE_MAX) throw new Error(`${name}_${i} is longer than ${TUPLE_MAX} elements.`);
        } catch (err) {
          if (!(err instanceof Error) || !HALTS.test(err.message)) throw err;
          const why = err.message.startsWith('No case')
            ? new Error(
                `No case of ${name}'s step holds at ${scan.index} = ${i - 1}, so its run stops at ${name}_${i - 1}.`,
              )
            : err;
          run.end = why;
          if (partial) return null;
          throw why;
        }
        run.terms.push(next);
      }
      return run.terms[k];
    } finally {
      computing.delete(name);
    }
  };
  const tupleRun = (name: string): TupleRun | null => {
    if (!isTupleSeq(name)) return null;
    tupleTerm(name, SEQ_MAX, true);
    const dim = defs.pointDims.get(`${name}_0`);
    return { terms: runs.get(name)!.terms, ...(dim === 2 || dim === 3 ? { point: dim } : {}) };
  };
  /** Term k of sequence `name`. `partial`: a recurrence whose chain breaks
   *  before k (its step reads past the end of a tuple) stops there, and the
   *  terms after it are missing rather than an error. */
  const term = (name: string, k: number, partial = false): Expr => {
    if (!Number.isInteger(k) || k < 0 || k > SEQ_MAX)
      throw new Error(`Sequence indices must be whole numbers from 0 to ${SEQ_MAX}.`);
    const scan = defs.sequences.get(name)!;
    // A tuple-valued recurrence's terms are numbers once computed: the term
    // is the tuple itself, as numbers (or missing, past where it stops).
    if (isTupleSeq(name)) {
      const value = tupleTerm(name, k, partial);
      return value ? tupleExpr(value) : { kind: 'num', value: NaN };
    }
    const key = `${name}_${k}`;
    if (protectedNames.has(key) || defs.consts.has(key)) return { kind: 'var', name: key };
    // A term the chain already holds: how a step that reads n, resolved term
    // by term, reaches its previous term while its sequence is resolving.
    if (scan.rec && defs.consts.has(chained(name, k))) return { kind: 'var', name: chained(name, k) };
    if (resolving.has(name)) throw new Error(`Sequence ${name} depends on itself outside its recurrence.`);
    resolving.add(name);
    try {
      const parsed = parseExpr(scan.rhs, new Set(defs.fns.keys()), indexNames());
      if (!scan.rec) {
        // Pin the index in the source (a Σ/∫ that rebinds it keeps its own),
        // then resolve ONCE — so a_5 of a_n = Σ(s=1..n, s) is the number 15,
        // not a sum node, and the term sees exactly what the plot row sees: a
        // second pass over an already-resolved body would re-apply the
        // tuple-call splat to vectors that functions computed.
        return resolveSeq(substIdx(parsed, scan.index, { kind: 'num', value: k }));
      }
      const recVar = `${name}_${scan.index}`;
      const body = resolveSeq(parsed);
      const isConstant = (v: string) => v === 't' || known.has(v) || defs.consts.has(v);
      const stepped = steps(name, body);
      if (!stepped)
        for (const v of freeVars(body)) {
          if (v !== recVar && !isConstant(v))
            throw new Error(`Sequence ${name} terms need constant parameters (found ${v}).`);
        }
      // A step that reads n is resolved once with n open, as its row is (its
      // own a_n the previous term, another sequence's b_n that term in n),
      // and is that expression at each n. A tuple position cannot be read at
      // an open n, so a step that reads one resolves its source per term.
      const open: Expr | null = stepped
        ? resolveSeq(parsed, {
            openVars: new Set([...(opts.openVars ?? []), scan.index]),
            sequenceTerm: (symbol, at, vars) =>
              symbol === recVar || (symbol === `${name}_` && at?.kind === 'var' && at.name === scan.index)
                ? { kind: 'var', name: recVar }
                : (opts.sequenceTerm?.(symbol, at, vars) ?? null),
          })
        : null;
      const openIndexed = open ? indexedNames(open) : new Set<string>();
      const byIndexAlone = open && ![...freeVars(open)].some(v => openIndexed.has(v) || !!opts.isList?.(v));
      if (byIndexAlone)
        for (const v of freeVars(open)) {
          if (v !== recVar && v !== scan.index && !isConstant(v) && !v.startsWith(`${defs.sequencePrefix}_`))
            throw new Error(`Sequence ${name} terms need constant parameters (found ${v}).`);
        }
      /** Another recurrence's term k, read from its chain: built now if it
       *  is not there yet, so a chain that stops early (a run off the end of
       *  its tuple) says why rather than naming a missing constant. */
      const chainTerm = (chain: string, k: number): Expr => {
        const other = chain.slice(defs.sequencePrefix.length + 1, -1);
        return defs.consts.has(`${chain}${k}`) || !defs.sequences.has(other)
          ? { kind: 'var', name: `${chain}${k}` }
          : term(other, k);
      };
      /** Step i of a recurrence that reads n: its source at n = i − 1, resolved
       *  and its tuple positions read, so each term is its own expression. */
      const stepAt = (i: number): Expr => {
        if (byIndexAlone)
          return pinTerms(
            substVars(open, {
              [recVar]: { kind: 'var', name: chained(name, i - 1) },
              [scan.index]: { kind: 'num', value: i - 1 },
            }),
            chainTerm,
          );
        const at = substIdx(substVars(parsed, { [recVar]: { kind: 'var', name: chained(name, i - 1) } }), scan.index, {
          kind: 'num',
          value: i - 1,
        });
        const resolved = resolveSeq(at);
        // A step reading a stack runs as a tuple-valued one does: only the
        // case that holds, so {count(s_n) = 0: 0, top(s_n)} is safe.
        if (stackCalls(resolved)) {
          const value = runTuple(resolved, tupleLeaf(name));
          if (typeof value !== 'number') throw new Error(`Each term of ${name} must be one number, not a tuple.`);
          return { kind: 'num', value };
        }
        const value = lowerLists(resolved, listGetter(defs), opts);
        if (value.kind === 'list' || value.kind === 'data')
          throw new Error(`Each term of ${name} must be one number, not a list.`);
        for (const v of freeVars(value)) {
          if (!isConstant(v)) throw new Error(`Sequence ${name} terms need constant parameters (found ${v}).`);
        }
        return value;
      };
      // A chain is built from 0 without gaps, so past the first missing term
      // every later one is missing too — and not asking matters: each binding
      // invalidates the Env's projections, so asking after one rebuilds them.
      let fresh = false;
      for (let i = 0; i <= k; i++) {
        const internal = chained(name, i);
        if (!fresh && defs.consts.has(internal)) continue;
        fresh = true;
        let value: Expr;
        if (i === 0)
          value =
            protectedNames.has(`${name}_0`) || defs.consts.has(`${name}_0`)
              ? { kind: 'var', name: `${name}_0` }
              : { kind: 'num', value: 0.5 };
        else if (!stepped) value = substVars(body, { [recVar]: { kind: 'var', name: chained(name, i - 1) } });
        else
          try {
            value = stepAt(i);
          } catch (err) {
            // Only a run off the end of a tuple (its own, or one another
            // sequence it reads steps over) ends the chain quietly.
            if (!partial || !HALTS.test((err as Error).message)) throw err;
            return { kind: 'num', value: NaN };
          }
        defineConstant(internal, value);
        known.add(internal);
        try {
          if (opts.consts) opts.consts[internal] = evaluate(value, opts.consts);
        } catch {
          /* resolved at frame time */
        }
      }
      return { kind: 'var', name: chained(name, k) };
    } finally {
      resolving.delete(name);
    }
  };
  /** Another sequence's term at the recurrence's own index, left as a name
   *  (b_n) when the step is resolved with n not yet open. */
  const otherTerm = (name: string, v: string): boolean => {
    const scan = defs.sequences.get(name)!;
    const m = NAMED_RE.exec(v);
    return !!m && m[1] !== name && m[2] === scan.index && defs.sequences.has(m[1]);
  };
  /** A step that reads n, another sequence at n, or a tuple: computed term by
   *  term rather than as one map applied over and over. */
  const steps = (name: string, body: Expr): boolean => {
    const index = defs.sequences.get(name)!.index;
    const indexed = indexedNames(body);
    return [...freeVars(body)].some(v => v === index || indexed.has(v) || !!opts.isList?.(v) || otherTerm(name, v));
  };
  /** What parses as an index in a sequence's row: its tuples and lists
   *  (T[n+1]) and the sequences themselves (b_[n+1]). */
  const indexNames = () => new Set([...indexNamesOf(defs), ...[...defs.sequences.keys()].map(n => n + '_')]);
  /**
   * Sequence `name`'s term at an index that is still open — another sequence
   * row's own n — as an expression in it: b_n in a_n = b_n + 1 is b's term,
   * written in n. Only an explicit term has one; a recurrence's terms exist
   * only as a chain from its seed.
   */
  const inline = (name: string, at: Expr, open: ReadonlySet<string>): Expr => {
    const scan = defs.sequences.get(name)!;
    // A tuple at an open n has no expression in n: left as the term it is,
    // s_[n], which a step reading it resolves term by term (stepAt).
    if (isTupleSeq(name)) return { kind: 'index', args: [{ kind: 'var', name: `${name}_` }, at] };
    if (scan.rec) {
      // No closed form: read the chain that computes its terms, all of them
      // (or up to where a step that reads a tuple runs off its end). Read
      // from another recurrence's step, it is read term by term instead, as
      // that chain grows — so two recurrences may read each other.
      if (!resolving.size) term(name, SEQ_MAX, true);
      const body = resolveSeq(parseExpr(scan.rhs, new Set(defs.fns.keys()), indexNames()));
      // The trailing inputs are names the row depends on: the step's
      // constants, not its index, its own term, lists or other sequences'.
      const stepped = steps(name, body);
      const indexed = indexedNames(body);
      const inputs = [...freeVars(body)].filter(
        v =>
          v !== `${name}_${scan.index}` &&
          (!stepped || (v !== scan.index && !opts.isList?.(v) && !indexed.has(v) && !otherTerm(name, v))),
      );
      if (protectedNames.has(`${name}_0`) || defs.consts.has(`${name}_0`)) inputs.push(`${name}_0`);
      return {
        kind: 'call',
        name: TERM_AT_FN,
        args: [
          { kind: 'str', value: `${defs.sequencePrefix}_${name}_` },
          at,
          ...inputs.map((v): Expr => ({ kind: 'var', name: v })),
        ],
      };
    }
    if (resolving.has(name)) {
      const cycle = [...resolving].slice([...resolving].indexOf(name));
      throw new Error(
        cycle.length > 1
          ? `Sequences ${cycle.join(' and ')} are defined in terms of each other.`
          : `Sequence ${name} depends on itself.`,
      );
    }
    resolving.add(name);
    try {
      const parsed = parseExpr(scan.rhs, new Set(defs.fns.keys()), indexNames());
      return resolveSeq(substIdx(parsed, scan.index, at), { openVars: open });
    } finally {
      resolving.delete(name);
    }
  };
  const resolve = (symbol: string, index?: Expr, open?: ReadonlySet<string>): Expr | null => {
    if (index === undefined) {
      const hit = TERM_RE.exec(symbol);
      if (hit) return defs.sequences.has(hit[1]) ? term(hit[1], Number(hit[2])) : null;
      // a_k or a_N: the term at a slider, or one per element of a list —
      // unless a_k is a name of its own.
      const named = NAMED_RE.exec(symbol);
      const scan = named && defs.sequences.get(named[1]);
      if (!named || !scan || protectedNames.has(symbol) || known.has(symbol)) return null;
      const k = named[2];
      // At an open index: the term there (a recurrence's own row keeps its
      // previous term a_n for itself — see classifySeqRec).
      if (open?.has(k)) return inline(named[1], { kind: 'var', name: k }, open);
      if (k === scan.index) return null;
      if (!opts.isList?.(k) && opts.consts?.[k] === undefined) return null;
      return resolve(`${named[1]}_`, { kind: 'var', name: k }, open);
    }
    const name = symbol.slice(0, -1);
    if (!symbol.endsWith('_') || !defs.sequences.has(name)) return null;
    // A recurrence's own previous term, written a_{n} or a_(n): its variable
    // a_n, as when written plainly.
    const scan = defs.sequences.get(name)!;
    if (scan.rec && index.kind === 'var' && index.name === scan.index && !open?.has(index.name))
      return { kind: 'var', name: `${name}_${scan.index}` };
    if (open && [...freeVars(index)].some(v => open.has(v))) return inline(name, index, open);
    const input: Expr = index.kind === 'range' ? { kind: 'list', items: [index] } : index;
    const indices = lowerLists(input, listGetter(defs), opts);
    const one = (e: Expr) => {
      for (const n of freeVars(e)) opts.boundConsts?.add(n);
      return term(name, evaluate(e, opts.consts ?? {}));
    };
    // One term per index, so a_[n] runs over the same instances n does.
    if (indices.kind === 'list') return withAxes({ kind: 'list', items: indices.items.map(one) }, axesOf(indices));
    if (indices.kind === 'data')
      return withAxes({ kind: 'list', items: Array.from(indices.values, k => term(name, k)) }, axesOf(indices));
    return one(indices);
  };
  return Object.assign(resolve, { tupleRun });
}
