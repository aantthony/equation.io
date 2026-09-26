/**
 * Continuous intervals (docs/multisets.md §5): `interval(a, b)` is every real
 * number from a to b, an infinite multiset like u but over [a, b].
 *
 * Resolution (lib/defs.ts) turns each one into a hidden parameter: a call to
 * INTERVAL carrying its bounds and an identity. Every mention of a name
 * (`r = interval(1, 2)`) is the same node, so it is chosen once per row;
 * each literal gets its own identity, so two literals are separate — the
 * rule of §1. The node denotes the chosen number itself, so its bounds, and
 * with them the interval's length (its measure), stay readable from the
 * tree: nothing else has to remember them.
 *
 * Nothing evaluates the node. Before a row draws, classify (lib/plot.ts) or
 * the density path (lib/analysis.ts) replaces it: by a sampling parameter
 * swept over [0, 1] (`lo + (hi - lo) u`), or by a uniform random variable.
 */
import { type Expr, INTERVAL, childrenOf, exprKey, freeVars, mapChildren } from './expr.ts';

export interface HiddenInterval {
  /** The node itself, as it appears in the row. */
  node: Expr & { kind: 'call' };
  lo: Expr;
  hi: Expr;
  /** Equal for identical intervals (every mention of one name). */
  key: string;
}

const isHidden = (e: Expr): e is Expr & { kind: 'call' } => e.kind === 'call' && e.name === INTERVAL;

let identities = 0;
/** One identity per source literal: resolving the same parsed row again (or
 *  a function body inlined twice) keeps it, as list origins do. */
const literals = new WeakMap<Expr, number>();

/**
 * The hidden parameter for `interval(lo, hi)` written at `source`, with
 * resolved bounds. The bounds may use constants, sliders and t; numbers are
 * checked here, the rest when the row draws.
 */
export function hiddenInterval(source: Expr, args: readonly Expr[]): Expr {
  if (args.length !== 2) throw new Error('interval takes two bounds: interval(1, 2).');
  const [lo, hi] = args;
  for (const b of args) {
    if (b.kind === 'vec' || b.kind === 'eq' || b.kind === 'ineq' || b.kind === 'str' || b.kind === 'text')
      throw new Error('The bounds of an interval are two numbers: interval(1, 2).');
    if (hasInterval(b)) throw new Error('The bounds of an interval cannot be intervals themselves.');
    const moving = [...freeVars(b)].find(v => ['x', 'y', 'z', 'u', 'v', 'w'].includes(v));
    if (moving) throw new Error(`The bounds of an interval can only use constants, sliders and t (found ${moving}).`);
  }
  if (lo.kind === 'num' && hi.kind === 'num') {
    if (!Number.isFinite(lo.value) || !Number.isFinite(hi.value))
      throw new Error('The bounds of an interval must be finite.');
    if (!(lo.value < hi.value)) throw new Error(`interval(a, b) needs a < b (got ${lo.value} and ${hi.value}).`);
  }
  let id = literals.get(source);
  if (id === undefined) literals.set(source, (id = ++identities));
  return { kind: 'call', name: INTERVAL, args: [lo, hi, { kind: 'num', value: id }] };
}

export function hasInterval(e: Expr): boolean {
  return isHidden(e) || childrenOf(e).some(hasInterval);
}

/** The distinct hidden intervals of `e`, in order of first appearance. */
export function intervalsIn(e: Expr): HiddenInterval[] {
  const found = new Map<string, HiddenInterval>();
  const walk = (n: Expr): void => {
    if (isHidden(n)) {
      const key = exprKey(n);
      if (!found.has(key)) found.set(key, { node: n, lo: n.args[0], hi: n.args[1], key });
      return;
    }
    childrenOf(n).forEach(walk);
  };
  walk(e);
  return [...found.values()];
}

/** `e` with each hidden interval replaced by what `by` gives for it. */
export function replaceIntervals(e: Expr, by: (h: HiddenInterval) => Expr): Expr {
  const hidden = new Map(intervalsIn(e).map(h => [h.key, by(h)]));
  if (!hidden.size) return e;
  const walk = (n: Expr): Expr => (isHidden(n) ? hidden.get(exprKey(n))! : mapChildren(n, walk));
  return walk(e);
}

/** The interval's length, hi − lo: its measure (docs/multisets.md §5). */
export function lengthOf(h: HiddenInterval): Expr {
  if (h.lo.kind === 'num' && h.hi.kind === 'num') return { kind: 'num', value: h.hi.value - h.lo.value };
  return { kind: 'bin', op: '-', a: h.hi, b: h.lo };
}

/** `lo + (hi - lo) p`: the interval swept by a parameter p over [0, 1] —
 *  folded for number bounds, so interval(0, 1) is p itself. */
export function sweep(h: HiddenInterval, p: string): Expr {
  const length = lengthOf(h);
  const param: Expr = { kind: 'var', name: p };
  const scaled: Expr =
    length.kind === 'num' && length.value === 1 ? param : { kind: 'bin', op: '*', a: length, b: param };
  return h.lo.kind === 'num' && h.lo.value === 0 ? scaled : { kind: 'bin', op: '+', a: h.lo, b: scaled };
}
