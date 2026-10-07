/**
 * Collects the recorded parseExpr calls (record-parses.ts) into the Swift
 * conformance fixture: one entry per distinct input, sorted so a re-record
 * diffs cleanly.
 *
 *   pnpm swift:corpus
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { parseExpr } from '../../lib/expr.ts';
import { encodePayload } from '../../lib/link.ts';

const out = new URL('./out/', import.meta.url);
const fixtures = new URL('../EquationCore/Tests/EquationCoreTests/Fixtures/', import.meta.url);

interface Entry {
  src: string;
  userFns: string[];
  listNames: string[];
  valueNames: string[];
  expr?: unknown;
  error?: string;
  errorType?: string;
}

const byKey = new Map<string, Entry>();
for (const name of readdirSync(out)) {
  for (const line of readFileSync(new URL(name, out), 'utf8').split('\n')) {
    if (!line) continue;
    const e = JSON.parse(line) as Entry;
    e.userFns.sort();
    e.listNames.sort();
    e.valueNames.sort();
    const key = JSON.stringify([e.src, e.userFns, e.listNames, e.valueNames]);
    const seen = byKey.get(key);
    if (seen && JSON.stringify(seen) !== JSON.stringify(e)) throw new Error(`Nondeterministic parse: ${key}`);
    byKey.set(key, e);
  }
}

const entries = [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, e]) => e);
writeFileSync(new URL('parse-corpus.json', fixtures), JSON.stringify(entries) + '\n');
rmSync(out, { recursive: true });

// Every prefix of every input, as typing produces them: half-written rows are
// where auto-closing brackets and most of the errors live.
const replacer = (key: string, value: unknown): unknown =>
  typeof value === 'number' && !Number.isFinite(value) ? String(value) : value;
const prefixes = new Map<string, Entry>();
for (const e of entries) {
  const units = e.src.length;
  for (let n = 1; n < units; n++) {
    const src = e.src.slice(0, n);
    const key = JSON.stringify([src, e.userFns, e.listNames, e.valueNames]);
    if (byKey.has(key) || prefixes.has(key)) continue;
    const input = { src, userFns: e.userFns, listNames: e.listNames, valueNames: e.valueNames };
    try {
      const expr = parseExpr(src, new Set(e.userFns), new Set(e.listNames), new Set(e.valueNames));
      prefixes.set(key, JSON.parse(JSON.stringify({ ...input, expr }, replacer)) as Entry);
    } catch (err) {
      prefixes.set(key, { ...input, error: (err as Error).message, errorType: (err as Error).constructor.name });
    }
  }
}
const prefixList = [...prefixes.values()];
writeFileSync(new URL('parse-prefixes.json', fixtures), JSON.stringify(prefixList) + '\n');
console.log(`${prefixList.length} prefixes, ${prefixList.filter(e => e.error !== undefined).length} errors`);

// Share links: each input alone, runs of three as one graph, and the cases
// the codec exists for (a `;` or `%` inside a row, blank rows, unicode).
const sources = entries.map(e => e.src);
const graphs = [
  ...sources.map(s => [s]),
  ...sources.flatMap((_, k) => (k % 3 === 0 ? [sources.slice(k, k + 3)] : [])),
  ['people[people.city == "a;b"]', 'y = x'],
  ['y = 50% x', 'a = 2; b = 3'],
  ['  y = x  ', '', '\t', 'y = sin(x) # a (note)!'],
  ["y = x'", 'θ = π/4', 'f(x) = x² · e^x', '🙂 = 1'],
  [],
];
const links = graphs.map(rows => ({ rows, payload: encodePayload(rows) }));
writeFileSync(new URL('link-corpus.json', fixtures), JSON.stringify(links) + '\n');
console.log(`${links.length} share links`);

const errors = entries.filter(e => e.error !== undefined);
const types = Object.groupBy(errors, e => e.errorType ?? '?');
console.log(`${entries.length} distinct parses, ${errors.length} errors:`);
for (const [type, list] of Object.entries(types)) console.log(`  ${type}: ${list!.length}`);
