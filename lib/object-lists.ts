import type { ValueDefinitions } from './env.ts';
import { rowsAsPoints } from './geom.ts';
import { mapChildren } from './expr.ts';
import { exceedsNodes } from './size.ts';
/** Lift lists in object positions before scalar geometry lowering. Existing
 * data/reduction paths get first refusal so large CSVs remain typed arrays. */
import { type ResolveOpts, compsOf, listGetter } from './defs.ts';
import { WHOLE_EXPR_NAMES } from './complex.ts';
import { type Expr, type FigureForm, freeVars, sameList } from './expr.ts';
import { GEOM_STATEMENTS, lowerGeom } from './geom.ts';
import { type Axis, axesOf, isDataScatter, lowerLists, withAxes } from './list.ts';

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
    n.kind === 'call' && POINT_FIGURES.has(n.name) ? n : null;
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
      const l = pushTransforms(e.a),
        r = pushTransforms(e.b);
      const a = figure(l),
        b = figure(r);
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
    default:
      return e;
  }
}

const holdsFigure = (e: Expr): boolean => {
  switch (e.kind) {
    case 'call':
      return POINT_FIGURES.has(e.name) || e.args.some(holdsFigure);
    case 'bin':
      return holdsFigure(e.a) || holdsFigure(e.b);
    case 'neg':
      return holdsFigure(e.a);
    default:
      return false;
  }
};

export function lowerObjects(e: Expr, defs: ValueDefinitions, opts: ResolveOpts = {}, named = false): Expr {
  const plotVariable = (v: string) => ['x', 'y', 'z', 'u', 'v'].includes(v) || defs.fields.has(v);
  const baseGet = listGetter(defs);
  const get = (name: string): Expr | null =>
    baseGet(name) ?? (defs.mats.has(name) ? rowsAsPoints(defs.mats.get(name)!, name) : null);
  // One answer per node: the argument of f(P) is shared by every component
  // that reads it, and has to stay one node to be lowered once.
  const indexed = new WeakMap<Expr, Expr>();
  const indices = (n: Expr): Expr => {
    let out = indexed.get(n);
    if (!out) indexed.set(n, (out = indicesOf(n)));
    return out;
  };
  const indicesOf = (n: Expr): Expr => {
    if (n.kind === 'index') return lowerLists(n, get, opts, true);
    switch (n.kind) {
      case 'call':
        return { ...n, args: n.args.map(indices) };
      case 'bin':
        return { ...n, a: indices(n.a), b: indices(n.b) };
      case 'neg':
        return { ...n, a: indices(n.a) };
      case 'eq':
      case 'ineq':
        return { ...n, l: indices(n.l), r: indices(n.r) };
      case 'vec':
      case 'list':
        return sameList(n, { ...n, items: n.items.map(indices) });
      case 'piecewise':
        return {
          ...n,
          cases: n.cases.map(c => ({ cond: indices(c.cond), value: indices(c.value) })),
          otherwise: n.otherwise && indices(n.otherwise),
        };
      default:
        return mapChildren(n, indices);
    }
  };
  if (!exceedsNodes(e, 32768)) e = indices(e);
  const ordinary = (e: Expr, packed = false) =>
    lowerLists(
      lowerGeom(
        e,
        n => compsOf(defs, n),
        n => defs.mats.get(n) ?? null,
        n => get(n) !== null,
      ),
      get,
      opts,
      named,
      packed,
    );
  // A list's elements, with the instances it runs over (see Axis in list.ts).
  type ListValue = { items: readonly Expr[]; axes: readonly Axis[] };
  // Coordinate lists settleComps wrote in: values already, one node each to
  // the expansion's size limit — not a tree it would have to walk.
  const settledLists = new WeakSet<object>();
  const listValues = new WeakMap<Expr, ListValue | null>();
  const listValue = (e: Expr): ListValue | null => {
    let hit = listValues.get(e);
    if (hit === undefined) listValues.set(e, (hit = listValueOf(e)));
    return hit;
  };
  const listValueOf = (e: Expr): ListValue | null => {
    let value: Expr;
    if (e.kind === 'var' && defs.mats.has(e.name)) {
      const rows = rowsAsPoints(defs.mats.get(e.name)!, e.name);
      return { items: rows.items, axes: axesOf(rows) };
    }
    try {
      value = ordinary(e);
    } catch {
      return null;
    }
    if (value.kind === 'list') return { items: value.items, axes: axesOf(value) };
    if (value.kind === 'data') {
      if (value.values.length > 100000) throw new Error('A point path accepts at most 100000 vertices.');
      return { items: Array.from(value.values, num), axes: axesOf(value) };
    }
    if (isDataScatter(value) && value.kind === 'vec') {
      const n = value.items.find(c => c.kind === 'data')! as Expr & { kind: 'data' };
      if (n.values.length > 100000) throw new Error('A point path accepts at most 100000 vertices.');
      return {
        items: Array.from(n.values, (_, k) => ({
          kind: 'vec',
          items: value.items.map(c => (c.kind === 'data' ? num(c.values[k]) : c)),
        })),
        axes: axesOf(n),
      };
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
    // Points computed over packed numbers with a slider or t in the way —
    // polyline(F(k)) through thousands of k — stay one vertex template.
    const arg = e.args[0];
    if (!(arg.kind === 'var' && defs.mats.has(arg.name))) {
      let value: Expr | null = null;
      try {
        value = ordinary(arg, true);
      } catch {
        /* the paths below report it */
      }
      if (value?.kind === 'lazy') return packedFigure(e.name as 'polyline' | 'polygon' | 'hull', value);
    }
    // A point list may itself be computed — R P, P + (1, 0), rotate(P, a) —
    // which is the expansion below, asked for the values it yields.
    const computed = (arg: Expr): readonly Expr[] | null => {
      try {
        const value = lowerObjects(arg, defs, opts, true);
        return value.kind === 'list' ? value.items : null;
      } catch {
        return null;
      }
    };
    const pts = listValue(e.args[0])?.items ?? computed(e.args[0]);
    if (pts) {
      if (!pts.every(p => p.kind === 'vec')) throw new Error(`${e.name} needs a list of points.`);
      return ordinary({ ...e, args: pts });
    }
  }
  let originalError: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      const value = ordinary(e);
      // Lists of functions/parametrics become families; constant lists retain
      // their existing dot/scatter representation and unbounded data path.
      if (value.kind !== 'list' || !value.items.some(it => [...freeVars(it)].some(plotVariable))) return value;
      break;
    } catch (err) {
      originalError ??= err;
    }
    // f(R P), f(P + (1, 0)): the argument is a point list only this pass can
    // compute. Settle it ONCE, as the lists of its coordinates, and the row
    // is ordinary again — mean(g(2 P)) included, which no family could be.
    const settled = attempt === 0 && !exceedsNodes(e, 32768) ? settleComps(e) : e;
    if (settled === e) break;
    e = settled;
  }
  try {
    return expand(e, false)!;
  } catch (err) {
    // A matrix error is about the matrix: the expansion's own complaint, made
    // while reading things as lists of points, would only bury it.
    throw originalError instanceof Error &&
      /matri/i.test(originalError.message) &&
      !/not a value on its own/.test(originalError.message)
      ? originalError
      : err;
  }

  /** A connected figure through a template of points: the template is its one
   *  vertex, evaluated once per element of the columns (see `over`). */
  function packedFigure(form: 'polyline' | 'polygon' | 'hull', points: Expr & { kind: 'lazy' }): Expr {
    const vertex = points.body;
    if (vertex.kind !== 'vec' || (vertex.items.length !== 2 && vertex.items.length !== 3))
      throw new Error(`${form} needs a list of points.`);
    const n = points.cols[0].values.length;
    if (n > 100000) throw new Error('A point path accepts at most 100000 vertices.');
    const least = form === 'polyline' ? 2 : 3;
    if (n < least) {
      throw new Error(
        form === 'polyline'
          ? 'polyline needs at least 2 points: polyline(A, B, C).'
          : form === 'hull'
            ? 'hull needs at least 3 points: hull(A, B, C, D), or hull(P) for a list of points.'
            : 'polygon needs at least 3 vertices.',
      );
    }
    return {
      kind: 'figure',
      form: form as FigureForm,
      dimension: vertex.items.length as 2 | 3,
      vertices: vertex.items,
      over: points.cols,
    };
  }

  /** Every `[comp]` whose value is a computed point list, replaced by the list
   *  of that coordinate — over the value's own instances, so they still zip. */
  function settleComps(root: Expr): Expr {
    const done = new WeakMap<Expr, Expr>();
    const points = new WeakMap<Expr, Expr | null>();
    const walk = (n: Expr): Expr => {
      let out = done.get(n);
      if (!out) done.set(n, (out = walkOf(n)));
      return out;
    };
    const all = (ns: readonly Expr[]): readonly Expr[] => {
      const out = ns.map(walk);
      return out.every((o, k) => o === ns[k]) ? ns : out;
    };
    const walkOf = (n: Expr): Expr => {
      switch (n.kind) {
        case 'neg': {
          const a = walk(n.a);
          return a === n.a ? n : { ...n, a };
        }
        case 'bin': {
          const a = walk(n.a),
            b = walk(n.b);
          return a === n.a && b === n.b ? n : { ...n, a, b };
        }
        case 'eq':
        case 'ineq': {
          const l = walk(n.l),
            r = walk(n.r);
          return l === n.l && r === n.r ? n : { ...n, l, r };
        }
        case 'vec':
        case 'list': {
          const items = all(n.items);
          return items === n.items ? n : sameList(n, { ...n, items });
        }
        case 'piecewise': {
          const cases = n.cases.map(c => ({ cond: walk(c.cond), value: walk(c.value) }));
          const otherwise = n.otherwise && walk(n.otherwise);
          return otherwise === n.otherwise &&
            cases.every((c, k) => c.cond === n.cases[k].cond && c.value === n.cases[k].value)
            ? n
            : { ...n, cases, otherwise };
        }
        case 'comp': {
          const value = walk(n.value);
          const call = value === n.value ? n : { ...n, value };
          let pts = points.get(value);
          if (pts === undefined) {
            try {
              pts = lowerObjects(value, defs, opts, true);
            } catch {
              pts = null;
            }
            points.set(value, pts);
          }
          const dim = n.arity;
          // (Anything else — one point, a wrong dimension — is the ordinary path's to judge.)
          if (
            pts?.kind !== 'list' ||
            !pts.items.length ||
            !pts.items.every(p => p.kind === 'vec' && p.items.length === dim)
          )
            return call;
          const k = n.index;
          const coords = withAxes<Expr>(
            { kind: 'list', items: pts.items.map(p => (p as Expr & { kind: 'vec' }).items[k]) },
            axesOf(pts),
          );
          settledLists.add(coords);
          return coords;
        }
        case 'call':
          return mapChildren(n, walk);
        default:
          return mapChildren(n, walk);
      }
    };
    return walk(root);
  }

  /** One member per combination of the lists in `source`. `outside`: only the
   *  lists around a figure, each member a figure lowered in its own right;
   *  null when there are none. */
  function expand(source: Expr, outside: boolean): Expr | null {
    if (exceedsNodes(source, 32768, n => settledLists.has(n)))
      throw new Error('This object family is too large to expand (32768 nodes).');
    const lists: ListValue[] = [];
    const markers = new Map<Expr, number>();
    // A matrix name is the matrix, not a list of row-points, along the row's
    // own algebra (2 M, M v). Those rows are a list only where a call asks for
    // points — hull(M), distance(P, A) — and there still not as the matrix
    // factor of a product.
    const visit = (node: Expr, asMatrix = true): Expr => {
      if (asMatrix && node.kind === 'var' && defs.mats.has(node.name)) return node;
      // Around a figure, only the transform's lists count: the figure keeps its own.
      if (outside && node.kind === 'call' && POINT_FIGURES.has(node.name)) return node;
      const values = listValue(node);
      if (values) {
        if (!values.items.length || values.items.length > 100000)
          throw new Error('Point-list arithmetic needs 1–100000 values.');
        const marker = num(0);
        markers.set(marker, lists.length);
        lists.push(values);
        return marker;
      }
      const map = (nodes: readonly Expr[]) => nodes.map(n => visit(n, asMatrix));
      switch (node.kind) {
        case 'bin':
          return { ...node, a: visit(node.a, asMatrix || node.op === '*'), b: visit(node.b, asMatrix) };
        case 'neg':
          return { ...node, a: visit(node.a, asMatrix) };
        case 'eq':
        case 'ineq':
          return { ...node, l: visit(node.l), r: visit(node.r) };
        case 'vec':
          return { ...node, items: map(node.items) };
        case 'call':
          return { ...node, args: node.args.map(n => visit(n, false)) };
        case 'comp':
          return { ...node, value: visit(node.value, false) };
        case 'piecewise':
          return {
            ...node,
            cases: node.cases.map(c => ({ cond: visit(c.cond), value: visit(c.value) })),
            otherwise: node.otherwise && visit(node.otherwise),
          };
        default:
          return mapChildren(node, n => visit(n, asMatrix));
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
    if (n > 100000)
      throw new Error(
        `Independent lists combine every value with every other — that is ${n} combinations. Name one list and reuse it to pair values up instead.`,
      );
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
      const hit = markers.get(node);
      if (hit !== undefined) return lists[hit].items[at(lists[hit], k)];
      const map = (ns: readonly Expr[]) => ns.map(n => instantiate(n, k));
      switch (node.kind) {
        case 'bin':
          return { ...node, a: instantiate(node.a, k), b: instantiate(node.b, k) };
        case 'neg':
          return { ...node, a: instantiate(node.a, k) };
        case 'eq':
        case 'ineq':
          return { ...node, l: instantiate(node.l, k), r: instantiate(node.r, k) };
        case 'vec':
          return { ...node, items: map(node.items) };
        case 'call':
          return { ...node, args: map(node.args) };
        case 'piecewise':
          return {
            ...node,
            cases: node.cases.map(c => ({ cond: instantiate(c.cond, k), value: instantiate(c.value, k) })),
            otherwise: node.otherwise && instantiate(node.otherwise, k),
          };
        default:
          return mapChildren(node, n => instantiate(n, k));
      }
    };
    const objects =
      outside ||
      source.kind === 'eq' ||
      source.kind === 'ineq' ||
      [...freeVars(source)].some(plotVariable) ||
      lists.some(l => l.items.some(e => [...freeVars(e)].some(plotVariable))) ||
      (source.kind === 'call' && (GEOM_STATEMENTS.has(source.name) || WHOLE_EXPR_NAMES.has(source.name)));
    const limit =
      outside || (source.kind === 'call' && POINT_FIGURES.has(source.name)) ? FIGURE_FAMILY_MAX : FAMILY_MAX;
    if (objects && n > limit) throw new Error(`An object family needs 1–${limit} members (got ${n}).`);
    const members = Array.from({ length: n }, (_, k) =>
      outside ? lowerObjects(instantiate(template, k), defs, opts) : ordinary(instantiate(template, k)),
    );
    const valuesOnly = members.every(
      m =>
        ![...freeVars(m)].some(plotVariable) &&
        !['figure', 'trail', 'label', 'hist', 'family'].includes(m.kind) &&
        m.kind !== 'eq' &&
        m.kind !== 'ineq' &&
        !(
          m.kind === 'call' &&
          (/^\[(polygon|segment|polyline|vector|square|hull|trail|hist)/.test(m.name) ||
            GEOM_STATEMENTS.has(m.name) ||
            WHOLE_EXPR_NAMES.has(m.name))
        ),
    );
    // (Over the instances it was expanded along: Q = P + (1, 0) moves with P.)
    if (valuesOnly) return withAxes({ kind: 'list', items: members }, axes);
    if (n > limit) throw new Error(`An object family has at most ${limit} members.`);
    if (named) throw new Error('An object family is a whole row; give it a row of its own.');
    return { kind: 'family', members };
  }
}
