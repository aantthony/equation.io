import { describe, expect, it } from 'vitest';
import { seedKey, testDb } from './d1.fixtures.ts';
import {
  charge,
  endCall,
  generateKey,
  hashKey,
  isKeyShaped,
  lookupKey,
  openCalls,
  startCall,
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
    await startCall(db, 'rtc_1', 'h1', 100);
    expect(await charge(db, 'h1', 'rtc_1', 250_000, '{}', 200)).toBe(750_000);
    expect(await charge(db, 'h1', 'rtc_1', 900_000, '{}', 300)).toBe(-150_000);
    expect((await lookupKey(db, 'h1'))?.balance_micros).toBe(-150_000);
    expect(raw.prepare('SELECT cost_micros FROM voice_calls').get()).toEqual({ cost_micros: 1_150_000 });
    expect(raw.prepare('SELECT SUM(delta_micros) AS s, COUNT(*) AS n FROM voice_ledger').get()).toEqual({
      s: -1_150_000,
      n: 2,
    });
  });

  it('counts only recent open calls', async () => {
    const { db, raw } = testDb();
    seedKey(raw, 'h1', 1);
    await startCall(db, 'old', 'h1', 0);
    await startCall(db, 'live', 'h1', 1000);
    await startCall(db, 'done', 'h1', 1000);
    await endCall(db, 'done', 'ended', 2000);
    expect(await openCalls(db, 'h1', 500)).toBe(1);
    // Ending twice keeps the first reason.
    await endCall(db, 'done', 'again', 3000);
    expect(raw.prepare("SELECT end_reason FROM voice_calls WHERE call_id = 'done'").get()).toEqual({
      end_reason: 'ended',
    });
  });
});
