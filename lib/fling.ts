/**
 * Touch-dismissal and corner-pinning physics: the math behind flicking a
 * panel between screen corners or off-screen entirely, the way iOS moves its
 * sheets, banners, and picture-in-picture window. Pure and DOM-free —
 * web/panel-swipe.ts owns the events and styles — so the tuning that makes
 * the gesture feel right lives under test.
 *
 * The feel comes from four rules borrowed from UIKit:
 *  - while touched, the panel is pinned to the finger — no easing, no lag;
 *  - release decides by *projected momentum* (where the panel would coast to,
 *    not where it is), so a slow drag past halfway off an edge and a short
 *    sharp flick both dismiss, and a soft directional flick is enough to send
 *    the panel across the screen to another corner;
 *  - the projected point picks the destination: past half the panel beyond
 *    any screen edge it leaves along the throw line, otherwise it belongs to
 *    the nearest corner — Apple's picture-in-picture recipe;
 *  - the hand-off from finger to animation is a spring seeded with the
 *    release velocity, so motion stays continuous through the release.
 *
 * Coordinates are the panel's top-left corner in viewport space, px and
 * seconds throughout (sample times in ms, as events give).
 */

export interface Vec2 {
  x: number;
  y: number;
}

/** A touch position at a moment, straight from a touchmove. */
export interface Sample {
  /** Event timeStamp, ms. */
  t: number;
  x: number;
  y: number;
}

/**
 * Diminishing-returns pull, UIScrollView's overscroll curve: starts at slope
 * `c` and approaches `limit` asymptotically, so pulling the panel past a
 * boundary visibly gives but never gets far. Used when pulling the panel
 * open beyond its parked and home positions; ordinary panel drags are free
 * in every direction (every direction leads somewhere). Negative input (a
 * free direction) passes through 0.
 */
export function rubberband(d: number, limit = 90, c = 0.55): number {
  if (d <= 0) return 0;
  return (1 - 1 / ((c * d) / limit + 1)) * limit;
}

/** Samples older than this before the release no longer describe the throw. */
const V_WINDOW_MS = 100;
/** A finger that rested this long before lifting released at velocity zero. */
const V_STALL_MS = 80;

/**
 * Release velocity (px/s) over the last V_WINDOW_MS of a gesture, the way
 * UIPanGestureRecognizer reports it. `t` is the release time: touchmove stops
 * firing the moment the finger stops, so without the stall gate a
 * drag-pause-release would replay the stale pre-pause velocity as a throw.
 */
export function releaseVelocity(samples: readonly Sample[], t: number): Vec2 {
  const last = samples[samples.length - 1];
  if (!last || t - last.t > V_STALL_MS) return { x: 0, y: 0 };
  let first = last;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (last.t - samples[i].t > V_WINDOW_MS) break;
    first = samples[i];
  }
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) return { x: 0, y: 0 };
  return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
}

/** How far ahead the *dismissal* test looks: ~the distance a friction-decayed
 *  coast would add. Kept short so leaving the screen takes real intent. */
const PROJECT_S = 0.2;

/** How far ahead the *corner* pick looks. Longer than the dismissal horizon:
 *  crossing the screen should take a soft directional flick, not a hurl —
 *  the panel glides the distance the finger implied. */
export const CORNER_PROJECT_S = 0.35;

/** Where the gesture would coast to if the finger's momentum carried on. */
export function project(offset: Vec2, v: Vec2, tau = PROJECT_S): Vec2 {
  return { x: offset.x + v.x * tau, y: offset.y + v.y * tau };
}

/** Clear margins the panel rests inside (screen edge + safe areas). */
export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * The four rest positions of a w×h panel — TL, TR, BL, BR — as top-left
 * coordinates inside a vw×vh viewport.
 */
export function cornerPositions(vw: number, vh: number, w: number, h: number, m: Margins): Vec2[] {
  return [
    { x: m.left, y: m.top },
    { x: vw - m.right - w, y: m.top },
    { x: m.left, y: vh - m.bottom - h },
    { x: vw - m.right - w, y: vh - m.bottom - h },
  ];
}

/** Index of the corner nearest to `p` — fed the *projected* release point,
 *  this is Apple's fluid-interfaces corner-pinning rule. */
export function nearestCorner(p: Vec2, corners: readonly Vec2[]): number {
  let best = 0;
  let bestD = Infinity;
  corners.forEach((c, i) => {
    const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

export type Edge = 'left' | 'right' | 'top' | 'bottom';

/**
 * Commit or stay: the edge the projected position has pushed more than half
 * the panel beyond — the dismissal decision — or null to remain on-screen.
 * All four edges count, so the panel can be thrown out past any corner. Ties
 * go to the deepest overhang, so a diagonal hurl reads as the edge it most
 * clearly crossed.
 */
export function dismissEdge(proj: Vec2, w: number, h: number, vw: number, vh: number): Edge | null {
  // Each entry: how far the panel pokes past that edge, and the size of the
  // panel on that axis (the yardstick for "half").
  const overhangs: Array<[Edge, number, number]> = [
    ['left', -proj.x, w],
    ['right', proj.x + w - vw, w],
    ['top', -proj.y, h],
    ['bottom', proj.y + h - vh, h],
  ];
  let best: Edge | null = null;
  let bestFrac = 0.5; // more than half the panel must be projected out
  for (const [edge, over, size] of overhangs) {
    const frac = over / size;
    if (frac > bestFrac) {
      bestFrac = frac;
      best = edge;
    }
  }
  return best;
}

/** Slower than this (px/s) a release has no direction of its own. */
const THROW_MIN_SPEED = 250;

/**
 * The direction a dismissal leaves in: the throw velocity when there is one,
 * else the drag displacement (a slow carry keeps its heading), else straight
 * out the crossed edge.
 */
export function throwDir(v: Vec2, disp: Vec2, edge: Edge, minSpeed = THROW_MIN_SPEED): Vec2 {
  if (Math.hypot(v.x, v.y) >= minSpeed) return v;
  if (Math.hypot(disp.x, disp.y) > 1) return disp;
  return { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } }[edge];
}

/**
 * Where a dismissal flies to: from `pos` along `dir` until the panel has
 * fully cleared the viewport on whichever side the ray reaches first (`pad`
 * covers the drop shadow). A panel already fully out stays where it is.
 */
export function exitRay(pos: Vec2, dir: Vec2, w: number, h: number, vw: number, vh: number, pad = 28): Vec2 {
  let t = Infinity;
  if (dir.x < 0) t = Math.min(t, (-w - pad - pos.x) / dir.x);
  if (dir.x > 0) t = Math.min(t, (vw + pad - pos.x) / dir.x);
  if (dir.y < 0) t = Math.min(t, (-h - pad - pos.y) / dir.y);
  if (dir.y > 0) t = Math.min(t, (vh + pad - pos.y) / dir.y);
  if (!isFinite(t) || t <= 0) return pos;
  return { x: pos.x + dir.x * t, y: pos.y + dir.y * t };
}

/**
 * Whether releasing a pull-open drag (from the collapsed chip) should open
 * the panel: the projected point must be more than halfway home along the
 * ray it was parked on, `parked` and `offset` both relative to the pinned
 * corner's rest position. The mirror of dismissEdge.
 */
export function shouldOpen(offset: Vec2, v: Vec2, parked: Vec2): boolean {
  const p = project(offset, v);
  const len2 = parked.x * parked.x + parked.y * parked.y;
  if (!len2) return true;
  return (p.x * parked.x + p.y * parked.y) / len2 < 0.5;
}

/**
 * A damped spring, in SwiftUI's parametrization: `response` is the undamped
 * period in seconds (smaller = snappier) and `dampingRatio` 1 is critical —
 * no overshoot — with values below 1 bouncing. Mass is 1. Springs rather
 * than duration curves because they take an initial velocity, which is the
 * whole trick of a gesture-driven animation: the panel keeps the speed the
 * finger gave it.
 */
export interface Spring {
  /** Current position (px) and velocity (px/s). */
  x: number;
  v: number;
  target: number;
  /** Stiffness ω² and damping 2ζω, from makeSpring. */
  k: number;
  c: number;
}

export function makeSpring(x: number, v: number, target: number, response: number, dampingRatio: number): Spring {
  const w = (2 * Math.PI) / response;
  return { x, v, target, k: w * w, c: 2 * dampingRatio * w };
}

/**
 * Advance a spring by `dt` seconds (semi-implicit Euler, subdivided so a
 * dropped frame cannot blow the integration up; a background-tab stall is
 * clamped rather than fast-forwarded). Returns false once at rest, with the
 * position snapped to the target. `restDist`/`restSpeed` are the rest
 * thresholds — loose for a flight whose end is off-screen, tight for a
 * settle the eye watches land.
 */
export function stepSpring(s: Spring, dt: number, restDist = 0.5, restSpeed = 20): boolean {
  let remaining = Math.min(dt, 0.1);
  while (remaining > 0) {
    const h = Math.min(remaining, 1 / 120);
    remaining -= h;
    s.v += (-s.k * (s.x - s.target) - s.c * s.v) * h;
    s.x += s.v * h;
  }
  if (Math.abs(s.x - s.target) < restDist && Math.abs(s.v) < restSpeed) {
    s.x = s.target;
    s.v = 0;
    return false;
  }
  return true;
}

export type Claim = 'panel' | 'scroll' | 'undecided';

/**
 * Who owns a touch that has moved (dx, dy) from where it started: undecided
 * inside the slop circle; the panel once motion is mostly horizontal (nothing
 * inside the panel scrolls sideways); and for vertical motion, the scrollable
 * under the finger wins whenever it could actually consume the move — the
 * panel only drags once the list has nothing left to scroll that way, exactly
 * how a sheet behaves under a scroll view on iOS. `scroll` says whether such
 * a scrollable exists and which ways it can currently move.
 */
export function claimGesture(dx: number, dy: number, scroll: { up: boolean; down: boolean } | null, slop = 9): Claim {
  if (dx * dx + dy * dy < slop * slop) return 'undecided';
  if (Math.abs(dx) > Math.abs(dy)) return 'panel';
  // A finger moving up reveals content further down, and vice versa.
  return (dy < 0 ? scroll?.down : scroll?.up) ? 'scroll' : 'panel';
}
