/** Production sandbox smoke test. Start wrangler on 5196 after web:build. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const origin = process.env.MCP_TEST_ORIGIN ?? 'http://localhost:5196';
async function rpc(method: string, params: object = {}) {
  const res = await fetch(`${origin}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json() as any;
  assert.ok(!body.error, JSON.stringify(body.error));
  return body.result;
}
const tools = await rpc('tools/list');
const tool = tools.tools.find((t: any) => t.name === 'show_graph');
const resource = (await rpc('resources/read', { uri: tool._meta.ui.resourceUri })).contents[0];
const result = await rpc('tools/call', { name: 'show_graph', arguments: { equations: ['a = 2', 'y = a sin(x)'] } });
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.addInitScript(() => {
    const state = window as any;
    state.traceResults = [];
    state.renderFrames = 0;
    state.workersTerminated = 0;
    const clear = WebGL2RenderingContext.prototype.clear;
    WebGL2RenderingContext.prototype.clear = function(mask: number) {
      state.renderFrames++;
      return clear.call(this, mask);
    };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      terminate() { state.workersTerminated++; super.terminate(); }
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', event => state.traceResults.push(event.data));
      }
    };
    state.openai = {
      widgetState: { privateContent: {
        source: JSON.stringify(['a = 2', 'y = a sin(x)']),
        equations: ['a = 1.5', 'y = a sin(x)'],
      } },
      setWidgetState(value: unknown) { state.savedWidgetState = value; },
    };
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  // Use a public-looking origin so Chromium's local-network permission does
  // not mask the CORS/CSP behavior we are testing. Preserve server headers.
  const assetOrigin = 'https://equation-assets.test';
  await page.route(`${assetOrigin}/**`, async route => {
    const response = await page.request.get(route.request().url().replace(assetOrigin, origin));
    await route.fulfill({ response });
  });
  // A separate origin, with no nested iframe permission inside the app.
  await page.route('http://127.0.0.1:5195/**', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body style="margin:0"><iframe title="Graph" sandbox="allow-scripts allow-same-origin allow-popups" style="width:100%;height:520px;border:0"></iframe></body></html>',
  }));
  await page.goto('http://127.0.0.1:5195/');
  await page.evaluate(({ html, result, origin }) => {
    const frame = document.querySelector('iframe')!;
    const state = window as any;
    state.messages = [];
    state.sendResult = (value: unknown) => frame.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: value }, '*');
    state.sendContext = (value: unknown) => frame.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: value }, '*');
    state.sendInput = (args: unknown, partial = false) => frame.contentWindow!.postMessage({ jsonrpc: '2.0', method: `ui/notifications/tool-input${partial ? '-partial' : ''}`, params: { arguments: args } }, '*');
    window.addEventListener('message', event => {
      if (event.source !== frame.contentWindow || event.data?.jsonrpc !== '2.0') return;
      const message = event.data;
      state.messages.push(message);
      if (!message.method) return; // A response to a host request, e.g. teardown.
      let response = {};
      if (message.method === 'ui/initialize') response = {
        protocolVersion: message.params.protocolVersion,
        hostInfo: { name: 'test-host', version: '1' },
        hostCapabilities: { openLinks: {}, updateModelContext: { structuredContent: {} } },
        hostContext: {
          theme: 'dark', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'], containerDimensions: { maxHeight: 520 },
          safeAreaInsets: { top: 18, right: 12, bottom: 24, left: 16 },
          styles: { variables: { '--color-background-secondary': '#20252b', '--color-text-primary': '#ebf0f5', '--font-sans': 'Georgia, serif', '--font-mono': 'Courier New, monospace' },
            css: { fonts: '@font-face { font-family: TestHost; src: local("Arial"); }' } },
        },
      };
      if (message.method === 'ui/notifications/initialized') state.sendInput({ equations: ['a = 2', 'y = a sin('] }, true);
      if (message.method === 'ui/notifications/size-changed') frame.style.height = `${message.params.height}px`;
      if (message.method === 'ui/request-display-mode') response = { mode: state.forcedMode ?? message.params.mode };
      if (message.id !== undefined) frame.contentWindow!.postMessage({ jsonrpc: '2.0', id: message.id, result: response }, '*');
    });
    // Same resource restrictions as the declared policy; inline style is used
    // by the existing graph controls and the host bridge's sizing helpers.
    frame.srcdoc = html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${origin} blob: 'unsafe-inline'; style-src ${origin} 'unsafe-inline'; img-src ${origin} data:; worker-src blob:; connect-src 'none'; frame-src 'none'">`);
  }, { html: resource.text.replaceAll(origin, assetOrigin), result, origin: assetOrigin });
  const frame = page.frames().find(f => f !== page.mainFrame())!;
  await frame.waitForSelector('.eq-slider input[type=range]', { state: 'attached', timeout: 10000 }).catch(async error => {
    console.error({ errors, messages: await page.evaluate(() => (window as any).messages), body: await frame.locator('body').innerText() });
    throw error;
  });
  await frame.waitForFunction(() => document.querySelectorAll('.eq-line').length === 2);
  assert.ok((await frame.locator('.eq-line').last().textContent())?.includes('sin('), 'Partial arguments render before tool completion');
  assert.equal(await frame.locator('#app-status').textContent(), 'Drawing graph…');
  assert.ok(await frame.locator('#app-reset').isHidden(), 'Reset waits for a confirmed graph');
  await page.evaluate(() => (window as any).sendInput({ equations: ['a = 2', 'y = a sin(x)'] }));
  await frame.waitForFunction(() => document.getElementById('app-status')?.textContent === '');
  assert.ok((await frame.locator('.eq-line').first().textContent())?.includes('1.5'), 'Complete input restores saved edits before the result');
  await frame.evaluate(() => (window as any).earlyRow = document.querySelector('.eq-line'));
  assert.equal(await page.evaluate(() => (window as any).messages.filter((m: any) => m.method === 'ui/update-model-context').length), 0, 'Unconfirmed input is not published');
  await page.evaluate(value => (window as any).sendResult(value), result);
  await frame.waitForFunction(() => document.getElementById('app-status')?.textContent === '');
  assert.ok(await frame.evaluate(() => (window as any).earlyRow === document.querySelector('.eq-line')), 'Matching result does not rebuild the graph');
  assert.ok(await frame.locator('#panel').isHidden(), 'Embedded editor starts tucked away');
  assert.ok(await frame.locator('#panel-chip').isVisible(), 'Equation chip remains available');
  const chipBox = await frame.locator('#panel-chip').boundingBox();
  assert.ok(chipBox && chipBox.x >= 28 && chipBox.y >= 30, 'Chip respects host safe areas');
  await frame.locator('#panel-chip').click();
  await frame.locator('.eq-slider input[type=range]').waitFor();
  assert.ok(await frame.locator('#panel-chip').isHidden(), 'Opening the editor hides its chip');
  assert.equal(await frame.locator('#shot').count(), 0, 'screenshot control is site-only');
  assert.equal(await frame.locator('#rec').count(), 0, 'record control is site-only');
  assert.equal(await frame.locator('#try-another').count(), 0, 'random is site-only');
  assert.equal(await frame.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await frame.locator('#panel').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(32, 37, 43)');
  assert.match(await frame.locator('#equations').evaluate(el => getComputedStyle(el).fontFamily), /Courier New/);
  assert.match(await frame.locator('#app-toolbar').evaluate(el => getComputedStyle(el).fontFamily), /Georgia/);
  assert.ok((await frame.locator('#equation-host-fonts').textContent())?.includes('TestHost'));
  assert.equal(await frame.locator('.eq-line').count(), 2);
  assert.ok((await frame.locator('.eq-line').first().textContent())?.includes('1.5'), 'Restores edits for the original tool result');
  assert.equal(await frame.locator('#app-status').textContent(), '');
  assert.ok(await frame.locator('#app-reset').isVisible(), 'Reset is available after a confirmed graph');
  assert.ok(await frame.locator('#gl').evaluate((canvas: HTMLCanvasElement) => canvas.width > 0 && !!canvas.getContext('webgl2')));
  await frame.locator('.eq-slider input[type=range]').evaluate((input: HTMLInputElement) => {
    input.value = '3'; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => (window as any).messages.some((m: any) => m.method === 'ui/update-model-context' && m.params.structuredContent.equations[0].includes('3')));
  assert.ok(await frame.evaluate(() => (window as any).savedWidgetState.privateContent.equations[0].includes('3')));
  // A host may replay the original input after completion. It must neither
  // reset slider edits nor turn off publishing for subsequent edits.
  await frame.evaluate(() => (window as any).confirmedRow = document.querySelector('.eq-line'));
  await page.evaluate(() => (window as any).sendInput({ equations: ['a = 2', 'y = a sin(x)'] }));
  await page.waitForTimeout(100);
  assert.equal(await frame.locator('#app-status').textContent(), '');
  assert.ok(await frame.evaluate(() => (window as any).confirmedRow === document.querySelector('.eq-line')), 'Replayed input preserves the editor');
  assert.ok((await frame.locator('.eq-line').first().textContent())?.includes('3'), 'Replayed input preserves edits');
  await frame.locator('.eq-slider input[type=range]').evaluate((input: HTMLInputElement) => {
    input.value = '4'; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => (window as any).messages.some((m: any) => m.method === 'ui/update-model-context' && m.params.structuredContent.equations[0].includes('4')));
  await frame.locator('#app-reset').click();
  await frame.waitForFunction(() => document.querySelector('.eq-line')?.textContent?.includes('a = 2'));
  assert.ok((await frame.locator('.eq-line').first().textContent())?.includes('a = 2'), 'Reset restores the original tool-result equations');
  await page.waitForFunction(() => (window as any).messages.some((m: any) =>
    m.method === 'ui/update-model-context' && m.params.structuredContent.equations[0].includes('a = 2')));
  await frame.locator('#app-open').click();
  await page.waitForFunction(() => (window as any).messages.some((m: any) => m.method === 'ui/open-link'));
  await frame.locator('#app-expand').click();
  await frame.waitForFunction(() => document.getElementById('app-expand')?.textContent === 'Collapse');
  assert.equal(await frame.locator('#app-expand').textContent(), 'Collapse');
  await page.evaluate(() => (window as any).sendContext({ availableDisplayModes: ['fullscreen'] }));
  await frame.locator('#app-expand').waitFor({ state: 'hidden' });
  const beforeRequests = await page.evaluate(() => (window as any).messages.filter((m: any) => m.method === 'ui/request-display-mode').length);
  await frame.locator('#app-expand').dispatchEvent('click');
  await frame.locator('body').press('Escape');
  assert.equal(await page.evaluate(() => (window as any).messages.filter((m: any) => m.method === 'ui/request-display-mode').length), beforeRequests);
  await page.evaluate(() => (window as any).sendContext({ availableDisplayModes: ['inline'] }));
  await frame.locator('#app-expand').waitFor({ state: 'visible' });
  await frame.locator('body').press('Escape');
  await frame.waitForFunction(() => document.getElementById('app-expand')?.textContent === 'Expand');
  assert.ok(await frame.locator('#app-expand').isHidden(), 'Cannot expand when only inline is allowed');
  await page.evaluate(() => { (window as any).forcedMode = 'inline'; (window as any).sendContext({ availableDisplayModes: ['inline','fullscreen'], styles: { variables: { '--color-text-primary': '#ddeeff' } } }); });
  await frame.locator('#app-expand').click();
  await frame.waitForFunction(() => !(document.getElementById('app-expand') as HTMLButtonElement).disabled);
  assert.equal(await frame.locator('#app-expand').textContent(), 'Expand', 'Use the host-returned mode if fullscreen is declined');
  assert.equal(await frame.locator('#panel').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(32, 37, 43)', 'Partial style updates preserve existing variables');
  assert.equal(await frame.locator('#equations').evaluate(el => getComputedStyle(el).color), 'rgb(221, 238, 255)');
  await page.evaluate(() => (window as any).sendContext({ theme: 'light' }));
  await frame.waitForFunction(() => document.documentElement.dataset.theme === 'light');

  await frame.evaluate(() => (window as any).beforeCancelledPreview = document.querySelector('.eq-line'));
  await page.evaluate(() => {
    (window as any).sendInput({ equations: ['y=999'] }, true);
    document.querySelector('iframe')!.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-cancelled', params: {} }, '*');
  });
  await frame.waitForFunction(() => document.getElementById('app-status')?.textContent === 'Graph request cancelled.');
  await page.waitForTimeout(100);
  assert.ok(await frame.evaluate(() => (window as any).beforeCancelledPreview === document.querySelector('.eq-line')), 'Cancellation discards queued partial input');
  await page.evaluate(() => (window as any).sendInput({ equations: ['y=998'] }));
  await frame.waitForFunction(() => document.getElementById('app-status')?.textContent === '');
  await page.evaluate(() => (window as any).sendResult({ isError: true, content: [] }));
  await frame.waitForFunction(() => document.getElementById('app-status')?.textContent === 'Could not load this graph. Ask to try again.');
  assert.equal(await frame.locator('.eq-line').count(), 0, 'Error results clear the previewed rows');
  assert.ok(await frame.locator('#app-reset').isHidden(), 'Reset hides when the graph is cleared');

  const sphere = await rpc('tools/call', { name: 'show_graph', arguments: { equations: ['x^2+y^2+z^2=9'] } });
  await page.evaluate(value => (window as any).sendResult(value), sphere);
  await frame.waitForFunction(() => document.querySelectorAll('.eq-line').length === 1);
  // Worker-backed coordinate curve: proves blob worker creation works from
  // the foreign sandbox origin, not only ordinary 2D/3D shader rendering.
  const workerCreated = page.waitForEvent('worker');
  const curve = await rpc('tools/call', { name: 'show_graph', arguments: { equations: ['(x,y)=(u,sin(u))'] } });
  await page.evaluate(value => (window as any).sendResult(value), curve);
  await workerCreated;
  await frame.waitForFunction(() => (window as any).traceResults.some((r: any) => r.result.pts.length > 0));
  await frame.waitForFunction(() => document.querySelector('.eq-line')?.textContent?.includes('sin(u)'));
  await page.setViewportSize({ width: 390, height: 700 });
  await page.screenshot({ path: '/tmp/equation-mcp-app.png' });
  assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const animated = await rpc('tools/call', { name: 'show_graph', arguments: { equations: ['a=2', 'y=a sin(x+t)'] } });
  await page.evaluate(() => (window as any).sendInput({ equations: ['a=2', 'y=a sin(x+t)'] }));
  await frame.waitForFunction(() => document.getElementById('app-status')?.textContent === '');
  await frame.locator('.eq-slider input[type=range]').evaluate((input: HTMLInputElement) => {
    input.value = '7'; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.evaluate(value => (window as any).sendResult(value), animated);
  await frame.waitForFunction(() => document.getElementById('app-status')?.textContent === '');
  assert.ok((await frame.locator('.eq-line').first().textContent())?.includes('7'), 'Result preserves edits made during validation');
  await page.evaluate(() => document.querySelector('iframe')!.style.marginTop = '2000px');
  await page.waitForTimeout(300); // Allow the cross-frame intersection notification to settle.
  const pausedFrames = await frame.evaluate(() => (window as any).renderFrames);
  await page.waitForTimeout(350);
  assert.equal(await frame.evaluate(() => (window as any).renderFrames), pausedFrames, 'Offscreen widgets stop rendering, including the timer fallback');
  await page.evaluate(() => document.querySelector('iframe')!.style.marginTop = '0');
  await frame.waitForFunction(count => (window as any).renderFrames > count, pausedFrames);
  await page.evaluate(() => document.querySelector('iframe')!.style.marginTop = '2000px');
  await page.waitForTimeout(300);
  const beforeViewport = await frame.evaluate(() => (window as any).renderFrames);
  const viewportRows = ['a=2', 'y=a sin(x+t)', 'view(x = 100..120, y = 200..220)'];
  const viewportResult = await rpc('tools/call', { name: 'show_graph', arguments: { equations: viewportRows } });
  assert.equal(viewportResult.structuredContent.valid, true);
  await page.evaluate(value => (window as any).sendResult(value), viewportResult);
  await frame.waitForFunction(() => document.querySelectorAll('.eq-line').length === 3);
  assert.equal(await frame.evaluate(() => (window as any).renderFrames), beforeViewport, 'Incoming viewport remains unapplied while offscreen');
  await frame.locator('.eq-slider input[type=range]').evaluate((input: HTMLInputElement) => {
    input.value = '9'; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.evaluate(() => document.querySelector('iframe')!.contentWindow!.postMessage({ jsonrpc: '2.0', id: 'teardown-test', method: 'ui/resource-teardown', params: {} }, '*'));
  await page.waitForFunction(() => (window as any).messages.some((m: any) => m.id === 'teardown-test' && m.result));
  assert.ok(await frame.evaluate(() => (window as any).savedWidgetState.privateContent.equations[0].includes('9')), 'Teardown saves the last edit');
  assert.equal(await frame.evaluate(() => (window as any).savedWidgetState.privateContent.equations[2]), viewportRows[2], 'Teardown preserves an unapplied viewport in widget state');
  const publishedRows = await page.evaluate(() => (window as any).messages.filter((m: any) => m.method === 'ui/update-model-context').at(-1).params.structuredContent.equations);
  assert.equal(publishedRows[2], viewportRows[2], 'Teardown preserves an unapplied viewport in model context');
  assert.ok(await frame.evaluate(() => (window as any).workersTerminated >= 1), 'Teardown terminates the curve worker');
  const disposedFrames = await frame.evaluate(() => (window as any).renderFrames);
  await page.evaluate(value => (window as any).sendResult(value), sphere);
  await page.evaluate(() => { (window as any).sendInput({ equations: ['y=x'] }, true); (window as any).sendInput({ equations: ['y=x'] }); });
  await page.setViewportSize({ width: 500, height: 700 });
  await page.waitForTimeout(350);
  assert.equal(await frame.evaluate(() => (window as any).renderFrames), disposedFrames, 'No rendering restarts after teardown');
  assert.equal(await frame.locator('.eq-line').count(), 3, 'Late tool results are ignored');
  assert.deepEqual(errors, []);
  console.log('PASS: production UI resource, cross-origin CSP, WebGL, worker tracing, early/partial tool input, cancellation, validation errors, sliders, reset, context updates, state restoration, links, fullscreen negotiation, host styles, safe areas, narrow layout, visibility pause/resume, and teardown');
} finally {
  await browser.close();
}
