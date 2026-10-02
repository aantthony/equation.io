import { fileURLToPath } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig, type Plugin } from 'vite';

/**
 * Hosts keep the MCP App page they were served: ChatGPT stores a copy with
 * each conversation. A copy that names this build's hashed bundles runs this
 * build forever, or nothing once a deploy removes them. So the built page
 * names two stable files instead, /mcp-app/app.js and /mcp-app/app.css, which
 * import the hashed entries. They are revalidated on every load (_headers),
 * so any copy a host kept runs the current build.
 */
function mcpAppLoader(): Plugin {
  return {
    name: 'mcp-app-loader',
    apply: 'build',
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(_, bundle) {
        const page = bundle['mcp-app/index.html'];
        if (page?.type !== 'asset') return;
        const scripts: string[] = [];
        const styles: string[] = [];
        const html = String(page.source)
          .replace(/\n\s*<script type="module" crossorigin src="\/(assets\/[^"]+\.js)"><\/script>/g, (_, src) => {
            scripts.push(src);
            return '';
          })
          .replace(/\n\s*<link rel="stylesheet" crossorigin href="\/(assets\/[^"]+\.css)">/g, (_, href) => {
            styles.push(href);
            return '';
          });
        if (!scripts.length || html.includes('/assets/')) this.error('mcp-app/index.html: unexpected asset tags');
        // Relative to /mcp-app/, so they resolve against our origin from
        // inside the host's frame.
        const js = scripts.map(src => `import '../${src}';\n`).join('');
        const css = styles.map(href => `@import url('../${href}');\n`).join('');
        this.emitFile({ type: 'asset', fileName: 'mcp-app/app.js', source: js });
        this.emitFile({ type: 'asset', fileName: 'mcp-app/app.css', source: css });
        page.source = html.replace(
          '</head>',
          '  <script type="module" crossorigin src="/mcp-app/app.js"></script>\n' +
            '  <link rel="stylesheet" crossorigin href="/mcp-app/app.css">\n</head>',
        );
      },
    },
  };
}

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
    // The CSP's font-src 'self' refuses data: URIs, so small font subsets
    // must ship as files rather than be inlined into the CSS.
    assetsInlineLimit: file => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
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
            privacy: fileURLToPath(new URL('web/privacy/index.html', import.meta.url)),
            terms: fileURLToPath(new URL('web/terms/index.html', import.meta.url)),
            notFound: fileURLToPath(new URL('web/404.html', import.meta.url)),
          },
        },
      },
    },
  },
  plugins: [
    mcpAppLoader(),
    cloudflare({
      configPath: '../wrangler.jsonc',
      // The repo root's .wrangler/state, where `wrangler d1 …` and
      // scripts/voice-key.ts look — not web/, which is only Vite's root.
      persistState: { path: fileURLToPath(new URL('.wrangler/state', import.meta.url)) },
    }),
  ],
});
