import { GRAPH_CSP, LANDING_CSP } from '../lib/csp.ts';
import { landingFromPath, graphUrl, type Landing } from '../lib/landings.ts';
import { decodePayload } from '../lib/link.ts';
import { handleDiscovery } from './discovery.ts';
import { handleMcp } from './mcp.ts';
import { handleVoiceConnect } from './voice.ts';

/** Static site card for graph links and landings without their own screenshot. */
const SITE_OG = '/shots/hero.png';

const escapeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Title and og:/twitter: pairs for a share link.
 *
 * The page never analyzes its graph: a heavy graph (thousands of list
 * elements) can take a second or more of CPU to analyze, past the Worker's
 * limit, and the page must load regardless. Links use the static site card.
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
    ['og:image:width', '2880'],
    ['og:image:height', '1800'],
    ['twitter:card', 'summary_large_image'],
    ['twitter:image', `${origin}${SITE_OG}`],
  ];
  return { title, meta };
}

/**
 * Title and og:/twitter: pairs for an intent landing page.
 *
 * Pages use the static site card or their own stable PNG in /shots/.
 */
export function landingMeta(
  page: Landing,
  origin: string,
): { title: string; description: string; canonical: string; meta: string[][] } {
  const title = `${page.title} — Equation.io`;
  const description = page.lead;
  const canonical = `${origin}${page.path}`;
  const image = `${origin}${page.og === 'shot' ? `/shots/${page.slug}.png` : SITE_OG}`;
  const width = page.og === 'shot' ? '1800' : '2880';
  const height = page.og === 'shot' ? '1200' : '1800';
  const meta: string[][] = [
    ['og:title', title],
    ['og:description', description],
    ['og:type', 'website'],
    ['og:url', canonical],
    ['og:image', image],
    ['og:image:width', width],
    ['og:image:height', height],
    ['twitter:card', 'summary_large_image'],
    ['twitter:image', image],
  ];
  return { title, description, canonical, meta };
}

/**
 * /g/<payload>: the share form of a graph link. Serves the app shell with
 * og:/twitter: meta tags injected so the link unfurls with its graph title
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
      // The shell carries the site's own og:/twitter: tags (the homepage card).
      // Drop them and append the graph's title, description, and site card.
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

/**
 * /implicit/, /slope-field/, /complex/, … — intent pages. The shell is the
 * shared /landing/ template; title, description, canonical, and og: tags
 * are injected here so crawlers see them without running JS.
 */
async function handleLanding(request: Request, url: URL, env: Env, page: Landing): Promise<Response> {
  if (url.pathname !== page.path) {
    return Response.redirect(new URL(page.path, url).toString(), 301);
  }
  const shell = await env.ASSETS.fetch(new Request(new URL('/landing/', url), request));
  if (!shell.headers.get('content-type')?.includes('text/html')) return shell;

  const { title, description, canonical, meta } = landingMeta(page, url.origin);
  const share = `${url.origin}${graphUrl(page.heroEqs)}`;
  const extra = meta
    .filter(([k]) => k === 'twitter:card' || k === 'twitter:image' || k === 'og:image:width' || k === 'og:image:height')
    .map(([p, c]) => `<meta ${p.startsWith('twitter:') ? 'name' : 'property'}="${p}" content="${escapeAttr(c)}">`)
    .join('\n  ');
  return withCsp(
    new HTMLRewriter()
      .on('head', {
        element(el) {
          el.append(`${extra}\n  `, { html: true });
        },
      })
      .on('title', {
        element(el) {
          el.setInnerContent(title);
        },
      })
      .on('meta[name="description"]', {
        element(el) {
          el.setAttribute('content', description);
        },
      })
      .on('link[rel="canonical"]', {
        element(el) {
          el.setAttribute('href', canonical);
        },
      })
      .on('meta[property="og:title"]', {
        element(el) {
          el.setAttribute('content', title);
        },
      })
      .on('meta[property="og:description"]', {
        element(el) {
          el.setAttribute('content', description);
        },
      })
      .on('meta[property="og:url"]', {
        element(el) {
          el.setAttribute('content', canonical);
        },
      })
      .on('meta[property="og:image"]', {
        element(el) {
          const image = meta.find(([k]) => k === 'og:image')![1];
          el.setAttribute('content', image);
        },
      })
      .on('h1#h1', {
        element(el) {
          el.setInnerContent(page.h1);
        },
      })
      .on('p#lead', {
        element(el) {
          el.setInnerContent(page.lead);
        },
      })
      .on('noscript', {
        element(el) {
          el.prepend(`<p>${escapeAttr(page.lead)}</p><p><a href="${escapeAttr(share)}">${escapeAttr(share)}</a></p>`, {
            html: true,
          });
        },
      })
      .transform(shell),
    LANDING_CSP,
  );
}

async function handleApi(request: Request, url: URL, env: Env): Promise<Response> {
  if (url.pathname === '/api/health') {
    return Response.json({ ok: true });
  }
  if (url.pathname === '/api/voice/connect') {
    return handleVoiceConnect(request, env);
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
