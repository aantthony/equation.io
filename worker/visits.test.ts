import { describe, expect, it } from 'vitest';
import { encodePayload } from '../lib/link.ts';
import { testDb } from './d1.fixtures.ts';
import worker from './index.ts';
import { handleVisit, pageName, visitorId } from './visits.ts';

describe('pageName', () => {
  it('names each page by its canonical path', () => {
    expect(pageName('/')).toBe('/');
    expect(pageName('/index.html')).toBe('/');
    expect(pageName('/about/')).toBe('/about/');
    expect(pageName('/about')).toBe('/about/');
    expect(pageName('/privacy/')).toBe('/privacy/');
    expect(pageName('/implicit')).toBe('/implicit/');
  });

  it('keeps no part of a graph link or an unknown path', () => {
    expect(pageName('/g/' + encodePayload(['y = sin(x)']))).toBe('/g/');
    expect(pageName('/y = sin(x)')).toBe('other');
  });
});

describe('visitorId', () => {
  it('is stable within a day and unrelated across days', async () => {
    const { db } = testDb();
    const a = await visitorId(db, '2026-10-02', '203.0.113.7');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await visitorId(db, '2026-10-02', '203.0.113.7')).toBe(a);
    expect(await visitorId(db, '2026-10-02', '203.0.113.8')).not.toBe(a);
    expect(await visitorId(db, '2026-10-03', '203.0.113.7')).not.toBe(a);
  });

  it("deletes a day's salt once the next day starts", async () => {
    const { db, raw } = testDb();
    await visitorId(db, '2026-10-01', '203.0.113.7');
    await visitorId(db, '2026-10-02', '203.0.113.7');
    expect(raw.prepare('SELECT day FROM visit_salts').all()).toEqual([{ day: '2026-10-02' }]);
  });
});

describe('POST /api/visit', () => {
  const setup = () => {
    const points: AnalyticsEngineDataPoint[] = [];
    const env = {
      DB: testDb().db,
      VISITS: { writeDataPoint: (p: AnalyticsEngineDataPoint) => points.push(p) },
    } as unknown as Env;
    const visit = (headers: Record<string, string>, method = 'POST') =>
      handleVisit(new Request('https://equation.io/api/visit', { method, headers }), env);
    return { points, env, visit };
  };
  const from = (path: string) => ({ Referer: `https://equation.io${path}`, 'CF-Connecting-IP': '203.0.113.7' });

  it('records the page and a hashed visitor, never the URL or the IP', async () => {
    const { points, visit } = setup();
    const res = await visit(from('/g/' + encodePayload(['y = tan(x)'])));
    expect(res.status).toBe(204);
    expect(points).toHaveLength(1);
    const [page, visitor] = points[0].blobs as string[];
    expect(page).toBe('/g/');
    expect(visitor).toMatch(/^[0-9a-f]{16}$/);
    expect(points[0].indexes).toEqual(['/g/']);
    const stored = JSON.stringify(points);
    expect(stored).not.toContain('tan');
    expect(stored).not.toContain('203.0.113');
  });

  it('counts two pages from one IP as one visitor', async () => {
    const { points, visit } = setup();
    await visit(from('/'));
    await visit(from('/about/'));
    expect(points.map(p => p.blobs![0])).toEqual(['/', '/about/']);
    expect(points[0].blobs![1]).toBe(points[1].blobs![1]);
  });

  it('ignores beacons from other sites, bots and missing referrers', async () => {
    const { points, visit } = setup();
    await visit({ Referer: 'https://example.com/', 'CF-Connecting-IP': '203.0.113.7' });
    await visit({ ...from('/'), 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' });
    await visit({ ...from('/'), 'User-Agent': 'Mozilla/5.0 HeadlessChrome/140.0' });
    await visit({ 'CF-Connecting-IP': '203.0.113.7' });
    expect(points).toHaveLength(0);
  });

  it('still counts the view when the salt table is missing', async () => {
    const points: AnalyticsEngineDataPoint[] = [];
    const env = {
      DB: { prepare: () => ({ bind: () => ({ first: () => Promise.reject(new Error('no such table')) }) }) },
      VISITS: { writeDataPoint: (p: AnalyticsEngineDataPoint) => points.push(p) },
    } as unknown as Env;
    const error = console.error;
    console.error = () => {};
    try {
      await handleVisit(new Request('https://equation.io/api/visit', { method: 'POST', headers: from('/') }), env);
    } finally {
      console.error = error;
    }
    expect(points.map(p => p.blobs)).toEqual([['/', '']]);
  });

  it('is routed by the Worker and rejects GET', async () => {
    const { env } = setup();
    expect((await worker.fetch(new Request('https://equation.io/api/visit'), env)).status).toBe(404);
    const res = await worker.fetch(
      new Request('https://equation.io/api/visit', { method: 'POST', headers: from('/') }),
      env,
    );
    expect(res.status).toBe(204);
  });
});
