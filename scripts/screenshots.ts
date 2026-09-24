/**
 * Renders every /about/ showcase item through the real app and saves the
 * screenshots the page displays. Rerun after visual changes: `pnpm shots`.
 *
 * Boots the vite dev server, loads each item via the same `#eq;eq` URL the
 * gallery links to, waits for the scene to settle, and captures the canvas
 * (panel hidden for cards, visible for the hero).
 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { LANDINGS } from '../lib/landings.ts';
import { HERO, SHOWCASE, type ShowcaseItem, hashUrl } from '../web/about/showcase.ts';

const PORT = 5199;
const ORIGIN = `http://localhost:${PORT}`;
// Gallery shots are imported by about.ts, so Vite content-hashes them into
// assets/. The hero is the og:image and must keep a stable public URL, so it
// stays in public/shots/ (copied verbatim by Vite).
const SHOTS_DIR = fileURLToPath(new URL('../web/shots/', import.meta.url));
const HERO_DIR = fileURLToPath(new URL('../web/public/shots/', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(ORIGIN);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`vite dev server did not come up on ${ORIGIN}`);
}

mkdirSync(SHOTS_DIR, { recursive: true });
mkdirSync(HERO_DIR, { recursive: true });

// A leftover server on the port would silently serve some other checkout's
// app; refuse to shoot against anything we didn't start ourselves.
const taken = await fetch(ORIGIN).then(
  () => true,
  () => false,
);
if (taken) throw new Error(`something is already listening on ${ORIGIN} — stop it and rerun`);

// Spawn the vite binary directly (not via pnpm) so kill() reaches the server.
const vite = spawn(`${ROOT}node_modules/.bin/vite`, ['--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  stdio: 'ignore',
});
process.on('exit', () => vite.kill());

try {
  await waitForServer();
  // --enable-unsafe-swiftshader keeps WebGL2 working when headless Chromium
  // has no GPU (CI); locally the real GPU is used.
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });

  async function shoot(item: ShowcaseItem, opts: { width: number; height: number; panel: boolean; dir: string }) {
    const page = await browser.newPage({
      viewport: { width: opts.width, height: opts.height },
      deviceScaleFactor: 2,
    });
    await page.goto(ORIGIN + hashUrl(item.eqs));
    await page.waitForSelector('#gl');
    // backdrop-filter over the WebGL canvas blanks it in headless Chromium;
    // swap the panel's blur for a nearly-opaque background in shots.
    await page.addStyleTag({
      content: opts.panel
        ? '#panel { backdrop-filter: none; background: rgba(255, 255, 255, 0.97); }'
        : '#panel { display: none; }',
    });
    // Frame the shot before settling, so the wait covers the final view.
    // __eq is the app's dev-only handle; shots always run against dev.
    if (item.view) {
      await page.waitForFunction(
        () =>
          !!(window as unknown as { __eq?: unknown }).__eq &&
          (document.getElementById('gl') as HTMLCanvasElement).width > 0,
      );
      await page.evaluate(v => {
        const { view, requestRender } = (
          window as unknown as {
            __eq: { view: { cx: number; cy: number; upp: number }; requestRender: () => void };
          }
        ).__eq;
        const gl = document.getElementById('gl') as HTMLCanvasElement;
        // span is measured across the short edge, matching the app's own
        // opening-zoom convention.
        if (v.span !== undefined) view.upp = v.span / Math.min(gl.width, gl.height);
        if (v.cx !== undefined) view.cx = v.cx;
        if (v.cy !== undefined) view.cy = v.cy;
        requestRender();
      }, item.view);
    }
    // Let compilation finish and `t` reach the pose the caption describes.
    await page.waitForTimeout((item.settle ?? 0.5) * 1000);
    // Seed integral curves on vector fields / ODEs (motionless clicks).
    for (const [fx, fy] of item.clicks ?? []) {
      await page.mouse.click(fx * opts.width, fy * opts.height);
    }
    if (item.clicks?.length) await page.waitForTimeout(250);
    const path = `${opts.dir}${item.slug}.png`;
    await page.screenshot({ path });
    await page.close();
    console.log(`✓ ${item.slug} (${item.eqs.join('; ')})`);
  }

  // `pnpm shots lemniscate torus` re-renders just those slugs.
  const only = process.argv.slice(2);
  const wanted = (s: string) => only.length === 0 || only.includes(s);

  if (wanted(HERO.slug)) await shoot(HERO, { width: 1440, height: 900, panel: true, dir: HERO_DIR });
  for (const item of SHOWCASE) {
    if (wanted(item.slug)) await shoot(item, { width: 900, height: 600, panel: false, dir: SHOTS_DIR });
  }

  // Landing pages whose hero the OG renderer cannot draw need a stable PNG
  // at /shots/<slug>.png (the gallery file is content-hashed by Vite).
  for (const page of LANDINGS) {
    if (page.og !== 'shot') continue;
    if (!wanted(page.hero) && !wanted(page.slug)) continue;
    copyFileSync(`${SHOTS_DIR}${page.hero}.png`, `${HERO_DIR}${page.slug}.png`);
    console.log(`✓ ${page.slug} og shot ← ${page.hero}`);
  }

  await browser.close();
} finally {
  vite.kill();
}
