// Shared pre-paint theme initialization; external to comply with the CSP.
(function () {
  // Window identity is safe to compare even with a cross-origin parent.
  if (window.self !== window.top && !document.documentElement.hasAttribute('data-mcp-app')) {
    document.documentElement.setAttribute('data-embed', '');
    document.documentElement.setAttribute('data-embed-boot', '');
  }
  try {
    var s = localStorage.getItem('eq-theme');
    var dark = s === 'dark' ||
      (s !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.getElementById('theme-color')
      ?.setAttribute('content', dark ? '#171a1f' : '#ffffff');
  } catch {}
})();
