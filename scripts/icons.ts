/**
 * Rasterises web/public/icon.svg into the PNG sizes the install prompts need:
 * `pnpm icons`. Rerun after editing icon.svg.
 *
 * iOS reads apple-touch-icon.png (180) for Home Screen web apps; Android reads
 * the manifest's 192/512. The maskable variant insets the artwork into the
 * safe circle Android crops to, so the sine curve survives a round mask.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = fileURLToPath(new URL('../web/public/', import.meta.url));
/** The Apple app's icon set: a full-bleed 1024 square that iPhone and iPad
 *  mask to their rounded shape, and the Mac sizes, already shaped (below). */
const APP_ICON = fileURLToPath(
  new URL('../apple/Equation/Sources/Assets.xcassets/AppIcon.appiconset/', import.meta.url),
);
const svg = readFileSync(DIR + 'icon.svg', 'utf8');

/** The icon's own backdrop, extended to fill the padding on maskable renders. */
const BG = '#171a1f';

const TARGETS = [
  { file: 'apple-touch-icon.png', size: 180, inset: 0 },
  { file: 'icon-192.png', size: 192, inset: 0 },
  { file: 'icon-512.png', size: 512, inset: 0 },
  // Android crops maskable icons to a circle inscribed in the middle 80%.
  { file: 'icon-maskable-512.png', size: 512, inset: 0.14 },
  { file: 'icon-1024.png', size: 1024, inset: 0, dir: APP_ICON },
];

/** The Mac icon set's pixel sizes (16 to 512 pt, at 1x and 2x). */
const MAC_SIZES = [16, 32, 64, 128, 256, 512, 1024];

const browser = await chromium.launch();
try {
  for (const { file, size, inset, dir = DIR } of TARGETS) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    const pad = Math.round(size * inset);
    await page.setContent(
      `<style>html,body{margin:0;background:${BG}}
       #a{width:${size}px;height:${size}px;display:grid;place-items:center}
       svg{width:${size - 2 * pad}px;height:${size - 2 * pad}px}</style>
       <div id="a">${svg}</div>`,
    );
    writeFileSync(dir + file, await page.screenshot({ omitBackground: false }));
    await page.close();
    console.log(`${file} ${size}x${size}`);
  }
  // The Mac draws app icons as they come, so they carry their own shape:
  // Apple's grid puts an 824-unit rounded square, with a soft shadow, in a
  // transparent 1024 canvas. One render per pixel size the icon set lists.
  for (const size of MAC_SIZES) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    const u = size / 1024;
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}
       #a{width:${size}px;height:${size}px;display:grid;place-items:center}
       #s{width:${824 * u}px;height:${824 * u}px;border-radius:${185 * u}px;overflow:hidden;
          box-shadow:0 ${10 * u}px ${20 * u}px rgba(0,0,0,.3)}
       svg{display:block;width:100%;height:100%}</style>
       <div id="a"><div id="s">${svg}</div></div>`,
    );
    writeFileSync(`${APP_ICON}icon-mac-${size}.png`, await page.screenshot({ omitBackground: true }));
    await page.close();
    console.log(`icon-mac-${size}.png ${size}x${size}`);
  }
} finally {
  await browser.close();
}
