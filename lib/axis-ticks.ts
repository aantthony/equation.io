/**
 * Grid lines and labels for a mapped axis (lib/axis-map.ts).
 *
 * An unmapped axis has a line every 1, 2 or 5 × 10^k units, evenly spaced on
 * screen. A mapped one is not even: on `x = 10^X` the decades are, and the
 * numbers between them crowd toward each one's top. So ticks are chosen
 * where they land on screen: from a tick, the next is the nicest number
 * (0, then the fewest significant digits, then a leading 1, 5 or 2) that
 * lands between `gap` and 2.5 `gap` pixels further on. Zoomed out on a log
 * axis that is every decade, or every few; zoomed in it is 1, 2, 3, 5, 10;
 * on a map that is nearly linear it is the usual even steps.
 *
 * The walk starts from the nicest number in view and goes both ways, so
 * while panning (same zoom) the ticks stay put until that number leaves.
 */
import { type AxisMap, shownRange, toScreen, toWorld } from './axis-map.ts';

export interface AxisTicks {
  /** Screen coordinates of the labelled lines, with their world values. */
  major: Array<{ at: number; value: number }>;
  /** Screen coordinates of the faint lines between them. */
  minor: number[];
  /** Screen coordinate where the world value is 0, when the map reaches it. */
  zero: number | null;
}

/** Pixels between labelled lines, at least: niceSpacing's 90 in render2d. */
const MAJOR_GAP_PX = 90;
const MINOR_GAP_PX = 18;
/** Enough for any window; a runaway walk stops here. */
const MAX_TICKS = 200;

const LEAD_ORDER = [1, 5, 2];

/** Lower is nicer: 0, then fewer significant digits, then a last digit of
 *  5 or an even one (0.25 before 0.21), then a leading 1, 5, 2. */
function niceness(v: number): number {
  if (v === 0) return -1;
  let m = Math.abs(v);
  m /= 10 ** Math.floor(Math.log10(m));
  // Digits of the mantissa to ten places, so float noise reads as none.
  const digits = m
    .toFixed(10)
    .replace(/\.?0+$/, '')
    .replace('.', '');
  const last = Number(digits[digits.length - 1]);
  const ending = digits.length === 1 ? 0 : last === 5 ? 0 : last % 2 === 0 ? 1 : 2;
  const rank = LEAD_ORDER.indexOf(Number(digits[0]));
  return digits.length * 100 + ending * 10 + (rank < 0 ? 9 : rank);
}

/** The nicest number in [a, b] (a ≤ b), or null when the interval is empty
 *  or holds no number at any scale worth labelling. */
export function nicestIn(a: number, b: number): number | null {
  if (!(a <= b) || !isFinite(a) || !isFinite(b)) return null;
  if (a <= 0 && b >= 0) return 0;
  const top = Math.floor(Math.log10(Math.max(Math.abs(a), Math.abs(b))));
  // The coarsest power of ten with a multiple inside holds the nicest ones.
  for (let k = top; k > top - 16; k--) {
    const step = 10 ** k;
    const first = Math.ceil(a / step);
    const last = Math.floor(b / step);
    if (first > last) continue;
    let best: number | null = null;
    let bestScore = Infinity;
    for (let n = first; n <= last && n - first < 20; n++) {
      // Rounded at the step, so 0.30000000000000004 is 0.3.
      const v = parseFloat((n * step).toPrecision(12));
      const score = niceness(v);
      if (score < bestScore || (score === bestScore && Math.abs(v) < Math.abs(best!))) {
        best = v;
        bestScore = score;
      }
    }
    return best;
  }
  return null;
}

/**
 * Ticks for screen window [lo, hi] of a mapped axis, `pxPerUnit` screen
 * pixels per screen unit. Every coordinate returned is in screen units.
 */
export function axisTicks(map: AxisMap, lo: number, hi: number, pxPerUnit: number): AxisTicks {
  const world = (s: number) => toWorld(map, s);
  const screen = (v: number) => toScreen(map, v);
  // Outward from `from` both ways, staying inside [first, last].
  const walk = (from: number, first: number, last: number): number[] => {
    const gap = MAJOR_GAP_PX / pxPerUnit;
    const out: number[] = [];
    for (const dir of [1, -1]) {
      let s = from;
      for (let k = 0; k < MAX_TICKS; k++) {
        const [v0, v1] = [world(s + dir * gap), world(s + dir * 2.5 * gap)];
        const next = nicestIn(Math.min(v0, v1), Math.max(v0, v1));
        if (next === null) break;
        s = screen(next);
        if (!isFinite(s) || s > last || s < first) break;
        out.push(s);
      }
    }
    return out;
  };
  const empty: AxisTicks = { major: [], minor: [], zero: null };
  // The window may reach past the map (ln(X) left of 0): tick what it can show.
  const shown = shownRange(map, lo, hi);
  if (!shown) return empty;
  const [a, b] = shown.screen;
  const anchorValue = nicestIn(world(a), world(b));
  if (anchorValue === null) return empty;
  const anchor = screen(anchorValue);
  const majors = [anchor, ...walk(anchor, a, b)].sort((p, q) => p - q);
  // Minor lines fill each gap between majors (and the ends of the window).
  const edges = [a, ...majors, b];
  const minor: number[] = [];
  for (let k = 0; k + 1 < edges.length; k++) {
    const [s0, s1] = [edges[k], edges[k + 1]];
    for (const s of walkBetween(s0, s1)) minor.push(s);
  }
  const zero = screen(0);
  return {
    major: majors.map(at => ({ at, value: parseFloat(world(at).toPrecision(12)) })),
    minor,
    zero: isFinite(zero) && Math.abs(world(zero)) < 1e-12 ? zero : null,
  };

  function walkBetween(s0: number, s1: number): number[] {
    const gap = MINOR_GAP_PX / pxPerUnit;
    const out: number[] = [];
    let s = s0;
    for (let k = 0; k < MAX_TICKS; k++) {
      const next = nicestIn(world(s + gap), world(Math.min(s + 2.5 * gap, s1)));
      if (next === null) break;
      s = screen(next);
      if (!isFinite(s) || s >= s1 - gap / 2) break;
      out.push(s);
    }
    return out;
  }
}
