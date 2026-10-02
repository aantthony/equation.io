// Counts this page load (worker/visits.ts). The beacon carries nothing: the
// Worker reads which page from its Referer and keeps only that page's path,
// never a /g/ link's equations. External to comply with the CSP.
(function () {
  // Only the live site, and only top-level pages: localhost and preview
  // deploys aren't visits, and a framed page (an embed, the MCP app) is
  // someone else's page.
  if (location.hostname !== 'equation.io' || window.self !== window.top) return;
  try {
    navigator.sendBeacon('/api/visit');
  } catch {}
})();
