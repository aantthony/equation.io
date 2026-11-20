import { defineConfig } from 'vitest/config';

// The lib suite, run only to record what the parser (record-parses.ts) and
// the GLSL emitter (record-glsl.ts) are asked.
export default defineConfig({
  root: new URL('../..', import.meta.url).pathname,
  test: {
    include: ['lib/**/*.test.ts'],
    setupFiles: ['lib/test-setup.ts', 'apple/corpus/record-parses.ts', 'apple/corpus/record-glsl.ts'],
    passWithNoTests: true,
  },
});
