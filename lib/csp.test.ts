import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_CSP, GRAPH_CSP, LANDING_CSP } from './csp.ts';

const headers = readFileSync(new URL('../web/public/_headers', import.meta.url), 'utf8');

describe('CSP policies', () => {
  it('keeps a single catch-all policy on the app shell', () => {
    expect(headers).toContain(`Content-Security-Policy: ${APP_CSP}`);
  });

  it('lets landings frame same-origin embeds, and embeds be framed', () => {
    expect(LANDING_CSP).toContain("frame-src 'self'");
    expect(LANDING_CSP).toContain("frame-ancestors 'none'");
    expect(GRAPH_CSP).toContain('frame-ancestors *');
    expect(GRAPH_CSP).not.toContain("frame-ancestors 'none'");
  });
});
