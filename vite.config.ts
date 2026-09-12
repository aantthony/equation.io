import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig, type Plugin } from 'vite';

// Keep this a classic, parser-blocking script: module scripts run too late to
// set the theme before first paint. Emitting an asset gives it Vite's content
// hash and /assets/ immutable caching without deferring its execution.
function themeScript(): Plugin {
  return {
    name: 'theme-script',
    buildStart() {
      if (this.environment.name !== 'client' || this.environment.mode !== 'build') return;
      const path = fileURLToPath(new URL('web/theme.js', import.meta.url));
      this.addWatchFile(path);
      this.emitFile({ type: 'asset', name: 'theme.js', source: readFileSync(path, 'utf8') });
    },
    transformIndexHtml(html, context) {
      let src = '/theme.js';
      if (context.bundle) {
        const asset = Object.values(context.bundle).find(
          output => output.type === 'asset' && output.names.includes('theme.js'),
        );
        if (!asset) throw new Error('Missing emitted theme script');
        src = `/${asset.fileName}`;
      }
      return html.replace(
        '<!-- theme-script: Vite inserts a blocking script here before first paint. -->',
        `<script src="${src}"></script>`,
      );
    },
  };
}

export default defineConfig({
  root: 'web',
  server: process.env.PORT ? { port: Number(process.env.PORT), strictPort: true } : undefined,
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
  },
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: {
            main: fileURLToPath(new URL('web/index.html', import.meta.url)),
            about: fileURLToPath(new URL('web/about/index.html', import.meta.url)),
          },
        },
      },
    },
  },
  plugins: [
    themeScript(),
    cloudflare({ configPath: '../wrangler.jsonc' }),
  ],
});
