import { describe, expect, it, vi } from 'vitest';
import { type GraphHost, type GraphState, type ToolContext, runTool } from './host.ts';

const state: GraphState = { mode: '2d', window: { x: [-1, 1], y: [-1, 1] }, rows: [] };

function fakes() {
  const host: GraphHost = {
    graph: vi.fn(() => state),
    setRows: vi.fn(() => state),
    animateSlider: vi.fn(() => ({ ok: true })),
    moveView: vi.fn(() => ({ ok: true })),
    toClient: vi.fn(() => ({ x: 0, y: 0 })),
    screenshot: vi.fn(() => ({
      canvas: { toDataURL: () => 'data:image/jpeg;base64,AA' } as unknown as HTMLCanvasElement,
      rect: {} as DOMRect,
    })),
    notice: vi.fn(),
  };
  const ctx: ToolContext = {
    attach: vi.fn(() => Promise.resolve()),
    captured: vi.fn(),
    readSyntax: vi.fn(async (q: string) => `entries for ${q}`),
    pointAt: vi.fn(() => true),
  };
  return { host, ctx };
}

describe('runTool', () => {
  it('replaces the graph with set_graph and validates its arguments', async () => {
    const { host, ctx } = fakes();
    expect(await runTool(host, 'set_graph', '{"equations":["y = x"]}', ctx)).toBe(state);
    expect(host.setRows).toHaveBeenCalledWith(['y = x']);
    expect(await runTool(host, 'set_graph', '{"equations":"y = x"}', ctx)).toMatchObject({ error: expect.any(String) });
    expect(await runTool(host, 'set_graph', 'not json', ctx)).toMatchObject({ error: expect.any(String) });
  });

  it('attaches a screenshot with its legend for look_at_graph', async () => {
    const { host, ctx } = fakes();
    expect(await runTool(host, 'look_at_graph', '{}', ctx)).toHaveProperty('screenshot');
    expect(ctx.attach).toHaveBeenCalledWith('data:image/jpeg;base64,AA', expect.stringContaining('Visible window'));
  });

  it('clamps durations and checks move_view ranges', async () => {
    const { host, ctx } = fakes();
    await runTool(host, 'move_view', '{"x":[-2,2],"seconds":999}', ctx);
    expect(host.moveView).toHaveBeenCalledWith(expect.objectContaining({ x: [-2, 2] }), 30);
    expect(await runTool(host, 'move_view', '{"x":[1]}', ctx)).toHaveProperty('error');
  });

  it('answers read_syntax from the reference and rejects unknown tools', async () => {
    const { host, ctx } = fakes();
    expect(await runTool(host, 'read_syntax', '{"query":"vector field"}', ctx)).toEqual({
      reference: 'entries for vector field',
    });
    expect(await runTool(host, 'nope', '{}', ctx)).toEqual({ error: 'unknown tool nope' });
  });
});
