import { describe, expect, it } from 'vitest';
import { encodePayload } from '../lib/link.ts';
import { testDb } from './d1.fixtures.ts';
import { clientName, deviceClass, handleEvents, pageName, visitorId } from './events.ts';
import worker from './index.ts';

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

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

describe('clientName and deviceClass', () => {
  it('reduce a browser to its family and form factor', () => {
    expect(clientName(CHROME_MAC)).toBe('chrome');
    expect(clientName(CHROME_MAC + ' Edg/140.0.0.0')).toBe('edge');
    expect(clientName(SAFARI_IPHONE)).toBe('safari');
    expect(clientName('Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0')).toBe('firefox');
    expect(deviceClass(CHROME_MAC)).toBe('desktop');
    expect(deviceClass(SAFARI_IPHONE)).toBe('mobile');
  });

  it('reduce anything else to its product name', () => {
    expect(clientName('Claude-User/1.0')).toBe('claude-user');
    expect(clientName('Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)')).toBe('chatgpt-user');
    expect(clientName('node')).toBe('node');
    expect(clientName('')).toBe('');
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

describe('POST /api/events', () => {
  const setup = () => {
    const points: AnalyticsEngineDataPoint[] = [];
    const env = {
      DB: testDb().db,
      EVENTS: { writeDataPoint: (p: AnalyticsEngineDataPoint) => points.push(p) },
    } as unknown as Env;
    const send = (headers: Record<string, string>, events: unknown) =>
      handleEvents(
        new Request('https://equation.io/api/events', { method: 'POST', headers, body: JSON.stringify({ events }) }),
        env,
      );
    return { points, env, send };
  };
  const from = (path: string) => ({
    Referer: `https://equation.io${path}`,
    'CF-Connecting-IP': '203.0.113.7',
    'User-Agent': SAFARI_IPHONE,
  });
  const pageview = [{ name: 'pageview' }];

  it('records the page and a hashed visitor, never the URL or the IP', async () => {
    const { points, send } = setup();
    const res = await send(from('/g/' + encodePayload(['y = tan(x)'])), pageview);
    expect(res.status).toBe(204);
    expect(points).toHaveLength(1);
    const [name, page, visitor, , client, device] = points[0].blobs as string[];
    expect([name, page, client, device]).toEqual(['pageview', '/g/', 'safari', 'mobile']);
    expect(visitor).toMatch(/^[0-9a-f]{16}$/);
    expect(points[0].indexes).toEqual(['pageview']);
    const stored = JSON.stringify(points);
    expect(stored).not.toContain('tan');
    expect(stored).not.toContain('203.0.113');
  });

  it('counts two pages from one IP as one visitor', async () => {
    const { points, send } = setup();
    await send(from('/'), pageview);
    await send(from('/about/'), pageview);
    expect(points.map(p => p.blobs![1])).toEqual(['/', '/about/']);
    expect(points[0].blobs![2]).toBe(points[1].blobs![2]);
  });

  it('takes the page from the Referer, not the body', async () => {
    const { points, send } = setup();
    await send(from('/about/'), [{ name: 'pageview', param: 'y = x^2' }]);
    expect(points.map(p => p.blobs![1])).toEqual(['/about/']);
  });

  it('records known graph types and drops anything else', async () => {
    const { points, send } = setup();
    await send(from('/g/abc'), [
      { name: 'add_type', param: 'implicit3d' },
      { name: 'add_type', param: 'y = x^2' },
      { name: 'add_type' },
      { name: 'mcp_show_type', param: 'implicit2d' },
      { name: 'whatever', param: 'implicit2d' },
      null,
      'add_type',
    ]);
    expect(points.map(p => p.blobs!.slice(0, 2))).toEqual([['add_type', 'implicit3d']]);
  });

  it('ignores beacons from other sites, bots, missing referrers and junk', async () => {
    const { points, send, env } = setup();
    await send({ ...from('/'), Referer: 'https://example.com/' }, pageview);
    await send({ ...from('/'), 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' }, pageview);
    await send({ ...from('/'), 'User-Agent': 'Mozilla/5.0 HeadlessChrome/140.0' }, pageview);
    await send({ 'CF-Connecting-IP': '203.0.113.7' }, pageview);
    const post = (body: string) =>
      handleEvents(new Request('https://equation.io/api/events', { method: 'POST', headers: from('/'), body }), env);
    expect((await post('not json')).status).toBe(204);
    expect((await post('{"events": "pageview"}')).status).toBe(204);
    expect((await post(JSON.stringify({ events: pageview, pad: 'x'.repeat(5000) }))).status).toBe(204);
    expect(points).toHaveLength(0);
  });

  it('still counts the event when the salt table is missing', async () => {
    const points: AnalyticsEngineDataPoint[] = [];
    const env = {
      DB: { prepare: () => ({ bind: () => ({ first: () => Promise.reject(new Error('no such table')) }) }) },
      EVENTS: { writeDataPoint: (p: AnalyticsEngineDataPoint) => points.push(p) },
    } as unknown as Env;
    const error = console.error;
    console.error = () => {};
    try {
      await handleEvents(
        new Request('https://equation.io/api/events', {
          method: 'POST',
          headers: from('/'),
          body: JSON.stringify({ events: pageview }),
        }),
        env,
      );
    } finally {
      console.error = error;
    }
    expect(points.map(p => p.blobs!.slice(0, 3))).toEqual([['pageview', '/', '']]);
  });

  it('is routed by the Worker and rejects GET', async () => {
    const { env, points } = setup();
    expect((await worker.fetch(new Request('https://equation.io/api/events'), env)).status).toBe(404);
    const res = await worker.fetch(
      new Request('https://equation.io/api/events', {
        method: 'POST',
        headers: from('/'),
        body: JSON.stringify({ events: pageview }),
      }),
      env,
    );
    expect(res.status).toBe(204);
    expect(points).toHaveLength(1);
  });
});
