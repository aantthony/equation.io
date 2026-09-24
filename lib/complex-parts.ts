/** Real expression components for CPU solving and point rendering. */
import { type Expr, RECUR, childrenOf, isRecur } from './expr.ts';
import { usesComplex, inferScalarType, loopTypes, type ScalarType } from './complex.ts';
import { num, bin, call } from './coordinate.ts';
import { add as realAdd, mul as realMul, pow } from './diff.ts';
import { countNodes } from './size.ts';
type Pair = [Expr, Expr];
const add = (a: Pair, b: Pair): Pair => [bin('+', a[0], b[0]), bin('+', a[1], b[1])];
const mul = (a: Pair, b: Pair): Pair => [
  bin('-', bin('*', a[0], b[0]), bin('*', a[1], b[1])),
  bin('+', bin('*', a[0], b[1]), bin('*', a[1], b[0])),
];
const neg = (a: Expr) => bin('*', num(-1), a);
const norm2 = (a: Pair) => bin('+', bin('^', a[0], num(2)), bin('^', a[1], num(2)));
const div = (a: Pair, b: Pair): Pair => mul(a, [b[0], neg(b[1])]).map(c => bin('/', c, norm2(b))) as Pair;
const exp = (a: Pair): Pair => [
  bin('*', call('exp', a[0]), call('cos', a[1])),
  bin('*', call('exp', a[0]), call('sin', a[1])),
];
const ln = (a: Pair): Pair => [bin('/', call('ln', norm2(a)), num(2)), call('atan2', a[1], a[0])];

function hasProjection(e: Expr): boolean {
  if (e.kind === 'call') return ['re', 'im', 'conj', 'arg'].includes(e.name) || e.args.some(hasProjection);
  if (e.kind === 'bin') return hasProjection(e.a) || hasProjection(e.b);
  if (e.kind === 'neg') return hasProjection(e.a);
  if (e.kind === 'eq' || e.kind === 'ineq') return hasProjection(e.l) || hasProjection(e.r);
  if (e.kind === 'piecewise')
    return (
      e.cases.some(c => hasProjection(c.cond) || hasProjection(c.value)) ||
      (!!e.otherwise && hasProjection(e.otherwise))
    );
  if (e.kind === 'loop') return childrenOf(e).some(hasProjection);
  return false;
}

/** Complex variables bound by an enclosing loop, as their two real parts. */
type ComplexVars = ReadonlyMap<string, Pair>;
const typesOf = (vars: ComplexVars): Record<string, ScalarType> =>
  Object.fromEntries([...vars.keys()].map(k => [k, 'complex']));

/** Thrown when a split outgrows its budget; callers word it for their row. */
export class SplitTooLarge extends Error {}

/**
 * The real and imaginary parts of `e`. Splitting duplicates subterms — every
 * complex product uses both parts of both factors — so a nested product
 * grows geometrically. With a `budget` (in nodes, shared subtrees counted per
 * use) the split stops with SplitTooLarge at the first subterm past it,
 * having built only that far.
 */
export function complexParts(
  e: Expr,
  budget = Infinity,
  sizes = new WeakMap<object, number>(),
  vars: ComplexVars = new Map(),
): Pair {
  const parts = splitParts(e, (a, scope = vars) => complexParts(a, budget, sizes, scope), vars);
  if (budget < Infinity && countNodes(parts[0], sizes) + countNodes(parts[1], sizes) > budget)
    throw new SplitTooLarge();
  return parts;
}

function splitParts(e: Expr, complexParts: (e: Expr, vars?: ComplexVars) => Pair, vars: ComplexVars): Pair {
  const complexNames = new Set(vars.keys());
  if (!usesComplex(e, complexNames) && !hasProjection(e)) return [e, num(0)];
  if (e.kind === 'var')
    return (
      vars.get(e.name) ??
      (e.name === 'i'
        ? [num(0), num(1)]
        : [
            { kind: 'var', name: 'x' },
            { kind: 'var', name: 'y' },
          ])
    );
  if (e.kind === 'neg') return complexParts(e.a).map(neg) as Pair;
  if (e.kind === 'eq' || e.kind === 'ineq') return [{ ...e, l: complexParts(e.l)[0], r: complexParts(e.r)[0] }, num(0)];
  if (e.kind === 'piecewise') {
    const type = inferScalarType(e, typesOf(vars)); // Keep the shader's typing rules (real conditions).
    const cases = e.cases.map(c => ({ cond: complexParts(c.cond)[0], value: complexParts(c.value) }));
    const otherwise = e.otherwise && complexParts(e.otherwise);
    const part = (k: 0 | 1): Expr => ({
      ...e,
      cases: cases.map(c => ({ cond: c.cond, value: c.value[k] })),
      ...(otherwise ? { otherwise: otherwise[k] } : {}),
    });
    return [part(0), type === 'complex' ? part(1) : num(0)];
  }
  if (e.kind === 'loop') return splitLoop(e, complexParts, vars);
  if (e.kind === 'bin') {
    const a = complexParts(e.a),
      b = complexParts(e.b);
    if (inferScalarType(e, typesOf(vars)) === 'real') return [bin(e.op, a[0], b[0]), num(0)];
    switch (e.op) {
      case '+':
        return add(a, b);
      case '-':
        return add(a, b.map(neg) as Pair);
      case '*':
        return mul(a, b);
      case '/':
        return div(a, b);
      case '^': {
        if (e.b.kind === 'num' && Number.isInteger(e.b.value) && Math.abs(e.b.value) <= 16) {
          // Binomial terms keep the evaluated tree linear in n; repeated
          // complex multiplication duplicates both previous component trees.
          const n = Math.abs(e.b.value);
          const p: Pair = [num(0), num(0)];
          let coefficient = 1;
          for (let k = 0; k <= n; k++) {
            const term = realMul(
              num(k % 4 < 2 ? coefficient : -coefficient),
              realMul(pow(a[0], num(n - k)), pow(a[1], num(k))),
            );
            p[k % 2] = realAdd(p[k % 2], term);
            coefficient = (coefficient * (n - k)) / (k + 1);
          }
          return e.b.value < 0 ? div([num(1), num(0)], p) : p;
        }
        return exp(mul(b, ln(a)));
      }
    }
  }
  if (e.kind === 'call') {
    const type = inferScalarType(e, typesOf(vars)); // Keep function support and arity consistent with the shader.
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
      case 're':
        return [x, num(0)];
      case 'im':
        return [y, num(0)];
      case 'abs':
        return [call('sqrt', norm2(a)), num(0)];
      case 'arg':
        return [call('atan2', y, x), num(0)];
      case 'conj':
        return [x, neg(y)];
      case 'exp':
        return exp(a);
      case 'ln':
        return ln(a);
      case 'log':
        return ln(a).map(c => bin('/', c, call('ln', num(10)))) as Pair;
      case 'sqrt': {
        const radius = call('sqrt', norm2(a));
        const re = call('sqrt', bin('/', bin('+', radius, x), num(2)));
        const im = call('sqrt', bin('/', bin('-', radius, x), num(2)));
        const signedIm: Expr = {
          kind: 'piecewise',
          cases: [{ cond: { kind: 'ineq', op: '<', l: y, r: num(0) }, value: neg(im) }],
          otherwise: im,
        };
        const positive: Expr = { kind: 'ineq', op: '>', l: x, r: num(0) };
        const zero: Expr = { kind: 'ineq', op: '<=', l: radius, r: num(0) };
        // Compute the smaller component from 2 re im = y, avoiding
        // cancellation in radius ± x and singular derivatives on the axes.
        return [
          {
            kind: 'piecewise',
            cases: [
              { cond: zero, value: num(0) },
              { cond: positive, value: re },
            ],
            otherwise: bin('/', y, bin('*', num(2), signedIm)),
          },
          {
            kind: 'piecewise',
            cases: [
              { cond: zero, value: num(0) },
              { cond: positive, value: bin('/', y, bin('*', num(2), re)) },
            ],
            otherwise: signedIm,
          },
        ];
      }
      case 'sin':
        return sin;
      case 'cos':
        return cos;
      case 'tan':
        return div(sin, cos);
      case 'sinh':
        return sinh;
      case 'cosh':
        return cosh;
      case 'tanh':
        return div(sinh, cosh);
    }
  }
  throw new Error('This complex expression cannot be evaluated as a point or root system.');
}

/**
 * A loop over complex state becomes a loop over twice as many real params:
 * each complex param `p` is carried as `p.re` and `p.im` (names no row can
 * spell), bound to that pair while its body splits. A complex result is two
 * loops, one per part, which run the same passes.
 */
function splitLoop(e: Expr & { kind: 'loop' }, split: (e: Expr, vars: ComplexVars) => Pair, vars: ComplexVars): Pair {
  const { params: types, result } = loopTypes(e, typesOf(vars));
  const inner = new Map(vars);
  const params: string[] = [];
  e.params.forEach((p, k) => {
    if (types[k] === 'real') {
      inner.delete(p);
      params.push(p);
      return;
    }
    inner.set(p, [
      { kind: 'var', name: `${p}.re` },
      { kind: 'var', name: `${p}.im` },
    ]);
    params.push(`${p}.re`, `${p}.im`);
  });
  const flatten = (args: readonly Expr[], scope: ComplexVars): Expr[] =>
    args.flatMap((a, k) => {
      const parts = split(a, scope);
      return types[k] === 'real' ? [parts[0]] : parts;
    });
  const seeds = flatten(e.seeds, vars);
  const body = (part: 0 | 1): Expr => {
    const rebuild = (node: Expr): Expr => {
      if (isRecur(node)) return { kind: 'call', name: RECUR, args: flatten(node.args, inner) };
      if (node.kind !== 'piecewise') return split(node, inner)[part];
      return {
        ...node,
        cases: node.cases.map(c => ({ cond: split(c.cond, inner)[0], value: rebuild(c.value) })),
        ...(node.otherwise ? { otherwise: rebuild(node.otherwise) } : {}),
      };
    };
    return { kind: 'loop', params, seeds, body: rebuild(e.body), limit: e.limit };
  };
  return [body(0), result === 'complex' ? body(1) : num(0)];
}
