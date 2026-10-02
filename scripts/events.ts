/**
 * Usage events (worker/events.ts) from Workers Analytics Engine.
 *
 *   node scripts/events.ts [days]        the last 7 days by default, at most 90
 *
 * Prints unique visitors per day (overall and per page), the graph types
 * drawn on the site and over MCP, and visitors by country, browser and device.
 *
 * Needs CLOUDFLARE_ACCOUNT_ID and a CLOUDFLARE_API_TOKEN with Account
 * Analytics: Read. Wrangler's own login cannot read Analytics Engine.
 *
 * A visitor is an IP address within one UTC day; the id changes daily, so a
 * day's visitors are counted once across pages but there is no weekly total.
 * Over several days, "visitors" adds up those daily counts.
 */
const days = Number(process.argv[2] ?? 7);
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token || !Number.isInteger(days) || days < 1 || days > 90) {
  console.error('usage: CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… node scripts/events.ts [days ≤ 90]');
  process.exit(1);
}

type Row = Record<string, string | number>;

async function query(sql: string): Promise<Row[]> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: `${sql} FORMAT JSON`,
  });
  if (!res.ok) throw new Error(`Analytics Engine ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { data: Row[] }).data;
}

// blob1 event, blob2 param, blob3 visitor, blob4 country, blob5 client, blob6 device.
const since = `timestamp > NOW() - INTERVAL '${days}' DAY`;
const pageviews = `FROM equation_events WHERE blob1 = 'pageview' AND ${since}`;
/** Daily uniques for each value of a column, added up over the days; the
 *  ten largest. (Analytics Engine has no string concat to count day+visitor
 *  pairs directly.) */
async function visitorsBy(column: string): Promise<{ key: string; visitors: number }[]> {
  const rows = await query(
    `SELECT ${column} AS key, toStartOfDay(timestamp) AS day, count(DISTINCT blob3) AS visitors
     ${pageviews} GROUP BY key, day`,
  );
  const sums = new Map<string, number>();
  for (const r of rows) sums.set(String(r.key), (sums.get(String(r.key)) ?? 0) + Number(r.visitors));
  return [...sums]
    .map(([key, visitors]) => ({ key, visitors }))
    .sort((a, b) => b.visitors - a.visitors)
    .slice(0, 10);
}

const [overall, byPage, types, countries, browsers, devices] = await Promise.all([
  query(
    `SELECT toStartOfDay(timestamp) AS day, count(DISTINCT blob3) AS visitors, SUM(_sample_interval) AS views
     ${pageviews} GROUP BY day`,
  ),
  query(
    `SELECT toStartOfDay(timestamp) AS day, blob2 AS page, count(DISTINCT blob3) AS visitors ${pageviews} GROUP BY day, page`,
  ),
  query(
    `SELECT blob2 AS type, blob1 AS event, SUM(_sample_interval) AS n
     FROM equation_events WHERE blob1 != 'pageview' AND ${since} GROUP BY type, event`,
  ),
  visitorsBy('blob4'),
  visitorsBy('blob5'),
  visitorsBy('blob6'),
]);

const dayOf = (r: Row) => String(r.day).slice(0, 10);
const num = (v: unknown) => Number(v ?? 0);

if (!overall.length && !types.length) {
  console.log(`No events in the last ${days} days.`);
  process.exit(0);
}

// Busiest pages first.
const pageWeight = new Map<string, number>();
for (const r of byPage) pageWeight.set(String(r.page), (pageWeight.get(String(r.page)) ?? 0) + num(r.visitors));
const pages = [...pageWeight.keys()].sort((a, b) => pageWeight.get(b)! - pageWeight.get(a)!);
console.log('Unique visitors per day (UTC): all pages, then each page. views = page loads.');
console.table(
  overall
    .map(r => {
      const row: Row = { day: dayOf(r), visitors: num(r.visitors), views: num(r.views) };
      for (const page of pages) {
        row[page] = num(byPage.find(p => dayOf(p) === row.day && p.page === page)?.visitors);
      }
      return row;
    })
    .sort((a, b) => String(b.day).localeCompare(String(a.day))),
);

const COLUMNS = { add_type: 'site documents', mcp_show_type: 'MCP shown', mcp_encode_type: 'MCP linked' };
const byType = new Map<string, Row>();
for (const r of types) {
  const type = String(r.type);
  const row = byType.get(type) ?? { type, ...Object.fromEntries(Object.values(COLUMNS).map(c => [c, 0])) };
  const column = COLUMNS[String(r.event) as keyof typeof COLUMNS];
  if (column) row[column] = num(r.n);
  byType.set(type, row);
}
const total = (r: Row) => Object.values(COLUMNS).reduce((s, c) => s + num(r[c]), 0);
console.log(`\nGraph types, last ${days} days: documents on the site that drew each, and MCP calls that did.`);
console.table([...byType.values()].sort((a, b) => total(b) - total(a)));

console.log(`\nVisitors by country, browser and device, last ${days} days (top 10).`);
console.table(countries.map(r => ({ country: r.key || '?', visitors: r.visitors })));
console.table(browsers.map(r => ({ browser: r.key || '?', visitors: r.visitors })));
console.table(devices.map(r => ({ device: r.key || '?', visitors: r.visitors })));
