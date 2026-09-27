import { afterEach, describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { measureRuns, setMeasureHardStop } from './measure.ts';

/**
 * What ends a measurement (lib/measure.ts): the deterministic work budget,
 * whose refusals are remembered, and the wall-clock stop, a safety net whose
 * refusals are not. The test setup (lib/test-setup.ts) turns the clock off,
 * so no answer a test checks depends on the runner's speed; the tests here
 * that turn it on put it back.
 */
const last = (rows: string[]) => analyzeRows(rows, { readouts: true }).rows.at(-1)!;
const error = (rows: string[]) => last(rows).error ?? '';

afterEach(() => setMeasureHardStop(Infinity));

describe('the wall-clock stop', () => {
  it('refuses a run it stops, but does not remember the refusal', () => {
    // (A radius of its own, so no other test has this measurement cached.)
    const rows = ['count(x^2 + y^2 < 1.2345)'];
    setMeasureHardStop(0);
    expect(error(rows)).toMatch(/could not be measured within the time/);
    // A slow moment is not the answer: with time, the same row measures.
    setMeasureHardStop(Infinity);
    expect(last(rows).error).toBeUndefined();
    expect(last(rows).info).toMatch(/^≈ 3\.878/); // 1.2345 π
  });

  it('stops a root count as slow, not as having too many roots', () => {
    const rows = ['count({-1000<x<1000, sin(x) = 0.25})'];
    setMeasureHardStop(0);
    expect(error(rows)).toMatch(/could not be measured within the time/);
    setMeasureHardStop(Infinity);
    expect(last(rows).info).toBe('= 637');
  });
});

describe('remembered refusals', () => {
  it('a refusal by the work budget is remembered: the same slider value does not redo it', () => {
    const rows = ['a = 3.5', 'count({-1000<x<1000,-1000<y<1000, sin(a x y)>0})'];
    expect(error(rows)).toMatch(/precisely enough/);
    const runs = measureRuns.count;
    expect(error(rows)).toMatch(/precisely enough/);
    expect(measureRuns.count).toBe(runs);
  });
});
