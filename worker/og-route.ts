/**
 * /api/og/<payload>: the link-preview image. Decoding, the fallback redirect
 * and caching live here; drawing is @equation/og-renderer's.
 */
import { decodePayload } from '../lib/link.ts';
import { canRenderOg, renderOgPng } from '../packages/og-renderer/src/index.ts';

/** Static card used when a graph is not one the preview renderer can draw. */
const FALLBACK_OG = '/shots/hero.png';

export async function handleOgImage(url: URL): Promise<Response> {
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
