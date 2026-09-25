import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedKey, testDb } from './d1.fixtures.ts';
import { SESSION_CONFIG } from '../lib/voice-agent.ts';
import { MAX_CALL_MS, MAX_OPEN_CALLS, VoiceCall, hangUp, sessionIntact } from './voice-call.ts';
import { hashKey } from './voice-credit.ts';

const KEY = 'eqv_' + 'k'.repeat(43);
const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n';
const ANSWER = 'v=0\r\no=answer\r\n';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A WebSocket as the call sees it: records what it's sent, and can be driven from the other end. */
class FakeSocket {
  sent: any[] = [];
  closed = false;
  private listeners: Record<string, ((e: any) => void)[]> = {};
  accept() {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this.listeners.close ?? []) fn({});
  }
  addEventListener(type: string, fn: (e: any) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  /** The connection breaks without a close. */
  fail() {
    for (const fn of this.listeners.error ?? []) fn({});
  }
  /** The other end sends a message. */
  emit(message: object) {
    for (const fn of this.listeners.message ?? []) fn({ data: JSON.stringify(message) });
  }
  last(type: string) {
    return this.sent.filter(m => m.type === type).at(-1);
  }
}

const settle = () => new Promise(r => setTimeout(r, 10));
/** Waits (on real event-loop turns, so fake timers don't stall it) until `ready` holds. */
async function until(ready: () => unknown) {
  for (let i = 0; i < 1000 && !ready(); i++) await new Promise(r => setImmediate(r));
  expect(ready()).toBeTruthy();
}

/**
 * A page connected with KEY at `balance`, and OpenAI's side: creating a call
 * answers the offer, `?call_id=` opens `sideband`, anything else (hangup) succeeds.
 */
async function connect(balance = 5_000_000, { sidebandOpens = true } = {}) {
  const { db, raw } = testDb();
  const hash = await hashKey(KEY);
  seedKey(raw, hash, balance);
  const sideband = new FakeSocket();
  const upstream = vi.fn(async (url: string, _init?: RequestInit): Promise<any> => {
    if (url === 'https://api.openai.com/v1/realtime/calls') {
      return new Response(ANSWER, { status: 201, headers: { Location: '/v1/realtime/calls/rtc_1' } });
    }
    if (url.includes('?call_id='))
      return { status: sidebandOpens ? 101 : 403, webSocket: sidebandOpens ? sideband : null };
    return new Response(null, { status: 200 });
  });
  vi.stubGlobal('fetch', upstream);
  const page = new FakeSocket();
  new VoiceCall(page as never, { OPENAI_API_KEY: 'sk-test', DB: db }).listen();
  const hangups = () => upstream.mock.calls.filter(c => c[0].endsWith('/calls/rtc_1/hangup')).length;
  const call = () => raw.prepare('SELECT cost_micros, ended_at, end_reason FROM voice_calls').get() as any;
  const balanceNow = () => (raw.prepare('SELECT balance_micros FROM voice_keys').get() as any).balance_micros;
  return { page, sideband, upstream, raw, hash, hangups, call, balanceNow };
}

/** Connects and starts a call; the page has its answer. */
async function started(balance = 5_000_000) {
  const c = await connect(balance);
  c.page.emit({ type: 'start', key: KEY, sdp: OFFER });
  await settle();
  expect(c.page.last('answer')).toEqual({ type: 'answer', sdp: ANSWER, call_id: 'rtc_1' });
  return c;
}

const done = (audioOut: number) => ({
  type: 'response.done',
  response: { usage: { output_token_details: { audio_tokens: audioOut } } },
});

describe('starting a call', () => {
  it.each([undefined, '', 'open sesame', 'eqv_' + 'x'.repeat(43)])(
    'refuses key %j without calling OpenAI',
    async key => {
      const { page, upstream } = await connect();
      page.emit({ type: 'start', key, sdp: OFFER });
      await settle();
      expect(page.last('refused')).toEqual({ type: 'refused', error: 'forbidden' });
      expect(page.closed).toBe(true);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it('refuses a disabled key, and one without enough credit to start', async () => {
    const disabled = await connect();
    disabled.raw.prepare('UPDATE voice_keys SET disabled = 1').run();
    disabled.page.emit({ type: 'start', key: KEY, sdp: OFFER });
    await settle();
    expect(disabled.page.last('refused')).toMatchObject({ error: 'forbidden' });

    const poor = await connect(99_999);
    poor.page.emit({ type: 'start', key: KEY, sdp: OFFER });
    await settle();
    expect(poor.page.last('refused')).toEqual({ type: 'refused', error: 'no_credit', balance_micros: 99_999 });
    expect(poor.upstream).not.toHaveBeenCalled();
  });

  it('refuses a third call on one key while two are open', async () => {
    const { page, raw, hash, upstream } = await connect();
    for (const id of ['a', 'b']) {
      raw.prepare('INSERT INTO voice_calls (call_id, key_hash, started_at) VALUES (?, ?, ?)').run(id, hash, Date.now());
    }
    page.emit({ type: 'start', key: KEY, sdp: OFFER });
    await settle();
    expect(page.last('refused')).toMatchObject({ error: 'too_many_calls' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('refuses something that is not an SDP offer, and a page that never sends one', async () => {
    const bad = await connect();
    bad.page.emit({ type: 'start', key: KEY, sdp: 'hello' });
    await settle();
    expect(bad.page.last('refused')).toMatchObject({ error: 'bad_request' });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const silent = await connect();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(silent.page.last('refused')).toMatchObject({ error: 'bad_request' });
    expect(silent.page.closed).toBe(true);
  });

  it('creates the call with the server key and fixed session, attaches the sideband, then answers', async () => {
    const { upstream, call } = await started();
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/realtime/calls');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-test');
    const form = init.body as FormData;
    expect(form.get('sdp')).toBe(OFFER);
    const session = JSON.parse(form.get('session') as string);
    expect(session).toMatchObject({ type: 'realtime', model: 'gpt-realtime-2.1' });
    expect(session.tools.map((t: { name: string }) => t.name)).toContain('look_at_graph');
    expect(upstream.mock.calls[1][0]).toBe('https://api.openai.com/v1/realtime?call_id=rtc_1');
    expect(call()).toMatchObject({ ended_at: null });
  });

  it('hangs up rather than let a call run unmetered when the sideband fails', async () => {
    const { page, hangups, call } = await connect(5_000_000, { sidebandOpens: false });
    page.emit({ type: 'start', key: KEY, sdp: OFFER });
    await settle();
    expect(page.last('answer')).toBeUndefined();
    expect(page.last('refused')).toMatchObject({ error: 'upstream' });
    expect(hangups()).toBe(1);
    expect(call()).toMatchObject({ end_reason: 'sideband failed' });
  });

  it('refuses the page and hangs up when setup fails part way', async () => {
    const c = await connect();
    // The call is created, then recording its id fails.
    c.raw.exec(
      "CREATE TRIGGER fail BEFORE UPDATE OF call_id ON voice_calls BEGIN SELECT RAISE(FAIL, 'D1 is down'); END",
    );
    c.page.emit({ type: 'start', key: KEY, sdp: OFFER });
    await settle();
    expect(c.page.last('refused')).toMatchObject({ error: 'upstream' });
    expect(c.page.closed).toBe(true);
    expect(c.hangups()).toBe(1);
    expect(c.call()).toMatchObject({ end_reason: 'setup failed' });
  });

  it('gives back the reserved slot when OpenAI refuses the call', async () => {
    const c = await connect();
    vi.stubGlobal('fetch', async () => new Response('busy', { status: 503 }));
    c.page.emit({ type: 'start', key: KEY, sdp: OFFER });
    await settle();
    expect(c.page.last('refused')).toMatchObject({ error: 'upstream' });
    expect(c.call()).toMatchObject({ end_reason: 'upstream' });
    expect(c.call().ended_at).not.toBeNull();
  });

  it('lets only MAX_OPEN_CALLS of many simultaneous starts through', async () => {
    const { db, raw } = testDb();
    seedKey(raw, await hashKey(KEY), 5_000_000);
    let n = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/realtime/calls')) {
        // Every start is in flight at once before any call exists.
        await new Promise(r => setTimeout(r, 20));
        return new Response(ANSWER, { status: 201, headers: { Location: `/v1/realtime/calls/rtc_${++n}` } });
      }
      if (url.includes('?call_id=')) return { status: 101, webSocket: new FakeSocket() };
      return new Response(null, { status: 200 });
    });
    const pages = Array.from({ length: 6 }, () => new FakeSocket());
    for (const page of pages) new VoiceCall(page as never, { OPENAI_API_KEY: 'sk-test', DB: db }).listen();
    for (const page of pages) page.emit({ type: 'start', key: KEY, sdp: OFFER });
    await new Promise(r => setTimeout(r, 100));
    expect(pages.filter(p => p.last('answer')).length).toBe(MAX_OPEN_CALLS);
    expect(pages.filter(p => p.last('refused')?.error === 'too_many_calls').length).toBe(6 - MAX_OPEN_CALLS);
    expect(n).toBe(MAX_OPEN_CALLS);
  });

  it('ignores pings', async () => {
    const c = await started();
    const before = c.page.sent.length;
    c.page.emit({ type: 'ping' });
    await settle();
    expect(c.page.sent.length).toBe(before);
    expect(c.page.closed).toBe(false);
    expect(c.hangups()).toBe(0);
  });

  it('hides upstream failure details', async () => {
    const { page } = await connect();
    vi.stubGlobal('fetch', async () => Response.json({ error: 'account acme-corp is over quota' }, { status: 429 }));
    page.emit({ type: 'start', key: KEY, sdp: OFFER });
    await settle();
    expect(page.sent).toEqual([{ type: 'refused', error: 'upstream' }]);
  });
});

describe('hangUp', () => {
  it('retries a failed hangup once, and fails when OpenAI never confirms', async () => {
    const statuses = [500, 200];
    const fetch = vi.fn(async () => new Response(null, { status: statuses.shift() ?? 500 }));
    vi.stubGlobal('fetch', fetch);
    await hangUp('rtc_1', 'sk');
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockClear();
    await expect(hangUp('rtc_1', 'sk')).rejects.toThrow('HTTP 500');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('counts a call that is already gone as hung up', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
    await expect(hangUp('rtc_1', 'sk')).resolves.toBeUndefined();
  });
});

describe('sessionIntact', () => {
  const base = () => structuredClone(SESSION_CONFIG) as any;
  it('accepts the session as created, with fields the server fills in', () => {
    const s = base();
    s.audio.input.turn_detection.eagerness = 'auto';
    s.tools = [...s.tools].reverse();
    expect(sessionIntact(s)).toBe(true);
  });
  it.each<[string, (s: any) => void]>([
    ['instructions', s => (s.instructions = 'Speak like a pirate.')],
    ['tools', s => s.tools.pop()],
    ['transcription', s => (s.audio.input.transcription = { model: 'gpt-4o-transcribe' })],
    ['turn detection', s => (s.audio.input.turn_detection.create_response = true)],
    ['no turn detection', s => (s.audio.input.turn_detection = null)],
  ])('rejects changed %s', (_, change) => {
    const s = base();
    change(s);
    expect(sessionIntact(s)).toBe(false);
  });
});

describe('a live call', () => {
  it('charges each response to the key and the call', async () => {
    const { sideband, call, balanceNow, hangups } = await started(1_000_000);
    sideband.emit(done(1000)); // 1000 × 64 µ$
    sideband.emit(done(500));
    sideband.emit({ type: 'response.done', response: {} }); // no usage: free
    await settle();
    expect(balanceNow()).toBe(1_000_000 - 1500 * 64);
    expect(call()).toMatchObject({ cost_micros: 1500 * 64, ended_at: null });
    expect(hangups()).toBe(0);
  });

  it('hangs up once the balance runs out, and says why', async () => {
    const { sideband, page, call, hangups } = await started(100_000);
    sideband.emit(done(1000)); // 64,000 µ$: still in credit
    await settle();
    expect(hangups()).toBe(0);
    sideband.emit(done(1000)); // now -28,000
    await settle();
    expect(hangups()).toBe(1);
    expect(sideband.closed).toBe(true);
    expect(page.last('ended')).toEqual({ type: 'ended', reason: 'out of credit' });
    expect(page.closed).toBe(true);
    expect(call()).toMatchObject({ cost_micros: 128_000, end_reason: 'out of credit' });
  });

  it('hangs up when the page goes, settling charges still in flight', async () => {
    const { sideband, page, call, hangups } = await started();
    sideband.emit(done(10));
    page.close();
    await settle();
    expect(hangups()).toBe(1);
    expect(call()).toMatchObject({ cost_micros: 640, end_reason: 'ended' });
  });

  it('records the call before closing either socket, and tells the page why first', async () => {
    const c = await started();
    const order: string[] = [];
    const closeSideband = c.sideband.close.bind(c.sideband);
    c.sideband.close = () => {
      order.push(`sideband closed, call ${c.call().ended_at ? 'recorded' : 'open'}`);
      closeSideband();
    };
    c.upstream.mockImplementation(async (url: string) => {
      if (url.endsWith('/hangup')) order.push(`hangup, page told ${c.page.last('ended')?.reason}`);
      return new Response(null, { status: 200 });
    });
    c.sideband.emit(done(100_000)); // $6.40: over the balance
    await settle();
    expect(order).toEqual(['hangup, page told out of credit', 'sideband closed, call recorded']);
    expect(c.page.closed).toBe(true);
  });

  it('hangs up when the page changes the session', async () => {
    const c = await started();
    const session = structuredClone(SESSION_CONFIG) as any;
    c.sideband.emit({ type: 'session.updated', session });
    await settle();
    expect(c.hangups()).toBe(0);
    session.audio.input.transcription = { model: 'gpt-4o-transcribe' };
    c.sideband.emit({ type: 'session.updated', session });
    await settle();
    expect(c.hangups()).toBe(1);
    expect(c.call()).toMatchObject({ end_reason: 'session changed' });
  });

  it('retries a failed charge once, and ends a call it still cannot charge', async () => {
    const c = await started();
    c.raw.exec("CREATE TRIGGER flaky BEFORE INSERT ON voice_ledger BEGIN SELECT RAISE(FAIL, 'D1 is down'); END");
    c.sideband.emit(done(10));
    await settle();
    expect(c.hangups()).toBe(1);
    expect(c.page.last('ended')).toEqual({ type: 'ended', reason: 'billing failed' });
    expect(c.call()).toMatchObject({ end_reason: 'billing failed', cost_micros: 0 });
  });

  it('charges on the retry when the first attempt fails', async () => {
    const c = await started();
    let failures = 1;
    c.raw.function('flake', () => (failures-- > 0 ? 1 : 0));
    c.raw.exec("CREATE TRIGGER flaky BEFORE INSERT ON voice_ledger WHEN flake() BEGIN SELECT RAISE(FAIL, 'blip'); END");
    c.sideband.emit(done(10));
    await settle();
    expect(c.hangups()).toBe(0);
    expect(c.call()).toMatchObject({ cost_micros: 640, ended_at: null });
  });

  it('ends the call when the sideband errors', async () => {
    const c = await started();
    c.sideband.fail();
    await settle();
    expect(c.hangups()).toBe(1);
    expect(c.call()).toMatchObject({ end_reason: 'sideband error' });
  });

  it('hangs up at the time limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const c = await connect();
    c.page.emit({ type: 'start', key: KEY, sdp: OFFER });
    await until(() => c.page.last('answer'));
    await vi.advanceTimersByTimeAsync(MAX_CALL_MS);
    await until(() => c.page.last('ended'));
    expect(c.hangups()).toBe(1);
    expect(c.page.last('ended')).toEqual({ type: 'ended', reason: 'time limit' });
  });

  it('adds a screenshot to the conversation and tells the page once it is in', async () => {
    const { sideband, page } = await started();
    const image = 'data:image/jpeg;base64,AAAA';
    page.emit({ type: 'image', id: 'p1', image, legend: 'y = x (red)' });
    await settle();
    const sent = sideband.last('conversation.item.create');
    expect(sent).toMatchObject({
      item: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'y = x (red)' },
          { type: 'input_image', image_url: image },
        ],
      },
    });
    sideband.emit({ type: 'conversation.item.added', item: { id: sent.item.id } });
    await settle();
    expect(page.last('image.done')).toEqual({ type: 'image.done', id: 'p1' });
  });

  it('reports a rejected image, and refuses anything but a small image data URL', async () => {
    const { sideband, page } = await started();
    page.emit({ type: 'image', id: 'p1', image: 'data:image/png;base64,AAAA', legend: '' });
    await settle();
    sideband.emit({
      type: 'error',
      error: { message: 'bad image', event_id: sideband.last('conversation.item.create').event_id },
    });
    await settle();
    expect(page.last('image.done')).toEqual({ type: 'image.done', id: 'p1', error: 'bad image' });
    const sentBefore = sideband.sent.length;
    for (const [id, image] of [
      ['a', 'https://evil.example/x.png'],
      ['b', 'data:text/html;base64,PGI+'],
      ['c', 'data:image/jpeg;base64,' + 'A'.repeat(1_500_000)],
    ]) {
      page.emit({ type: 'image', id, image, legend: '' });
      await settle();
      expect(page.last('image.done')).toEqual({ type: 'image.done', id, error: 'bad image' });
    }
    expect(sideband.sent.length).toBe(sentBefore);
  });
});
