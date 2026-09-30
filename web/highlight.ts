/**
 * Syntax colouring and hover cards for the equation editor.
 *
 * Colour is painted with the CSS Custom Highlight API: ranges over the
 * lines' existing text nodes, registered by class, so the contentEditable's
 * DOM — which the caret math, undo and copy all read — is never touched.
 * A mutation observer repaints after any edit, wherever it came from (typing,
 * a slider, a drag, undo); `repaint()` covers the definitions changing under
 * unchanged text, which recolours names.
 */
import type { Env } from '../lib/env.ts';
import { type NameInfo, type Span, type SpanClass, describeName, highlightSpans } from '../lib/highlight.ts';

const CLASSES: SpanClass[] = ['num', 'str', 'fn', 'const', 'coord', 'name', 'op'];
/** The name under a ⌘/Ctrl hover, underlined as a link to its definition. */
const LINK = 'eq-link';
const HOVER_DELAY_MS = 350;

interface Options {
  lines: () => HTMLElement[];
  lineText: (line: HTMLElement) => string;
  env: () => Env;
  /** Row that defines `name`, or -1 when no row does. */
  definitionRow: (name: string) => number;
  /** Move the caret to a row's definition and bring it into view. */
  goTo: (row: number, name: string) => void;
}

/** The DOM range of [start, end) in a line, across its text nodes (the note span included). */
function rangeIn(line: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let pos = 0;
  let started = false;
  let t: Node | null;
  while ((t = walker.nextNode())) {
    const len = t.textContent!.length;
    if (!started && start <= pos + len) {
      range.setStart(t, start - pos);
      started = true;
    }
    if (started && end <= pos + len) {
      range.setEnd(t, end - pos);
      return range;
    }
    pos += len;
  }
  return null;
}

export function initHighlight(editor: HTMLElement, options: Options) {
  const highlights = 'highlights' in CSS ? CSS.highlights : null;
  const sets = new Map(CLASSES.map(cls => [cls, new Highlight()]));
  const link = new Highlight();
  for (const [cls, h] of sets) highlights?.set(`eq-${cls}`, h);
  highlights?.set(LINK, link);
  /** Each line's spans as last painted, for hit-testing a hover. */
  const painted = new WeakMap<HTMLElement, { text: string; spans: Span[] }>();

  let frame = 0;
  function paint() {
    frame = 0;
    const env = options.env();
    for (const h of sets.values()) h.clear();
    for (const line of options.lines()) {
      const text = options.lineText(line);
      let spans: Span[];
      try {
        spans = highlightSpans(text, env);
      } catch {
        spans = []; // colour is never worth an exception in the editor
      }
      painted.set(line, { text, spans });
      if (!highlights) continue;
      for (const s of spans) {
        const r = rangeIn(line, s.start, s.end);
        if (r) sets.get(s.cls)!.add(r);
      }
    }
  }
  const repaint = () => {
    frame ||= requestAnimationFrame(paint);
  };
  new MutationObserver(repaint).observe(editor, { childList: true, subtree: true, characterData: true });

  // --- hover ---

  const card = document.createElement('div');
  card.id = 'eq-hover';
  card.hidden = true;
  card.setAttribute('role', 'tooltip');
  document.body.append(card);

  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const linkKey = (e: MouseEvent | KeyboardEvent) => (mac ? e.metaKey : e.ctrlKey);

  interface Hit {
    line: HTMLElement;
    span: Span;
    range: Range;
    info: NameInfo;
    row: number;
  }

  /** The named span under a client point, if the point is really over its glyphs. */
  function hitAt(x: number, y: number): Hit | null {
    let node: Node | null = null;
    let offset = 0;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      node = p?.offsetNode ?? null;
      offset = p?.offset ?? 0;
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      node = r?.startContainer ?? null;
      offset = r?.startOffset ?? 0;
    }
    const line = (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('.eq-line');
    if (!node || !line || !editor.contains(line)) return null;
    const upTo = document.createRange();
    upTo.selectNodeContents(line);
    upTo.setEnd(node, offset);
    const at = upTo.toString().length;
    const spans = painted.get(line)?.spans ?? [];
    // The caret lands between characters: the span either side may be the one under the pointer.
    for (const span of spans) {
      if (!span.name || at < span.start || at > span.end) continue;
      const range = rangeIn(line, span.start, span.end);
      if (!range) continue;
      const over = [...range.getClientRects()].some(
        r => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1,
      );
      if (!over) continue;
      const info = describeName(span.name, options.env(), span.called);
      if (!info) return null;
      // A name on its own definition row has nowhere to go.
      const row = info.defined ? options.definitionRow(info.defined) : -1;
      return { line, span, range, info, row: row === options.lines().indexOf(line) ? -1 : row };
    }
    return null;
  }

  let shown: Hit | null = null;
  let timer = 0;
  let last: { x: number; y: number; link: boolean } | null = null;

  function hide() {
    clearTimeout(timer);
    timer = 0;
    shown = null;
    card.hidden = true;
    link.clear();
    editor.classList.remove('eq-linking');
  }

  function show(hit: Hit) {
    shown = hit;
    const { info, row } = hit;
    const sig = document.createElement('code');
    sig.textContent = info.signature;
    const type = document.createElement('span');
    type.className = 'eq-hover-type';
    type.textContent = info.type;
    const head = document.createElement('div');
    head.className = 'eq-hover-head';
    head.append(sig, type);
    const parts: HTMLElement[] = [head];
    if (info.description) {
      const d = document.createElement('div');
      d.textContent = info.description;
      parts.push(d);
    }
    if (row >= 0) {
      const def = options.lines()[row];
      const src = document.createElement('code');
      src.className = 'eq-hover-def';
      src.textContent = def ? options.lineText(def) : '';
      const key = document.createElement('div');
      key.className = 'eq-hover-key';
      key.textContent = `Row ${row + 1} · ${mac ? '⌘' : 'Ctrl'}-click to go to the definition`;
      parts.push(src, key);
    }
    card.replaceChildren(...parts);
    card.hidden = false;
    const rect = hit.range.getBoundingClientRect();
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const left = Math.max(8, Math.min(rect.left, innerWidth - w - 8));
    const below = rect.bottom + 6;
    card.style.left = `${left}px`;
    card.style.top = `${below + h > innerHeight - 8 ? rect.top - h - 6 : below}px`;
  }

  function update() {
    if (!last) return;
    const hit = hitAt(last.x, last.y);
    link.clear();
    editor.classList.remove('eq-linking');
    if (hit && last.link && hit.row >= 0) {
      link.add(hit.range);
      editor.classList.add('eq-linking');
    }
    if (!hit) {
      hide();
      return;
    }
    if (shown && shown.line === hit.line && shown.span.start === hit.span.start) return;
    if (shown) {
      show(hit);
      return;
    }
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = 0;
      const again = last && hitAt(last.x, last.y);
      if (again) show(again);
    }, HOVER_DELAY_MS);
  }

  editor.addEventListener('mousemove', e => {
    if (e.buttons) {
      hide();
      return;
    }
    last = { x: e.clientX, y: e.clientY, link: linkKey(e) };
    update();
  });
  editor.addEventListener('mouseleave', () => {
    last = null;
    hide();
  });
  // Holding or releasing the modifier over a name turns the link on and off.
  for (const type of ['keydown', 'keyup'] as const) {
    addEventListener(type, e => {
      if (e.key !== (mac ? 'Meta' : 'Control') || !last) return;
      last.link = type === 'keydown';
      update();
    });
  }
  // Typing, scrolling or clicking away all end the hover.
  editor.addEventListener('keydown', e => {
    if (e.key !== 'Meta' && e.key !== 'Control') hide();
  });
  editor.addEventListener('scroll', hide, { passive: true });
  addEventListener('blur', hide);

  editor.addEventListener('mousedown', e => {
    if (e.button !== 0 || !linkKey(e)) return;
    const hit = hitAt(e.clientX, e.clientY);
    if (!hit?.info.defined || hit.row < 0) return;
    e.preventDefault();
    hide();
    options.goTo(hit.row, hit.info.defined);
  });

  paint(); // the document may have loaded before the observer existed
  return { repaint };
}
