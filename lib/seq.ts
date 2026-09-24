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
 * - The seed is the constant `a_0` when defined (sliders work), else 1/2.
 *
 * The whole subscripted symbol (`a_n`) is one token, so these rows are
 * recognized by regex before definition scanning, like defs.ts does.
 */
import { usesComplex } from './complex.ts';
import { type GetFn, RESERVED, type ResolveOpts, resolveExpr, substIdx } from './defs.ts';
import { axesOf, lowerLists, withAxes } from './list.ts';
import { listGetter } from './defs.ts';
import { GREEK_NAME_CHARS, WRITTEN_NAME_CHARS, type Expr, evaluate, freeVars, parseExpr, substVars } from './expr.ts';
import { type Classified } from './math-object.ts';

export interface SeqScan {
  /** True for a_{n+1} = … (recurrence); false for a_n = … (explicit term). */
  rec: boolean;
  name: string;
  index: string;
  rhs: string;
}

/** A sequence letter: one Latin or Greek letter (a_n, θ_n). */
const L = `[A-Za-z${GREEK_NAME_CHARS}]`;
/** A term reference by literal index: a_3 (or a₃, canonicalized), θ_2. */
const TERM_RE = new RegExp(`^(${L})_(\\d+)$`);
/** A term reference by a named index: a_k (a slider) or a_N (a list). */
const NAMED_RE = new RegExp(`^(${L})_([A-Za-z${GREEK_NAME_CHARS}]\\w*)$`);
const SEQ_RE = new RegExp(String.raw`^\s*(${L})_(${L})\s*=(?!=)([\s\S]+)$`);
const REC_RE = new RegExp(String.raw`^\s*(${L})_(?:\{\s*(${L})\s*\+\s*1\s*\}|\(\s*(${L})\s*\+\s*1\s*\))\s*=(?!=)([\s\S]+)$`);

/** Indices that read as a sequence on sight, so `a_n = 5` is the constant
 *  sequence rather than a constant named a_n. */
const SEQ_INDICES = new Set(['n', 'k', 'm']);

/** The index as a standalone identifier in the term: `a_j = 1/j^2` is a
 *  sequence, but `T_c = 300` and `k_B = 1.38` are subscripted constants. */
const usesIndex = (rhs: string, index: string): boolean =>
  // Written classes on purpose: in `c₁n` the n is part of a name (c_1n),
  // not the standalone index, and only the written class can see that.
  new RegExp(`(?<![${WRITTEN_NAME_CHARS}])${index}(?![${WRITTEN_NAME_CHARS}])`).test(rhs);

/** Detect a sequence/recurrence row before definition scanning. */
export function scanSeqRec(text: string): SeqScan | null {
  let m = REC_RE.exec(text);
  if (m) return { rec: true, name: m[1], index: m[2] ?? m[3], rhs: m[4] };
  m = SEQ_RE.exec(text);
  if (m) {
    // Every letter_letter row used to be a sequence, which stole the
    // subscripted constants physics and chemistry are written with (T_c,
    // k_B, v_x). Require a conventional index or one the term actually uses.
    const [, name, index, rhs] = m;
    if (SEQ_INDICES.has(index) || (!RESERVED.has(index) && usesIndex(rhs, index))) {
      return { rec: false, name, index, rhs };
    }
  }
  return null;
}

export function classifySeqRec(
  scan: SeqScan,
  fnNames: ReadonlySet<string>,
  getFn: GetFn,
  constNames: ReadonlySet<string>,
  ropts: ResolveOpts = {},
): Classified {
  const { name, index, rhs } = scan;
  if (RESERVED.has(index)) {
    throw new Error(`"${index}" is reserved; index sequences with n, k, or m.`);
  }
  // Σ/Π with constant bounds expand here, as anywhere else. A bound that uses
  // the index (a_n = Σ(s=1..n, s)) stays a sum; evaluate() runs it at each n.
  const openVars = new Set(ropts.openVars);
  openVars.add(index);
  const parsed = resolveExpr(parseExpr(rhs, fnNames), getFn, { ...ropts, openVars });
  if (usesComplex(parsed)) throw new Error('Sequences are real-valued; use re(…) or im(…).');

  const recVar = `${name}_${index}`;
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
  if (vars.has(index)) {
    throw new Error(`A recurrence may only use ${recVar} (and x as a parameter axis), not ${index} itself.`);
  }
  for (const v of vars) {
    throw new Error(`Unknown variable: ${v}. Define "${v} = 1" to make a slider.`);
  }
  if (a0Name) params.push(a0Name);
  params.sort();

  return {
    object: { kind: 'sequence', form: bifurcation ? 'bifurcation' : 'cobweb', expr: parsed, variable: recVar, seedName: a0Name },
    animated, needs3D: false, params,
  };
}

/** Sequence values share the same scalar/list pipeline as CSV columns.
 * Recurrences form a linear chain of computed constants rather than an
 * exponentially duplicated expression. Those constants become uniforms. */
export function sequenceResolver(defs: ValueDefinitions, getFn: GetFn, opts: ResolveOpts,
  known: Set<string>, protectedNames: ReadonlySet<string> = new Set(),
  defineConstant: (name: string, expr: Expr) => void = (name, expr) => {
    if (!(defs instanceof Env)) throw new Error('Sequence construction needs a binding writer.');
    defs.bind(name, { tag: 'scalar', role: 'const', expr });
  }) {
  const resolving = new Set<string>();
  const term = (name: string, k: number): Expr => {
    if (!Number.isInteger(k) || k < 0 || k > 1000) throw new Error('Sequence indices must be whole numbers from 0 to 1000.');
    const scan = defs.sequences.get(name)!;
    const key = `${name}_${k}`;
    if (protectedNames.has(key) || defs.consts.has(key)) return { kind: 'var', name: key };
    if (resolving.has(name)) throw new Error(`Sequence ${name} depends on itself outside its recurrence.`);
    resolving.add(name);
    try {
      const parsed = parseExpr(scan.rhs, new Set(defs.fns.keys()), new Set([...defs.sequences.keys()].map(n => n + '_')));
      if (!scan.rec) {
        // Pin the index in the source (a Σ/∫ that rebinds it keeps its own),
        // then resolve ONCE — so a_5 of a_n = Σ(s=1..n, s) is the number 15,
        // not a sum node, and the term sees exactly what the plot row sees: a
        // second pass over an already-resolved body would re-apply the
        // tuple-call splat to vectors that functions computed.
        return resolveExpr(substIdx(parsed, scan.index, { kind: 'num', value: k }), getFn, opts);
      }
      const body = resolveExpr(parsed, getFn, opts);
      for (const v of freeVars(body)) {
        if (v !== `${name}_${scan.index}` && v !== 't' && !known.has(v) && !defs.consts.has(v)) throw new Error(`Sequence ${name} terms need constant parameters (found ${v}).`);
      }
      for (let i = 0; i <= k; i++) {
        const internal = `${defs.sequencePrefix}_${name}_${i}`;
        if (defs.consts.has(internal)) continue;
        const value: Expr = i === 0
          ? (protectedNames.has(`${name}_0`) || defs.consts.has(`${name}_0`) ? { kind: 'var', name: `${name}_0` } : { kind: 'num', value: .5 })
          : substVars(body, { [`${name}_${scan.index}`]: { kind: 'var', name: `${defs.sequencePrefix}_${name}_${i - 1}` } });
        defineConstant(internal, value); known.add(internal);
        try { if (opts.consts) opts.consts[internal] = evaluate(value, opts.consts); } catch { /* resolved at frame time */ }
      }
      return { kind: 'var', name: `${defs.sequencePrefix}_${name}_${k}` };
    } finally { resolving.delete(name); }
  };
  const resolve = (symbol: string, index?: Expr): Expr | null => {
    if (index === undefined) {
      const hit = TERM_RE.exec(symbol);
      if (hit) return defs.sequences.has(hit[1]) ? term(hit[1], Number(hit[2])) : null;
      // a_k or a_N: the term at a slider, or one per element of a list —
      // unless a_k is a name of its own, or k is the sequence's own index.
      const named = NAMED_RE.exec(symbol);
      const scan = named && defs.sequences.get(named[1]);
      if (!named || !scan || named[2] === scan.index || protectedNames.has(symbol) || known.has(symbol)) return null;
      const k = named[2];
      if (!opts.isList?.(k) && opts.consts?.[k] === undefined) return null;
      return resolve(`${named[1]}_`, { kind: 'var', name: k });
    }
    const name = symbol.slice(0, -1);
    if (!symbol.endsWith('_') || !defs.sequences.has(name)) return null;
    const input: Expr = index.kind === 'range' ? { kind: 'list', items: [index] } : index;
    const indices = lowerLists(input, listGetter(defs), opts);
    const one = (e: Expr) => {
      for (const n of freeVars(e)) opts.boundConsts?.add(n);
      return term(name, evaluate(e, opts.consts ?? {}));
    };
    // One term per index, so a_[n] runs over the same instances n does.
    if (indices.kind === 'list') return withAxes({ kind: 'list', items: indices.items.map(one) }, axesOf(indices));
    if (indices.kind === 'data') return withAxes({ kind: 'list', items: Array.from(indices.values, k => term(name, k)) }, axesOf(indices));
    return one(indices);
  };
  return resolve;
}
