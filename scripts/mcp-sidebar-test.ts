/**
 * ChatGPT sidebar/panel entrypoint smoke test: the host opens the app with
 * graphing_calculator({}) in fullscreen, optionally at a deep link. Start
 * wrangler on 5196 after web:build (MCP_TEST_ORIGIN overrides).
 */
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';
import { encodePayload } from '../lib/link.ts';

const origin = process.env.MCP_TEST_ORIGIN ?? 'http://localhost:5196';
async function rpc(method: string, params: object = {}) {
  const res = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as any;
  assert.ok(!body.error, JSON.stringify(body.error));
  return body.result;
}
const tools = await rpc('tools/list');
const tool = tools.tools.find((t: any) => t.name === 'graphing_calculator');
assert.ok(tool, 'graphing_calculator is listed');
const resource = (await rpc('resources/read', { uri: tool._meta.ui.resourceUri })).contents[0];
const launch = await rpc('tools/call', { name: 'graphing_calculator', arguments: {} });
const icon = await fetch(new URL(tool.icons[0].src.replace(/^https?:\/\/[^/]+/, origin)));
assert.equal(icon.status, 200, 'sidebar icon is served');
assert.match(await icon.text(), /currentColor/, 'sidebar icon is monochrome');

const assetOrigin = 'https://equation-assets.test';
const contexts = (page: Page) =>
  page.evaluate(() =>
    (window as any).messages
      .filter((m: any) => m.method === 'ui/update-model-context')
      .map((m: any) => m.params.structuredContent.equations),
  );

/** A fullscreen-only host, as ChatGPT's sidebar is, with an optional deep link. */
async function openHost(page: Page, deepLink?: string) {
  await page.route(`${assetOrigin}/**`, async route => {
    const response = await page.request.get(route.request().url().replace(assetOrigin, origin));
    await route.fulfill({ response });
  });
  await page.route('http://127.0.0.1:5195/**', route =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body style="margin:0"><iframe title="Graph" sandbox="allow-scripts allow-same-origin allow-popups" style="width:100%;height:700px;border:0"></iframe></body></html>',
    }),
  );
  await page.goto('http://127.0.0.1:5195/');
  await page.evaluate(
    ({ html, origin, deepLink }) => {
      const frame = document.querySelector('iframe')!;
      const state = window as any;
      state.messages = [];
      const post = (method: string, params: unknown) =>
        frame.contentWindow!.postMessage({ jsonrpc: '2.0', method, params }, '*');
      state.sendResult = (value: unknown) => post('ui/notifications/tool-result', value);
      state.sendContext = (value: unknown) => post('ui/notifications/host-context-changed', value);
      window.addEventListener('message', event => {
        if (event.source !== frame.contentWindow || event.data?.jsonrpc !== '2.0') return;
        const message = event.data;
        state.messages.push(message);
        if (!message.method) return;
        let response = {};
        if (message.method === 'ui/initialize')
          response = {
            protocolVersion: message.params.protocolVersion,
            hostInfo: { name: 'test-sidebar', version: '1' },
            hostCapabilities: { openLinks: {}, updateModelContext: { structuredContent: {}, image: {} } },
            hostContext: {
              theme: 'light',
              displayMode: 'fullscreen',
              availableDisplayModes: ['fullscreen'],
              containerDimensions: { height: 700 },
              ...(deepLink ? { 'openai/deepLink': { url: deepLink } } : {}),
            },
          };
        // Entrypoints open with {} as the tool arguments.
        if (message.method === 'ui/notifications/initialized') post('ui/notifications/tool-input', { arguments: {} });
        if (message.id !== undefined)
          frame.contentWindow!.postMessage({ jsonrpc: '2.0', id: message.id, result: response }, '*');
      });
      frame.srcdoc = html.replace(
        '<head>',
        `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${origin} blob: 'unsafe-inline'; style-src ${origin} 'unsafe-inline'; img-src ${origin} data:; worker-src blob:; connect-src 'none'; frame-src 'none'">`,
      );
    },
    { html: resource.text.replaceAll(origin, assetOrigin), origin: assetOrigin, deepLink },
  );
  await page.waitForFunction(() =>
    (window as any).messages.some((m: any) => m.method === 'ui/notifications/initialized'),
  );
  return page.frames().find(f => f !== page.mainFrame())!;
}

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
try {
  const errors: string[] = [];
  const track = (page: Page) => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
  };

  // Blank launch from the sidebar: the editor is out, ready to type in.
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  track(page);
  const frame = await openHost(page);
  await page.evaluate(value => (window as any).sendResult(value), launch);
  await frame.locator('#panel').waitFor({ state: 'visible' });
  assert.equal(await frame.locator('#app-status').textContent(), '', 'No waiting message once launched');
  assert.ok(await frame.locator('#app-reset').isHidden(), 'A blank calculator has no Reset');
  assert.ok(await frame.locator('#app-expand').isHidden(), 'No Collapse when the host only offers fullscreen');
  assert.equal(await frame.locator('#app-open').getAttribute('href'), `${assetOrigin}/`, 'Blank graph links the site');
  assert.deepEqual(await contexts(page), [], 'An empty graph is not published');
  assert.equal(
    await frame.locator('.eq-line').getAttribute('data-ph'),
    'add an equation…',
    'A blank calculator shows a line to type on',
  );
  await frame.locator('#equations').click();
  await page.keyboard.type('y = x^2');
  await page.waitForFunction(() =>
    (window as any).messages.some(
      (m: any) => m.method === 'ui/update-model-context' && m.params.structuredContent.equations[0] === 'y = x^2',
    ),
  );
  assert.ok(await frame.locator('#app-reset').isHidden(), 'Typing into a blank calculator still has no Reset');
  // The picture follows once typing pauses.
  await page.waitForFunction(() =>
    (window as any).messages.some(
      (m: any) =>
        m.method === 'ui/update-model-context' &&
        m.params.structuredContent.equations[0] === 'y = x^2' &&
        m.params.content?.[0]?._meta?.['openai/title'] === 'Edited graph',
    ),
  );

  // A deep link arriving while open replaces the graph and becomes the original.
  const sine = ['a = 2', 'y = a sin(x)'];
  await page.evaluate(url => (window as any).sendContext({ 'openai/deepLink': { url } }), `/g/${encodePayload(sine)}`);
  await frame.waitForFunction(() => document.querySelectorAll('.eq-line').length === 2);
  await page.waitForFunction(
    rows => (window as any).messages.some((m: any) => JSON.stringify(m.params?.structuredContent?.equations) === rows),
    JSON.stringify(sine),
  );
  assert.ok(await frame.locator('#app-reset').isHidden(), 'A freshly opened link needs no Reset');
  // The model has never seen a linked graph, so it gets a picture of it too.
  await page.waitForFunction(() =>
    (window as any).messages.some((m: any) => m.params?.content?.[0]?._meta?.['openai/title'] === 'Graph'),
  );
  // Opening a link while open is undoable: the typed graph comes back.
  await frame.locator('.eq-line').first().click();
  await page.keyboard.press('Control+z');
  await frame.waitForFunction(
    () =>
      document.querySelectorAll('.eq-line').length === 1 &&
      document.querySelector('.eq-line')!.textContent === 'y = x^2',
  );
  await page.keyboard.press('Control+Shift+z');
  await frame.waitForFunction(() => document.querySelectorAll('.eq-line').length === 2);
  await frame.locator('.eq-slider input[type=range]').evaluate((input: HTMLInputElement) => {
    input.value = '3';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await frame.locator('#app-reset').waitFor({ state: 'visible' });
  await frame.locator('#app-reset').click();
  await frame.waitForFunction(() => document.querySelector('.eq-line')?.textContent?.includes('a = 2'));
  // A bad link keeps the graph and says so.
  await page.evaluate(() => (window as any).sendContext({ 'openai/deepLink': { url: '/g/%E0%A4%A' } }));
  await frame.waitForFunction(
    () => document.getElementById('app-status')?.textContent === 'Could not open that graph link.',
  );
  assert.equal(await frame.locator('.eq-line').count(), 2, 'A bad link leaves the graph alone');
  // A link to a page with no graph opens a blank calculator, and says so to the model.
  await page.evaluate(() => (window as any).sendContext({ 'openai/deepLink': { url: '/' } }));
  await frame.waitForFunction(
    () => document.querySelectorAll('.eq-line').length === 1 && !document.querySelector('.eq-line')!.textContent,
  );
  await page.waitForFunction(() =>
    (window as any).messages.some(
      (m: any) => m.method === 'ui/update-model-context' && m.params.structuredContent.equations.length === 0,
    ),
  );
  assert.equal(await frame.locator('#app-status').textContent(), '', 'Opening a blank link clears the error');
  await page.close();

  // Closed untouched: nothing new for the model, and no picture.
  const untouched = await browser.newPage({ viewport: { width: 900, height: 700 } });
  track(untouched);
  const untouchedFrame = await openHost(untouched);
  await untouched.evaluate(value => (window as any).sendResult(value), launch);
  await untouchedFrame.locator('#panel').waitFor({ state: 'visible' });
  await untouched.evaluate(() =>
    document
      .querySelector('iframe')!
      .contentWindow!.postMessage({ jsonrpc: '2.0', id: 'teardown', method: 'ui/resource-teardown', params: {} }, '*'),
  );
  await untouched.waitForFunction(() => (window as any).messages.some((m: any) => m.id === 'teardown' && m.result));
  assert.ok(
    !(await untouched.evaluate(() => (window as any).messages.some((m: any) => m.params?.content?.length))),
    'An untouched calculator sends no picture',
  );
  await untouched.close();

  // Opened straight at a deep link: that graph, not a blank one.
  const linked = await browser.newPage({ viewport: { width: 900, height: 700 } });
  track(linked);
  const linkedFrame = await openHost(linked, `/g/${encodePayload(['y = cos(x)'])}`);
  await linked.evaluate(value => (window as any).sendResult(value), launch);
  await linkedFrame.waitForFunction(() => document.querySelector('.eq-line')?.textContent?.includes('cos'));
  await linkedFrame.locator('#panel').waitFor({ state: 'visible' });
  await linked.waitForFunction(() =>
    (window as any).messages.some((m: any) => m.params?.structuredContent?.equations?.[0] === 'y = cos(x)'),
  );
  assert.equal(await linkedFrame.locator('.eq-line').count(), 1);
  // The panel glides in; let it settle so the screenshot shows where it rests.
  await linkedFrame.waitForFunction(() => !document.getElementById('panel')!.getAttribute('style'));
  await linked.screenshot({ path: '/tmp/equation-mcp-sidebar.png' });
  await linked.close();

  assert.deepEqual(errors, []);
  console.log(
    'PASS: sidebar entrypoint, icon, blank launch, typing, deep links (at launch, while open, undo, bad, blank), reset, pictures',
  );
} finally {
  await browser.close();
}
