/**
 * The MCP Server Card (SEP-2127,
 * https://github.com/modelcontextprotocol/experimental-ext-server-card), at
 * <streamable-http-url>/server-card, which the spec reserves for it. The AI
 * Catalog that points here is a static file (worker/catalog.ts).
 *
 * Every field that also appears in server.json (the MCP Registry entry) is
 * read from it, so a version bump there reaches the card.
 */
import server from '../server.json' with { type: 'json' };
import { SERVER_CARD_URL } from './catalog.ts';
import { PROTOCOL_VERSIONS } from './mcp.ts';

const [remote] = server.remotes;

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

const DOCUMENTS = new Map<string, { body: string; type: string }>([
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
