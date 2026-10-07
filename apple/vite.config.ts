import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * The renderer page the Apple app bundles (web/native-app). The app serves
 * it from its own scheme, app://equation/, so absolute paths resolve there.
 *
 *   pnpm app:web
 */
export default defineConfig({
  root: fileURLToPath(new URL('../web', import.meta.url)),
  publicDir: false,
  build: {
    outDir: fileURLToPath(new URL('Equation/WebBundle', import.meta.url)),
    emptyOutDir: true,
    // The app's pages load fonts as files, like the site's (vite.config.ts).
    assetsInlineLimit: file => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
    rollupOptions: {
      input: { native: fileURLToPath(new URL('../web/native-app/index.html', import.meta.url)) },
    },
  },
});
