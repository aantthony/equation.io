/**
 * Records every call the TypeScript suite makes into lib/glsl.ts — toGLSL,
 * fourierGraphGLSL, uniformName, declareHelper — with what it returned or
 * threw, so the Swift emitter can be held to the same text
 * (apple/corpus/build.ts collects the records into the fixture).
 *
 * Only calls from outside lib/glsl.ts pass through here: its own recursion
 * is not recorded, so each record is one whole expression.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { vi } from 'vitest';

const dir = new URL('./out/', import.meta.url);
mkdirSync(dir, { recursive: true });
const file = new URL(`glsl-${process.pid}-${process.env.VITEST_POOL_ID ?? 0}.jsonl`, dir);

// JSON has no spelling for a non-finite number or for -0; the fixture writes
// them as text. A packed column (a `data` or `lazy` node's typed array) is
// only marked: the Swift Expr has no such node yet.
const replacer = (key: string, value: unknown): unknown => {
  if (key === 'axes' || key === 'origin') return undefined;
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (Object.is(value, -0)) return '-0';
  if (ArrayBuffer.isView(value)) return '[packed]';
  return value;
};

// A suite compiles the same expression many times; one record each.
const seen = new Set<string>();
function record(entry: object): void {
  const line = JSON.stringify(entry, replacer);
  if (seen.has(line)) return;
  seen.add(line);
  appendFileSync(file, line + '\n');
}

function recorded<T>(input: object, call: () => T): T {
  try {
    const out = call();
    record({ ...input, out: out ?? null });
    return out;
  } catch (err) {
    record({ ...input, error: (err as Error).message });
    throw err;
  }
}

/** The derivatives fourierGraphGLSL asks for while it runs: the Swift port
 *  is handed lib/diff.ts's answers, which it does not have yet. */
let graphDiffs: object[] | null = null;

vi.mock(import('../../lib/diff.ts'), async load => {
  const real = await load();
  return {
    ...real,
    diff(e, v) {
      const asked = graphDiffs;
      if (!asked) return real.diff(e, v);
      try {
        const out = real.diff(e, v);
        asked.push({ expr: e, v, out });
        return out;
      } catch (err) {
        asked.push({ expr: e, v, error: (err as Error).message });
        throw err;
      }
    },
  };
});

vi.mock(import('../../lib/glsl.ts'), async load => {
  const real = await load();
  return {
    ...real,
    toGLSL: e => recorded({ fn: 'toGLSL', expr: e }, () => real.toGLSL(e)),
    uniformName: p => recorded({ fn: 'uniformName', p }, () => real.uniformName(p)),
    declareHelper: (source, table) =>
      recorded({ fn: 'declareHelper', source, table: table ? Array.from(table) : null }, () =>
        real.declareHelper(source, table),
      ),
    fourierGraphGLSL(e) {
      const diffs: object[] = (graphDiffs = []);
      try {
        return recorded({ fn: 'fourierGraphGLSL', expr: e, diffs }, () => real.fourierGraphGLSL(e));
      } finally {
        graphDiffs = null;
      }
    },
  };
});
