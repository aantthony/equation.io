import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { definitionHead, scanDefinition } from './defs.ts';

const infos = (rows: string[]) => {
  const a = analyzeRows(rows);
  expect(a.rows.map(r => r.error)).toEqual(rows.map(() => undefined));
  return a.rows.map(r => r.info);
};

describe('explicit definitions (:=)', () => {
  it('defines ordinary names as = does', () => {
    expect(scanDefinition('a := 2')).toEqual({ kind: 'const', name: 'a', rhs: ' 2' });
    expect(scanDefinition('f(x) := x^2')).toEqual({ kind: 'fn', name: 'f', params: ['x'], rhs: ' x^2' });
    expect(scanDefinition("a' := -a")?.kind).toBe('state');
    expect(scanDefinition('a(0) := 1')?.kind).toBe('init');
    expect(infos(['f(x) := x^2', 'a := 2', 'f(a) + 1'])[2]).toBe('= 5');
  });

  it('redefines e, pi, i and w for the whole graph', () => {
    expect(infos(['e := 0.6', 'e', '2e', 'exp(1)'])).toEqual([undefined, '= 0.6', '= 1.2', '≈ 2.71828']);
    expect(infos(['e := sin(32)', 'e'])[1]).toBe('≈ 0.551427');
    expect(infos(['pi := 3', 'pi', 'π'])).toEqual([undefined, '= 3', '= 3']);
    // A real field now, not a complex one.
    expect(infos(['i := 3', 'i x'])[1]).toBe('scalar field — for the curve write y = i x');
    expect(infos(['i := 3', 'i + 1'])[1]).toBe('= 4');
    expect(infos(['w := 2', 'w^2'])[1]).toBe('= 4');
    // Rows before the definition see it too, and so do other definitions.
    expect(infos(['b := e^2', 'b', 'e := 2'])[1]).toBe('= 4');
  });

  it('draws with a redefined name on both backends', () => {
    for (const rows of [
      ['e := 0.6', 'y = e x'],
      ['i := 2', 'y = i x'],
      ['w := x - y', 'w = 0'],
    ]) {
      const plot = analyzeRows(rows).rows[1];
      expect(plot.error, rows.join('; ')).toBeUndefined();
      expect(plot.cls?.object.kind, rows.join('; ')).toBe('curve');
      expect(plot.gpu, rows.join('; ')).toBeDefined();
    }
  });

  it('leaves = rows meaning what they meant', () => {
    const [e] = analyzeRows(['e = 0.6']).rows;
    expect(e.def).toBeUndefined();
    expect(e.info).toBe('Never true (2.71828 ≠ 0.6) — e is a constant; to redefine it, write e := …');
    // Once e is the graph's own, `e = …` is a claim about it, with no advice.
    expect(infos(['e := 1', 'e = 2'])[1]).toBe('False now (1 ≠ 2)');
  });

  it('keeps x, y, z, t and d, and says why', () => {
    const error = (row: string) => analyzeRows([row]).rows[0].error;
    expect(error('x := 3')).toBe(
      "x cannot be redefined: x is a plot axis. A function's parameters may still be called x, like f(x) := x^2.",
    );
    expect(error('t := 1')).toBe('t cannot be redefined: t is animation time.');
    expect(error('d := 3')).toBe('d cannot be redefined: d starts derivatives (d/dx).');
    expect(error('sin := 3')).toBe('sin cannot be redefined: sin is a built-in function.');
    expect(error('2 := 3')).toBe('The left side of := names what it defines, like a := 2 or f(x) := x^2.');
  });

  it('redefines u and v as intervals', () => {
    expect(analyzeRows(['u := interval(0, 2pi)']).rows[0].def?.kind).toBe('const');
    // The same range `u = interval(…)` sets.
    const curve = (op: string) => analyzeRows([`u ${op} interval(0, 2pi)`, '(cos(u), sin(u))']).rows[1];
    expect(curve(':=').error).toBeUndefined();
    expect(JSON.stringify(curve(':=').cls)).toBe(JSON.stringify(curve('=').cls));
    expect(analyzeRows(['u := 3']).rows[0].error).toBe(
      'u is a curve/surface parameter, so it is redefined as the interval it runs over, like u := interval(0, 2pi).',
    );
  });

  it('names a redefined built-in as written in messages and write-backs', () => {
    const a = analyzeRows(['e := 0.6', 'e := 2']);
    expect(a.rows[1].error).toBe('e is already defined.');
    const def = a.rows[0].def!;
    expect(definitionHead(def, 'e := 0.6')).toBe('e :=');
    expect(definitionHead({ kind: 'init', name: 'a', rhs: '1' }, 'a(0) = 1')).toBe('a(0) =');
  });
});
