/** Run against a production build served by wrangler dev on port 5198. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const origin = 'http://localhost:5198';
const path = '/g/y%3Dx%5E2';
// Allow the cross-origin localhost fixture through Chromium's local-network check.
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--disable-features=LocalNetworkAccessChecks'] });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('requestfailed', request => console.error(request.url(), request.failure()));
  page.on('pageerror', error => console.error(error.message));
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  const response = await page.goto(origin + path);
  assert.equal(response?.status(), 200);
  const csp = response!.headers()['content-security-policy'];
  assert.match(csp, /frame-ancestors \*/);
  assert.equal((csp.match(/default-src/g) ?? []).length, 1);
  assert.match(await page.content(), /og:title/);
  await page.locator('.eq-line').first().waitFor();
  assert.equal(await page.locator('html').getAttribute('data-embed'), null);
  assert.equal(await page.locator('#panel').evaluate(el => el.classList.contains('is-parked')), false);
  assert.equal(await page.locator('#panel-links').isVisible(), true);

  // The landing page embeds the same URL as its full-editor link.
  await page.goto(origin + '/implicit/');
  const landingFrame = page.frameLocator('#graph');
  await landingFrame.locator('#panel-chip.shown').waitFor();
  assert.match((await page.locator('#graph').getAttribute('src'))!, /^\/g\//);
  assert.equal(await landingFrame.locator('#panel').evaluate(el => el.classList.contains('is-parked')), true);

  // A different host verifies frame-ancestors and cross-origin detection.
  await context.route('http://127.0.0.1:5198/embed-test-parent', route => route.fulfill({
    contentType: 'text/html',
    body: `<iframe src="${origin}${path}" width="800" height="600"></iframe>`,
  }));
  await page.goto('http://127.0.0.1:5198/embed-test-parent');
  const frame = page.frameLocator('iframe');
  await frame.locator('#panel-chip.shown').waitFor();
  assert.equal(await frame.locator('#panel').evaluate(el => el.classList.contains('is-parked')), true);
  await frame.locator('#panel-chip').click();
  await frame.locator('.eq-line').first().waitFor();
  assert.equal(await frame.locator('#panel-links').isVisible(), false);
  assert.equal(await frame.locator('#shot').isVisible(), false);
  assert.equal(await frame.locator('#theme-toggle').isVisible(), true);
  const child = page.frames().find(f => f.url().startsWith(origin))!;
  const before = child.url();
  await frame.locator('#equations').fill('y = x^3');
  await page.waitForTimeout(500);
  assert.equal(child.url(), before, 'Editing an embedded graph must not rewrite its URL');

  await page.goto(origin + '/embed/y%3Dx%5E2');
  await page.locator('.eq-line').first().waitFor();
  assert.match(page.url(), /\/g\//);
  assert.equal(await page.locator('html').getAttribute('data-embed'), null);
  console.log('PASS: direct graph, landing iframe, cross-origin iframe, editor reopening, stable embedded URL, legacy redirect');
} finally {
  await browser.close();
}
