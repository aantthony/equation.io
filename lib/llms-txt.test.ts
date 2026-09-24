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
import { analyzeRows } from './analysis.ts';
import { FUNCTIONS } from './expr.ts';

const llms = readFileSync(new URL('../web/public/llms.txt', import.meta.url), 'utf8');

describe('llms.txt', () => {
  it('documents every advanced feature the MCP tool description points here for', () => {
    for (const marker of [
      'domain(', // domain coloring
      'rgb(', 'hsl(', 'oklch(', // custom per-pixel color
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
      'https://equation.io/implicit/',
      'https://equation.io/slope-field/',
      'https://equation.io/complex/',
    ]) {
      expect(llms).toContain(marker);
    }
  });

  it('describes the MCP server its resource is served from', () => {
    for (const marker of ['encode_graph_url', 'decode_graph_url', '`syntax` MCP resource', 'PNG preview']) {
      expect(llms).toContain(marker);
    }
  });

  // Assistants learn the language from this file alone, so a builtin it
  // never names is one they will never write.
  it('names every builtin function', () => {
    const missing = [...FUNCTIONS].filter(name => !new RegExp(`\\b${name}\\b`).test(llms));
    expect(missing).toEqual([]);
  });

  it('gives builtin examples that compile', () => {
    for (const row of [
      'y = erf(x)', 'y = normalcdf(x, 0, 1)', '1/gcd(floor(x), floor(y))', 'a_n = isprime(n)',
      'grad(x^2 - y^2)', '∇(x^2 - y^2)', 'dot(grad(x^2 - y^2), (1, 0))',
      'tube((1+cos(4pi u), sin(4pi u), 2sin(2pi u)), 0.06)',
    ]) {
      expect(analyzeRows([row]).rows[0].error, row).toBeUndefined();
    }
  });
});
