import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_CSP, EMBED_CSP, LANDING_CSP } from './csp.ts';

const headers = readFileSync(new URL('../web/public/_headers', import.meta.url), 'utf8');

describe('CSP policies', () => {
  it('keeps a single catch-all policy on the app shell', () => {
    expect(headers).toContain(`Content-Security-Policy: ${APP_CSP}`);
  });

  it('detaches the inherited CSP on landing and embed before replacing', () => {
    expect(headers).toMatch(
      /\/landing\/\*\n  ! Content-Security-Policy\n  Content-Security-Policy: /,
    );
    expect(headers).toMatch(
      /\/embed\/\*\n  ! Content-Security-Policy\n  Content-Security-Policy: /,
    );
    expect(headers).toContain(`Content-Security-Policy: ${LANDING_CSP}`);
    expect(headers).toContain(`Content-Security-Policy: ${EMBED_CSP}`);
  });

  it('lets landings frame same-origin embeds, and embeds be framed', () => {
    expect(LANDING_CSP).toContain("frame-src 'self'");
    expect(LANDING_CSP).toContain("frame-ancestors 'none'");
    expect(EMBED_CSP).toContain('frame-ancestors *');
    expect(EMBED_CSP).not.toContain("frame-ancestors 'none'");
  });
});
