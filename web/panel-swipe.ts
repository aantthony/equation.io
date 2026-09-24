/**
 * Swipe-to-move and swipe-to-dismiss for the equations panel.
 *
 * The panel is a corner-pinned floating card, Apple's picture-in-picture
 * grammar: from the first move it is pinned to the pointer, and release
 * decides by projected momentum — thrown more than half past any screen
 * edge it flies off along the throw line and a `y=` chip takes the nearest
 * corner; otherwise it glides to whichever corner the projected point
 * belongs to, so a soft directional flick sends it across the screen. Every
 * animation is a spring seeded with the release velocity, so motion is
 * continuous through the release — and interruptible: a new touch picks the
 * panel up wherever the animation currently holds it. Tapping the chip
 * springs the panel back; dragging the chip pulls it back in under the
 * finger. The chosen corner persists across visits.
 *
 * Touches drag from anywhere on the panel (scrolling lists and slider
 * thumbs still win their own gestures, and while the editor is focused or
 * holds a selection its text is ceded entirely — iOS caret and selection-
 * handle drags dispatch plain touches at the text, and hijacking those
 * would break text editing). The grip strip along the top edge drags with
 * any pointer, which is the mouse's way in: elsewhere on the panel a mouse
 * drag means text selection, not throwing furniture.
 *
 * All physics and decision math is lib/fling.ts, under test; this module
 * owns the events, the scroll-vs-swipe arbitration, and the styles.
 */

import {
  CORNER_PROJECT_S,
  type Sample,
  type Spring,
  type Vec2,
  claimGesture,
  cornerPositions,
  dismissEdge,
  exitRay,
  makeSpring,
  nearestCorner,
  project,
  releaseVelocity,
  rubberband,
  shouldOpen,
  stepSpring,
  throwDir,
} from '../lib/fling.ts';

/** Extra travel past the screen edge so the drop shadow fully clears too. */
const EXIT_PAD = 28;
/** Movement before a pointer commits to being a drag at all (px). */
const SLOP = 9;
/** The corner the panel was last pinned to, kept across visits. */
const CORNER_KEY = 'eq-panel-corner';

export function initPanelSwipe(panel: HTMLElement, chip: HTMLElement, grip: HTMLElement, editor: HTMLElement): void {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  /** Which corner the panel is pinned to: 0 TL, 1 TR, 2 BL, 3 BR. */
  let corner = 0;
  try {
    const n = Number(localStorage.getItem(CORNER_KEY));
    if (n >= 0 && n <= 3) corner = Math.floor(n);
  } catch {}

  /** The panel's translation from its pinned rest position; (0,0) is home. */
  const offset: Vec2 = { x: 0, y: 0 };
  // Embedded markup starts parked so the editor never flashes over the
  // graph before initialization. Adopt that pose for chip tap/drag handling.
  let hidden = panel.classList.contains('is-parked') || panel.style.visibility === 'hidden';
  /** Unit direction the panel last left in; reopening retraces it. */
  let exitDir: Vec2 = { x: 0, y: -1 };

  /** Apply a corner's anchor classes: CSS anchoring (not a transform) so a
   *  bottom-pinned panel grows upward when equations are added. */
  const pin = (el: HTMLElement, i: number) => {
    el.classList.toggle('pin-right', i % 2 === 1);
    el.classList.toggle('pin-bottom', i >= 2);
  };
  pin(panel, corner);
  pin(chip, corner);

  // --- geometry ---

  // env(safe-area-inset-*) is not readable from JS directly; a fixed probe
  // with the insets as padding resolves them to pixels on demand.
  const probe = document.createElement('div');
  probe.style.position = 'fixed';
  probe.style.inset = '0';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  probe.style.padding = 'var(--safe-area-top) var(--safe-area-right) var(--panel-bottom-inset) var(--safe-area-left)';
  document.body.append(probe);

  const margins = () => {
    const s = getComputedStyle(probe);
    return {
      top: 12 + (parseFloat(s.paddingTop) || 0),
      right: 12 + (parseFloat(s.paddingRight) || 0),
      bottom: 12 + (parseFloat(s.paddingBottom) || 0),
      left: 12 + (parseFloat(s.paddingLeft) || 0),
    };
  };

  interface Geo {
    /** Absolute top-left of the current pin's rest spot. */
    rest: Vec2;
    w: number;
    h: number;
    vw: number;
    vh: number;
    /** Rest positions of all four corners for the current panel size. */
    corners: Vec2[];
  }

  /** Measured once per gesture/animation, so per-frame paint stays pure math. */
  const measure = (): Geo => {
    const r = panel.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    return {
      rest: { x: r.left - offset.x, y: r.top - offset.y },
      w: r.width,
      h: r.height,
      vw,
      vh,
      corners: cornerPositions(vw, vh, r.width, r.height, margins()),
    };
  };
  let geo = measure();

  // --- painting ---

  function paint() {
    const { rest, w, h, vw, vh } = geo;
    const x = rest.x + offset.x;
    const y = rest.y + offset.y;
    // A light fade once the panel starts leaving the screen; squared so the
    // on-screen range barely dims and the flight does the fading.
    const out = Math.min(
      1,
      Math.max(
        -x / (w + EXIT_PAD),
        (x + w - vw) / (w + EXIT_PAD),
        -y / (h + EXIT_PAD),
        (y + h - vh) / (h + EXIT_PAD),
        0,
      ),
    );
    panel.style.transform = offset.x || offset.y ? `translate3d(${offset.x}px, ${offset.y}px, 0)` : '';
    panel.style.opacity = out ? String(1 - 0.5 * out * out) : '';
  }

  function showChip() {
    chip.hidden = false;
    void chip.offsetWidth; // commit the hidden pose, so .shown transitions from it
    chip.classList.add('shown');
  }

  function hideChip() {
    chip.classList.remove('shown');
    chip.hidden = true;
  }

  // --- the spring loop ---
  //
  // One rAF loop integrating an x and a y spring toward a corner or the exit
  // point. State lives in module scope rather than in an animation object so
  // a pointer can stop the loop and adopt `offset` mid-flight — catching the
  // panel is just "the finger is the integrator now".

  let sx: Spring | null = null;
  let sy: Spring | null = null;
  let raf = 0;
  let lastT = 0;
  let restDist = 0.5;
  let restSpeed = 20;
  let onRest: (() => void) | null = null;

  function animateTo(
    target: Vec2,
    v: Vec2,
    response: number,
    damping: number,
    done: (() => void) | null,
    rest: [number, number] = [0.5, 20],
  ) {
    sx = makeSpring(offset.x, v.x, target.x, response, damping);
    sy = makeSpring(offset.y, v.y, target.y, response, damping);
    [restDist, restSpeed] = rest;
    onRest = done;
    if (!raf) {
      lastT = performance.now();
      raf = requestAnimationFrame(tick);
    }
  }

  function tick(t: number) {
    raf = 0;
    const dt = (t - lastT) / 1000;
    lastT = t;
    if (!sx || !sy) return;
    const moveX = stepSpring(sx, dt, restDist, restSpeed);
    const moveY = stepSpring(sy, dt, restDist, restSpeed);
    offset.x = sx.x;
    offset.y = sy.x;
    paint();
    if (moveX || moveY) {
      raf = requestAnimationFrame(tick);
    } else {
      sx = sy = null;
      const cb = onRest;
      onRest = null;
      cb?.();
    }
  }

  function stopAnim() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    sx = sy = null;
    onRest = null;
  }

  /** Back at rest and untouched: drop the compositing hints. */
  function idle() {
    if (!offset.x && !offset.y && !raf && !gesture) panel.style.willChange = '';
  }

  // --- transitions ---

  /** Pin panel and chip to corner `i` and make it the new zero. Only valid
   *  when the panel is at rest exactly on that corner (or hidden): the CSS
   *  re-anchor and the cleared transform land on the same rect. */
  function setCorner(i: number) {
    corner = i;
    try {
      localStorage.setItem(CORNER_KEY, String(i));
    } catch {} // private mode: the corner just won't stick across visits
    pin(panel, i);
    pin(chip, i);
    offset.x = 0;
    offset.y = 0;
    panel.style.transform = '';
    panel.style.opacity = '';
  }

  function finishDismiss(exitPos: Vec2) {
    // The chip takes the corner nearest where the panel left — which is also
    // where it will come back to.
    setCorner(nearestCorner(exitPos, geo.corners));
    hidden = true;
    panel.classList.add('is-parked');
    panel.style.visibility = 'hidden';
    panel.style.willChange = '';
    showChip();
  }

  /** Shared release decision for panel drags (touch and grip alike). */
  function releasePanel(v: Vec2, startOffset: Vec2) {
    const { rest, w, h, vw, vh, corners } = geo;
    const pos = { x: rest.x + offset.x, y: rest.y + offset.y };
    const edge = dismissEdge(project(pos, v), w, h, vw, vh);
    if (edge) {
      // Drop the keyboard with the panel; the graph is what's being revealed.
      if (panel.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      const disp = { x: offset.x - startOffset.x, y: offset.y - startOffset.y };
      const dir = throwDir(v, disp, edge);
      const len = Math.hypot(dir.x, dir.y) || 1;
      exitDir = { x: dir.x / len, y: dir.y / len };
      const exit = exitRay(pos, dir, w, h, vw, vh, EXIT_PAD);
      const target = { x: exit.x - rest.x, y: exit.y - rest.y };
      if (reduceMotion.matches) {
        offset.x = target.x;
        offset.y = target.y;
        paint();
        finishDismiss(exit);
        return;
      }
      // Critically damped and quick: a thrown thing leaves fast, and any
      // overshoot would land off-screen where nobody could see it anyway.
      // Loose rest tolerances for the same reason.
      animateTo(target, v, 0.32, 1, () => finishDismiss(exit), [6, 60]);
      return;
    }
    // Not a dismissal: the projected point picks the corner (the PiP rule).
    const i = nearestCorner(project(pos, v, CORNER_PROJECT_S), corners);
    const target = { x: corners[i].x - rest.x, y: corners[i].y - rest.y };
    if (reduceMotion.matches) {
      offset.x = target.x;
      offset.y = target.y;
      paint();
      setCorner(i);
      idle();
      return;
    }
    // A glide with a lively arrival bounce; the finger's speed carries in.
    animateTo(target, v, 0.45, 0.7, () => {
      setCorner(i);
      idle();
    });
  }

  function present() {
    if (!hidden) return;
    hideChip();
    hidden = false;
    panel.classList.remove('is-parked');
    panel.style.visibility = '';
    geo = measure(); // offset is (0,0) while parked, so this reads the rest box
    const parked = exitRay(geo.rest, exitDir, geo.w, geo.h, geo.vw, geo.vh, EXIT_PAD);
    offset.x = parked.x - geo.rest.x;
    offset.y = parked.y - geo.rest.y;
    if (reduceMotion.matches) {
      offset.x = 0;
      offset.y = 0;
      paint();
      return;
    }
    panel.style.willChange = 'transform, opacity';
    paint();
    animateTo({ x: 0, y: 0 }, { x: 0, y: 0 }, 0.42, 0.6, idle);
  }

  /** A handle tap parks the panel beyond its pinned horizontal edge. */
  function dismiss() {
    if (hidden || gesture) return;
    stopAnim();
    if (panel.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    geo = measure();
    exitDir = { x: corner % 2 === 1 ? 1 : -1, y: 0 };
    const pos = { x: geo.rest.x + offset.x, y: geo.rest.y + offset.y };
    const exit = exitRay(pos, exitDir, geo.w, geo.h, geo.vw, geo.vh, EXIT_PAD);
    const target = { x: exit.x - geo.rest.x, y: exit.y - geo.rest.y };
    if (reduceMotion.matches) {
      finishDismiss(exit);
      return;
    }
    panel.style.willChange = 'transform, opacity';
    animateTo(target, { x: 0, y: 0 }, 0.32, 1, () => finishDismiss(exit), [6, 60]);
  }

  // --- gestures ---

  interface Gesture {
    /** Touch identifier or pointerId. */
    id: number;
    /** Pointer start, client coords. */
    x0: number;
    y0: number;
    /** Where the panel was when the pointer landed. */
    base: Vec2;
    startOffset: Vec2;
    claimed: boolean;
    /** Ceded to a scrollable or the text editor: ignore until it ends. */
    dead: boolean;
    /** Dragging the panel back in from the chip. */
    pull: boolean;
    /** Driven by pointer events on the grip/chip (mouse or pen). */
    mouse: boolean;
    fromEditor: boolean;
    scroll: { up: boolean; down: boolean } | null;
    samples: Sample[];
  }

  let gesture: Gesture | null = null;
  let suppressGripClick = false;

  /**
   * The scrollable under the touch (the equation list or the examples tree)
   * and which ways it can currently move — the input claimGesture arbitrates
   * on. First match wins: they don't nest, and overscroll-behavior keeps a
   * scroll that hits its end from chaining anywhere.
   */
  function scrollableAt(el: Element | null): { up: boolean; down: boolean } | null {
    for (let n = el; n && n !== panel.parentElement; n = n.parentElement) {
      if (n.scrollHeight > n.clientHeight + 1) {
        const oy = getComputedStyle(n).overflowY;
        if (oy === 'auto' || oy === 'scroll') {
          return { up: n.scrollTop > 0, down: n.scrollTop + n.clientHeight < n.scrollHeight - 1 };
        }
      }
    }
    return null;
  }

  /** A live selection in the editor: its iOS drag handles dispatch plain
   *  touchmoves at the text, so those touches are never ours to claim. */
  const editorSelection = (): boolean => {
    const sel = getSelection();
    return !!sel && !sel.isCollapsed && sel.anchorNode !== null && editor.contains(sel.anchorNode);
  };

  /** While focused (caret dragging, keyboard up) or holding a selection, the
   *  editor owns every touch on its text. */
  const editorOwnsTouches = (): boolean => {
    const a = document.activeElement;
    return a === editor || (!!a && editor.contains(a)) || editorSelection();
  };

  /** Pull-open space: free between the parked spot and home, rubbering past
   *  home and stopped just past the parked spot. Sign-aware — the panel may
   *  be parked off any side of the screen. */
  const shapePull = (raw: number, parked: number): number => {
    if (parked < 0) return raw >= 0 ? rubberband(raw) : Math.max(raw, parked);
    if (parked > 0) return raw <= 0 ? -rubberband(-raw) : Math.min(raw, parked);
    return Math.sign(raw) * rubberband(Math.abs(raw));
  };

  const trackedTouch = (e: TouchEvent) => {
    const g = gesture;
    if (!g) return null;
    for (const t of e.changedTouches) if (t.identifier === g.id) return t;
    return null;
  };

  function startPanelGesture(
    id: number,
    x: number,
    y: number,
    t: number,
    opts: { claimed: boolean; mouse: boolean; fromEditor: boolean; scroll: Gesture['scroll'] },
  ) {
    const flying = raf !== 0;
    if (flying) stopAnim();
    gesture = {
      id,
      x0: x,
      y0: y,
      base: { x: offset.x, y: offset.y },
      startOffset: { x: offset.x, y: offset.y },
      claimed: opts.claimed || flying, // a caught panel is already in hand
      dead: false,
      pull: false,
      mouse: opts.mouse,
      fromEditor: opts.fromEditor,
      scroll: opts.scroll,
      samples: [{ t, x, y }],
    };
    geo = measure();
    panel.style.willChange = 'transform, opacity';
  }

  // --- panel touches: drag from anywhere that isn't someone else's gesture ---

  panel.addEventListener(
    'touchstart',
    e => {
      if (hidden || gesture || e.touches.length > 1) return;
      suppressGripClick = false;
      const t = e.changedTouches[0];
      if (!(t.target instanceof Element)) return;
      // Range sliders and bound inputs own their drags outright. Buttons,
      // links and (unfocused) editor text stay grabbable: a tap on them never
      // crosses the slop, and once a swipe claims the touch no click follows.
      if (t.target.closest('input, select, textarea')) return;
      const fromEditor = editor.contains(t.target);
      if (fromEditor && editorOwnsTouches()) return; // caret/selection drags are text edits, not throws
      startPanelGesture(t.identifier, t.clientX, t.clientY, e.timeStamp, {
        claimed: false,
        mouse: false,
        fromEditor,
        scroll: scrollableAt(t.target),
      });
    },
    { passive: true },
  );

  panel.addEventListener(
    'touchmove',
    e => {
      const g = gesture;
      if (!g || g.pull || g.mouse || g.dead) return;
      const t = trackedTouch(e);
      if (!t) return;
      g.samples.push({ t: e.timeStamp, x: t.clientX, y: t.clientY });
      if (g.samples.length > 32) g.samples.shift();
      const dx = t.clientX - g.x0;
      const dy = t.clientY - g.y0;
      if (!g.claimed) {
        // A selection that appeared since the touch began (long-press mid-
        // gesture) hands the touch to its drag handles.
        if (g.fromEditor && editorSelection()) {
          g.dead = true;
          return;
        }
        const claim = claimGesture(dx, dy, g.scroll, SLOP);
        if (claim === 'undecided') return;
        if (claim === 'scroll') {
          g.dead = true;
          return;
        }
        g.claimed = true;
      }
      if (e.cancelable) e.preventDefault(); // ours: no scroll, no selection
      offset.x = g.base.x + dx;
      offset.y = g.base.y + dy;
      paint();
    },
    { passive: false },
  );

  const endPanelTouch = (e: TouchEvent) => {
    const g = gesture;
    if (!g || g.pull || g.mouse) return;
    if (!trackedTouch(e)) return;
    gesture = null;
    suppressGripClick = g.claimed || g.dead || e.type === 'touchcancel';
    if (!g.claimed || g.dead) {
      idle();
      return;
    }
    const v = e.type === 'touchcancel' ? { x: 0, y: 0 } : releaseVelocity(g.samples, e.timeStamp);
    releasePanel(v, g.startOffset);
  };
  panel.addEventListener('touchend', endPanelTouch);
  panel.addEventListener('touchcancel', endPanelTouch);

  // --- the grip: the same drag for mouse and pen ---
  //
  // Touches on the grip take the touch path above (and claim on the first
  // real move: nothing scrollable lives under it), so only non-touch
  // pointers are driven from here.

  grip.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch' || hidden || gesture || e.button !== 0) return;
    suppressGripClick = false;
    e.preventDefault(); // a drag, not a text-selection start
    startPanelGesture(e.pointerId, e.clientX, e.clientY, e.timeStamp, {
      claimed: true, // grabbing the handle is intent enough
      mouse: true,
      fromEditor: false,
      scroll: null,
    });
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {} // synthetic events have no active pointer to capture
  });

  grip.addEventListener('pointermove', e => {
    const g = gesture;
    if (!g?.mouse || g.pull || e.pointerId !== g.id) return;
    if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) >= SLOP) suppressGripClick = true;
    g.samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
    if (g.samples.length > 32) g.samples.shift();
    offset.x = g.base.x + (e.clientX - g.x0);
    offset.y = g.base.y + (e.clientY - g.y0);
    paint();
  });

  const endGrip = (e: PointerEvent) => {
    const g = gesture;
    if (!g?.mouse || g.pull || e.pointerId !== g.id) return;
    gesture = null;
    if (e.type === 'pointercancel') suppressGripClick = true;
    if (!suppressGripClick) {
      idle();
      return; // the following click hides the panel
    }
    const v = e.type === 'pointercancel' ? { x: 0, y: 0 } : releaseVelocity(g.samples, e.timeStamp);
    releasePanel(v, g.startOffset);
  };
  grip.addEventListener('pointerup', endGrip);
  grip.addEventListener('pointercancel', endGrip);
  grip.addEventListener('click', () => {
    if (suppressGripClick) {
      suppressGripClick = false;
      return;
    }
    dismiss();
  });

  // --- the chip: tap to bring the panel back, or drag to pull it in ---

  /** The drag becomes the panel: park it under the pointer and let it pull. */
  function beginPull(g: Gesture) {
    hidden = false;
    panel.classList.remove('is-parked');
    panel.style.visibility = '';
    hideChip();
    geo = measure(); // offset is (0,0) while parked, so this reads the rest box
    const parked = exitRay(geo.rest, exitDir, geo.w, geo.h, geo.vw, geo.vh, EXIT_PAD);
    g.base = { x: parked.x - geo.rest.x, y: parked.y - geo.rest.y };
    panel.style.willChange = 'transform, opacity';
  }

  function releasePull(g: Gesture, v: Vec2, cancelled: boolean) {
    const open = !cancelled && shouldOpen(offset, v, g.base);
    if (reduceMotion.matches) {
      if (open) {
        offset.x = 0;
        offset.y = 0;
        paint();
        panel.style.willChange = '';
      } else {
        offset.x = g.base.x;
        offset.y = g.base.y;
        paint();
        finishDismiss({ x: geo.rest.x + g.base.x, y: geo.rest.y + g.base.y });
      }
      return;
    }
    if (open) {
      animateTo({ x: 0, y: 0 }, v, 0.42, 0.6, idle);
    } else {
      // Not pulled far enough: park it again and bring the chip back.
      const parked = { x: geo.rest.x + g.base.x, y: geo.rest.y + g.base.y };
      animateTo(g.base, v, 0.36, 1, () => finishDismiss(parked), [6, 60]);
    }
  }

  /** Set when a mouse drag on the chip just ended: the click that follows a
   *  drag is not a tap. (Touch drags never produce that click at all.) */
  let suppressChipClick = false;

  chip.addEventListener('click', () => {
    if (suppressChipClick) {
      suppressChipClick = false;
      return;
    }
    if (gesture?.pull) return;
    present();
  });

  chip.addEventListener(
    'touchstart',
    e => {
      if (!hidden || gesture || e.touches.length > 1) return;
      const t = e.changedTouches[0];
      gesture = {
        id: t.identifier,
        x0: t.clientX,
        y0: t.clientY,
        base: { x: 0, y: 0 },
        startOffset: { x: 0, y: 0 },
        claimed: false,
        dead: false,
        pull: true,
        mouse: false,
        fromEditor: false,
        scroll: null,
        samples: [{ t: e.timeStamp, x: t.clientX, y: t.clientY }],
      };
    },
    { passive: true },
  );

  chip.addEventListener(
    'touchmove',
    e => {
      const g = gesture;
      if (!g?.pull || g.mouse) return;
      const t = trackedTouch(e);
      if (!t) return;
      g.samples.push({ t: e.timeStamp, x: t.clientX, y: t.clientY });
      if (g.samples.length > 32) g.samples.shift();
      const dx = t.clientX - g.x0;
      const dy = t.clientY - g.y0;
      if (!g.claimed) {
        if (dx * dx + dy * dy < SLOP * SLOP) return;
        g.claimed = true;
        beginPull(g);
      }
      if (e.cancelable) e.preventDefault();
      offset.x = shapePull(g.base.x + dx, g.base.x);
      offset.y = shapePull(g.base.y + dy, g.base.y);
      paint();
    },
    { passive: false },
  );

  const endChipTouch = (e: TouchEvent) => {
    const g = gesture;
    if (!g?.pull || g.mouse) return;
    if (!trackedTouch(e)) return;
    gesture = null;
    if (!g.claimed) return; // a tap: the click that follows presents
    releasePull(g, releaseVelocity(g.samples, e.timeStamp), e.type === 'touchcancel');
  };
  chip.addEventListener('touchend', endChipTouch);
  chip.addEventListener('touchcancel', endChipTouch);

  chip.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch' || !hidden || gesture || e.button !== 0) return;
    suppressChipClick = false;
    gesture = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      base: { x: 0, y: 0 },
      startOffset: { x: 0, y: 0 },
      claimed: false,
      dead: false,
      pull: true,
      mouse: true,
      fromEditor: false,
      scroll: null,
      samples: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }],
    };
    try {
      chip.setPointerCapture(e.pointerId);
    } catch {}
  });

  chip.addEventListener('pointermove', e => {
    const g = gesture;
    if (!g?.pull || !g.mouse || e.pointerId !== g.id) return;
    g.samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
    if (g.samples.length > 32) g.samples.shift();
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (!g.claimed) {
      if (dx * dx + dy * dy < SLOP * SLOP) return;
      g.claimed = true;
      beginPull(g);
    }
    offset.x = shapePull(g.base.x + dx, g.base.x);
    offset.y = shapePull(g.base.y + dy, g.base.y);
    paint();
  });

  const endChipPointer = (e: PointerEvent) => {
    const g = gesture;
    if (!g?.pull || !g.mouse || e.pointerId !== g.id) return;
    gesture = null;
    if (!g.claimed) return; // a plain click: the click event presents
    suppressChipClick = true;
    releasePull(g, releaseVelocity(g.samples, e.timeStamp), e.type === 'pointercancel');
  };
  chip.addEventListener('pointerup', endChipPointer);
  chip.addEventListener('pointercancel', endChipPointer);
}
