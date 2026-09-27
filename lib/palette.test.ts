import { describe, expect, it } from 'vitest';
import { analyze } from '../worker/graph.ts';
import { assignColors, takesColor } from './palette.ts';

/** Slots after coloring rows given as existing slots (-1 = new). */
function color(slots: number[], takes = slots.map(() => true)): number[] {
  const rows = slots.map(colorIndex => ({ colorIndex }));
  assignColors(rows, takes, 6);
  return rows.map(r => r.colorIndex);
}

/** Slots a freshly loaded document's rows take, as the share image colors them. */
function loaded(texts: string[]): number[] {
  const rows = texts.map(() => ({ colorIndex: -1 }));
  const analysis = analyze(texts);
  assignColors(
    rows,
    analysis.rows.map((row, i) =>
      takesColor({
        ...row,
        text: texts[i],
        point: row.def?.kind === 'const' && analysis.defs.points.has(row.def.name),
      }),
    ),
    6,
  );
  return rows.map(r => r.colorIndex);
}

describe('assignColors', () => {
  it('runs a fresh document through the palette in order', () => {
    expect(color([-1, -1, -1, -1, -1, -1, -1, -1])).toEqual([0, 1, 2, 3, 4, 5, 0, 1]);
  });

  it('leaves colored rows alone', () => {
    expect(color([3, 3, 5])).toEqual([3, 3, 5]);
  });

  it('fills the gap a deleted row left', () => {
    expect(color([0, 2, 3, -1])).toEqual([0, 2, 3, 1]);
  });

  it('counts only the finished document, however the new rows got there', () => {
    // Pasting three curves over a whole [blue, red, green] document, or
    // voice mode inserting a row above a kept one: new rows are uncolored
    // until the document is final, so nothing removed or half-built counts.
    expect(color([-1, -1, -1])).toEqual([0, 1, 2]);
    expect(color([-1, 0])).toEqual([1, 0]);
    expect(color([0, -1, 1])).toEqual([0, 2, 1]);
  });

  it('breaks a tie away from the rows on either side', () => {
    // Every slot used once: a row inserted between blue and red is neither.
    expect(color([0, -1, 1, 2, 3, 4, 5])).toEqual([0, 2, 1, 2, 3, 4, 5]);
    // Two copies of a row, with blue free after a deletion.
    expect(color([1, 2, 3, 4, 5, -1, -1])).toEqual([1, 2, 3, 4, 5, 0, 1]);
  });

  it('gives rows that show no color no slot, and does not count them', () => {
    expect(color([-1, 4, -1, -1], [true, false, true, true])).toEqual([0, -1, 1, 2]);
  });

  it('reaches black only when every other color is in use', () => {
    expect(color([0, 1, 2, 3, 4, -1])).toEqual([0, 1, 2, 3, 4, 5]);
    expect(color([0, 0, -1])).toEqual([0, 0, 1]);
  });
});

describe('takesColor', () => {
  it('passes over rows that draw nothing', () => {
    expect(loaded(['a = 1', 'b = 2', 'c = 3', 'y = a x', 'y = b x^2', 'y = c x^3'])).toEqual([-1, -1, -1, 0, 1, 2]);
    expect(loaded(['# curves', 'y = x', 'view(x = -1..1, y = -1..1)', 'y = x^2'])).toEqual([-1, 0, -1, 1]);
    expect(loaded(['y = x', '---', 'y = x^2'])).toEqual([0, -1, 1]);
  });

  it('colors named points, which draw a dot', () => {
    expect(loaded(['A = (1, 2)', 'k = 3', 'B = (k, 0)', 'segment(A, B)'])).toEqual([0, -1, 1, 2]);
  });

  it('passes over rows with their own #hex color', () => {
    expect(loaded(['y = x #e24', 'y = x^2'])).toEqual([-1, 0]);
  });

  it('colors a row that is still being typed', () => {
    expect(takesColor({ text: 'y = sin(' })).toBe(true);
    expect(takesColor({ text: '   ' })).toBe(false);
  });
});
