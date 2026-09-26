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
} finally {
  await browser?.close();
  server.kill();
}
