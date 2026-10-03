/** End-to-end route behaviour for /g/, landings, and API routes. */
import { describe, expect, it } from 'vitest';
import { APP_CSP, GRAPH_CSP, LANDING_CSP } from '../lib/csp.ts';
import { LANDINGS } from '../lib/landings.ts';
import { decodePayload, encodePayload } from '../lib/link.ts';
import worker, { landingMeta, shareMeta } from './index.ts';

const APP = '<!doctype html><html><head><title>Equation.io</title></head><body></body></html>';
const LANDING = `<!doctype html><html><head>
<title>Equation.io</title>
<meta name="description" content="x">
<link rel="canonical" href="https://equation.io/landing/">
<meta property="og:title" content="Equation.io">
<meta property="og:description" content="x">
<meta property="og:url" content="https://equation.io/landing/">
<meta property="og:image" content="https://equation.io/shots/hero.png">
</head><body><h1 id="h1"></h1><p class="lead" id="lead"></p><noscript></noscript></body></html>`;

function html(body: string): Response {
  const headers = new Headers({ 'content-type': 'text/html' });
  // Asset fetches inherit the catch-all _headers policy.
  headers.append('content-security-policy', APP_CSP);
  return new Response(body, { headers });
}

const env = {
  ASSETS: {
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path.startsWith('/landing')) return html(LANDING);
      return html(APP);
    },
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
  it.each([['y = sin(x)'], ['iter(z^2 + w)'], ['n = 101', 'm = [0..n(n-1)/2]', 'polyline(mod(m, n), mod(3m, n))']])(
    'uses the static site card for %j',
    (...rows) => {
      const payload = encodePayload(rows);
      const meta = Object.fromEntries(shareMeta(rows, payload, 'https://equation.io').meta);
      expect(meta['og:image']).toBe('https://equation.io/shots/hero.png');
      expect(meta['twitter:image']).toBe(meta['og:image']);
      expect(meta['twitter:card']).toBe('summary_large_image');
      expect(meta['og:image:width']).toBe('2880');
      expect(meta['og:image:height']).toBe('1800');
      expect(meta['og:url']).toBe(`https://equation.io/g/${payload}`);
      expect(meta['og:description']).toContain('Interactive graph');
    },
  );

  it('titles the card with the first equation', () => {
    expect(shareMeta(['y = sin(x)'], 'p', 'https://equation.io').title).toBe('y = sin(x) — equation.io');
    expect(shareMeta(['y = x', 'y = 2x'], 'p', 'https://equation.io').title).toBe('y = x … — equation.io');
  });
});

describe('removed OG image endpoint', () => {
  it.each([
    '/api/og/' + encodePayload(['x^2 + y^2 = 9']),
    '/api/og/' + encodePayload(['domain((w^3 - 1)/w)']),
    '/api/og/%E0%A4%A',
  ])('returns the normal API 404 for %s', async path => {
    const res = await get(path);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});

describe('intent landings', () => {
  it('redirects a missing trailing slash to the canonical path', async () => {
    const res = await get('/implicit');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://equation.io/implicit/');
  });

  it('uses the site card for landings without a dedicated screenshot', () => {
    const page = LANDINGS.find(l => l.slug === 'implicit')!;
    const { title, canonical, meta } = landingMeta(page, 'https://equation.io');
    const keys = Object.fromEntries(meta);
    expect(title).toBe('Implicit equation grapher — Equation.io');
    expect(canonical).toBe('https://equation.io/implicit/');
    expect(keys['og:image']).toBe('https://equation.io/shots/hero.png');
    expect(keys['twitter:image']).toBe(keys['og:image']);
    expect(keys['og:image:width']).toBe('2880');
    expect(keys['og:image:height']).toBe('1800');
  });

  it('keeps a dedicated static landing screenshot', () => {
    const page = LANDINGS.find(l => l.slug === 'complex')!;
    const keys = Object.fromEntries(landingMeta(page, 'https://equation.io').meta);
    expect(keys['og:image']).toBe('https://equation.io/shots/complex.png');
    expect(keys['twitter:image']).toBe(keys['og:image']);
    expect(keys['og:image:width']).toBe('1800');
    expect(keys['og:image:height']).toBe('1200');
  });

  const hasRewriter = typeof HTMLRewriter !== 'undefined';
  (hasRewriter ? it : it.skip)('injects the landing title into the shared shell', async () => {
    const res = await get('/implicit/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Implicit equation grapher — Equation.io');
    expect(html).toContain('Graph an equation without solving for y');
  });

  (hasRewriter ? it : it.skip)('replaces the inherited asset CSP with a single frame-src policy', async () => {
    const res = await get('/implicit/');
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBe(LANDING_CSP);
    expect(csp).toContain("frame-src 'self'");
    expect(csp?.match(/default-src/g)?.length).toBe(1);
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
