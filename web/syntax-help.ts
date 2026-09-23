import type { Env } from '../lib/env.ts';
import { syntaxHelp, type SyntaxHelp } from '../lib/syntax-help.ts';

interface Caret { line: number; offset: number }

export function initSyntaxHelp(editor: HTMLElement, options: {
  context: () => { caret: Caret; text: string; defs: Env; declared?: ReadonlySet<string> } | null;
  replace: (caret: Caret, start: number, end: number, text: string, offset: number) => void;
}) {
  const box = document.createElement('div');
  box.id = 'syntax-help'; box.hidden = true;
  const hint = document.createElement('div');
  hint.id = 'syntax-hint'; hint.className = 'syntax-hint';
  const list = document.createElement('div');
  list.id = 'syntax-suggestions'; list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Equation suggestions');
  const footer = document.createElement('div');
  footer.className = 'syntax-keys'; footer.textContent = 'Tab to insert · ↑↓ to choose · Esc to dismiss';
  box.append(hint, list, footer); document.body.append(box);
  editor.setAttribute('aria-autocomplete', 'list');
  editor.setAttribute('aria-controls', list.id);
  let context: ReturnType<typeof options.context> = null;
  let help: SyntaxHelp | null = null;
  let selected = -1, composing = false, dismissed = '', currentKey = '';

  const hide = () => {
    box.hidden = true; help = null;
    editor.removeAttribute('aria-activedescendant');
    editor.removeAttribute('aria-describedby');
  };
  const highlight = () => {
    [...list.children].forEach((el, i) => el.setAttribute('aria-selected', String(i === selected)));
    if (selected >= 0) editor.setAttribute('aria-activedescendant', `syntax-option-${selected}`);
    else editor.removeAttribute('aria-activedescendant');
  };
  const accept = (index: number) => {
    if (!context || !help) return;
    const suggestion = help.suggestions[index];
    if (!suggestion) return;
    const needsParens = !suggestion.insert && suggestion.call
      && !/^\s*\(/.test(context.text.slice(help.end)) && suggestion.name !== 'int';
    const text = suggestion.insert ?? (suggestion.name + (needsParens ? '()' : ''));
    const pos = { ...context.caret };
    const start = help.start, end = help.end;
    hide();
    options.replace(pos, start, end, text, start + text.length - (needsParens ? 1 : 0));
    refresh();
  };
  function refresh() {
    if (composing || document.activeElement !== editor || !getSelection()?.isCollapsed) { hide(); return; }
    context = options.context();
    if (!context) { hide(); return; }
    const key = `${context.caret.line}:${context.caret.offset}:${context.text}`;
    if (key === dismissed) { hide(); return; }
    if (key !== currentKey) selected = -1;
    currentKey = key;
    help = syntaxHelp(context.text, context.caret.offset, context.defs, context.declared);
    if (!help.suggestions.length && !help.hint) { hide(); return; }
    hint.textContent = help.hint ?? ''; hint.hidden = !help.hint;
    if (help.hint) editor.setAttribute('aria-describedby', hint.id);
    else editor.removeAttribute('aria-describedby');
    list.replaceChildren();
    for (const [i, suggestion] of help.suggestions.entries()) {
      const button = document.createElement('button');
      button.type = 'button'; button.tabIndex = -1; button.id = `syntax-option-${i}`;
      button.setAttribute('role', 'option');
      const title = document.createElement('strong'); title.textContent = suggestion.signature;
      const description = document.createElement('span'); description.textContent = suggestion.description;
      button.append(title, description);
      button.addEventListener('pointerdown', event => event.preventDefault());
      button.addEventListener('click', () => accept(i));
      list.append(button);
    }
    footer.hidden = !help.suggestions.length;
    highlight(); box.hidden = false;
    const range = getSelection()?.rangeCount ? getSelection()!.getRangeAt(0) : null;
    const rect = range?.getBoundingClientRect();
    const anchor = rect?.height ? rect : editor.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
    const width = Math.min(innerWidth, viewport?.width ?? innerWidth);
    const height = Math.min(innerHeight, viewport?.height ?? innerHeight);
    box.style.maxWidth = `${Math.max(0, width - 16)}px`;
    box.style.maxHeight = `${Math.max(40, height - 16)}px`;
    box.style.left = `${Math.max(left + 8, Math.min(anchor.left, left + width - box.offsetWidth - 8))}px`;
    const below = anchor.bottom + 6;
    box.style.top = `${Math.max(top + 8, below + box.offsetHeight <= top + height - 8 ? below : anchor.top - box.offsetHeight - 6)}px`;
  }
  editor.addEventListener('keydown', e => {
    if (e.target !== editor || composing || e.isComposing || box.hidden || !help) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); dismissed = currentKey; hide(); return; }
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !help.suggestions.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopImmediatePropagation();
      selected = selected < 0 ? (e.key === 'ArrowDown' ? 0 : help.suggestions.length - 1)
        : (selected + (e.key === 'ArrowDown' ? 1 : -1) + help.suggestions.length) % help.suggestions.length;
      highlight();
    } else if (e.key === 'Tab' || (e.key === 'Enter' && selected >= 0)) {
      e.preventDefault(); e.stopImmediatePropagation(); accept(Math.max(0, selected));
    }
  }, true);
  editor.addEventListener('compositionstart', () => { composing = true; hide(); });
  editor.addEventListener('compositionend', () => { composing = false; refresh(); });
  editor.addEventListener('input', () => { dismissed = ''; refresh(); });
  editor.addEventListener('focus', refresh);
  editor.addEventListener('blur', hide);
  document.addEventListener('selectionchange', refresh);
  // Moving or resizing the panel invalidates the anchor, so hide until the
  // next caret interaction instead of leaving suggestions over the canvas.
  addEventListener('resize', refresh);
  document.addEventListener('scroll', hide, true);
  window.visualViewport?.addEventListener('resize', refresh);
  window.visualViewport?.addEventListener('scroll', hide);
}
