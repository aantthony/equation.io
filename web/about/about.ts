import { landingForGroup } from '../../lib/landings.ts';
import { initTheme, onThemeChange, theme, toggleTheme } from '../theme.ts';
import { startHeroField } from './hero-field.ts';
import { SHOWCASE, hashUrl, type ShowcaseItem } from './showcase.ts';

// Bundle the shots through Vite so each ships as assets/<slug>-<hash>.png:
// content-hashed filenames can cache forever and bust automatically on change.
// (hero.png stays in public/ — it's the og:image and needs a stable URL.)
const shots = import.meta.glob<string>('../shots/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
});
function shotUrl(slug: string): string {
  const url = shots[`../shots/${slug}.png`];
  if (!url) throw new Error(`no bundled shot for "${slug}" (expected web/shots/${slug}.png)`);
  return url;
}
function item(slug: string): ShowcaseItem {
  const found = SHOWCASE.find(i => i.slug === slug);
  if (!found) throw new Error(`no showcase item "${slug}"`);
  return found;
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const pad = (n: number) => String(n).padStart(2, '0');
const anchor = (group: string) => group.toLowerCase().replace(/[^a-z0-9]+/g, '-');

// Hero: the backdrop is this gallery item, and the typed rows open it.
const orbit = item('orbiting-charge');
const typed = document.getElementById('typed') as HTMLAnchorElement;
typed.href = hashUrl(orbit.eqs);
const hero = startHeroField({
  canvas: document.getElementById('field') as HTMLCanvasElement,
  clock: document.getElementById('clock')!,
  typed,
  rows: orbit.eqs,
});

// Theme: shares the app's saved choice. theme.ts only tints #theme-color with
// the grapher's canvas color, so this page tints its own meta from --bg.
const themeToggle = document.getElementById('theme-toggle') as HTMLButtonElement;
const themeColor = document.querySelector('meta[name="theme-color"]');
onThemeChange(() => {
  const next = theme.dark ? 'light' : 'dark';
  themeToggle.textContent = theme.dark ? '☀' : '☾';
  themeToggle.setAttribute('aria-label', `Switch to ${next} mode`);
  themeToggle.title = `Switch to ${next} mode`;
  themeColor?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  hero.restyle();
});
initTheme();
themeToggle.addEventListener('click', toggleTheme);

// Gallery, one numbered chapter per group.
const gallery = document.getElementById('gallery')!;
const chapters = document.getElementById('chapters')!;
const groups: string[] = [];
for (const it of SHOWCASE) if (!groups.includes(it.group)) groups.push(it.group);

groups.forEach((group, gi) => {
  const items = SHOWCASE.filter(i => i.group === group);
  const counter = `${pad(gi + 1)} / ${pad(groups.length)}`;

  const li = el('li');
  const link = el('a');
  link.href = `#${anchor(group)}`;
  link.append(el('span', 'num', pad(gi + 1)), el('span', 'name', group), el('span', 'count', String(items.length)));
  li.append(link);
  chapters.append(li);

  const section = el('section', 'group');
  section.id = anchor(group);
  const head = el('div', 'group-head');
  const title = el('div', 'group-title');
  title.append(el('span', 'counter', counter), el('h2', 'display small', group));
  head.append(title);
  const landing = landingForGroup(group);
  if (landing) {
    const a = el('a', 'more', landing.nav + ' →');
    a.href = landing.path;
    a.title = landing.title;
    head.append(a);
  }
  const grid = el('div', 'grid');
  for (const it of items) {
    const card = el('a', 'card');
    card.href = hashUrl(it.eqs);
    card.title = 'Open in the app';

    const frame = el('div', 'shot');
    const img = el('img');
    img.src = shotUrl(it.slug);
    img.alt = it.title;
    img.loading = 'lazy';
    img.width = 900;
    img.height = 600;
    frame.append(img);

    const body = el('div', 'card-body');
    body.append(el('h3', undefined, it.title), el('p', undefined, it.blurb), el('code', undefined, it.eqs.join(';  ')));

    card.append(frame, body);
    grid.append(card);
  }
  section.append(head, grid);
  gallery.append(section);
});
