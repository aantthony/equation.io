/*
 * Prompt to switch to the new version of Equation.io (https://equation.io/).
 *
 * Shows a small dismissible banner at the bottom of the classic graph.tk
 * app. "Not now" snoozes it for 14 days; iframe embeds never see it.
 */
(function () {
  'use strict';

  var NEW_URL = 'https://equation.io/';
  var SNOOZE_KEY = 'nvbSnoozeUntil';
  var SNOOZE_DAYS = 14;

  // Embeds are someone else's page; only prompt direct visitors.
  try { if (window.top !== window.self) return; } catch (e) { return; }

  try {
    if (Number(localStorage.getItem(SNOOZE_KEY)) > Date.now()) return;
  } catch (e) { /* storage blocked: just show the banner */ }

  var style = document.createElement('style');
  style.appendChild(document.createTextNode(
    // width:max-content because a fixed box at left:50% otherwise shrinks to
    // the space right of the midline before the transform recenters it.
    '#nvb{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);' +
      'z-index:2147483000;box-sizing:border-box;display:flex;align-items:center;' +
      'gap:14px;width:max-content;max-width:calc(100vw - 24px);padding:12px 16px;' +
      'background:#fff;color:#26313b;border:1px solid #d5dde5;border-radius:12px;' +
      'box-shadow:0 6px 24px rgba(20,40,60,.22);' +
      'font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;' +
      'text-align:left;}' +
    '#nvb b{color:#16202a;}' +
    '#nvb-actions{display:flex;align-items:center;gap:10px;flex-shrink:0;}' +
    '#nvb-open{display:inline-block;padding:7px 14px;border-radius:8px;' +
      'background:#2d70b3;color:#fff;font-weight:600;text-decoration:none;white-space:nowrap;}' +
    '#nvb-open:hover{background:#255f99;}' +
    '#nvb-open:focus,#nvb-later:focus{outline:2px solid #2d70b3;outline-offset:2px;}' +
    '#nvb-later{padding:7px 10px;border:0;background:none;color:#5a6b7b;' +
      'font:inherit;cursor:pointer;white-space:nowrap;}' +
    '#nvb-later:hover{color:#26313b;text-decoration:underline;}' +
    '@media (max-width:560px){#nvb{flex-direction:column;align-items:stretch;' +
      'gap:10px;bottom:10px;}#nvb-actions{justify-content:flex-end;}}'
  ));

  var banner = document.createElement('div');
  banner.id = 'nvb';
  banner.setAttribute('role', 'region');
  banner.setAttribute('aria-label', 'A new version of Equation.io is available');

  var text = document.createElement('div');
  text.id = 'nvb-text';
  text.innerHTML = '<b>A new version of this grapher is available at equation.io.</b> ' +
    'This classic version is no longer updated.';

  var actions = document.createElement('div');
  actions.id = 'nvb-actions';

  var open = document.createElement('a');
  open.id = 'nvb-open';
  open.href = NEW_URL;
  open.appendChild(document.createTextNode('Open the new version'));

  var later = document.createElement('button');
  later.id = 'nvb-later';
  later.type = 'button';
  later.appendChild(document.createTextNode('Not now'));

  later.addEventListener('click', function () {
    try {
      localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_DAYS * 864e5));
    } catch (e) { /* storage blocked: hide for this page view only */ }
    if (banner.parentNode) banner.parentNode.removeChild(banner);
  });

  actions.appendChild(open);
  actions.appendChild(later);
  banner.appendChild(text);
  banner.appendChild(actions);

  function insert() {
    document.head.appendChild(style);
    document.body.appendChild(banner);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', insert);
  } else {
    insert();
  }
})();
