import { describe, expect, it } from 'vitest';
import { readReference } from '../scripts/reference.ts';
import { CHARTED_GROUPS, KIND_CHART, instructions } from './assistant-instructions.ts';
import { checkRows } from './assistant-tools.ts';
import { kindNames } from './reference.ts';

/** An instance of each chart line: its rows, and the kind check gives the last. */
const INSTANCES: [string, string[], string][] = [
  ['slider: a = 0', ['a = 0', 'y = a x'], 'implicit2d'],
  ['family: a = [1..5]', ['a = [1..5]', 'y = a x'], 'family'],
  ['motion: t is seconds', ['y = sin(x - t)'], 'implicit2d'],
  // 2D
  ['point: (0, 0)', ['(1, 2)'], 'point'],
  ['named, draggable: A = (0, 0)', ['A = (1, 2)'], 'definition (point)'],
  ['label: label((0, 0), "text")', ['label((1, 2), "text")'], 'label'],
  ['implicit2d: xy = 0', ['y = x^2'], 'implicit2d'],
  ['circle((0, 0), 1) is one too', ['circle((0, 0), 1)'], 'implicit2d'],
  ['ineq2d: xy > 0', ['x^2 + y^2 < 4'], 'ineq2d'],
  ['xy >= 0', ['x^2 + y^2 >= 4'], 'ineq2d'],
  ['pcurve: (u, u)', ['(cos(2pi u), sin(2pi u))'], 'pcurve'],
  ['pregion: (uv, uv)', ['(u cos(2pi v), u sin(2pi v))'], 'pregion'],
  ['system: (xy, xy) = (0, 0)', ['(x + y, x - y) = (1, 0)'], 'system'],
  ['trail: trail(A)', ['A = (cos(t), sin(t))', 'trail(A)'], 'trail'],
  ['scalar2d: xy', ['sin(x)cos(y)'], 'scalar2d'],
  ['vfield2d: (xy, xy)', ['(y, -x)'], 'vfield2d'],
  // 3D
  ['point: (0, 0, 0)', ['(1, 2, 3)'], 'point'],
  ['implicit3d: xyz = 0', ['x^2 + y^2 + z^2 = 1'], 'implicit3d'],
  ['pcurve: (u, u, u)', ['(cos(2pi u), sin(2pi u), u)'], 'pcurve'],
  ['psurface: (uv, uv, uv)', ['(u, v, u v)'], 'psurface'],
  ['solid: (uvs, uvs, uvs)', ['s = interval(0, 1)', '(u, v, s)'], 'solid'],
  ['scalar3d: xyz', ['x y z'], 'scalar3d'],
  ['vfield3d: (xyz, xyz, xyz)', ['(y, -x, z)'], 'vfield3d'],
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
    const [slider] = checkRows(['a = 0', 'y = a x']);
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
