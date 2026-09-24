/** Open /color-field.test.html in the Vite dev server. These checks exercise
 * the actual parser, shader compiler and renderer, then read rendered pixels.
 * The HTML entry is deliberately excluded from production build inputs.
 */
import { analyzeRows } from '../lib/analysis.ts';
import { fullscreenQuad, glStats } from './gl.ts';
import { Renderer2D, type ColorField2D } from './render2d.ts';

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
  const render = (rows: string[], time = 0) => {
    const analysis = analyzeRows(rows);
    const colors: ColorField2D[] = [];
    for (const row of analysis.rows) {
      assert(!row.error, row.error ?? '');
      const gpu = row.gpu;
      if (gpu && (gpu.type === 'rgb2d' || gpu.type === 'hsl2d' || gpu.type === 'oklch2d')) {
        colors.push({ ...gpu, color: [0, 0, 0] });
      }
    }
    renderer.render({ cx: 0, cy: 0, upp: 0.1 }, { colors }, time, analysis.constEnv);
    assert(gl.getError() === gl.NO_ERROR, 'WebGL error');
  };
  const pixel = (x = 48, y = 48) => {
    const bytes = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    return Array.from(bytes.slice(0, 3));
  };
  const near = (actual: number[], expected: number[], tolerance = 1) =>
    assert(
      actual.every((x, k) => Math.abs(x - expected[k]) <= tolerance),
      `${actual} ≠ ${expected}`,
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
  const swatches: Array<[string, number[]]> = [
    ['rgb(1.2,-0.1,0.5)', [255, 0, 128]],
    ['hsl(0,1,0.5)', [255, 0, 0]],
    ['hsl(pi/3,1,0.5)', [255, 255, 0]],
    ['hsl(2pi/3,1,0.5)', [0, 255, 0]],
    ['hsl(pi,1,0.5)', [0, 255, 255]],
    ['hsl(4pi/3,1,0.5)', [0, 0, 255]],
    ['hsl(5pi/3,1,0.5)', [255, 0, 255]],
    ['hsl(-2pi/3,1,0.5)', [0, 0, 255]],
    ['hsl(8pi/3,1,0.5)', [0, 255, 0]],
    ['hsl(2pi/9,0,0.5)', [128, 128, 128]],
    ['hsl(0,2,0.5)', [255, 0, 0]],
    ['hsl(2pi/3,-1,0.5)', [128, 128, 128]],
    ['hsl(0,1,-1)', [0, 0, 0]],
    ['hsl(0,1,1.01)', [255, 255, 255]],
    // Independent sRGB primary reference coordinates in OKLCH.
    ['oklch(0.62795536,0.25768331,0.510227546)', [255, 0, 0]],
    ['oklch(0.86643961,0.29482724,2.487012834)', [0, 255, 0]],
    ['oklch(0.45201372,0.31321437,4.608577163)', [0, 0, 255]],
    ['oklch(0.5,0,2pi/3)', [99, 99, 99]],
    ['oklch(0.5,-2,2pi/3)', [99, 99, 99]],
    ['oklch(-1,0.4,5pi/18)', [0, 0, 0]],
    ['oklch(2,0.4,5pi/18)', [255, 255, 255]],
  ];
  for (const [row, expected] of swatches)
    check(row, () => {
      render([row]);
      near(pixel(), expected);
    });
  check('mixed color spaces keep row order and transparent pixels', () => {
    render(['rgb(1,0,0)', 'hsl({x>0:2pi/3},1,0.5)', 'oklch({y>0:0.5},0,0)']);
    near(pixel(16, 16), [255, 0, 0]);
    near(pixel(48, 16), [0, 255, 0]);
    near(pixel(16, 48), [99, 99, 99]);
    near(pixel(48, 48), [99, 99, 99]);
  });
  check('nonfinite channels are transparent before clamping', () => {
    render(['rgb(1,0,0)', 'hsl(1/0,1,0.5)', 'oklch(0.5,0/0,2pi/3)']);
    near(pixel(), [255, 0, 0]);
  });
  check('HSL responds to time', () => {
    render(['hsl(t,1,0.5)'], 0);
    near(pixel(), [255, 0, 0]);
    render(['hsl(t,1,0.5)'], (2 * Math.PI) / 3);
    near(pixel(), [0, 255, 0]);
  });
  check('sliders reuse a color shader', () => {
    render(['hue=0', 'hsl(hue,1,0.5)']);
    const count = glStats.compiles;
    render(['hue=2pi/3', 'hsl(hue,1,0.5)']);
    near(pixel(), [0, 255, 0]);
    assert(glStats.compiles === count, 'Recompiled on slider change');
  });
  check('OKLCH wraps negative and multiple-turn hue', () => {
    render(['oklch(0.7,0.1,-2pi/3)']);
    const reference = pixel();
    render(['oklch(0.7,0.1,10pi/3)']);
    near(pixel(), reference);
  });
  // Decode output pixels independently to test perceptual invariants after
  // gamut reduction, rather than repeating the forward conversion under test.
  const toLab = (rgb: number[]) => {
    const [r, g, b] = rgb.map(x => {
      const c = x / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  };
  for (const hue of [0, 60, 120, 180, 240, 300])
    check(`out-of-gamut OKLCH preserves L and hue at ${hue}°`, () => {
      render([`oklch(0.7,0.8,${hue}pi/180)`]);
      const [l, a, b] = toLab(pixel());
      const angle = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
      const difference = Math.abs(((angle - hue + 540) % 360) - 180);
      assert(Math.abs(l - 0.7) < 0.003, `Lightness drift: ${l}`);
      assert(difference < 1, `Hue drift: ${difference}°`);
      assert(Math.hypot(a, b) < 0.8, 'Chroma was not reduced');
    });
  check('very large finite chroma remains a visible mapped color', () => {
    render(['oklch(0.7,1,pi/6)']);
    const reference = pixel();
    render(['oklch(0.7,10^20,pi/6)']);
    near(pixel(), reference);
  });
  status.textContent = `${passed} passed, ${failed} failed`;
  document.title = `${failed ? 'FAIL' : 'PASS'} — Color field GPU checks`;
}
