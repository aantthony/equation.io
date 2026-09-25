import { describe, expect, it } from 'vitest';
import { seedKey, testDb } from './d1.fixtures.ts';
import {
  charge,
  claimCall,
  endCall,
  generateKey,
  hashKey,
  isKeyShaped,
  reserveCall,
  usageCost,
} from './voice-credit.ts';

describe('credit keys', () => {
  it('are prefixed, unguessable and stored only as a hash', async () => {
    const a = generateKey();
    const b = generateKey();
    expect(a).toMatch(/^eqv_[\w-]{43}$/);
    expect(a).not.toBe(b);
    expect(isKeyShaped(a)).toBe(true);
    expect(isKeyShaped('open sesame')).toBe(false);
    expect(isKeyShaped('eqv_short')).toBe(false);
    expect(await hashKey(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashKey(a)).toBe(await hashKey(a));
  });
});

describe('usageCost', () => {
  it('prices each kind of token at the gpt-realtime-2.1 rate, cached input at the cached rate', () => {
    // 1000 audio in (400 cached), 50 text in, 2000 audio out, 30 text out, 800 image in.
    const cost = usageCost({
      input_token_details: {
        text_tokens: 50,
        audio_tokens: 1000,
        image_tokens: 800,
        cached_tokens_details: { audio_tokens: 400 },
      },
      output_token_details: { text_tokens: 30, audio_tokens: 2000 },
    });
    expect(cost).toBe(Math.ceil(50 * 4 + 600 * 32 + 400 * 0.4 + 800 * 5 + 30 * 24 + 2000 * 64));
  });

  it('is zero for missing or malformed usage, never negative', () => {
    expect(usageCost(undefined)).toBe(0);
    expect(usageCost({})).toBe(0);
    expect(usageCost({ output_token_details: { audio_tokens: -5 } })).toBe(0);
    // More cached than total can't make a refund.
    expect(usageCost({ input_token_details: { audio_tokens: 10, cached_tokens_details: { audio_tokens: 99 } } })).toBe(
      4,
    );
  });
});

describe('ledger', () => {
  it('charges the key and the call atomically and records each charge', async () => {
    const { db, raw } = testDb();
    seedKey(raw, 'h1', 1_000_000);
    raw.prepare("INSERT INTO voice_calls (call_id, key_hash, started_at) VALUES ('rtc_1', 'h1', 100)").run();
    expect(await charge(db, 'h1', 'rtc_1', 250_000, '{}', 200)).toBe(750_000);
    expect(await charge(db, 'h1', 'rtc_1', 900_000, '{}', 300)).toBe(-150_000);
    expect(raw.prepare('SELECT balance_micros FROM voice_keys').get()).toEqual({ balance_micros: -150_000 });
    expect(raw.prepare('SELECT cost_micros FROM voice_calls').get()).toEqual({ cost_micros: 1_150_000 });
    expect(raw.prepare('SELECT SUM(delta_micros) AS s, COUNT(*) AS n FROM voice_ledger').get()).toEqual({
      s: -1_150_000,
      n: 2,
    });
  });

  it('reserves a call only for an enabled key with credit and a free slot, counting recent open calls', async () => {
    const { db, raw } = testDb();
    seedKey(raw, 'h1', 100);
    seedKey(raw, 'poor', 99);
    seedKey(raw, 'off', 100, 1);
    const limits = { since: 500, maxOpen: 2, minMicros: 100 };
    const insert = raw.prepare('INSERT INTO voice_calls (call_id, key_hash, started_at) VALUES (?, ?, ?)');
    insert.run('old', 'h1', 0); // too old to count
    insert.run('live', 'h1', 1000);
    insert.run('done', 'h1', 1000);
    await endCall(db, 'done', 'ended', 2000);

    expect(await reserveCall(db, 'h1', 'p1', 3000, limits)).toEqual({
      key: { label: 'test', balance_micros: 100, disabled: 0 },
      reserved: true,
    });
    // live and p1 are open: the cap is reached.
    expect((await reserveCall(db, 'h1', 'p2', 3000, limits)).reserved).toBe(false);
    for (const hash of ['poor', 'off'])
      expect((await reserveCall(db, hash, `p_${hash}`, 3000, limits)).reserved).toBe(false);
    expect(await reserveCall(db, 'nobody', 'p3', 3000, limits)).toEqual({ key: null, reserved: false });
    expect((raw.prepare('SELECT COUNT(*) AS n FROM voice_calls').get() as { n: number }).n).toBe(4);

    await claimCall(db, 'p1', 'rtc_9');
    expect(raw.prepare("SELECT key_hash, started_at FROM voice_calls WHERE call_id = 'rtc_9'").get()).toEqual({
      key_hash: 'h1',
      started_at: 3000,
    });
    // Ending twice keeps the first reason.
    await endCall(db, 'done', 'again', 3000);
    expect(raw.prepare("SELECT end_reason FROM voice_calls WHERE call_id = 'done'").get()).toEqual({
      end_reason: 'ended',
    });
  });
});
