import { describe, expect, it } from 'vitest';
import { parseAxisMap } from './axis-map.ts';
import { axisTicks, nicestIn } from './axis-ticks.ts';

const values = (src: string, lo: number, hi: number, px: number) =>
  axisTicks(parseAxisMap('x', src), lo, hi, px).major.map(t => t.value);

describe('nicestIn', () => {
  it('prefers 0, then fewer digits, then a leading 1, 5, 2', () => {
    expect(nicestIn(-3, 7)).toBe(0);
    expect(nicestIn(28, 133)).toBe(100);
    expect(nicestIn(1.41, 2.37)).toBe(2);
    expect(nicestIn(4.2, 7.1)).toBe(5);
    expect(nicestIn(2.83, 4.7)).toBe(3);
    expect(nicestIn(0.21, 0.29)).toBe(0.25);
    expect(nicestIn(0.3, 0.30000000000000004)).toBe(0.3);
    expect(nicestIn(-133, -28)).toBe(-100);
    expect(nicestIn(2, 1)).toBeNull();
  });
});

describe('ticks on a mapped axis', () => {
  it('label every decade of a zoomed-out log axis', () => {
    // 1..1000000 across 1200 px: 200 px a decade.
    expect(values('10^X', 0, 6, 200)).toEqual([1, 10, 100, 1000, 10000, 100000, 1000000]);
  });

  it('skip decades when they crowd', () => {
    // 40 px a decade: every third or so.
    const v = values('10^X', -12, 12, 40);
    expect(v.length).toBeGreaterThan(4);
    expect(v.length).toBeLessThan(13);
    for (const x of v) expect(Math.log10(x) % 1).toBeCloseTo(0, 9);
  });

  it('fill in 2, 3 and 5 when a decade is wide', () => {
    expect(values('10^X', 0, 1, 600)).toEqual([1, 2, 3, 5, 10]);
  });

  it('step evenly on a linear map', () => {
    expect(values('3X + 1', 0, 9, 100)).toEqual([5, 10, 15, 20, 25]);
  });

  it('cross zero on a symlog axis', () => {
    const v = values('sinh(X)', -5, 5, 100);
    expect(v).toContain(0);
    expect(v.some(x => x < 0) && v.some(x => x > 0)).toBe(true);
    expect(axisTicks(parseAxisMap('x', 'sinh(X)'), -5, 5, 100).zero).toBeCloseTo(0, 9);
  });

  it('stay put while panning', () => {
    const map = parseAxisMap('x', '10^X');
    const at = (lo: number) => axisTicks(map, lo, lo + 6, 200).major.map(t => t.value);
    const [a, b] = [at(0.1), at(0.3)];
    expect(b.filter(v => a.includes(v))).toEqual(b.filter(v => v >= 10 ** 0.3 && v <= 10 ** 6.1));
  });

  it('put minor lines between decades', () => {
    const t = axisTicks(parseAxisMap('x', '10^X'), 0, 2, 300);
    const inFirst = t.minor.filter(s => s > 0 && s < 1);
    expect(inFirst.length).toBeGreaterThanOrEqual(3);
  });

  it('tick only what the map can show', () => {
    // ln(X) has no value left of X = 0.
    const t = axisTicks(parseAxisMap('x', 'ln(X)'), -1, 10, 100);
    expect(t.major.every(m => m.at > 0)).toBe(true);
    expect(t.major.length).toBeGreaterThan(0);
    expect(t.zero).toBeCloseTo(1, 9);
  });

  it('have no zero line on a log axis', () => {
    expect(axisTicks(parseAxisMap('x', '10^X'), -3, 3, 100).zero).toBeNull();
  });
});
