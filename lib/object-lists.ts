import { exceedsNodes } from './size.ts';
/** Lift lists in object positions before scalar geometry lowering. Existing
 * data/reduction paths get first refusal so large CSVs remain typed arrays. */
import { type Defs, type ResolveOpts, compsOf, listGetter } from './defs.ts';
import { WHOLE_EXPR_NAMES } from './complex.ts';
import { type Expr, freeVars } from './expr.ts';
import { GEOM_STATEMENTS, lowerGeom } from './geom.ts';
import { isDataScatter, isSeq, lowerLists } from './list.ts';

export const FAMILY_MAX = 32;
export const FAMILY_3D_MAX = 8;
const num = (value: number): Expr => ({ kind: 'num', value });

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
      case 'vec': case 'list': return { ...n, items: n.items.map(indices) };
      case 'piecewise': return { ...n, cases: n.cases.map(c => ({ cond: indices(c.cond), value: indices(c.value) })), otherwise: n.otherwise && indices(n.otherwise) };
      default: return n;
    }
  };
  if (!exceedsNodes(e, 32768)) e = indices(e);
  const ordinary = (e: Expr) => lowerLists(lowerGeom(e, n => compsOf(defs, n), n => defs.mats.get(n) ?? null,
    n => get(n) !== null), get, opts, named);
  const listValue = (e: Expr): Expr[] | null => {
    let value: Expr;
    if (e.kind === 'var' && defs.mats.has(e.name)) {
      return defs.mats.get(e.name)!.map(items => ({ kind: 'vec', items }));
    }
    try { value = ordinary(e); } catch { return null; }
    if (value.kind === 'list') return value.items;
    if (value.kind === 'data') {
      if (value.values.length > 100000) throw new Error('A point path accepts at most 100000 vertices.');
      return Array.from(value.values, num);
    }
    if (isDataScatter(value) && value.kind === 'vec') {
      const n = value.items.find(c => c.kind === 'data')! as Expr & { kind: 'data' };
      if (n.values.length > 100000) throw new Error('A point path accepts at most 100000 vertices.');
      return Array.from(n.values, (_, k) => ({ kind: 'vec', items: value.items.map(c => c.kind === 'data' ? num(c.values[k]) : c) }));
    }
    return null;
  };
  // Connectedness consumes a whole list; it does not broadcast its vertices
  // into separate one-vertex figures. Also accepts a zipped CSV scatter.
  if (e.kind === 'call' && ['polyline', 'polygon'].includes(e.name) && e.args.length === 1) {
    const pts = listValue(e.args[0]);
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

  if (exceedsNodes(e, 32768)) throw new Error('This object family is too large to expand (32768 nodes).');
  const lists: Expr[][] = [];
  const markers = new Map<Expr, number>();
  const visit = (node: Expr): Expr => {
    const values = listValue(node);
    if (values) {
      if (!values.length || values.length > 100000) throw new Error('Point-list arithmetic needs 1–100000 values.');
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
  const template = visit(e);
  if (!lists.length) throw originalError ?? new Error('This expression cannot be expanded as an object family.');
  const n = lists[0].length;
  if (lists.some(l => l.length !== n)) throw new Error('Lists have different lengths — object families zip equal-length lists.');
  const instantiate = (node: Expr, k: number): Expr => {
    const hit = markers.get(node); if (hit !== undefined) return lists[hit][k];
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
  const objects = e.kind === 'eq' || e.kind === 'ineq' || [...freeVars(e)].some(plotVariable)
    || lists.some(l => l.some(e => [...freeVars(e)].some(plotVariable)))
    || (e.kind === 'call' && (GEOM_STATEMENTS.has(e.name) || WHOLE_EXPR_NAMES.has(e.name)));
  if (objects && n > FAMILY_MAX) throw new Error(`An object family needs 1–${FAMILY_MAX} members (got ${n}).`);
  const members = Array.from({ length: n }, (_, k) => ordinary(instantiate(template, k)));
  const valuesOnly = members.every(m => ![...freeVars(m)].some(plotVariable)
    && m.kind !== 'eq' && m.kind !== 'ineq' && !(m.kind === 'call' && (/^\[(polygon|segment|polyline|vector|square|trail|hist)/.test(m.name) || (GEOM_STATEMENTS.has(m.name) || WHOLE_EXPR_NAMES.has(m.name)))));
  if (valuesOnly) return { kind: 'list', items: members };
  if (n > FAMILY_MAX) throw new Error(`An object family has at most ${FAMILY_MAX} members.`);
  if (named) throw new Error('An object family is a whole row; give it a row of its own.');
  return { kind: 'call', name: '[family]', args: members };
}
