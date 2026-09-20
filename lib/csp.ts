/**
 * Content-Security-Policy values for the static _headers file and for the
 * Worker, which must set a *single* policy on /landing/ and /g/ responses.
 *
 * Cloudflare applies every matching _headers block and joins duplicate
 * Content-Security-Policy names with a comma. Browsers then AND every policy,
 * so /*'s frame-ancestors 'none' would forbid the landing iframe unless the
 * inherited header is detached (or overwritten here).
 */
const BASE = "default-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self'; style-src-attr 'none'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

export const APP_CSP =
  `${BASE}; frame-ancestors 'none'; upgrade-insecure-requests`;

export const LANDING_CSP =
  `${BASE}; frame-src 'self'; frame-ancestors 'none'; upgrade-insecure-requests`;

export const GRAPH_CSP =
  `${BASE}; frame-ancestors *; upgrade-insecure-requests`;
