import { describe, expect, it } from 'vitest';
import server from '../server.json' with { type: 'json' };
import worker from './index.ts';
import { handleMcp } from './mcp.ts';

// Discovery never reaches an asset; a stray fallthrough would show up as a 404.
const env = {
  ASSETS: { fetch: async () => new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } }) },
} as unknown as Env;

const get = (path: string, method = 'GET') => worker.fetch(new Request('https://equation.io' + path, { method }), env);

async function json(path: string) {
  const response = await get(path);
  expect(response.status).toBe(200);
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
  return { type: response.headers.get('content-type'), body: (await response.json()) as any };
}

async function initialize(protocolVersion: string) {
  const request = new Request('https://equation.io/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion } }),
  });
  const response = await handleMcp(request, new URL(request.url), env);
  return ((await response.json()) as any).result;
}

describe('AI Catalog', () => {
  it('serves one document at the ARD path and its predecessor', async () => {
    const ard = await json('/.well-known/ard.json');
    const legacy = await json('/.well-known/ai-catalog.json');
    expect(legacy.body).toEqual(ard.body);
    expect(ard.type).toBe('application/json');
    expect(legacy.type).toBe('application/ai-catalog+json');
  });

  it('meets what both the ARD and the closed ai-catalog schemas require', async () => {
    const { body } = await json('/.well-known/ard.json');
    // ai-catalog.schema.json rejects any other top-level member.
    expect(Object.keys(body).sort()).toEqual(['entries', 'host', 'specVersion']);
    expect(body.specVersion).toBe('1.0');
    for (const entry of body.entries) {
      // The publisher segment must be the domain that serves the catalog.
      expect(entry.identifier).toMatch(/^urn:air:equation\.io(:[a-zA-Z0-9._-]+)+$/);
      expect(entry.displayName).toBeTruthy();
      expect(entry.type).toBe('application/mcp-server-card+json');
      expect('url' in entry !== 'data' in entry).toBe(true);
      expect(entry.representativeQueries.length).toBeGreaterThanOrEqual(2);
      expect(entry.representativeQueries.length).toBeLessThanOrEqual(5);
    }
  });

  it('points at a server card the worker serves', async () => {
    const { body } = await json('/.well-known/ard.json');
    const url = new URL(body.entries[0].url);
    expect(url.origin).toBe(server.websiteUrl);
    const card = await json(url.pathname);
    expect(card.type).toBe('application/mcp-server-card+json');
  });
});

describe('MCP Server Card', () => {
  it('sits at the streamable-http URL plus /server-card', async () => {
    const { body } = await json('/mcp/server-card');
    expect(body.$schema).toBe('https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json');
    expect(body.name).toBe(server.name);
    expect(body.remotes.map((r: { url: string }) => `${r.url}/server-card`)).toEqual([
      'https://equation.io/mcp/server-card',
    ]);
  });

  it('matches what initialize reports once connected', async () => {
    const { body: card } = await json('/mcp/server-card');
    const { serverInfo } = await initialize('2025-06-18');
    expect(card.title).toBe(serverInfo.title);
    expect(card.version).toBe(serverInfo.version);
    for (const version of card.remotes[0].supportedProtocolVersions) {
      expect((await initialize(version)).protocolVersion).toBe(version);
    }
  });

  it('is read-only', async () => {
    const response = await get('/mcp/server-card', 'POST');
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });
});
