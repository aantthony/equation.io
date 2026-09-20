import { fileURLToPath } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  html: {
    additionalAssetSources: {
      // Hash classic scripts as assets, preserving parser-blocking execution.
      // Vite still warns that these cannot be bundled as modules; asset emission
      // is intentional, and ?no-inline keeps the result compatible with CSP.
      script: {
        srcAttributes: ['src'],
        filter: ({ attributes }) => attributes.type !== 'module',
      },
    },
  },
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
            mcpApp: fileURLToPath(new URL('web/mcp-app/index.html', import.meta.url)),
            about: fileURLToPath(new URL('web/about/index.html', import.meta.url)),
            landing: fileURLToPath(new URL('web/landing/index.html', import.meta.url)),
            embed: fileURLToPath(new URL('web/embed/index.html', import.meta.url)),
            privacy: fileURLToPath(new URL('web/privacy/index.html', import.meta.url)),
            terms: fileURLToPath(new URL('web/terms/index.html', import.meta.url)),
          },
        },
      },
    },
  },
  plugins: [
    cloudflare({ configPath: '../wrangler.jsonc' }),
  ],
});
