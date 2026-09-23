import { evaluateFrame } from './env.ts';
import { expect, it } from 'vitest';
import { TraceQueue, traceEnvironment, type TraceInput, type TraceMessage } from './trace-queue.ts';

import { analyze } from '../worker/graph.ts';
const input: TraceInput = { residuals: [], dim: 2, lo: [-1, -1], hi: [1, 1], env: {} };
const result = { pts: [[1, 2]] };

it('coalesces a burst of wheel updates to the latest view', () => {
  const sent: TraceMessage[] = [];
  const received: string[] = [];
  const q = new TraceQueue(m => sent.push(m));
  for (let k = 0; k < 100; k++) q.request(1, String(k), input, () => received.push(String(k)));
  expect(sent).toHaveLength(1);
  q.complete(sent[0].token, result);
  expect(sent).toHaveLength(2);
  q.complete(sent[1].token, result);
  expect(received).toEqual(['0', '99']);
  expect(sent).toHaveLength(2);
});

it('deduplicates an active request and discards an obsolete pending view', () => {
  const sent: TraceMessage[] = [];
  const q = new TraceQueue(m => sent.push(m));
  q.request(1, 'original', input, () => {});
  q.request(1, 'zoomed', input, () => {});
  q.request(1, 'original', input, () => {});
  q.complete(sent[0].token, result);
  expect(sent).toHaveLength(1);
});

it('keeps different rows and advances the queue after an error', () => {
  const sent: TraceMessage[] = [];
  const rows: number[] = [];
  const q = new TraceQueue(m => sent.push(m));
  q.request(1, 'a', input, () => rows.push(1));
  q.request(2, 'b', input, () => rows.push(2));
  q.request(1, 'c', input, () => rows.push(3));
  q.complete(sent[0].token, { pts: [], error: 'test failure' });
  q.complete(sent[1].token, result);
  q.complete(sent[2].token, result);
  expect(rows).toEqual([1, 2, 3]);
});

it('ignores duplicate or unexpected replies', () => {
  const sent: TraceMessage[] = [];
  let received = 0;
  const q = new TraceQueue(m => sent.push(m));
  q.request(1, 'a', input, () => received++);
  q.complete(-1, result);
  expect(received).toBe(0);
  q.complete(sent[0].token, result);
  q.complete(sent[0].token, result);
  expect(received).toBe(1);
});


it('cancels a queued view when existing geometry covers it again', () => {
  const sent: TraceMessage[] = [];
  const q = new TraceQueue(m => sent.push(m));
  q.request(1, 'a', input, () => {});
  q.request(1, 'zoom', input, () => {});
  q.cancelPending(1);
  q.complete(sent[0].token, result);
  expect(sent).toHaveLength(1);
});

const environmentFor = (rows: string[]) => {
  const a = analyze(rows);
  expect(a.rows.some(r => r.error)).toBe(false);
  const cls = a.rows.at(-1)!.cls!;
  const keys = traceEnvironment(cls.params, cls.animated, a.defs);
  return (time: number, states: Record<string, number> = {}) => {
    const seed = Object.fromEntries(Object.entries(states).filter(([n]) => a.defs.states.has(n)));
    return keys(evaluateFrame(a.defs, time, seed), time);
  };
};

it.each([
  ['(x,y)=(u,sin(t))'],
  ['a=sin(t)', '(x,y)=(u,a)'],
  ['a=sin(t)', 'b=2a', '(x,y)=(u,b)'],
  ["a'=1", '(x,y)=(u,a)'],
  ["a'=1", 'b=2a', '(x,y)=(u,b)'],
])('keeps completed traces visible while moving inputs advance: %j', (...rows) => {
  const envAt = environmentFor(rows);
  const sent: TraceMessage[] = [];
  const q = new TraceQueue(m => sent.push(m));
  let target = '';
  let completed: { stableEnv: string; pts: number[][] } | undefined;
  for (const t of [0, 0.1, 0.2]) {
    const { env, stableEnv } = envAt(t, { a: t });
    target = stableEnv;
    q.request(1, env, input, result => {
      if (target === stableEnv) completed = { stableEnv, pts: result.pts };
    });
  }
  expect(sent).toHaveLength(1);
  q.complete(sent[0].token, result);
  expect(sent).toHaveLength(2);
  expect(completed?.pts).toEqual(result.pts);
  expect(completed?.stableEnv).toBe(envAt(0.3, { a: 0.3 }).stableEnv);
});

it('invalidates animated geometry when a fixed input or definition changes', () => {
  const rows = ['k=2', 'a=k sin(t)', '(x,y)=(u,a)'];
  const original = environmentFor(rows)(1);
  expect(environmentFor(['k=3', ...rows.slice(1)])(1).stableEnv).not.toBe(original.stableEnv);
  expect(environmentFor(['k=2', 'a=k cos(t)', rows[2]])(1).stableEnv).not.toBe(original.stableEnv);
  const state = environmentFor(["a'=1", rows[2]])(1, { a: 1 });
  expect(environmentFor(["a'=2", rows[2]])(1, { a: 1 }).stableEnv).not.toBe(state.stableEnv);
});

it('retains fixed-parameter invalidation alongside literal time animation', () => {
  const a = analyze(['a=2', '(x,y)=(u,a+t)']);
  const cls = a.rows.at(-1)!.cls!;
  const keys = traceEnvironment(cls.params, cls.animated, a.defs);
  expect(keys({ a: 2 }, 0).stableEnv).toBe(keys({ a: 2 }, 1).stableEnv);
  expect(keys({ a: 2 }, 0).stableEnv).not.toBe(keys({ a: 3 }, 1).stableEnv);
});

it('discards active and pending work on teardown, ignoring late replies', () => {
  const sent: TraceMessage[] = [];
  let received = 0;
  const queue = new TraceQueue(message => sent.push(message));
  queue.request(1, 'running', input, () => received++);
  queue.request(2, 'pending', input, () => received++);
  queue.clear();
  queue.complete(sent[0].token, result);
  expect(received).toBe(0);
  expect(sent).toHaveLength(1);
});
