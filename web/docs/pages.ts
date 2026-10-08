/**
 * The site's docs pages (equation.io/docs/…), written from the language
 * reference (docs/reference, read by lib/reference.ts) when the site is built
 * or served (vite.config.ts docsPages). Plain HTML: docs.css styles it, and
 * docs.ts only adds the theme toggle.
 *
 *   /docs/                the kinds by group, and the other pages
 *   /docs/<kind slug>/    one kind: what it draws, forms, examples, pitfalls
 *   /docs/<guide slug>/   the language in general, links, the MCP server
 *   /docs/functions/      every built-in function
 *   /docs/shapes/         named curves and surfaces, each as rows to adapt
 */
import { encodePayload } from '../../lib/link.ts';
import { type KindPage, type Reference, type Shape, functionEntries, kindName } from '../../lib/reference.ts';
import { splitStatements } from '../../lib/statements.ts';

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A page's path under the site, by its slug. */
export const docsPath = (slug?: string) => (slug ? `/docs/${slug}/` : '/docs/');

/** Inline Markdown: `code`, **bold** and links (a link to `#kind` goes to that kind's page). */
function inline(text: string, ref: Reference): string {
  // Code first, held aside, so brackets in it (`p[1](10..100)`) are never a link.
  const code: string[] = [];
  const held = text.replace(/`([^`]+)`/g, (_, c: string) => `\0${code.push(c) - 1}\0`);
  const restore = (html: string) => html.replace(/\0(\d+)\0/g, (_, k: string) => `<code>${escape(code[+k])}</code>`);
  const plain = (t: string) => escape(t).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const links = (t: string): string => {
    // A link's target runs to the bracket that balances its `(`: the graph links hold brackets of their own.
    const link = /\[([^\]]+)\]\(/.exec(t);
    if (!link) return plain(t);
    let depth = 1;
    let end = link.index + link[0].length;
    for (; end < t.length && depth; end++) depth += t[end] === '(' ? 1 : t[end] === ')' ? -1 : 0;
    if (depth) return plain(t);
    const href = t.slice(link.index + link[0].length, end - 1);
    const kind = href.startsWith('#') ? ref.kinds.get(href.slice(1) as never) : undefined;
    const target = kind ? docsPath(kind.slug) : href;
    return `${plain(t.slice(0, link.index))}<a href="${escape(target)}">${plain(link[1])}</a>${links(t.slice(end))}`;
  };
  return restore(links(held));
}

/** A Markdown list's items, each with its own nested list (lines indented two more spaces). */
function list(lines: string[], ref: Reference): string {
  const items: string[][] = [];
  for (const line of lines) {
    if (line.startsWith('- ')) items.push([line.slice(2)]);
    else items.at(-1)?.push(line.replace(/^ {2}/, ''));
  }
  const item = (body: string[]) => {
    // Text, then any nested list, then text again: each run joined into one.
    const out: string[] = [];
    let text: string[] = [];
    let nested: string[] = [];
    const flushText = () => {
      if (text.length) out.push(inline(text.join(' '), ref));
      text = [];
    };
    const flushNested = () => {
      if (nested.length) out.push(list(nested, ref));
      nested = [];
    };
    for (const line of body) {
      if (line.startsWith('- ') || (nested.length && line.startsWith('  '))) {
        flushText();
        nested.push(line);
      } else {
        flushNested();
        text.push(line.trim());
      }
    }
    flushText();
    flushNested();
    return `<li>${out.join('\n')}</li>`;
  };
  return `<ul>\n${items.map(item).join('\n')}\n</ul>`;
}

/** Block Markdown: paragraphs, lists, quotes, code indented four spaces and `###` headings. */
export function markdown(md: string, ref: Reference): string {
  const blocks: string[] = [];
  const lines = md.split('\n');
  for (let k = 0; k < lines.length;) {
    const line = lines[k];
    if (!line.trim()) {
      k++;
      continue;
    }
    const run = (test: (l: string) => boolean) => {
      const out: string[] = [];
      while (k < lines.length && test(lines[k])) out.push(lines[k++]);
      return out;
    };
    if (line.startsWith('    ')) {
      const code = run(l => l.startsWith('    ') || !l.trim()).map(l => l.slice(4));
      while (code.at(-1) === '') code.pop();
      blocks.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
    } else if (line.startsWith('### ')) {
      blocks.push(`<h3>${inline(line.slice(4), ref)}</h3>`);
      k++;
    } else if (line.startsWith('- ')) {
      blocks.push(
        list(
          run(l => !!l.trim()),
          ref,
        ),
      );
    } else if (line.startsWith('> ')) {
      blocks.push(
        `<blockquote><p>${inline(
          run(l => l.startsWith('> '))
            .map(l => l.slice(2))
            .join(' '),
          ref,
        )}</p></blockquote>`,
      );
    } else {
      blocks.push(`<p>${inline(run(l => !!l.trim() && !l.startsWith('- ')).join(' '), ref)}</p>`);
    }
  }
  return blocks.join('\n');
}

/** Rows that read a data file only draw where that file was dropped: no link for them. */
const needsData = (rows: string[]) => rows.some(r => /\bopen\s*\(/.test(r));

/** Rows as a block of code, a row a line, with a link that opens them in the calculator. */
function rowsBlock(rows: string[], what: string): string {
  const code = `<pre><code>${rows.map(escape).join('\n')}</code></pre>`;
  const open = needsData(rows)
    ? '<p class="open muted">Needs a data file dropped onto the graph.</p>'
    : `<p class="open"><a href="/#${encodePayload(rows)}" aria-label="Open ${escape(what)} in the calculator">Open in the calculator →</a></p>`;
  return code + open;
}

const kindNav = (ref: Reference, current?: string) =>
  ref.groups
    .map(
      g => `<li><span class="group">${escape(g.name)}</span>
<ul>${g.kinds
        .map(kind => {
          const page = ref.kinds.get(kind)!;
          return `<li><a href="${docsPath(page.slug)}"${page.slug === current ? ' aria-current="page"' : ''}>${escape(page.title)}</a></li>`;
        })
        .join('')}</ul></li>`,
    )
    .join('\n');

const guideNav = (ref: Reference, current?: string) =>
  [
    ...ref.guides.values(),
    { slug: 'functions', title: 'Functions', site: true },
    { slug: 'shapes', title: ref.shapesPage.title, site: ref.shapes.length > 0 },
  ]
    .filter(g => g.site)
    .map(
      g =>
        `<li><a href="${docsPath(g.slug)}"${g.slug === current ? ' aria-current="page"' : ''}>${escape(g.title)}</a></li>`,
    )
    .join('');

/** The shell every page shares: header, the contents (a sidebar, folded on a phone), the page and footer. */
function shell(ref: Reference, page: { slug?: string; title: string; description: string; body: string }): string {
  const title = page.slug ? `${page.title} — Equation.io reference` : 'Reference — Equation.io';
  const canonical = `https://equation.io${docsPath(page.slug)}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(title)}</title>
  <meta name="description" content="${escape(page.description)}">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#fbfaf7">
  <link rel="canonical" href="${canonical}">
  <link rel="alternate" type="text/plain" href="/llms.txt" title="LLM instructions">
  <link rel="icon" type="image/svg+xml" href="/icon.svg">
  <link rel="stylesheet" href="/docs/docs.css">
  <!-- Follow the app's saved theme before first paint; Vite hashes the asset. -->
  <script src="/theme.js?no-inline"></script>
  <script type="module" src="/docs/docs.ts"></script>
</head>
<body>
  <header>
    <a class="brand" href="/">Equation<span>.io</span></a>
    <nav aria-label="Site">
      <a href="/docs/">Reference</a>
      <a href="/about/">About</a>
      <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Toggle dark mode" title="Toggle dark mode">☾</button>
      <a class="cta" href="/">Calculator</a>
    </nav>
  </header>
  <div class="docs">
    <details class="contents" id="contents">
      <summary>Contents</summary>
      <nav aria-label="Reference">
        <p class="nav-title"><a href="/docs/">Reference</a></p>
        <ul class="kinds">
${kindNav(ref, page.slug)}
        </ul>
        <p class="nav-title">The language</p>
        <ul class="guides">${guideNav(ref, page.slug)}</ul>
      </nav>
    </details>
    <main>
${page.body}
    </main>
  </div>
  <footer><span>Equation.io &copy; 2026 · <a href="https://github.com/aantthony/equation.io" rel="noopener">open source (MIT)</a></span><span><a href="/llms.txt">llms.txt</a> · <a href="/privacy/">Privacy</a> · <a href="/terms/">Terms</a></span></footer>
</body>
</html>
`;
}

function kindBody(ref: Reference, page: KindPage): string {
  const group = ref.groups.find(g => g.kinds.includes(page.kind))!;
  const order = ref.groups.flatMap(g => g.kinds);
  const at = order.indexOf(page.kind);
  const neighbour = (kind: (typeof order)[number] | undefined, rel: string) => {
    const other = kind && ref.kinds.get(kind);
    return other ? `<a rel="${rel}" href="${docsPath(other.slug)}">${escape(other.title)}</a>` : '<span></span>';
  };
  const section = (heading: string, html: string) => `<section>\n<h2>${heading}</h2>\n${html}\n</section>`;
  const parts = [
    `<p class="crumb"><a href="/docs/">Reference</a> · ${escape(group.name)}</p>`,
    `<h1>${escape(page.title)}</h1>`,
    `<p class="kind">kind <code>${escape(page.kind)}</code></p>`,
    `<div class="lede">${markdown(page.intro, ref)}</div>`,
    `<div class="smallest"><p class="label">Smallest form</p>${rowsBlock(
      splitStatements(page.form).map(s => s.trim()),
      'the smallest form',
    )}</div>`,
  ];
  if (page.forms) parts.push(section('Forms', markdown(page.forms, ref)));
  parts.push(
    section(
      'Examples',
      `<ol class="examples">${page.examples
        .map(
          e =>
            `<li id="${e.name
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-|-$/g, '')}"><h3>${escape(e.name)}</h3>${
              e.note ? `<p class="note">${inline(e.note, ref)}</p>` : ''
            }${rowsBlock(e.rows, e.name)}</li>`,
        )
        .join('\n')}</ol>`,
    ),
  );
  if (page.pitfalls) parts.push(section('Pitfalls', markdown(page.pitfalls, ref)));
  if (page.details) parts.push(section('Details', markdown(page.details, ref)));
  parts.push(
    `<nav class="pager" aria-label="Next and previous">${neighbour(order[at - 1], 'prev')}${neighbour(order[at + 1], 'next')}</nav>`,
  );
  return parts.join('\n');
}

function indexBody(ref: Reference): string {
  const blurb = ref.blurb.replace(/^> ?/gm, '').replace(/\s+/g, ' ').trim();
  return [
    '<h1>Reference</h1>',
    `<p class="lede">${inline(blurb, ref)}</p>`,
    markdown(ref.intro, ref),
    ...ref.groups.map(
      g => `<section>
<h2>${escape(g.name)}</h2>
<ul class="cards">${g.kinds
        .map(kind => {
          const page = ref.kinds.get(kind)!;
          return `<li><a href="${docsPath(page.slug)}"><span class="title">${escape(page.title)}</span><span class="short">${escape(page.short)}</span><code>${escape(page.form)}</code></a></li>`;
        })
        .join('')}</ul>
</section>`,
    ),
    `<section>
<h2>The language</h2>
<ul class="cards guides">${[
      ...ref.guides.values(),
      {
        slug: 'functions',
        title: 'Functions',
        summary: 'Every built-in function, its signature and notes.',
        site: true,
      },
      { slug: 'shapes', title: ref.shapesPage.title, summary: ref.shapesPage.summary, site: ref.shapes.length > 0 },
    ]
      .filter(g => g.site)
      .map(
        g =>
          `<li><a href="${docsPath(g.slug)}"><span class="title">${escape(g.title)}</span><span class="short">${escape(g.summary)}</span></a></li>`,
      )
      .join('')}</ul>
</section>`,
  ].join('\n');
}

function functionsBody(ref: Reference): string {
  return [
    `<p class="crumb"><a href="/docs/">Reference</a></p>`,
    '<h1>Functions</h1>',
    markdown(ref.functionsIntro, ref),
    `<dl class="functions">${functionEntries(ref)
      .map(
        f =>
          `<div id="${escape(f.name)}"><dt><code>${escape(f.signature)}</code></dt><dd>${escape(f.description)}${
            f.note ? `<p class="note">${inline(f.note.replace(/\s+/g, ' '), ref)}</p>` : ''
          }</dd></div>`,
      )
      .join('\n')}</dl>`,
  ].join('\n');
}

/** A named shape: what it is, then each form, its parameters, and an instance to open. */
function shapeSection(ref: Reference, shape: Shape): string {
  const forms = shape.forms.map(form => {
    const kind = ref.kinds.get(form.kind)!;
    const kindLink = `<a href="${docsPath(kind.slug)}">${escape(kindName(kind.title))}</a> <code>${escape(form.kind)}</code>`;
    const params = form.params.length
      ? `<ul>${form.params.map(([name, meaning]) => `<li><code>${escape(name)}</code>: ${inline(meaning, ref)}</li>`).join('')}</ul>`
      : '';
    return `<li><p class="kind">${kindLink}${form.note ? ` — ${inline(form.note, ref)}` : ''}</p>
<pre><code>${form.rows.map(escape).join('\n')}</code></pre>${params}
<p class="label">For example${form.example.note ? ` — ${inline(form.example.note, ref)}` : ''}</p>${rowsBlock(
      form.example.rows,
      `${shape.name}, ${form.example.note ?? 'an example'}`,
    )}</li>`;
  });
  return `<section id="${shape.slug}">
<h2>${escape(shape.name)}</h2>
${shape.aliases.length ? `<p class="note">Also: ${shape.aliases.map(escape).join(', ')}.</p>` : ''}
${markdown(shape.intro, ref)}
<ol class="examples">${forms.join('\n')}</ol>
${shape.pitfall ? `<p class="note">Pitfall: ${inline(shape.pitfall, ref)}</p>` : ''}
</section>`;
}

function shapesBody(ref: Reference): string {
  return [
    `<p class="crumb"><a href="/docs/">Reference</a></p>`,
    `<h1>${escape(ref.shapesPage.title)}</h1>`,
    markdown(ref.shapesPage.intro, ref),
    `<p>${ref.shapes.map(s => `<a href="#${s.slug}">${escape(s.name)}</a>`).join(' · ')}</p>`,
    ...ref.shapes.map(s => shapeSection(ref, s)),
  ].join('\n');
}

/** Every docs page, by its path under web/ (`docs/index.html`, `docs/curve/index.html`, …). */
export function docsPages(ref: Reference): Map<string, string> {
  const pages = new Map<string, string>();
  pages.set(
    'docs/index.html',
    shell(ref, {
      title: 'Reference',
      description:
        "Equation.io's language reference: every kind of row it draws, with forms, examples and pitfalls, and the syntax, definitions and functions.",
      body: indexBody(ref),
    }),
  );
  for (const page of ref.kinds.values())
    pages.set(
      `docs/${page.slug}/index.html`,
      shell(ref, {
        slug: page.slug,
        title: page.title,
        description: `${page.title} in Equation.io: ${page.short}. Forms, worked examples and pitfalls.`,
        body: kindBody(ref, page),
      }),
    );
  for (const guide of ref.guides.values())
    if (guide.site)
      pages.set(
        `docs/${guide.slug}/index.html`,
        shell(ref, {
          slug: guide.slug,
          title: guide.title,
          description: guide.summary,
          body: `<p class="crumb"><a href="/docs/">Reference</a></p>\n<h1>${escape(guide.title)}</h1>\n${markdown(guide.body, ref)}`,
        }),
      );
  pages.set(
    'docs/functions/index.html',
    shell(ref, {
      slug: 'functions',
      title: 'Functions',
      description: "Every built-in function in Equation.io's language, with its signature and notes.",
      body: functionsBody(ref),
    }),
  );
  if (ref.shapes.length)
    pages.set(
      'docs/shapes/index.html',
      shell(ref, {
        slug: 'shapes',
        title: ref.shapesPage.title,
        description: `${ref.shapesPage.summary} Circles to tori, in Equation.io's language.`,
        body: shapesBody(ref),
      }),
    );
  return pages;
}
