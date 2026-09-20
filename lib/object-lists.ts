import { exceedsNodes } from './size.ts';
/** Lift lists in object positions before scalar geometry lowering. Existing
 * data/reduction paths get first refusal so large CSVs remain typed arrays. */
import { type Defs, type ResolveOpts, compsOf, listGetter } from './defs.ts';
import { WHOLE_EXPR_NAMES } from './complex.ts';
import { type Expr, freeVars, sameList } from './expr.ts';
import { GEOM_STATEMENTS, lowerGeom } from './geom.ts';
import { type Axis, axesOf, isDataScatter, lowerLists } from './list.ts';

export const FAMILY_MAX = 32;
export const FAMILY_3D_MAX = 8;
/** Point figures are a handful of numbers each, evaluated on the CPU — not a
 *  shader draw — so a family of them can be a whole lattice of arrows. */
export const FIGURE_FAMILY_MAX = 1024;
const num = (value: number): Expr => ({ kind: 'num', value });

/** Figures that are just their points: moving the points moves the figure. */
const POINT_FIGURES = new Set(['segment', 'polyline', 'polygon', 'vector', 'hull']);

/**
 * A transformed figure is the figure of the transformed points: `R hull(P)`,
 * `polygon(A, B, C) + (1, 0)`, `2 segment(A, B)`, `rotate(hull(P), a)`. Every
 * map a row can write this way is affine, and affine maps carry segments to
 * segments and hulls to hulls — so the transform moves inside, onto each
 * point (or the one point list), and the figure stays the whole statement.
 */
function pushTransforms(e: Expr): Expr {
  const figure = (n: Expr): (Expr & { kind: 'call' }) | null =>
    (n.kind === 'call' && POINT_FIGURES.has(n.name) ? n : null);
  const onto = (fig: Expr & { kind: 'call' }, move: (point: Expr) => Expr, shifts = false): Expr => {
    // vector(V) starts at the origin, which a shift would have to move too.
    if (shifts && fig.name === 'vector' && fig.args.length === 1) {
      throw new Error('vector(V) starts at the origin — write vector(A, B) to move it.');
    }
    return { ...fig, args: fig.args.map(move) };
  };
  switch (e.kind) {
    case 'neg': {
      const a = figure(pushTransforms(e.a));
      return a ? onto(a, p => ({ kind: 'neg', a: p })) : e;
    }
    case 'bin': {
      const l = pushTransforms(e.a), r = pushTransforms(e.b);
      const a = figure(l), b = figure(r);
      if (a && b) throw new Error('Two figures do not combine — transform one figure at a time.');
      const shifts = e.op === '+' || e.op === '-';
      if (a && e.op !== '^') return onto(a, p => ({ ...e, a: p, b: r }), shifts);
      if (b && e.op !== '^' && e.op !== '/') return onto(b, p => ({ ...e, a: l, b: p }), shifts);
      return e;
    }
    case 'call': {
      if (e.name !== 'rotate' || !e.args.length) return e;
      const a = figure(pushTransforms(e.args[0]));
      return a ? onto(a, p => ({ ...e, args: [p, ...e.args.slice(1)] })) : e;
    }
    default: return e;
  }
}

const holdsFigure = (e: Expr): boolean => {
  switch (e.kind) {
    case 'call': return POINT_FIGURES.has(e.name) || e.args.some(holdsFigure);
    case 'bin': return holdsFigure(e.a) || holdsFigure(e.b);
    case 'neg': return holdsFigure(e.a);
    default: return false;
  }
};

export function lowerObjects(e: Expr, defs: Defs, opts: ResolveOpts = {}, named = false): Expr {
  const plotVariable = (v: string) => ['x', 'y', 'z', 'u', 'v'].includes(v) || defs.fields.has(v);
  const baseGet = listGetter(defs);
  const get = (name: string): Expr | null => baseGet(name) ?? (defs.mats.has(name)
    ? { kind: 'list', items: defs.mats.get(name)!.map(items => ({ kind: 'vec', items })) } : null);
  const indices = (n: Expr): Expr => {
    if (n.kind === 'call' && n.name === '[index]') return lowerLists(n, get, opts, true);
    switch (n.kind) {
      case 'call': return { ...n, args: n.args.map(indices) };
      case 'bin': return { ...n, a: indices(n.a), b: indices(n.b) };
      case 'neg': return { ...n, a: indices(n.a) };
      case 'eq': case 'ineq': return { ...n, l: indices(n.l), r: indices(n.r) };
      case 'vec': case 'list': return sameList(n, { ...n, items: n.items.map(indices) });
      case 'piecewise': return { ...n, cases: n.cases.map(c => ({ cond: indices(c.cond), value: indices(c.value) })), otherwise: n.otherwise && indices(n.otherwise) };
      default: return n;
    }
  };
  if (!exceedsNodes(e, 32768)) e = indices(e);
  const ordinary = (e: Expr) => lowerLists(lowerGeom(e, n => compsOf(defs, n), n => defs.mats.get(n) ?? null,
    n => get(n) !== null), get, opts, named);
  // A list's elements, with the instances it runs over (see Axis in list.ts).
  const listValue = (e: Expr): { items: Expr[]; axes: readonly Axis[] } | null => {
    let value: Expr;
    if (e.kind === 'var' && defs.mats.has(e.name)) {
      const items = defs.mats.get(e.name)!.map((items): Expr => ({ kind: 'vec', items }));
      return { items, axes: [{ id: `${e.name}#0`, n: items.length }] };
    }
    try { value = ordinary(e); } catch { return null; }
    if (value.kind === 'list') return { items: value.items, axes: axesOf(value) };
    if (value.kind === 'data') {
      if (value.values.length > 100000) throw new Error('A point path accepts at most 100000 vertices.');
      return { items: Array.from(value.values, num), axes: axesOf(value) };
    }
    if (isDataScatter(value) && value.kind === 'vec') {
      const n = value.items.find(c => c.kind === 'data')! as Expr & { kind: 'data' };
      if (n.values.length > 100000) throw new Error('A point path accepts at most 100000 vertices.');
      return { items: Array.from(n.values, (_, k) => ({ kind: 'vec', items: value.items.map(c => c.kind === 'data' ? num(c.values[k]) : c) })), axes: axesOf(n) };
    }
    return null;
  };
  // A transformed figure. A list in the TRANSFORM is one figure per element —
  // e^(th J) hull(P) is a rosette of hulls, not the hull of every copy — so
  // those expand first, around the figure; then the transform moves inside.
  // (Sized first: the size walk stops at its limit, a figure hunt would not.)
  if (!(e.kind === 'call' && POINT_FIGURES.has(e.name)) && !exceedsNodes(e, 32768) && holdsFigure(e)) {
    const family = expand(e, true);
    if (family) return family;
    e = pushTransforms(e);
  }
  // Connectedness consumes a whole list; it does not broadcast its vertices
  // into separate one-vertex figures. Also accepts a zipped CSV scatter.
  if (e.kind === 'call' && ['polyline', 'polygon', 'hull'].includes(e.name) && e.args.length === 1) {
    // A point list may itself be computed — R P, P + (1, 0), rotate(P, a) —
    // which is the expansion below, asked for the values it yields.
    const computed = (arg: Expr): Expr[] | null => {
      try {
        const value = lowerObjects(arg, defs, opts, true);
        return value.kind === 'list' ? value.items : null;
      } catch { return null; }
    };
    const pts = listValue(e.args[0])?.items ?? computed(e.args[0]);
    if (pts) {
      if (!pts.every(p => p.kind === 'vec')) throw new Error(`${e.name} needs a list of points.`);
      return ordinary({ ...e, args: pts });
    }
  }
  let originalError: unknown;
  try {
    const value = ordinary(e);
    // Lists of functions/parametrics become families; constant lists retain
    // their existing dot/scatter representation and unbounded data path.
    if (value.kind !== 'list' || !value.items.some(it => [...freeVars(it)].some(plotVariable))) return value;
  } catch (err) { originalError = err; }
  try { return expand(e, false)!; } catch (err) {
    // A matrix error is about the matrix: the expansion's own complaint, made
    // while reading things as lists of points, would only bury it.
    throw originalError instanceof Error && /matri/i.test(originalError.message) && !/not a value on its own/.test(originalError.message)
      ? originalError : err;
  }

  /** One member per combination of the lists in `source`. `outside`: only the
   *  lists around a figure, each member a figure lowered in its own right;
   *  null when there are none. */
  function expand(source: Expr, outside: boolean): Expr | null {
    if (exceedsNodes(source, 32768)) throw new Error('This object family is too large to expand (32768 nodes).');
    const lists: Array<{ items: Expr[]; axes: readonly Axis[] }> = [];
    const markers = new Map<Expr, number>();
    // A matrix name is the matrix, not a list of row-points. Those rows are a
    // list only where a figure asks for points — hull(M).
    const visit = (node: Expr): Expr => {
      if (node.kind === 'var' && defs.mats.has(node.name)) return node;
      // Around a figure, only the transform's lists count: the figure keeps its own.
      if (outside && node.kind === 'call' && POINT_FIGURES.has(node.name)) return node;
      const values = listValue(node);
      if (values) {
        if (!values.items.length || values.items.length > 100000) throw new Error('Point-list arithmetic needs 1–100000 values.');
        const marker = num(0);
        markers.set(marker, lists.length); lists.push(values);
        return marker;
      }
      const map = (nodes: Expr[]) => nodes.map(visit);
      switch (node.kind) {
        case 'bin': return { ...node, a: visit(node.a), b: visit(node.b) };
        case 'neg': return { ...node, a: visit(node.a) };
        case 'eq': case 'ineq': return { ...node, l: visit(node.l), r: visit(node.r) };
        case 'vec': return { ...node, items: map(node.items) };
        case 'call': return { ...node, args: map(node.args) };
        case 'piecewise': return { ...node, cases: node.cases.map(c => ({ cond: visit(c.cond), value: visit(c.value) })), otherwise: node.otherwise && visit(node.otherwise) };
        default: return node;
      }
    };
    const template = visit(source);
    if (!lists.length) {
      if (outside) return null;
      throw originalError ?? new Error('This expression cannot be expanded as an object family.');
    }
    // One member per instance: uses of the same list move together, lists with
    // different origins are independent and cross.
    const axes: Axis[] = [];
    for (const a of lists.flatMap(l => l.axes)) {
      const seen = axes.find(u => u.id === a.id);
      if (!seen) axes.push(a);
      else if (seen.n !== a.n) throw new Error(`Lists have different lengths (${seen.n} vs ${a.n}).`);
    }
    const n = axes.reduce((size, a) => size * a.n, 1);
    if (n > 100000) throw new Error(`Independent lists combine every value with every other — that is ${n} combinations. Name one list and reuse it to pair values up instead.`);
    // Where member k sits in each list: its own axes, row-major like the rest.
    const at = (list: { axes: readonly Axis[] }, k: number): number => {
      let index = 0;
      for (let d = axes.length - 1, rest = k; d >= 0; rest = Math.floor(rest / axes[d].n), d--) {
        const own = list.axes.findIndex(a => a.id === axes[d].id);
        if (own < 0) continue;
        index += (rest % axes[d].n) * list.axes.slice(own + 1).reduce((size, a) => size * a.n, 1);
      }
      return index;
    };
    const instantiate = (node: Expr, k: number): Expr => {
      const hit = markers.get(node); if (hit !== undefined) return lists[hit].items[at(lists[hit], k)];
      const map = (ns: Expr[]) => ns.map(n => instantiate(n, k));
      switch (node.kind) {
        case 'bin': return { ...node, a: instantiate(node.a, k), b: instantiate(node.b, k) };
        case 'neg': return { ...node, a: instantiate(node.a, k) };
        case 'eq': case 'ineq': return { ...node, l: instantiate(node.l, k), r: instantiate(node.r, k) };
        case 'vec': return { ...node, items: map(node.items) };
        case 'call': return { ...node, args: map(node.args) };
        case 'piecewise': return { ...node, cases: node.cases.map(c => ({ cond: instantiate(c.cond, k), value: instantiate(c.value, k) })), otherwise: node.otherwise && instantiate(node.otherwise, k) };
        default: return node;
      }
    };
    const objects = outside || source.kind === 'eq' || source.kind === 'ineq' || [...freeVars(source)].some(plotVariable)
      || lists.some(l => l.items.some(e => [...freeVars(e)].some(plotVariable)))
      || (source.kind === 'call' && (GEOM_STATEMENTS.has(source.name) || WHOLE_EXPR_NAMES.has(source.name)));
    const limit = outside || (source.kind === 'call' && POINT_FIGURES.has(source.name)) ? FIGURE_FAMILY_MAX : FAMILY_MAX;
    if (objects && n > limit) throw new Error(`An object family needs 1–${limit} members (got ${n}).`);
    const members = Array.from({ length: n }, (_, k) => (outside ? lowerObjects(instantiate(template, k), defs, opts) : ordinary(instantiate(template, k))));
    const valuesOnly = members.every(m => ![...freeVars(m)].some(plotVariable)
      && m.kind !== 'eq' && m.kind !== 'ineq' && !(m.kind === 'call' && (/^\[(polygon|segment|polyline|vector|square|hull|trail|hist)/.test(m.name) || (GEOM_STATEMENTS.has(m.name) || WHOLE_EXPR_NAMES.has(m.name)))));
    if (valuesOnly) return { kind: 'list', items: members };
    if (n > limit) throw new Error(`An object family has at most ${limit} members.`);
    if (named) throw new Error('An object family is a whole row; give it a row of its own.');
    return { kind: 'call', name: '[family]', args: members };
  }
}
