/**
 * `sys.clock`, `sys.day`: values the viewer's device supplies rather than
 * the document. They live under `sys.` so they claim no name a graph might
 * want — `clock = 3` stays an ordinary slider.
 *
 * Each is a constant whose definition is written in `t` (so it animates,
 * differentiates and reaches shaders as a parameter, like any constant that
 * follows time) and whose value evaluateFrame takes from the wall clock. The
 * definition gives only the rate: `sys.clock` gains a second per second of
 * `t`. Only documents that mention a sys value get the constant, so no other
 * graph re-evaluates its constants every frame.
 */
import type { Definition } from './defs.ts';

const DAY_MS = 86_400_000;
/** 2000-01-01 00:00 UTC: `sys.day` counts from here. Days since 1970 would
 *  be ~20 500, which a shader's float32 still resolves; since 2000 keeps a
 *  bit more headroom and makes a moon or season epoch short to write. */
const EPOCH_2000 = Date.UTC(2000, 0, 1);

interface SysValue {
  /** Its definition in `t`: the rate at which it changes. */
  rate: string;
  value: (now: Date) => number;
  doc: string;
}

export const SYS: Readonly<Record<string, SysValue>> = {
  clock: {
    rate: 't',
    // Local wall time, so the hands of a clock read what the viewer's own
    // clock reads (DST included). Seconds since midnight rather than since
    // 1970: ~1.8e9 in a float32 uniform only resolves to about 2 minutes.
    value: now => now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000,
    doc: "seconds since local midnight, 0 to 86400 — the viewer's own clock",
  },
  day: {
    rate: 't/86400',
    value: now => (now.getTime() - EPOCH_2000) / DAY_MS,
    doc: 'days since 2000-01-01 00:00 UTC, with the fraction of today',
  },
};

export const SYS_PREFIX = 'sys.';

let clock: () => number = () => Date.now();

/** Pin the wall clock `sys` values read (tests); no argument restores it. */
export function setSysClock(now?: () => number): void {
  clock = now ?? (() => Date.now());
}

export const isSysName = (name: string): boolean => name.startsWith(SYS_PREFIX) && name.slice(4) in SYS;

/** The current value of a sys name (`sys.clock`). */
export const sysValue = (name: string): number => SYS[name.slice(4)].value(new Date(clock()));

const MENTION = /\bsys\s*\.\s*([A-Za-z_]\w*)/g;

/**
 * The constant definitions a document's rows call for: one per sys value
 * mentioned anywhere in `texts`. A mention the parser reads another way (in a
 * comment, say) costs only a per-frame evaluation.
 */
export function sysDefinitions(texts: Iterable<string>): Definition[] {
  const names = new Set<string>();
  for (const text of texts) for (const [, key] of text.matchAll(MENTION)) if (key in SYS) names.add(key);
  return [...names].sort().map(key => ({ kind: 'const', name: SYS_PREFIX + key, rhs: SYS[key].rate }));
}

/** Why `name` (under `sys.`) is not a sys value — or null when it is one or
 *  is not under `sys.` at all. */
export function sysNameIssue(name: string): string | null {
  if (!name.startsWith(SYS_PREFIX) || isSysName(name)) return null;
  const known = Object.keys(SYS).map(k => SYS_PREFIX + k);
  return `${name} is not a system value — there are ${known.join(' and ')}.`;
}
