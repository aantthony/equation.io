import { traceSystem } from '../lib/solve.ts';
import type { TraceMessage, TraceResult } from '../lib/trace-queue.ts';

self.onmessage = (event: MessageEvent<TraceMessage>) => {
  const { token, input } = event.data;
  let result: TraceResult;
  try {
    const { residuals, dim, lo, hi, env, angular } = input;
    const paths = traceSystem(residuals, dim === 3 ? ['x', 'y', 'z'] : ['x', 'y'], lo, hi, env, 256, angular);
    result = { pts: paths.flatMap(path => [...path, Array(dim).fill(NaN)]) };
  } catch (error) {
    result = { pts: [], error: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage({ token, result });
};
