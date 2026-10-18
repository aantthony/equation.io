/** End-to-end route behaviour for /g/. */
import { describe, expect, it } from 'vitest';
import { APP_CSP, GRAPH_CSP } from '../lib/csp.ts';
import { decodePayload, encodePayload } from '../lib/link.ts';
import worker, { shareMeta } from './index.ts';

const APP = '<!doctype html><html><head><title>Equation.io</title></head><body></body></html>';
function html(body: string): Response {
  const headers = new Headers({ 'content-type': 'text/html' });
  // Asset fetches inherit the catch-all _headers policy.
  headers.append('content-security-policy', APP_CSP);
  return new Response(body, { headers });
}

const env = {
  ASSETS: {
    fetch: async () => html(APP),
  },
} as unknown as Env;

const get = (path: string) => worker.fetch(new Request('https://equation.io' + path), env);

describe('/.well-known files', () => {
  it.each(['/.well-known', '/.well-known/', '/.well-known/missing'])('rejects an HTML page for %s', async path => {
    const response = await get(path);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
  });

  it.each(['text/plain', 'application/json'])('preserves existing %s assets', async contentType => {
    const assets = {
      ASSETS: { fetch: async () => new Response('verification', { headers: { 'content-type': contentType } }) },
    } as unknown as Env;
    const response = await worker.fetch(new Request('https://equation.io/.well-known/openai-apps-challenge'), assets);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('verification');
  });

  it('passes the asset server’s 404 through outside the namespace', async () => {
    const missing = {
      ASSETS: {
        fetch: async () =>
          new Response('<h1>Not found</h1>', { status: 404, headers: { 'content-type': 'text/html' } }),
      },
    } as unknown as Env;
    const response = await worker.fetch(new Request('https://equation.io/some-app-path'), missing);
    expect(response.status).toBe(404);
  });
});

describe('share meta tags', () => {
  const keys = (rows: string[]) => shareMeta(rows, encodePayload(rows), 'https://equation.io').meta.map(([k]) => k);

  it('unfurls with the static site card', () => {
    const meta = Object.fromEntries(shareMeta(['y = sin(x)'], 'p', 'https://equation.io').meta);
    expect(meta['og:image']).toBe('https://equation.io/shots/hero.png');
    expect(meta['twitter:card']).toBe('summary_large_image');
    expect(Object.keys(meta)).toEqual(expect.arrayContaining(['og:title', 'og:description', 'og:url']));
  });

  it('builds share tags for a heavy graph without analyzing it', () => {
    const rows = ['n = 101', 'm = [0..n(n-1)/2]', 'polyline(mod(m, n), mod(3m, n))'];
    const started = performance.now();
    expect(keys(rows)).toContain('og:image');
    expect(performance.now() - started).toBeLessThan(50);
  });

  it('titles the card with the first equation', () => {
    expect(shareMeta(['y = sin(x)'], 'p', 'https://equation.io').title).toBe('y = sin(x) — equation.io');
    expect(shareMeta(['y = x', 'y = 2x'], 'p', 'https://equation.io').title).toBe('y = x … — equation.io');
  });
});

describe('/api/og', () => {
  it('is gone', async () => {
    expect((await get('/api/og/' + encodePayload(['x^2 + y^2 = 9']))).status).toBe(404);
  });
});

describe('frameable graph links', () => {
  it.each(['/g/', '/g/%E0%A4%A'])('makes even empty or invalid graphs frameable: %s', async path => {
    const res = await get(path);
    expect(await res.text()).toBe(APP);
    expect(res.headers.get('content-security-policy')).toBe(GRAPH_CSP);
  });

  const hasRewriter = typeof HTMLRewriter !== 'undefined';
  (hasRewriter ? it : it.skip)('preserves the frameable policy after adding share metadata', async () => {
    const res = await get('/g/' + encodePayload(['y = x^2']));
    expect(res.headers.get('content-security-policy')).toBe(GRAPH_CSP);
    expect(await res.text()).toContain('og:title');
  });
});

describe('payload round-trip', () => {
  it('survives equations containing parens', () => {
    const rows = ['f(x) = x^3 - 2x', 'y = f(x)', 'a = 2'];
    expect(decodePayload(encodePayload(rows))).toEqual(rows);
  });

  it('treats ; as a separator in either spelling, never as content', () => {
    // The documented contract (llms.txt): ';' is only the row separator and
    // never appears inside an equation. That is what lets a payload survive
    // its separator coming back encoded — the far more common case, since
    // copying a /g/ link out of the address bar can do exactly that.
    expect(decodePayload(encodePayload(['y = 1', 'z']))).toEqual(['y = 1', 'z']);
    expect(decodePayload('y%20%3D%201%3Bz')).toEqual(['y = 1', 'z']);
  });
});
