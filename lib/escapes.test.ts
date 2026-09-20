import { describe, expect, it } from 'vitest';
import { ESCAPES, typedEscape } from './escapes.ts';
import { FUNCTIONS } from './expr.ts';

/** Feed a whole string as keystrokes onto `text`, applying each rewrite. */
const type = (text: string, keys: string) => {
  let caret = text.length;
  for (const key of keys) {
    text = text.slice(0, caret) + key + text.slice(caret);
    caret += key.length;
    const edit = typedEscape(text, caret, key);
    if (edit) {
      text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
      caret = edit.caret;
    }
  }
  return { text, caret };
};

describe('typedEscape', () => {
  it('converts a completed name no other command extends', () => {
    expect(type('y = ', '\\pi')).toEqual({ text: 'y = π', caret: 5 });
    expect(type('', '\\theta + 1')).toEqual({ text: 'θ + 1', caret: 5 });
    expect(type('', '\\nabla(f)')).toEqual({ text: '∇(f)', caret: 4 });
    expect(type('', '2\\pi r')).toEqual({ text: '2π r', caret: 4 });
  });

  it('waits for a delimiter when a longer command shadows the name', () => {
    expect(type('', '\\sin').text).toBe('\\sin'); // could still be \sinh
    expect(type('', '\\sin(x)').text).toBe('sin(x)');
    expect(type('', '\\sinh(x)').text).toBe('sinh(x)');
    expect(type('', '\\inf').text).toBe('\\inf'); // could still be \infty
    expect(type('', 'x \\le 5').text).toBe('x ≤ 5');
    expect(type('', '\\infty').text).toBe('∞');
  });

  it('leaves unknown names alone', () => {
    expect(type('', '\\zz + 1').text).toBe('\\zz + 1');
  });

  it('collapses \\\\ to a literal backslash and never converts after it', () => {
    expect(type('', '\\\\')).toEqual({ text: '\\', caret: 1 });
    // The remaining single backslash starts a fresh escape if letters follow.
    expect(type('', '\\\\pi').text).toBe('π');
    // But a backslash pasted before a word is left alone by delimiters.
    expect(type('\\\\pi', ' ').text).toBe('\\\\pi ');
  });

  it('is inert inside quoted text', () => {
    expect(type('label("', '\\pi').text).toBe('label("\\pi');
    expect(type("open('", '\\theta ').text).toBe("open('\\theta ");
    // A prime is not a quote: escapes still fire after f'.
    expect(type("f' = ", '\\pi').text).toBe("f' = π");
  });

  it('drops the backslash from LaTeX spellings of built-ins', () => {
    expect(type('', '\\sqrt(2)').text).toBe('sqrt(2)');
    expect(type('', '\\arcsin(1)').text).toBe('asin(1)');
    expect(type('', '\\ln(x)').text).toBe('ln(x)');
  });

  it('keeps the table well-shaped', () => {
    // Names are plain ASCII words, replacements non-empty, no duplicates.
    const seen = new Set<string>();
    for (const { name, text } of ESCAPES) {
      expect(name).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
      expect(text.length).toBeGreaterThan(0);
      expect(seen.has(name), name).toBe(false);
      seen.add(name);
    }
  });

  it('enumerates every built-in function name', () => {
    for (const name of FUNCTIONS) {
      expect(ESCAPES.some(e => e.name === name), name).toBe(true);
    }
    expect(ESCAPES.some(e => e.name === 'view')).toBe(true);
    expect(ESCAPES.some(e => e.name === 'open')).toBe(true);
    // A function escape simply writes the name…
    expect(type('', '\\trail(P)').text).toBe('trail(P)');
    expect(type('', '\\mean(L)').text).toBe('mean(L)');
    // …a digit delimits like anything else, so \atan2 lands whole…
    expect(type('', '\\atan2(1, 1)').text).toBe('atan2(1, 1)');
    // …and curated spellings win: \sum is Σ (which IS sum), \gamma the letter.
    expect(type('', '\\sum(n=1..3, n)').text).toBe('Σ(n=1..3, n)');
    expect(type('', '\\gamma ').text).toBe('γ ');
  });
});
