/** End-to-end route behaviour for /g/, landings, and /api/og. */
import { describe, expect, it } from 'vitest';
import { APP_CSP, GRAPH_CSP, LANDING_CSP } from '../lib/csp.ts';
import { LANDINGS } from '../lib/landings.ts';
import { decodePayload, encodePayload } from '../lib/link.ts';
import worker, { landingMeta, shareMeta } from './index.ts';
import { canRenderOg } from './og.ts';

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

function html(body: string, extraCsp?: string): Response {
  const headers = new Headers({ 'content-type': 'text/html' });
  // Simulate Cloudflare joining /* with a more specific _headers block.
  headers.append('content-security-policy', APP_CSP);
  if (extraCsp) headers.append('content-security-policy', extraCsp);
  return new Response(body, { headers });
}

const env = {
  ASSETS: {
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path.startsWith('/landing')) return html(LANDING, LANDING_CSP);
      return html(APP);
    },
  },
} as unknown as Env;

const get = (path: string) => worker.fetch(new Request('https://equation.io' + path), env);

describe('/.well-known files', () => {
  it.each(['/.well-known', '/.well-known/', '/.well-known/missing'])('rejects the SPA fallback for %s', async (path) => {
    const response = await get(path);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
  });

  it.each(['text/plain', 'application/json'])('preserves existing %s assets', async (contentType) => {
    const assets = { ASSETS: { fetch: async () => new Response('verification', { headers: { 'content-type': contentType } }) } } as unknown as Env;
    const response = await worker.fetch(new Request('https://equation.io/.well-known/openai-apps-challenge'), assets);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('verification');
  });

  it('preserves the normal SPA fallback outside the namespace', async () => {
    const response = await get('/some-app-path');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(APP);
  });
});

describe('share meta tags', () => {
  const keys = (rows: string[]) =>
    shareMeta(rows, encodePayload(rows), 'https://equation.io').meta.map(([k]) => k);

  it('advertises a rendered preview for a drawable graph', () => {
    const k = keys(['y = sin(x)']);
    expect(k).toContain('og:image');
    expect(k).toContain('twitter:card');
    expect(k).toContain('og:image:width');
  });

  it('omits image tags for a shader-only graph so the site card survives', () => {
    const k = keys(['iter(z^2 + w)']);
    expect(k).not.toContain('og:image');
    expect(k).not.toContain('twitter:image');
    // Title and description stay: they are accurate regardless.
    expect(k).toContain('og:title');
    expect(k).toContain('og:description');
  });

  it('titles the card with the first equation', () => {
    expect(shareMeta(['y = sin(x)'], 'p', 'https://equation.io').title).toBe('y = sin(x) — equation.io');
    expect(shareMeta(['y = x', 'y = 2x'], 'p', 'https://equation.io').title).toBe('y = x … — equation.io');
  });
});

describe('/api/og images', () => {
  it('renders a PNG for a drawable graph', async () => {
    const res = await get('/api/og/' + encodePayload(['x^2 + y^2 = 9']));
    expect(res.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG magic
  });

  it('redirects to the static card rather than drawing an empty grid', async () => {
    const res = await get('/api/og/' + encodePayload(['domain((w^3 - 1)/w)']));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/shots/hero.png');
  });

  it('redirects for a general implicit 3D surface the renderer would draw as nothing', async () => {
    const res = await get('/api/og/' + encodePayload(['x^2 + y^2 + z^2 = 9']));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/shots/hero.png');
  });

  it('rejects an undecodable payload', async () => {
    expect((await get('/api/og/%E0%A4%A')).status).toBe(400);
  });
});

describe('intent landings', () => {
  it('redirects a missing trailing slash to the canonical path', async () => {
    const res = await get('/implicit');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://equation.io/implicit/');
  });

  it('titles preview landings with a drawable /api/og/ image', () => {
    const page = LANDINGS.find(l => l.slug === 'implicit')!;
    const { title, canonical, meta } = landingMeta(page, 'https://equation.io');
    const keys = Object.fromEntries(meta);
    expect(title).toBe('Implicit equation grapher — Equation.io');
    expect(canonical).toBe('https://equation.io/implicit/');
    expect(keys['og:image']).toContain('/api/og/');
    expect(canRenderOg(page.heroEqs)).toBe(true);
  });

  it('uses a stable PNG when the preview renderer cannot draw the hero', () => {
    const page = LANDINGS.find(l => l.slug === 'complex')!;
    const keys = Object.fromEntries(landingMeta(page, 'https://equation.io').meta);
    expect(keys['og:image']).toBe('https://equation.io/shots/complex.png');
    expect(canRenderOg(page.heroEqs)).toBe(false);
  });

  const hasRewriter = typeof HTMLRewriter !== 'undefined';
  (hasRewriter ? it : it.skip)('injects the landing title into the shared shell', async () => {
    const res = await get('/implicit/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Implicit equation grapher — Equation.io');
    expect(html).toContain('Graph an equation without solving for y');
  });

  (hasRewriter ? it : it.skip)('replaces a joined catch-all CSP with a single frame-src policy', async () => {
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
