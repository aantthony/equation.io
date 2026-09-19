/**
 * Guards web/public/llms.txt — the document behind /llms.txt AND the MCP
 * "syntax" resource (worker/mcp.ts serves that asset byte-for-byte).
 *
 * The MCP tool description deliberately only NAMES the advanced features and
 * defers their syntax here; if a rename or rewrite drops one of these markers,
 * assistants lose the only place that feature is documented. Lives in lib/
 * rather than worker/ because it reads a file: the worker tsconfig compiles
 * with `types: []` (Workers runtime only), where node:fs and import.meta.url
 * do not exist, while lib tests are excluded from typechecking.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const llms = readFileSync(new URL('../web/public/llms.txt', import.meta.url), 'utf8');

describe('llms.txt', () => {
  it('documents every advanced feature the MCP tool description points here for', () => {
    for (const marker of [
      'domain(', // domain coloring
      'conformal(', // conformal grid maps
      'iter(', // escape-time fractals
      'revolve(', // surfaces of revolution
      'sum[n=1..N]', // symbolically expanded sums, slider bounds
      "(x', y')", // ODE systems / phase portraits
      'd/dx', // symbolic derivatives
      'atan2(y,x)', // the polar coordinate-field recipe
      'open("people.csv"', // CSV data files, dropped in and pinned by hash
      'view(x = ', // 2D framing row
      'camera(', // 3D orbit-camera row
      '## Row types',
      '## Definitions',
    ]) {
      expect(llms).toContain(marker);
    }
  });

  it('describes the MCP server its resource is served from', () => {
    for (const marker of ['encode_graph_url', 'decode_graph_url', '`syntax` MCP resource', 'PNG preview']) {
      expect(llms).toContain(marker);
    }
  });
});
