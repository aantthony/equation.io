import { GRAPH_CSP, LANDING_CSP } from '../lib/csp.ts';
import { landingFromPath, graphUrl, type Landing } from '../lib/landings.ts';
import { decodePayload, encodePayload } from '../lib/link.ts';
import { handleMcp } from './mcp.ts';
import { OG_HEIGHT, OG_WIDTH, canRenderOg, renderOgPng } from './og.ts';

/** Static card used when a graph is not one the preview renderer can draw. */
const FALLBACK_OG = '/shots/hero.png';

const escapeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Title and og:/twitter: pairs for a share link.
 *
 * The page never analyzes its graph: a heavy graph (thousands of list
 * elements) can take a second or more of CPU to analyze, past the Worker's
 * limit, and the page must load regardless. The preview image is always
 * advertised; /api/og/ decides whether it can draw the graph and otherwise
 * redirects to the static site card — a truthful generic card beats a
 * picture of an empty grid, which reads as a broken graph.
 *
 * Split out from handleShare so this is testable without the Workers
 * runtime (HTMLRewriter is a runtime global).
 */
export function shareMeta(
  equations: string[],
  payload: string,
  origin: string,
): { title: string; meta: string[][] } {
  const title = `${equations[0]}${equations.length > 1 ? ' …' : ''} — equation.io`;
  const description = equations.length > 1
    ? `Interactive graph of ${equations.length} equations: ${equations.join('; ')}`
    : 'Interactive graph — opens rendered in the browser, no account needed.';
  const meta: string[][] = [
    ['og:title', title],
    ['og:description', description],
    ['og:type', 'website'],
    ['og:url', `${origin}/g/${payload}`],
    ['og:image', `${origin}/api/og/${payload}`],
    ['og:image:width', String(OG_WIDTH)],
    ['og:image:height', String(OG_HEIGHT)],
    ['twitter:card', 'summary_large_image'],
    ['twitter:image', `${origin}/api/og/${payload}`],
  ];
  return { title, meta };
}

/**
 * Title and og:/twitter: pairs for an intent landing page.
 *
 * `preview` pages advertise the CPU-rendered /api/og/ of the hero graph.
 * `shot` pages use a stable PNG in /shots/ — the preview renderer cannot
 * draw those heroes (complex potentials, domain coloring), and a generic
 * site card would be a lie.
 */
export function landingMeta(
  page: Landing,
  origin: string,
): { title: string; description: string; canonical: string; meta: string[][] } {
  const title = `${page.title} — Equation.io`;
  const description = page.lead;
  const canonical = `${origin}${page.path}`;
  const image = page.og === 'preview'
    ? `${origin}/api/og/${encodePayload(page.heroEqs)}`
    : `${origin}/shots/${page.slug}.png`;
  const width = page.og === 'preview' ? String(OG_WIDTH) : '900';
  const height = page.og === 'preview' ? String(OG_HEIGHT) : '600';
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
 * og:/twitter: meta tags injected so the link unfurls with a rendered preview
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
  const shell = withCsp(
    withCharset(await env.ASSETS.fetch(new Request(new URL('/', url), request))),
    GRAPH_CSP,
  );
  if (!equations.length || !shell.headers.get('content-type')?.includes('text/html')) return shell;

  const { title, meta } = shareMeta(equations, payload, url.origin);
  const tags = meta
    .map(([p, c]) => `<meta ${p.startsWith('twitter:') ? 'name' : 'property'}="${p}" content="${escapeAttr(c)}">`)
    .join('\n  ');
  return new HTMLRewriter()
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
    .transform(shell);
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
  return withCsp(new HTMLRewriter()
    .on('head', {
      element(el) {
        el.append(`${extra}\n  `, { html: true });
      },
    })
    .on('title', {
      element(el) { el.setInnerContent(title); },
    })
    .on('meta[name="description"]', {
      element(el) { el.setAttribute('content', description); },
    })
    .on('link[rel="canonical"]', {
      element(el) { el.setAttribute('href', canonical); },
    })
    .on('meta[property="og:title"]', {
      element(el) { el.setAttribute('content', title); },
    })
    .on('meta[property="og:description"]', {
      element(el) { el.setAttribute('content', description); },
    })
    .on('meta[property="og:url"]', {
      element(el) { el.setAttribute('content', canonical); },
    })
    .on('meta[property="og:image"]', {
      element(el) {
        const image = meta.find(([k]) => k === 'og:image')![1];
        el.setAttribute('content', image);
      },
    })
    .on('h1#h1', {
      element(el) { el.setInnerContent(page.h1); },
    })
    .on('p#lead', {
      element(el) { el.setInnerContent(page.lead); },
    })
    .on('noscript', {
      element(el) {
        el.prepend(
          `<p>${escapeAttr(page.lead)}</p><p><a href="${escapeAttr(share)}">${escapeAttr(share)}</a></p>`,
          { html: true },
        );
      },
    })
    .transform(shell), LANDING_CSP);
}

async function handleOgImage(url: URL): Promise<Response> {
  const payload = url.pathname.slice('/api/og/'.length);
  let equations: string[] = [];
  try {
    equations = decodePayload(payload);
  } catch {
    return Response.json({ error: 'bad_payload' }, { status: 400 });
  }
  // handleShare advertises this URL for every graph without analyzing it, so
  // this is where an undrawable graph is sent to the static site image rather
  // than rendered as an empty grid.
  if (!canRenderOg(equations)) {
    return Response.redirect(new URL(FALLBACK_OG, url).toString(), 302);
  }
  const png = await renderOgPng(equations);
  return new Response(png as unknown as BodyInit, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

async function handleApi(request: Request, url: URL, _env: Env): Promise<Response> {
  if (url.pathname === '/api/health') {
    return Response.json({ ok: true });
  }
  if (url.pathname.startsWith('/api/og/')) {
    return handleOgImage(url);
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
