import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedKey, testDb } from './d1.fixtures.ts';
import { MAX_CALL_MS, VoiceCall } from './voice-call.ts';
import { startCall } from './voice-credit.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The sideband socket as the Durable Object sees it. */
class FakeSocket {
  sent: any[] = [];
  closed = false;
  private listeners: Record<string, ((e: any) => void)[]> = {};
  accept() {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  addEventListener(type: string, fn: (e: any) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  /** OpenAI sends an event. */
  emit(event: object) {
    for (const fn of this.listeners.message ?? []) fn({ data: JSON.stringify(event) });
  }
  hangUpRemotely() {
    for (const fn of this.listeners.close ?? []) fn({});
  }
}

function fakeState() {
  const store = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    alarmAt: () => alarm,
    storage: {
      get: async (k: string) => store.get(k),
      put: async (k: string, v: unknown) => void store.set(k, v),
      setAlarm: async (t: number) => void (alarm = t),
      deleteAlarm: async () => void (alarm = null),
      deleteAll: async () => store.clear(),
    },
  };
}

/** A started call on a key with `balance`, its socket, and every request made to OpenAI. */
async function live(balance: number) {
  const { db, raw } = testDb();
  seedKey(raw, 'h1', balance);
  await startCall(db, 'rtc_1', 'h1', 0);
  const socket = new FakeSocket();
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    requests.push(url);
    return url.includes('?call_id=') ? { status: 101, webSocket: socket } : new Response(null, { status: 200 });
  });
  const state = fakeState();
  const call = new VoiceCall(state as unknown as DurableObjectState, { OPENAI_API_KEY: 'sk-test', DB: db });
  const res = await call.fetch(
    new Request('https://voice-call/start', {
      method: 'POST',
      body: JSON.stringify({ callId: 'rtc_1', keyHash: 'h1' }),
    }),
  );
  expect(res.status).toBe(200);
  const row = () =>
    raw.prepare("SELECT cost_micros, ended_at, end_reason FROM voice_calls WHERE call_id = 'rtc_1'").get();
  const balanceNow = () =>
    (raw.prepare("SELECT balance_micros FROM voice_keys WHERE key_hash = 'h1'").get() as any).balance_micros;
  return { call, socket, requests, state, row, balanceNow };
}

const done = (audioOut: number) => ({
  type: 'response.done',
  response: { usage: { output_token_details: { audio_tokens: audioOut } } },
});
const settle = () => new Promise(r => setTimeout(r, 10));

describe('VoiceCall sideband', () => {
  it('attaches to the call with the server key and sets the time limit', async () => {
    const { requests, state } = await live(1_000_000);
    expect(requests).toEqual(['https://api.openai.com/v1/realtime?call_id=rtc_1']);
    expect(state.alarmAt()! - Date.now()).toBeGreaterThan(MAX_CALL_MS - 1000);
  });

  it('charges each response to the key and the call', async () => {
    const { socket, row, balanceNow, requests } = await live(1_000_000);
    socket.emit(done(1000)); // 1000 × 64 µ$
    socket.emit(done(500));
    socket.emit({ type: 'response.done', response: {} }); // no usage: free
    await settle();
    expect(balanceNow()).toBe(1_000_000 - 1500 * 64);
    expect(row()).toMatchObject({ cost_micros: 1500 * 64, ended_at: null });
    expect(requests.some(u => u.endsWith('/hangup'))).toBe(false);
  });

  it('hangs up once the balance runs out, and records why', async () => {
    const { socket, row, requests, state } = await live(100_000);
    socket.emit(done(1000)); // 64,000 µ$: still in credit
    await settle();
    expect(requests.some(u => u.endsWith('/hangup'))).toBe(false);
    socket.emit(done(1000)); // now -28,000
    await settle();
    expect(requests.filter(u => u.endsWith('/calls/rtc_1/hangup'))).toHaveLength(1);
    expect(socket.closed).toBe(true);
    expect(row()).toMatchObject({ cost_micros: 128_000, end_reason: 'out of credit' });
    expect(state.alarmAt()).toBeNull();
  });

  it('records a call the user ended', async () => {
    const { socket, row, requests } = await live(1_000_000);
    socket.emit(done(10));
    socket.hangUpRemotely();
    await settle();
    expect(row()).toMatchObject({ cost_micros: 640, end_reason: 'ended' });
    expect(requests.some(u => u.endsWith('/hangup'))).toBe(false);
  });

  it('hangs up at the time limit', async () => {
    const { call, row, requests } = await live(1_000_000);
    await call.alarm();
    expect(requests.filter(u => u.endsWith('/hangup'))).toHaveLength(1);
    expect(row()).toMatchObject({ end_reason: 'time limit' });
  });

  it('adds a screenshot to the conversation and answers once it is in', async () => {
    const { call, socket } = await live(1_000_000);
    const pending = call.fetch(
      new Request('https://voice-call/image', {
        method: 'POST',
        body: JSON.stringify({ image: 'data:image/jpeg;base64,AAAA', legend: 'y = x (red)' }),
      }),
    );
    await settle();
    const sent = socket.sent.at(-1);
    expect(sent).toMatchObject({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'y = x (red)' },
          { type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA' },
        ],
      },
    });
    socket.emit({ type: 'conversation.item.added', item: { id: sent.item.id } });
    expect((await pending).status).toBe(200);
  });

  it('reports an image OpenAI rejected', async () => {
    const { call, socket } = await live(1_000_000);
    const pending = call.fetch(
      new Request('https://voice-call/image', { method: 'POST', body: JSON.stringify({ image: 'x', legend: '' }) }),
    );
    await settle();
    socket.emit({ type: 'error', error: { message: 'bad image', event_id: socket.sent.at(-1).event_id } });
    expect((await pending).status).toBe(502);
  });
});
