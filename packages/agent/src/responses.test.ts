import { describe, expect, it } from 'vitest';
import {
  Agent,
  AgentAborted,
  type Item,
  type ResponsesRequest,
  type StreamEvent,
  pruneImages,
  replayable,
} from './responses.ts';
import { TOOLS } from './tools.ts';

const say = (text: string): StreamEvent[] => [
  { type: 'response.output_text.delta', delta: text.slice(0, 3) },
  { type: 'response.output_text.delta', delta: text.slice(3) },
  {
    type: 'response.output_item.done',
    item: { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  },
  { type: 'response.completed', response: { output: [] } },
];

const call = (name: string, args: object, callId = 'call_1'): StreamEvent[] => [
  {
    type: 'response.output_item.done',
    item: { id: 'fc_1', type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) },
  },
  { type: 'response.completed', response: { output: [] } },
];

/** A transport that plays one canned response per request and records what was sent. */
function scripted(...responses: StreamEvent[][]) {
  const requests: ResponsesRequest[] = [];
  const transport = async function* (request: ResponsesRequest) {
    requests.push(structuredClone(request));
    const next = responses.shift();
    if (!next) throw new Error('no more responses scripted');
    yield* next;
  };
  return { requests, transport };
}

const agent = (transport: ReturnType<typeof scripted>['transport'], runTool = async () => ({ ok: true })) =>
  new Agent({ transport, model: 'm', instructions: 'be helpful', tools: TOOLS, runTool });

describe('Agent (Responses API loop)', () => {
  it('sends stateless streaming requests and returns the reply', async () => {
    const { requests, transport } = scripted(say('Hello there'));
    const deltas: string[] = [];
    const reply = await agent(transport).send('hi', { onTextDelta: d => deltas.push(d) });
    expect(reply).toBe('Hello there');
    expect(deltas.join('')).toBe('Hello there');
    expect(requests[0]).toMatchObject({ model: 'm', store: false, stream: true, instructions: 'be helpful' });
    expect(requests[0].include).toContain('reasoning.encrypted_content');
    expect(requests[0].tools.map(t => t.name)).toContain('set_graph');
    expect(requests[0].input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
  });

  it('runs tool calls against the app and continues with their results', async () => {
    const { requests, transport } = scripted(call('set_graph', { equations: ['y = x'] }), say('Done.'));
    const ran: [string, string][] = [];
    const a = agent(transport, async (name, args) => {
      ran.push([name, args]);
      return { rows: [{ text: 'y = x', status: 'ok' }] };
    });
    expect(await a.send('draw y = x')).toBe('Done.');
    expect(ran).toEqual([['set_graph', '{"equations":["y = x"]}']]);
    const second = requests[1].input;
    // The call goes back without its id (store: false), followed by its output.
    expect(second[1]).toEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'set_graph',
      arguments: '{"equations":["y = x"]}',
    });
    expect(second[2]).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: JSON.stringify({ rows: [{ text: 'y = x', status: 'ok' }] }),
    });
    // The history carries on into the next turn.
    expect(a.history.at(-1)).toMatchObject({ type: 'message', role: 'assistant' });
  });

  it('puts a screenshot in after the tool outputs of the step that took it', async () => {
    const { requests, transport } = scripted(call('look_at_graph', {}), say('A parabola.'));
    let a: Agent;
    a = agent(transport, async () => {
      await a.attach('data:image/jpeg;base64,AAAA', 'Rows: y = x^2');
      return { screenshot: 'attached' };
    });
    await a.send('what is on screen?');
    const input = requests[1].input;
    expect(input[2].type).toBe('function_call_output');
    expect(input[3]).toMatchObject({ type: 'message', role: 'user' });
    expect(JSON.stringify(input[3])).toContain('data:image/jpeg;base64,AAAA');
  });

  it('reports a tool that throws as an error result, not a failed turn', async () => {
    const { requests, transport } = scripted(call('get_graph', {}), say('ok'));
    await agent(transport, () => Promise.reject(new Error('boom'))).send('?');
    expect(requests[1].input[2]).toMatchObject({ output: JSON.stringify({ error: 'boom' }) });
  });

  it('can speak one turn with other instructions', async () => {
    const { requests, transport } = scripted(say('a'), say('b'));
    const a = agent(transport);
    await a.send('typed');
    await a.send('spoken', { instructions: 'talk' });
    expect(requests.map(r => r.instructions)).toEqual(['be helpful', 'talk']);
    expect(requests[1].input).toHaveLength(3);
  });

  it('surfaces a failed response', async () => {
    const { transport } = scripted([{ type: 'response.failed', response: { error: { message: 'quota exceeded' } } }]);
    await expect(agent(transport).send('hi')).rejects.toThrow('quota exceeded');
  });

  it('stops after the step limit', async () => {
    const { transport } = scripted(...Array.from({ length: 3 }, () => call('get_graph', {})));
    const a = new Agent({
      transport,
      model: 'm',
      instructions: '',
      tools: TOOLS,
      runTool: async () => ({}),
      maxSteps: 3,
    });
    expect(await a.send('loop')).toMatch(/stopped/);
  });

  it('keeps the history consistent when interrupted mid-turn', async () => {
    const controller = new AbortController();
    const { transport } = scripted([
      ...call('get_graph', {}, 'a').slice(0, 1),
      ...call('set_graph', { equations: [] }, 'b'),
    ]);
    const a = agent(transport, async () => {
      controller.abort();
      return {};
    });
    await expect(a.send('go', {}, controller.signal)).rejects.toBeInstanceOf(AgentAborted);
    const outputs = a.history.filter(i => i.type === 'function_call_output').map(i => i.call_id);
    expect(outputs).toEqual(['a', 'b']);
  });

  it('uses the completed response when items were not streamed one by one', async () => {
    const { transport } = scripted([
      {
        type: 'response.completed',
        response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }] },
      },
    ]);
    expect(await agent(transport).send('hello')).toBe('hi');
  });
});

describe('replayable', () => {
  it('drops ids and reasoning without encrypted content', () => {
    expect(replayable({ type: 'reasoning', id: 'rs_1', summary: [] })).toBeNull();
    expect(replayable({ type: 'reasoning', id: 'rs_1', encrypted_content: 'x', summary: [] })).toEqual({
      type: 'reasoning',
      encrypted_content: 'x',
      summary: [],
    });
    expect(replayable({ type: 'message', id: 'm', status: 'completed', role: 'assistant', content: [] })).toEqual({
      type: 'message',
      role: 'assistant',
      content: [],
    });
  });
});

describe('pruneImages', () => {
  const shot = (n: number): Item => ({
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: `legend ${n}` },
      { type: 'input_image', image_url: `data:${n}` },
    ],
  });

  it('keeps only the newest screenshots', () => {
    const pruned = pruneImages([shot(1), shot(2), shot(3)], 2);
    expect(JSON.stringify(pruned[0])).not.toContain('data:1');
    expect(JSON.stringify(pruned[0])).toContain('legend 1');
    expect(JSON.stringify(pruned[1])).toContain('data:2');
    expect(JSON.stringify(pruned[2])).toContain('data:3');
  });
});
