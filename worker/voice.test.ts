import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedKey, testDb } from './d1.fixtures.ts';
import worker from './index.ts';
import { hashKey } from './voice-credit.ts';

const KEY = 'eqv_' + 'k'.repeat(43);
const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n';
const ANSWER = 'v=0\r\no=answer\r\n';

afterEach(() => vi.unstubAllGlobals());

/** A configured deployment: a database with KEY at `balance`, and call objects that record what they're asked. */
async function setup(balance = 5_000_000, sideband: (path: string, body: any) => Response = () => new Response('ok')) {
  const { db, raw } = testDb();
  const hash = await hashKey(KEY);
  seedKey(raw, hash, balance);
  const asked: { name: string; path: string; body: any }[] = [];
  const VOICE_CALLS = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      fetch: async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        const body = JSON.parse(init.body as string);
        asked.push({ name, path, body });
        return sideband(path, body);
      },
    }),
  };
  return { env: { OPENAI_API_KEY: 'sk-test', DB: db, VOICE_CALLS } as unknown as Env, raw, hash, asked };
}

const call = (env: Env, key: string | null = KEY, body = OFFER) =>
  worker.fetch(
    new Request('https://equation.io/api/voice/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp', ...(key === null ? {} : { 'X-Voice-Key': key }) },
      body,
    }),
    env,
  );

/** OpenAI's side: creating a call answers the offer; anything else (hangup) just succeeds. */
function openai() {
  const upstream = vi.fn(async (url: string) =>
    url.endsWith('/v1/realtime/calls')
      ? new Response(ANSWER, { status: 201, headers: { Location: '/v1/realtime/calls/rtc_abc123' } })
      : new Response(null, { status: 200 }),
  );
  vi.stubGlobal('fetch', upstream);
  return upstream;
}

describe('/api/voice/call', () => {
  it('does not exist until the key and both bindings are configured', async () => {
    const { env } = await setup();
    for (const missing of ['OPENAI_API_KEY', 'DB', 'VOICE_CALLS']) {
      const partial = { ...env, [missing]: undefined } as Env;
      expect((await call(partial)).status).toBe(404);
    }
  });

  it.each([null, '', 'open sesame', 'eqv_' + 'x'.repeat(43)])('refuses key %j without calling OpenAI', async key => {
    const { env } = await setup();
    const upstream = openai();
    expect((await call(env, key)).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('refuses a disabled key, and a key without enough credit to start', async () => {
    const upstream = openai();
    const disabled = await setup();
    disabled.raw.prepare('UPDATE voice_keys SET disabled = 1').run();
    expect((await call(disabled.env)).status).toBe(403);
    const poor = await setup(99_999);
    const res = await call(poor.env);
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'no_credit', balance_micros: 99_999 });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('refuses a third call on one key while two are open', async () => {
    const { env, raw, hash } = await setup();
    const upstream = openai();
    for (const id of ['a', 'b']) {
      raw.prepare('INSERT INTO voice_calls (call_id, key_hash, started_at) VALUES (?, ?, ?)').run(id, hash, Date.now());
    }
    expect((await call(env)).status).toBe(429);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rejects a body that is not an SDP offer', async () => {
    const { env } = await setup();
    openai();
    expect((await call(env, KEY, 'hello')).status).toBe(400);
  });

  it('creates the call with the server key and fixed session, starts its sideband, then answers', async () => {
    const { env, raw, hash, asked } = await setup();
    const upstream = openai();
    const res = await call(env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/sdp');
    expect(res.headers.get('x-voice-call')).toBe('rtc_abc123');
    expect(await res.text()).toBe(ANSWER);

    const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/realtime/calls');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-test');
    const form = init.body as FormData;
    expect(form.get('sdp')).toBe(OFFER);
    const session = JSON.parse(form.get('session') as string);
    expect(session).toMatchObject({ type: 'realtime', model: 'gpt-realtime-2.1' });
    expect(session.tools.map((t: { name: string }) => t.name)).toContain('look_at_graph');

    expect(asked).toEqual([{ name: 'rtc_abc123', path: '/start', body: { callId: 'rtc_abc123', keyHash: hash } }]);
    expect(raw.prepare('SELECT call_id, ended_at FROM voice_calls').all()).toEqual([
      { call_id: 'rtc_abc123', ended_at: null },
    ]);
  });

  it('hangs up rather than let a call run unmetered when the sideband fails', async () => {
    const { env, raw } = await setup(5_000_000, () => new Response('no', { status: 502 }));
    const upstream = openai();
    expect((await call(env)).status).toBe(502);
    expect(upstream.mock.calls.map(c => c[0])).toContain('https://api.openai.com/v1/realtime/calls/rtc_abc123/hangup');
    expect(raw.prepare('SELECT end_reason FROM voice_calls').get()).toEqual({ end_reason: 'sideband failed' });
  });

  it('hides upstream failure details', async () => {
    const { env } = await setup();
    vi.stubGlobal('fetch', async () => Response.json({ error: 'account acme-corp is over quota' }, { status: 429 }));
    const res = await call(env);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('acme');
  });
});

const IMAGE = 'data:image/jpeg;base64,/9j/4AAQ';

const image = (env: Env, body: unknown, key = KEY) =>
  worker.fetch(
    new Request('https://equation.io/api/voice/image', {
      method: 'POST',
      headers: { 'X-Voice-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );

describe('/api/voice/image', () => {
  it("passes a screenshot to its own live call's sideband", async () => {
    const { env, raw, hash, asked } = await setup();
    raw.prepare("INSERT INTO voice_calls (call_id, key_hash, started_at) VALUES ('rtc_1', ?, 0)").run(hash);
    const res = await image(env, { call_id: 'rtc_1', image: IMAGE, legend: 'y = x^2 (blue)' });
    expect(res.status).toBe(200);
    expect(asked).toEqual([{ name: 'rtc_1', path: '/image', body: { image: IMAGE, legend: 'y = x^2 (blue)' } }]);
  });

  it("refuses another key's call, an ended call, and anything but a small image data URL", async () => {
    const { env, raw, asked } = await setup();
    raw
      .prepare("INSERT INTO voice_keys (key_hash, label, balance_micros, created_at) VALUES ('other', 'o', 1, 0)")
      .run();
    raw.prepare("INSERT INTO voice_calls (call_id, key_hash, started_at) VALUES ('theirs', 'other', 0)").run();
    expect((await image(env, { call_id: 'theirs', image: IMAGE, legend: '' })).status).toBe(404);
    expect((await image(env, { call_id: 'nope', image: IMAGE, legend: '' })).status).toBe(404);
    for (const bad of [
      { call_id: 'x', image: 'https://evil.example/x.png', legend: '' },
      { call_id: 'x', image: 'data:text/html;base64,PGI+', legend: '' },
      { call_id: 'x', image: IMAGE + 'A'.repeat(1_500_000), legend: '' },
      { call_id: 'x', image: IMAGE },
    ]) {
      expect((await image(env, bad)).status).toBe(400);
    }
    expect(asked).toEqual([]);
  });
});

describe('/api/voice/balance', () => {
  it("reports the key's balance", async () => {
    const { env } = await setup(1_234_567);
    const res = await worker.fetch(
      new Request('https://equation.io/api/voice/balance', { method: 'POST', headers: { 'X-Voice-Key': KEY } }),
      env,
    );
    expect(await res.json()).toEqual({ balance_micros: 1_234_567 });
  });
});

describe('retired routes', () => {
  it.each(['/api/voice/token', '/api/voice/look'])('%s is gone', async path => {
    const { env } = await setup();
    const res = await worker.fetch(new Request(`https://equation.io${path}`, { method: 'POST' }), env);
    expect(res.status).toBe(404);
  });
});
