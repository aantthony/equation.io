// Shared pre-paint theme initialization; external to comply with the CSP.
(function () {
  try {
    var s = localStorage.getItem('eq-theme');
    var dark = s === 'dark' ||
      (s !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.getElementById('theme-color')
      ?.setAttribute('content', dark ? '#171a1f' : '#ffffff');
  } catch (e) {}
})();
