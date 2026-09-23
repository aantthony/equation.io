import { describe, expect, it } from 'vitest';
import { type Expr, childrenOf, evaluate, exprKey, freeVars, legacyCallArgs, mapChildren, markOrigins, originOf, parseExpr, sameList, substVars } from './expr.ts';
import { axesOf, withAxes } from './list.ts';
import { countNodes, exceedsNodes } from './size.ts';
import { resolveExpr } from './defs.ts';

const num = (value: number): Expr => ({ kind: 'num', value });
const variable = (name: string): Expr => ({ kind: 'var', name });

describe('structural expression traversal', () => {
  it('maps one level, reuses unchanged nodes and preserves list metadata', () => {
    const leaf = variable('a');
    const expression: Expr = { kind: 'list', items: [{ kind: 'neg', a: leaf }] };
    markOrigins(expression);
    const axes = [{ id: 'L', n: 1 }];
    withAxes(expression, axes);
    const seen: Expr[] = [];
    expect(mapChildren(expression, child => { seen.push(child); return child; })).toBe(expression);
    expect(seen).toEqual(expression.items);
    const changed = mapChildren(expression, () => num(2));
    expect(changed).toMatchObject({ kind: 'list', items: [num(2)], origin: originOf(expression) });
    expect(changed.axes).toBe(axes);
    expect(leaf).toEqual(variable('a'));
  });

  it('keeps absent axes absent through cloning and ignores identity in keys and budgets', () => {
    const expression: Expr = { kind: 'list', items: [variable('a'), num(2)] };
    const key = exprKey(expression), size = countNodes(expression);
    markOrigins(expression);
    const clone = substVars(expression, { a: num(1) });
    expect(clone.axes).toBeUndefined();
    expect(originOf(clone)).toBe(originOf(expression));
    withAxes(expression, Array.from({ length: 100 }, (_, n) => ({ id: String(n), n: 1 })));
    expect(exprKey(expression)).toBe(key);
    expect(countNodes(expression)).toBe(size);
    expect(exceedsNodes(expression, size)).toBe(false);
    expect(exceedsNodes(expression, size - 1)).toBe(true);
    const absent: Expr = { kind: 'list', items: [num(1)] };
    expect(sameList(absent, { ...absent }).axes).toBeUndefined();
    expect(axesOf(absent)).toHaveLength(1);
  });

  it('treats packed histogram arrays as leaves without copying', () => {
    const centers = Float64Array.of(1, 2), counts = Float64Array.of(4, 5);
    const hist: Expr = { kind: 'hist', centers, counts, width: 1 };
    expect(childrenOf(hist)).toEqual([]);
    expect(mapChildren(hist, () => { throw new Error('packed data traversed'); })).toBe(hist);
    expect(hist.centers).toBe(centers);
    const projection: Expr = { kind: 'comp', value: variable('P'), index: 0, arity: 2, functionName: 'f' };
    expect(childrenOf(projection)).toEqual([variable('P')]);
    expect([...freeVars(projection)]).toEqual(['P']);
    expect(substVars(projection, { P: variable('Q') })).toEqual({ ...projection, value: variable('Q') });
  });

  it('substitutes outer bounds while respecting reused sum indices and private integral symbols', () => {
    const inner: Expr = { kind: 'call', name: 'sum', args: [variable('n'), num(1), variable('n'), variable('n')] };
    const sum: Expr = { kind: 'call', name: 'sum', args: [variable('n'), num(1), variable('N'), inner] };
    expect([...freeVars(sum)]).toEqual(['N']);
    const result = substVars(sum, { n: num(99), N: num(3) });
    expect(evaluate(result, {})).toBe(10);
    expect(substVars(variable('[dx]'), { x: num(2) })).toEqual(variable('[dx]'));
  });
});

describe('tuple syntax and explicit syntax nodes', () => {
  it('preserves grouping until call normalization, including tuples in multiple positions', () => {
    const expression = parseExpr('max((1,2),3)');
    expect(expression).toMatchObject({ kind: 'call', name: 'max', args: [{ kind: 'vec', items: [num(1), num(2)] }, num(3)] });
    expect(evaluate(resolveExpr(expression, () => undefined), {})).toBe(3);
    expect(legacyCallArgs('atan2', [variable('A')])).toEqual([variable('A')]);
    expect(evaluate(resolveExpr(parseExpr('sin((0,2))'), () => undefined), {})).toBe(0);
  });

  it('makes ranges, equality tests and indexing structural syntax', () => {
    expect(parseExpr('L[L!=2]', undefined, new Set(['L']))).toMatchObject({ kind: 'index', args: [variable('L'), { kind: 'eqtest', op: '!=' }] });
    expect(parseExpr('[1..3]')).toMatchObject({ kind: 'list', items: [{ kind: 'range', args: [num(1), num(3)] }] });
  });
});
