import { describe, expect, it } from 'vitest';
import { TypeEvents } from './type-events.ts';

const row = (text: string, type?: string) => ({ text, type });

describe('TypeEvents', () => {
  it('reports each type the first time a document draws it', () => {
    const t = new TypeEvents();
    t.note([row('y = x^2', 'implicit2d')]);
    t.note([row('y = x^2', 'implicit2d'), row('y = x^3', 'implicit2d'), row('a = 2')]);
    t.note([row('y = x^2', 'implicit2d'), row('x^2 + y^2 + z^2 = 1', 'implicit3d')]);
    expect(t.take()).toEqual(['implicit2d', 'implicit3d']);
    expect(t.take()).toEqual([]);
  });

  it("ignores an example's rows until they are edited", () => {
    const t = new TypeEvents();
    t.opened(['x^2 + y^2 + z^2 = 1', 'y = sin(x)']);
    t.note([row('x^2 + y^2 + z^2 = 1', 'implicit3d'), row('y = sin(x)', 'implicit2d')]);
    expect(t.take()).toEqual([]);
    // Editing one row makes it the visitor's; the other is still the example's.
    t.note([row('x^2 + y^2 + z^2 = 4', 'implicit3d'), row('y = sin(x)', 'implicit2d')]);
    expect(t.take()).toEqual(['implicit3d']);
    // A row of their own counts even when an example row has the same type.
    t.note([row('x^2 + y^2 + z^2 = 4', 'implicit3d'), row('y = sin(x)', 'implicit2d'), row('y = x', 'implicit2d')]);
    expect(t.take()).toEqual(['implicit2d']);
  });

  it('starts over when an example opens', () => {
    const t = new TypeEvents();
    t.note([row('y = x', 'implicit2d')]);
    t.opened(['r = theta']);
    t.note([row('r = theta', 'implicit2d'), row('y = 2x', 'implicit2d')]);
    expect(t.take()).toEqual(['implicit2d', 'implicit2d']);
  });

  it('starts over when the document is emptied', () => {
    const t = new TypeEvents();
    t.opened(['y = sin(x)']);
    t.note([row('y = x', 'implicit2d')]);
    t.note([row('')]);
    // Emptying also forgets the example, so retyping its row is the visitor's.
    t.note([row('y = sin(x)', 'implicit2d')]);
    expect(t.take()).toEqual(['implicit2d', 'implicit2d']);
  });
});
