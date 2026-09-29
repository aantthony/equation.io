import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts (whose root is web/ for the graphing app):
// tests live under lib/, worker/ and packages/.
export default defineConfig({
  test: {
    include: ['lib/**/*.test.ts', 'worker/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    // Measurements end on their work budget alone, never a slow runner's clock.
    setupFiles: ['lib/test-setup.ts'],
    // Anchored the same way as include: the default benchmark glob is
    // unanchored, so it also picked up the copies in .claude/worktrees/.
    benchmark: {
      include: ['lib/**/*.bench.ts', 'worker/**/*.bench.ts', 'packages/*/src/**/*.bench.ts'],
    },
  },
});
