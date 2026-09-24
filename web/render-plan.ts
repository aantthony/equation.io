/** Adapt compiled GPU plans to the renderer's parameter and uniform layout. */
import type { GpuPlan } from '../lib/compiler.ts';
import { uniformName } from '../lib/glsl.ts';

export function gpuFor<T extends GpuPlan['type']>(row: { gpu?: GpuPlan }, type: T): Extract<GpuPlan, { type: T }> {
  if (row.gpu?.type !== type) throw new Error(`Missing ${type} shader plan.`);
  return row.gpu as Extract<GpuPlan, { type: T }>;
}

export function shaderBindings(plan?: GpuPlan): { params: string[]; uniforms: Record<string, number> } {
  return {
    params: plan?.params ?? [],
    uniforms: Object.fromEntries(
      Object.entries(plan?.uniforms ?? {}).map(([name, value]) => [uniformName(name), value]),
    ),
  };
}
