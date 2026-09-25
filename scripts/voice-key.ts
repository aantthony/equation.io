/**
 * Voice mode credit keys (worker/voice-credit.ts), managed straight in D1 via
 * `wrangler d1 execute`, so there is no admin endpoint to attack.
 *
 *   node scripts/voice-key.ts create <label> <dollars>   print a new key
 *   node scripts/voice-key.ts grant <id> <dollars>       add (or with -, remove) credit
 *   node scripts/voice-key.ts disable <id>               refuse the key from now on
 *   node scripts/voice-key.ts enable <id>
 *   node scripts/voice-key.ts list
 *
 * <id> is the start of a key's hash, as `list` prints it. Add --remote to
 * act on the deployed database; the default is the local dev one.
 */
import { execFileSync } from 'node:child_process';
import { generateKey, hashKey } from '../worker/voice-credit.ts';

const args = process.argv.slice(2);
const remote = args.includes('--remote');
const [command, ...rest] = args.filter(a => a !== '--remote');

function sql(command: string): Record<string, unknown>[] {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'DB', remote ? '--remote' : '--local', '--json', '--command', command],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const results = JSON.parse(out) as { results: Record<string, unknown>[] }[];
  return results.flatMap(r => r.results);
}

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

function micros(dollars: string | undefined): number {
  const n = Number(dollars);
  if (!dollars || !Number.isFinite(n)) throw new Error(`not an amount in dollars: ${dollars}`);
  return Math.round(n * 1e6);
}

/** The one key whose hash starts with `id`. */
function resolve(id: string | undefined): string {
  if (!id || !/^[0-9a-f]{6,64}$/.test(id))
    throw new Error('give the start of a key hash (6+ hex digits), as list prints it');
  const rows = sql(`SELECT key_hash FROM voice_keys WHERE key_hash LIKE ${quote(id + '%')}`);
  if (rows.length !== 1) throw new Error(rows.length ? `${id} matches ${rows.length} keys` : `no key ${id}`);
  return rows[0].key_hash as string;
}

const now = Date.now();

switch (command) {
  case 'create': {
    const [label, dollars] = rest;
    if (!label) throw new Error('usage: create <label> <dollars>');
    const amount = micros(dollars);
    const key = generateKey();
    const hash = await hashKey(key);
    sql(
      `INSERT INTO voice_keys (key_hash, label, balance_micros, created_at) VALUES (${quote(hash)}, ${quote(label)}, ${amount}, ${now});` +
        `INSERT INTO voice_ledger (key_hash, at, delta_micros, reason) VALUES (${quote(hash)}, ${now}, ${amount}, 'grant');`,
    );
    console.log(`Created ${hash.slice(0, 12)} (${label}) with $${(amount / 1e6).toFixed(2)}.`);
    console.log(`Key (shown once): ${key}`);
    // A local key exists only in the dev server's database.
    const origin = remote ? 'https://equation.io' : 'http://localhost:5173';
    // A fragment never reaches the server, so the key stays out of request logs.
    console.log(`Unlock a browser with: ${origin}/#voice=${key}${remote ? '' : ' (or your dev port)'}`);
    break;
  }
  case 'grant': {
    const hash = resolve(rest[0]);
    const amount = micros(rest[1]);
    sql(
      `UPDATE voice_keys SET balance_micros = balance_micros + ${amount} WHERE key_hash = ${quote(hash)};` +
        `INSERT INTO voice_ledger (key_hash, at, delta_micros, reason) VALUES (${quote(hash)}, ${now}, ${amount}, 'grant');`,
    );
    const [row] = sql(`SELECT balance_micros FROM voice_keys WHERE key_hash = ${quote(hash)}`);
    console.log(`${hash.slice(0, 12)} now has $${((row.balance_micros as number) / 1e6).toFixed(2)}.`);
    break;
  }
  case 'disable':
  case 'enable': {
    const hash = resolve(rest[0]);
    sql(`UPDATE voice_keys SET disabled = ${command === 'disable' ? 1 : 0} WHERE key_hash = ${quote(hash)}`);
    console.log(`${hash.slice(0, 12)} ${command}d.`);
    break;
  }
  case 'list': {
    const rows = sql(
      `SELECT substr(k.key_hash, 1, 12) AS id, k.label, k.balance_micros, k.disabled,
              COUNT(c.call_id) AS calls, COALESCE(SUM(c.cost_micros), 0) AS spent_micros
         FROM voice_keys k LEFT JOIN voice_calls c ON c.key_hash = k.key_hash
        GROUP BY k.key_hash ORDER BY k.created_at`,
    );
    console.table(
      rows.map(r => ({
        id: r.id,
        label: r.label,
        balance: `$${((r.balance_micros as number) / 1e6).toFixed(2)}`,
        spent: `$${((r.spent_micros as number) / 1e6).toFixed(2)}`,
        calls: r.calls,
        disabled: r.disabled ? 'yes' : '',
      })),
    );
    break;
  }
  default:
    console.log('usage: node scripts/voice-key.ts create|grant|disable|enable|list … [--remote]');
    process.exitCode = 1;
}
