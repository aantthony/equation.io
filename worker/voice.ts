/**
 * Voice mode's server side (web/voice.ts is the client).
 *
 * The page never holds an OpenAI credential. It opens a control WebSocket to
 * /api/voice/connect and sends its WebRTC offer with a credit key; the Worker
 * checks the key's balance, creates the Realtime call with the server's key
 * and a fixed session (lib/voice-agent.ts), attaches a sideband that charges
 * every response to the key, and only then sends the SDP answer — so no call
 * goes unmetered. Audio then flows between the page and OpenAI directly. See
 * worker/voice-call.ts for the call itself.
 *
 * With OPENAI_API_KEY or the DB binding missing, the route does not exist (404).
 */
import { VoiceCall, type VoiceCallEnv } from './voice-call.ts';

export type VoiceEnv = Partial<VoiceCallEnv>;

export function handleVoiceConnect(request: Request, env: VoiceEnv): Response {
  const { OPENAI_API_KEY, DB } = env;
  if (!OPENAI_API_KEY || !DB) return Response.json({ error: 'not_found' }, { status: 404 });
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return Response.json({ error: 'upgrade_required' }, { status: 426, headers: { Upgrade: 'websocket' } });
  }
  const [client, server] = Object.values(new WebSocketPair());
  // Half-open: the call answers the page's Close itself, once it has recorded the call (voice-call.ts).
  server.accept({ allowHalfOpen: true });
  new VoiceCall(server, { OPENAI_API_KEY, DB }).listen();
  return new Response(null, { status: 101, webSocket: client });
}
