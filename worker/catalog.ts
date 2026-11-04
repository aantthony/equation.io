/**
 * The AI Catalog: a discovery document that lists the MCP server for agents
 * and registries before they connect.
 *
 * It follows Agentic Resource Discovery
 * (https://agenticresourcediscovery.org/spec/, v0.91), which renamed
 * /.well-known/ai-catalog.json to /.well-known/ard.json. Consumers only MUST
 * read the new name, but Lighthouse's ARD audit and the MCP discovery draft
 * still read the old one, so the same document is served at both.
 *
 * Both are static files, emitted by the build (vite.config.ts) and served by
 * the asset server, so /.well-known never runs the Worker: scanners probe it
 * constantly, and a miss there is a free 404 rather than an invocation.
 * web/public/_headers gives them CORS and the old name its media type.
 *
 * Every field that also appears in server.json (the MCP Registry entry) is
 * read from it, so a version bump there reaches the catalog on the next build.
 */
import server from '../server.json' with { type: 'json' };
import { TOOL_NAMES } from './mcp-usage.ts';

const [remote] = server.remotes;
export const SERVER_CARD_URL = `${remote.url}/server-card`;

export const catalog = {
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

/** Build output path → contents, for the files the build emits. */
export const CATALOG_FILES: Record<string, string> = Object.fromEntries(
  ['.well-known/ard.json', '.well-known/ai-catalog.json'].map(path => [path, JSON.stringify(catalog, null, 2) + '\n']),
);
