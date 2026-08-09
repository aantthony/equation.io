import { describe, expect, it } from 'vitest';
import { handleMcp } from './mcp.ts';

const URL_BASE = 'https://equation.io/mcp';

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

  it('lists both tools', async () => {
    const { body } = await rpc('tools/list');
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual(['create_graph', 'read_graph']);
  });

  it('creates a validated graph link (tangent-line editing example)', async () => {
    const { body } = await rpc('tools/call', {
      name: 'create_graph',
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
      name: 'create_graph',
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
    expect(out.preview).toBe('attached');
  });

  it('validates random-variable rows like the app does (normal probability)', async () => {
    const { body } = await rpc('tools/call', {
      name: 'create_graph',
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
      name: 'create_graph',
      arguments: { equations: ['N = 8', 'y = 2 sum[n=1..N] (-1)^(n+1) sin(n x)/n'] },
    });
    const out = body.result.structuredContent;
    expect(out.valid).toBe(true);
    expect(out.rows.map((r: { kind?: string }) => r.kind)).toEqual(['definition (const)', 'implicit2d']);
    expect(out.preview_omits).toBeUndefined();
  });

  it('still rejects Σ bounds with no static value (animated constant)', async () => {
    const { body } = await rpc('tools/call', {
      name: 'create_graph',
      arguments: { equations: ['a = 2 + sin(t)', 'y = sum[n=1..a] x^n'] },
    });
    const out = body.result.structuredContent;
    expect(out.valid).toBe(false);
    expect(out.rows[1].status).toBe('error');
    expect(out.rows[1].error).toContain('must be constant');
  });

  it('rejects a P(…) row with no random variable declared', async () => {
    const { body } = await rpc('tools/call', {
      name: 'create_graph',
      arguments: { equations: ['P(X < 2)'] },
    });
    const out = body.result.structuredContent;
    expect(out.valid).toBe(false);
    expect(out.rows[0].status).toBe('error');
    expect(out.rows[0].error).toContain('X ~ Normal(0, 1)');
  });

  it('validates random-variable rows: base, derived, and P(…) forms', async () => {
    const { body } = await rpc('tools/call', {
      name: 'create_graph',
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
    expect(out.preview).toBe('attached');
  });

  it('validates E(…) rows: exact and sampled means', async () => {
    const { body } = await rpc('tools/call', {
      name: 'create_graph',
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
    expect(out.preview).toBe('attached');
  });

  it('validates ∫ rows: exact readouts and non-elementary curves', async () => {
    const { body } = await rpc('tools/call', {
      name: 'create_graph',
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
    expect(out.preview).toBe('attached');
  });

  it('rejects malformed ∫ rows with a usable message', async () => {
    const { body } = await rpc('tools/call', {
      name: 'create_graph',
      arguments: { equations: ['int(x^2)'] },
    });
    const out = body.result.structuredContent;
    expect(out.valid).toBe(false);
    expect(out.rows[0].error).toContain('dx');
  });

  it('leaves E(…) rows alone when the user defines E', async () => {
    const { body } = await rpc('tools/call', {
      name: 'create_graph',
      arguments: { equations: ['E = 3', 'X ~ Normal(0, 1)', 'E(X)'] },
    });
    const out = body.result.structuredContent;
    // E is the user's constant, so E(X) is the product E·X — a derived
    // density row, not an expectation readout.
    expect(out.rows[2].kind).toBe('random variable (density curve)');
  });

  it('reports per-row errors without failing the call', async () => {
    const { body } = await rpc('tools/call', {
      name: 'create_graph',
      arguments: { equations: ['y = x^2', 'y = florb(x)'] },
    });
    const out = body.result.structuredContent;
    expect(out.valid).toBe(false);
    expect(out.rows[0].status).toBe('ok');
    expect(out.rows[1].status).toBe('error');
  });

  it('treats # rows as comments, not errors', async () => {
    const { body } = await rpc('tools/call', {
      name: 'create_graph',
      arguments: { equations: ['# Lines', 'y = x'] },
    });
    const out = body.result.structuredContent;
    expect(out.valid).toBe(true);
    expect(out.rows[0]).toMatchObject({ status: 'ok', kind: 'comment (group heading)' });
    expect(out.rows[1].status).toBe('ok');
  });

  it('round-trips a link through read_graph (both URL forms)', async () => {
    const { body: created } = await rpc('tools/call', {
      name: 'create_graph',
      arguments: { equations: ['a = 2', 'y = sin(a x)/a'] },
    });
    for (const key of ['url', 'share_url'] as const) {
      const { body } = await rpc('tools/call', {
        name: 'read_graph',
        arguments: { url: created.result.structuredContent[key] },
      });
      expect(body.result.structuredContent.equations).toEqual(['a = 2', 'y = sin(a x)/a']);
    }
  });

  it('names the expected argument when a caller guesses wrong', async () => {
    // "rows" is the guess to expect: the tool's own result calls the
    // per-equation validation "rows", so a caller can reasonably reach for it.
    const { body } = await rpc('tools/call', {
      name: 'create_graph',
      arguments: { rows: ['y = x^2'] },
    });
    const text = body.result.content[0].text;
    expect(text).toContain('"equations"');
    expect(text).toContain('"rows"'); // says what arrived, not just what was wanted
    expect(text).toContain('{"equations": ["y = x^2", "y = sin(x)"]}'); // a copyable example
  });

  it('describes the argument it actually takes', async () => {
    const { body } = await rpc('tools/list');
    const create = body.result.tools.find((t: { name: string }) => t.name === 'create_graph');
    expect(Object.keys(create.inputSchema.properties)).toEqual(['equations']);
    expect(create.inputSchema.required).toEqual(['equations']);
    // The prose must not tell a caller to send "rows:" — the schema says
    // equations, and a description that disagrees is what caused the misuse.
    expect(create.description).not.toMatch(/send rows|rows:\s*\[/i);
    expect(create.description).toContain('"equations"');
  });

  it('feeds read_graph output straight back into create_graph', async () => {
    const rows = ['a = 2', 'y = sin(a x)'];
    const made = await rpc('tools/call', { name: 'create_graph', arguments: { equations: rows } });
    const url = JSON.parse(made.body.result.content[0].text).share_url;
    const read = await rpc('tools/call', { name: 'read_graph', arguments: { url } });
    // read_graph returns "equations", the exact key create_graph consumes.
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
  });
});

describe('draggable points', () => {
  const rowsFor = async (equations: string[]) => {
    const { body } = await rpc('tools/call', { name: 'create_graph', arguments: { equations } });
    return body.result.structuredContent.rows as Array<{ text: string; kind?: string; draggable?: boolean }>;
  };

  it('marks literal and slider-coordinate points draggable', async () => {
    const rows = await rowsFor(['(2, 3)', 'a = 1', '(a, 4)']);
    expect(rows[0]).toMatchObject({ kind: 'point', draggable: true });
    expect(rows[1].draggable).toBeUndefined(); // the slider itself is not a point
    expect(rows[2]).toMatchObject({ kind: 'point', draggable: true });
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
    rpc('tools/call', { name: 'create_graph', arguments: { equations } });

  it('attaches a PNG the caller can actually look at', async () => {
    const { body } = await call(['y = sin(x)', 'y = x/2']);
    expect(body.result.structuredContent.preview).toBe('attached');
    const image = body.result.content.find((c: { type: string }) => c.type === 'image');
    expect(image.mimeType).toBe('image/png');
    const bytes = Uint8Array.from(atob(image.data), ch => ch.charCodeAt(0));
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG magic
  });

  it('notes that an animated graph is rendered at t = 0', async () => {
    const { body } = await call(['y = sin(x - 2t)']);
    expect(body.result.structuredContent.preview).toContain('t = 0');
    expect(body.result.content.some((c: { type: string }) => c.type === 'image')).toBe(true);
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
    expect(body.result.content.some((c: { type: string }) => c.type === 'image')).toBe(true);
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

  it('does not call a definition-only document fine', async () => {
    // `ages` draws nothing on any device, so "every plot row is device-local"
    // would send the caller away satisfied with a graph that is simply empty.
    const { body } = await call(['person = open("people.csv", 3a7f1b2c9d4e)', 'ages = person.age / 2']);
    const out = body.result.structuredContent;
    expect(out.preview).toContain('no plot rows');
    expect(out.preview).not.toContain('the graph itself is fine');
  });

  it('still previews the working rows of a partly-broken graph', async () => {
    const { body } = await call(['y = x^2', 'y = florb(x)']);
    expect(body.result.structuredContent.valid).toBe(false);
    expect(body.result.structuredContent.preview).toBe('attached');
    expect(body.result.content.some((c: { type: string }) => c.type === 'image')).toBe(true);
  });
});

describe('viewport rows', () => {
  const call = (equations: string[]) =>
    rpc('tools/call', { name: 'create_graph', arguments: { equations } });

  it('classifies viewport rows and still attaches the (framed) preview', async () => {
    const { body } = await call(['view(x = 98..102)', 'y = (x - 100)^2']);
    const out = body.result.structuredContent;
    expect(out.valid).toBe(true);
    expect(out.rows[0]).toEqual({ text: 'view(x = 98..102)', status: 'ok', kind: 'viewport (view)' });
    expect(out.preview).toBe('attached');
    expect(body.result.content.some((c: { type: string }) => c.type === 'image')).toBe(true);
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
    expect(body.result.resources).toHaveLength(1);
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

  it('names the valid uri when asked for an unknown one', async () => {
    const { body } = await rpc('resources/read', { uri: 'https://equation.io/nope' });
    expect(body.error.code).toBe(-32002);
    expect(body.error.message).toContain('https://equation.io/llms.txt');
  });

  it('keeps tool descriptions short enough to survive client truncation', async () => {
    // The old inline syntax manual pushed create_graph past 2.5KB and a client
    // truncated it mid-sentence, cutting exactly the differentiating features.
    // The manual lives in the resource now; the description must stay short.
    const { body } = await rpc('tools/list');
    for (const tool of body.result.tools) {
      expect(tool.description.length).toBeLessThan(1600);
    }
    const create = body.result.tools.find((t: { name: string }) => t.name === 'create_graph');
    expect(create.description).toContain('llms.txt'); // points at the full reference
  });
});
