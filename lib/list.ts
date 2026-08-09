/**
 * List lowering — lists as values, by symbolic expansion.
 *
 * Like Σ/Π/∫, d/dx, points, and matrices, lists vanish before anything
 * downstream looks: broadcasting rewrites operations over lists into a
 * top-level `{kind: 'list'}` literal (the shape classify already plots as
 * dots/bars or a scatter), reductions collapse to scalar expressions, and
 * indexing picks its element at lowering time. GLSL, evaluate, diff, and the
 * integrator never see a list.
 *
 * Semantics (see docs/lists-tables-plan.md):
 * - scalar ⊕ list maps elementwise; list ⊕ list zips, and mismatched
 *   lengths are an error — never a silent truncation.
 * - `(A, B)` with list components zips into a list of points.
 * - ranges [1..20] / [0, 0.5..10] / [10..1] expand here, where constant
 *   values are known (bounds behave like Σ bounds: constants and sliders).
 * - indexing is 1-based: L[1] is the first element.
 * - mean/total/count and min/max over a list lower symbolically, so their
 *   elements may animate with t; stdev/median/sort need a constant list.
 */
import { add, div, mul } from './diff.ts';
import type { ResolveOpts } from './defs.ts';
import { type Expr, evaluate, freeVars } from './expr.ts';

export type GetList = (name: string) => readonly Expr[] | null;

/** Elements one [a..b] range may expand to. */
const RANGE_MAX = 10_000;
/** Total list elements one lowering may materialize across all operations. */
const ITEMS_MAX = 100_000;

/** Reductions that lower symbolically — their elements may depend on t. */
const SYMBOLIC_REDUCTIONS = new Set(['mean', 'total', 'count']);
/** Reductions that need numeric elements (ordering), so a constant list. */
const NUMERIC_REDUCTIONS = new Set(['stdev', 'median', 'sort']);

/** Whole-plot forms a list can never appear inside. */
const NO_LIST_INSIDE = new Set([
  'domain', 'conformal', 'iter', 'tube', '[polygon]', '[segment]', '[square]',
]);

interface Ctx {
  getList: GetList;
  opts: ResolveOpts;
  /** List elements materialized so far (ranges, zips, maps all count). */
  items: number;
}

const num = (value: number): Expr => ({ kind: 'num', value });

const isList = (e: Expr): e is Expr & { kind: 'list' } => e.kind === 'list';
const isRange = (e: Expr): e is Expr & { kind: 'call' } =>
  e.kind === 'call' && e.name === '[range]';

function listOf(items: Expr[], ctx: Ctx): Expr {
  ctx.items += items.length;
  if (ctx.items > ITEMS_MAX) {
    throw new Error(`This expression expands to too many list elements (limit ${ITEMS_MAX}).`);
  }
  return { kind: 'list', items };
}

/** Evaluate a subexpression that must be a known number (range bounds,
 *  indices) from constants and sliders, like Σ/Π bounds. */
function constVal(e: Expr, ctx: Ctx, what: string): number {
  const env: Record<string, number> = {};
  for (const fv of freeVars(e)) {
    const v = ctx.opts.consts?.[fv];
    if (v === undefined) {
      if (fv === 't') throw new Error(`${what} cannot depend on t.`);
      throw new Error(`${what} must be constant — add "${fv} = 5" in a row above.`);
    }
    ctx.opts.boundConsts?.add(fv);
    env[fv] = v;
  }
  const v = evaluate(e, env);
  if (!isFinite(v)) throw new Error(`${what} is not finite.`);
  return v;
}

/** Expand the items of a list literal: ranges become runs of numbers, with
 *  the step set by the element just before the range ([0, 0.5..10]). */
function expandItems(raw: readonly Expr[], ctx: Ctx): Expr[] {
  const out: Expr[] = [];
  for (const item of raw) {
    if (!isRange(item)) {
      const low = lower(item, ctx);
      if (isList(low)) throw new Error('Lists cannot be nested.');
      out.push(low);
      continue;
    }
    const lo = constVal(item.args[0], ctx, 'A ".." range bound');
    const hi = constVal(item.args[1], ctx, 'A ".." range bound');
    let step = hi >= lo ? 1 : -1;
    if (out.length) {
      const prev = out[out.length - 1];
      if (prev.kind !== 'num') {
        throw new Error('The element before a ".." range must be a plain number (it sets the step).');
      }
      step = lo - prev.value;
      if (step === 0) throw new Error('The ".." range step is zero.');
      if ((hi - lo) / step < -1e-9) {
        throw new Error('The ".." range step points away from its end value.');
      }
    }
    const count = Math.floor((hi - lo) / step + 1e-9) + 1;
    if (count > RANGE_MAX) {
      throw new Error(`[${lo}..${hi}] expands to ${count} elements (limit ${RANGE_MAX}).`);
    }
    for (let k = 0; k < count; k++) out.push(num(lo + k * step));
  }
  return out;
}

/** Combine lowered operands elementwise: lists zip (equal lengths only),
 *  scalars broadcast. */
function zipN(parts: Expr[], build: (comps: Expr[]) => Expr, ctx: Ctx): Expr {
  let n: number | null = null;
  for (const p of parts) {
    if (!isList(p)) continue;
    if (n !== null && p.items.length !== n) {
      throw new Error(`Lists have different lengths (${n} vs ${p.items.length}).`);
    }
    n = p.items.length;
  }
  if (n === null) return build(parts);
  const items: Expr[] = [];
  for (let k = 0; k < n; k++) {
    const comps = parts.map(p => (isList(p) ? p.items[k] : p));
    // An element that is itself a point cannot feed scalar operations or
    // nest inside another point — fail loud rather than mis-plot later.
    if (comps.some((c, i) => c.kind === 'vec' && isList(parts[i]))) {
      throw new Error('Arithmetic over a list of points is not supported yet — operate on coordinate lists instead.');
    }
    items.push(build(comps));
  }
  return listOf(items, ctx);
}

/** Numeric values of a constant list, for order-dependent reductions. */
function numericItems(items: readonly Expr[], ctx: Ctx, name: string): number[] {
  return items.map(it => constVal(it, ctx, `${name}(…) needs a constant list, so each element`));
}

function reduce(name: string, items: readonly Expr[], ctx: Ctx): Expr {
  if (items.some(it => it.kind === 'vec')) {
    throw new Error(`${name}(…) over a list of points is not supported yet.`);
  }
  const n = items.length;
  switch (name) {
    case 'count': return num(n);
    case 'total':
    case 'mean': {
      let acc: Expr = items[0] ?? num(0);
      for (let k = 1; k < n; k++) acc = add(acc, items[k]);
      return name === 'total' ? acc : div(acc, num(n));
    }
    case 'min':
    case 'max': {
      let acc: Expr = items[0];
      for (let k = 1; k < n; k++) acc = { kind: 'call', name, args: [acc, items[k]] };
      return acc;
    }
    case 'stdev': {
      if (n < 2) throw new Error('stdev needs at least 2 elements.');
      const xs = numericItems(items, ctx, name);
      const mean = xs.reduce((a, b) => a + b, 0) / n;
      return num(Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)));
    }
    case 'median': {
      const xs = numericItems(items, ctx, name).sort((a, b) => a - b);
      return num(n % 2 ? xs[(n - 1) / 2] : (xs[n / 2 - 1] + xs[n / 2]) / 2);
    }
    case 'sort':
      return listOf(numericItems(items, ctx, name).sort((a, b) => a - b).map(num), ctx);
  }
  throw new Error(`Unknown reduction: ${name}.`);
}

function lowerIndex(e: Expr & { kind: 'call' }, ctx: Ctx): Expr {
  const [target, idx] = e.args;
  const low = lower(target, ctx);
  if (!isList(low)) {
    const name = target.kind === 'var' ? target.name : 'this';
    throw new Error(`${name} is not a list here — define it above where it is used.`);
  }
  const idxLow = lower(idx, ctx);
  if (isList(idxLow)) {
    throw new Error('Slicing L[a..b] is not supported yet — index one element, like L[1].');
  }
  const v = constVal(idxLow, ctx, 'A list index');
  const k = Math.round(v);
  if (Math.abs(v - k) > 1e-9) throw new Error('List indices must be whole numbers.');
  if (k === 0) throw new Error('Lists are 1-based: the first element is L[1].');
  if (k < 1 || k > low.items.length) {
    throw new Error(`Index ${k} is out of range — the list has ${low.items.length} element${low.items.length === 1 ? '' : 's'}.`);
  }
  return low.items[k - 1];
}

function lower(e: Expr, ctx: Ctx): Expr {
  switch (e.kind) {
    case 'num':
    case 'var': {
      if (e.kind === 'var') {
        const items = ctx.getList(e.name);
        if (items) return listOf([...items], ctx);
      }
      return e;
    }
    case 'neg':
      return zipN([lower(e.a, ctx)], ([a]) => ({ kind: 'neg', a }), ctx);
    case 'bin':
      return zipN(
        [lower(e.a, ctx), lower(e.b, ctx)],
        ([a, b]) => ({ kind: 'bin', op: e.op, a, b }),
        ctx,
      );
    case 'call': {
      if (e.name === '[index]') return lowerIndex(e, ctx);
      const args = e.args.map(a => lower(a, ctx));
      const listArgs = args.filter(isList);
      const isMinMax = e.name === 'min' || e.name === 'max';
      if (SYMBOLIC_REDUCTIONS.has(e.name) || NUMERIC_REDUCTIONS.has(e.name)
        || (isMinMax && args.length === 1 && isList(args[0]))) {
        if (args.length !== 1 || !isList(args[0])) {
          if (args.length === 1 && args[0].kind === 'var') {
            throw new Error(`${e.name}(${args[0].name}) needs ${args[0].name} to be a list defined above this row.`);
          }
          throw new Error(`${e.name}(…) needs a list, like ${e.name}([1, 4, 2]).`);
        }
        return reduce(e.name, args[0].items, ctx);
      }
      if (!listArgs.length) return { kind: 'call', name: e.name, args };
      if (NO_LIST_INSIDE.has(e.name)) {
        const label = e.name.startsWith('[') ? e.name.slice(1, -1) : e.name;
        throw new Error(`Lists cannot appear inside ${label}(…).`);
      }
      // Scalar builtins map elementwise: sin(L), atan2(L, M), min(L, 5).
      return zipN(args, comps => ({ kind: 'call', name: e.name, args: comps }), ctx);
    }
    case 'vec':
      return zipN(
        e.items.map(it => lower(it, ctx)),
        comps => ({ kind: 'vec', items: comps }),
        ctx,
      );
    case 'list':
      return listOf(expandItems(e.items, ctx), ctx);
    case 'eq':
    case 'ineq': {
      const l = lower(e.l, ctx);
      const r = lower(e.r, ctx);
      if (isList(l) || isList(r)) {
        throw new Error('Cannot put a list in an equation — plot the list on its own row.');
      }
      return e.kind === 'eq'
        ? { kind: 'eq', l, r }
        : { kind: 'ineq', op: e.op, l, r };
    }
    case 'piecewise': {
      const cases = e.cases.map(c => ({ cond: lower(c.cond, ctx), value: lower(c.value, ctx) }));
      const otherwise = e.otherwise && lower(e.otherwise, ctx);
      if (cases.some(c => isList(c.value)) || (otherwise && isList(otherwise))) {
        throw new Error('Lists are not supported inside {…} piecewise yet.');
      }
      return { kind: 'piecewise', cases, otherwise };
    }
  }
}

/**
 * Eliminate lists from a resolved, geometry-lowered expression. The result
 * is either an ordinary scalar expression or a top-level list literal of
 * scalars/points, ready for classify. `opts` supplies constant values for
 * range bounds and indices (and collects boundConsts so their sliders snap
 * to integers), exactly as Σ/Π expansion does.
 */
export function lowerLists(e: Expr, getList: GetList, opts: ResolveOpts = {}): Expr {
  return lower(e, { getList, opts, items: 0 });
}

/** Whether a parsed (unresolved) row calls a list reduction — such rows get
 *  a numeric readout when they resolve to a constant, like ∫ rows. */
export function usesListReduction(e: Expr): boolean {
  const REDUCTIONS = new Set([...SYMBOLIC_REDUCTIONS, ...NUMERIC_REDUCTIONS]);
  switch (e.kind) {
    case 'num':
    case 'var': return false;
    case 'neg': return usesListReduction(e.a);
    case 'bin': return usesListReduction(e.a) || usesListReduction(e.b);
    case 'call': return REDUCTIONS.has(e.name) || e.args.some(usesListReduction);
    case 'eq': return usesListReduction(e.l) || usesListReduction(e.r);
    case 'ineq': return usesListReduction(e.l) || usesListReduction(e.r);
    case 'vec':
    case 'list': return e.items.some(usesListReduction);
    case 'piecewise':
      return e.cases.some(c => usesListReduction(c.cond) || usesListReduction(c.value))
        || (e.otherwise ? usesListReduction(e.otherwise) : false);
  }
}
