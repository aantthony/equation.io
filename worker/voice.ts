/**
 * Voice mode's server side (web/voice.ts is the client).
 *
 * /api/voice/token mints a short-lived OpenAI Realtime client secret so the
 * browser can open a voice session without ever seeing OPENAI_API_KEY. The
 * secret is minted for one model; the page configures the rest of the session.
 *
 * A client secret only gates opening the socket: a session outlives it, and
 * whoever holds one can run a session of their own — and the site has no
 * accounts — so an open endpoint would be a free voice API billed to this
 * deployment. Voice mode is therefore private: the caller must present
 * VOICE_PASSPHRASE. With either secret unset the feature does not exist (404),
 * which is the default for every deployment that has not opted in.
 */

const CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';

/** The realtime model; web/voice.ts connects with the same one. */
export const VOICE_MODEL = 'gpt-realtime-2.1';

/** The secret only has to last until the WebSocket handshake completes. */
const TOKEN_TTL_SECONDS = 60;

export interface VoiceEnv {
  OPENAI_API_KEY?: string;
  VOICE_PASSPHRASE?: string;
}

/** Compares in time independent of where the strings first differ. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

/** The gate: a Response to return, or null to proceed. */
async function refuse(request: Request, env: VoiceEnv): Promise<Response | null> {
  if (!env.OPENAI_API_KEY || !env.VOICE_PASSPHRASE) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  if (request.method !== 'POST') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: { Allow: 'POST' } });
  }
  const passphrase = request.headers.get('X-Voice-Passphrase') ?? '';
  if (!(await sameSecret(passphrase, env.VOICE_PASSPHRASE))) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  return null;
}

// Don't relay OpenAI's body: it can describe the account behind the key.
const upstreamError = (status?: number) => Response.json({ error: 'upstream', status }, { status: 502 });

export async function handleVoiceToken(request: Request, env: VoiceEnv): Promise<Response> {
  const refused = await refuse(request, env);
  if (refused) return refused;
  const upstream = await fetch(CLIENT_SECRETS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expires_after: { anchor: 'created_at', seconds: TOKEN_TTL_SECONDS },
      session: { type: 'realtime', model: VOICE_MODEL },
    }),
  });
  if (!upstream.ok) return upstreamError(upstream.status);
  const { value, expires_at } = (await upstream.json()) as { value?: unknown; expires_at?: unknown };
  if (typeof value !== 'string') return upstreamError();
  return Response.json({ value, expires_at }, { headers: { 'Cache-Control': 'no-store' } });
}
