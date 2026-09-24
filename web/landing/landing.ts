import { SHOWCASE, type ShowcaseItem } from '../about/showcase.ts';
import { LANDINGS, graphUrl, landingFromPath, landingJsonLd } from '../../lib/landings.ts';

const shots = import.meta.glob<string>('../shots/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
});
function shotUrl(slug: string): string {
  const url = shots[`../shots/${slug}.png`];
  if (!url) throw new Error(`no bundled shot for "${slug}"`);
  return url;
}

function bySlug(slug: string): ShowcaseItem {
  const item = SHOWCASE.find(i => i.slug === slug);
  if (!item) throw new Error(`showcase missing "${slug}"`);
  return item;
}

const page = landingFromPath(location.pathname);
if (!page) {
  location.replace('/about/');
  throw new Error('unknown landing');
}

// Landing-to-landing links would otherwise restore the previous scroll
// offset, so you arrive still looking at the cards and miss the new graph.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
window.scrollTo(0, 0);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

$('h1').textContent = page.h1;
$('lead').textContent = page.lead;
$('contrast').textContent = page.contrast;

const syntax = $('syntax');
for (const line of page.syntax) {
  const li = document.createElement('li');
  li.textContent = line;
  syntax.append(li);
}

const prompts = $('prompts');
for (const line of page.prompts) {
  const li = document.createElement('li');
  li.textContent = line;
  prompts.append(li);
}

const faq = $('faq');
for (const item of page.faq) {
  const dt = document.createElement('dt');
  dt.textContent = item.q;
  const dd = document.createElement('dd');
  dd.textContent = item.a;
  faq.append(dt, dd);
}

const also = $('also');
for (const other of LANDINGS.filter(l => l.slug !== page.slug)) {
  const a = document.createElement('a');
  a.href = other.path;
  a.textContent = other.title;
  also.append(a);
}

const ld = document.createElement('script');
ld.type = 'application/ld+json';
ld.textContent = JSON.stringify(landingJsonLd(page, location.origin));
document.head.append(ld);

const iframe = $<HTMLIFrameElement>('graph');
const edit = $<HTMLAnchorElement>('edit');
const share = $('share');
const related = $('related');

function show(item: ShowcaseItem, opts: { scroll?: boolean } = {}) {
  iframe.src = graphUrl(item.eqs);
  iframe.title = `Live graph: ${item.title}`;
  const href = graphUrl(item.eqs);
  edit.href = href;
  share.textContent = location.origin + href;
  for (const card of related.querySelectorAll<HTMLAnchorElement>('.card')) {
    card.classList.toggle('active', card.dataset.slug === item.slug);
  }
  if (opts.scroll) window.scrollTo({ top: 0, behavior: 'smooth' });
}

function cardFor(item: ShowcaseItem): HTMLAnchorElement {
  const card = document.createElement('a');
  card.className = 'card';
  card.dataset.slug = item.slug;
  card.href = graphUrl(item.eqs);
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

  card.addEventListener('click', e => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    show(item, { scroll: true });
  });
  return card;
}

const hero = bySlug(page.hero);
related.append(cardFor(hero));
for (const slug of page.related) related.append(cardFor(bySlug(slug)));
show(hero);
