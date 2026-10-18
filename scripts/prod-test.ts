/**
 * Browser smoke tests against the production build (`pnpm test:prod` builds
 * first): serves dist-web with wrangler dev on 5198, then runs the CSP, embed
 * and MCP App tests against it.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const origin = 'http://localhost:5198';
const TESTS = ['scripts/csp-test.ts', 'scripts/embed-test.ts', 'scripts/mcp-app-test.ts'];

const server = spawn(
  root + 'node_modules/.bin/wrangler',
  ['dev', '--config', 'dist-web/equation/wrangler.json', '--port', '5198'],
  { cwd: root, stdio: 'ignore' },
);
let failed = 0;
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(origin + '/api/health')).ok) break;
    } catch {}
    if (i > 150) throw new Error('wrangler dev did not start');
    await new Promise(r => setTimeout(r, 200));
  }
  for (const test of TESTS) {
    const code = await new Promise<number | null>(resolve =>
      spawn(process.execPath, [test], { cwd: root, stdio: 'inherit' }).on('exit', resolve),
    );
    if (code !== 0) {
      failed++;
      console.error(`FAIL ${test}`);
    }
  }
} finally {
  server.kill();
}
process.exit(failed ? 1 : 0);
