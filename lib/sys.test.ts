import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { constsAnimated } from './defs.ts';
import { emptyEnv, evaluateFrame } from './env.ts';
import { orbitInput } from './orbit.ts';
import { syntaxHelp } from './syntax-help.ts';
import { setSysClock } from './sys.ts';

// 2026-06-21 10:10:30.250 in the local zone, whatever the machine's zone is.
const NOW = new Date(2026, 5, 21, 10, 10, 30, 250);

describe('sys values', () => {
  beforeEach(() => setSysClock(() => NOW.getTime()));
  afterEach(() => setSysClock());

  it('reads the local wall clock and the days since 2000, whatever t is', () => {
    const { defs } = analyzeRows(['sys.clock', 'sys.day']);
    const env = evaluateFrame(defs, 123.4);
    expect(env['sys.clock']).toBeCloseTo(10 * 3600 + 10 * 60 + 30.25, 6);
    expect(env['sys.day']).toBeCloseTo((NOW.getTime() - Date.UTC(2000, 0, 1)) / 86_400_000, 9);
  });

  it('is a constant that follows time, so rows using it animate as parameters', () => {
    const a = analyzeRows(['s = sys.clock', 'segment((0, 0), (sin(2pi s/60), cos(2pi s/60)))', 'y = sys.day x']);
    expect(a.rows.map(r => r.error)).toEqual([undefined, undefined, undefined]);
    expect(a.rows[1].cls?.params).toEqual(['s']);
    expect(a.rows[2].cls?.params).toEqual(['sys.day']);
    expect(constsAnimated(a.defs)).toBe(true);
    expect(a.constEnv.s).toBeCloseTo(36630.25, 6);
  });

  it('claims no names: a graph that never mentions sys stays static', () => {
    const a = analyzeRows(['clock = 3', 'y = clock x', '# sys.clock in a comment']);
    expect(a.rows.map(r => r.error)).toEqual([undefined, undefined, undefined]);
    expect(constsAnimated(a.defs)).toBe(false);
  });

  it('names the sys values when a row asks for one that does not exist', () => {
    expect(analyzeRows(['y = sys.time x']).rows[0].error).toBe(
      'sys.time is not a system value — there are sys.clock and sys.day.',
    );
  });

  it('reads sys values written right after a number', () => {
    const a = analyzeRows(['y = 2sys.clock x', 'y = x/2sys.day']);
    expect(a.rows.map(r => r.error)).toEqual([undefined, undefined]);
    expect(a.rows[0].cls?.params).toEqual(['sys.clock']);
  });

  it('refuses to set a sys value', () => {
    expect(analyzeRows(['sys.clock = 5']).rows[0].error).toBe(
      "sys.clock comes from the device's clock, so it cannot be set. Name your own value instead, like c = 5.",
    );
  });

  it('keeps sys values out of orbits, which run in their own time from 0', () => {
    const a = analyzeRows(["th' = sys.clock/100000 - th", 'th(0) = 1', 'th(0..10)']);
    expect(a.rows.map(r => r.error).slice(0, 2)).toEqual([undefined, undefined]);
    const { object } = a.rows[2].cls!;
    if (object.kind !== 'orbit') throw new Error(`an orbit, not ${object.kind}`);
    expect(() => orbitInput(a.defs, object.paths, object.series, 0, 10, a.constEnv)).toThrow(
      'An orbit runs in its own time from t = 0, so it cannot read sys.clock.',
    );
  });

  it('completes sys. in the editor', () => {
    const names = syntaxHelp('sys.', 4, emptyEnv()).suggestions.map(s => s.name);
    expect(names).toEqual(['sys.clock', 'sys.day']);
  });
});
