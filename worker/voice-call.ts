/**
 * One voice call, held by the Worker invocation that accepted the page's
 * control WebSocket (/api/voice/connect).
 *
 * The page's audio goes straight to OpenAI over WebRTC. This invocation holds
 * the other two connections: the page's control socket, and a sideband
 * WebSocket onto the same Realtime session (`?call_id=`), where it sees every
 * `response.done` and charges its usage to the caller's credit key. The call
 * lives exactly as long as the control socket: the page closing it, the
 * credit running out, the page changing the session, or MAX_CALL_MS hangs the
 * call up.
 *
 * The control socket is accepted half-open (worker/voice.ts): a page's Close
 * frame isn't answered until end() has hung up and recorded the call, because
 * answering it completes the request and the runtime would then cancel those
 * database writes.
 *
 * The control protocol, as JSON messages:
 *   page → { type: 'start', key, sdp }                  first message
 *   page ← { type: 'answer', sdp, call_id }
 *   page ← { type: 'refused', error, balance_micros? }  then closes
 *   page → { type: 'image', id, image, legend }         a screenshot for the model
 *   page ← { type: 'image.done', id, error? }
 *   page ← { type: 'ended', reason }                    then closes
 */
import { SESSION_CONFIG, TOOLS } from '../lib/voice-agent.ts';
import { charge, endCall, hashKey, isKeyShaped, lookupKey, openCalls, startCall, usageCost } from './voice-credit.ts';

export interface VoiceCallEnv {
  OPENAI_API_KEY: string;
  DB: D1Database;
}

/** The parts of a WebSocket a call uses, on either side. */
export interface CallSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
  addEventListener(type: 'close' | 'error', fn: () => void): void;
}

const REALTIME_URL = 'https://api.openai.com/v1/realtime';

/** A call needs at least this much credit to start (10¢): a few responses' worth. */
export const MIN_START_MICROS = 100_000;
/** Calls one key may have open at once. */
export const MAX_OPEN_CALLS = 2;
/** Longest call: a session left open by a forgotten tab still ends. */
export const MAX_CALL_MS = 30 * 60 * 1000;
/** The page has this long to send its offer after connecting. */
const START_TIMEOUT_MS = 10_000;
/** How long an image may take to be added to the conversation. */
const IMAGE_TIMEOUT_MS = 10_000;
/** A browser's SDP offer is a few KB. */
const MAX_SDP_CHARS = 20_000;
/** A 1280px JPEG is ~200 KB as a data URL. */
const MAX_IMAGE_CHARS = 1_500_000;
const MAX_LEGEND_CHARS = 8000;

export const hangUp = (callId: string, apiKey: string) =>
  fetch(`${REALTIME_URL}/calls/${encodeURIComponent(callId)}/hangup`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
  });

type Message = { type?: unknown; [k: string]: unknown };

function parse(data: unknown): Message | null {
  if (typeof data !== 'string') return null;
  try {
    const value: unknown = JSON.parse(data);
    return value && typeof value === 'object' ? (value as Message) : null;
  } catch {
    return null;
  }
}

export class VoiceCall {
  private sideband?: CallSocket;
  private callId = '';
  private keyHash = '';
  private started = false;
  private ended = false;
  private timers: ReturnType<typeof setTimeout>[] = [];
  /** Charges run one at a time, in event order. */
  private charges: Promise<unknown> = Promise.resolve();
  /** Screenshots waiting to be confirmed, by item id and by the event id that sent them. */
  private waiting = new Map<string, (error?: string) => void>();

  constructor(
    private page: CallSocket,
    private env: VoiceCallEnv,
  ) {}

  /** Starts listening to the page. Everything after is driven by socket events. */
  listen() {
    this.page.addEventListener('message', e => void this.onPage(parse(e.data)));
    this.page.addEventListener('close', () => void this.end('ended'));
    this.page.addEventListener('error', () => void this.end('ended'));
    this.timers.push(setTimeout(() => !this.started && this.refuse('bad_request'), START_TIMEOUT_MS));
  }

  private send(message: object) {
    try {
      this.page.send(JSON.stringify(message));
    } catch {
      // The page has gone; its close event ends the call.
    }
  }

  private async onPage(message: Message | null) {
    if (!message || this.ended) return;
    if (message.type === 'start' && !this.started) {
      this.started = true;
      try {
        await this.start(message.key, message.sdp);
      } catch (e) {
        // A database or network failure mid-setup: the page is waiting on an answer.
        console.error('[voice] start failed', e);
        await this.abandon();
      }
    } else if (message.type === 'image') {
      const result = await this.image(message.image, message.legend).catch(() => ({ error: 'call is not live' }));
      this.send({ type: 'image.done', id: message.id, ...result });
    }
  }

  private refuse(error: string, extra: object = {}) {
    this.send({ type: 'refused', error, ...extra });
    this.ended = true;
    this.clear();
    this.closePage(error);
  }

  /** Setup failed part way: hang up whatever call was created, and refuse the page. */
  private async abandon() {
    if (this.callId) {
      await hangUp(this.callId, this.env.OPENAI_API_KEY).catch(() => {});
      await endCall(this.env.DB, this.callId, 'setup failed', Date.now()).catch(() => {});
    }
    this.closeSideband(this.sideband);
    this.sideband = undefined;
    if (!this.ended) this.refuse('upstream');
  }

  private async start(key: unknown, sdp: unknown) {
    const { DB, OPENAI_API_KEY } = this.env;
    const keyHash = typeof key === 'string' && isKeyShaped(key) ? await hashKey(key) : '';
    const row = keyHash ? await lookupKey(DB, keyHash) : null;
    if (!row || row.disabled) return this.refuse('forbidden');
    if (row.balance_micros < MIN_START_MICROS) return this.refuse('no_credit', { balance_micros: row.balance_micros });
    const now = Date.now();
    if ((await openCalls(DB, keyHash, now - MAX_CALL_MS)) >= MAX_OPEN_CALLS) return this.refuse('too_many_calls');
    if (typeof sdp !== 'string' || !sdp.startsWith('v=0') || sdp.length > MAX_SDP_CHARS) {
      return this.refuse('bad_request');
    }

    const form = new FormData();
    form.set('sdp', sdp);
    form.set('session', JSON.stringify(SESSION_CONFIG));
    const created = await fetch(`${REALTIME_URL}/calls`, {
      method: 'POST',
      // The key's hash stands in for a user id, as OpenAI's abuse monitoring asks.
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Safety-Identifier': keyHash.slice(0, 32) },
      body: form,
    });
    // Don't relay OpenAI's body: it can describe the account behind the key.
    const callId = created.ok ? created.headers.get('Location')?.split('/').pop() : undefined;
    if (!callId) return this.refuse('upstream');
    const answer = await created.text();
    this.callId = callId;
    this.keyHash = keyHash;
    await startCall(DB, callId, keyHash, now);

    const sideband = await this.attach().catch(() => null);
    // No sideband, no metering; and a page that left meanwhile gets no call.
    if (!sideband || this.ended) {
      await hangUp(callId, OPENAI_API_KEY).catch(() => {});
      await endCall(DB, callId, sideband ? 'ended' : 'sideband failed', Date.now());
      this.closeSideband(sideband);
      if (!this.ended) this.refuse('upstream');
      return;
    }
    this.sideband = sideband;
    this.timers.push(setTimeout(() => void this.end('time limit'), MAX_CALL_MS));
    this.send({ type: 'answer', sdp: answer, call_id: callId });
  }

  /** Opens the sideband onto the call just created. */
  private async attach(): Promise<CallSocket | null> {
    const res = await fetch(`${REALTIME_URL}?call_id=${encodeURIComponent(this.callId)}`, {
      headers: { Authorization: `Bearer ${this.env.OPENAI_API_KEY}`, Upgrade: 'websocket' },
    });
    const ws = res.webSocket;
    if (!ws) return null;
    ws.accept();
    ws.addEventListener('message', e => this.onSideband(parse(e.data)));
    ws.addEventListener('close', () => void this.end('ended'));
    return ws;
  }

  private onSideband(event: Message | null) {
    if (!event) return;
    const response = event.response as { usage?: object } | undefined;
    if (event.type === 'session.updated') {
      // The page holds the call's data channel and could send session.update:
      // turn on transcription (billed outside response.done), or swap the
      // instructions and tools. It never needs to, so any change ends the call.
      if (!sessionIntact(event.session)) void this.end('session changed');
    } else if (event.type === 'response.done') {
      const micros = usageCost(response?.usage);
      if (micros > 0) this.bill(micros, JSON.stringify(response?.usage ?? {}));
    } else if (event.type === 'conversation.item.added' || event.type === 'conversation.item.created') {
      this.settle((event.item as { id?: unknown } | undefined)?.id);
    } else if (event.type === 'error') {
      const error = event.error as { event_id?: unknown; message?: string } | undefined;
      this.settle(error?.event_id, error?.message ?? 'error');
    }
  }

  private bill(micros: number, detail: string) {
    this.charges = this.charges
      .then(() => charge(this.env.DB, this.keyHash, this.callId, micros, detail, Date.now()))
      .then(balance => {
        // Not returned: end() waits for this chain, so it can't be part of it.
        if (balance <= 0) void this.end('out of credit');
      })
      .catch(e => console.error('[voice] charge failed', e));
  }

  private settle(id: unknown, error?: string) {
    if (typeof id === 'string') this.waiting.get(id)?.(error);
  }

  private async image(image: unknown, legend: unknown): Promise<{ error?: string }> {
    const sideband = this.sideband;
    if (!sideband) return { error: 'call is not live' };
    if (
      typeof image !== 'string' ||
      !/^data:image\/(jpeg|png);base64,/.test(image) ||
      image.length > MAX_IMAGE_CHARS ||
      typeof legend !== 'string' ||
      legend.length > MAX_LEGEND_CHARS
    ) {
      return { error: 'bad image' };
    }
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
    sideband.send(
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
    return error ? { error } : {};
  }

  private clear() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private closeSideband(sideband: CallSocket | null | undefined) {
    try {
      sideband?.close();
    } catch {
      // Already closed.
    }
  }

  private closePage(reason: string) {
    try {
      this.page.close(1000, reason);
    } catch {
      // Already closed.
    }
  }

  /**
   * Ends the call once, whichever side ended it: tell the page why, hang up,
   * settle charges and record the call, and only then close the sockets.
   * Closing the page's socket completes this request, so the writes go first.
   */
  private async end(reason: string) {
    if (this.ended) return;
    this.ended = true;
    this.clear();
    // Before hanging up: the page stops as soon as its call drops, and would miss it after.
    this.send({ type: 'ended', reason });
    if (this.callId) {
      await hangUp(this.callId, this.env.OPENAI_API_KEY).catch(e => console.error('[voice] hangup failed', e));
      await this.charges;
      await endCall(this.env.DB, this.callId, reason, Date.now()).catch(e =>
        console.error('[voice] endCall failed', e),
      );
    }
    this.closeSideband(this.sideband);
    this.closePage(reason);
  }
}

const TOOL_NAMES = TOOLS.map(t => t.name)
  .sort()
  .join();

/**
 * Whether a `session.updated` session is still the one the call was created
 * with, in everything that changes what it costs or what the model does.
 */
export function sessionIntact(session: unknown): boolean {
  const s = session as
    | {
        instructions?: unknown;
        tools?: { name?: unknown }[];
        audio?: { input?: { transcription?: unknown; turn_detection?: Record<string, unknown> | null } };
      }
    | undefined;
  const turns = s?.audio?.input?.turn_detection;
  const expected = SESSION_CONFIG.audio.input.turn_detection;
  return (
    s?.instructions === SESSION_CONFIG.instructions &&
    Array.isArray(s.tools) &&
    s.tools
      .map(t => t.name)
      .sort()
      .join() === TOOL_NAMES &&
    !s.audio?.input?.transcription &&
    !!turns &&
    Object.entries(expected).every(([k, v]) => turns[k] === v)
  );
}
