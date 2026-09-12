/**
 * Browser tests for the contentEditable equation editor: `pnpm test:editor`.
 *
 * The editor is the app's primary input surface and its logic (caret math,
 * state/DOM sync, widget-boundary handling) can only run in a real DOM, so it
 * is invisible to the vitest suite. This drives the actual app in headless
 * Chromium and asserts behavior end to end.
 *
 * Widget-origin cases are the reason this exists: sliders and error blocks
 * live *inside* the contentEditable as contenteditable=false widgets, so their
 * inputs bubble key and clipboard events to the editor host. Without target
 * guards those events edit whatever line the caret last touched.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

const PORT = 5197;
const ORIGIN = `http://localhost:${PORT}`;
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n      ${detail}` : ''}`);
}

/** Run a scenario; a thrown error (e.g. a widget the bug destroyed) is a failure, not a crash. */
async function scenario(label: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    check(label, false, String(err).split('\n')[0]);
  }
}

const rowTexts = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll('.eq-line')].map(l => l.textContent));

async function load(page: Page, rows: string[]) {
  // goto with only a differing hash does not reload, which would leak the
  // previous scenario's equations into the next one.
  await page.goto('about:blank');
  await page.goto(ORIGIN + '/#' + rows.map(encodeURIComponent).join(';'));
  await page.waitForSelector('.eq-line');
  await page.waitForSelector('.eq-slider input[type=range]', { timeout: 3000 }).catch(() => {});
}

/** Put the caret in a line at a character offset (mirrors user clicking). */
async function caretTo(page: Page, line: number, offset: number) {
  await page.evaluate(
    ({ line, offset }) => {
      const el = [...document.querySelectorAll('.eq-line')][line] as HTMLElement;
      el.focus();
      const node = el.firstChild ?? el;
      const r = document.createRange();
      r.setStart(node, Math.min(offset, node.textContent?.length ?? 0));
      r.collapse(true);
      const sel = getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
    },
    { line, offset },
  );
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
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });

// --- events originating in slider widgets must not edit the document ---

await load(page, ['a = 1', 'y = sin(a x)']);
await scenario('paste into slider bound', async () => {
  // Paste into a slider bound input: must reach the input, not the equations.
  const before = await rowTexts(page);
  await page.evaluate(() => {
    const min = document.querySelector<HTMLInputElement>('.eq-slider input[type=number]')!;
    min.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', '-42');
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    min.dispatchEvent(ev);
    (globalThis as { __pasteDefaultPrevented?: boolean }).__pasteDefaultPrevented = ev.defaultPrevented;
  });
  const after = await rowTexts(page);
  const prevented = await page.evaluate(
    () => (globalThis as { __pasteDefaultPrevented?: boolean }).__pasteDefaultPrevented,
  );
  check(
    'paste into slider bound does not rewrite equations',
    JSON.stringify(before) === JSON.stringify(after),
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
  );
  check('paste into slider bound is not preventDefaulted', prevented === false, `prevented=${prevented}`);
});

await scenario('Enter in slider bound', async () => {
  // Enter inside a bound input must not split an unrelated equation.
  await caretTo(page, 1, 4); // caret parked mid "y = sin(a x)"
  const before = await rowTexts(page);
  await page.evaluate(() => {
    const min = document.querySelector<HTMLInputElement>('.eq-slider input[type=number]')!;
    min.focus();
    min.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  const after = await rowTexts(page);
  check(
    'Enter in slider bound does not split a line',
    JSON.stringify(before) === JSON.stringify(after),
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
  );
});

await scenario('undo shortcut in slider bound', async () => {
  // Cmd/Ctrl+Z inside a bound input must stay native, not pop our undo stack.
  const before = await rowTexts(page);
  await page.evaluate(() => {
    const min = document.querySelector<HTMLInputElement>('.eq-slider input[type=number]')!;
    min.focus();
    min.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }),
    );
  });
  const after = await rowTexts(page);
  check(
    'undo shortcut in slider bound does not revert equations',
    JSON.stringify(before) === JSON.stringify(after),
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
  );
});

// --- normal editing still works (regression guards for the same handlers) ---

await scenario('Enter in a line splits', async () => {
  await load(page, ['a = 1', 'y = sin(a x)']);
  await caretTo(page, 1, 12); // end of "y = sin(a x)"
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('#equations')!;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  const after = await rowTexts(page);
  check('Enter in a line still splits into a new row', after.length === 3, `rows=${JSON.stringify(after)}`);
});

await scenario('paste a system', async () => {
  // Pasting a system of equations into an empty document: the headline
  // capability of the unified editor.
  await load(page, ['y = x', 'y = 2x']);
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('#equations')!;
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    const sel = getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    const dt = new DataTransfer();
    dt.setData('text/plain', 'a = 2\ny = a x^2\ny = x^3');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  const after = await rowTexts(page);
  check(
    'pasting a system into an empty document creates one row per statement',
    after.length === 3 && after[0] === 'a = 2' && after[1] === 'y = a x^2' && after[2] === 'y = x^3',
    `rows=${JSON.stringify(after)}`,
  );
});

await scenario('insertParagraph', async () => {
  // insertParagraph (mobile IME / dictation newline) must split like Enter.
  await load(page, ['y = x']);
  await caretTo(page, 0, 5);
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('#equations')!;
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true }));
  });
  const after = await rowTexts(page);
  check('insertParagraph splits the line (IME/dictation newline)', after.length === 2, `rows=${JSON.stringify(after)}`);
});

await scenario('typing syncs', async () => {
  // Typing still syncs to state and renders.
  await load(page, ['y = x']);
  await caretTo(page, 0, 5);
  await page.evaluate(() => {
    const line = document.querySelector<HTMLElement>('.eq-line')!;
    line.textContent = 'y = x^2';
    document.querySelector<HTMLElement>('#equations')!
      .dispatchEvent(new InputEvent('input', { inputType: 'insertText', bubbles: true }));
  });
  // Edits normalize the address to the /g/ path form (writeUrl), so the
  // payload lives in the pathname, not the hash.
  const url = await page.evaluate(() => decodeURIComponent(location.pathname + location.hash));
  check('typing syncs state to the URL', url.includes('y = x^2'), `url=${url}`);
});

// --- comment rows and collapsible groups ---

const visibleRows = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.eq-line')]
      .filter(l => !l.classList.contains('eq-hidden'))
      .map(l => l.textContent),
  );

/** Click a line's left gutter (chevron/color dot) via the app's pointerdown path. */
const gutterClick = (page: Page, line: number) =>
  page.evaluate(l => {
    const el = [...document.querySelectorAll<HTMLElement>('.eq-line')][l];
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 10, clientY: r.top + 10, bubbles: true, cancelable: true }));
  }, line);

await scenario('comment rows collapse their group', async () => {
  await load(page, ['# Lines', 'y=x', 'y=x^2', '# Another group', 'y=3']);
  const classed = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.eq-line')].map(l => l.classList.contains('is-comment')),
  );
  check(
    '# rows render as comments, not errors',
    JSON.stringify(classed) === JSON.stringify([true, false, false, true, false])
      && (await page.evaluate(() => document.querySelectorAll('.eq-error').length)) === 0,
    `is-comment=${JSON.stringify(classed)}`,
  );
  await gutterClick(page, 0);
  const collapsed = await visibleRows(page);
  const badge = await page.evaluate(() => document.querySelector<HTMLElement>('.eq-line')!.dataset.hidden);
  check(
    'gutter click collapses the group up to the next comment',
    JSON.stringify(collapsed) === JSON.stringify(['# Lines', '# Another group', 'y=3']) && badge === '2 hidden',
    `visible=${JSON.stringify(collapsed)} badge=${badge}`,
  );
  await gutterClick(page, 0);
  const expanded = await visibleRows(page);
  check('second gutter click expands it again', expanded.length === 5, `visible=${JSON.stringify(expanded)}`);
});

await scenario('collapsed rows still copy and share', async () => {
  await load(page, ['# Lines', 'y=x', 'y=x^2']);
  await gutterClick(page, 0);
  const url = await page.evaluate(() => decodeURIComponent(location.pathname + location.hash));
  check(
    'collapsed rows stay in the share URL',
    url.includes('y=x^2') && url.includes('# Lines'),
    `url=${url}`,
  );
});

await scenario('Enter after a collapsed heading expands it', async () => {
  await load(page, ['# Lines', 'y=x']);
  await gutterClick(page, 0);
  await caretTo(page, 0, 7); // caret at end of "# Lines"
  await page.keyboard.press('Enter');
  const visible = await visibleRows(page);
  check(
    'the new row is visible (group auto-expanded)',
    visible.length === 3,
    `visible=${JSON.stringify(visible)}`,
  );
});

await scenario('coordinate point drag persists through the URL', async () => {
  await load(page, ['r = sqrt(x^2+y^2)', 'theta = atan2(y,x)',
    '(r, theta) = (2, 0)', 'view(x = -4..4, y = -3..3)']);
  await page.mouse.move(733.33, 350);
  await page.mouse.down();
  await page.mouse.move(616.67, 233.33, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(700); // URL writes coalesce during a drag.
  const rows = await rowTexts(page);
  check('drag evaluates radius and angle at the pointer', /1\.4\d*, 0\.7\d*/.test(rows[2] ?? ''), String(rows[2]));
  await page.reload();
  await page.waitForSelector('.eq-line');
  check('coordinate drag survives reload', (await rowTexts(page))[2] === rows[2]);
});

await scenario('spiral zoom stays responsive while traces run', async () => {
  await load(page, ['r = sqrt(x^2+y^2)', 'theta = atan2(y,x)',
    '(r, theta) = (3u, 6pi u)', 'view(x = -4..4, y = -3..3)']);
  // Wait for actual green curve pixels, not merely an empty responsive grid.
  const hasCurve = () => {
    const c = document.querySelector<HTMLCanvasElement>('#overlay')!;
    const pixels = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] > 100 && pixels[i + 1] > pixels[i] + 30 && pixels[i + 1] > pixels[i + 2] + 15) return true;
    }
    return false;
  };
  await page.waitForFunction(hasCurve, undefined, { timeout: 15000 });
  const longest = await page.evaluate(async () => {
    const durations: number[] = [];
    const observer = new PerformanceObserver(list => durations.push(...list.getEntries().map(e => e.duration)));
    observer.observe({ type: 'longtask' });
    const canvas = document.querySelector('#gl')!;
    for (let i = 0; i < 60; i++) {
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: i < 30 ? -60 : 60,
        clientX: 650, clientY: 350, bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 16));
    }
    await new Promise(r => setTimeout(r, 700));
    observer.disconnect();
    return Math.max(0, ...durations);
  });
  // Generous CI smoke threshold: the previous synchronous trace stalled for
  // over a second. GPU scheduling noise should not fail this regression test.
  check('spiral scrolling has no solver-sized main-thread stalls', longest < 250, `${longest}ms`);
  await page.waitForFunction(hasCurve, undefined, { timeout: 15000 });
  check('spiral remains drawn after scrolling', true);
});

await browser.close();
server.kill();

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
