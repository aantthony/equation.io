import { certifySystem } from '../lib/certify.ts';
import { traceIntersection } from '../lib/intersection.ts';
import { traceField } from '../lib/flow.ts';
import { solveSystem, traceSystem } from '../lib/solve.ts';
import type { TraceMessage, TraceResult } from '../lib/trace-queue.ts';

self.onmessage = (event: MessageEvent<TraceMessage>) => {
  const { token, input } = event.data;
  let result: TraceResult;
  try {
    const { residuals, dim, lo, hi, env, angular } = input;
    if (input.kind === 'certify') {
      if (angular?.some(Boolean)) throw new Error('Certification does not yet cover wrapped angular coordinates.');
      const proof = certifySystem(residuals, dim === 3 ? ['x', 'y', 'z'] : ['x', 'y'], lo, hi, env);
      const numeric = solveSystem(residuals, dim === 3 ? ['x', 'y', 'z'] : ['x', 'y'], lo, hi, { env });
      for (const p of proof.roots) if (!numeric.some(q => Math.hypot(...q.map((v, k) => v - p[k])) < 1e-7)) numeric.push(p);
      result = { pts: numeric, info: `Search box: ${proof.roots.length} certified root${proof.roots.length === 1 ? '' : 's'}; ${proof.complete ? 'complete' : `${proof.unresolved} unresolved regions (bounded search)`}` };
      self.postMessage({ token, result }); return;
    }
    const paths = input.kind === 'intersection' ? traceIntersection(residuals, lo, hi, env) : input.kind === 'field' ? traceField(residuals, lo, hi, env, input.glyphs) : traceSystem(residuals, dim === 3 ? ['x', 'y', 'z'] : ['x', 'y'], lo, hi, env, 256, angular);
    result = { pts: paths.flatMap(path => [...path, Array(dim).fill(NaN)]) };
  } catch (error) {
    result = { pts: [], error: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage({ token, result });
};
