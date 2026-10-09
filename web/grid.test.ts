/** Open /grid.test.html in the Vite dev server. These checks draw coordinate
 * fields' grids (a planar definition such as r = sqrt(x^2 + y^2) grids its
 * panel) through the real analysis, shader compiler and renderer, then read
 * rendered pixels. The HTML entry is excluded from production build inputs.
 */
import { analyzeRows } from '../lib/analysis.ts';
import { compileGridGpu } from '../lib/compiler.ts';
import { fullscreenQuad } from './gl.ts';
import { Renderer2D, type GridSpec } from './render2d.ts';
import { theme } from './theme.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true })!;
const results = document.querySelector('#results')!;
const status = document.querySelector('#status')!;
let passed = 0,
  failed = 0;
const assert = (condition: boolean, why: string) => {
  if (!condition) throw new Error(why);
};

type Spacing = Record<string, { major: number; minor: number }>;

if (!gl) status.textContent = 'FAIL: WebGL2 unavailable';
else {
  const renderer = new Renderer2D(gl, fullscreenQuad(gl));
  // By default 160 × 120 pixels at 0.2 a pixel: x from -16 to 16, y from -12 to 12.
  let view = { cx: 0, cy: 0, upp: 0.2 };
  const render = (rows: string[], spacing: Spacing, at: Partial<typeof view> = {}, height = 120) => {
    canvas.height = height;
    view = { cx: 0, cy: 0, upp: 0.2, ...at };
    const analysis = analyzeRows(rows);
    const specs: GridSpec[] = analysis.gridFields.map(f => ({ ...compileGridGpu(f), ...spacing[f.name] }));
    assert(specs.length === Object.keys(spacing).length, `grid fields: ${analysis.gridFields.map(f => f.name)}`);
    renderer.render(view, {}, 0, analysis.constEnv, specs);
    assert(gl.getError() === gl.NO_ERROR, 'WebGL error');
  };
  /** The pixel holding (x, y) in plane coordinates, and that pixel itself. */
  const pixelOf = (x: number, y: number) => [
    Math.floor(canvas.width / 2 + (x - view.cx) / view.upp),
    Math.floor(canvas.height / 2 + (y - view.cy) / view.upp),
  ];
  const read = (i: number, j: number) => {
    const bytes = new Uint8Array(4);
    gl.readPixels(i, j, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    return Array.from(bytes.slice(0, 3));
  };
  const at = (x: number, y: number) => read(...(pixelOf(x, y) as [number, number]));
  const bg = theme.bg.map(c => Math.round(c * 255));
  const ink = (px: number[]) => px.some((c, k) => Math.abs(c - bg[k]) > 15);
  const isBg = (px: number[], where: string) =>
    assert(
      px.every((c, k) => Math.abs(c - bg[k]) <= 2),
      `${where}: ${px}`,
    );
  const isInk = (px: number[], where: string) => assert(ink(px), `${where}: ${px}`);
  const check = (label: string, run: () => void) => {
    try {
      run();
      passed++;
      results.textContent += `PASS ${label}\n`;
    } catch (error) {
      failed++;
      results.textContent += `FAIL ${label}: ${String(error)}\n`;
    }
  };
  check('a field creeping toward a level does not paint its tail', () => {
    // exp(-x^2 - y^2) only approaches 0, and underflows to it: its tail's
    // distance estimate to the level 0 was a pixel or less everywhere, and
    // painted most of the panel in the axis color.
    render(['h = exp(-x^2 - y^2)'], { h: { major: 1e-14, minor: 2.5e-15 } });
    for (const [x, y] of [
      [6.1, 6.1],
      [-7.1, 3.1],
      [9.3, 0.1],
      [10.1, 2.1],
      [-14.1, -10.1],
      [3.1, -11.1],
    ])
      isBg(at(x, y), `(${x}, ${y})`);
  });
  check('level sets that do cross are drawn: circles of r, rays of an angle, its branch cut', () => {
    render(['r = sqrt(x^2 + y^2)', 'phi = atan2(y, x)'], {
      r: { major: 4, minor: 1 },
      phi: { major: Math.PI / 4, minor: Math.PI / 16 },
    });
    // Points at pixel centres (odd multiples of 0.1), on major lines.
    isInk(at(7.9, 1.3), 'r = 8');
    isInk(at(-11.9, 1.5), 'r = 12');
    isInk(at(5.3, 5.3), 'phi = π/4');
    isInk(at(-10.5, 0.1), 'phi = ±π, on the branch cut');
    isBg(at(9.5, 0.9), 'between the lines');
  });
  check('the branch cut is one line with a pixel row on it', () => {
    // An odd height puts a row of pixel centres on y = 0, where atan2 = π.
    render(
      ['r = sqrt(x^2 + y^2)', 'phi = atan2(y, x)'],
      { r: { major: 40, minor: 40 }, phi: { major: Math.PI / 4, minor: Math.PI / 16 } },
      {},
      121,
    );
    for (let i = 0; i < 70; i++) isInk(read(i, 60), `column ${i}`);
  });
  check('circles stay whole zoomed in to 1e-3 across 800 pixels', () => {
    // Rounding near a line must not read as falling short of it.
    const upp = 1e-3 / 800;
    const spacing = { major: 2e-5, minor: 5e-6 };
    render(['r = sqrt(x^2 + y^2)', 'phi = atan2(y, x)'], { r: spacing, phi: spacing }, { cx: 1, cy: 1, upp });
    const L = Math.round(Math.SQRT2 / 2e-5) * 2e-5;
    let misses = 0;
    for (let j = 0; j < 120; j++) {
      const y = 1 + (j + 0.5 - 60) * upp;
      const x = Math.sqrt(L * L - y * y);
      if (!ink(read(Math.floor(80 + (x - 1) / upp), j))) misses++;
    }
    assert(misses === 0, `${misses} of 120 rows miss r = ${L}`);
  });
  check('double roots and saddles are drawn: x y, x^2, x^2 + y^2', () => {
    render(['p = x y'], { p: { major: 4, minor: 1 } });
    for (const [i, j] of [
      [79, 59],
      [80, 60],
      [40, 60],
      [80, 20],
    ])
      isInk(read(i, j), `x y = 0 at pixel (${i}, ${j})`);
    render(['p = x^2'], { p: { major: 4, minor: 1 } });
    for (let j = 0; j < 120; j += 7) isInk(read(80, j), `x^2 = 0 at row ${j}`);
    render(['s = x^2 + y^2'], { s: { major: 40, minor: 10 } });
    isInk(read(80, 60), 'x^2 + y^2 = 0 at the origin');
  });
  check('a level at an extreme value is drawn: sin(x) = 1, x^10 = 0', () => {
    render(['q = sin(x)'], { q: { major: 0.5, minor: 0.25 } }, { upp: 0.02 });
    for (let j = 0; j < 120; j += 7) isInk(at(Math.PI / 2, -1.1 + j * 0.02), `sin(x) = 1 at row ${j}`);
    render(['q = x^10'], { q: { major: 4, minor: 1 } }, { upp: 0.02 });
    for (let j = 0; j < 120; j += 7) isInk(read(80, j), `x^10 = 0 at row ${j}`);
    isBg(read(90, 60), 'x^10 a few pixels off its root');
  });
  status.textContent = `${passed} passed, ${failed} failed`;
  document.title = `${failed ? 'FAIL' : 'PASS'} — Coordinate grid GPU checks`;
}
