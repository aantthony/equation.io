/**
 * `device.clock`, `device.mouse`, …: values the viewer's device supplies rather
 * than the document. They live under `device.` so they claim no name a graph
 * might want — `clock = 3` stays an ordinary slider.
 *
 * Each is a constant (a point, for the vector ones) whose definition is
 * written in `t`, so it animates, differentiates and reaches shaders as a
 * parameter like any constant that follows time; evaluateFrame takes its
 * value from the device. The definition gives only the rate: `device.clock`
 * gains a second per second of `t`, and an input like `device.mouse` is `0 t`
 * — changing, at no rate anything can predict. Only documents that mention a
 * device value get the constant, so no other graph re-evaluates its constants
 * every frame.
 *
 * The wall clock is read here; the app feeds the other inputs in through
 * setDeviceInput (web/device-inputs.ts). Anywhere else — tests, the worker's
 * previews — they hold their resting values.
 */
import type { Definition } from './defs.ts';

const DAY_MS = 86_400_000;
/** 2000-01-01 00:00 UTC: `device.day` counts from here. Days since 1970 would
 *  be ~20 500, which a shader's float32 still resolves; since 2000 keeps a
 *  bit more headroom and makes a moon or season epoch short to write. */
const EPOCH_2000 = Date.UTC(2000, 0, 1);
/** Standard gravity, m/s². */
export const STANDARD_GRAVITY = 9.80665;

interface DeviceValue {
  /** Its definition in `t`: the rate at which it changes. */
  rate: string;
  /** 1 for a number; 2 or 3 for a point or vector, read as `_x`, `_y`, `_z`. */
  dim: 1 | 2 | 3;
  /** The value where the device supplies none. */
  rest: readonly number[];
  /** Read from the clock rather than from setDeviceInput. */
  clock?: (now: Date) => number;
  /** Read from the motion sensor (web/device-inputs.ts). */
  motion?: boolean;
  doc: string;
}

const input = (dim: 1 | 2 | 3, rest: readonly number[], doc: string, motion = false): DeviceValue => ({
  rate: dim === 1 ? '0 t' : `(${Array(dim).fill('0 t').join(', ')})`,
  dim,
  rest,
  doc,
  motion,
});

export const DEVICE: Readonly<Record<string, DeviceValue>> = {
  clock: {
    rate: 't',
    dim: 1,
    rest: [0],
    // Local wall time, so the hands of a clock read what the viewer's own
    // clock reads (DST included). Seconds since midnight rather than since
    // 1970: ~1.8e9 in a float32 uniform only resolves to about 2 minutes.
    clock: now => now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000,
    doc: "seconds since local midnight, 0 to 86400 — the viewer's own clock",
  },
  day: {
    rate: 't/86400',
    dim: 1,
    rest: [0],
    clock: now => (now.getTime() - EPOCH_2000) / DAY_MS,
    doc: 'days since 2000-01-01 00:00 UTC, with the fraction of today',
  },
  mouse: input(2, [0, 0], 'the pointer, in graph coordinates'),
  gravity: input(
    3,
    [0, -STANDARD_GRAVITY, 0],
    "gravity in m/s² along the screen's x, y and out of it — tilt a phone to turn it",
    true,
  ),
  xmin: input(1, [-10], 'left edge of the visible graph'),
  xmax: input(1, [10], 'right edge of the visible graph'),
  ymin: input(1, [-10], 'bottom edge of the visible graph'),
  ymax: input(1, [10], 'top edge of the visible graph'),
};

export const DEVICE_PREFIX = 'device.';
const AXES = ['x', 'y', 'z'];

let clock: () => number = () => Date.now();
const inputs = new Map<string, readonly number[]>();

/** Pin the wall clock device values read (tests); no argument restores it. */
export function setDeviceClock(now?: () => number): void {
  clock = now ?? (() => Date.now());
}

/** What the device reports for an input (`mouse`, `gravity`); no value
 *  returns it to rest. */
export function setDeviceInput(key: string, value?: readonly number[]): void {
  if (value) inputs.set(key, value);
  else inputs.delete(key);
}

/** A device name (`device.mouse_x`, `device.clock`) as its entry and component. */
function resolve(name: string): { key: string; entry: DeviceValue; axis: number } | null {
  if (!name.startsWith(DEVICE_PREFIX)) return null;
  const rest = name.slice(DEVICE_PREFIX.length);
  const m = /^(\w+?)(?:_([xyz]))?$/.exec(rest);
  if (!m) return null;
  const [, key, comp] = m;
  if (!Object.hasOwn(DEVICE, key)) return null;
  const entry = DEVICE[key];
  const axis = comp ? AXES.indexOf(comp) : 0;
  if (comp ? entry.dim === 1 || axis >= entry.dim : entry.dim !== 1) return null;
  return { key, entry, axis };
}

/** Whether evaluateFrame should read `name` from the device: a scalar device
 *  value or one component of a vector one. */
export const isDeviceName = (name: string): boolean => resolve(name) !== null;

/** The current value of a device name (`device.clock`, `device.mouse_x`). */
export function deviceValue(name: string): number {
  const { key, entry, axis } = resolve(name)!;
  if (entry.clock) return entry.clock(new Date(clock()));
  return (inputs.get(key) ?? entry.rest)[axis] ?? NaN;
}

/** No `\b` before device: `2device.clock` is 2 × device.clock. A name ending in device
 *  (`mydevice.clock`) over-matches, which costs only a per-frame evaluation. */
const MENTION = /device\s*\.\s*([A-Za-z_]\w*)/g;

/** The device entries `texts` mention, components folded to their vector. */
function mentioned(texts: Iterable<string>): Set<string> {
  const keys = new Set<string>();
  for (const text of texts) {
    for (const [, word] of text.matchAll(MENTION)) {
      const key = Object.hasOwn(DEVICE, word) ? word : word.replace(/_[xyz]$/, '');
      if (Object.hasOwn(DEVICE, key)) keys.add(key);
    }
  }
  return keys;
}

/**
 * The constant definitions a document's rows call for: one per device value
 * mentioned anywhere in `texts`. A mention the parser reads another way (in a
 * comment, say) costs only a per-frame evaluation.
 */
export function deviceDefinitions(texts: Iterable<string>): Definition[] {
  return [...mentioned(texts)].sort().map(key => ({ kind: 'const', name: DEVICE_PREFIX + key, rhs: DEVICE[key].rate }));
}

/** Whether a document's definitions read the motion sensor. */
export function readsMotion(constNames: Iterable<string>): boolean {
  for (const name of constNames) if (resolve(name)?.entry.motion) return true;
  return false;
}

/** The device value a row tries to define (`device.clock = 5`), or null. */
export function deviceDefinitionIssue(text: string): string | null {
  const m = /^\s*device\s*\.\s*([A-Za-z_]\w*)\s*=(?!=)/.exec(text);
  const key = m && m[1].replace(/_[xyz]$/, '');
  if (!key || !Object.hasOwn(DEVICE, key)) return null;
  return `device.${m[1]} comes from the device, so it cannot be set. Name your own value instead, like c = 5.`;
}

/** Why `name` (under `device.`) is not a device value — or null when it is one or
 *  is not under `device.` at all. */
export function deviceNameIssue(name: string): string | null {
  if (!name.startsWith(DEVICE_PREFIX) || isDeviceName(name)) return null;
  const key = name.slice(DEVICE_PREFIX.length).replace(/_[xyz]$/, '');
  if (Object.hasOwn(DEVICE, key)) {
    const { dim } = DEVICE[key];
    return dim === 1
      ? `device.${key} is a number, with no components.`
      : `device.${key} has components ${AXES.slice(0, dim)
          .map(a => `device.${key}_${a}`)
          .join(', ')}.`;
  }
  const known = Object.keys(DEVICE).map(k => DEVICE_PREFIX + k);
  return `${name} is not a device value — there are ${known.slice(0, -1).join(', ')} and ${known.at(-1)}.`;
}
