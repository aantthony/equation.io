import { expect, it } from 'vitest';
import { TraceQueue, type TraceInput, type TraceMessage } from './trace-queue.ts';
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
