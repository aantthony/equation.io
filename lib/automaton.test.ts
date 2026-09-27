import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { type CellGrid, cellShades, evalTable, runAutomaton, runBoard, tableShades } from './automaton.ts';
import { scanSeqRec, scanSequences } from './seq.ts';

const RULE = 'c_{n+1}[i] = mod(floor(r / 2^(4 c_n[i-1] + 2 c_n[i] + c_n[i+1])), 2)';

/** Rows 0..n of the automaton `rows` define, drawn from cell -half to half. */
function run(rows: string[], env: Record<string, number> = {}) {
  const analysis = analyzeRows(rows);
  const row = analysis.rows.find(r => r.cpu?.type === 'automaton');
  const bad = analysis.rows.find(r => r.error);
  if (bad) throw new Error(bad.error);
  if (row?.cpu?.type !== 'automaton') throw new Error('no automaton row');
  return runAutomaton(row.cpu, { ...analysis.constEnv, ...env });
}
const cell = (g: CellGrid, n: number, i: number) =>
  g.values[n * g.width + Math.max(0, Math.min(g.width - 1, i - g.x0))];
const picture = (g: CellGrid, rows: number, half: number) =>
  Array.from({ length: rows }, (_, n) =>
    Array.from({ length: 2 * half + 1 }, (_, k) => (cell(g, n, k - half) ? '#' : '.')).join(''),
  );

/** Rule `r` on an infinite zero background from a single 1, by definition:
 *  cells within n of the seed, and one background value beyond them. */
function reference(r: number, rows: number, half: number): string[] {
  const rule = (a: number, b: number, c: number) => (r >> (4 * a + 2 * b + c)) & 1;
  let row = new Map<number, number>([[0, 1]]);
  let background = 0;
  const out: string[] = [];
  for (let n = 0; n < rows; n++) {
    const at = (i: number) => row.get(i) ?? background;
    out.push(Array.from({ length: 2 * half + 1 }, (_, k) => (at(k - half) ? '#' : '.')).join(''));
    const next = new Map<number, number>();
    for (let i = -n - 1; i <= n + 1; i++) next.set(i, rule(at(i - 1), at(i), at(i + 1)));
    background = rule(background, background, background);
    row = next;
  }
  return out;
}

describe('scanning', () => {
  it('reads rule and seed rows', () => {
    expect(scanSeqRec('c_{n+1}[i] = c_n[i-1]')).toMatchObject({
      rec: true,
      name: 'c',
      index: 'n',
      cell: 'i',
      rhs: ' c_n[i-1]',
    });
    expect(scanSeqRec('c_(n+1)[j] = c_n[j]')).toMatchObject({ rec: true, name: 'c', index: 'n', cell: 'j' });
    expect(scanSeqRec('c_0[i] = mod(i, 2)')).toMatchObject({ seed: true, name: 'c', cell: 'i', rhs: ' mod(i, 2)' });
    expect(scanSeqRec('c_{0}[i] = 1')).toMatchObject({ seed: true, name: 'c' });
  });
});

describe('elementary rules', () => {
  it('rule 30 from a single cell', () => {
    const g = run(['r = 30', RULE]);
    expect(picture(g, 5, 5)).toEqual(['.....#.....', '....###....', '...##..#...', '..##.####..', '.##..#...#.']);
    expect(picture(g, 60, 70)).toEqual(reference(30, 60, 70));
  });

  it('every rule from a single cell matches the definition', () => {
    for (const r of [0, 1, 18, 45, 73, 90, 110, 150, 184, 255]) {
      const g = run(['r = 0', RULE], { r });
      expect(picture(g, 40, 50), `rule ${r}`).toEqual(reference(r, 40, 50));
    }
  });

  it('computes all 1000 steps, the last row still exact', () => {
    const g = run(['r = 30', RULE]);
    expect(g.rows).toBe(1001);
    // Row n of rule 30's left edge is always a 1 at i = -n.
    expect(cell(g, 1000, -1000)).toBe(1);
    expect(cell(g, 1000, -1001)).toBe(0);
  });

  it('a background that flips steps exactly, forever outward', () => {
    // Rule 1: 000 → 1, so the empty background turns full, then empty, …
    const g = run(['r = 1', RULE]);
    expect(cell(g, 1, -5000)).toBe(1);
    expect(cell(g, 1, 5000)).toBe(1);
    expect(cell(g, 2, 5000)).toBe(0);
    expect(picture(g, 30, 40)).toEqual(reference(1, 30, 40));
  });
});

describe('seeds and rules', () => {
  it('reads a seed row over i', () => {
    const g = run(['c_0[i] = {i < 0: 1, 0}', 'c_{n+1}[i] = c_n[i-1]']);
    // The step between the two backgrounds moves one cell right per row.
    expect(cell(g, 0, -1)).toBe(1);
    expect(cell(g, 0, 0)).toBe(0);
    expect(cell(g, 10, 9)).toBe(1);
    expect(cell(g, 10, 10)).toBe(0);
    expect(cell(g, 500, -3000)).toBe(1);
    expect(cell(g, 500, 3000)).toBe(0);
  });

  it('reaches further than one cell', () => {
    const g = run(['c_{n+1}[i] = mod(c_n[i-2] + c_n[i+2], 2)']);
    expect(picture(g, 3, 4)).toEqual(['....#....', '..#...#..', '#.......#']);
  });

  it('keeps many states and uses n', () => {
    const g = run(['c_{n+1}[i] = mod(c_n[i-1] + c_n[i] + c_n[i+1] + n, 3)']);
    expect([cell(g, 1, -1), cell(g, 1, 0), cell(g, 1, 1)]).toEqual([1, 1, 1]);
    expect([cell(g, 2, -2), cell(g, 2, 0), cell(g, 2, 3)]).toEqual([2, 1, 1]);
    const shades = cellShades(g);
    expect(shades[1 * g.width + (0 - g.x0)]).toBe(128);
    expect(shades[2 * g.width + (-2 - g.x0)]).toBe(255);
  });

  it('uses functions and sliders', () => {
    const g = run(['f(a, b, c) = mod(a + c, 2)', 'c_{n+1}[i] = f(c_n[i-1], c_n[i], c_n[i+1])']);
    expect(picture(g, 4, 3)).toEqual(['...#...', '..#.#..', '.#...#.', '#.#.#.#']);
  });
});

describe('diagnostics', () => {
  const errors = (rows: string[]) => analyzeRows(rows).rows.map(r => r.error ?? null);
  it('reports what a rule cannot read', () => {
    expect(errors(['c_{n+1}[i] = c_n[2 i]'])[0]).toMatch(/fixed offset/);
    expect(errors(['c_{n+1}[i] = c_n'])[0]).toMatch(/whole row/);
    expect(errors(['c_{n+1}[i] = c_n[i] + i'])[0]).toMatch(/same at every cell/);
    expect(errors(['c_{n+1}[i] = c_n[i] + q'])[0]).toMatch(/Unknown variable in the rule: q/);
  });
  it('a seed without a rule, and duplicates', () => {
    expect(errors(['c_0[i] = 1'])[0]).toMatch(/starts an automaton/);
    expect(errors(['c_{n+1}[i] = c_n[i]', 'c_{n+1}[i] = c_n[i-1]'])).toEqual([
      null,
      expect.stringMatching(/already defined/),
    ]);
    expect(errors(['c_n = 1/n', 'c_{n+1}[i] = c_n[i]'])[1]).toMatch(/already a sequence/);
  });
  it('the seed row draws nothing and reports its own errors', () => {
    const a = analyzeRows(['c_0[i] = {i < 0: 1, 0}', 'c_{n+1}[i] = c_n[i-1]']);
    expect(a.rows[0].cls).toBeUndefined();
    expect(a.rows[0].error).toBeUndefined();
    expect(a.rows[1].cls?.object.kind).toBe('automaton');
    const b = analyzeRows(['c_0[i] = q', 'c_{n+1}[i] = c_n[i-1]']);
    expect(b.rows[0].error).toMatch(/Unknown variable in the seed: q/);
    expect(b.rows[1].error).toBeUndefined();
  });
  it('rebuilds when a slider moves', () => {
    const a = analyzeRows(['r = 30', RULE]);
    expect(a.rows[1].cls?.params).toEqual(['r']);
  });
});

const LIFE = 'L_{n+1}[i, j] = life(L_n[i, j], sum(a=-1..1, sum(b=-1..1, L_n[i+a, j+b])))';
const LIFE_FN = 'life(c, s) = {s = 3: 1, s = 4: c, 0}';
const GLIDER = 'L_0 = [(1, 0), (2, 1), (0, 2), (1, 2), (2, 2)]';

/** The board the rows define, at generation `n`. */
function board(rows: string[], n: number) {
  const analysis = analyzeRows(rows);
  const bad = analysis.rows.find(r => r.error);
  if (bad) throw new Error(bad.error);
  const row = analysis.rows.find(r => r.cpu?.type === 'automaton');
  if (row?.cpu?.type !== 'automaton') throw new Error('no automaton row');
  const b = runBoard(row.cpu, analysis.constEnv);
  b.advance(n);
  return b;
}
/** Live cells of a board as sorted "row,column" strings, as seeds list them. */
const live = (g: CellGrid) => {
  const out: string[] = [];
  for (let y = 0; y < g.rows; y++)
    for (let x = 0; x < g.width; x++) if (g.values[y * g.width + x]) out.push(`${y + g.y0},${x + g.x0}`);
  return out.sort();
};
const shift = (cells: string[], di: number, dj: number) =>
  cells
    .map(c => c.split(',').map(Number))
    .map(([i, j]) => `${i + di},${j + dj}`)
    .sort();

describe('2D automata', () => {
  it('scans rule, seed and live-cell seed rows', () => {
    expect(scanSeqRec('L_{n+1}[i, j] = L_n[i, j]')).toMatchObject({ rec: true, name: 'L', cell: 'i', cell2: 'j' });
    expect(scanSeqRec('L_0[i, j] = 1')).toMatchObject({ seed: true, cell: 'i', cell2: 'j' });
    const a = { seqScans: scanSequences(['L_0 = [(0, 0)]', 'L_{n+1}[i, j] = L_n[i, j]']) };
    expect(a.seqScans[0]).toMatchObject({ seed: true, seedList: true });
    // Without a rule for L, L_0 = […] is an ordinary list.
    expect(scanSequences(['L_0 = [1, 2]'])[0]).toBeNull();
  });

  it('a glider moves one cell diagonally every four generations', () => {
    const start = live(board([LIFE_FN, GLIDER, LIFE], 0).grid);
    expect(start).toEqual(['0,2', '1,0', '1,2', '2,1', '2,2']);
    expect(live(board([LIFE_FN, GLIDER, LIFE], 4).grid)).toEqual(shift(start, 1, 1));
    expect(live(board([LIFE_FN, GLIDER, LIFE], 40).grid)).toEqual(shift(start, 10, 10));
  });

  it('a blinker blinks, and stepping back starts over from the seed', () => {
    const b = board([LIFE_FN, 'L_0 = [(-1, 0), (0, 0), (1, 0)]', LIFE], 1);
    expect(live(b.grid)).toEqual(['0,-1', '0,0', '0,1']);
    b.advance(2);
    expect(live(b.grid)).toEqual(['-1,0', '0,0', '1,0']);
    b.advance(1);
    expect(b.generation).toBe(1);
    expect(live(b.grid)).toEqual(['0,-1', '0,0', '0,1']);
  });

  it('a glider is exact across the board', () => {
    const start = live(board([LIFE_FN, GLIDER, LIFE], 0).grid);
    expect(live(board([LIFE_FN, GLIDER, LIFE], 960).grid)).toEqual(shift(start, 240, 240));
  });

  it('reads a seed over i and j, and a rule written out by offsets', () => {
    // Each cell copies its left neighbour (row first): the seed column walks right.
    const b = board(['L_0[i, j] = {0 <= i <= 2: {j = 0: 1, 0}, 0}', 'L_{n+1}[i, j] = L_n[i, j-1]'], 3);
    expect(live(b.grid)).toEqual(['0,3', '1,3', '2,3']);
  });

  it('diagnoses 2D rules', () => {
    const errors = (rows: string[]) => analyzeRows(rows).rows.map(r => r.error ?? null);
    expect(errors(['L_{n+1}[i, j] = L_n[i]'])[0]).toMatch(/fixed offsets/);
    expect(errors(['L_{n+1}[i, j] = L_n[i, 2j]'])[0]).toMatch(/fixed offsets/);
    expect(errors(['L_{n+1}[i, j] = L_n[i, j] + j'])[0]).toMatch(/same at every cell/);
    expect(errors(['L_0[i] = 1', 'L_{n+1}[i, j] = L_n[i, j]'])[0]).toMatch(/2D automaton/);
    expect(errors(['L_0 = [(0.5, 0)]', 'L_{n+1}[i, j] = L_n[i, j]'])[0]).toMatch(/whole numbers/);
  });

  it('a 2D rule animates and names its axes', () => {
    const cls = analyzeRows([LIFE_FN, LIFE]).rows[1].cls!;
    expect(cls.animated).toBe(true);
    expect(cls.object).toMatchObject({ kind: 'automaton', dims: 2, axes: ['j', 'i'] });
    expect(analyzeRows(['r = 30', RULE]).rows[1].cls!.object).toMatchObject({ dims: 1, axes: ['i', 'n'] });
  });
});

describe('tables', () => {
  const table = (rows: string[]) => {
    const analysis = analyzeRows(rows);
    const bad = analysis.rows.find(r => r.error);
    if (bad) throw new Error(bad.error);
    const row = analysis.rows.find(r => r.cpu?.type === 'lattice');
    if (row?.cpu?.type !== 'lattice') throw new Error('no table row');
    return { cpu: row.cpu, env: analysis.constEnv };
  };

  it('evaluates a Cayley table over a window', () => {
    const { cpu, env } = table(['m = 5', 'T[i, j] = mod(i + j, m)']);
    // Row i, column j, as a matrix is read: j runs across, i down.
    expect(cpu.axes).toEqual(['j', 'i']);
    const g = evalTable(cpu, env, 0, 0, 5, 5);
    expect(Array.from(g.values.slice(0, 5))).toEqual([0, 1, 2, 3, 4]);
    expect(Array.from(g.values.slice(5, 10))).toEqual([1, 2, 3, 4, 0]);
  });

  it('reads like a matrix: row i down, column j across', () => {
    const { cpu, env } = table(['T[i, j] = 10 i + j']);
    expect(Array.from(evalTable(cpu, env, 0, 0, 3, 2).values)).toEqual([0, 1, 2, 10, 11, 12]);
  });

  it('a piecewise with no case leaves a cell empty', () => {
    const { cpu, env } = table(['T[i, j] = {0 <= i < 2: {0 <= j < 2: i j}}']);
    const g = evalTable(cpu, env, -1, 0, 4, 1);
    expect(Array.from(g.values).map(v => (Number.isNaN(v) ? null : v))).toEqual([null, 0, 0, null]);
    const shades = tableShades(g);
    expect(shades[0]).toBe(0);
    expect(shades[1]).toBeGreaterThan(0);
  });

  it('equality cases, beside a sequence of another letter', () => {
    const { cpu, env } = table(['a_n = n^2', 'T[i, j] = {i = j: 1, 0}']);
    expect(Array.from(evalTable(cpu, env, 0, 0, 3, 1).values)).toEqual([1, 0, 0]);
  });

  it('diagnoses tables', () => {
    const errors = (rows: string[]) => analyzeRows(rows).rows.map(r => r.error ?? null);
    expect(errors(['T[i, j] = q'])[0]).toMatch(/Unknown variable in the table: q/);
    expect(errors(['T[i, j] = 1', 'T[i, j] = 2'])[1]).toMatch(/already defined/);
  });
});
