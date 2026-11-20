/**
 * Resolve-time expansion of Σ and Π. A bound that is a number or a known
 * constant becomes an ordinary sum of terms. A bound that is still open —
 * a sequence index, a function parameter — stays a call.
 */
import { add, mul } from './diff.ts';
import { SUM_MAX_TERMS, childrenOf, evaluate, type Expr, freeVars, mapChildren, markOrigins } from './expr.ts';
import { fourierSeries } from './glsl.ts';
import { type Seq, isSeq, namedAxes, withAxes } from './list.ts';
import { type Ctx, type SumCall, RESERVED, SUM_MAX_TOTAL, foldNums, substIdx } from './defs.ts';

const num = (value: number): Expr => ({ kind: 'num', value });

/** Expand a Σ/Π into an explicit sum/product of per-index terms. */
export function expandSum(header: SumCall, body: Expr, ctx: Ctx): Expr {
  const sym = header.name === 'sum' ? 'Σ' : 'Π';
  // A literal in the body is written once: every term's copy is that one
  // list, so the terms pair up element by element rather than crossing.
  markOrigins(body);
  const [idxE, loE, hiE] = header.args;
  if (idxE.kind !== 'var') throw new Error(`Expected ${header.name}(n=1..N, …).`);
  const idx = idxE.name;
  if (RESERVED.has(idx)) throw new Error(`Cannot use "${idx}" as a ${sym} index (it is reserved).`);
  const listed = boundList(loE, hiE, sym, ctx);
  if (listed) {
    const { name, seq, values } = listed;
    // Each element's sum would itself be a list: a family of families.
    const inner =
      [...freeVars(body)].find(n => n !== name && ctx.opts.isList?.(n)) ??
      (containsListLiteral(body) ? 'a list literal' : null);
    if (inner) throw new Error(`${sym} over the list ${name} cannot also use ${inner} in its body.`);
    const before = ctx.terms;
    const items = values.map(v => {
      const at = (e: Expr) => substIdx(e, name, num(v));
      try {
        return expandSum({ ...header, args: [idxE, at(loE), at(hiE)] }, at(body), ctx);
      } catch (err) {
        if (ctx.terms <= SUM_MAX_TOTAL) throw err;
        throw new Error(
          `${sym} over the list ${name} expands to over ${ctx.terms - before} terms across its values (limit ${SUM_MAX_TOTAL} total).`,
        );
      }
    });
    return withAxes<Expr>({ kind: 'list', items }, namedAxes(name, seq));
  }
  // A bound that uses an open name (the sequence index, or a function's
  // parameter) cannot be expanded here: the sum stays a call and evaluate() runs it once that name is a number.
  const bound = (b: Expr): { expr: Expr; value?: number } => {
    const r = ctx.rx(b, ctx);
    const env: Record<string, number> = {};
    let open = false;
    for (const fv of freeVars(r)) {
      // A function's parameter is its argument, never the document's name of
      // the same spelling: the bound stays open until the call substitutes it.
      if (ctx.opts.params?.has(fv) || ctx.opts.openVars?.has(fv)) {
        open = true;
        continue;
      }
      const v = ctx.opts.consts?.[fv];
      if (v !== undefined) {
        ctx.opts.boundConsts?.add(fv);
        env[fv] = v;
        continue;
      }
      if (fv === 't' || RESERVED.has(fv)) throw new Error(`${sym} bounds cannot depend on ${fv}.`);
      throw new Error(`${sym} bounds must be constant — add "${fv} = 5" in a row above.`);
    }
    if (open) return { expr: r };
    const v = evaluate(r, env);
    if (!isFinite(v)) throw new Error(`${sym} bound is not finite.`);
    return { expr: r, value: v };
  };
  const lo = bound(loE);
  const gated = lo.value !== undefined && sliderGated(header, body, lo.value, ctx);
  if (gated) return gated;
  const hi = bound(hiE);
  if (lo.value === undefined || hi.value === undefined) {
    const saved = ctx.opts;
    const openVars = new Set(saved.openVars);
    openVars.add(idx);
    ctx.opts = { ...saved, openVars };
    try {
      return {
        kind: 'call',
        name: header.name,
        args: [{ kind: 'var', name: idx }, lo.expr, hi.expr, ctx.rx(body, ctx)],
      };
    } finally {
      ctx.opts = saved;
    }
  }
  const start = Math.ceil(lo.value - 1e-9);
  const end = Math.floor(hi.value + 1e-9);
  const count = end - start + 1;
  if (count > SUM_MAX_TERMS) throw new Error(`${sym} expands to ${count} terms (limit ${SUM_MAX_TERMS}).`);
  ctx.terms += Math.max(count, 0);
  if (ctx.terms > SUM_MAX_TOTAL) {
    throw new Error(`Nested ${sym} expand to too many terms (limit ${SUM_MAX_TOTAL} total).`);
  }
  const combine = header.name === 'sum' ? add : mul;
  let acc: Expr | null = null;
  for (let k = start; k <= end; k++) {
    const term = foldNums(ctx.rx(substIdx(body, idx, num(k)), ctx));
    acc = acc === null ? term : combine(acc, term);
  }
  return acc ?? num(header.name === 'sum' ? 0 : 1);
}

/**
 * Expand the Σ/Π a function's body left open on its parameters, now that a
 * call has substituted its arguments: `f(N) = sum(k=1..N, k)` keeps the sum a
 * call (expandSum), and `f(100)` expands it to 100. A bound still open here —
 * on an enclosing function's parameter or a sequence index — waits as before.
 */
export function expandClosedSums(e: Expr, ctx: Ctx): Expr {
  if (e.kind === 'call' && (e.name === 'sum' || e.name === 'prod') && e.args.length === 4) {
    const open = (b: Expr) => [...freeVars(b)].some(v => ctx.opts.params?.has(v) || ctx.opts.openVars?.has(v));
    if (open(e.args[1]) || open(e.args[2])) return e;
    return expandSum(e as SumCall, e.args[3], ctx);
  }
  return mapChildren(e, x => expandClosedSums(x, ctx));
}

/**
 * A Σ up to a clamped whole-number slider, `N = round(clamp(19, 1, 50))`,
 * whose terms form a sine/cosine series expands to the slider's maximum, each
 * term gated on `N >= k`. N is then read at runtime rather than baked into
 * the expansion (it never reaches the consts proxy, so it stays off
 * structuralConsts): a drag keeps the shader and only moves a uniform, and
 * glsl.ts's fourierLoop runs the series only up to N, as for reconstruct.
 * Null for anything else — another bound or body, a range fourierLoop cannot
 * loop over — which then expands at the current value as usual: gating a
 * general body would evaluate every term up to the maximum at every N.
 */
function sliderGated(header: SumCall, body: Expr, lo: number, ctx: Ctx): Expr | null {
  const [idxE, , hiE] = header.args;
  if (header.name !== 'sum' || idxE.kind !== 'var' || hiE.kind !== 'var') return null;
  const name = hiE.name;
  // A parameter or open index named like a slider is its own value.
  if (ctx.opts.params?.has(name) || ctx.opts.openVars?.has(name)) return null;
  const consts = ctx.opts.consts;
  // `in`, not a read: the analysis proxy records reads as structural.
  if (!consts || !(name in consts)) return null;
  const range = wholeClampRange(ctx.opts.definition?.(name));
  if (!range) return null;
  const start = Math.ceil(lo - 1e-9);
  const count = range.hi - start + 1;
  if (start < 1 || count > SUM_MAX_TERMS || ctx.terms + count > SUM_MAX_TOTAL) return null;
  let acc: Expr | null = null;
  for (let k = start; k <= range.hi; k++) {
    // Even the terms the slider's minimum always keeps are gated: a uniform
    // run of gates is the shape fourierLoop reads.
    const value: Expr = {
      kind: 'piecewise',
      cases: [
        {
          cond: { kind: 'ineq', op: '>=', l: hiE, r: num(k) },
          value: foldNums(ctx.rx(substIdx(body, idxE.name, num(k)), ctx)),
        },
      ],
      otherwise: num(0),
    };
    acc = acc === null ? value : add(acc, value);
  }
  if (!acc || !fourierSeries(acc)) return null;
  ctx.terms += count;
  ctx.opts.boundConsts?.add(name);
  return acc;
}

/** The whole-number [lo, hi] of a rounded clamp slider — round(clamp(v, lo,
 *  hi)) or clamp(round(v), lo, hi), i.e. min(max(…)) with a round, floor or
 *  ceil outside or around v and integer ends — or null. Its value is then
 *  always a whole number in [lo, hi], so `N >= k` gates exactly. */
function wholeClampRange(definition: Expr | undefined): { lo: number; hi: number } | null {
  const isRounding = (e: Expr | undefined): e is Expr & { kind: 'call' } =>
    e?.kind === 'call' && ['round', 'floor', 'ceil'].includes(e.name) && e.args.length === 1;
  let e = definition;
  let rounded = false;
  while (isRounding(e)) {
    rounded = true;
    e = e.args[0];
  }
  if (e?.kind !== 'call' || e.name !== 'min' || e.args.length !== 2) return null;
  const inside = e.args[0];
  if (inside.kind !== 'call' || inside.name !== 'max' || inside.args.length !== 2) return null;
  const [lo, hi] = [inside.args[1], e.args[1]];
  if (!rounded && !isRounding(inside.args[0])) return null;
  if (lo.kind !== 'num' || hi.kind !== 'num' || !Number.isInteger(lo.value) || !Number.isInteger(hi.value)) return null;
  return hi.value > lo.value ? { lo: lo.value, hi: hi.value } : null;
}

const containsListLiteral = (e: Expr): boolean => e.kind === 'list' || childrenOf(e).some(containsListLiteral);

/**
 * The list a Σ/Π bound names, with its numeric values — or null when the
 * bounds name none. One list at a time: two would have to cross or zip, and
 * neither reading is obvious from `sum(n=A..B, …)`.
 */
function boundList(loE: Expr, hiE: Expr, sym: string, ctx: Ctx): { name: string; seq: Seq; values: number[] } | null {
  const get = ctx.opts.getList;
  if (!get) return null;
  const names = [...new Set([...freeVars(loE), ...freeVars(hiE)])].filter(
    // isList first: reading a slider's value would mark it structural.
    n => ctx.opts.isList?.(n) && !ctx.opts.openVars?.has(n) && ctx.opts.consts?.[n] === undefined,
  );
  if (!names.length) return null;
  if (names.length > 1) throw new Error(`${sym} bounds can use one list at a time (found ${names.join(' and ')}).`);
  const [name] = names;
  let seq: Expr | null = null;
  try {
    seq = get(name);
  } catch {
    /* reported below */
  }
  const values = !seq
    ? null
    : seq.kind === 'data'
      ? [...seq.values]
      : seq.kind === 'list' && seq.items.every(it => it.kind === 'num')
        ? seq.items.map(it => (it as Expr & { kind: 'num' }).value)
        : null;
  if (!seq || !isSeq(seq) || !values)
    throw new Error(`${sym} bounds need a list of plain numbers — ${name} is not one.`);
  if (values.length > SUM_MAX_TERMS)
    throw new Error(`${name} has too many elements to bound a ${sym} (limit ${SUM_MAX_TERMS}).`);
  return { name, seq, values };
}
