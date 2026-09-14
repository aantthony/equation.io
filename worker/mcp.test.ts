import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { handleMcp } from './mcp.ts';
import { GRAPH_UI_URI } from './mcp-app.ts';

const URL_BASE = 'https://equation.io/mcp';
const ajv = new Ajv({ strict: true });
const outputValidators = new Map<string, ReturnType<typeof ajv.compile>>();

// The "syntax" resource serves the /llms.txt asset. The stub returns a
// sentinel, proving resources/read plumbs ASSETS through untouched; that the
// real llms.txt actually documents the advanced syntax is guarded by
// lib/llms-txt.test.ts (this tsconfig has no node:fs to read the file with).
const SYNTAX_DOC = '# equation.io syntax sentinel';
const env = {
  ASSETS: {
    fetch: async (req: Request) =>
      new URL(req.url).pathname === '/llms.txt'
        ? new Response(SYNTAX_DOC)
        : new URL(req.url).pathname === '/mcp-app/'
        ? new Response('<html data-mcp-app><meta content="__EQUATION_ORIGIN__"><script type="module" src="/assets/graph.js"></script><link href="/assets/graph.css"></html>')
        : new Response('not found', { status: 404 }),
  },
} as unknown as Env;

async function rpc(method: string, params?: object, id: number | null = 1) {
  const request = new Request(URL_BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const res = await handleMcp(request, new URL(URL_BASE), env);
  const body = (res.status === 202 ? null : await res.json()) as any;
  // Validate real outputs throughout this suite, including invalid equations,
  // device-local data, animation, preview omissions, and compatibility aliases.
  if (method === 'tools/call' && body.result?.structuredContent) {
    if (!outputValidators.size) {
      const listed = await rpc('tools/list');
      for (const tool of listed.body.result.tools) {
        expect(tool.outputSchema).toBeDefined();
        outputValidators.set(tool.name, ajv.compile(tool.outputSchema));
      }
    }
    const name = (params as { name: string }).name;
    const canonical = name === 'create_graph' ? 'encode_graph_url'
      : name === 'read_graph' ? 'decode_graph_url' : name;
    const validate = outputValidators.get(canonical)!;
    expect(validate(body.result.structuredContent), JSON.stringify(validate.errors)).toBe(true);
  }
  return { res, body };
}

describe('mcp endpoint', () => {
  it('initializes with a supported protocol version', async () => {
    const { body } = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    expect(body.result.protocolVersion).toBe('2025-06-18');
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.serverInfo.name).toBe('equation');
  });

  it('falls back to its latest version for unknown requested versions', async () => {
    const { body } = await rpc('initialize', { protocolVersion: '9999-01-01' });
    expect(body.result.protocolVersion).toBe('2025-06-18');
  });

  it('answers requests with id: null (only an ABSENT id is a notification)', async () => {
    const { body } = await rpc('ping', undefined, null);
    expect(body).toEqual({ jsonrpc: '2.0', id: null, result: {} });
  });

  it('accepts notifications with a 202 and no body', async () => {
    const request = new Request(URL_BASE, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    const res = await handleMcp(request, new URL(URL_BASE), env);
    expect(res.status).toBe(202);
  });

  it('lists link tools and the interactive graph tool', async () => {
    const { body } = await rpc('tools/list');
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual(['encode_graph_url', 'decode_graph_url', 'show_graph']);
    for (const tool of body.result.tools) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true, openWorldHint: false, destructiveHint: false,
      });
    }
  });

  it.each([
    ['encode_graph_url', 'create_graph', { equations: ['y = x'] }],
    ['decode_graph_url', 'read_graph', { url: 'https://equation.io/#y=x' }],
  ])('keeps %s compatible with %s', async (name, legacyName, args) => {
    const current = await rpc('tools/call', { name, arguments: args });
    const legacy = await rpc('tools/call', { name: legacyName, arguments: args });
    expect(legacy.body.result).toEqual(current.body.result);
  });

  it('creates a validated graph link (tangent-line editing example)', async () => {
    const { body } = await rpc('tools/call', {
      name: 'encode_graph_url',
      arguments: {
        equations: ['f(x) = x^2 - 2x', 'g(x) = d/dx f(x)', 'a = 3', 'y = f(x)', 'y = f(a) + g(a)(x - a)'],
      },
    });
    const out = body.result.structuredContent;
    expect(out.valid).toBe(true);
    expect(out.url).toMatch(/^https:\/\/equation\.io\/#/);
    expect(out.share_url).toMatch(/^https:\/\/equation\.io\/g\//);
    // Chat-app linkifiers cut URLs at bare parens; the codec must escape them.
    expect(out.share_url).not.toMatch(/[()!'*]/);
    expect(out.url).not.toMatch(/[()!'*]/);
    expect(out.rows.map((r: { kind?: string }) => r.kind)).toEqual([
      'definition (fn)', 'definition (fn)', 'definition (const)', 'implicit2d', 'implicit2d',
    ]);
  });

  it('validates recurrence rows like the app does (logistic cobweb)', async () => {
    const { body } = await rpc('tools/call', {
      name: 'encode_graph_url',
      arguments: {
        equations: ['r = 1.9', 'a_0 = 0.265', 'a_{n+1} = r a_n (1 - a_n)', '(a_0, a_0)'],
      },
    });
    const out = body.result.structuredContent;
    expect(out.valid).toBe(true);
    expect(out.rows.map((r: { kind?: string }) => r.kind)).toEqual([
      'definition (const)', 'definition (const)', 'cobweb', 'point',
    ]);
    // The static preview draws cobwebs, so nothing is omitted and the image
    // attaches with the recurrence included.
    expect(out.preview_omits).toBeUndefined();
    expect(out.preview).toBe('not attached — available via share link');
  });

  it('validates random-variable rows like the app does (normal probability)', async () => {
    const { body } = await rpc('tools/call', {
      name: 'encode_graph_url',
      arguments: { equations: ['m = 1', 's = 0.5', 'X ~ Normal(m, s)', 'P(0 < X < 2)'] },
    });
    const out = body.result.structuredContent;
    expect(out.valid).toBe(true);
    expect(out.rows.map((r: { kind?: string }) => r.kind)).toEqual([
      'definition (const)', 'definition (const)', 'random variable (density curve)', 'probability (shaded area)',
    ]);
    // The P row carries its numeric value, matching the app's row readout.
    expect(out.rows[3].value).toBe('≈ 0.9545');
    // Density and shaded area both draw in the static preview.
    expect(out.preview_omits).toBeUndefined();
  });

  it('expands slider-bounded sums like the app does (Fourier series)', async () => {
    const { body } = await rpc('tools/call', {
      name: 'encode_graph_url',
      arguments: { equations: ['N = 8', 'y = 2 sum[n=1..N] (-1)^(n+1) sin(n x)/n'] },
    });
    const out = body.result.structuredContent;
    expect(out.valid).toBe(true);
    expect(out.rows.map((r: { kind?: string }) => r.kind)).toEqual(['definition (const)', 'implicit2d']);
    expect(out.preview_omits).toBeUndefined();
  });

  it('still rejects Σ bounds with no static value (animated constant)', async () => {
    const { body } = await rpc('tools/call', {
      name: 'encode_graph_url',
      arguments: { equations: ['a = 2 + sin(t)', 'y = sum[n=1..a] x^n'] },
    });
    const out = body.result.structuredContent;
    expect(out.valid).toBe(false);
    expect(out.rows[1].status).toBe('error');
    expect(out.rows[1].error).toContain('must be constant');
  });

  it('rejects a P(…) row with no random variable declared', async () => {
    const { body } = await rpc('tools/call', {
      name: 'encode_graph_url',
      arguments: { equations: ['P(X < 2)'] },
    });
    const out = body.result.structuredContent;
    expect(out.valid).toBe(false);
    expect(out.rows[0].status).toBe('error');
    expect(out.rows[0].error).toContain('X ~ Normal(0, 1)');
  });

  it('validates random-variable rows: base, derived, and P(…) forms', async () => {
    const { body } = await rpc('tools/call', {
      name: 'encode_graph_url',
      arguments: {
        equations: ['X ~ Normal(0, 1)', 'Y = {X > 0: X^2, 1}', 'P(-1 < X < 1)', 'P(Y > X)', 'X + X',
          'P(X + X < 1)'],
      },
    });
    const out = body.result.structuredContent;
    expect(out.valid).toBe(true);
    // Every member of the family reports the same human-readable kinds the
    // base rows do, whether the density is exact (X, X + X) or sampled (Y) —
    // and the inline-bounded P(X + X < 1) is a probability the same way.
    expect(out.rows.map((r: { kind?: string }) => r.kind)).toEqual([
      'random variable (density curve)',
      'random variable (density curve)',
      'probability (shaded area)',
      'probability (shaded area)',
      'random variable (density curve)',
      'probability (shaded area)',
    ]);
    // The exact P rows read their CDF values; the Monte Carlo one estimates.
    expect(out.rows[2].value).toBe('≈ 0.6827');
    expect(out.rows[3].value).toMatch(/^≈ 0\.\d{3}$/);
    // X + X ~ Normal(0, 2), so P(X + X < 1) = Φ(1/2) exactly.
    expect(out.rows[5].value).toBe('≈ 0.6915');
    expect(out.preview).toBe('not attached — available via share link');
  });

  it('names what a joined row actually holds, semicolon or line break', async () => {
    // Two equations in one string is worth catching, and `splitStatements` is
    // what the app and the link codec use to decide where a row ends — but it
    // splits on line breaks too, so the message may not blame a character the
    // row does not contain.
    for (const joined of ['y = x; y = 2', 'y = x\ny = 2']) {
      const { body } = await rpc('tools/call', {
        name: 'encode_graph_url',
        arguments: { equations: [joined] },
      });
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toMatch(/holds more than one equation/);
    }
    // …and a row whose semicolon is inside text is one equation, not two.
    const { body: ok } = await rpc('tools/call', {
      name: 'encode_graph_url',
      arguments: { equations: ['p = open("a;b.csv", a1b2c3d4e5f6)'] },
    });
    expect(ok.result.isError).toBeUndefined();
  });

  it('keeps a semicolon inside text, through the link and back', async () => {
    // The row means the ';'. Refusing it did not save the graph — an invalid
    // row is written to the URL like any other — so the link came back cut in
    // half at the quote. The codec tells a row's own semicolon from the
    // separator now (lib/link.ts), and decode_graph_url proves the round trip.
    const rows = ['p = open("sales;2026.csv", a1b2c3d4e5f6)', 'y = 2'];
    const { body } = await rpc('tools/call', {
      name: 'encode_graph_url',
      arguments: { equations: rows },
    });
    const out = body.result.structuredContent;
    expect(out.rows[0].status).not.toBe('error');
    const { body: back } = await rpc('tools/call', {
      name: 'decode_graph_url',
      arguments: { url: out.share_url },
    });
    expect(back.result.structuredContent.equations).toEqual(rows);
  });

  it('reads a list inside P(…) and E(…), like every other row', async () => {
    // These two bodies were the last rows parsed without the document's list
    // names and never lowered, so a reduction over a list defined above them
    // reported `Unknown variable: L` — about a name two rows up.
    const { body } = await rpc('tools/call', {
      name: 'encode_graph_url',
      arguments: { equations: ['L = [1, 4, 2]', 'X ~ Normal(0, 1)', 'P(X < mean(L))', 'E(X + mean(L))'] },
    });
    const out = body.result.structuredContent;
    expect(out.valid).toBe(true);
    expect(out.rows[2].value).toBe('≈ 0.9902'); // Φ(7/3)
    expect(out.rows[3].value).toBe('≈ 2.3333'); // E[X] + 7/3
  });

  it('keeps a graph shared before `total` and `open` had meanings of their own', async () => {
    // Both names arrived with data files. A link written before that says
    // `total = 3` and means the product `total (x + 1)`, or names a slider
    // `open` — and the row it was shared as has to keep drawing.
    const { body } = await rpc('tools/call', {
      name: 'encode_graph_url',
      arguments: { equations: ['total = 3', 'open = 2', 'y = total(x + 1)', 'y = open x'] },
    });
    const out = body.result.structuredContent;
    expect(out.valid).toBe(true);
    expect(out.rows.map((r: { kind?: string }) => r.kind)).toEqual([
      'definition (const)', 'definition (const)', 'implicit2d', 'implicit2d',
    ]);
    // …while a document that binds neither still reduces and still opens.
    const { body: b2 } = await rpc('tools/call', {
      name: 'encode_graph_url',
      arguments: { equations: ['L = [1, 4, 2]', 'total(L)'] },
    });
    expect(b2.result.structuredContent.rows[1].value).toBe('≈ 7');
    // A call folds case, so the name a document bound has to fold with it:
    // `Total = 3` is a legal old definition and `Total(x + 1)` was its product.
    const { body: b3 } = await rpc('tools/call', {
      name: 'encode_graph_url',
      arguments: { equations: ['Total = 3', 'y = Total(x + 1)'] },
    });
    expect(b3.result.structuredContent.valid).toBe(true);
    expect(b3.result.structuredContent.rows[1].kind).toBe('implicit2d');
  });

  it('validates E(…) rows: exact and sampled means', async () => {
    const { body } = await rpc('tools/call', {
      name: 'encode_graph_url',
      arguments: { equations: ['X ~ Normal(2, 1)', 'Y = X^2', 'E(X)', 'E(2X + 1)', 'E(Y)'] },
    });
    const out = body.result.structuredContent;
    expect(out.valid).toBe(true);
    expect(out.rows.map((r: { kind?: string }) => r.kind)).toEqual([
      'random variable (density curve)',
      'random variable (density curve)',
      'expectation (mean readout)',
      'expectation (mean readout)',
      'expectation (mean readout)',
    ]);
    // Exact under the law: E[X] = 2 and E[2X + 1] = 5 (affine in a normal base).
    expect(out.rows[2].value).toBe('≈ 2.0000');
    expect(out.rows[3].value).toBe('≈ 5.0000');
    // E[X²] = μ² + σ² = 5, by quadrature against the base pdf.
    expect(out.rows[4].value).toBe('≈ 5.0000');
    expect(out.preview).toBe('not attached — available via share link');
  });

  it('validates ∫ rows: exact readouts and non-elementary curves', async () => {
    const { body } = await rpc('tools/call', {
      name: 'encode_graph_url',
      arguments: {
        equations: ['int[0..1] exp(-x^2) dx', 'y = int[0..x] sin(t)/t dt', 'a = 2', 'y = int[0..a] t^2 dt + x'],
      },
    });
    const out = body.result.structuredContent;
    expect(out.valid).toBe(true);
    // ∫₀¹e^(−x²) = (√π/2)erf(1), symbolically; the row reads its value.
    expect(out.rows[0].value).toBe('≈ 0.746824');
    // Si(x) has no elementary form — the quadrature expansion still plots.
    expect(out.rows[1].kind).toBe('implicit2d');
    expect(out.rows[3].kind).toBe('implicit2d'); // slider bound stays symbolic
    expect(out.preview).toBe('not attached — available via share link');
  });

  it('rejects malformed ∫ rows with a usable message', async () => {
    const { body } = await rpc('tools/call', {
      name: 'encode_graph_url',
      arguments: { equations: ['int(x^2)'] },
    });
    const out = body.result.structuredContent;
    expect(out.valid).toBe(false);
    expect(out.rows[0].error).toContain('dx');
  });

  it('leaves E(…) rows alone when the user defines E', async () => {
    const { body } = await rpc('tools/call', {
      name: 'encode_graph_url',
      arguments: { equations: ['E = 3', 'X ~ Normal(0, 1)', 'E(X)'] },
    });
    const out = body.result.structuredContent;
    // E is the user's constant, so E(X) is the product E·X — a derived
    // density row, not an expectation readout.
    expect(out.rows[2].kind).toBe('random variable (density curve)');
  });

  it('reports per-row errors without failing the call', async () => {
    const { body } = await rpc('tools/call', {
      name: 'encode_graph_url',
      arguments: { equations: ['y = x^2', 'y = florb(x)'] },
    });
    const out = body.result.structuredContent;
    expect(out.valid).toBe(false);
    expect(out.rows[0].status).toBe('ok');
    expect(out.rows[1].status).toBe('error');
  });

  it('treats # rows as comments, not errors', async () => {
    const { body } = await rpc('tools/call', {
      name: 'encode_graph_url',
      arguments: { equations: ['# Lines', 'y = x'] },
    });
    const out = body.result.structuredContent;
    expect(out.valid).toBe(true);
    expect(out.rows[0]).toMatchObject({ status: 'ok', kind: 'comment (group heading)' });
    expect(out.rows[1].status).toBe('ok');
  });

  it('round-trips a link through decode_graph_url (both URL forms)', async () => {
    const { body: created } = await rpc('tools/call', {
      name: 'encode_graph_url',
      arguments: { equations: ['a = 2', 'y = sin(a x)/a'] },
    });
    for (const key of ['url', 'share_url'] as const) {
      const { body } = await rpc('tools/call', {
        name: 'decode_graph_url',
        arguments: { url: created.result.structuredContent[key] },
      });
      expect(body.result.structuredContent.equations).toEqual(['a = 2', 'y = sin(a x)/a']);
    }
  });

  it('names the expected argument when a caller guesses wrong', async () => {
    // "rows" is the guess to expect: the tool's own result calls the
    // per-equation validation "rows", so a caller can reasonably reach for it.
    const { body } = await rpc('tools/call', {
      name: 'encode_graph_url',
      arguments: { rows: ['y = x^2'] },
    });
    const text = body.result.content[0].text;
    expect(text).toContain('"equations"');
    expect(text).toContain('"rows"'); // says what arrived, not just what was wanted
    expect(text).toContain('{"equations": ["y = x^2", "y = sin(x)"]}'); // a copyable example
  });

  it('describes the argument it actually takes', async () => {
    const { body } = await rpc('tools/list');
    const create = body.result.tools.find((t: { name: string }) => t.name === 'encode_graph_url');
    expect(Object.keys(create.inputSchema.properties)).toEqual(['equations']);
    expect(create.inputSchema.required).toEqual(['equations']);
    // The prose must not tell a caller to send "rows:" — the schema says
    // equations, and a description that disagrees is what caused the misuse.
    expect(create.description).not.toMatch(/send rows|rows:\s*\[/i);
    expect(create.description).toContain('"equations"');
  });

  it('feeds decode_graph_url output straight back into encode_graph_url', async () => {
    const rows = ['a = 2', 'y = sin(a x)'];
    const made = await rpc('tools/call', { name: 'encode_graph_url', arguments: { equations: rows } });
    const url = JSON.parse(made.body.result.content[0].text).share_url;
    const read = await rpc('tools/call', { name: 'decode_graph_url', arguments: { url } });
    // decode_graph_url returns "equations", the exact key encode_graph_url consumes.
    expect(JSON.parse(read.body.result.content[0].text)).toEqual({ equations: rows });
  });

  it('answers preflights with a long-lived cacheable policy', async () => {
    const res = await handleMcp(new Request(URL_BASE, { method: 'OPTIONS' }), new URL(URL_BASE), env);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('rejects unknown methods and non-POST requests', async () => {
    const { body } = await rpc('bogus/method');
    expect(body.error.code).toBe(-32601);
    const res = await handleMcp(new Request(URL_BASE, { method: 'GET' }), new URL(URL_BASE), env);
    expect(res.status).toBe(405);
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
    expect(await res.text()).toContain('https://equation.io/mcp');
  });
});

describe('draggable points', () => {
  const rowsFor = async (equations: string[]) => {
    const { body } = await rpc('tools/call', { name: 'encode_graph_url', arguments: { equations } });
    return body.result.structuredContent.rows as Array<{ text: string; kind?: string; draggable?: boolean }>;
  };

  it('marks literal and slider-coordinate points draggable', async () => {
    const rows = await rowsFor(['(2, 3)', 'a = 1', '(a, 4)']);
    expect(rows[0]).toMatchObject({ kind: 'point', draggable: true });
    expect(rows[1].draggable).toBeUndefined(); // the slider itself is not a point
    expect(rows[2]).toMatchObject({ kind: 'point', draggable: true });
  });

  it('reports coordinate RHS dragging without making intersection rows draggable', async () => {
    const rows = await rowsFor(['r = sqrt(x^2+y^2)', 'theta = atan2(y,x)',
      '(r, theta) = (2, 0.8)', '(r, theta) = (sqrt(2), pi/4)', '(x, y) = (y, -sin(x))']);
    expect(rows[2]).toMatchObject({ kind: 'system', draggable: true });
    expect(rows[3]).toMatchObject({ kind: 'system', draggable: false });
    expect(rows[4].draggable).toBeUndefined();
  });

  it('pins sliders that also define the chart while allowing independent axes', async () => {
    const rows = await rowsFor(['a=2', 'b=a^2', 'p=x/b', '(p,y)=(a,a)', '(p,y)=(a,0)']);
    expect(rows[3]).toMatchObject({ kind: 'system', draggable: false });
    expect(rows[4]).toMatchObject({ kind: 'system', draggable: true });
  });

  it('marks fully computed points as not draggable', async () => {
    const rows = await rowsFor(['a = 1', '(a+1, 2cos(1))']);
    expect(rows[1]).toMatchObject({ kind: 'point', draggable: false });
  });

  it('reports named points (A = (…)) too', async () => {
    const rows = await rowsFor(['A = (1, 2)', 'B = (2cos(1), sin(2))']);
    expect(rows[0]).toMatchObject({ kind: 'definition (const)', draggable: true });
    expect(rows[1]).toMatchObject({ kind: 'definition (const)', draggable: false });
  });

  it('never drags in 3D, where the app has no point dragging', async () => {
    const rows = await rowsFor(['(1, 2)', 'z = x^2 + y^2']);
    expect(rows[0]).toMatchObject({ kind: 'point', draggable: false });
  });

  it('omits the flag from non-point rows', async () => {
    const rows = await rowsFor(['y = x^2', 'f(x) = x', 'view(x = -5..5)']);
    for (const row of rows) expect(row).not.toHaveProperty('draggable');
  });
});

describe('graph previews', () => {
  const call = (equations: string[]) =>
    rpc('tools/call', { name: 'encode_graph_url', arguments: { equations } });

  it('returns only text content for drawable graphs', async () => {
    const { body } = await call(['y = sin(x)', 'y = x/2']);
    expect(body.result.content.map((c: { type: string }) => c.type)).toEqual(['text']);
    expect(JSON.parse(body.result.content[0].text)).toEqual(body.result.structuredContent);
  });

  it('notes that an animated graph is rendered at t = 0', async () => {
    const { body } = await call(['y = sin(x - 2t)']);
    expect(body.result.structuredContent.preview).toContain('t = 0');
    expect(body.result.content.some((c: { type: string }) => c.type === 'image')).toBe(false);
  });

  it('says why shader-only plots get no image instead of sending a wrong one', async () => {
    const { body } = await call(['iter(z^2 + w)']);
    expect(body.result.content.some((c: { type: string }) => c.type === 'image')).toBe(false);
    const out = body.result.structuredContent;
    expect(out.preview).toContain('nothing about whether the graph works');
    expect(out.preview_omits).toEqual([
      { row: 'iter(z^2 + w)', why: expect.stringContaining('fractal2d') },
    ]);
    expect(out.preview_omits[0].why).toContain('live app');
  });

  it('never attaches the empty grid a general implicit 3D surface would render as', async () => {
    // The sphere is a 'draws' TYPE but not a drawable ROW (only z = f(x, y)
    // is); a blank "attached" image here would read as "3D failed" and teach
    // the caller to stop offering 3D graphs at all.
    const { body } = await call(['x^2 + y^2 + z^2 = 9']);
    expect(body.result.structuredContent.valid).toBe(true);
    expect(body.result.content.some((c: { type: string }) => c.type === 'image')).toBe(false);
    const [omit] = body.result.structuredContent.preview_omits;
    expect(omit.row).toBe('x^2 + y^2 + z^2 = 9');
    expect(omit.why).toContain('live app renders general implicit surfaces');
  });

  it('discloses rows missing from a partial preview', async () => {
    const { body } = await call(['z = x^2 + y^2', 'y = sin(x)']);
    expect(body.result.content.some((c: { type: string }) => c.type === 'image')).toBe(false);
    const out = body.result.structuredContent;
    expect(out.preview).toContain('1 of 2 plot rows missing');
    expect(out.preview_omits).toEqual([{ row: 'y = sin(x)', why: expect.stringContaining('vertical sheets') }]);
  });

  it('skips the preview when there is nothing to draw', async () => {
    const { body } = await call(['a = 2', 'f(x) = a x']);
    expect(body.result.content.some((c: { type: string }) => c.type === 'image')).toBe(false);
    expect(body.result.structuredContent.preview).toContain('no plot rows');
  });

  it('says a graph is fine when only the CSV is missing', async () => {
    const { body } = await call(['person = open("people.csv", 3a7f1b2c9d4e)', 'y = person.age']);
    const out = body.result.structuredContent;
    expect(out.valid).toBe(true);
    expect(out.preview).toContain('the graph itself is fine');
    expect(out.preview_omits).toEqual([
      { row: 'y = person.age', why: expect.stringContaining('not on this device') },
    ]);
  });

  it('does not call a row valid just because the file is elsewhere', async () => {
    // `person.age[person.age]` is a slice, which the app refuses once the
    // bytes are here. Reporting it as merely device-local would make the same
    // link valid in a preview and broken for its author.
    const { body } = await call(['person = open("people.csv", 3a7f1b2c9d4e)', 'person.age[person.age]']);
    const out = body.result.structuredContent;
    expect(out.valid).toBe(false);
    expect(out.rows[1].error).toMatch(/Slicing/);
  });

  it('does not call a graph fine while another row is broken', async () => {
    // The device-local plot is the only thing the preview can say nothing
    // about; a row that fails to parse is broken everywhere. Saying "the
    // graph itself is fine" over the top of it sends the caller away from an
    // error that `rows` — and only `rows` — is reporting.
    const { body } = await call([
      'person = open("people.csv", 3a7f1b2c9d4e)', 'y = person.age', 'y = florb(x)',
    ]);
    const out = body.result.structuredContent;
    expect(out.valid).toBe(false);
    expect(out.preview).not.toContain('the graph itself is fine');
    expect(out.preview).toContain('other rows have errors');
  });

  it('does not call a definition-only document fine', async () => {
    // `ages` draws nothing on any device, so "every plot row is device-local"
    // would send the caller away satisfied with a graph that is simply empty.
    const { body } = await call(['person = open("people.csv", 3a7f1b2c9d4e)', 'ages = person.age / 2']);
    const out = body.result.structuredContent;
    expect(out.preview).toContain('no plot rows');
    expect(out.preview).not.toContain('the graph itself is fine');
  });

  it('describes preview availability for working rows of a partly-broken graph', async () => {
    const { body } = await call(['y = x^2', 'y = florb(x)']);
    expect(body.result.structuredContent.valid).toBe(false);
    expect(body.result.structuredContent.preview).toBe('not attached — available via share link');
    expect(body.result.content.some((c: { type: string }) => c.type === 'image')).toBe(false);
  });
});

describe('viewport rows', () => {
  const call = (equations: string[]) =>
    rpc('tools/call', { name: 'encode_graph_url', arguments: { equations } });

  it('classifies viewport rows and describes the share-link preview', async () => {
    const { body } = await call(['view(x = 98..102)', 'y = (x - 100)^2']);
    const out = body.result.structuredContent;
    expect(out.valid).toBe(true);
    expect(out.rows[0]).toEqual({ text: 'view(x = 98..102)', status: 'ok', kind: 'viewport (view)' });
    expect(out.preview).toBe('not attached — available via share link');
    expect(body.result.content.some((c: { type: string }) => c.type === 'image')).toBe(false);
  });

  it('accepts a camera row for 3D graphs', async () => {
    const { body } = await call(['camera(-pi/3, 0.6, 8)', 'z = x^2 - y^2']);
    const out = body.result.structuredContent;
    expect(out.valid).toBe(true);
    expect(out.rows[0].kind).toBe('viewport (camera)');
  });

  it('reports malformed viewport rows per-row, like any other error', async () => {
    const { body } = await call(['view(x = 5..-5)', 'y = sin(x)']);
    const out = body.result.structuredContent;
    expect(out.valid).toBe(false);
    expect(out.rows[0].status).toBe('error');
    expect(out.rows[0].error).toContain('lo < hi');
  });
});

describe('syntax resource', () => {
  it('declares the resources capability and lists the syntax resource', async () => {
    const { body: init } = await rpc('initialize', { protocolVersion: '2025-06-18' });
    expect(init.result.capabilities.resources).toBeDefined();
    const { body } = await rpc('resources/list');
    expect(body.result.resources).toHaveLength(2);
    expect(body.result.resources[0].name).toBe('syntax');
    expect(body.result.resources[0].uri).toBe('https://equation.io/llms.txt');
  });

  it('serves the /llms.txt asset as the resource body', async () => {
    const { body } = await rpc('resources/read', { uri: 'https://equation.io/llms.txt' });
    const [contents] = body.result.contents;
    expect(contents.uri).toBe('https://equation.io/llms.txt');
    expect(contents.mimeType).toBe('text/markdown');
    expect(contents.text).toBe(SYNTAX_DOC);
  });

  it('links only show_graph to a readable UI with cross-origin assets and scoped CSP', async () => {
    const { body: listed } = await rpc('tools/list');
    const show = listed.result.tools.find((t: { name: string }) => t.name === 'show_graph');
    expect(show._meta.ui.resourceUri).toBe(GRAPH_UI_URI);
    expect(listed.result.tools[0]._meta).toBeUndefined();
    const { body } = await rpc('resources/read', { uri: show._meta.ui.resourceUri });
    const [resource] = body.result.contents;
    expect(resource.mimeType).toBe('text/html;profile=mcp-app');
    expect(resource.text).toContain('src="https://equation.io/assets/graph.js"');
    expect(resource.text).toContain('href="https://equation.io/assets/graph.css"');
    expect(resource.text).not.toContain('__EQUATION_ORIGIN__');
    expect(resource._meta.ui.csp).toEqual({ resourceDomains: ['https://equation.io', 'blob:'], connectDomains: [] });
    const args = { equations: ['a = 2', 'y = a sin(x)'] };
    const shown = await rpc('tools/call', { name: 'show_graph', arguments: args });
    const encoded = await rpc('tools/call', { name: 'encode_graph_url', arguments: args });
    expect(shown.body.result).toEqual(encoded.body.result);
  });

  it('reports missing UI assets instead of returning the website fallback as a widget', async () => {
    const request = new Request(URL_BASE, { method: 'POST', body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: GRAPH_UI_URI },
    }) });
    const missing = { ASSETS: { fetch: async () => new Response('<html>website fallback</html>') } } as unknown as Env;
    const response = await handleMcp(request, new URL(URL_BASE), missing);
    expect(await response.json()).toMatchObject({ error: { code: -32603, message: 'Graph UI unavailable; rebuild the web assets.' } });
  });

  it('names the valid uri when asked for an unknown one', async () => {
    const { body } = await rpc('resources/read', { uri: 'https://equation.io/nope' });
    expect(body.error.code).toBe(-32002);
    expect(body.error.message).toContain('https://equation.io/llms.txt');
  });

  it('keeps tool descriptions short enough to survive client truncation', async () => {
    // The old inline syntax manual pushed encode_graph_url past 2.5KB and a client
    // truncated it mid-sentence, cutting exactly the differentiating features.
    // The manual lives in the resource now; the description must stay short.
    const { body } = await rpc('tools/list');
    for (const tool of body.result.tools) {
      // Allow the longer tool names without changing the original descriptions.
      expect(tool.description.length).toBeLessThan(1610);
    }
    const create = body.result.tools.find((t: { name: string }) => t.name === 'encode_graph_url');
    expect(create.description).toContain('llms.txt'); // points at the full reference
  });
});
