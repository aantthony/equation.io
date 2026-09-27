/**
 * The examples popup: a grid of categories, each shown by one example's
 * screenshot, then a grid of that category's examples. A search field filters
 * either screen (at the top it finds categories and examples both), and the
 * arrows and Enter pick from the grid without leaving it. Loaded on first use
 * so the example list and its thumbnails stay out of the app's first download.
 */
import {
  EXAMPLES,
  type ExampleEntry,
  coverLabel,
  exampleShotPath,
  searchCategories,
  searchExamples,
} from './examples.ts';

// Bundled through Vite like the /about/ shots, so each ships as
// assets/<name>-<hash>.webp and can be cached forever. `pnpm shots:examples`
// renders them.
const shots = import.meta.glob<string>('./shots/examples/*/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
});

function shotImage(category: string, label: string): HTMLImageElement {
  const img = document.createElement('img');
  const url = shots[`./shots/examples/${exampleShotPath(category, label)}.webp`];
  // A missing shot is a CI failure (lib/examples.test.ts), not a broken menu.
  if (url) img.src = url;
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.width = 400;
  img.height = 300;
  return img;
}

let dialog: HTMLDialogElement | null = null;
/** The category on screen, or null for the categories and all-example search. */
let current: string | null = null;
/** The category last opened: preselected when the popup opens again. */
let lastCategory: string | null = null;
let pick: (text: string) => void = () => {};

interface Entry {
  el: HTMLElement;
  go: () => void;
}
/** The cards on screen, in order, and what choosing each one does. */
let entries: Entry[] = [];
/**
 * Every card built so far, by `cat:<category>` or `ex:<category>/<label>`.
 * A search reshuffles these rather than building new ones: a fresh <img>
 * decodes asynchronously and paints blank for a frame, even from cache, so
 * rebuilding on each keystroke made the whole grid flash.
 */
const built = new Map<string, Entry>();
function once(key: string, make: () => Entry): Entry {
  let entry = built.get(key);
  if (!entry) built.set(key, (entry = make()));
  return entry;
}
/** The index into `entries` that Enter chooses; arrows move it. */
let selected = 0;

const parts = () => {
  const d = dialog!;
  return {
    back: d.querySelector<HTMLElement>('.exd-back')!,
    title: d.querySelector('h2')!,
    search: d.querySelector<HTMLInputElement>('.exd-search')!,
    grid: d.querySelector<HTMLElement>('.exd-grid')!,
  };
};

/** Focus the search, except on touch screens, where it throws up the keyboard. */
function focusSearch() {
  if (matchMedia('(pointer: fine)').matches) parts().search.focus();
}

function build(): HTMLDialogElement {
  const d = document.createElement('dialog');
  d.id = 'examples-dialog';
  d.setAttribute('aria-labelledby', 'examples-title');
  d.innerHTML = `
    <header class="exd-head">
      <button type="button" class="exd-back" aria-label="All categories">‹</button>
      <h2 id="examples-title"></h2>
      <input type="search" class="exd-search" aria-controls="examples-grid"
        autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go">
      <button type="button" class="exd-close" aria-label="Close">×</button>
    </header>
    <div class="exd-grid" id="examples-grid" role="listbox" aria-label="Examples"></div>`;
  dialog = d;
  const { back, search, grid } = parts();
  back.addEventListener('click', () => {
    goBack();
    focusSearch();
  });
  search.addEventListener('input', render);
  search.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      select(Math.max(0, selected + (e.key === 'ArrowDown' ? 1 : -1)), true);
    } else if (e.key === 'Enter') {
      // Enter's default would carry on to the examples button, which has
      // focus again once the popup closes, and reopen it.
      e.preventDefault();
      entries[selected]?.go();
    } else if (e.key === 'Escape') {
      // Escape closes the popup outright; a search field's own Escape would
      // only clear it.
      e.preventDefault();
      d.close();
    }
  });
  // The pointer and the arrows share one highlight.
  grid.addEventListener('pointermove', e => {
    const card = (e.target as Element).closest('.exd-card');
    const i = entries.findIndex(x => x.el === card);
    if (i >= 0 && i !== selected) select(i, false);
  });
  d.querySelector('.exd-close')!.addEventListener('click', () => d.close());
  // A click on the backdrop lands on the dialog itself; its content never does.
  d.addEventListener('click', e => {
    if (e.target === d) d.close();
  });
  document.body.append(d);
  return d;
}

function card(img: HTMLImageElement, name: string, detail: string, title: string, go: () => void) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'exd-card';
  b.title = title;
  b.tabIndex = -1;
  b.setAttribute('role', 'option');
  const nameEl = document.createElement('span');
  nameEl.className = 'exd-name';
  nameEl.textContent = name;
  const detailEl = document.createElement('code');
  detailEl.textContent = detail;
  b.append(img, nameEl, detailEl);
  b.addEventListener('click', go);
  return b;
}

function exampleCard({ category, label, text, tags }: ExampleEntry): Entry {
  return once(`ex:${category}/${label}`, () => {
    const go = () => {
      dialog!.close();
      pick(text);
    };
    const b = card(shotImage(category, label), label, text, text, go);
    // Each tag searches for every example that carries it.
    const row = document.createElement('span');
    row.className = 'exd-tags';
    for (const tag of tags) {
      const chip = document.createElement('span');
      chip.className = 'exd-tag';
      chip.textContent = tag;
      chip.title = `All #${tag} examples`;
      chip.addEventListener('click', e => {
        e.stopPropagation();
        current = null;
        parts().search.value = `#${tag}`;
        render();
        focusSearch();
      });
      row.append(chip);
    }
    b.append(row);
    return { el: b, go };
  });
}

function categoryCard(category: string): Entry {
  return once(`cat:${category}`, () => {
    const list = EXAMPLES.find(([c]) => c === category)![1];
    const go = () => openCategory(category);
    const b = card(
      shotImage(category, coverLabel(category, list)),
      category,
      `${list.length} examples ›`,
      list.map(([l]) => l).join(', '),
      go,
    );
    b.classList.add('exd-cat');
    return { el: b, go };
  });
}

/** Move the highlight to entry `i` (clamped at the end), scrolling it into view if asked. */
function select(i: number, scroll: boolean) {
  const was = entries[selected]?.el;
  was?.classList.remove('selected');
  was?.removeAttribute('aria-selected');
  was?.removeAttribute('id');
  parts().search.removeAttribute('aria-activedescendant');
  // Below 0 only clears it.
  if (i < 0 || !entries.length) return;
  selected = Math.min(entries.length - 1, i);
  const el = entries[selected].el;
  el.classList.add('selected');
  el.setAttribute('aria-selected', 'true');
  el.id = 'examples-selected';
  parts().search.setAttribute('aria-activedescendant', el.id);
  if (scroll) el.scrollIntoView({ block: 'nearest' });
}

function openCategory(category: string) {
  current = lastCategory = category;
  parts().search.value = '';
  render();
  focusSearch();
}

/** Back to all categories, highlighting the one just left. */
function goBack() {
  const left = current;
  current = null;
  parts().search.value = '';
  render();
  select(
    Math.max(
      0,
      EXAMPLES.findIndex(([c]) => c === left),
    ),
    true,
  );
}

/**
 * Fill the grid for the current category and search: a category's examples
 * (filtered by the search), or at the top the categories, or for a search
 * the matching categories followed by the matching examples.
 */
function render() {
  const { back, title, search, grid } = parts();
  const query = search.value.trim();
  title.textContent = current ?? 'Examples';
  back.hidden = current === null;
  search.placeholder = current === null ? 'Search examples' : `Search ${current}`;
  search.setAttribute('aria-label', search.placeholder);
  // Cards are reused, so the old highlight has to come off by hand.
  select(-1, false);
  if (current !== null) {
    const category = current;
    const items = query
      ? searchExamples(query, category)
      : EXAMPLES.find(([c]) => c === category)![1].map(([label, text, tags]) => ({
          category,
          label,
          text,
          tags: tags.split(' '),
        }));
    entries = items.map(exampleCard);
  } else if (query) {
    entries = [...searchCategories(query).map(categoryCard), ...searchExamples(query).map(exampleCard)];
  } else {
    entries = EXAMPLES.map(([c]) => categoryCard(c));
  }
  if (entries.length) {
    grid.replaceChildren(...entries.map(e => e.el));
  } else {
    const empty = document.createElement('p');
    empty.className = 'exd-empty';
    empty.textContent = `No examples match “${query}”.`;
    grid.replaceChildren(empty);
  }
  grid.scrollTop = 0;
  selected = 0;
  select(0, false);
}

/**
 * Open the popup on all categories, the last one visited highlighted, or
 * close it if it is open (the Cmd/Ctrl+K shortcut toggles). `onPick`
 * receives the chosen example's rows.
 */
export function toggleExamplesMenu(onPick: (text: string) => void) {
  pick = onPick;
  if (dialog?.open) {
    dialog.close();
    return;
  }
  dialog ??= build();
  current = null;
  parts().search.value = '';
  render();
  dialog.showModal();
  select(
    Math.max(
      0,
      EXAMPLES.findIndex(([c]) => c === lastCategory),
    ),
    true,
  );
  focusSearch();
}
