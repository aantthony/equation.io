/**
 * Page visits (worker/visits.ts): unique visitors per day, overall and per
 * page, from Workers Analytics Engine.
 *
 *   node scripts/visits.ts [days]        the last 7 days by default, at most 90
 *
 * Needs CLOUDFLARE_ACCOUNT_ID and a CLOUDFLARE_API_TOKEN with Account
 * Analytics: Read. Wrangler's own login cannot read Analytics Engine.
 *
 * A visitor is an IP address within one UTC day; the id changes daily, so a
 * day's visitors are counted once across pages but there is no weekly total.
 */
const days = Number(process.argv[2] ?? 7);
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token || !Number.isInteger(days) || days < 1 || days > 90) {
  console.error('usage: CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… node scripts/visits.ts [days ≤ 90]');
  process.exit(1);
}

async function query(sql: string): Promise<Record<string, string | number>[]> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: `${sql} FORMAT JSON`,
  });
  if (!res.ok) throw new Error(`Analytics Engine ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { data: Record<string, string | number>[] }).data;
}

// blob1 is the page, blob2 the day's visitor hash; each row is one page load.
const where = `WHERE timestamp > NOW() - INTERVAL '${days}' DAY`;
const [overall, byPage] = await Promise.all([
  query(
    `SELECT toStartOfDay(timestamp) AS day, count(DISTINCT blob2) AS visitors, SUM(_sample_interval) AS views
     FROM equation_visits ${where} GROUP BY day`,
  ),
  query(
    `SELECT toStartOfDay(timestamp) AS day, blob1 AS page, count(DISTINCT blob2) AS visitors
     FROM equation_visits ${where} GROUP BY day, page`,
  ),
]);

const dayOf = (r: Record<string, string | number>) => String(r.day).slice(0, 10);
// Busiest pages first.
const weight = new Map<string, number>();
for (const r of byPage) weight.set(String(r.page), (weight.get(String(r.page)) ?? 0) + Number(r.visitors));
const pages = [...weight.keys()].sort((a, b) => weight.get(b)! - weight.get(a)!);

const table = overall
  .map(r => {
    const row: Record<string, string | number> = {
      day: dayOf(r),
      visitors: Number(r.visitors),
      views: Number(r.views),
    };
    for (const page of pages) {
      const hit = byPage.find(p => dayOf(p) === row.day && p.page === page);
      row[page] = hit ? Number(hit.visitors) : 0;
    }
    return row;
  })
  .sort((a, b) => String(b.day).localeCompare(String(a.day)));

if (!table.length) console.log(`No visits in the last ${days} days.`);
else {
  console.log('Unique visitors per day (UTC): all pages, then each page. views = page loads.');
  console.table(table);
}
