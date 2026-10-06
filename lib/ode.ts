/** Flows spelled as ODEs, shared by plot classification and axis maps. */
import type { Expr } from './expr.ts';

const isVarNamed = (e: Expr, name: string): boolean => e.kind === 'var' && e.name === name;

/**
 * Match an equation that spells an ODE — dy/dx = f, y' = f, or a system
 * (x', y') = (P, Q) — and return its direction field as a tuple.
 */
export function matchODE(e: Expr): (Expr & { kind: 'vec' }) | null {
  if (e.kind !== 'eq') return null;
  const { l, r } = e;
  const one: Expr = { kind: 'num', value: 1 };
  const vec = (items: Expr[]): Expr & { kind: 'vec' } => ({ kind: 'vec', items });
  if (l.kind === 'bin' && l.op === '/') {
    if (isVarNamed(l.a, 'dy') && isVarNamed(l.b, 'dx')) return vec([one, r]);
    if (isVarNamed(l.a, 'dx') && isVarNamed(l.b, 'dy')) return vec([r, one]);
  }
  if (isVarNamed(l, "y'")) return vec([one, r]);
  if (l.kind === 'vec' && l.items.length === 3 && l.items.every((e, k) => isVarNamed(e, ["x'", "y'", "z'"][k]))) {
    if (r.kind !== 'vec' || r.items.length !== 3) throw new Error('A 3D flow needs three velocity components.');
    return r;
  }
  if (l.kind === 'vec' && l.items.length === 2 && isVarNamed(l.items[0], "x'") && isVarNamed(l.items[1], "y'")) {
    if (r.kind !== 'vec' || r.items.length !== 2) {
      throw new Error("A system needs two components on the right: (x', y') = (P, Q).");
    }
    return r;
  }
  return null;
}
