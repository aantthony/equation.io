import { defineConfig } from 'vitest/config';

// The lib suite, run only to record what the parser is asked (record-parses.ts).
export default defineConfig({
  root: new URL('../..', import.meta.url).pathname,
  test: {
    include: ['lib/**/*.test.ts'],
    setupFiles: ['lib/test-setup.ts', 'apple/corpus/record-parses.ts'],
    passWithNoTests: true,
  },
});
