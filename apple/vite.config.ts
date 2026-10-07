import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { EXAMPLES } from '../web/examples.ts';
import { examplesIndex } from '../lib/assistant-tools.ts';
import { assistantData } from '../lib/reference.ts';
import { splitStatements } from '../lib/statements.ts';
import { readReference } from '../scripts/reference.ts';

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
      // What the chat's lookups answer from (lib/assistant-tools.ts): the
      // reference's kinds, forms, examples and notes (docs/reference), with
      // the same menu examples by what they draw and the functions they call.
      const menu = examplesIndex(EXAMPLES.flatMap(([, items]) => items.map(([label, rows]) => [label, rows] as const)));
      const data = assistantData(readReference(), menu);
      this.emitFile({ type: 'asset', fileName: 'assistant.json', source: JSON.stringify(data) });
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
