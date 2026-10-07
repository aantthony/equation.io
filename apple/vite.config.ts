import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { EXAMPLES } from '../web/examples.ts';
import { splitStatements } from '../lib/statements.ts';

/**
 * The examples menu for the app's menu bar (apple/Equation Examples.swift):
 * web/examples.ts as data, rows split the way the web menu splits them.
 */
function examplesJson(): Plugin {
  return {
    name: 'examples-json',
    apply: 'build',
    generateBundle() {
      const categories = EXAMPLES.map(([name, items]) => ({
        name,
        examples: items.map(([label, rows, tags]) => ({
          label,
          rows: splitStatements(rows)
            .map(s => s.trim())
            .filter(Boolean),
          tags: tags.split(' ').filter(Boolean),
        })),
      }));
      this.emitFile({ type: 'asset', fileName: 'examples.json', source: JSON.stringify(categories) });
      // The language reference, which the app's chat looks syntax up in (Chat.swift).
      this.emitFile({
        type: 'asset',
        fileName: 'llms.txt',
        source: readFileSync(new URL('../web/public/llms.txt', import.meta.url), 'utf8'),
      });
    },
  };
}

/**
 * The renderer page the Apple app bundles (web/native-app). The app serves
 * it from its own scheme, equation://app/, so absolute paths resolve there.
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
  plugins: [examplesJson()],
});
