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

if (!gl) status.textContent = 'FAIL: WebGL2 unavailable';
else {
  const renderer = new Renderer2D(gl, fullscreenQuad(gl));
  // 160 × 120 pixels at 0.2 a pixel: x from -16 to 16, y from -12 to 12.
  const upp = 0.2;
  const render = (rows: string[], spacing: Record<string, { major: number; minor: number }>) => {
    const analysis = analyzeRows(rows);
    const specs: GridSpec[] = analysis.gridFields.map(f => ({ ...compileGridGpu(f), ...spacing[f.name] }));
    assert(specs.length === Object.keys(spacing).length, `grid fields: ${analysis.gridFields.map(f => f.name)}`);
    renderer.render({ cx: 0, cy: 0, upp }, {}, 0, analysis.constEnv, specs);
    assert(gl.getError() === gl.NO_ERROR, 'WebGL error');
  };
  /** The pixel at (x, y) in plane coordinates. */
  const at = (x: number, y: number) => {
    const bytes = new Uint8Array(4);
    gl.readPixels(Math.floor(80 + x / upp), Math.floor(60 + y / upp), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    return Array.from(bytes.slice(0, 3));
  };
  const bg = theme.bg.map(c => Math.round(c * 255));
  const isBg = (px: number[], where: string) =>
    assert(
      px.every((c, k) => Math.abs(c - bg[k]) <= 2),
      `${where}: ${px}`,
    );
  const isInk = (px: number[], where: string) =>
    assert(
      px.some((c, k) => Math.abs(c - bg[k]) > 15),
      `${where}: ${px}`,
    );
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
  status.textContent = `${passed} passed, ${failed} failed`;
  document.title = `${failed ? 'FAIL' : 'PASS'} — Coordinate grid GPU checks`;
}
