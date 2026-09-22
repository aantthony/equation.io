import { structuralDiagnostic } from './expr.ts';
/**
 * Symbolic differentiation over the plotting AST, with just enough
 * simplification (constant folding, 0/1 pruning) that the emitted GLSL stays
 * readable and cheap. Non-smooth functions (min, max, floor, …) throw;
 * callers fall back to finite differences.
 */
import { ANGLE_FN, ANGLE_RATE_FN, type Expr, plainFnName } from './expr.ts';

const num = (value: number): Expr => ({ kind: 'num', value });
const ZERO = num(0);
const ONE = num(1);

const isNum = (e: Expr): e is Expr & { kind: 'num' } => e.kind === 'num';
const isNumVal = (e: Expr, v: number): boolean => e.kind === 'num' && e.value === v;

export function add(a: Expr, b: Expr): Expr {
  if (isNumVal(a, 0)) return b;
  if (isNumVal(b, 0)) return a;
  if (isNum(a) && isNum(b)) return num(a.value + b.value);
  return { kind: 'bin', op: '+', a, b };
}

export function sub(a: Expr, b: Expr): Expr {
  if (isNumVal(b, 0)) return a;
  if (isNum(a) && isNum(b)) return num(a.value - b.value);
  if (isNumVal(a, 0)) return neg(b);
  return { kind: 'bin', op: '-', a, b };
}

export function neg(a: Expr): Expr {
  if (isNum(a)) return num(-a.value || 0);
  if (a.kind === 'neg') return a.a;
  return { kind: 'neg', a };
}

export function mul(a: Expr, b: Expr): Expr {
  if (isNumVal(a, 0) || isNumVal(b, 0)) return ZERO;
  if (isNumVal(a, 1)) return b;
  if (isNumVal(b, 1)) return a;
  if (isNum(a) && isNum(b)) return num(a.value * b.value);
  return { kind: 'bin', op: '*', a, b };
}

export function div(a: Expr, b: Expr): Expr {
  if (isNumVal(a, 0)) return ZERO;
  if (isNumVal(b, 1)) return a;
  if (isNum(a) && isNum(b) && b.value !== 0) return num(a.value / b.value);
  return { kind: 'bin', op: '/', a, b };
}

export function pow(a: Expr, b: Expr): Expr {
  if (isNumVal(b, 1)) return a;
  if (isNumVal(b, 0)) return ONE;
  return { kind: 'bin', op: '^', a, b };
}

const call = (name: string, ...args: Expr[]): Expr => ({ kind: 'call', name, args });

/** A function with no usable symbolic derivative: callers may fall back to
 *  finite differences (unlike other diff() errors, which are real errors). */
export class NonSmoothError extends Error {}

/** d(e)/d(v). Throws for functions without a usable derivative. */
export function diff(e: Expr, v: string): Expr {
  switch (e.kind) {
    case 'num': return ZERO;
    case 'var': return e.name === v ? ONE : ZERO;
    case 'neg': return neg(diff(e.a, v));
    case 'bin': {
      const { a, b } = e;
      const da = () => diff(a, v);
      const db = () => diff(b, v);
      switch (e.op) {
        case '+': return add(da(), db());
        case '-': return sub(da(), db());
        case '*': return add(mul(da(), b), mul(a, db()));
        case '/': return div(sub(mul(da(), b), mul(a, db())), pow(b, num(2)));
        case '^': {
          if (isNum(b)) {
            // d(a^n) = n a^(n-1) a'
            return mul(mul(b, pow(a, num(b.value - 1))), da());
          }
          if (isNum(a)) {
            // d(c^b) = c^b ln(c) b'
            return mul(mul(pow(a, b), num(Math.log(a.value))), db());
          }
          // d(a^b) = a^b (b' ln a + b a'/a)
          return mul(pow(a, b), add(mul(db(), call('ln', a)), mul(b, div(da(), a))));
        }
      }
      break;
    }
    case 'comp': {
        // f(P): a component of the derivative is the derivative of the
        // component. A value diff() cannot carry (a tuple inside arithmetic)
        // leaves the whole call to the finite-difference fallback.
        const { value } = e;
        let dv: Expr;
        try { dv = diff(value, v); } catch { throw new NonSmoothError('Cannot differentiate this point.'); }
        return isNumVal(dv, 0) ? ZERO : { ...e, value: dv };
      }
    case 'index': case 'range': case 'eqtest': case 'figure': case 'trail': case 'hist': case 'family': throw new NonSmoothError(structuralDiagnostic(e));
    case 'call': {
      if (e.name === 'atan2' || e.name === 'atan' && e.args.length === 2) {
        const [y, x] = e.args;
        const n = sub(mul(diff(y, v), x), mul(y, diff(x, v)));
        return div(n, add(pow(x, num(2)), pow(y, num(2))));
      }
      if (e.name === ANGLE_FN && e.args.length === 4) {
        // The angle turns as fast as arm v does, less how fast arm u does.
        // Each rate is its own scaled builtin: spelled out as
        // (cross′ dot − cross dot′)/(cross² + dot²) it is 0/0 in float32 long
        // before the angle itself stops being well defined near the vertex.
        const [u0, u1, v0, v1] = e.args;
        const rate = (a: Expr, b: Expr): Expr => {
          const da = diff(a, v), db = diff(b, v);
          return isNumVal(da, 0) && isNumVal(db, 0) ? ZERO : call(ANGLE_RATE_FN, a, b, da, db);
        };
        return sub(rate(v0, v1), rate(u0, u1));
      }
      if (e.name === ANGLE_RATE_FN && e.args.length === 4) {
        // Rare (a second derivative): differentiate the unscaled quotient.
        const [a, b, da, db] = e.args;
        return diff(div(sub(mul(a, db), mul(b, da)), add(mul(a, a), mul(b, b))), v);
      }
      if ((e.name === 'normalpdf' || e.name === 'normalcdf') && e.args.length === 3) {
        // Full chain rule in all three arguments (x, mean, sd may all move).
        const [x, m, s] = e.args;
        const z = div(sub(x, m), s);
        const dz = div(sub(sub(diff(x, v), diff(m, v)), mul(z, diff(s, v))), s);
        const pdf = call('normalpdf', x, m, s);
        if (e.name === 'normalcdf') return mul(mul(pdf, s), dz);
        // φ′ = φ·(−z·z′ − s′/s): the −z z′ from the exponent, −s′/s from 1/s.
        return mul(pdf, sub(mul(neg(z), dz), div(diff(s, v), s)));
      }
      if (e.args.length !== 1) throw new NonSmoothError(`Cannot differentiate ${plainFnName(e.name)}.`);
      const a = e.args[0];
      const da = diff(a, v);
      const chain = (outer: Expr) => mul(outer, da);
      switch (e.name) {
        case 'sin': return chain(call('cos', a));
        case 'cos': return neg(chain(call('sin', a)));
        case 'tan': return chain(div(ONE, pow(call('cos', a), num(2))));
        case 'asin': return chain(div(ONE, call('sqrt', sub(ONE, pow(a, num(2))))));
        case 'acos': return neg(chain(div(ONE, call('sqrt', sub(ONE, pow(a, num(2)))))));
        case 'atan': return chain(div(ONE, add(ONE, pow(a, num(2)))));
        case 'sinh': return chain(call('cosh', a));
        case 'cosh': return chain(call('sinh', a));
        case 'tanh': return chain(div(ONE, pow(call('cosh', a), num(2))));
        case 'sech': return neg(chain(mul(call('sech', a), call('tanh', a))));
        case 'asinh': return chain(div(ONE, call('sqrt', add(pow(a, num(2)), ONE))));
        case 'acosh': return chain(div(ONE, call('sqrt', sub(pow(a, num(2)), ONE))));
        case 'atanh': return chain(div(ONE, sub(ONE, pow(a, num(2)))));
        case 'exp': return chain(call('exp', a));
        case 'ln': return div(da, a);
        case 'log': return div(da, mul(a, num(Math.LN10)));
        case 'sqrt': return div(da, mul(num(2), call('sqrt', a)));
        case 'abs': return chain(call('sign', a));
        case 'erf': return chain(mul(num(2 / Math.sqrt(Math.PI)), call('exp', neg(pow(a, num(2))))));
        case 'sinc':
          // (cos x − sinc x)/x away from 0 — this form cancels less than
          // cos/x − sin/x² — and the removable hole filled in: sinc is
          // differentiable at 0 with derivative 0.
          return chain({
            kind: 'piecewise',
            cases: [{
              cond: { kind: 'ineq', op: '>', l: call('abs', a), r: ZERO },
              value: div(sub(call('cos', a), call('sinc', a)), a),
            }],
            otherwise: ZERO,
          });
        case 'coth': return chain(sub(ONE, pow(call('coth', a), num(2))));
        default:
          // min/max/floor/mod/… (and gamma: digamma isn't in the language):
          // no smooth derivative; caller falls back to FD.
          throw new NonSmoothError(`Cannot differentiate ${plainFnName(e.name)}.`);
      }
    }
    case 'eq': return sub(diff(e.l, v), diff(e.r, v));
    case 'ineq': throw new Error('Cannot differentiate an inequality.');
    case 'vec': throw new Error('Differentiate vector components individually.');
    case 'list':
    case 'data': throw new Error('Cannot differentiate a list.');
    case 'str':
    case 'text': throw new Error('Cannot differentiate text.');
    case 'piecewise':
      // Branchwise derivative (ignores the boundary points).
      return {
        kind: 'piecewise',
        cases: e.cases.map(c => ({ cond: c.cond, value: diff(c.value, v) })),
        otherwise: e.otherwise && diff(e.otherwise, v),
      };
  }
  throw new Error('Unreachable');
}
