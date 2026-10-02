#!/usr/bin/env node
/**
 * Who uses equation.io, from data Cloudflare already keeps.
 *
 *   pnpm traffic [days]                   the last 7 days by default, at most 30
 *   ./scripts/traffic.ts [days]           the same
 *
 * Site: unique IPs per day on each page, from the zone's HTTP analytics, using
 * GETs with a browser user agent only. The dashboard's "unique visitors" also
 * counts scanners probing /.env and the like (the single-page fallback answers
 * them 200), so it reads several times too high. This is still an upper bound
 * on people: a scanner claiming to be Chrome gets through, and a school behind
 * one IP counts once. IPs are fetched to be counted and never printed.
 *
 * MCP: POSTs to /mcp per day and by user agent, from the same analytics. Most
 * come from registries and liveness monitors, and one session is several
 * POSTs. The tool calls themselves (worker/mcp-usage.ts) are in Analytics
 * Engine, which wrangler's login can't read: set CLOUDFLARE_API_TOKEN to a
 * token with Account Analytics: Read to include them.
 *
 * Uses your wrangler login (`wrangler login`) for the zone analytics.
 */
import { execFileSync } from 'node:child_process';
import { LANDINGS } from '../lib/landings.ts';

const days = Number(process.argv[2] ?? 7);
if (!Number.isInteger(days) || days < 1 || days > 30) {
  console.error('usage: node scripts/traffic.ts [days ≤ 30]');
  process.exit(1);
}

type Json = Record<string, any>;

const login = execFileSync('npx', ['wrangler', 'auth', 'token'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
})
  .trim()
  .split('\n')
  .pop()!;

async function cf(path: string, token: string, init: RequestInit = {}): Promise<Json> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<Json>;
}

const { result: zones } = await cf('/zones?name=equation.io', login);
const zone: string = zones[0].id;
const account: string = zones[0].account.id;

const until = new Date();
// Whole UTC days, today included, so only today's row is a partial day.
const since = new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), until.getUTCDate() - (days - 1)));

/** httpRequestsAdaptiveGroups over the window, filtered and grouped as asked. */
async function adaptive(filter: string, dimensions: string, extra = ''): Promise<Json[]> {
  const query = `query($zone: String!, $since: Time!, $until: Time!) { viewer { zones(filter: {zoneTag: $zone}) {
    httpRequestsAdaptiveGroups(limit: 10000, filter: {datetime_geq: $since, datetime_lt: $until, ${filter}} ${extra}) {
      count
      dimensions { ${dimensions} }
    } } } }`;
  const body = await cf('/graphql', login, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { zone, since: since.toISOString(), until: until.toISOString() } }),
  });
  if (body.errors?.length) throw new Error(body.errors.map((e: Json) => e.message).join('; '));
  const groups: Json[] = body.data.viewer.zones[0].httpRequestsAdaptiveGroups;
  if (groups.length === 10000) console.warn(`(hit the 10000-group limit for ${filter}; counts are low)`);
  return groups;
}

// --- site ---

const BROWSER = `userAgent_like: "Mozilla/%", AND: [${[
  '%bot%',
  '%Bot%',
  '%crawl%',
  '%spider%',
  '%Headless%',
  '%preview%',
]
  .map(p => `{userAgent_notlike: "${p}"}`)
  .join(', ')}]`;
const PAGES: [string, string][] = [
  ['/', 'clientRequestPath: "/"'],
  ['/g/', 'clientRequestPath_like: "/g/%"'],
  ['/about/', 'clientRequestPath: "/about/"'],
  ...LANDINGS.map(l => [l.path, `clientRequestPath: "${l.path}"`] as [string, string]),
  ['/privacy/', 'clientRequestPath: "/privacy/"'],
  ['/terms/', 'clientRequestPath: "/terms/"'],
];

/** day → page → IPs, with 'site' the union across pages. */
const ips = new Map<string, Map<string, Set<string>>>();
const add = (day: string, page: string, ip: string) => {
  if (!ips.has(day)) ips.set(day, new Map());
  const byPage = ips.get(day)!;
  if (!byPage.has(page)) byPage.set(page, new Set());
  byPage.get(page)!.add(ip);
};
for (const [page, filter] of PAGES) {
  for (const g of await adaptive(`clientRequestHTTPMethodName: "GET", ${filter}, ${BROWSER}`, 'date clientIP')) {
    add(g.dimensions.date, page, g.dimensions.clientIP);
    add(g.dimensions.date, 'site', g.dimensions.clientIP);
  }
}
const columns = ['site', ...PAGES.map(([page]) => page)];
console.log(
  `Unique IPs per day (UTC) with a browser user agent, all pages ("site") and each page. Upper bound on people.`,
);
console.table(
  [...ips.keys()]
    .sort()
    .reverse()
    .map(day => Object.fromEntries([['day', day], ...columns.map(c => [c, ips.get(day)!.get(c)?.size ?? 0])])),
);
const week = new Set([...ips.values()].flatMap(byPage => [...(byPage.get('site') ?? [])]));
console.log(`Distinct IPs across all ${days} days (UTC, today so far): ${week.size}`);

// --- MCP traffic ---

const mcp = 'clientRequestPath: "/mcp", clientRequestHTTPMethodName: "POST"';
const mcpDays = await adaptive(mcp, 'date', ', orderBy: [date_DESC]');
console.log(`\nPOST /mcp per day: ${mcpDays.map(g => `${g.dimensions.date}: ${g.count}`).join(', ')}`);
const agents = await adaptive(mcp, 'userAgent', ', orderBy: [count_DESC]');
console.log(`POST /mcp by user agent, last ${days} days (top 12):`);
console.table(
  agents.slice(0, 12).map(g => ({ posts: g.count, 'user agent': String(g.dimensions.userAgent).slice(0, 100) })),
);

// --- MCP tool calls (Analytics Engine) ---

const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  console.log('\nMCP tool calls: set CLOUDFLARE_API_TOKEN (Account Analytics: Read) to include them.');
  process.exit(0);
}

async function sql(query: string): Promise<Json[]> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: `${query} FORMAT JSON`,
  });
  if (!res.ok) throw new Error(`Analytics Engine ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { data: Json[] }).data;
}

// blob1 kind, blob2 tool, blob3 client, blob4 type; double1 rows, double2
// error rows, double3 invalid, double4 failed (worker/mcp-usage.ts).
const from = `timestamp >= toDateTime('${since.toISOString().slice(0, 19).replace('T', ' ')}')`;
const calls = `FROM equation_mcp WHERE blob1 = 'call' AND ${from}`;
const n = (v: unknown) => Number(v ?? 0);
const [perDay, perTool, perClient, perType] = await Promise.all([
  sql(
    `SELECT toStartOfDay(timestamp) AS day, SUM(_sample_interval) AS calls,
       SUM(_sample_interval * double3) AS invalid, SUM(_sample_interval * double4) AS failed
     ${calls} GROUP BY day ORDER BY day DESC`,
  ),
  sql(
    `SELECT blob2 AS tool, SUM(_sample_interval) AS calls, SUM(_sample_interval * double3) AS invalid,
       SUM(_sample_interval * double4) AS failed, SUM(_sample_interval * double1) AS rows,
       SUM(_sample_interval * double2) AS error_rows
     ${calls} GROUP BY tool ORDER BY calls DESC`,
  ),
  sql(`SELECT blob3 AS client, SUM(_sample_interval) AS calls ${calls} GROUP BY client ORDER BY calls DESC LIMIT 12`),
  sql(
    `SELECT blob4 AS type, SUM(_sample_interval) AS calls FROM equation_mcp
     WHERE blob1 = 'type' AND ${from} GROUP BY type ORDER BY calls DESC`,
  ),
]);
const pct = (part: unknown, whole: unknown) => (n(whole) ? `${Math.round((100 * n(part)) / n(whole))}%` : '');
console.log('\nMCP tool calls per day. invalid: some row had an error; failed: the call was rejected outright.');
console.table(
  perDay.map(r => ({
    day: String(r.day).slice(0, 10),
    calls: n(r.calls),
    invalid: pct(r.invalid, r.calls),
    failed: pct(r.failed, r.calls),
  })),
);
console.table(
  perTool.map(r => ({
    tool: r.tool,
    calls: n(r.calls),
    invalid: pct(r.invalid, r.calls),
    failed: pct(r.failed, r.calls),
    'rows/call': n(r.calls) ? (n(r.rows) / n(r.calls)).toFixed(1) : '',
    'error rows': pct(r.error_rows, r.rows),
  })),
);
console.table(perClient.map(r => ({ client: r.client || '?', calls: n(r.calls) })));
console.log('Graph types in MCP calls (calls that drew each):');
console.table(perType.map(r => ({ type: r.type, calls: n(r.calls) })));
