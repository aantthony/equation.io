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
      'rgb(',
      'hsl(',
      'oklch(', // custom per-pixel color
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
  // never names is one they will never write. A plain word match passes on
  // English ("count", "total", "line", "int"), so each name must appear as
  // code: called, `name(` or `name[`, or in the "- Functions:" entry's list.
  it('names every builtin function as code', () => {
    const entry = /^- Functions:([\s\S]*?)(?=^- )/m.exec(llms)?.[1] ?? '';
    const listed = new Set(entry.split(/[\s,.;:`()]+/));
    const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const missing = [...FUNCTIONS].filter(
      name => !listed.has(name) && !new RegExp(`(?<![\\w.])${escape(name)}[([]`).test(llms),
    );
    expect(missing).toEqual([]);
  });

  // Every snippet the builtin and vector-calculus entries give, with what it
  // must draw: a form that parses but means something else (grad(f) as the
  // point (0, 0)) is as wrong as one that errors.
  it('gives builtin examples that mean what the text says', () => {
    const f = ['f(x, y) = x^2 - y^2'];
    const cases: Array<[string[], string, string]> = [
      [[], 'erf(x)', 'scalar-field'],
      [[], '1/gcd(floor(x), floor(y))', 'scalar-field'],
      [[], 'a_n = isprime(n)', 'sequence'],
      [[], 'grad(x^2 - y^2)', 'vector-field'],
      [[], 'div((x y, y^2))', 'scalar-field'],
      [[], 'curl((y z, -x z, 0))', 'vector-field'],
      [[], 'curl((-y, x))', 'value'],
      [[], 'laplacian(x^2 + y^2)', 'value'],
      [[], '∇ x^2 y', 'vector-field'],
      [f, '∇f(x, y)', 'vector-field'],
      [f, '∇f', 'vector-field'],
      [f, 'grad(f)', 'vector-field'],
      [f, '∇f · (1, 1)/sqrt(2)', 'scalar-field'],
      [['r = sqrt(x^2 + y^2)'], 'grad(1/r)', 'vector-field'],
      [['r = sqrt(x^2 + y^2)'], 'd/dx r', 'scalar-field'],
      [['F = (-y, x)'], 'curl(F)', 'value'],
      [['F = (-y, x)'], '∇×F', 'value'],
      [['F = (-y, x)'], '∇·F', 'value'],
      [[], 'sin(x)^2 + cos(x)^2 = 1', 'note'],
      [[], 'sin(x)^2 + cos(x)^2 = 1.0001', 'curve'],
      [['c = 1', 'g(s) = exp(-s^2)', 'f(x, t) = (g(x - c t) + g(x + c t))/2'], 'y = f(x, t)', 'curve'],
      [
        ['c = 1', 'g(s) = exp(-s^2)', 'f(x, t) = (g(x - c t) + g(x + c t))/2'],
        'd^2/dt^2 f(x, t) = c^2 ∇^2 f(x, t)',
        'note',
      ],
      [[], 'tube((1+cos(4pi u), sin(4pi u), 2sin(2pi u)), 0.06)', 'curve'],
      // A tuple of rows is a matrix; a bracket of tuples is points.
      [[], '((0, -1), (1, 0)) (2, 1)', 'point'],
      [[], 'det(((1, 2), (3, 4)))', 'value'],
      [[], '[(1, 2), (3, 4)]', 'list'],
      // A row is drawn per pixel only when it depends on x or y.
      [[], 'y = x!', 'curve'],
      [[], 'sin(x)cos(y)', 'scalar-field'],
      [[], '(u, u^2)', 'curve'],
      [[], 'u^2', 'distribution'],
      [[], '[3, 1, 4, 4]', 'list'],
    ];
    for (const [defs, row, kind] of cases) {
      expect(llms, row).toContain(row);
      const a = analyzeRows([...defs, row]);
      const last = a.rows[a.rows.length - 1];
      expect(last.error, row).toBeUndefined();
      expect(last.cls?.object.kind, row).toBe(kind);
    }
    // normalcdf(x, mean, sd) is only a signature in the text.
    expect(analyzeRows(['y = normalcdf(x, 0, 1)']).rows[0].cls?.object.kind).toBe('curve');
    // The values the text quotes.
    const readout = (rows: string[]) => analyzeRows(rows, { readouts: true }).rows.at(-1)!.info;
    expect(readout(['curl((-y, x))'])).toBe('= 2');
    expect(readout(['laplacian(x^2 + y^2)'])).toBe('= 4');
    const M = ['a = [1, 2]', 'M = ((a, 0), (0, 1))', 'P = (1, 1)'];
    expect(llms).toContain('`M = ((a, 0), (0, 1))`');
    expect(readout([...M, 'det(M)'])).toBe('= [1, 2]');
    expect(analyzeRows([...M, 'M M P']).rows.at(-1)!.cpu).toMatchObject({ type: 'plist', pts: { length: 2 } });
  });
});
