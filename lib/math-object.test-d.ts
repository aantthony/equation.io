/** Compile-only checks, included by tsc; semantic collections cannot be edited. */
import type { Classified, LevelSetSpec, MathObject } from './math-object.ts';

declare const classified: Classified;
declare const levels: LevelSetSpec;
declare const family: Extract<MathObject, { kind: 'family' }>;
declare const point: Extract<MathObject, { kind: 'point' }>;
declare const points: Extract<MathObject, { kind: 'list'; element: 'point'; storage: 'expressions' }>;

// @ts-expect-error Classification metadata is immutable.
classified.animated = true;
// @ts-expect-error Sorting requires an explicit copy.
classified.params.sort();
// @ts-expect-error Level parameter layout is immutable.
levels.params.push('a');
// @ts-expect-error Family membership is immutable.
family.members.splice(0, 1);
// @ts-expect-error Nested point-list collections are immutable too.
points.values[0].push({ kind: 'num', value: 1 });
if (point.source.representation === 'real') {
  // @ts-expect-error Point coordinates cannot be replaced.
  point.source.coordinates[0] = { kind: 'num', value: 1 };
}

// Callers can still prepare their own mutable parameter lists.
const params: string[] = [...classified.params];
params.sort();
