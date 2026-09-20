/** Run against a production build served by wrangler dev on port 5198. */
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
  // Exercise the analytics origins without sending test traffic to Cloudflare.
  await context.route('https://static.cloudflareinsights.com/**', route => route.fulfill({
    contentType: 'application/javascript', body: 'window.analyticsLoaded = true;',
  }));
  await context.route('https://cloudflareinsights.com/**', route => route.fulfill({
    headers: { 'Access-Control-Allow-Origin': '*' }, body: 'ok',
  }));
  for (const path of ['/', '/about/', '/g/y%3Dx%5E2', '/implicit/']) {
    const page = await context.newPage();
    const response = await page.goto(`http://localhost:5198${path}`);
    const csp = response?.headers()['content-security-policy'] ?? '';
    assert.ok(csp, `CSP missing on ${path}`);
    assert.equal((csp.match(/default-src/g) ?? []).length, 1, `duplicate CSP on ${path}: ${csp}`);
    if (path === '/implicit/') {
      assert.match(csp, /frame-src 'self'/);
      assert.match(csp, /frame-ancestors 'none'/);
    } else if (path.startsWith('/g/')) {
      assert.match(csp, /frame-ancestors \*/);
      assert.equal(csp.includes("frame-ancestors 'none'"), false, csp);
    } else {
      assert.match(csp, /frame-ancestors 'none'/);
    }
    const themeScript = page.locator('head script[src*="/assets/theme-"]');
    assert.equal(await themeScript.count(), 1);
    for (const attribute of ['type', 'async', 'defer']) {
      assert.equal(await themeScript.getAttribute(attribute), null, `Theme must remain parser-blocking: ${attribute}`);
    }
    const themeResponse = await context.request.get(new URL((await themeScript.getAttribute('src'))!, page.url()).href);
    assert.match(themeResponse.headers()['cache-control'], /max-age=31536000.*immutable/);
    const ready = path === '/about/' ? '#gallery img'
      : path === '/implicit/' ? 'iframe#graph[src*="/g/"]'
      : '.eq-line';
    await page.waitForSelector(ready);
    if (path === '/implicit/') {
      await page.waitForFunction(() => {
        const iframe = document.querySelector<HTMLIFrameElement>('iframe#graph');
        return !!iframe?.contentDocument?.getElementById('gl');
      });
    }
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    if (path !== '/about/' && path !== '/implicit/') await page.locator('#theme-toggle').click();
    assert.deepEqual(await page.evaluate(() => (window as any).violations), []);
    await page.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://static.cloudflareinsights.com/beacon.min.js/test-version';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Analytics script blocked'));
        document.head.append(script);
      });
      await fetch('https://cloudflareinsights.com/cdn-cgi/rum');
    });
    assert.equal(await page.evaluate(() => (window as any).analyticsLoaded), true);
    assert.deepEqual(await page.evaluate(() => (window as any).violations), []);
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
    console.log(`PASS ${path}: CSP present, app/theme work, analytics allowed, inline injection blocked`);
    await page.close();
  }
} finally {
  await browser.close();
}
