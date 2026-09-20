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
import { compileTyped, usesComplex } from './complex.ts';
import { type GetFn, RESERVED, type ResolveOpts, resolveExpr } from './defs.ts';
import { lowerLists } from './list.ts';
import { listGetter } from './defs.ts';
import { GREEK_NAME_CHARS, WRITTEN_NAME_CHARS, type Expr, evaluate, freeVars, parseExpr, substVars } from './expr.ts';
import { uniformName } from './glsl.ts';
import type { Classified } from './plot.ts';

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
  // Σ/Π in the term expand here like anywhere else, so a_n = sum(k=1..N, k^n)
  // works — the bounds must still be constants, since expansion is static.
  const parsed = resolveExpr(parseExpr(rhs, fnNames), getFn, ropts);
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
    return { plot: { type: 'sequence', term: parsed, index }, animated, needs3D: false, params };
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

  // GLSL sees constants as u_<name> uniforms, like classify() does.
  const g = params.length
    ? substVars(parsed, Object.fromEntries(params.map(p => [p, { kind: 'var', name: uniformName(p) } as Expr])))
    : parsed;

  if (bifurcation) {
    const field = compileTyped(substVars(g, { [recVar]: { kind: 'var', name: 'a' } })).code;
    return { plot: { type: 'bifurcation', field, a0Name }, animated, needs3D: false, params };
  }

  const curve: Expr = {
    kind: 'eq',
    l: { kind: 'var', name: 'y' },
    r: substVars(g, { [recVar]: { kind: 'var', name: 'x' } }),
  };
  return {
    plot: { type: 'cobweb', f: parsed, recVar, curveField: compileTyped(curve).code, a0Name },
    animated,
    needs3D: false,
    params,
  };
}

/** Sequence values share the same scalar/list pipeline as CSV columns.
 * Recurrences form a linear chain of computed constants rather than an
 * exponentially duplicated expression. Those constants become uniforms. */
export function sequenceResolver(defs: import('./defs.ts').Defs, getFn: GetFn, opts: ResolveOpts,
  known: Set<string>, protectedNames: ReadonlySet<string> = new Set()) {
  const resolving = new Set<string>();
  const term = (name: string, k: number): Expr => {
    if (!Number.isInteger(k) || k < 0 || k > 1000) throw new Error('Sequence indices must be whole numbers from 0 to 1000.');
    const scan = defs.sequences.get(name)!;
    const key = `${name}_${k}`;
    if (protectedNames.has(key) || defs.consts.has(key)) return { kind: 'var', name: key };
    if (resolving.has(name)) throw new Error(`Sequence ${name} depends on itself outside its recurrence.`);
    resolving.add(name);
    try {
      const body = resolveExpr(parseExpr(scan.rhs, new Set(defs.fns.keys()), new Set([...defs.sequences.keys()].map(n => n + '_'))), getFn, opts);
      if (!scan.rec) return substVars(body, { [scan.index]: { kind: 'num', value: k } });
      for (const v of freeVars(body)) {
        if (v !== `${name}_${scan.index}` && v !== 't' && !known.has(v) && !defs.consts.has(v)) throw new Error(`Sequence ${name} terms need constant parameters (found ${v}).`);
      }
      for (let i = 0; i <= k; i++) {
        const internal = `${defs.sequencePrefix}_${name}_${i}`;
        if (defs.consts.has(internal)) continue;
        const value: Expr = i === 0
          ? (protectedNames.has(`${name}_0`) || defs.consts.has(`${name}_0`) ? { kind: 'var', name: `${name}_0` } : { kind: 'num', value: .5 })
          : substVars(body, { [`${name}_${scan.index}`]: { kind: 'var', name: `${defs.sequencePrefix}_${name}_${i - 1}` } });
        defs.consts.set(internal, value); known.add(internal);
        try { if (opts.consts) opts.consts[internal] = evaluate(value, opts.consts); } catch { /* resolved at frame time */ }
      }
      return { kind: 'var', name: `${defs.sequencePrefix}_${name}_${k}` };
    } finally { resolving.delete(name); }
  };
  return (symbol: string, index?: Expr): Expr | null => {
    if (index === undefined) {
      const hit = TERM_RE.exec(symbol);
      return hit && defs.sequences.has(hit[1]) ? term(hit[1], Number(hit[2])) : null;
    }
    const name = symbol.slice(0, -1);
    if (!symbol.endsWith('_') || !defs.sequences.has(name)) return null;
    const input: Expr = index.kind === 'call' && index.name === '[range]' ? { kind: 'list', items: [index] } : index;
    const indices = lowerLists(input, listGetter(defs), opts);
    const one = (e: Expr) => {
      for (const n of freeVars(e)) opts.boundConsts?.add(n);
      return term(name, evaluate(e, opts.consts ?? {}));
    };
    if (indices.kind === 'list') return { kind: 'list', items: indices.items.map(one) };
    if (indices.kind === 'data') return { kind: 'list', items: Array.from(indices.values, k => term(name, k)) };
    return one(indices);
  };
}
