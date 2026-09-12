/** Coordinate notation lowers to the same Cartesian objects as ordinary rows. */
import { type Expr, substVars, evaluate, freeVars } from './expr.ts';
import { diff } from './diff.ts';

export const num = (value: number): Expr => ({ kind: 'num', value });
export const bin = (op: '+' | '-' | '*' | '/' | '^', a: Expr, b: Expr): Expr => ({ kind: 'bin', op, a, b });
export const call = (name: string, ...args: Expr[]): Expr => ({ kind: 'call', name, args });

export function coordinateRow(expr: Expr, fields: Record<string, Expr>) {
  if (expr.kind !== 'eq' || expr.l.kind !== 'vec') return null;
  if (!expr.l.items.every(e => e.kind === 'var')) return null;
  const names = expr.l.items.map(e => (e as Expr & { kind: 'var' }).name);
  const flow = names.some(n => n.endsWith("'"));
  if (!flow && !names.every(n => n === 'x' || n === 'y' || Object.hasOwn(fields, n))) return null;
  if (flow && !names.every(n => n.endsWith("'"))) throw new Error('A coordinate flow needs a prime on every coordinate.');
  const bases = names.map(n => flow ? n.slice(0, -1) : n);
  if (bases.length !== 2 || new Set(bases).size !== 2) throw new Error('Use two distinct coordinates to determine a point or flow.');
  const coords = bases.map(n => {
    if (n === 'x' || n === 'y') return { kind: 'var', name: n } as Expr;
    if (Object.hasOwn(fields, n)) return fields[n];
    throw new Error(`${n} is not a coordinate — define ${n} as a function of x and y first.`);
  });
  if (expr.r.kind !== 'vec') throw new Error(flow ? 'A coordinate flow needs two components on the right.' : 'A vector equation needs components on both sides.');
  if (expr.r.items.length !== 2) throw new Error(`Mismatched components: 2 on the left, ${expr.r.items.length} on the right.`);
  return { coords, flow, rhs: expr.r.items };
}

export function lowerCoordinateFlow(expr: Expr, fields: Record<string, Expr>): Expr {
  const row = coordinateRow(expr, fields);
  if (!row?.flow || (row.coords[0].kind === 'var' && row.coords[0].name === 'x' && row.coords[1].kind === 'var' && row.coords[1].name === 'y')) return Object.keys(fields).length ? substVars(expr, fields) : expr;
  const [a, b] = row.coords;
  const [f, g] = row.rhs.map((e, k) => bin('-', substVars(e, fields), diff(row.coords[k], 't')));
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
