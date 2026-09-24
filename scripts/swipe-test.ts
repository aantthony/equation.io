/**
 * Browser tests for the panel fling gesture: `pnpm test:swipe`.
 *
 * The gesture code (web/panel-swipe.ts) is arbitration between native
 * behaviors — scrolling, text selection, taps, clicks — and a custom drag,
 * so unit tests of the physics (lib/fling.test.ts) cannot cover it. This
 * drives the real app in headless Chromium with CDP-synthesized *trusted*
 * input: real hit testing, real scrolling, real focus, real click
 * suppression after a swipe. Touch scenarios run on a phone-shaped page,
 * mouse scenarios on a desktop-shaped one (the grip is the mouse's drag
 * surface).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { type CDPSession, type Page, chromium } from 'playwright';

const PORT = 5198;
const ORIGIN = `http://localhost:${PORT}`;
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n      ${detail}` : ''}`);
}

async function scenario(label: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    check(label, false, String(err).split('\n')[0]);
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Pt {
  x: number;
  y: number;
}

/** Evenly spaced points from `a` to `b`, endpoints included. */
function path(a: Pt, b: Pt, steps: number): Pt[] {
  return Array.from({ length: steps + 1 }, (_, i) => ({
    x: a.x + ((b.x - a.x) * i) / steps,
    y: a.y + ((b.y - a.y) * i) / steps,
  }));
}

/**
 * One-finger drag through `pts`. Real time passes between moves, so release
 * velocity is (distance between points) / stepMs; `holdMs` pauses before
 * lifting, which zeroes it (the stall gate).
 */
async function swipe(cdp: CDPSession, pts: Pt[], { stepMs = 16, holdMs = 0 } = {}) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...pts[0], id: 1 }] });
  for (let i = 1; i < pts.length; i++) {
    await sleep(stepMs);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...pts[i], id: 1 }] });
  }
  if (holdMs) await sleep(holdMs);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** The same drag with the mouse (down, stepped moves, up). */
async function mouseDrag(page: Page, pts: Pt[], { stepMs = 16, holdMs = 0 } = {}) {
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.mouse.down();
  for (let i = 1; i < pts.length; i++) {
    await sleep(stepMs);
    await page.mouse.move(pts[i].x, pts[i].y);
  }
  if (holdMs) await sleep(holdMs);
  await page.mouse.up();
}

const panelState = (page: Page) =>
  page.evaluate(() => {
    const p = document.getElementById('panel')!;
    const chip = document.getElementById('panel-chip')!;
    return {
      visibility: getComputedStyle(p).visibility,
      transform: p.style.transform,
      chipShown: !chip.hidden && chip.classList.contains('shown'),
      pinRight: p.classList.contains('pin-right'),
      pinBottom: p.classList.contains('pin-bottom'),
      chipRight: chip.classList.contains('pin-right'),
      chipBottom: chip.classList.contains('pin-bottom'),
    };
  });

const panelRect = (page: Page) =>
  page.evaluate(() => {
    const r = document.getElementById('panel')!.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });

/** A point inside the panel's body (below the grip strip, above examples). */
const panelBody = async (page: Page, fx: number, fy: number): Promise<Pt> => {
  const r = await panelRect(page);
  return { x: r.left + r.width * fx, y: r.top + Math.max(24, r.height * fy) };
};

/** Poll until the panel reports dismissed (or settled home); throws on timeout. */
async function waitState(page: Page, want: 'hidden' | 'home', timeout = 2500) {
  const t0 = Date.now();
  for (;;) {
    const s = await panelState(page);
    if (want === 'hidden' && s.visibility === 'hidden' && s.chipShown) return;
    if (want === 'home' && s.visibility !== 'hidden' && s.transform === '' && !s.chipShown) return;
    if (Date.now() - t0 > timeout) {
      throw new Error(`timed out waiting for ${want}: ${JSON.stringify(s)}`);
    }
    await sleep(50);
  }
}

async function load(page: Page, rows: string[]) {
  await page.goto('about:blank');
  await page.goto(ORIGIN + '/#' + rows.map(encodeURIComponent).join(';'));
  await page.waitForSelector('.eq-line');
}

const server = spawn(`${ROOT}node_modules/.bin/vite`, ['--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  stdio: 'ignore',
});
process.on('exit', () => server.kill());

for (let i = 0; ; i++) {
  try {
    if ((await fetch(ORIGIN)).ok) break;
  } catch {}
  if (i > 100) throw new Error(`vite did not come up on ${ORIGIN}`);
  await new Promise(r => setTimeout(r, 200));
}

// CHROMIUM overrides the browser binary, for containers with a system build.
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
  args: ['--enable-unsafe-swiftshader'],
});
// A phone-shaped, touch-enabled page: the surface the gesture exists for.
const page = await browser.newPage({ viewport: { width: 390, height: 720 }, hasTouch: true });
const cdp = await page.context().newCDPSession(page);

// --- touch: dismissal ---

await scenario('tapping the grip hides the panel and the chip restores it', async () => {
  await load(page, ['y = sin(x)']);
  await page.tap('#panel-grip');
  await waitState(page, 'hidden');
  await page.tap('#panel-chip');
  await waitState(page, 'home');
  check('touch grip tap hides and chip tap restores', true);
});

await scenario('flick up dismisses', async () => {
  await load(page, ['y = sin(x)']);
  const from = await panelBody(page, 0.5, 0.6);
  // ~160px in ~64ms: an unambiguous flick.
  await swipe(cdp, path(from, { x: from.x, y: from.y - 160 }, 4));
  await waitState(page, 'hidden');
  check('flick up hides the panel and shows the chip', true);
});

await scenario('chip tap restores', async () => {
  await page.tap('#panel-chip');
  await waitState(page, 'home');
  check('tapping the chip springs the panel back', true);
});

await scenario('short slow drag springs back', async () => {
  const r = await panelRect(page);
  const from = await panelBody(page, 0.5, 0.7);
  // A third of the panel, slowly, resting before release: short of the
  // halfway commit point, and the rest zeroes any leftover momentum.
  await swipe(cdp, path(from, { x: from.x, y: from.y - r.height * 0.35 }, 6), { stepMs: 40, holdMs: 250 });
  await waitState(page, 'home');
  check('a hesitant drag settles back home', true);
});

await scenario('slow drag past half dismisses', async () => {
  const r = await panelRect(page);
  const from = await panelBody(page, 0.5, 0.8);
  // Past half the panel with no speed at all: still a dismissal.
  await swipe(cdp, path(from, { x: from.x, y: from.y - r.height * 0.65 }, 10), { stepMs: 40, holdMs: 250 });
  await waitState(page, 'hidden');
  check('carrying the panel past halfway dismisses without a flick', true);
  await page.tap('#panel-chip');
  await waitState(page, 'home');
});

await scenario('flick left dismisses', async () => {
  const from = await panelBody(page, 0.7, 0.5);
  await swipe(cdp, path(from, { x: from.x - 150, y: from.y }, 4));
  await waitState(page, 'hidden');
  check('flick left hides the panel too', true);
  await page.tap('#panel-chip');
  await waitState(page, 'home');
});

// --- touch: gestures that are not panel drags ---

await scenario('swipe on a scrollable list scrolls it, not the panel', async () => {
  // Enough rows that #equations overflows and owns vertical pans.
  await load(
    page,
    Array.from({ length: 40 }, (_, i) => `y = ${i + 1} x`),
  );
  const box = await page.evaluate(() => {
    const r = document.getElementById('equations')!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await swipe(cdp, path(box, { x: box.x, y: box.y - 150 }, 6));
  // Read immediately: a claimed drag would still be translated or animating.
  const s = await panelState(page);
  const scrolled = await page.evaluate(() => document.getElementById('equations')!.scrollTop);
  check(
    'the list consumed the swipe',
    s.visibility !== 'hidden' && s.transform === '' && scrolled > 0,
    `state=${JSON.stringify(s)} scrollTop=${scrolled}`,
  );
});

await scenario('focused editor keeps its touches (text selection stays draggable)', async () => {
  await load(page, ['y = sin(x)', 'y = 2x']);
  const line = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.eq-line')!;
    const r = el.getBoundingClientRect();
    return { x: r.left + 120, y: r.top + r.height / 2 };
  });
  await page.touchscreen.tap(line.x, line.y); // focus the editor (caret in)
  const focused = await page.evaluate(() => document.activeElement?.id === 'equations');
  // A swipe over the text while editing must not move the panel: on iOS the
  // same touches drag the caret and the selection handles.
  await swipe(cdp, path(line, { x: line.x - 130, y: line.y }, 5));
  const s = await panelState(page);
  check(
    'a swipe over focused text leaves the panel alone',
    focused && s.visibility !== 'hidden' && s.transform === '',
    `focused=${focused} state=${JSON.stringify(s)}`,
  );
  // The grip still works mid-edit: it is the guaranteed drag surface.
  const r = await panelRect(page);
  const grip = { x: r.left + r.width / 2, y: r.top + 8 };
  await swipe(cdp, path(grip, { x: grip.x, y: grip.y - 150 }, 4));
  await waitState(page, 'hidden');
  check('the grip still dismisses while the editor is focused', true);
  await page.tap('#panel-chip');
  await waitState(page, 'home');
});

await scenario('swipe from the gutter dismisses without recoloring', async () => {
  await load(page, ['y = x']);
  const line = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.eq-line')!;
    const r = el.getBoundingClientRect();
    return { x: r.left + 10, y: r.top + r.height / 2, color: el.style.getPropertyValue('--eq-color') };
  });
  await swipe(cdp, path({ x: line.x, y: line.y }, { x: line.x, y: line.y - 150 }, 4));
  await waitState(page, 'hidden');
  const after = await page.evaluate(() =>
    document.querySelector<HTMLElement>('.eq-line')!.style.getPropertyValue('--eq-color'),
  );
  check('gutter-origin swipe left the row color alone', after === line.color, `${line.color} -> ${after}`);
  await page.tap('#panel-chip');
  await waitState(page, 'home');
});

await scenario('gutter tap still recolors', async () => {
  const line = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.eq-line')!;
    const r = el.getBoundingClientRect();
    return { x: r.left + 10, y: r.top + r.height / 2, color: el.style.getPropertyValue('--eq-color') };
  });
  await page.touchscreen.tap(line.x, line.y);
  await sleep(100);
  const after = await page.evaluate(() =>
    document.querySelector<HTMLElement>('.eq-line')!.style.getPropertyValue('--eq-color'),
  );
  check('a plain touch tap on the dot cycles the color', after !== line.color, `stuck at ${after}`);
});

// --- touch: pull-open and catching ---

await scenario('dragging the chip pulls the panel back in', async () => {
  await load(page, ['y = sin(x)']);
  const from = await panelBody(page, 0.5, 0.6);
  await swipe(cdp, path(from, { x: from.x, y: from.y - 160 }, 4));
  await waitState(page, 'hidden');
  const chip = await page.evaluate(() => {
    const c = document.getElementById('panel-chip')!.getBoundingClientRect();
    return { x: c.left + c.width / 2, y: c.top + c.height / 2 };
  });
  // Pull well past the parked distance: the panel must follow and open.
  await swipe(cdp, path(chip, { x: chip.x, y: chip.y + 200 }, 8), { stepMs: 24 });
  await waitState(page, 'home');
  check('a pull on the chip brings the panel home', true);

  // Dismiss again and pull only a little: it must park again, chip back.
  const from2 = await panelBody(page, 0.5, 0.6);
  await swipe(cdp, path(from2, { x: from2.x, y: from2.y - 160 }, 4));
  await waitState(page, 'hidden');
  await swipe(cdp, path(chip, { x: chip.x, y: chip.y + 25 }, 5), { stepMs: 40, holdMs: 250 });
  await waitState(page, 'hidden');
  check('a timid pull lets the panel park again', true);
  await page.tap('#panel-chip');
  await waitState(page, 'home');
});

await scenario('the panel can be caught mid-flight', async () => {
  // A tall panel makes for a long flight — long enough to intercept.
  await load(
    page,
    Array.from({ length: 8 }, (_, i) => `y = x + ${i}`),
  );
  const from = await panelBody(page, 0.5, 0.7);
  // A modest flick: enough to commit the dismissal, slow enough to catch.
  await swipe(cdp, path(from, { x: from.x, y: from.y - 100 }, 6), { stepMs: 24 });
  await sleep(80); // it is now flying off, partly off-screen
  const mid = await panelRect(page);
  if (mid.top + mid.height < 40) throw new Error(`nothing left to catch: ${JSON.stringify(mid)}`);
  const grab = { x: mid.left + mid.width / 2, y: mid.top + mid.height - 25 };
  // Catch the visible sliver, shove it back toward home, rest, release.
  await swipe(cdp, path(grab, { x: grab.x, y: grab.y + 400 }, 10), { holdMs: 250 });
  await waitState(page, 'home');
  check('a touch during the exit catches the panel and can put it back', true);
});

// --- touch: corner pinning (last: the chosen corner persists) ---

await scenario('flick down pins the panel to the bottom', async () => {
  await load(page, ['y = sin(x)']);
  const from = await panelBody(page, 0.5, 0.4);
  // A firm downward flick, but nowhere near a bottom-edge dismissal.
  await swipe(cdp, path(from, { x: from.x, y: from.y + 130 }, 5), { stepMs: 20 });
  await waitState(page, 'home', 3500);
  const s = await panelState(page);
  const r = await panelRect(page);
  const vh = 720;
  check(
    'the panel glided to a bottom corner and re-anchored',
    s.pinBottom && !s.pinRight && Math.abs(r.top + r.height - (vh - 12)) < 2,
    `state=${JSON.stringify(s)} rect=${JSON.stringify(r)}`,
  );
});

await scenario('dismissing past a bottom corner parks the chip there', async () => {
  const from = await panelBody(page, 0.5, 0.6);
  await swipe(cdp, path(from, { x: from.x, y: from.y + 150 }, 4));
  await waitState(page, 'hidden');
  const s = await panelState(page);
  check('the chip took the bottom corner', s.chipBottom && !s.chipRight, JSON.stringify(s));
  await page.tap('#panel-chip');
  await waitState(page, 'home');
  const s2 = await panelState(page);
  check('the panel came back to the same corner', s2.pinBottom && !s2.pinRight, JSON.stringify(s2));
});

await scenario('the pinned corner persists across a reload', async () => {
  await page.reload();
  await page.waitForSelector('.eq-line');
  const s = await panelState(page);
  check('a reload boots the panel at its pinned corner', s.pinBottom && !s.pinRight, JSON.stringify(s));
});

// --- mouse: the grip is the drag surface ---

const desk = await browser.newPage({ viewport: { width: 1200, height: 800 } });

await scenario('clicking the grip hides the panel and the chip restores it', async () => {
  await load(desk, ['y = sin(x)']);
  await desk.click('#panel-grip');
  await waitState(desk, 'hidden');
  await desk.click('#panel-chip');
  await waitState(desk, 'home');
  check('mouse grip click hides and chip click restores', true);
});

await scenario('mouse-dragging the grip moves the panel to another corner', async () => {
  await load(desk, ['y = sin(x)']);
  const r = await panelRect(desk);
  const grip = { x: r.left + r.width / 2, y: r.top + 8 };
  // Carry it toward the bottom-right and rest before letting go — this is a
  // placement, not a throw.
  await mouseDrag(desk, path(grip, { x: 1000, y: 650 }, 10), { stepMs: 20, holdMs: 250 });
  await waitState(desk, 'home', 3500);
  const s = await panelState(desk);
  check('the panel pinned to the bottom-right', s.pinRight && s.pinBottom, JSON.stringify(s));
});

await scenario('mouse-flicking the grip off an edge dismisses', async () => {
  const r = await panelRect(desk);
  const grip = { x: r.left + r.width / 2, y: r.top + 8 };
  await mouseDrag(desk, path(grip, { x: grip.x + 220, y: grip.y }, 4));
  await waitState(desk, 'hidden');
  const s = await panelState(desk);
  check('thrown off the right edge; chip at the bottom-right', s.chipRight && s.chipBottom, JSON.stringify(s));
  await desk.click('#panel-chip');
  await waitState(desk, 'home');
  check('clicking the chip restores on desktop', true);
});

await scenario('a timid mouse pull on the chip parks again, not reopens', async () => {
  const r = await panelRect(desk);
  const grip = { x: r.left + r.width / 2, y: r.top + 8 };
  await mouseDrag(desk, path(grip, { x: grip.x + 220, y: grip.y }, 4));
  await waitState(desk, 'hidden');
  const chip = await desk.evaluate(() => {
    const c = document.getElementById('panel-chip')!.getBoundingClientRect();
    return { x: c.left + c.width / 2, y: c.top + c.height / 2 };
  });
  // A 25px mouse pull, released at rest: parks. The click that follows the
  // drag must not count as a tap and reopen it.
  await mouseDrag(desk, path(chip, { x: chip.x - 25, y: chip.y }, 4), { stepMs: 30, holdMs: 250 });
  await sleep(900);
  const s = await panelState(desk);
  check('the panel parked again after the timid pull', s.visibility === 'hidden' && s.chipShown, JSON.stringify(s));
  // And a real pull opens it.
  await mouseDrag(desk, path(chip, { x: chip.x - 240, y: chip.y - 120 }, 8), { stepMs: 20 });
  await waitState(desk, 'home');
  check('a real mouse pull on the chip opens the panel', true);
});

await browser.close();
server.kill();

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
