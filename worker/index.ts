import { GRAPH_CSP } from '../lib/csp.ts';
import { decodePayload } from '../lib/link.ts';
import { handleDiscovery } from './discovery.ts';
import { handleMcp } from './mcp.ts';

/** The site's static card: share links unfurl with it. */
const SITE_OG = '/shots/hero.png';

const escapeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Title and og:/twitter: pairs for a share link: the graph's equations as
 * text, over the static site card.
 *
 * Split out from handleShare so this is testable without the Workers
 * runtime (HTMLRewriter is a runtime global).
 */
export function shareMeta(equations: string[], payload: string, origin: string): { title: string; meta: string[][] } {
  const title = `${equations[0]}${equations.length > 1 ? ' …' : ''} — equation.io`;
  const description =
    equations.length > 1
      ? `Interactive graph of ${equations.length} equations: ${equations.join('; ')}`
      : 'Interactive graph — opens rendered in the browser, no account needed.';
  const meta: string[][] = [
    ['og:title', title],
    ['og:description', description],
    ['og:type', 'website'],
    ['og:url', `${origin}/g/${payload}`],
    ['og:image', `${origin}${SITE_OG}`],
    ['twitter:card', 'summary_large_image'],
    ['twitter:image', `${origin}${SITE_OG}`],
  ];
  return { title, meta };
}

/**
 * /g/<payload>: the share form of a graph link. Serves the app shell with
 * og:/twitter: meta tags injected so the link unfurls with the graph's title
 * (crawlers never see URL fragments, which is why this form exists). The web
 * app boots from the path and keeps the address bar on the canonical /g/ form.
 */
async function handleShare(request: Request, url: URL, env: Env): Promise<Response> {
  const payload = url.pathname.slice('/g/'.length);
  let equations: string[] = [];
  try {
    equations = decodePayload(payload);
  } catch {
    // Undecodable payload — serve the plain app.
  }
  const shell = withCsp(withCharset(await env.ASSETS.fetch(new Request(new URL('/', url), request))), GRAPH_CSP);
  if (!equations.length || !shell.headers.get('content-type')?.includes('text/html')) return shell;

  const { title, meta } = shareMeta(equations, payload, url.origin);
  const tags = meta
    .map(([p, c]) => `<meta ${p.startsWith('twitter:') ? 'name' : 'property'}="${p}" content="${escapeAttr(c)}">`)
    .join('\n  ');
  return (
    new HTMLRewriter()
      // The shell carries the homepage's own og:/twitter: tags; crawlers take
      // the first of each, so drop them and append the graph's.
      .on('meta[property^="og:"], meta[name^="twitter:"]', {
        element(el) {
          el.remove();
        },
      })
      .on('head', {
        element(el) {
          el.append(`${tags}\n  `, { html: true });
        },
      })
      .on('title', {
        element(el) {
          el.setInnerContent(title);
        },
      })
      .transform(shell)
  );
}

function handleApi(url: URL): Response {
  if (url.pathname === '/api/health') {
    return Response.json({ ok: true });
  }
  return Response.json({ error: 'not_found' }, { status: 404 });
}

// Static assets are served without a charset, so browsers decode text/* as
// windows-1252 and mangle the em dashes in llms.txt. Tag them as UTF-8.
function withCharset(response: Response): Response {
  const type = response.headers.get('content-type');
  if (!type || !type.startsWith('text/') || type.includes('charset=')) {
    return response;
  }
  const patched = new Response(response.body, response);
  patched.headers.set('content-type', `${type}; charset=utf-8`);
  return patched;
}

/** Replace the asset response's CSP with the route-specific policy. */
function withCsp(response: Response, policy: string): Response {
  const patched = new Response(response.body, response);
  patched.headers.set('Content-Security-Policy', policy);
  return patched;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const discovery = handleDiscovery(request, url);
    if (discovery) return discovery;
    if (url.pathname === '/.well-known' || url.pathname.startsWith('/.well-known/')) {
      const response = await env.ASSETS.fetch(request);
      // This namespace serves machine-readable files, never the HTML 404 page.
      if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'text/html') {
        return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
      return withCharset(response);
    }
    if (url.pathname === '/mcp') {
      return handleMcp(request, url, env);
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(url);
    }
    if (url.pathname.startsWith('/g/')) {
      return handleShare(request, url, env);
    }
    return withCharset(await env.ASSETS.fetch(request));
  },
} satisfies ExportedHandler<Env>;
