/**
 * Records every parseExpr call the TypeScript suite makes, with what it
 * returned or threw, so the Swift parser can be held to the same answers
 * (apple/corpus/build.ts collects the records into the fixture).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { vi } from 'vitest';

const dir = new URL('./out/', import.meta.url);
mkdirSync(dir, { recursive: true });
const file = new URL(`parses-${process.pid}-${process.env.VITEST_POOL_ID ?? 0}.jsonl`, dir);

// Non-finite numbers have no JSON spelling; the fixture writes them as text.
const replacer = (key: string, value: unknown): unknown => {
  if (key === 'axes' || key === 'origin') return undefined;
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
};

vi.mock(import('../../lib/expr.ts'), async load => {
  const real = await load();
  return {
    ...real,
    parseExpr(str, userFns = new Set(), listNames = new Set(), valueNames = new Set()) {
      const input = { src: str, userFns: [...userFns], listNames: [...listNames], valueNames: [...valueNames] };
      try {
        const expr = real.parseExpr(str, userFns, listNames, valueNames);
        appendFileSync(file, JSON.stringify({ ...input, expr }, replacer) + '\n');
        return expr;
      } catch (err) {
        const e = err as Error;
        appendFileSync(file, JSON.stringify({ ...input, error: e.message, errorType: e.constructor.name }) + '\n');
        throw err;
      }
    },
  };
});
