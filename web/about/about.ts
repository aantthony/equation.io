import { landingForGroup } from '../../lib/landings.ts';
import { SHOWCASE, hashUrl } from './showcase.ts';

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

const gallery = document.getElementById('gallery')!;

const groups: string[] = [];
for (const item of SHOWCASE) if (!groups.includes(item.group)) groups.push(item.group);

for (const group of groups) {
  const section = document.createElement('section');
  section.className = 'group';
  const head = document.createElement('div');
  head.className = 'group-head';
  const h = document.createElement('h2');
  h.textContent = group;
  head.append(h);
  const landing = landingForGroup(group);
  if (landing) {
    const a = document.createElement('a');
    a.href = landing.path;
    a.textContent = landing.nav + ' →';
    a.title = landing.title;
    head.append(a);
  }
  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const item of SHOWCASE.filter(i => i.group === group)) {
    const card = document.createElement('a');
    card.className = 'card';
    card.href = hashUrl(item.eqs);
    card.title = 'Open in the app';

    const img = document.createElement('img');
    img.src = shotUrl(item.slug);
    img.alt = item.title;
    img.loading = 'lazy';
    img.width = 900;
    img.height = 600;

    const body = document.createElement('div');
    body.className = 'card-body';
    const h3 = document.createElement('h3');
    h3.textContent = item.title;
    const p = document.createElement('p');
    p.textContent = item.blurb;
    const code = document.createElement('code');
    code.textContent = item.eqs.join(';  ');
    body.append(h3, p, code);

    card.append(img, body);
    grid.append(card);
  }
  section.append(head, grid);
  gallery.append(section);
}
