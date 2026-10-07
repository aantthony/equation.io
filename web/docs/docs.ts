/**
 * The docs pages' script (pages.ts writes them): the theme toggle, sharing
 * the app's saved choice, and the contents folded on a phone, open beside
 * the page on a wider screen.
 */
import { initTheme, onThemeChange, theme, toggleTheme } from '../theme.ts';

const toggle = document.getElementById('theme-toggle') as HTMLButtonElement;
const themeColor = document.querySelector('meta[name="theme-color"]');
onThemeChange(() => {
  const next = theme.dark ? 'light' : 'dark';
  toggle.textContent = theme.dark ? '☀' : '☾';
  toggle.setAttribute('aria-label', `Switch to ${next} mode`);
  toggle.title = `Switch to ${next} mode`;
  themeColor?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
});
initTheme();
toggle.addEventListener('click', toggleTheme);

const contents = document.getElementById('contents') as HTMLDetailsElement;
const wide = matchMedia('(min-width: 960px)');
const fold = () => (contents.open = wide.matches);
fold();
wide.addEventListener('change', fold);
