/**
 * Discovery documents that point agents and registries at the MCP server
 * before they connect: an MCP Server Card, and an AI Catalog that lists it.
 *
 * Both formats are drafts. The catalog follows Agentic Resource Discovery
 * (https://agenticresourcediscovery.org/spec/, v0.91), which renamed
 * /.well-known/ai-catalog.json to /.well-known/ard.json. Consumers only MUST
 * read the new name, but Lighthouse's ARD audit and the MCP discovery draft
 * still read the old one, so the same document is served at both. The card
 * follows SEP-2127 (https://github.com/modelcontextprotocol/experimental-ext-server-card),
 * which reserves <streamable-http-url>/server-card for it.
 *
 * Every field that also appears in server.json (the MCP Registry entry) is
 * read from it, so a version bump there reaches both documents.
 */
import server from '../server.json' with { type: 'json' };
import { PROTOCOL_VERSIONS } from './mcp.ts';
import { TOOL_NAMES } from './mcp-usage.ts';

const [remote] = server.remotes;
export const SERVER_CARD_URL = `${remote.url}/server-card`;

const serverCard = {
  // Card schemas are versioned /v1/, unlike server.json's dated ones.
  $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
  name: server.name,
  title: server.title,
  description: server.description,
  version: server.version,
  websiteUrl: server.websiteUrl,
  repository: server.repository,
  icons: [{ src: `${server.websiteUrl}/icon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] }],
  remotes: [{ ...remote, supportedProtocolVersions: PROTOCOL_VERSIONS }],
};

const catalog = {
  // Not ARD's, but the predecessor's schema requires it and closes the top
  // level to everything but specVersion, host and entries. ARD ignores it.
  specVersion: '1.0',
  host: {
    displayName: server.title,
    documentationUrl: `${server.websiteUrl}/llms.txt`,
    logoUrl: `${server.websiteUrl}/icon-512.png`,
  },
  entries: [
    {
      identifier: 'urn:air:equation.io:mcp:equation',
      displayName: server.title,
      type: 'application/mcp-server-card+json',
      url: SERVER_CARD_URL,
      description: server.description,
      version: server.version,
      capabilities: [...TOOL_NAMES],
      tags: ['math', 'graphing', 'calculator', 'education', '3d'],
      // What registries embed for semantic search: 2–5 requests a user would
      // make, in their words.
      representativeQueries: [
        'graph y = sin(x) and its derivative',
        'plot the saddle surface z = x^2 - y^2 in 3D',
        'draw the slope field of dy/dx = x - y',
        'graph y = a sin(x) with a slider for a',
        'make a shareable link to a graph of x^2 + y^2 = 9',
      ],
    },
  ],
};

const DOCUMENTS = new Map<string, { body: string; type: string }>([
  ['/.well-known/ard.json', { body: JSON.stringify(catalog, null, 2), type: 'application/json' }],
  ['/.well-known/ai-catalog.json', { body: JSON.stringify(catalog, null, 2), type: 'application/ai-catalog+json' }],
  [
    new URL(SERVER_CARD_URL).pathname,
    { body: JSON.stringify(serverCard, null, 2), type: 'application/mcp-server-card+json' },
  ],
]);

/** The discovery document at this path, or null when the path is not one. */
export function handleDiscovery(request: Request, url: URL): Response | null {
  const document = DOCUMENTS.get(url.pathname);
  if (!document) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response(document.body, {
    headers: {
      'Content-Type': document.type,
      // Public metadata read by browser-based clients; the card spec requires CORS.
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
