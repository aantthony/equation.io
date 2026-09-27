import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeRows, prepareDocument } from './analysis.ts';
import { constsAnimated } from './defs.ts';
import { emptyEnv, evaluateFrame } from './env.ts';
import { orbitInput } from './orbit.ts';
import { advanceState, initialState } from './state.ts';
import { syntaxHelp } from './syntax-help.ts';
import { STANDARD_GRAVITY, setDeviceClock, setDeviceInput, readsMotion } from './device.ts';

// 2026-06-21 10:10:30.250 in the local zone, whatever the machine's zone is.
const NOW = new Date(2026, 5, 21, 10, 10, 30, 250);

describe('device values', () => {
  beforeEach(() => setDeviceClock(() => NOW.getTime()));
  afterEach(() => {
    setDeviceClock();
    for (const key of ['mouse', 'gravity', 'xmin']) setDeviceInput(key);
  });

  it('reads the local wall clock and the days since 2000, whatever t is', () => {
    const { defs } = analyzeRows(['device.clock', 'device.day']);
    const env = evaluateFrame(defs, 123.4);
    expect(env['device.clock']).toBeCloseTo(10 * 3600 + 10 * 60 + 30.25, 6);
    expect(env['device.day']).toBeCloseTo((NOW.getTime() - Date.UTC(2000, 0, 1)) / 86_400_000, 9);
  });

  it('is a constant that follows time, so rows using it animate as parameters', () => {
    const a = analyzeRows(['s = device.clock', 'segment((0, 0), (sin(2pi s/60), cos(2pi s/60)))', 'y = device.day x']);
    expect(a.rows.map(r => r.error)).toEqual([undefined, undefined, undefined]);
    expect(a.rows[1].cls?.params).toEqual(['s']);
    expect(a.rows[2].cls?.params).toEqual(['device.day']);
    expect(constsAnimated(a.defs)).toBe(true);
    expect(a.constEnv.s).toBeCloseTo(36630.25, 6);
  });

  it('claims no names: a graph that never mentions device stays static', () => {
    const a = analyzeRows(['clock = 3', 'y = clock x', '# device.clock in a comment']);
    expect(a.rows.map(r => r.error)).toEqual([undefined, undefined, undefined]);
    expect(constsAnimated(a.defs)).toBe(false);
  });

  it('names the device values when a row asks for one that does not exist', () => {
    expect(analyzeRows(['y = device.time x']).rows[0].error).toBe(
      'device.time is not a device value — there are device.clock, device.day, device.mouse, device.gravity, device.xmin, device.xmax, device.ymin and device.ymax.',
    );
  });

  it('reads device values written right after a number', () => {
    const a = analyzeRows(['y = 2device.clock x', 'y = x/2device.day']);
    expect(a.rows.map(r => r.error)).toEqual([undefined, undefined]);
    expect(a.rows[0].cls?.params).toEqual(['device.clock']);
  });

  it('refuses to set a device value', () => {
    expect(analyzeRows(['device.clock = 5']).rows[0].error).toBe(
      'device.clock comes from the device, so it cannot be set. Name your own value instead, like c = 5.',
    );
  });

  it('keeps device values out of orbits, which run in their own time from 0', () => {
    const a = analyzeRows(["th' = device.clock/100000 - th", 'th(0) = 1', 'th(0..10)']);
    expect(a.rows.map(r => r.error).slice(0, 2)).toEqual([undefined, undefined]);
    const { object } = a.rows[2].cls!;
    if (object.kind !== 'orbit') throw new Error(`an orbit, not ${object.kind}`);
    expect(() => orbitInput(a.defs, object.paths, object.series, 0, 10, a.constEnv)).toThrow(
      'An orbit runs in its own time from t = 0, so it cannot read device.clock.',
    );
  });

  it('completes device. in the editor', () => {
    const complete = (text: string) => syntaxHelp(text, text.length, emptyEnv()).suggestions.map(s => s.name);
    expect(complete('device.').every(n => n.startsWith('device.'))).toBe(true);
    expect(complete('device.c')).toEqual(['device.clock']);
    expect(complete('device.gr')).toEqual(['device.gravity']);
    expect(complete('device.m')).toEqual(['device.mouse']);
  });

  it('reads device inputs as points and numbers, resting where the device gives none', () => {
    const rows = ['segment((0, 0), device.mouse)', 'device.mouse_x + 1', '|device.gravity|', 'y = device.xmin + x'];
    let a = analyzeRows(rows);
    expect(a.rows.map(r => r.error)).toEqual(rows.map(() => undefined));
    expect(a.rows[0].cls?.params).toEqual(['device.mouse_x', 'device.mouse_y']);
    expect(a.constEnv).toMatchObject({
      'device.mouse_x': 0,
      'device.gravity_y': -STANDARD_GRAVITY,
      'device.xmin': -10,
    });
    setDeviceInput('mouse', [1.5, -2]);
    setDeviceInput('xmin', [-3]);
    a = analyzeRows(rows);
    expect(a.constEnv).toMatchObject({ 'device.mouse_x': 1.5, 'device.mouse_y': -2, 'device.xmin': -3 });
    expect(a.rows[1].info).toBe('= 2.5');
    // An input changes, but at no rate anything could predict.
    expect(constsAnimated(a.defs)).toBe(true);
    expect(analyzeRows(['d/dt device.mouse_x']).rows[0].info).toBe('= 0');
  });

  it('names the components a vector device value has', () => {
    expect(analyzeRows(['device.mouse_z']).rows[0].error).toBe(
      'device.mouse has components device.mouse_x, device.mouse_y.',
    );
    expect(analyzeRows(['device.xmin_x']).rows[0].error).toBe('device.xmin is a number, with no components.');
    expect(analyzeRows(['device.constructor']).rows[0].error).toContain('is not a device value');
    expect(analyzeRows(['device.mouse_x = 2']).rows[0].error).toContain('device.mouse_x comes from the device');
  });

  it('knows when a document reads the motion sensor', () => {
    expect(readsMotion(analyzeRows(['device.gravity_y', 'device.mouse']).defs.consts.keys())).toBe(true);
    expect(readsMotion(analyzeRows(['device.clock', 'device.mouse']).defs.consts.keys())).toBe(false);
  });

  it('reaches a simulation at every step: a pendulum settles along gravity', () => {
    const doc = prepareDocument([
      'a = atan2(device.gravity_x, -device.gravity_y)',
      'g = |(device.gravity_x, device.gravity_y)|',
      "th' = om",
      "om' = -g sin(th - a)/2 - om",
      'th(0) = 0',
      'om(0) = 0',
    ]);
    const system = doc.stateSystem!;
    const values = initialState(doc.defs, system);
    // The phone turned so that down is the screen's right.
    setDeviceInput('gravity', [STANDARD_GRAVITY, 0, 0]);
    let now = 0;
    for (let f = 1; f <= 60 * 20; f++) now = advanceState(doc.defs, system, values, now, f / 60);
    expect(values.th).toBeCloseTo(Math.PI / 2, 3);
  });
});
