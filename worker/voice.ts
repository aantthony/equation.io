/**
 * Voice mode's server side (web/voice.ts is the client).
 *
 * The browser never holds an OpenAI credential. It sends its WebRTC offer to
 * /api/voice/call with a credit key; the Worker checks the key's balance,
 * creates the Realtime call with the server's key and a fixed session
 * (lib/voice-agent.ts), and starts the call's sideband (worker/voice-call.ts),
 * which charges every response to the key and hangs up when it runs dry. Only
 * then does the browser get the SDP answer, so no call goes unmetered. Audio
 * then flows between the browser and OpenAI directly.
 *
 * /api/voice/image adds a screenshot to a live call (through its sideband),
 * and /api/voice/balance reports a key's remaining credit.
 *
 * With OPENAI_API_KEY or either binding missing, the routes do not exist (404).
 */
import { SESSION_CONFIG } from '../lib/voice-agent.ts';
import { hangUp, MAX_CALL_MS, type VoiceCallEnv } from './voice-call.ts';
import { callBelongsTo, endCall, hashKey, isKeyShaped, lookupKey, openCalls, startCall } from './voice-credit.ts';

export interface VoiceEnv extends VoiceCallEnv {
  VOICE_CALLS?: DurableObjectNamespace;
}

const CALLS_URL = 'https://api.openai.com/v1/realtime/calls';

/** A call needs at least this much credit to start (10¢): a few responses' worth. */
export const MIN_START_MICROS = 100_000;
/** Calls one key may have open at once. */
export const MAX_OPEN_CALLS = 2;
/** A browser's SDP offer is a few KB. */
const MAX_SDP_CHARS = 20_000;
/** A 1280px JPEG is ~200 KB as a data URL. */
const MAX_IMAGE_CHARS = 1_500_000;
const MAX_LEGEND_CHARS = 8000;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

type Configured = Required<Pick<VoiceEnv, 'OPENAI_API_KEY' | 'DB' | 'VOICE_CALLS'>>;

/** The shared gate: the key's hash, or the Response refusing the request. */
async function authorize(
  request: Request,
  env: VoiceEnv,
): Promise<{ env: Configured; keyHash: string; balance: number } | Response> {
  if (!env.OPENAI_API_KEY || !env.DB || !env.VOICE_CALLS) return json({ error: 'not_found' }, 404);
  if (request.method !== 'POST') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: { Allow: 'POST' } });
  }
  const key = request.headers.get('X-Voice-Key') ?? '';
  const keyHash = isKeyShaped(key) ? await hashKey(key) : '';
  const row = keyHash ? await lookupKey(env.DB, keyHash) : null;
  if (!row || row.disabled) return json({ error: 'forbidden' }, 403);
  return { env: env as Configured, keyHash, balance: row.balance_micros };
}

const callStub = (env: Configured, callId: string) => env.VOICE_CALLS.get(env.VOICE_CALLS.idFromName(callId));

export async function handleVoiceCall(request: Request, env: VoiceEnv): Promise<Response> {
  const auth = await authorize(request, env);
  if (auth instanceof Response) return auth;
  const { keyHash, balance } = auth;
  const { OPENAI_API_KEY, DB } = auth.env;
  if (balance < MIN_START_MICROS) return json({ error: 'no_credit', balance_micros: balance }, 402);
  const now = Date.now();
  if ((await openCalls(DB, keyHash, now - MAX_CALL_MS)) >= MAX_OPEN_CALLS) {
    return json({ error: 'too_many_calls' }, 429);
  }
  const sdp = await request.text();
  if (!sdp.startsWith('v=0') || sdp.length > MAX_SDP_CHARS) return json({ error: 'bad_request' }, 400);

  const form = new FormData();
  form.set('sdp', sdp);
  form.set('session', JSON.stringify(SESSION_CONFIG));
  const upstream = await fetch(CALLS_URL, {
    method: 'POST',
    // The key's hash stands in for a user id, as OpenAI's abuse monitoring asks.
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Safety-Identifier': keyHash.slice(0, 32) },
    body: form,
  });
  // Don't relay OpenAI's body: it can describe the account behind the key.
  if (!upstream.ok) return json({ error: 'upstream', status: upstream.status }, 502);
  const callId = upstream.headers.get('Location')?.split('/').pop();
  const answer = await upstream.text();
  if (!callId) return json({ error: 'upstream' }, 502);

  await startCall(DB, callId, keyHash, now);
  const started = await callStub(auth.env, callId)
    .fetch('https://voice-call/start', { method: 'POST', body: JSON.stringify({ callId, keyHash }) })
    .catch(() => null);
  if (!started?.ok) {
    // No sideband, no metering: the call must not go ahead.
    await hangUp(callId, OPENAI_API_KEY).catch(() => {});
    await endCall(DB, callId, 'sideband failed', Date.now());
    return json({ error: 'upstream' }, 502);
  }
  return new Response(answer, {
    headers: {
      'Content-Type': 'application/sdp',
      'Cache-Control': 'no-store',
      'X-Voice-Call': callId,
      'X-Voice-Balance': String(balance),
    },
  });
}

export async function handleVoiceImage(request: Request, env: VoiceEnv): Promise<Response> {
  const auth = await authorize(request, env);
  if (auth instanceof Response) return auth;
  let body: { call_id?: unknown; image?: unknown; legend?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  const { call_id, image, legend } = body;
  if (
    typeof call_id !== 'string' ||
    typeof image !== 'string' ||
    !/^data:image\/(jpeg|png);base64,/.test(image) ||
    image.length > MAX_IMAGE_CHARS ||
    typeof legend !== 'string' ||
    legend.length > MAX_LEGEND_CHARS
  ) {
    return json({ error: 'bad_request' }, 400);
  }
  if (!(await callBelongsTo(auth.env.DB, call_id, auth.keyHash))) return json({ error: 'not_found' }, 404);
  const res = await callStub(auth.env, call_id).fetch('https://voice-call/image', {
    method: 'POST',
    body: JSON.stringify({ image, legend }),
  });
  return res.ok ? json({ ok: true }) : json({ error: 'upstream' }, 502);
}

export async function handleVoiceBalance(request: Request, env: VoiceEnv): Promise<Response> {
  const auth = await authorize(request, env);
  if (auth instanceof Response) return auth;
  return json({ balance_micros: auth.balance });
}
