/** Response helpers shared by the Worker's routes. */

export const escapeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Static assets are served without a charset, so browsers decode text/* as
// windows-1252 and mangle the em dashes in llms.txt. Tag them as UTF-8.
export function withCharset(response: Response): Response {
  const type = response.headers.get('content-type');
  if (!type || !type.startsWith('text/') || type.includes('charset=')) {
    return response;
  }
  const patched = new Response(response.body, response);
  patched.headers.set('content-type', `${type}; charset=utf-8`);
  return patched;
}

/** Replace the asset response's CSP with the route-specific policy. */
export function withCsp(response: Response, policy: string): Response {
  const patched = new Response(response.body, response);
  patched.headers.set('Content-Security-Policy', policy);
  return patched;
}
