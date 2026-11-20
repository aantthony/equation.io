/**
 * A picture of a graph as the site draws it, to set beside the Metal
 * renderer's (apple/EquationCore metal-shot takes the same rows, size and
 * theme):
 *
 *   node apple/tools/web-shot.ts --out web.png "y = sin(x)" "x^2 + y^2 = 9"
 *
 *   --size 800x600   the page in CSS pixels (default 800x600); the panel is hidden, so the graph fills it
 *   --scale 2        device pixels per CSS pixel (default 2)
 *   --dark           the dark theme
 *   --settle 0.8     seconds to wait before the shot (compilation, and t)
 *   --origin URL     the site (default https://equation.io; a local `pnpm web` works too)
 *
 * Shots of the live site are kept in a cache by what was asked for
 * (~/Library/Caches/equation-web-shot), so asking again costs the site
 * nothing; --fresh shoots anyway. A graph that reads t moves, so its shots
 * differ from one to the next.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const options: Record<string, string> = {};
const flags = new Set<string>();
const rows: string[] = [];
while (args.length) {
  const arg = args.shift()!;
  if (arg === '--dark' || arg === '--fresh') flags.add(arg);
  else if (['--out', '--size', '--scale', '--settle', '--origin'].includes(arg)) options[arg] = args.shift() ?? '';
  else rows.push(arg);
}
const out = options['--out'];
if (!out) throw new Error('Where to? Pass --out web.png.');
const [width, height] = (options['--size'] ?? '800x600').split('x').map(Number);
const scale = Number(options['--scale'] ?? 2);
const settle = Number(options['--settle'] ?? 0.8);
const origin = options['--origin'] ?? 'https://equation.io';
const dark = flags.has('--dark');

const cacheDir = `${homedir()}/Library/Caches/equation-web-shot`;
mkdirSync(cacheDir, { recursive: true });
const key = createHash('sha256')
  .update(JSON.stringify([origin, rows, width, height, scale, dark, settle]))
  .digest('hex')
  .slice(0, 24);
const cached = `${cacheDir}/${key}.png`;

if (flags.has('--fresh') || !existsSync(cached)) {
  // --enable-unsafe-swiftshader keeps WebGL2 working when headless Chromium has no GPU.
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
  try {
    // The site's policy forbids the style this adds to hide the panel.
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale, bypassCSP: true });
    // The app reads its theme from here before first paint (theme.js).
    await page.addInitScript(mode => localStorage.setItem('eq-theme', mode), dark ? 'dark' : 'light');
    await page.goto(`${origin}/#${rows.map(encodeURIComponent).join(';')}`);
    await page.waitForSelector('#gl');
    // Only the graph: with the panel hidden it fills the page.
    await page.addStyleTag({ content: '#panel { display: none !important; }' });
    await page.waitForTimeout(settle * 1000);
    await page.screenshot({ path: cached });
  } finally {
    await browser.close();
  }
}
copyFileSync(cached, out);
console.log(out);
