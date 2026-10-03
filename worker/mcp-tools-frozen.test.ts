import { expect, it } from 'vitest';
import { handleMcp } from './mcp.ts';
import frozen from './mcp-tools.frozen.json' with { type: 'json' };

// TEMPORARY: the ChatGPT plugin review (submitted 2026-10-02, ticket
// C-3V0svuCwh24I) scanned tools/list from the live server, and every push to
// main deploys. Until the review clears, tools/list must stay exactly
// what was submitted: names, descriptions, schemas and annotations. This is a
// plain toEqual, not a snapshot, so `vitest -u` can't quietly accept a change.
// Delete this file and mcp-tools.frozen.json once the plugin is approved.
it('tools/list is frozen while the ChatGPT review is pending', async () => {
  const url = 'https://equation.io/mcp';
  const request = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const res = await handleMcp(request, new URL(url), {} as Env);
  const body = (await res.json()) as { result: unknown };
  expect(body.result).toEqual(frozen);
});
