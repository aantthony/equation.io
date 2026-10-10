import { describe, expect, it } from 'vitest';
import { readReference } from '../scripts/reference.ts';
import { CHARTED_GROUPS, KIND_CHART, instructions } from './assistant-instructions.ts';
import { checkRows } from './assistant-tools.ts';
import { kindNames } from './reference.ts';

/** An instance of each chart line: its rows, and the kind check gives the last. */
const INSTANCES: [string, string[], string][] = [
  ['slider: a = 2', ['a = 2', 'y = a x'], 'implicit2d'],
  ['family: a = [1..5]', ['a = [1..5]', 'y = a x'], 'family'],
  ['motion: t is seconds', ['y = sin(x - t)'], 'implicit2d'],
  // 2D
  ['point: (1, 2)', ['(1, 2)'], 'point'],
  ['named, draggable: A = (1, 2)', ['A = (1, 2)'], 'definition (point)'],
  ['label: label((1, 2), "text")', ['label((1, 2), "text")'], 'label'],
  ['implicit2d, an equation in x and y: x + y = 1', ['x + y = 1'], 'implicit2d'],
  ['circle((2, 1), 3) is one too', ['circle((2, 1), 3)'], 'implicit2d'],
  ['ineq2d, an inequality in x and y: y > x + 1', ['y > x + 1'], 'ineq2d'],
  ['pcurve: (u, u^2)', ['(u, u^2)'], 'pcurve'],
  ['pregion: (u, v u)', ['(u, v u)'], 'pregion'],
  ['system: (x + y, x - y) = (1, 0)', ['(x + y, x - y) = (1, 0)'], 'system'],
  ['trail: trail(A)', ['A = (cos(t), sin(t))', 'trail(A)'], 'trail'],
  ['scalar2d, an expression in x and y alone: x y', ['x y'], 'scalar2d'],
  ['vfield2d, a pair of expressions in x and y: (y, x)', ['(y, x)'], 'vfield2d'],
  // 3D
  ['point: (1, 2, 3)', ['(1, 2, 3)'], 'point'],
  ['implicit3d, an equation in x, y and z: x + y + z = 1', ['x + y + z = 1'], 'implicit3d'],
  ['pcurve: (u, u^2, u^3)', ['(u, u^2, u^3)'], 'pcurve'],
  ['psurface: (u, v, u v)', ['(u, v, u v)'], 'psurface'],
  ['solid: (u, v, s u) with s = interval(0, 1)', ['s = interval(0, 1)', '(u, v, s u)'], 'solid'],
  ['scalar3d, an expression in x, y and z alone: x y z', ['x y z'], 'scalar3d'],
  ['vfield3d, three expressions in x, y and z: (y, z, x)', ['(y, z, x)'], 'vfield3d'],
];

describe('the kind chart', () => {
  it('draws each line as the kind it names, with no error', () => {
    for (const [line, rows, kind] of INSTANCES) {
      expect(KIND_CHART, line).toContain(line);
      const checked = checkRows(rows);
      expect(
        checked.map(r => r.error),
        line,
      ).toEqual(checked.map(() => undefined));
      expect(checked.at(-1)!.kind, line).toBe(kind);
    }
    const [slider] = checkRows(['a = 2', 'y = a x']);
    expect(slider.meaning).toContain('slider');
    expect(checkRows(['a = [1..33]', 'y = a x'])[1].error).toContain('1–32');
    expect(checkRows(['y = sin(x - t)'])[0].meaning).toContain('moves with time t');
  });

  it('says which 2D kinds a 3D graph leaves out', () => {
    for (const [, rows, kind] of INSTANCES.slice(3, 16)) {
      const warning = checkRows(['(1, 2, 3)', ...rows]).at(-1)!.warning;
      if (['ineq2d', 'scalar2d', 'vfield2d'].includes(kind)) expect(warning, kind).toContain('not drawn');
      else expect(warning, kind).toBeUndefined();
    }
  });

  it('covers the charted groups, and names the rest', () => {
    const ref = readReference();
    const groups = ref.groups.map(g => g.name);
    for (const name of CHARTED_GROUPS) expect(groups).toContain(name);
    const text = instructions('text', kindNames(ref, CHARTED_GROUPS));
    expect(text).toContain(`${KIND_CHART}\n\nOther kinds (names only):\n- Sequences and simulations: sequence,`);
    for (const name of groups) expect(text.includes(`- ${name}: `), name).toBe(!CHARTED_GROUPS.includes(name));
  });
});
