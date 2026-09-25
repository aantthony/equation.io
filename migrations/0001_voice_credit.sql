-- Voice mode credit (worker/voice-credit.ts). Amounts are integer micro-dollars
-- (1 USD = 1_000_000): OpenAI prices per million tokens, so a token at
-- $32 / 1M costs exactly 32 micro-dollars.

-- A credit key is a bearer secret handed to one person; only its SHA-256 is
-- stored, so a database leak does not leak usable keys.
CREATE TABLE voice_keys (
  key_hash TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  balance_micros INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0
);

-- One row per Realtime call, opened when the Worker creates it and closed by
-- its sideband (worker/voice-call.ts) when the call ends.
CREATE TABLE voice_calls (
  call_id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL REFERENCES voice_keys (key_hash),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  end_reason TEXT
);
CREATE INDEX voice_calls_open ON voice_calls (key_hash, ended_at);

-- Every change to a balance: grants (positive) and usage charges (negative).
CREATE TABLE voice_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT NOT NULL REFERENCES voice_keys (key_hash),
  at INTEGER NOT NULL,
  delta_micros INTEGER NOT NULL,
  reason TEXT NOT NULL,
  call_id TEXT,
  detail TEXT
);
CREATE INDEX voice_ledger_key ON voice_ledger (key_hash, at);
