/** End-to-end checks for object families, 3D CPU geometry and background traces. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('..', import.meta.url));
const origin = 'http://localhost:5198';
const server = spawn(root + 'node_modules/.bin/vite', ['--port', '5198', '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {}
    if (i > 100) throw new Error('Vite did not start');
    await new Promise(r => setTimeout(r, 200));
  }
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || undefined,
    args: ['--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    if (m.type() === 'error') {
      errors.push(m.text());
      console.error(m.text());
    }
  });
  await page.addInitScript(() => {
    // `dots`: the most points one draw call has put on screen.
    const state = { strips: 0, triangles: 0, dots: 0, family: [] as number[], sources: [] as string[] };
    (window as unknown as { objectTest: typeof state }).objectTest = state;
    const proto = WebGL2RenderingContext.prototype;
    const draw = proto.drawArrays;
    proto.drawArrays = function (mode, first, count) {
      if (mode === this.LINE_STRIP && count > 2) state.strips++;
      if (mode === this.TRIANGLES) state.triangles += count / 3;
      if (mode === this.POINTS) state.dots = Math.max(state.dots, count);
      return draw.call(this, mode, first, count);
    };
    const drawEI = proto.drawElementsInstanced;
    proto.drawElementsInstanced = function (mode, count, type, offset, primcount) {
      if (mode === this.TRIANGLES) state.triangles += (count / 3) * primcount;
      return drawEI.call(this, mode, count, type, offset, primcount);
    };
    const locations = new WeakMap<WebGLUniformLocation, string>();
    const loc = proto.getUniformLocation;
    proto.getUniformLocation = function (program, name) {
      const l = loc.call(this, program, name);
      if (l) locations.set(l, name);
      return l;
    };
    const uniform = proto.uniform1f;
    proto.uniform1f = function (l, v) {
      if (l && locations.get(l)?.includes('eqioFamilyIndex')) state.family.push(v);
      return uniform.call(this, l, v);
    };
  });
  const load = async (rows: string[]) => {
    errors.length = 0;
    await page.goto('about:blank');
    await page.goto(origin + '/#' + rows.map(encodeURIComponent).join(';'));
    await page.waitForSelector('.eq-line');
    await page.waitForTimeout(250);
    assert.deepEqual(await page.locator('.eq-error').allTextContents(), [], rows.join(';'));
  };
  await load(['A=(0,0,0)', 'B=(2,0,1)', 'C=(0,2,2)', 'polygon(A,B,C)', 'vector(A,C)']);
  await page.waitForFunction(() => (window as any).objectTest.triangles >= 2);
  await page.screenshot({ path: '/private/tmp/equation-objects-geometry.png' });
  assert.deepEqual(errors, []);
  console.log('PASS 3D points, triangle and arrow');
  // A point list in space is one batched draw of all its dots.
  await load(['([0,1],[0,1],[0,1])', '[0,1] e_x + 2 e_z']);
  await page.waitForFunction(() => (window as any).objectTest.dots === 8);
  await page.screenshot({ path: '/private/tmp/equation-objects-point-list.png' });
  assert.deepEqual(errors, []);
  console.log('PASS 3D point lists and unit vectors');
  await load(['y=[1,2,3]x']);
  await page.waitForFunction(() => [0, 1, 2].every(v => (window as any).objectTest.family.includes(v)));
  await page.screenshot({ path: '/private/tmp/equation-objects-family.png' });
  assert.deepEqual(errors, []);
  console.log('PASS family uniforms and shader draws');
  await load(['revolve([1,2])']);
  await page.waitForFunction(() => [0, 1].every(v => (window as any).objectTest.family.includes(v)));
  assert.deepEqual(errors, []);
  console.log('PASS 3D family shader uniforms');
  await load(['a_{n+1}=2a_n', 'y=a_3 x']);
  assert.deepEqual(errors, []);
  console.log('PASS recurrence shader uniforms');
  await load(["(x',y',z')=(-y,x,0.4)"]);
  await page.waitForFunction(() => (window as any).objectTest.strips > 0);
  await page.getByRole('button', { name: 'arrows', exact: true }).click();
  await page.waitForFunction(() => (window as any).objectTest.triangles > 10);
  await page.screenshot({ path: '/private/tmp/equation-objects-flow.png' });
  assert.deepEqual(errors, []);
  console.log('PASS background trajectories and arrow lattice');
  await load(['(x^2+y^2+z^2,z)=(9,1)']);
  await page.waitForFunction(() => (window as any).objectTest.strips > 0);
  assert.deepEqual(errors, []);
  console.log('PASS surface intersection continuation');
  await load(['(min(x^2+y^2+z^2,100),z)=(9,1)']);
  await page.waitForFunction(() => (window as any).objectTest.strips > 0);
  assert.deepEqual(errors, []);
  console.log('PASS finite-difference space curve');
  await load(['(x^2,y)=(1,0)']);
  await page.getByRole('button', { name: 'certify search box', exact: true }).click();
  await page.getByText(/2 certified roots; complete/).waitFor({ timeout: 15000 });
  assert.deepEqual(errors, []);
  console.log('PASS search-box certification');
  await load(['a_n=1/n', 'a_[1..10]', 'a_3', '2+2=4', 'e=2']);
  await page.getByText('Always true (4 = 4)', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS sequence values and comparison notes');
  await load(['iter({re(z)<0:re(z),im(z)})']);
  assert.deepEqual(errors, []);
  console.log('PASS piecewise iteration shader');
  const fourier = await page.evaluate(async root => {
    const { analyzeRows } = await import(`/@fs/${root}lib/analysis.ts`);
    const { evaluate } = await import(`/@fs/${root}lib/expr.ts`);
    const { diff } = await import(`/@fs/${root}lib/diff.ts`);
    const { GLSL_PRELUDE, uniformName } = await import(`/@fs/${root}lib/glsl.ts`);
    const { compileProgram, fullscreenQuad, QUAD_VERT } = await import('/gl.ts');
    const gl = document.createElement('canvas').getContext('webgl2')!;
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('Float framebuffer unavailable');
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, null);
    const target = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error('Incomplete framebuffer');
    gl.viewport(0, 0, 1, 1);
    const quad = fullscreenQuad(gl);
    const pixel = new Float32Array(4);
    const cases = [
      { rows: ['y = reconstruct(sign(sin(2pi interval(0, 1))), N)'], max: 48 },
      { rows: ['y = reconstruct((2, -3, 1, 5, -4, 0, 3, -1, 2), N, interval(-3, 4))'], max: 4 },
      { rows: ['y = reconstruct((2,-3,1,5,-4,0,3,-1,2,4,1,0,-2,5,3,1), N)'], max: 8 },
      {
        rows: ['s = interval(0, 1)', 'y = reconstruct(1+cos(8pi s)+2sin(12pi s+0.7)+0.4cos(26pi s)+sin(42pi s), N)'],
        max: 32,
      },
      { rows: ['y = reconstruct(sign(sin(2pi interval(0, 1))), N)'], max: 128 },
      { rows: ['f(s) = sign(sin(2pi s))', 'g(x) = reconstruct(f(interval(0, 1)), N)', 'y = g(2x + 0.3)'], max: 48 },
      { rows: ['y = reconstruct(sign(sin(2pi interval(0, 1))), N)'], max: 48, staticTable: true },
    ];
    let checked = 0,
      maxError = 0,
      maxSlopeError = 0;
    for (const test of cases) {
      const analyzed = analyzeRows([`N = clamp(round(1), 0, ${test.max})`, ...test.rows]);
      const row = analyzed.rows.at(-1)!;
      if (row.error) throw new Error(row.error);
      if (!row.gpu.field.includes('eq_loop_')) throw new Error('Fourier loop was not emitted');
      if (!row.gpu.graphEval) throw new Error('Fourier analytic graph evaluator was not emitted');
      const derivative = diff(row.cls.object.rhs, 'x');
      const getParameter = gl.getParameter.bind(gl);
      // Exercise the fallback for a device with too few uniform slots.
      if (test.staticTable)
        gl.getParameter = parameter => (parameter === gl.MAX_FRAGMENT_UNIFORM_VECTORS ? 0 : getParameter(parameter));
      const program = compileProgram(
        gl,
        QUAD_VERT,
        `#version 300 es
precision highp float;
uniform float u_N;
uniform float testX;
out vec4 outColor;
${GLSL_PRELUDE}
void main() { float x = testX; float reach = 0.0; vec4 signal = ${row.gpu.graphEval.glsl}; outColor = vec4(-signal.x, signal.y * ${row.gpu.graphEval.slopeScale.toExponential()}, 0.0, 1.0); }`,
      );
      gl.getParameter = getParameter;
      gl.useProgram(program);
      const nLocation = gl.getUniformLocation(program, uniformName('N'));
      const xLocation = gl.getUniformLocation(program, 'testX');
      const counts =
        test.max === 128 ? [0, 1, 2, 5, 48, 96, 127, 128] : Array.from({ length: test.max + 1 }, (_, n) => n);
      for (const N of counts) {
        gl.uniform1f(nLocation, N);
        for (const x of [-3, -0.1, 0, 0.000001, 0.125, 0.499, 0.5, 0.501, 0.9, 1, 2.37]) {
          gl.uniform1f(xLocation, x);
          quad.draw();
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, pixel);
          const expected = -evaluate(row.cls.object.rhs, { x, N });
          const error = Math.abs(pixel[0] - expected);
          maxError = Math.max(maxError, error);
          if (!(error < 0.0003 * (1 + Math.abs(expected))))
            throw new Error(`Fourier GPU mismatch: N=${N}, x=${x}, got=${pixel[0]}, expected=${expected}`);
          const expectedSlope = evaluate(derivative, { x, N });
          const slopeError = Math.abs(pixel[1] - expectedSlope);
          maxSlopeError = Math.max(maxSlopeError, slopeError);
          // Differentiation weights high bins by frequency, amplifying the
          // GPU's float32 angle/trig roundoff near cancellation points.
          if (!(slopeError < 0.02 + 0.0003 * Math.abs(expectedSlope)))
            throw new Error(`Fourier GPU slope mismatch: N=${N}, x=${x}, got=${pixel[1]}, expected=${expectedSlope}`);
          checked++;
        }
      }
      gl.deleteProgram(program);
    }
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`Fourier GPU generated WebGL error ${error}`);
    return { checked, maxError, maxSlopeError };
  }, root);
  assert.ok(fourier.checked > 1000);
  assert.deepEqual(errors, []);
  console.log(
    `PASS Fourier loop GPU/CPU parity (${fourier.checked} values/slopes, max errors ${fourier.maxError.toPrecision(3)}/${fourier.maxSlopeError.toPrecision(3)})`,
  );
  // The curve shader itself, zoomed out on harmonics it cannot resolve: the
  // analytic slope alone put pixels far above the curve's range on it.
  const streaks = await page.evaluate(async root => {
    const { analyzeRows } = await import(`/@fs/${root}lib/analysis.ts`);
    const { evaluate } = await import(`/@fs/${root}lib/expr.ts`);
    const { uniformName } = await import(`/@fs/${root}lib/glsl.ts`);
    const { compileProgram, fullscreenQuad, QUAD_VERT } = await import('/gl.ts');
    const { curveFrag } = await import('/render2d.ts');
    const size = 256;
    const gl = document.createElement('canvas').getContext('webgl2')!;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, gl.createFramebuffer());
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, size, size);
    const quad = fullscreenQuad(gl);
    /** Alpha at world points, the curve drawn at `upp` units per pixel around the origin. */
    const alphas = (rows: string[], upp: number, points: Array<[number, number]>) => {
      const a = analyzeRows(rows);
      const row = a.rows.at(-1)!;
      if (row.error) throw new Error(row.error);
      if (!row.gpu.graphEval) throw new Error('Fourier analytic graph evaluator was not emitted');
      const program = compileProgram(gl, QUAD_VERT, curveFrag(row.gpu.field, row.gpu.params, row.gpu.graphEval));
      gl.useProgram(program);
      const set = (name: string, ...v: number[]) =>
        (gl as any)[`uniform${v.length}f`](gl.getUniformLocation(program, name), ...v);
      set('uCenter', 0, 0);
      set('uUpp', upp, upp);
      set('uRes', size, size);
      set('uOrigin', 0, 0);
      set('uColor', 1, 1, 1);
      set('t', 0);
      for (const name of row.gpu.params) set(uniformName(name), a.constEnv[name]);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      quad.draw();
      const pixel = new Uint8Array(4);
      const read = points.map(([x, y]) => {
        gl.readPixels(
          Math.floor(size / 2 + x / upp),
          Math.floor(size / 2 + y / upp),
          1,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixel,
        );
        return pixel[3] / 255;
      });
      gl.deleteProgram(program);
      return { read, rhs: row.cls.object.rhs, env: a.constEnv };
    };
    const fast = alphas(
      [
        'N = clamp(round(48), 0, 48)',
        's = interval(0, 1)',
        'y = reconstruct(sin(80pi s)+sin(82pi s)+sin(84pi s)+sin(86pi s), N)',
      ],
      0.05,
      [
        [0, 5],
        [0.3, 0],
      ],
    );
    // A resolved square wave keeps its usual line: on it, and 25 px off it (both in frame).
    const square = ['N = clamp(round(5), 0, 48)', 's = interval(0, 1)', 'y = reconstruct(sign(sin(2pi s)), N)'];
    const at = evaluate(alphas(square, 0.02, []).rhs, { x: 0.25, N: 5 });
    const resolved = alphas(square, 0.02, [
      [0.25, at],
      [0.25, at + 0.5],
    ]);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`Fourier curve shader generated WebGL error ${error}`);
    return { above: fast.read[0], inside: fast.read[1], on: resolved.read[0], off: resolved.read[1] };
  }, root);
  assert.equal(streaks.above, 0, 'a pixel above an unresolved series is not drawn');
  assert.ok(streaks.inside > 0, 'the band an unresolved series fills is drawn');
  assert.ok(streaks.on > 0.5, 'a resolved series draws on its curve');
  assert.equal(streaks.off, 0, 'a resolved series draws nothing 25 px away');
  assert.deepEqual(errors, []);
  console.log('PASS Fourier curve shader rejects pixels outside an unresolved series');
} finally {
  await browser?.close();
  server.kill();
}
