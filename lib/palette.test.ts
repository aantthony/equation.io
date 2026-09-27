import { describe, expect, it } from 'vitest';
import { freshColorIndex } from './palette.ts';

describe('freshColorIndex', () => {
  it('starts an empty document on the first color', () => {
    expect(freshColorIndex([], 6)).toBe(0);
  });

  it('runs through the palette in order as rows are added', () => {
    const used: number[] = [];
    for (let i = 0; i < 8; i++) used.push(freshColorIndex(used, 6));
    expect(used).toEqual([0, 1, 2, 3, 4, 5, 0, 1]);
  });

  it('fills the gap a deleted row left', () => {
    expect(freshColorIndex([0, 2, 3], 6)).toBe(1);
  });

  it('reaches the last slot only once the others are taken', () => {
    expect(freshColorIndex([1, 1, 1], 6)).toBe(0);
    expect(freshColorIndex([0, 1, 2, 3, 4], 6)).toBe(5);
  });
});
