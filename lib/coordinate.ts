/** Coordinate notation lowers to the same Cartesian objects as ordinary rows. */
import { type Expr, substVars, evaluate, freeVars } from './expr.ts';
import { diff } from './diff.ts';

export const num = (value: number): Expr => ({ kind: 'num', value });
export const bin = (op: '+' | '-' | '*' | '/' | '^', a: Expr, b: Expr): Expr => ({ kind: 'bin', op, a, b });
export const call = (name: string, ...args: Expr[]): Expr => ({ kind: 'call', name, args });

const AXES: ReadonlySet<string> = new Set(['x', 'y', 'z']);

/** A row naming coordinates in a tuple on the left: a position `(r, theta) =
 *  (2, pi/4)` — two coordinates in the plane, three in space — or a planar
 *  flow `(r', theta') = (F, G)`. Null for any other row. */
export function coordinateRow(expr: Expr, fields: Record<string, Expr>) {
  if (expr.kind !== 'eq' || expr.l.kind !== 'vec') return null;
  if (!expr.l.items.every(e => e.kind === 'var')) return null;
  const names = expr.l.items.map(e => (e as Expr & { kind: 'var' }).name);
  const flow = names.some(n => n.endsWith("'"));
  if (!flow && !names.every(n => AXES.has(n) || Object.hasOwn(fields, n))) return null;
  if (flow && !names.every(n => n.endsWith("'"))) throw new Error('A coordinate flow needs a prime on every coordinate.');
  const bases = names.map(n => flow ? n.slice(0, -1) : n);
  const shown = `(${names.join(', ')})`;
  if (new Set(bases).size !== bases.length) throw new Error(`${shown} repeats a coordinate — use distinct coordinates to determine a point or flow.`);
  if (flow ? bases.length !== 2 : bases.length !== 2 && bases.length !== 3) {
    throw new Error(flow
      ? 'A coordinate flow needs two coordinates — flows are 2D only.'
      : 'Use two coordinates to determine a point in the plane, or three in space.');
  }
  const coords = bases.map(n => {
    if (AXES.has(n)) return { kind: 'var', name: n } as Expr;
    if (Object.hasOwn(fields, n)) return fields[n];
    throw new Error(`${n} is not a coordinate — define ${n} as a function of x and y first.`);
  });
  if (flow) {
    const spatial = bases.find((_, k) => freeVars(coords[k]).has('z'));
    if (spatial === 'z') throw new Error('Coordinate flows are 2D only — z cannot be a flow coordinate.');
    if (spatial) throw new Error(`${spatial} uses z, and coordinate flows are 2D only.`);
  }
  const n = bases.length;
  if (expr.r.kind !== 'vec') throw new Error(flow ? 'A coordinate flow needs two components on the right.' : 'A vector equation needs components on both sides.');
  if (expr.r.items.length !== n) throw new Error(`Mismatched components: ${n} on the left, ${expr.r.items.length} on the right.`);
  return { coords, flow, rhs: expr.r.items };
}

export function lowerCoordinateFlow(expr: Expr, fields: Record<string, Expr>, timeDerivative = (e: Expr) => diff(e, 't')): Expr {
  const row = coordinateRow(expr, fields);
  if (!row?.flow || (row.coords[0].kind === 'var' && row.coords[0].name === 'x' && row.coords[1].kind === 'var' && row.coords[1].name === 'y')) return Object.keys(fields).length ? substVars(expr, fields) : expr;
  const [a, b] = row.coords;
  const [f, g] = row.rhs.map((e, k) => bin('-', substVars(e, fields), timeDerivative(row.coords[k])));
  const ax = diff(a, 'x'), ay = diff(a, 'y'), bx = diff(b, 'x'), by = diff(b, 'y');
  const det = bin('-', bin('*', ax, by), bin('*', ay, bx));
  if (freeVars(det).size === 0 && evaluate(det, {}) === 0) {
    throw new Error('These coordinates have a singular Jacobian and do not determine a flow.');
  }
  // Emit Cartesian prime notation so even a constant velocity remains a field.
  return { kind: 'eq', l: { kind: 'vec', items: ["x'", "y'"].map(name => ({ kind: 'var', name })) },
    r: { kind: 'vec', items: [bin('/', bin('-', bin('*', by, f), bin('*', ay, g)), det),
      bin('/', bin('-', bin('*', ax, g), bin('*', bx, f)), det)] } };
}
