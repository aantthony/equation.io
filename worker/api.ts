/** /api/*: health, link previews and (web only) voice mode's call setup. */
import { handleOgImage } from './og-route.ts';
import { handleVoiceConnect } from './voice.ts';

export async function handleApi(request: Request, url: URL, env: Env): Promise<Response> {
  if (url.pathname === '/api/health') {
    return Response.json({ ok: true });
  }
  if (url.pathname === '/api/voice/connect') {
    return handleVoiceConnect(request, env);
  }
  if (url.pathname.startsWith('/api/og/')) {
    return handleOgImage(url);
  }
  return Response.json({ error: 'not_found' }, { status: 404 });
}
