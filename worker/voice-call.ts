/**
 * One live voice call's sideband. The browser's audio goes straight to OpenAI
 * over WebRTC; this Durable Object holds a second, server-side WebSocket onto
 * the same session (`?call_id=`), where it sees every `response.done` and
 * charges its usage to the caller's credit key. It hangs the call up when the
 * balance runs out or the call reaches MAX_CALL_MS, and it is how screenshots
 * enter the conversation (an image is too large for a WebRTC data channel
 * message in every browser).
 *
 * A plain fetch/alarm class, not `extends DurableObject`, so importing the
 * Worker needs no `cloudflare:workers` module (the tests import it in Node).
 */
import { charge, endCall, usageCost } from './voice-credit.ts';

export interface VoiceCallEnv {
  OPENAI_API_KEY?: string;
  DB?: D1Database;
}

const REALTIME_URL = 'https://api.openai.com/v1/realtime';
/** Longest call: a session left open by a forgotten tab still ends. */
export const MAX_CALL_MS = 30 * 60 * 1000;
/** How long an image may take to be added to the conversation. */
const IMAGE_TIMEOUT_MS = 10_000;

export const hangUp = (callId: string, apiKey: string) =>
  fetch(`${REALTIME_URL}/calls/${encodeURIComponent(callId)}/hangup`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
  });

export class VoiceCall {
  private ws?: WebSocket;
  private callId = '';
  private keyHash = '';
  private ended = false;
  /** Charges run one at a time, in event order. */
  private charges: Promise<unknown> = Promise.resolve();
  /** Images waiting to be confirmed, by item id and by the event id that sent them. */
  private waiting = new Map<string, (error?: string) => void>();

  constructor(
    private state: DurableObjectState,
    private env: VoiceCallEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/start') return this.start((await request.json()) as { callId: string; keyHash: string });
    if (pathname === '/image') return this.image((await request.json()) as { image: string; legend: string });
    return new Response('not found', { status: 404 });
  }

  /** The call ran too long: the alarm set when it started. */
  async alarm() {
    const saved = await this.state.storage.get<{ callId: string; keyHash: string }>('call');
    if (!saved) return;
    this.callId ||= saved.callId;
    this.keyHash ||= saved.keyHash;
    await this.end('time limit');
  }

  private async start({ callId, keyHash }: { callId: string; keyHash: string }): Promise<Response> {
    if (!this.env.OPENAI_API_KEY || !this.env.DB) return new Response('not configured', { status: 500 });
    this.callId = callId;
    this.keyHash = keyHash;
    const res = await fetch(`${REALTIME_URL}?call_id=${encodeURIComponent(callId)}`, {
      headers: { Authorization: `Bearer ${this.env.OPENAI_API_KEY}`, Upgrade: 'websocket' },
    });
    const ws = res.webSocket;
    if (!ws) return new Response(`sideband refused: ${res.status}`, { status: 502 });
    ws.accept();
    this.ws = ws;
    ws.addEventListener('message', e => this.onEvent(e.data));
    ws.addEventListener('close', () => void this.finish('ended'));
    await this.state.storage.put('call', { callId, keyHash });
    await this.state.storage.setAlarm(Date.now() + MAX_CALL_MS);
    return new Response('ok');
  }

  private onEvent(data: unknown) {
    if (typeof data !== 'string') return;
    let event: { type?: string; [k: string]: any };
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (event.type === 'response.done') {
      const micros = usageCost(event.response?.usage);
      if (micros > 0) this.bill(micros, JSON.stringify(event.response?.usage ?? {}));
    } else if (event.type === 'conversation.item.added' || event.type === 'conversation.item.created') {
      this.settle(event.item?.id);
    } else if (event.type === 'error') {
      this.settle(event.error?.event_id, event.error?.message ?? 'error');
    }
  }

  private bill(micros: number, detail: string) {
    const db = this.env.DB!;
    this.charges = this.charges
      .then(() => charge(db, this.keyHash, this.callId, micros, detail, Date.now()))
      .then(balance => {
        // Not returned: finish() waits for this chain, so it can't be part of it.
        if (balance <= 0) void this.end('out of credit');
      })
      .catch(e => console.error('[voice] charge failed', e));
  }

  private settle(id: unknown, error?: string) {
    if (typeof id !== 'string') return;
    this.waiting.get(id)?.(error);
  }

  private async image({ image, legend }: { image: string; legend: string }): Promise<Response> {
    const ws = this.ws;
    if (!ws || this.ended) return new Response('call is not live', { status: 409 });
    const id = `img_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const eventId = `evt_${id}`;
    const done = new Promise<string | undefined>(resolve => {
      const finish = (error?: string) => {
        this.waiting.delete(id);
        this.waiting.delete(eventId);
        clearTimeout(timer);
        resolve(error);
      };
      const timer = setTimeout(() => finish('timed out'), IMAGE_TIMEOUT_MS);
      this.waiting.set(id, finish);
      this.waiting.set(eventId, finish);
    });
    ws.send(
      JSON.stringify({
        type: 'conversation.item.create',
        event_id: eventId,
        item: {
          id,
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: legend },
            { type: 'input_image', image_url: image },
          ],
        },
      }),
    );
    const error = await done;
    return error ? new Response(error, { status: 502 }) : new Response('ok');
  }

  /** Ends the call from this side: hang up, then record why. */
  private async end(reason: string) {
    if (this.ended) return;
    if (this.env.OPENAI_API_KEY) {
      await hangUp(this.callId, this.env.OPENAI_API_KEY).catch(e => console.error('[voice] hangup failed', e));
    }
    await this.finish(reason);
  }

  /** Records the end once, after any charges still in flight. */
  private async finish(reason: string) {
    if (this.ended) return;
    this.ended = true;
    try {
      this.ws?.close();
    } catch {
      // Already closed.
    }
    await this.charges;
    if (this.env.DB) await endCall(this.env.DB, this.callId, reason, Date.now());
    await this.state.storage.deleteAlarm();
    await this.state.storage.deleteAll();
  }
}
