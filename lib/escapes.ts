/**
 * LaTeX-style input escapes: in the editor, typing `\pi` becomes π.
 *
 * Pure logic. web/main.ts applies the edit on each keystroke, and
 * lib/syntax-help.ts lists the table when the word under the caret starts
 * with a backslash, so Tab/Enter/click insert like any other suggestion.
 * A typed escape commits in one of two ways:
 *
 *  - The letter completing a name no other command extends converts at once:
 *    `\pi` is π the moment the i lands (no command continues "pi").
 *  - A name some longer command extends (`\sin` could still become \sinh)
 *    converts when a non-letter lands after it: `\sin(` → `sin(`.
 *
 * `\\` collapses to a literal backslash, and inside quoted text ("C:\data")
 * a backslash is always literal — no escape fires there.
 */
import { FUNCTIONS } from './expr.ts';
import { VALUE_END } from './statements.ts';

export interface Escape {
  /** What is typed after the backslash. */
  name: string;
  /** What it becomes — a symbol, or the plain function name for the LaTeX
   *  spellings of built-ins, where the backslash simply drops. */
  text: string;
  description: string;
}

/** In display order: a bare `\` suggests the head of this list. */
const SYMBOL_ESCAPES: readonly Escape[] = [
  { name: 'pi', text: 'π', description: 'The constant π' },
  { name: 'theta', text: 'θ', description: 'Greek letter' },
  { name: 'tau', text: 'τ', description: 'The constant τ = 2π' },
  { name: 'nabla', text: '∇', description: 'Nabla: ∇f, ∇·F, ∇×F, ∇²f' },
  { name: 'infty', text: '∞', description: 'Infinity' },
  { name: 'inf', text: '∞', description: 'Infinity' },
  { name: 'sum', text: 'Σ', description: 'Sum: Σ(n=1..N, …)' },
  { name: 'prod', text: 'Π', description: 'Product: Π(n=1..N, …)' },
  { name: 'int', text: '∫', description: 'Integral: ∫[a..b] f(x) dx' },
  { name: 'times', text: '×', description: 'Cross product (or multiplication)' },
  { name: 'cdot', text: '·', description: 'Dot product (or multiplication)' },
  { name: 'div', text: '÷', description: 'Division' },
  { name: 'le', text: '≤', description: 'Less than or equal' },
  { name: 'leq', text: '≤', description: 'Less than or equal' },
  { name: 'ge', text: '≥', description: 'Greater than or equal' },
  { name: 'geq', text: '≥', description: 'Greater than or equal' },
  { name: 'ne', text: '≠', description: 'Not equal (list filters)' },
  { name: 'neq', text: '≠', description: 'Not equal (list filters)' },
  { name: 'alpha', text: 'α', description: 'Greek letter' },
  { name: 'beta', text: 'β', description: 'Greek letter' },
  { name: 'gamma', text: 'γ', description: 'Greek letter' },
  { name: 'delta', text: 'δ', description: 'Greek letter' },
  { name: 'epsilon', text: 'ε', description: 'Greek letter' },
  { name: 'varepsilon', text: 'ε', description: 'Greek letter' },
  { name: 'zeta', text: 'ζ', description: 'Greek letter' },
  { name: 'eta', text: 'η', description: 'Greek letter' },
  { name: 'vartheta', text: 'ϑ', description: 'Greek letter' },
  { name: 'iota', text: 'ι', description: 'Greek letter' },
  { name: 'kappa', text: 'κ', description: 'Greek letter' },
  { name: 'lambda', text: 'λ', description: 'Greek letter' },
  { name: 'mu', text: 'μ', description: 'Greek letter' },
  { name: 'nu', text: 'ν', description: 'Greek letter' },
  { name: 'xi', text: 'ξ', description: 'Greek letter' },
  { name: 'omicron', text: 'ο', description: 'Greek letter' },
  { name: 'rho', text: 'ρ', description: 'Greek letter' },
  { name: 'sigma', text: 'σ', description: 'Greek letter' },
  { name: 'upsilon', text: 'υ', description: 'Greek letter' },
  { name: 'phi', text: 'φ', description: 'Greek letter' },
  { name: 'varphi', text: 'φ', description: 'Greek letter' },
  { name: 'chi', text: 'χ', description: 'Greek letter' },
  { name: 'psi', text: 'ψ', description: 'Greek letter' },
  { name: 'omega', text: 'ω', description: 'Greek letter' },
  { name: 'Gamma', text: 'Γ', description: 'Greek letter' },
  { name: 'Delta', text: 'Δ', description: 'Greek letter' },
  { name: 'Theta', text: 'Θ', description: 'Greek letter' },
  { name: 'Lambda', text: 'Λ', description: 'Greek letter' },
  { name: 'Xi', text: 'Ξ', description: 'Greek letter' },
  { name: 'Pi', text: 'Π', description: 'Product (same as prod)' },
  { name: 'Sigma', text: 'Σ', description: 'Sum (same as sum)' },
  { name: 'Upsilon', text: 'Υ', description: 'Greek letter' },
  { name: 'Phi', text: 'Φ', description: 'Greek letter' },
  { name: 'Psi', text: 'Ψ', description: 'Greek letter' },
  { name: 'Omega', text: 'Ω', description: 'Greek letter' },
  { name: 'arcsin', text: 'asin', description: 'Function name' },
  { name: 'arccos', text: 'acos', description: 'Function name' },
  { name: 'arctan', text: 'atan', description: 'Function name' },
];

/**
 * Every built-in function name is also an escape that simply writes itself:
 * \trail → trail. The regular typeahead only surfaces built-in calls once
 * two characters are typed, so `\` doubles as a function search that works
 * from the first letter. A curated spelling above wins — \sum stays Σ
 * (which is sum) and \gamma stays the letter γ, LaTeX-style; the gamma
 * function is reached by typing its name plainly.
 */
const FUNCTION_ESCAPES: readonly Escape[] = [...FUNCTIONS, 'view', 'open']
  .filter(name => !SYMBOL_ESCAPES.some(e => e.name === name))
  .sort()
  .map(name => ({ name, text: name, description: 'Function name' }));

export const ESCAPES: readonly Escape[] = [...SYMBOL_ESCAPES, ...FUNCTION_ESCAPES];

const BY_NAME = new Map(ESCAPES.map(e => [e.name, e]));

/** Names some longer command extends (\inf → \infty, \sin → \sinh): typing
 *  their last letter cannot commit them; a delimiter or the suggestions can. */
const PREFIX_OF_LONGER = new Set(
  ESCAPES.filter(a => ESCAPES.some(b => b.name !== a.name && b.name.startsWith(a.name))).map(a => a.name),
);

export interface EscapeEdit {
  /** Replace text[start..end) … */
  start: number;
  end: number;
  /** … with this … */
  text: string;
  /** … and put the caret here. */
  caret: number;
}

/** Whether index `at` sits inside quoted text, where a backslash is literal.
 *  A `'` only opens text where no value just ended (see splitStatements). */
const inQuote = (text: string, at: number): boolean => {
  let quote = '';
  for (let i = 0; i < at; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || (c === "'" && !VALUE_END.test(text[i - 1] ?? ''))) quote = c;
  }
  return quote !== '';
};

/** The `\name` ending at `end`, unless it is escaped or inside quotes. */
const escapeBefore = (text: string, end: number): { start: number; escape: Escape } | null => {
  const m = /\\([A-Za-z]+)$/.exec(text.slice(0, end));
  if (!m) return null;
  const start = end - m[0].length;
  if (text[start - 1] === '\\' || inQuote(text, start)) return null;
  const escape = BY_NAME.get(m[1]);
  return escape ? { start, escape } : null;
};

/**
 * The rewrite (if any) that the character just typed at text[offset - 1]
 * finishes: `\pi` → π on its last letter, `\sin` → sin on a delimiter,
 * `\\` → `\`. Bounds are in `text`; `caret` is where the caret lands.
 */
export function typedEscape(text: string, offset: number, inserted: string): EscapeEdit | null {
  if (inserted.length !== 1 || text[offset - 1] !== inserted) return null;
  if (inserted === '\\') {
    if (text[offset - 2] !== '\\' || inQuote(text, offset - 2)) return null;
    return { start: offset - 2, end: offset, text: '\\', caret: offset - 1 };
  }
  if (/[A-Za-z]/.test(inserted)) {
    const hit = escapeBefore(text, offset);
    if (!hit || PREFIX_OF_LONGER.has(hit.escape.name)) return null;
    return { start: hit.start, end: offset, text: hit.escape.text, caret: hit.start + hit.escape.text.length };
  }
  const hit = escapeBefore(text, offset - 1);
  if (!hit) return null;
  return { start: hit.start, end: offset - 1, text: hit.escape.text, caret: hit.start + hit.escape.text.length + 1 };
}
