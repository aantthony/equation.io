/**
 * Guards wrangler.jsonc against the Worker's own routing.
 *
 * Lives in lib/ rather than worker/ because it reads a file: the worker
 * tsconfig compiles with `types: []` (Workers runtime only), where node:fs and
 * import.meta.url do not exist, while lib tests are excluded from typechecking.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { landingWorkerPaths } from './landings.ts';

const assets = (() => {
  const src = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  return JSON.parse(src.replace(/^\s*\/\/.*$/gm, '')).assets;
})();

/**
 * Every path worker/index.ts handles must appear in the assets
 * `run_worker_first` list, or Cloudflare serves it from the asset server and
 * the Worker never runs. A missing entry used to be quiet and misleading:
 * with not_found_handling=single-page-application a GET returned the app
 * shell with HTTP 200 and a POST returned 405, so the route read as
 * half-implemented rather than unrouted.
 *
 * That is exactly how /mcp and /g/ reached a preview deployment broken while
 * /g/ links still looked fine — the graph rendered from the shell, but the og:
 * tags the Worker injects were silently absent, so nothing unfurled.
 */
describe('wrangler run_worker_first covers the worker routes', () => {
  const patterns: string[] = assets.run_worker_first;

  const covered = (path: string) =>
    patterns.some(p => (p.endsWith('/*') ? path.startsWith(p.slice(0, -1)) : path === p));

  // One representative path per branch of the handler's dispatch, plus the
  // two text assets the Worker re-tags with a charset.
  it.each([
    ['/mcp'],
    ['/mcp/server-card'],
    ['/.well-known/ard.json'],
    ['/api/health'],
    ['/api/og/abc'],
    ['/g/y%20%3D%20x'],
    ...landingWorkerPaths().map(p => [p]),
    ['/llms.txt'],
    ['/robots.txt'],
  ])('%s reaches the worker', path => {
    expect(covered(path), `${path} would be served by the asset server, not the worker`).toBe(true);
  });

  it('leaves the app shell and its assets to the asset server', () => {
    // Marking these worker-first would make every page load pay for the worker.
    for (const path of ['/', '/index.html', '/style.css', '/about/', '/landing/', '/mcp-app/app.js']) {
      expect(covered(path), `${path} should be served directly by the asset server`).toBe(false);
    }
  });
});

describe('a path with no file', () => {
  // The app at every unknown path answered scanners with 200, and answered a
  // module script whose bundle a deploy had removed with HTML, cached as
  // immutable for a year. The app lives at / and, through the Worker, /g/*.
  it('gets the 404 page, not the app', () => {
    expect(assets.not_found_handling).toBe('404-page');
    expect(existsSync(new URL('../web/404.html', import.meta.url))).toBe(true);
  });
});
