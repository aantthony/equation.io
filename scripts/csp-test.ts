/** Run by scripts/prod-test.ts against the production build on port 5198. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
try {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    localStorage.setItem('eq-theme', 'dark');
    (window as any).violations = [];
    document.addEventListener('securitypolicyviolation', e => {
      (window as any).violations.push(e.violatedDirective);
    });
  });
  // The analytics beacon must stay blocked; stub it so a regression is caught
  // without sending test traffic to Cloudflare.
  await context.route('https://static.cloudflareinsights.com/**', route =>
    route.fulfill({
      contentType: 'application/javascript',
      body: 'window.analyticsLoaded = true;',
    }),
  );
  await context.route('https://cloudflareinsights.com/**', route =>
    route.fulfill({
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: 'ok',
    }),
  );
  for (const path of ['/', '/about/', '/g/y%3Dx%5E2']) {
    const page = await context.newPage();
    const response = await page.goto(`http://localhost:5198${path}`);
    const csp = response?.headers()['content-security-policy'] ?? '';
    assert.ok(csp, `CSP missing on ${path}`);
    assert.equal((csp.match(/default-src/g) ?? []).length, 1, `duplicate CSP on ${path}: ${csp}`);
    if (path.startsWith('/g/')) {
      assert.match(csp, /frame-ancestors \*/);
      assert.equal(csp.includes("frame-ancestors 'none'"), false, csp);
    } else {
      assert.match(csp, /frame-ancestors 'none'/);
    }
    // The classic pre-paint script, not the theme.ts module chunk that shares its name.
    const themeScript = page.locator('head script[src*="/assets/theme-"]:not([type="module"])');
    assert.equal(await themeScript.count(), 1);
    for (const attribute of ['type', 'async', 'defer']) {
      assert.equal(await themeScript.getAttribute(attribute), null, `Theme must remain parser-blocking: ${attribute}`);
    }
    const themeResponse = await context.request.get(new URL((await themeScript.getAttribute('src'))!, page.url()).href);
    assert.match(themeResponse.headers()['cache-control'], /max-age=31536000.*immutable/);
    const ready = path === '/about/' ? '#gallery img' : '.eq-line';
    await page.waitForSelector(ready);
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    if (path !== '/about/') await page.locator('#theme-toggle').click();
    assert.deepEqual(await page.evaluate(() => (window as any).violations), []);
    const beacon = await page.evaluate(
      () =>
        new Promise<string>(resolve => {
          const script = document.createElement('script');
          script.src = 'https://static.cloudflareinsights.com/beacon.min.js/test-version';
          script.onload = () => resolve('loaded');
          script.onerror = () => resolve('blocked');
          document.head.append(script);
        }),
    );
    assert.equal(beacon, 'blocked');
    assert.equal(await page.evaluate(() => (window as any).analyticsLoaded), undefined);
    await page.evaluate(() => ((window as any).violations = []));
    await page.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = 'window.injectedScriptRan = true';
      document.head.append(script);
      const el = document.createElement('div');
      el.setAttribute('style', 'color: red');
      document.body.append(el);
    });
    await page.waitForFunction(() => (window as any).violations.length >= 2);
    assert.equal(await page.evaluate(() => (window as any).injectedScriptRan), undefined);
    assert.ok((await page.evaluate(() => (window as any).violations)).includes('style-src-attr'));
    console.log(`PASS ${path}: CSP present, app/theme work, analytics and inline injection blocked`);
    await page.close();
  }
} finally {
  await browser.close();
}
