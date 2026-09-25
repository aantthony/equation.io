import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './index.ts';

const SECRETS = { OPENAI_API_KEY: 'sk-test-key', VOICE_PASSPHRASE: 'open sesame' };

const post = (env: object, passphrase?: string) =>
  worker.fetch(
    new Request('https://equation.io/api/voice/token', {
      method: 'POST',
      headers: passphrase === undefined ? {} : { 'X-Voice-Passphrase': passphrase },
    }),
    env as Env,
  );

afterEach(() => vi.unstubAllGlobals());

describe('/api/voice/token', () => {
  it('does not exist until both secrets are configured', async () => {
    expect((await post({}, 'open sesame')).status).toBe(404);
    expect((await post({ OPENAI_API_KEY: 'k' }, 'open sesame')).status).toBe(404);
    expect((await post({ VOICE_PASSPHRASE: 'open sesame' }, 'open sesame')).status).toBe(404);
  });

  it('only accepts POST', async () => {
    const res = await worker.fetch(new Request('https://equation.io/api/voice/token'), SECRETS as unknown as Env);
    expect(res.status).toBe(405);
  });

  it.each([undefined, '', 'open sesam', 'open sesame!'])('rejects passphrase %j without calling OpenAI', async p => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    expect((await post(SECRETS, p)).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('mints a short-lived client secret with the server key', async () => {
    const upstream = vi.fn(async () => Response.json({ value: 'secret-123', expires_at: 1750000000 }));
    vi.stubGlobal('fetch', upstream);
    const res = await post(SECRETS, 'open sesame');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ value: 'secret-123', expires_at: 1750000000 });

    const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/realtime/client_secrets');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-test-key');
    expect(JSON.parse(init.body as string)).toEqual({
      expires_after: { anchor: 'created_at', seconds: 60 },
      session: { type: 'realtime', model: 'gpt-realtime-2.1' },
    });
  });

  it('hides upstream failure details', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ error: 'account acme-corp is over quota' }, { status: 429 }));
    const res = await post(SECRETS, 'open sesame');
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('acme');
  });
});

describe('/api/voice/look', () => {
  it('is gone: the realtime model looks at screenshots itself', async () => {
    const res = await worker.fetch(
      new Request('https://equation.io/api/voice/look', {
        method: 'POST',
        headers: { 'X-Voice-Passphrase': 'open sesame' },
      }),
      SECRETS as unknown as Env,
    );
    expect(res.status).toBe(404);
  });
});
