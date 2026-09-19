import { type Expr, freeVars, substVars } from './expr.ts';
import { complexRootLabels } from './poly.ts';
const cache = new Map<string, ReturnType<typeof complexRootLabels>>();
export function complexRootLabel(expr: Expr | undefined, p: number[], env: Record<string, number>): string | undefined {
  if (!expr) return undefined;
  const values = Object.fromEntries([...freeVars(expr)].filter(n => n !== 'w' && Number.isFinite(env[n])).map(n => [n, { kind: 'num' as const, value: env[n] }]));
  const resolved = substVars(expr, values), key = JSON.stringify(resolved);
  let labels = cache.get(key);
  if (labels === undefined) {
    labels = complexRootLabels(resolved); if (cache.size >= 32) cache.delete(cache.keys().next().value!); cache.set(key, labels);
  }
  if (!labels) return undefined;
  const found = labels.roots.find(r => Math.hypot(r.re - p[0], r.im - p[1]) < 1e-6 * (1 + Math.hypot(...p)));
  return found?.label ?? (labels.rootOf ? `root of ${labels.rootOf} (≈ ${Number(p[0].toPrecision(4))} ${p[1] < 0 ? '−' : '+'} ${Number(Math.abs(p[1]).toPrecision(4))}i)` : undefined);
}
