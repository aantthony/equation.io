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
import { usesComplex } from './complex.ts';
import { type GetFn, RESERVED, type ResolveOpts, resolveExpr, substIdx } from './defs.ts';
import { axesOf, lowerLists, withAxes } from './list.ts';
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
  parseExpr,
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
/** T[i, j] = …: a function on the integer lattice. */
const TABLE_RE = new RegExp(String.raw`^\s*(${L})\s*\[\s*(${L})\s*,\s*(${L})\s*\]\s*=(?!=)([\s\S]+)$`);

/** The last term a sequence computes. */
const SEQ_MAX = 1000;

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
 *  constant itself, which a constant (unlike a plotted term) can depend on. */
function pinTerms(e: Expr): Expr {
  if (e.kind === 'call' && e.name === TERM_AT_FN) {
    const [chain, at] = e.args;
    if (chain.kind === 'str' && freeVars(at).size === 0) {
      const k = evaluate(at, {});
      return Number.isInteger(k) && k >= 0 && k <= SEQ_MAX
        ? { kind: 'var', name: `${chain.value}${k}` }
        : { kind: 'num', value: NaN };
    }
  }
  return mapChildren(e, pinTerms);
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
  return scans.map((s, k) => {
    if (!s) {
      const m = CELL_SET_RE.exec(texts[k]);
      return m && automata.has(m[1])
        ? { rec: false, lattice: true, seed: true, seedList: true, name: m[1], index: '', rhs: m[2] }
        : null;
    }
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
  const parsed = resolveExpr(source, getFn, { ...ropts, openVars, sequenceTerm });
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
  const chained = (name: string, i: number) => `${defs.sequencePrefix}_${name}_${i}`;
  /** Term k of sequence `name`. `partial`: a recurrence whose chain breaks
   *  before k (its step reads past the end of a tuple) stops there, and the
   *  terms after it are missing rather than an error. */
  const term = (name: string, k: number, partial = false): Expr => {
    if (!Number.isInteger(k) || k < 0 || k > SEQ_MAX)
      throw new Error(`Sequence indices must be whole numbers from 0 to ${SEQ_MAX}.`);
    const scan = defs.sequences.get(name)!;
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
        return resolveExpr(substIdx(parsed, scan.index, { kind: 'num', value: k }), getFn, opts);
      }
      const recVar = `${name}_${scan.index}`;
      const body = resolveExpr(parsed, getFn, opts);
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
        ? resolveExpr(parsed, getFn, {
            ...opts,
            openVars: new Set([...(opts.openVars ?? []), scan.index]),
            sequenceTerm: (symbol, at, vars) =>
              symbol === recVar || (symbol === `${name}_` && at?.kind === 'var' && at.name === scan.index)
                ? { kind: 'var', name: recVar }
                : (opts.sequenceTerm?.(symbol, at, vars) ?? null),
          })
        : null;
      const openIndexed = open ? indexedNames(open) : new Set<string>();
      const byIndexAlone = open && ![...freeVars(open)].some(v => openIndexed.has(v) || !!opts.isList?.(v));
      /** Step i of a recurrence that reads n: its source at n = i − 1, resolved
       *  and its tuple positions read, so each term is its own expression. */
      const stepAt = (i: number): Expr => {
        if (byIndexAlone)
          return pinTerms(
            substVars(open, {
              [recVar]: { kind: 'var', name: chained(name, i - 1) },
              [scan.index]: { kind: 'num', value: i - 1 },
            }),
          );
        const at = substIdx(substVars(parsed, { [recVar]: { kind: 'var', name: chained(name, i - 1) } }), scan.index, {
          kind: 'num',
          value: i - 1,
        });
        const value = lowerLists(resolveExpr(at, getFn, opts), listGetter(defs), opts);
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
            if (!partial) throw err;
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
    if (scan.rec) {
      // No closed form: read the chain that computes its terms, all of them
      // (or up to where a step that reads a tuple runs off its end).
      term(name, SEQ_MAX, true);
      const body = resolveExpr(parseExpr(scan.rhs, new Set(defs.fns.keys()), indexNames()), getFn, opts);
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
      return resolveExpr(substIdx(parsed, scan.index, at), getFn, { ...opts, openVars: open });
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
  return resolve;
}
