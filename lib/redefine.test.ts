import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { definitionHead, scanDefinition } from './defs.ts';
import { runtimeSliderNames } from './runtime-sliders.ts';
import { dragAxes } from './drag.ts';
import { boundIn } from './env.ts';
import { describeName } from './highlight.ts';
import { sliderBounds, sliderForm } from './slider.ts';

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
    expect(infos(['t := 2', 't^2', 'b := t + 1', 'b'])).toEqual([undefined, '= 4', undefined, '= 3']);
    // Rows before the definition see it too, and so do other definitions.
    expect(infos(['b := e^2', 'b', 'e := 2'])[1]).toBe('= 4');
  });

  it('draws with a redefined name on both backends', () => {
    for (const rows of [
      ['e := 0.6', 'y = e x'],
      ['i := 2', 'y = i x'],
      ['w := x - y', 'w = 0'],
      ['t := 0.5', 'y = sin(x + t)'],
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
    expect(e.info).toBe(
      'Never true (2.71828 ≠ 0.6) — e is a constant; name a slider something else, like k (e := … replaces e across the whole graph)',
    );
    // Once e is the graph's own, `e = …` is a claim about it, with no advice.
    expect(infos(['e := 1', 'e = 2'])[1]).toBe('False now (1 ≠ 2)');
  });

  it('keeps x, y, z and d, and says why', () => {
    const error = (row: string) => analyzeRows([row]).rows[0].error;
    expect(error('x := 3')).toBe(
      "x cannot be redefined: x is a plot axis. A function's parameters may still be called x, like f(x) := x^2.",
    );
    expect(error('d := 3')).toBe('d cannot be redefined: d starts derivatives (d/dx).');
    expect(error('sin := 3')).toBe('sin cannot be redefined: sin is a built-in function.');
    expect(error('2 := 3')).toBe('The left side of := names what it defines, like a := 2 or f(x) := x^2.');
  });

  it('redefines e, pi, i, w and t only as values', () => {
    // `e(2)` multiplies wherever e is not the document's value, so a function
    // named e would never be called.
    for (const n of ['e', 'pi', 'i', 'w', 't']) {
      expect(analyzeRows([`${n}(x) := x^2`]).rows[0].error, n).toBe(
        `${n} can be redefined as a value, not a function.`,
      );
    }
    // Parameters may still take the names.
    expect(infos(['f(e) := e^2', 'f(3)'])[1]).toBe('= 9');
  });

  it('says a function defined twice with := is already defined', () => {
    // Not a level set of f, as a second `f(x) = …` row would be.
    for (const first of ['f(x) := x^2', 'f(x) = x^2']) {
      expect(analyzeRows([first, 'f(x) := x^3']).rows[1].error, first).toBe('f is already defined.');
    }
  });

  it('holds time still when t is redefined', () => {
    // t is the graph's slider, not the clock: nothing reads time any more.
    const a = analyzeRows(['t := 0.5', 'y = sin(x + t)', "a' := -a", 'a(0) := 1']);
    expect(a.rows.map(r => r.error)).toEqual([undefined, undefined, undefined, undefined]);
    expect(a.defs.consts.has('#t')).toBe(true);
    // `t = 3` almost always meant a constant: the advice is k, not freezing time.
    expect(analyzeRows(['t = 3']).rows[0].error).not.toMatch(/:=/);
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

  it('reads := as a token, so text holding one is text', () => {
    for (const row of ['label((0, 0), "a := b")', '(0, 0) "a := b"']) {
      expect(analyzeRows([row]).rows[0].error, row).toBeUndefined();
      expect(scanDefinition(row), row).toBeNull();
    }
    // A bare text row is what any text row is.
    expect(analyzeRows(['"a := b"']).rows[0].error).toBe(analyzeRows(['"a b"']).rows[0].error);
    expect(analyzeRows(['a := "x := y"']).rows[0].def?.kind).toBe('const');
    expect(analyzeRows(['y = 1 + (a := 2)']).rows[0].error).toBe(
      ':= defines a name, at the start of a row of its own, like a := 2.',
    );
  });

  it('writes every row shape with :=', () => {
    // A random variable derived from another.
    expect(infos(['X ~ Normal(0, 1)', 'Y := 2X', 'P(Y > 0)'])[2]).toMatch(/^≈ 0\.5/);
    // Sequences and recurrences.
    expect(infos(['a_n := n^2', 'a_3'])[1]).toBe('= 9');
    expect(infos(['b_0 := 1', 'b_{n+1} := 2 b_n', 'b_4'])[2]).toBe('= 16');
    // A data file's malformed hash is explained as with =.
    expect(analyzeRows(['data := open("x.csv", ab12)']).rows[0].error).toMatch(/^A data file's hash is/);
  });

  it('scopes a parameter named after a built-in to its function', () => {
    expect(infos(['f(e) := e^2', 'f(3)'])[1]).toBe('= 9');
    expect(infos(['g(i) := i + 1', 'g(2)'])[1]).toBe('= 3');
    // Outside the function, e is Euler's.
    expect(infos(['f(e) := e^2', 'e'])[1]).toBe('≈ 2.71828');
  });

  it('reads a redefined name everywhere the document parses', () => {
    // Random variables see the document's e.
    expect(infos(['e := 2', 'X ~ Normal(e, 1)', 'E(X)'])[2]).toBe(infos(['a := 2', 'X ~ Normal(a, 1)', 'E(X)'])[2]);
    // A slider whose value another definition reads is not a runtime-only one.
    expect([...runtimeSliderNames(analyzeRows(['e := 0.6', 'b := e^2', 'y = b x']))]).toEqual([]);
    expect([...runtimeSliderNames(analyzeRows(['e := 0.6', 'y = e x']))]).toEqual(['#e']);
  });

  it('explains a redefined name whose own definition failed', () => {
    const a = analyzeRows(['e := sin(', 'y = e x']);
    expect(a.rows[0].error).toBeDefined();
    expect(a.rows[1].error).toBe('e has an error in its definition.');
  });

  it('reports a binder on a redefined name as a second definition', () => {
    expect(analyzeRows(['i := 3', 'i ∈ [1..3]']).rows[1].error).toBe('i is already defined.');
    expect(analyzeRows(['i ∈ [1..3]']).rows[0].error).toMatch(/^i is taken by the language/);
  });

  it('reads a redefined name in sequences, views and slider bounds', () => {
    expect(infos(['e := 2', 'a_n := e n', 'a_3'])[2]).toBe('= 6');
    const view = analyzeRows(['pi := 3', 'view(x = -pi..pi)']).rows[1].view;
    expect(view?.kind === 'view' && view.x).toEqual([-3, 3]);
    const a = analyzeRows(['pi := 3', 'a := clamp(1, 0, pi)']);
    const form = sliderForm(a.rows[1].def!.rhs)!;
    expect(sliderBounds(form, { '#pi': 3 }, new Set(), a.document.valueNames)).toEqual([0, 3]);
  });

  it('finds a redefined name from its written spelling', () => {
    const { defs } = analyzeRows(['e := 0.6', 'y = e x']);
    expect(boundIn(defs, 'e')).toBe('#e');
    expect(boundIn(defs, 'pi')).toBe('pi');
    // Hover says it is the document's number, and jumps to its row.
    expect(describeName('e', defs)).toMatchObject({ signature: 'e', type: 'number', defined: '#e' });
    // A point at (e, 1) drags e's slider.
    const drag = dragAxes(
      '(e, 1)',
      name => (name === '#e' ? 'slider' : null),
      new Set(),
      n => boundIn(defs, n),
    );
    expect(drag?.axes).toEqual(['slider', 'literal']);
  });
});
