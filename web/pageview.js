// A pageview event (worker/events.ts). The beacon names no page: the Worker
// reads it from the Referer and keeps only the page's path, never a /g/
// link's equations. External to comply with the CSP.
(function () {
  // Only the live site, and only top-level pages: localhost and preview
  // deploys aren't visits, and a framed page (an embed, the MCP app) is
  // someone else's page.
  if (location.hostname !== 'equation.io' || window.self !== window.top) return;
  try {
    navigator.sendBeacon('/api/events', '{"events":[{"name":"pageview"}]}');
  } catch {}
})();
