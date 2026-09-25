import { describe, expect, it } from 'vitest';
import { testDb } from './d1.fixtures.ts';
import worker from './index.ts';

// The call itself (worker/voice-call.test.ts) runs on the socket this route
// hands back; Node has no WebSocketPair, so only the refusals are tested here.
const CONFIGURED = { OPENAI_API_KEY: 'sk-test', DB: testDb().db } as unknown as Env;

const connect = (env: Env, headers: Record<string, string> = { Upgrade: 'websocket' }) =>
  worker.fetch(new Request('https://equation.io/api/voice/connect', { headers }), env);

describe('/api/voice/connect', () => {
  it('does not exist until the OpenAI key and the database are configured', async () => {
    for (const missing of ['OPENAI_API_KEY', 'DB']) {
      expect((await connect({ ...CONFIGURED, [missing]: undefined } as Env)).status).toBe(404);
    }
  });

  it('only upgrades to a WebSocket', async () => {
    const res = await connect(CONFIGURED, {});
    expect(res.status).toBe(426);
    expect(res.headers.get('upgrade')).toBe('websocket');
  });
});
