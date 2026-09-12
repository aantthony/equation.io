import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts (whose root is web/ for the graphing app):
// tests live under lib/.
export default defineConfig({
  test: {
    include: ['lib/**/*.test.ts', 'worker/**/*.test.ts'],
    benchmark: {
      include: ['lib/**/*.bench.ts'],
    },
  },
});
