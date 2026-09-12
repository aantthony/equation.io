/** Real expression components for CPU solving and point rendering. */
import { type Expr } from './expr.ts';
import { usesComplex, compileTyped } from './complex.ts';
import { num, bin, call } from './coordinate.ts';
type Pair = [Expr, Expr];
const add = (a: Pair, b: Pair): Pair => [bin('+', a[0], b[0]), bin('+', a[1], b[1])];
const mul = (a: Pair, b: Pair): Pair => [bin('-', bin('*', a[0], b[0]), bin('*', a[1], b[1])), bin('+', bin('*', a[0], b[1]), bin('*', a[1], b[0]))];
const neg = (a: Expr) => bin('*', num(-1), a);
const norm2 = (a: Pair) => bin('+', bin('^', a[0], num(2)), bin('^', a[1], num(2)));
const div = (a: Pair, b: Pair): Pair => mul(a, [b[0], neg(b[1])]).map(c => bin('/', c, norm2(b))) as Pair;
const exp = (a: Pair): Pair => [bin('*', call('exp', a[0]), call('cos', a[1])), bin('*', call('exp', a[0]), call('sin', a[1]))];
const ln = (a: Pair): Pair => [bin('/', call('ln', norm2(a)), num(2)), call('atan2', a[1], a[0])];

function hasProjection(e: Expr): boolean {
  if (e.kind === 'call') return ['re', 'im', 'conj', 'arg'].includes(e.name) || e.args.some(hasProjection);
  if (e.kind === 'bin') return hasProjection(e.a) || hasProjection(e.b);
  if (e.kind === 'neg') return hasProjection(e.a);
  return false;
}

export function complexParts(e: Expr): Pair {
  if (!usesComplex(e) && !hasProjection(e)) return [e, num(0)];
  if (e.kind === 'var') return e.name === 'i' ? [num(0), num(1)] : [{ kind: 'var', name: 'x' }, { kind: 'var', name: 'y' }];
  if (e.kind === 'neg') return complexParts(e.a).map(neg) as Pair;
  if (e.kind === 'bin') {
    const a = complexParts(e.a), b = complexParts(e.b);
    if (compileTyped(e).type === 'real') return [bin(e.op, a[0], b[0]), num(0)];
    switch (e.op) {
      case '+': return add(a, b);
      case '-': return add(a, b.map(neg) as Pair);
      case '*': return mul(a, b);
      case '/': return div(a, b);
      case '^': {
        if (e.b.kind === 'num' && Number.isInteger(e.b.value) && Math.abs(e.b.value) <= 16) {
          let p: Pair = [num(1), num(0)];
          for (let k = 0; k < Math.abs(e.b.value); k++) p = mul(p, a);
          return e.b.value < 0 ? div([num(1), num(0)], p) : p;
        }
        return exp(mul(b, ln(a)));
      }
    }
  }
  if (e.kind === 'call') {
    const type = compileTyped(e).type; // Keep function support and arity consistent with the shader.
    if (type === 'real' && !['re', 'im', 'arg', 'abs'].includes(e.name)) {
      return [call(e.name, ...e.args.map(a => complexParts(a)[0])), num(0)];
    }
    const a = complexParts(e.args[0]);
    const [x, y] = a;
    const sin: Pair = [bin('*', call('sin', x), call('cosh', y)), bin('*', call('cos', x), call('sinh', y))];
    const cos: Pair = [bin('*', call('cos', x), call('cosh', y)), neg(bin('*', call('sin', x), call('sinh', y)))];
    const sinh: Pair = [bin('*', call('sinh', x), call('cos', y)), bin('*', call('cosh', x), call('sin', y))];
    const cosh: Pair = [bin('*', call('cosh', x), call('cos', y)), bin('*', call('sinh', x), call('sin', y))];
    switch (e.name) {
      case 're': return [x, num(0)];
      case 'im': return [y, num(0)];
      case 'abs': return [call('sqrt', norm2(a)), num(0)];
      case 'arg': return [call('atan2', y, x), num(0)];
      case 'conj': return [x, neg(y)];
      case 'exp': return exp(a);
      case 'ln': return ln(a);
      case 'log': return ln(a).map(c => bin('/', c, call('ln', num(10)))) as Pair;
      case 'sqrt': {
        const radius = call('sqrt', norm2(a));
        const re = call('sqrt', bin('/', bin('+', radius, x), num(2)));
        const im = call('sqrt', bin('/', bin('-', radius, x), num(2)));
        return [re, { kind: 'piecewise', cases: [{ cond: { kind: 'ineq', op: '<', l: y, r: num(0) }, value: neg(im) }], otherwise: im }];
      }
      case 'sin': return sin;
      case 'cos': return cos;
      case 'tan': return div(sin, cos);
      case 'sinh': return sinh;
      case 'cosh': return cosh;
      case 'tanh': return div(sinh, cosh);
    }
  }
  throw new Error('This complex expression cannot be evaluated as a point or root system.');
}
