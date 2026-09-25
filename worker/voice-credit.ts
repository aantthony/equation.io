/**
 * Voice mode credit: bearer keys with a balance, charged for what each
 * Realtime call actually used. The schema is migrations/0001_voice_credit.sql;
 * amounts are integer micro-dollars.
 *
 * Keys are handed out by scripts/voice-key.ts. Only their SHA-256 is stored.
 */

/** Every key starts with this, so a pasted key is recognisable (and greppable in logs). */
export const KEY_PREFIX = 'eqv_';

/** A new credit key: the prefix and 32 random bytes, base64url. */
export function generateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return KEY_PREFIX + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const isKeyShaped = (key: string): boolean => key.startsWith(KEY_PREFIX) && /^[\w-]{40,64}$/.test(key.slice(4));

export async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * gpt-realtime-2.1 prices in dollars per million tokens, which is exactly
 * micro-dollars per token. Cached input is billed at the cached rate.
 */
export const PRICES = {
  text: { input: 4, cached: 0.4, output: 24 },
  audio: { input: 32, cached: 0.4, output: 64 },
  image: { input: 5, cached: 0.5 },
} as const;

/** The `usage` of a Realtime `response.done` event. */
export interface RealtimeUsage {
  input_token_details?: {
    text_tokens?: number;
    audio_tokens?: number;
    image_tokens?: number;
    cached_tokens_details?: { text_tokens?: number; audio_tokens?: number; image_tokens?: number };
  };
  output_token_details?: { text_tokens?: number; audio_tokens?: number };
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** What one response cost, in micro-dollars, rounded up. */
export function usageCost(usage: RealtimeUsage | undefined): number {
  const input = usage?.input_token_details;
  const cached = input?.cached_tokens_details;
  const output = usage?.output_token_details;
  let micros = 0;
  for (const kind of ['text', 'audio', 'image'] as const) {
    const all = count(input?.[`${kind}_tokens`]);
    const hit = Math.min(all, count(cached?.[`${kind}_tokens`]));
    micros += (all - hit) * PRICES[kind].input + hit * PRICES[kind].cached;
  }
  micros += count(output?.text_tokens) * PRICES.text.output + count(output?.audio_tokens) * PRICES.audio.output;
  return Math.ceil(micros);
}

export interface VoiceKey {
  label: string;
  balance_micros: number;
  disabled: number;
}

export function lookupKey(db: D1Database, keyHash: string): Promise<VoiceKey | null> {
  return db
    .prepare('SELECT label, balance_micros, disabled FROM voice_keys WHERE key_hash = ?')
    .bind(keyHash)
    .first<VoiceKey>();
}

/** Calls on this key started since `since` (ms) that have not ended. */
export async function openCalls(db: D1Database, keyHash: string, since: number): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM voice_calls WHERE key_hash = ? AND ended_at IS NULL AND started_at >= ?')
    .bind(keyHash, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function startCall(db: D1Database, callId: string, keyHash: string, now: number): Promise<void> {
  await db
    .prepare('INSERT INTO voice_calls (call_id, key_hash, started_at) VALUES (?, ?, ?)')
    .bind(callId, keyHash, now)
    .run();
}

/**
 * Charges one response to the key and the call, atomically, and returns the
 * key's balance afterwards. The balance may go below zero by at most one
 * response: the sideband hangs up as soon as it does.
 */
export async function charge(
  db: D1Database,
  keyHash: string,
  callId: string,
  micros: number,
  detail: string,
  now: number,
): Promise<number> {
  const [balance] = await db.batch<{ balance_micros: number }>([
    db
      .prepare('UPDATE voice_keys SET balance_micros = balance_micros - ? WHERE key_hash = ? RETURNING balance_micros')
      .bind(micros, keyHash),
    db.prepare('UPDATE voice_calls SET cost_micros = cost_micros + ? WHERE call_id = ?').bind(micros, callId),
    db
      .prepare(
        "INSERT INTO voice_ledger (key_hash, at, delta_micros, reason, call_id, detail) VALUES (?, ?, ?, 'usage', ?, ?)",
      )
      .bind(keyHash, now, -micros, callId, detail),
  ]);
  return balance.results[0]?.balance_micros ?? 0;
}

export async function endCall(db: D1Database, callId: string, reason: string, now: number): Promise<void> {
  await db
    .prepare('UPDATE voice_calls SET ended_at = ?, end_reason = ? WHERE call_id = ? AND ended_at IS NULL')
    .bind(now, reason, callId)
    .run();
}
