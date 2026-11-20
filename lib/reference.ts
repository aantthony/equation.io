/**
 * The Apple app's language reference (docs/reference/), read into one
 * structure that its outputs are generated from: the app's lookup tools
 * (list_kinds, kind_examples, function_doc, shape; lib/assistant-tools.ts),
 * and the whole reference as one file (llmsTxt), which the app's evals search
 * (read_syntax) or put in context. The site's own reference,
 * web/public/llms.txt, is written by hand and is not generated from here.
 *
 * The source is Markdown, a page per file, each opening with `key: value`
 * front matter between `---` lines:
 *
 * - `index.md`: the site's blurb (a `>` paragraph), the introduction to the
 *   kinds, and the kinds by group, a `## Group` heading over `- kind` lines.
 *   A group marked `(brief)` is one list_kinds names without forms.
 * - `kinds/<slug>.md`: one render kind (`kind:`, as KIND_MEANINGS names it),
 *   with its `title`, smallest `form` and `short` meaning (list_kinds' line).
 *   The text before the first heading says what it draws; then any of
 *   `## Forms`, `## Examples`, `## Pitfalls`, `## Details`, in that order.
 *   An example is a bullet, its name before its rows:
 *   `- Unit cube: \`(interval(0, 1), interval(0, 1), interval(0, 1))\``, the
 *   rows separated by `;`, optionally followed by ` — a note`. Its last row
 *   draws the page's kind (reference.test.ts analyzes every one).
 * - `guide/<slug>.md`: a page about the language in general (`title`), or
 *   about links and the MCP server; `site: no` or `llms: no` leaves it out of
 *   one output.
 * - `functions.md`: notes on built-in functions, a `## name` heading each,
 *   added to their signatures (lib/syntax-help.ts).
 * - `shapes.md`: named curves and surfaces (the shape tool), a `## Name`
 *   heading each, then an `Also: alias, alias.` line, a paragraph on what it
 *   is, its forms, and an optional `Pitfall: …` paragraph. A form is a
 *   bullet, `- kind: \`rows\``, optionally ` — a note`, over nested bullets
 *   naming each parameter (`` - `a`: what it sets ``) and one instance
 *   (`- e.g. a = 3, c = 2: \`rows\` — a note`, its parameters' values first).
 *   reference.test.ts draws every form (its parameters set) and instance as
 *   its kind.
 *
 * Text is Markdown's common core: paragraphs, `-` lists (two spaces indent a
 * continuation or a nested list), code indented four spaces, `inline code`,
 * **bold**, and links. A link to `#kind` names another kind's page.
 */
import type { PublicKind } from './math-object.ts';
import { splitStatements } from './statements.ts';
import { builtinHelp, builtinNames } from './syntax-help.ts';

export interface ReferenceExample {
  name: string;
  rows: string[];
  note?: string;
}

export interface KindPage {
  kind: PublicKind;
  slug: string;
  title: string;
  /** The smallest form, rows separated by `;`. */
  form: string;
  /** What it draws, in a few words. */
  short: string;
  /** What it draws, as the page opens. */
  intro: string;
  forms?: string;
  examples: ReferenceExample[];
  pitfalls?: string;
  details?: string;
}

export interface GuidePage {
  slug: string;
  title: string;
  /** One line for the docs index. */
  summary: string;
  body: string;
  site: boolean;
  llms: boolean;
}

export interface KindGroup {
  name: string;
  /** list_kinds names these kinds without their forms. */
  brief: boolean;
  kinds: PublicKind[];
}

/** One form of a named shape: its rows in named parameters, and an instance with numbers. */
export interface ShapeForm {
  kind: PublicKind;
  rows: string[];
  note?: string;
  /** Each parameter's name and what it sets. */
  params: [name: string, meaning: string][];
  /** The instance: its parameters' values (`a = 3, c = 2`), its rows and a note. */
  example: { values?: string; rows: string[]; note?: string };
}

/** A named curve or surface (shapes.md). */
export interface Shape {
  name: string;
  slug: string;
  aliases: string[];
  /** What it is, in a sentence or two. */
  intro: string;
  forms: ShapeForm[];
  pitfall?: string;
}

export interface Reference {
  blurb: string;
  intro: string;
  groups: KindGroup[];
  kinds: Map<PublicKind, KindPage>;
  guides: Map<string, GuidePage>;
  functionsIntro: string;
  /** Written notes on built-in functions, by name. */
  notes: Map<string, string>;
  shapesPage: { title: string; summary: string; intro: string };
  shapes: Shape[];
}

const KIND_SECTIONS = ['Forms', 'Examples', 'Pitfalls', 'Details'] as const;

/** A page's front matter and body. */
function frontMatter(path: string, text: string): { meta: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error(`${path}: no front matter`);
  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`${path}: front matter line ${JSON.stringify(line)}`);
    meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: text.slice(match[0].length).trim() };
}

/** The text before the first `## ` heading, then each heading's section. */
function sections(body: string): { intro: string; sections: [heading: string, text: string][] } {
  const parts = body.split(/^## (.+)$/m);
  const out: [string, string][] = [];
  for (let k = 1; k < parts.length; k += 2) out.push([parts[k].trim(), parts[k + 1].trim()]);
  return { intro: parts[0].trim(), sections: out };
}

/** Top-level `- ` items of a list, each with its continuation lines joined. */
function listItems(text: string): string[] {
  const items: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('- ')) items.push(line.slice(2));
    else if (line.trim() && items.length) items[items.length - 1] += ' ' + line.trim();
  }
  return items;
}

const EXAMPLE = /^([^`:]+): `([^`]+)`(?:\s+—\s+(.+))?$/;

const rowsOf = (text: string) =>
  splitStatements(text)
    .map(s => s.trim())
    .filter(Boolean);

const slugOf = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const FORM = /^- (\w+): `([^`]+)`(?:\s+—\s+(.+))?$/;
const PARAM = /^ {2}- `(\w+)`: (.+)$/;
const INSTANCE = /^ {2}- e\.g\. (?:([^`]+): )?`([^`]+)`(?:\s+—\s+(.+))?$/;

/** shapes.md's `## Name` sections, each a shape. */
function shapes(text: string): Shape[] {
  return sections(text).sections.map(([name, body]) => {
    const where = `shapes.md: ${name}`;
    const shape: Shape = { name, slug: slugOf(name), aliases: [], intro: '', forms: [] };
    const intro: string[] = [];
    for (const block of body.split(/\n\s*\n/)) {
      const flat = block.replace(/\s*\n\s*/g, ' ').trim();
      if (flat.startsWith('Also: ')) shape.aliases = flat.slice(6).replace(/\.$/, '').split(/,\s*/);
      else if (flat.startsWith('Pitfall: ')) shape.pitfall = flat.slice(9);
      else if (!block.startsWith('- ')) intro.push(flat);
      else
        for (const line of block.split('\n')) {
          const form = FORM.exec(line);
          const param = PARAM.exec(line);
          const instance = INSTANCE.exec(line);
          const last = shape.forms.at(-1);
          if (form)
            shape.forms.push({
              kind: form[1] as PublicKind,
              rows: rowsOf(form[2]),
              ...(form[3] ? { note: form[3] } : {}),
              params: [],
              example: { rows: [] },
            });
          else if (instance && last && !last.example.rows.length)
            last.example = {
              ...(instance[1] ? { values: instance[1] } : {}),
              rows: rowsOf(instance[2]),
              ...(instance[3] ? { note: instance[3] } : {}),
            };
          else if (param && last && !last.example.rows.length) last.params.push([param[1], param[2]]);
          else throw new Error(`${where}: ${JSON.stringify(line)} is not a form, a parameter or an e.g.`);
        }
    }
    shape.intro = intro.join('\n\n');
    if (!shape.intro || !shape.forms.length) throw new Error(`${where}: needs a paragraph and a form`);
    for (const form of shape.forms) if (!form.example.rows.length) throw new Error(`${where}: a form with no e.g.`);
    return shape;
  });
}

function examples(path: string, text: string): ReferenceExample[] {
  return listItems(text).map(item => {
    const match = EXAMPLE.exec(item);
    if (!match) throw new Error(`${path}: example ${JSON.stringify(item)} is not "- Name: \`rows\`"`);
    const rows = splitStatements(match[2])
      .map(s => s.trim())
      .filter(Boolean);
    return { name: match[1].trim(), rows, ...(match[3] ? { note: match[3].trim() } : {}) };
  });
}

/** Reads the reference from its files, by path relative to docs/reference/. */
export function parseReference(files: Record<string, string>): Reference {
  const index = files['index.md'];
  if (!index) throw new Error('index.md is missing');
  const { body } = frontMatter('index.md', index);
  const top = sections(body);
  const blurb = /^((?:> .*\n?)+)/m.exec(top.intro)?.[1] ?? '';
  const groups: KindGroup[] = top.sections.map(([heading, text]) => ({
    name: heading.replace(/\s*\(brief\)$/, ''),
    brief: heading.endsWith('(brief)'),
    kinds: listItems(text).map(k => k.trim() as PublicKind),
  }));

  const kinds = new Map<PublicKind, KindPage>();
  const guides = new Map<string, GuidePage>();
  for (const [path, text] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const slug = /([^/]+)\.md$/.exec(path)?.[1] ?? path;
    if (path.startsWith('kinds/')) {
      const { meta, body } = frontMatter(path, text);
      const { intro, sections: parts } = sections(body);
      const named = new Map(parts);
      const order = parts.map(([h]) => KIND_SECTIONS.indexOf(h as (typeof KIND_SECTIONS)[number]));
      if (order.some((k, i) => k < 0 || (i > 0 && k <= order[i - 1])))
        throw new Error(`${path}: sections must be some of ${KIND_SECTIONS.join(', ')}, in that order`);
      for (const key of ['kind', 'title', 'form', 'short']) if (!meta[key]) throw new Error(`${path}: no ${key}`);
      const kind = meta.kind as PublicKind;
      if (kinds.has(kind)) throw new Error(`${path}: a second page for ${kind}`);
      kinds.set(kind, {
        kind,
        slug,
        title: meta.title,
        form: meta.form,
        short: meta.short,
        intro,
        forms: named.get('Forms'),
        examples: examples(path, named.get('Examples') ?? ''),
        pitfalls: named.get('Pitfalls'),
        details: named.get('Details'),
      });
    } else if (path.startsWith('guide/')) {
      const { meta, body } = frontMatter(path, text);
      guides.set(slug, {
        slug,
        title: meta.title,
        summary: meta.summary ?? '',
        body,
        site: meta.site !== 'no',
        llms: meta.llms !== 'no',
      });
    }
  }

  const functions = files['functions.md'] ? frontMatter('functions.md', files['functions.md']).body : '';
  const fn = sections(functions);
  const shapesFile = files['shapes.md'] ? frontMatter('shapes.md', files['shapes.md']) : undefined;
  return {
    blurb,
    intro: top.intro.slice(blurb.length).trim(),
    groups,
    kinds,
    guides,
    functionsIntro: fn.intro,
    notes: new Map(fn.sections),
    shapesPage: {
      title: shapesFile?.meta.title ?? 'Named shapes',
      summary: shapesFile?.meta.summary ?? '',
      intro: shapesFile ? sections(shapesFile.body).intro : '',
    },
    shapes: shapesFile ? shapes(shapesFile.body) : [],
  };
}

/** Every built-in function, its signature and description (lib/syntax-help.ts) and the reference's note. */
export function functionEntries(ref: Reference) {
  const seen = new Set<string>();
  return builtinNames()
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b))
    .flatMap(name => {
      const help = builtinHelp(name);
      // Gamma the law reads as gamma the function: one entry.
      if (!help || seen.has(help.signature)) return [];
      seen.add(help.signature);
      return [{ name, ...help, note: ref.notes.get(name) }];
    });
}

// MARK: llms.txt

/** Text for a plain-text reader: a link to a kind reads as its words. */
const plain = (md: string) => md.replace(/\[([^\]]+)\]\((?:#[\w-]+|\/docs\/[\w-/]*)\)/g, '$1');

/** Guide pages in the order llms.txt prints them; ROW_TYPES, FUNCTIONS and SHAPES mark the generated sections. */
export const LLMS_ORDER = [
  'assistants',
  'links',
  'share-links',
  'mcp',
  'syntax',
  'variables',
  'ROW_TYPES',
  'definitions',
  'regression',
  'viewport',
  'panels',
  'grid',
  'FUNCTIONS',
  'SHAPES',
  'more',
] as const;

/** A kind's name in running text: its title, lower case but for acronyms ("motion trail", "RGB colour field"). */
export const kindName = (title: string) => title.replace(/^[A-Z](?![A-Z])/, c => c.toLowerCase());

/**
 * Every kind by name, a line per group but the groups in `skip`, for the
 * app's instructions (lib/assistant-instructions.ts, whose kind chart covers
 * those): a model that knows the names asks kind_examples for one, where a
 * request alone wouldn't send it to list_kinds.
 */
export const kindNames = (ref: Reference, skip: readonly string[] = []) =>
  ref.groups
    .filter(g => !skip.includes(g.name))
    .map(g => `- ${g.name}: ${g.kinds.map(k => kindName(ref.kinds.get(k)!.title)).join(', ')}`)
    .join('\n');

/** One kind's line in an index: its name, kind, smallest form and what it draws. */
const kindLine = (page: KindPage) => `- ${page.title} (\`${page.kind}\`): \`${page.form}\` — ${page.short}`;

function kindSection(page: KindPage): string {
  const parts = [`### ${page.title} (\`${page.kind}\`)`, plain(page.intro)];
  if (page.forms) parts.push(`Forms:\n\n${plain(page.forms)}`);
  if (page.examples.length)
    parts.push(
      'Examples:\n\n' +
        page.examples
          .map(e => `- ${e.name}: \`${e.rows.join('; ')}\`${e.note ? ` — ${plain(e.note)}` : ''}`)
          .join('\n'),
    );
  if (page.pitfalls) parts.push(`Pitfalls:\n\n${plain(page.pitfalls)}`);
  if (page.details) parts.push(`Details:\n\n${plain(page.details)}`);
  return parts.join('\n\n');
}

/** Named shapes, as shapes.md writes them, a `###` heading each. */
function shapesSection(ref: Reference): string {
  const shape = (s: Shape) => {
    const forms = s.forms.map(f =>
      [
        `- ${f.kind}: \`${f.rows.join('; ')}\`${f.note ? ` — ${f.note}` : ''}`,
        ...f.params.map(([name, meaning]) => `  - \`${name}\`: ${meaning}`),
        `  - e.g. ${f.example.values ? `${f.example.values}: ` : ''}\`${f.example.rows.join('; ')}\`${f.example.note ? ` — ${f.example.note}` : ''}`,
      ].join('\n'),
    );
    return [
      `### ${s.name}`,
      ...(s.aliases.length ? [`Also: ${s.aliases.join(', ')}.`] : []),
      plain(s.intro),
      forms.join('\n'),
      ...(s.pitfall ? [`Pitfall: ${plain(s.pitfall)}`] : []),
    ].join('\n\n');
  };
  return [`## ${ref.shapesPage.title}`, plain(ref.shapesPage.intro), ...ref.shapes.map(shape)].join('\n\n');
}

/** The whole reference as one file, in the layout of the site's llms.txt: what the evals' read_syntax searches. */
export function llmsTxt(ref: Reference): string {
  const out = [`# equation.io\n\n${ref.blurb.trim()}`];
  const listed = new Set<string>();
  for (const key of LLMS_ORDER) {
    if (key === 'ROW_TYPES') {
      const index = ref.groups.map(g => `${g.name}:\n\n${g.kinds.map(k => kindLine(ref.kinds.get(k)!)).join('\n')}`);
      out.push(`## Row types\n\n${plain(ref.intro)}\n\n${index.join('\n\n')}`);
      for (const group of ref.groups) for (const kind of group.kinds) out.push(kindSection(ref.kinds.get(kind)!));
    } else if (key === 'FUNCTIONS') {
      // Signatures only, to keep the file short: the sections above say what each does.
      const lines = functionEntries(ref).map(f => `- \`${f.signature}\``);
      out.push(`## Functions\n\n${plain(ref.functionsIntro)}\n\n${lines.join('\n')}`);
    } else if (key === 'SHAPES') {
      if (ref.shapes.length) out.push(shapesSection(ref));
    } else {
      const page = ref.guides.get(key);
      if (!page) throw new Error(`guide/${key}.md is missing`);
      listed.add(key);
      if (page.llms) out.push(`## ${page.title}\n\n${plain(page.body)}`);
    }
  }
  const stray = [...ref.guides.keys()].filter(k => !listed.has(k) && ref.guides.get(k)!.llms);
  if (stray.length) throw new Error(`guide pages llms.txt doesn't place: ${stray.join(', ')} (LLMS_ORDER)`);
  return out.join('\n\n') + '\n';
}

// MARK: the assistant's lookups

/** An example the assistant is shown: its rows, then what it is. */
export interface LabelledRows {
  label: string;
  rows: string[];
}

/**
 * What the Apple app's lookups answer from (lib/assistant-tools.ts),
 * bundled as assistant.json by `pnpm app:data`: the kinds by group with their
 * smallest forms, worked examples by kind and by function, notes on
 * functions, and named shapes.
 */
export interface AssistantData {
  groups: { name: string; brief: boolean; kinds: { kind: PublicKind; title: string; form: string; short: string }[] }[];
  kinds: Record<string, LabelledRows[]>;
  functions: Record<string, LabelledRows[]>;
  notes: Record<string, string>;
  /** Named curves and surfaces (shapes.md), for the shape tool. */
  shapes: Omit<Shape, 'slug'>[];
}

/**
 * The assistant's data: the reference's kinds, forms and notes, and for each
 * kind its own examples, written to show one shape each (the first `per`),
 * then examples from the menu (`menu`, lib/assistant-tools.ts examplesIndex)
 * to make up `per`.
 * Functions keep the menu's examples: those that call them; shapes are the
 * reference's.
 */
export function assistantData(
  ref: Reference,
  menu: { kinds: Record<string, LabelledRows[]>; functions: Record<string, LabelledRows[]> },
  per = 3,
): AssistantData {
  const kinds: Record<string, LabelledRows[]> = {};
  for (const group of ref.groups)
    for (const kind of group.kinds) {
      const own = ref.kinds.get(kind)!.examples.map(e => ({ label: e.name.toLowerCase(), rows: e.rows }));
      const same = (a: LabelledRows, b: LabelledRows) => a.rows.join(';') === b.rows.join(';');
      const more = (menu.kinds[kind] ?? []).filter(m => !own.some(o => same(o, m)));
      kinds[kind] = [...own, ...more].slice(0, per);
    }
  return {
    groups: ref.groups.map(g => ({
      name: g.name,
      brief: g.brief,
      kinds: g.kinds.map(kind => {
        const { title, form, short } = ref.kinds.get(kind)!;
        return { kind, title: kindName(title), form, short };
      }),
    })),
    kinds,
    functions: menu.functions,
    notes: Object.fromEntries([...ref.notes].map(([name, note]) => [name, plain(note).replace(/\s+/g, ' ')])),
    shapes: ref.shapes.map(({ slug: _, ...shape }) => shape),
  };
}
