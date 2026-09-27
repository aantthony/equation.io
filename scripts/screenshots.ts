/**
 * Renders every /about/ showcase item through the real app and saves the
 * screenshots the page displays. Rerun after visual changes: `pnpm shots`.
 *
 * `pnpm shots:examples` does the same for the examples menu's thumbnails,
 * shooting only examples that are new or whose rows changed since their shot
 * (web/shots/examples/manifest.json records what each was shot from). Name
 * shot paths or category slugs to reshoot those, or pass --all.
 *
 * Boots the vite dev server, loads each item via the same `#eq;eq` URL the
 * gallery links to, waits for the scene to settle, and captures the canvas
 * (panel hidden for cards, visible for the hero). Gallery and menu shots are
 * WebP, rendered once per theme: `<slug>.webp` and `<slug>.dark.webp`
 * (web/themed-shot.ts picks between them). The og:image PNGs are light only.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { LANDINGS } from '../lib/landings.ts';
import { HERO, SHOWCASE, type ShowcaseItem, hashUrl } from '../web/about/showcase.ts';
import { EXAMPLES, exampleShotPath } from '../web/examples.ts';
import { splitStatements } from '../lib/statements.ts';

// SHOTS_PORT when another checkout's dev server holds the default.
const PORT = Number(process.env.SHOTS_PORT) || 5199;
const ORIGIN = `http://localhost:${PORT}`;
// Gallery shots are imported by about.ts, so Vite content-hashes them into
// assets/. The hero and the landing og:images must keep stable public URLs,
// so they stay in public/shots/ (copied verbatim by Vite).
const SHOTS_DIR = fileURLToPath(new URL('../web/shots/', import.meta.url));
const HERO_DIR = fileURLToPath(new URL('../web/public/shots/', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Menu thumbnails: small WebP, imported by examples-menu.ts and so
// content-hashed like the gallery shots.
const EXAMPLES_DIR = fileURLToPath(new URL('../web/shots/examples/', import.meta.url));
const MANIFEST = `${EXAMPLES_DIR}manifest.json`;

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

  async function shoot(
    item: ShowcaseItem,
    opts: {
      width: number;
      height: number;
      panel: boolean;
      dir: string;
      scale?: number;
      webp?: number;
      dark?: boolean;
    },
  ) {
    const page = await browser.newPage({
      viewport: { width: opts.width, height: opts.height },
      deviceScaleFactor: opts.scale ?? 2,
      // device.clock and device.day read the wall clock: pin it, in one
      // zone, so a reshoot of an unchanged example is the same picture.
      timezoneId: 'UTC',
    });
    await page.clock.setFixedTime(new Date('2026-06-21T10:10:30Z'));
    // The app reads its theme from here before first paint (theme.js).
    await page.addInitScript(mode => localStorage.setItem('eq-theme', mode), opts.dark ? 'dark' : 'light');
    await page.goto(ORIGIN + hashUrl(item.eqs));
    await page.waitForSelector('#gl');
    // backdrop-filter over the WebGL canvas blanks it in headless Chromium;
    // swap the panel's blur for a nearly-opaque background in shots.
    const panelBg = opts.dark ? 'rgba(24, 27, 33, 0.97)' : 'rgba(255, 255, 255, 0.97)';
    await page.addStyleTag({
      content: opts.panel ? `#panel { backdrop-filter: none; background: ${panelBg}; }` : '#panel { display: none; }',
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
    const stem = `${opts.dir}${item.slug}${opts.dark ? '.dark' : ''}`;
    if (opts.webp === undefined) {
      await page.screenshot({ path: `${stem}.png` });
    } else {
      // Playwright writes only PNG and JPEG; Chromium's own encoder makes the
      // WebP, from the same page once the shot is taken.
      const png = await page.screenshot();
      const webp = await page.evaluate(
        async ([b64, quality]) => {
          const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
          const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
          let out = '';
          for (const b of new Uint8Array(await blob.arrayBuffer())) out += String.fromCharCode(b);
          return btoa(out);
        },
        [png.toString('base64'), opts.webp] as const,
      );
      const path = `${stem}.webp`;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(webp, 'base64'));
    }
    await page.close();
    console.log(`✓ ${item.slug}${opts.dark ? ' (dark)' : ''} (${item.eqs.join('; ')})`);
  }

  async function shootExamples(only: string[]) {
    const all = only.includes('--all');
    const names = only.filter(a => a !== '--all');
    const manifest: Record<string, string> = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};
    const next: Record<string, string> = {};
    const todo: ShowcaseItem[] = [];
    for (const [category, items] of EXAMPLES) {
      for (const [label, text] of items) {
        const slug = exampleShotPath(category, label);
        const named = names.some(n => slug === n || slug.startsWith(n + '/'));
        const stale =
          manifest[slug] !== text ||
          !existsSync(`${EXAMPLES_DIR}${slug}.webp`) ||
          !existsSync(`${EXAMPLES_DIR}${slug}.dark.webp`);
        // An example left unshot keeps the text its current shot was taken
        // from, so a later run still sees it as stale.
        if (slug in manifest) next[slug] = manifest[slug];
        if (all || named || (names.length === 0 && stale)) {
          next[slug] = text;
          const eqs = splitStatements(text)
            .map(r => r.trim())
            .filter(Boolean);
          // Animations and simulations get a moment to move off frame zero.
          todo.push({ slug, title: label, blurb: '', eqs, group: category, settle: 1.2 });
        }
      }
    }
    // Shots of examples that were renamed or removed.
    const current = new Set(EXAMPLES.flatMap(([c, items]) => items.map(([l]) => exampleShotPath(c, l))));
    for (const slug of Object.keys(manifest)) {
      if (current.has(slug)) continue;
      rmSync(`${EXAMPLES_DIR}${slug}.webp`, { force: true });
      rmSync(`${EXAMPLES_DIR}${slug}.dark.webp`, { force: true });
      console.log(`✗ ${slug} (removed)`);
    }
    // A few pages at a time: each mostly waits out its settle.
    const queue = todo.flatMap(item => [false, true].map(dark => ({ item, dark })));
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let job = queue.shift(); job; job = queue.shift()) {
          const { item, dark } = job;
          await shoot(item, { width: 400, height: 300, panel: false, dir: EXAMPLES_DIR, scale: 2, webp: 0.8, dark });
        }
      }),
    );
    writeFileSync(MANIFEST, JSON.stringify(next, null, 2) + '\n');
    console.log(`${todo.length} of ${current.size} example shots rendered`);
  }

  async function shootShowcase(only: string[]) {
    // `pnpm shots lemniscate torus` re-renders just those slugs.
    const wanted = (s: string) => only.length === 0 || only.includes(s);

    if (wanted(HERO.slug)) await shoot(HERO, { width: 1440, height: 900, panel: true, dir: HERO_DIR });
    const queue = SHOWCASE.filter(item => wanted(item.slug)).flatMap(item =>
      [false, true].map(dark => ({ item, dark })),
    );
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let job = queue.shift(); job; job = queue.shift()) {
          const { item, dark } = job;
          await shoot(item, { width: 900, height: 600, panel: false, dir: SHOTS_DIR, webp: 0.85, dark });
        }
      }),
    );

    // Landing pages whose hero the OG renderer cannot draw need a stable PNG
    // at /shots/<slug>.png (the gallery file is WebP and content-hashed).
    for (const page of LANDINGS) {
      if (page.og !== 'shot') continue;
      if (!wanted(page.hero) && !wanted(page.slug)) continue;
      const item = SHOWCASE.find(i => i.slug === page.hero);
      if (!item) throw new Error(`landing ${page.slug}: no showcase item "${page.hero}"`);
      await shoot({ ...item, slug: page.slug }, { width: 900, height: 600, panel: false, dir: HERO_DIR });
    }
  }

  const args = process.argv.slice(2);
  if (args[0] === '--examples') await shootExamples(args.slice(1));
  else await shootShowcase(args);

  await browser.close();
} finally {
  vite.kill();
}
