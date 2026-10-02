/**
 * Usage events in Workers Analytics Engine, one data point each, read back by
 * scripts/events.ts:
 *
 *   blob1  event    pageview | add_type | mcp_show_type | mcp_encode_type
 *   blob2  param    the page's path (pageview) or a graph type (the others)
 *   blob3  visitor  SHA-256 of the IP with that UTC day's salt; '' for MCP
 *   blob4  country  Cloudflare's estimate from the IP; '' for MCP
 *   blob5  client   browser family, or the MCP client's User-Agent product
 *   blob6  device   mobile | desktop; '' for MCP
 *
 * Every param comes from a fixed vocabulary — a page path from pageName, a
 * type from KIND_MEANINGS — so nothing a page sends can put equation text in
 * the dataset. A /g/ link is recorded as '/g/', never its payload.
 *
 * Pages report themselves with a beacon (web/pageview.js; add_type from
 * web/main.ts via lib/type-events.ts) rather than by being served through the
 * Worker, which would put every page load behind it (lib/deploy-config.test.ts
 * keeps the shell on the asset server).
 *
 * The visitor id's salt (migrations/0002_visit_salts.sql) is deleted the next
 * day, after which the id cannot be matched to an address.
 */
import { sha256Hex } from '../lib/hash.ts';
import { LANDINGS } from '../lib/landings.ts';
import { KIND_MEANINGS } from '../lib/row-kind.ts';

export type EventName = 'pageview' | 'add_type' | 'mcp_show_type' | 'mcp_encode_type';

/** Who an event came from, as coarsely as the stats need. */
interface Source {
  visitor: string;
  country: string;
  client: string;
  device: string;
}

const PAGES = new Set(['/', '/about/', '/privacy/', '/terms/', ...LANDINGS.map(l => l.path)]);
const TYPES = new Set(Object.keys(KIND_MEANINGS));
/** A beacon holds one document's new types; more than this is not a page. */
const MAX_EVENTS = 64;

/** Crawlers that run scripts, and headless browsers (screenshots, tests). */
const NOT_A_PERSON = /bot|crawl|spider|headless|lighthouse/i;

/** The page a path serves, as one of a fixed set of names. */
export function pageName(pathname: string): string {
  if (pathname.startsWith('/g/')) return '/g/';
  const path = pathname === '/index.html' ? '/' : pathname.endsWith('/') ? pathname : `${pathname}/`;
  // Anything else is the single-page fallback serving the app shell.
  return PAGES.has(path) ? path : 'other';
}

// Order matters: Edge and Opera also say Chrome, and Chrome also says Safari.
const BROWSERS: [RegExp, string][] = [
  [/Edg(A|iOS)?\//, 'edge'],
  [/OPR\//, 'opera'],
  [/Firefox\/|FxiOS\//, 'firefox'],
  [/Chrome\/|CriOS\//, 'chrome'],
  [/Safari\//, 'safari'],
];

/** A browser's family, or for anything else (an MCP client, a script) its
 *  product name without the version. */
export function clientName(ua: string): string {
  for (const [re, name] of BROWSERS) if (re.test(ua)) return name;
  const m = /compatible;\s*([A-Za-z][\w.-]*)/.exec(ua) ?? /^([A-Za-z][\w.-]*)/.exec(ua);
  return m ? m[1].slice(0, 32).toLowerCase() : '';
}

export const deviceClass = (ua: string): string => (/Mobi|iPhone|iPod|Android/.test(ua) ? 'mobile' : 'desktop');

function write(env: Env, name: EventName, param: string, from: Source) {
  try {
    env.EVENTS.writeDataPoint({
      blobs: [name, param, from.visitor, from.country, from.client, from.device],
      indexes: [name],
    });
  } catch (e) {
    console.error('event write', e);
  }
}

/** The day's salt: created by its first visit, which also deletes older ones. */
async function daySalt(db: D1Database, day: string): Promise<string> {
  const read = () => db.prepare('SELECT salt FROM visit_salts WHERE day = ?').bind(day).first<{ salt: string }>();
  const row = await read();
  if (row) return row.salt;
  const salt = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
  await db.batch([
    db.prepare('DELETE FROM visit_salts WHERE day < ?').bind(day),
    // Two isolates can open the same day at once; both then read the winner.
    db.prepare('INSERT OR IGNORE INTO visit_salts (day, salt) VALUES (?, ?)').bind(day, salt),
  ]);
  return (await read())!.salt;
}

export async function visitorId(db: D1Database, day: string, ip: string): Promise<string> {
  const salt = await daySalt(db, day);
  return (await sha256Hex(new TextEncoder().encode(`${salt}:${ip}`))).slice(0, 16);
}

/**
 * POST /api/events from the site's own pages: `{"events": [{"name":
 * "pageview"}, {"name": "add_type", "param": "implicit2d"}, …]}`. A pageview's
 * page is the beacon's Referer, not anything in the body. Always 204: a
 * beacon has no reader.
 */
export async function handleEvents(request: Request, env: Env, now = new Date()): Promise<Response> {
  if (request.method !== 'POST') return Response.json({ error: 'not_found' }, { status: 404 });
  const done = new Response(null, { status: 204 });

  let from: URL;
  let body: unknown;
  try {
    from = new URL(request.headers.get('Referer') ?? '');
    const text = await request.text();
    if (text.length > 4096) return done;
    body = JSON.parse(text);
  } catch {
    return done;
  }
  if (from.origin !== new URL(request.url).origin) return done;
  const ua = request.headers.get('User-Agent') ?? '';
  if (NOT_A_PERSON.test(ua)) return done;

  const events = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return done;
  const points: [EventName, string][] = [];
  for (const e of events.slice(0, MAX_EVENTS)) {
    const { name, param } = (e ?? {}) as { name?: unknown; param?: unknown };
    if (name === 'pageview') points.push(['pageview', pageName(from.pathname)]);
    else if (name === 'add_type' && typeof param === 'string' && TYPES.has(param)) points.push(['add_type', param]);
  }
  if (!points.length) return done;

  const ip = request.headers.get('CF-Connecting-IP');
  let visitor = '';
  try {
    if (ip) visitor = await visitorId(env.DB, now.toISOString().slice(0, 10), ip);
  } catch (e) {
    // Still count the events; a missing visit_salts table shows up here.
    console.error('visit salt', e);
  }
  const source: Source = {
    visitor,
    country: typeof request.cf?.country === 'string' ? request.cf.country : '',
    client: clientName(ua),
    device: deviceClass(ua),
  };
  for (const [name, param] of points) write(env, name, param, source);
  return done;
}

/**
 * The graph types an MCP tool call drew or linked, once each. MCP requests
 * come from the AI provider's servers, so their IP and country say nothing
 * about the person and are not recorded.
 */
export function recordMcpTypes(
  env: Env,
  request: Request,
  name: 'mcp_show_type' | 'mcp_encode_type',
  types: Iterable<string>,
) {
  const source: Source = {
    visitor: '',
    country: '',
    client: clientName(request.headers.get('User-Agent') ?? ''),
    device: '',
  };
  for (const type of new Set(types)) write(env, name, type, source);
}
