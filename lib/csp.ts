/**
 * APP_CSP mirrors the static assets' catch-all _headers policy.
 * The Worker replaces that inherited policy for graph and intent landing
 * responses; those route-specific policies live only here.
 */
const BASE = "default-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self'; style-src-attr 'none'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

export const APP_CSP =
  `${BASE}; frame-ancestors 'none'`;

export const LANDING_CSP =
  `${BASE}; frame-src 'self'; frame-ancestors 'none'`;

export const GRAPH_CSP =
  `${BASE}; frame-ancestors *`;
