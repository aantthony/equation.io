/**
 * A D1Database for tests, backed by node:sqlite and the real migrations, so
 * the SQL in the Worker runs against SQLite rather than a mock.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url).href);

class Statement {
  constructor(
    private db: DatabaseSync,
    readonly sql: string,
    readonly params: SQLInputValue[] = [],
  ) {}
  bind(...params: unknown[]) {
    return new Statement(this.db, this.sql, params as SQLInputValue[]);
  }
  rows(): Record<string, unknown>[] {
    return this.db.prepare(this.sql).all(...this.params) as Record<string, unknown>[];
  }
  async first<T>(): Promise<T | null> {
    return (this.rows()[0] as T) ?? null;
  }
  async all<T>() {
    return { results: this.rows() as T[], success: true, meta: {} };
  }
  async run() {
    return this.all();
  }
}

export function testDb(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS)
    .filter(f => f.endsWith('.sql'))
    .sort()) {
    raw.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  const db = {
    prepare: (sql: string) => new Statement(raw, sql),
    async batch(statements: Statement[]) {
      raw.exec('BEGIN');
      try {
        const out = statements.map(s => ({ results: s.rows(), success: true, meta: {} }));
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return { db: db as unknown as D1Database, raw };
}

/** Inserts a key with a balance; returns nothing (tests know the hash). */
export function seedKey(raw: DatabaseSync, keyHash: string, balanceMicros: number, disabled = 0) {
  raw
    .prepare('INSERT INTO voice_keys (key_hash, label, balance_micros, created_at, disabled) VALUES (?, ?, ?, 0, ?)')
    .run(keyHash, 'test', balanceMicros, disabled);
}
