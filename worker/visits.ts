/**
 * Page visits: which page loaded, and a per-day visitor id, so Analytics
 * Engine can count unique IPs per page per day. scripts/visits.ts reads them.
 *
 * Pages report themselves with a beacon (web/visit.js) rather than by being
 * served through the Worker, which would put every page load behind it
 * (lib/deploy-config.test.ts keeps the shell on the asset server).
 *
 * What is stored is the page's canonical path, never the URL it loaded from:
 * a /g/ path is the graph's equations. The visitor id is SHA-256 of the IP
 * and that day's random salt (migrations/0002_visit_salts.sql); the salt is
 * deleted the next day, after which the id cannot be matched to an address.
 */
import { sha256Hex } from '../lib/hash.ts';
import { LANDINGS } from '../lib/landings.ts';

const PAGES = new Set(['/', '/about/', '/privacy/', '/terms/', ...LANDINGS.map(l => l.path)]);

/** Crawlers that run scripts, and headless browsers (screenshots, tests). */
const NOT_A_PERSON = /bot|crawl|spider|headless|lighthouse/i;

/** The page a path serves, as one of a fixed set of names. */
export function pageName(pathname: string): string {
  if (pathname.startsWith('/g/')) return '/g/';
  const path = pathname === '/index.html' ? '/' : pathname.endsWith('/') ? pathname : `${pathname}/`;
  // Anything else is the single-page fallback serving the app shell.
  return PAGES.has(path) ? path : 'other';
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

/** POST /api/visit, sent by web/visit.js. Always 204: a beacon has no reader. */
export async function handleVisit(request: Request, env: Env, now = new Date()): Promise<Response> {
  if (request.method !== 'POST') return Response.json({ error: 'not_found' }, { status: 404 });
  const done = new Response(null, { status: 204 });

  let from: URL;
  try {
    from = new URL(request.headers.get('Referer') ?? '');
  } catch {
    return done;
  }
  if (from.origin !== new URL(request.url).origin) return done;
  if (NOT_A_PERSON.test(request.headers.get('User-Agent') ?? '')) return done;

  const page = pageName(from.pathname);
  const ip = request.headers.get('CF-Connecting-IP');
  let visitor = '';
  try {
    if (ip) visitor = await visitorId(env.DB, now.toISOString().slice(0, 10), ip);
  } catch (e) {
    // Still count the view; a missing visit_salts table shows up here.
    console.error('visit salt', e);
  }
  try {
    env.VISITS.writeDataPoint({ blobs: [page, visitor], indexes: [page] });
  } catch (e) {
    console.error('visit write', e);
  }
  return done;
}
