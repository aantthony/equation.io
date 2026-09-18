/**
 * Tier-3 performance harness: drives the real app in headless Chromium and
 * measures what the unit layer can't — shader compiles per interaction and
 * main-thread frame health during pan/zoom/slider-drag/animation.
 *
 *   pnpm perf            compare against scripts/perf-baseline.json
 *   pnpm perf:update     rewrite the baseline with current measurements
 *
 * Two kinds of assertion:
 *  - Shader compile counts are DETERMINISTIC and machine-independent: a
 *    slider drag must compile zero new programs (constants are uniforms;
 *    ProgramCache hits by source). Any increase is a real regression.
 *  - Frame times are machine-relative smoke: they fail only at >2.5x the
 *    baseline (or +8ms), so they catch order-of-magnitude main-thread
 *    stalls, not runner noise. Re-baseline when changing CI hardware.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

const PORT = 5198;
const ORIGIN = `http://localhost:${PORT}`;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASELINE_PATH = fileURLToPath(new URL('./perf-baseline.json', import.meta.url));
const UPDATE = process.argv.includes('--update');

interface Metrics {
  compilesAfterLoad: number;
  compilesDuringAction: number;
  avgFrameMs: number;
  p95FrameMs: number;
  longFrames: number;
}

interface Scenario {
  name: string;
  rows: string[];
  /** Perform the interaction being measured; harness records around it. */
  action: (page: Page) => Promise<void>;
}

const hashUrl = (rows: string[]) => ORIGIN + '/#' + rows.map(encodeURIComponent).join(';');

async function settle(page: Page, frames = 12) {
  await page.evaluate(async n => {
    for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame);
  }, frames);
}

const compiles = (page: Page) =>
  page.evaluate(() => (globalThis as { __glStats?: { compiles: number } }).__glStats?.compiles ?? -1);

async function startRecording(page: Page) {
  await page.evaluate(() => {
    const rec = { on: true, frames: [] as number[] };
    (globalThis as { __rec?: typeof rec }).__rec = rec;
    const tick = (t: number) => {
      if (!rec.on) return;
      rec.frames.push(t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopRecording(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const rec = (globalThis as { __rec?: { on: boolean; frames: number[] } }).__rec!;
    rec.on = false;
    return rec.frames;
  });
}

async function dragOnCanvas(page: Page, dx: number, dy: number, steps: number) {
  const box = (await page.locator('#gl').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(cx + (dx * i) / steps, cy + (dy * i) / steps);
    await settle(page, 1);
  }
  await page.mouse.up();
}

async function wheelZoom(page: Page, steps: number, deltaY: number) {
  const box = (await page.locator('#gl').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, deltaY);
    await settle(page, 1);
  }
}

async function dragSlider(page: Page, steps: number) {
  await page.evaluate(async n => {
    const range = document.querySelector<HTMLInputElement>('.eq-slider input[type=range]')!;
    const lo = Number(range.min);
    const hi = Number(range.max);
    for (let i = 0; i <= n; i++) {
      range.value = String(lo + ((hi - lo) * i) / n);
      range.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(requestAnimationFrame);
    }
    range.dispatchEvent(new Event('change', { bubbles: true }));
  }, steps);
}

const SCENARIOS: Scenario[] = [
  {
    name: 'pan-2d',
    rows: ['y = sin(x) + x^2/8', 'x^2 + y^2 = 9', 'y < cos(x)'],
    action: page => dragOnCanvas(page, 260, 140, 40),
  },
  {
    name: 'zoom-2d',
    rows: ['y = sin(x) + x^2/8', 'sin(x) cos(y) = 1/3'],
    action: page => wheelZoom(page, 30, -120),
  },
  {
    name: 'slider-drag',
    rows: ['a = 1', 'y = sin(a x)', 'x^2/(a^2 + 1) + y^2 = 1'],
    action: page => dragSlider(page, 40),
  },
  {
    name: 'orbit-3d',
    rows: ['z = sin(x) cos(y)'],
    action: page => dragOnCanvas(page, 220, 120, 40),
  },
  {
    // A field whose domain is shredded turns NaN on most march steps. The
    // raymarcher refines domain edges on a per-ray budget; unbudgeted, this
    // row cost 4–5x its frame time.
    name: 'orbit-3d-shredded-domain',
    rows: ['z = sqrt(sin(20 x y))'],
    action: page => dragOnCanvas(page, 220, 120, 40),
  },
  {
    // Coordinate fields substitute in, so the chart's expressions repeat
    // through the field: rho inside phi inside the equation, per march step.
    name: 'orbit-3d-spherical-chart',
    rows: ['rho = sqrt(x^2+y^2+z^2)', 'theta = atan2(y,x)', 'phi = acos(z/rho)', 'rho = 1 + cos(3 theta) sin(2 phi)'],
    action: page => dragOnCanvas(page, 220, 120, 40),
  },
  {
    name: 'animated-t',
    rows: ['y = sin(x - t)', 'x^2 + y^2 = 4 + sin(t)'],
    action: page => settle(page, 60),
  },
  {
    // The one scenario expected to compile: Σ expands at compile time, so
    // each N is a distinct shader. Baselined at its real cost rather than
    // left uncovered, so any *increase* still trips.
    name: 'sum-slider-drag',
    rows: ['N = 3', 'y = (4/pi) sum(k=1..N, sin((2k-1)x)/(2k-1))'],
    action: page => dragSlider(page, 30),
  },
  {
    name: 'vector-field',
    rows: ['(-y, x)'],
    action: page => settle(page, 60),
  },
  {
    name: 'fractal',
    rows: ['iter(z^2 + w)'],
    action: page => wheelZoom(page, 20, -120),
  },
];

function summarize(frames: number[], compilesAfterLoad: number, compilesDuringAction: number): Metrics {
  const deltas: number[] = [];
  for (let i = 1; i < frames.length; i++) deltas.push(frames[i] - frames[i - 1]);
  deltas.sort((a, b) => a - b);
  const avg = deltas.length ? deltas.reduce((s, d) => s + d, 0) / deltas.length : 0;
  const p95 = deltas.length ? deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * 0.95))] : 0;
  return {
    compilesAfterLoad,
    compilesDuringAction,
    avgFrameMs: Math.round(avg * 100) / 100,
    p95FrameMs: Math.round(p95 * 100) / 100,
    longFrames: deltas.filter(d => d > 34).length,
  };
}

// --- run ---

const taken = await fetch(ORIGIN).then(() => true, () => false);
if (taken) throw new Error(`something is already listening on ${ORIGIN} — stop it and rerun`);

const vite = spawn(`${ROOT}node_modules/.bin/vite`, ['--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  stdio: 'ignore',
});
process.on('exit', () => vite.kill());

for (let i = 0; ; i++) {
  try {
    if ((await fetch(ORIGIN)).ok) break;
  } catch {}
  if (i > 100) throw new Error(`vite dev server did not come up on ${ORIGIN}`);
  await new Promise(r => setTimeout(r, 200));
}

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const results: Record<string, Metrics> = {};

for (const sc of SCENARIOS) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.goto(hashUrl(sc.rows));
  await page.waitForSelector('#gl');
  await settle(page, 20);
  const compilesAfterLoad = await compiles(page);
  if (compilesAfterLoad < 0) throw new Error('__glStats missing — is web/gl.ts instrumentation present?');
  await startRecording(page);
  const before = await compiles(page);
  await sc.action(page);
  const after = await compiles(page);
  const frames = await stopRecording(page);
  results[sc.name] = summarize(frames, compilesAfterLoad, after - before);
  await page.close();
  console.log(sc.name, JSON.stringify(results[sc.name]));
}

await browser.close();
vite.kill();

if (UPDATE) {
  writeFileSync(BASELINE_PATH, JSON.stringify(results, null, 2) + '\n');
  console.log(`\nbaseline written to ${BASELINE_PATH}`);
  process.exit(0);
}

let baseline: Record<string, Metrics>;
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
} catch {
  throw new Error('no baseline — run `pnpm perf:update` once and commit scripts/perf-baseline.json');
}

const failures: string[] = [];
for (const [name, m] of Object.entries(results)) {
  const b = baseline[name];
  if (!b) {
    failures.push(`${name}: no baseline entry — run pnpm perf:update`);
    continue;
  }
  if (m.compilesDuringAction > b.compilesDuringAction) {
    failures.push(
      `${name}: ${m.compilesDuringAction} shader compiles during interaction (baseline ${b.compilesDuringAction}) — a cached path is now recompiling`,
    );
  }
  if (m.compilesAfterLoad > Math.ceil(b.compilesAfterLoad * 1.5)) {
    failures.push(
      `${name}: ${m.compilesAfterLoad} compiles at load (baseline ${b.compilesAfterLoad}) — if intended, pnpm perf:update`,
    );
  }
  const frameLimit = Math.max(b.p95FrameMs * 2.5, b.p95FrameMs + 8);
  if (m.p95FrameMs > frameLimit) {
    failures.push(`${name}: p95 frame ${m.p95FrameMs}ms exceeds ${frameLimit.toFixed(1)}ms (baseline ${b.p95FrameMs}ms)`);
  }
}

if (failures.length) {
  console.error('\nPERF REGRESSIONS:\n' + failures.map(f => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log('\nall scenarios within budget');
