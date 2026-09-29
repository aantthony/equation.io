/**
 * The Cloudflare Worker: a router in front of the static app. It serves the
 * server-only routes (share-link and landing metadata, /api/og/ previews,
 * /mcp, /api/health, web voice call setup) and hands everything else to the
 * static assets, which are the calculator itself.
 */
import { landingFromPath } from '../lib/landings.ts';
import { handleApi } from './api.ts';
import { withCharset } from './http.ts';
import { handleMcp } from './mcp.ts';
import { handleLanding, handleShare } from './pages.ts';

export { landingMeta, shareMeta } from './pages.ts';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/.well-known' || url.pathname.startsWith('/.well-known/')) {
      const response = await env.ASSETS.fetch(request);
      // This namespace serves machine-readable files, never the HTML SPA fallback.
      if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'text/html') {
        return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
      return withCharset(response);
    }
    if (url.pathname === '/mcp') {
      return handleMcp(request, url, env);
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(request, url, env);
    }
    if (url.pathname.startsWith('/g/')) {
      return handleShare(request, url, env);
    }
    const landing = landingFromPath(url.pathname);
    if (landing) return handleLanding(request, url, env, landing);
    return withCharset(await env.ASSETS.fetch(request));
  },
} satisfies ExportedHandler<Env>;
