/**
 * Which constants are sliders, and how a drag writes one back.
 *
 * A constant is a slider when its right-hand side is a number the user wrote,
 * optionally held to a range or to whole numbers by the ordinary functions
 * that mean exactly that:
 *
 *   a = 0.4                        a slider over a default range
 *   a = clamp(0.4, 0, 1)           over [0, 1]
 *   n = round(5)                   in whole steps (floor and ceil too)
 *   r = round(clamp(30, 0, 255))   whole steps over [0, 255]
 *
 * The range is part of the row's text, so it travels in the link like
 * everything else; the value is what the expression says it is. A drag
 * rewrites only the literal, leaving the rest as the user wrote it.
 */
import { SLIDER_NUM_RE } from './drag.ts';
import { evaluate, parseExpr } from './expr.ts';

const ROUNDING = ['round', 'floor', 'ceil'] as const;

export interface SliderForm {
  /** The literal as written. */
  literal: number;
  /** Where it sits in the right-hand side. */
  start: number;
  end: number;
  /** Source text of the range's ends, when clamped, and the span of
   *  `lo, hi` within the right-hand side. */
  bounds?: { lo: string; hi: string; start: number; end: number };
  /** Steps by whole numbers (a rounding function wraps the literal). */
  whole: boolean;
}

/** `name( … )` around the whole of text[from, to), or null. Returns the inner span. */
function call(text: string, from: number, to: number, name: string): [number, number] | null {
  const head = new RegExp(`^\\s*${name}\\s*\\(`).exec(text.slice(from, to));
  if (!head) return null;
  let close = to;
  while (close > from && /\s/.test(text[close - 1])) close--;
  if (text[close - 1] !== ')') return null;
  // The parenthesis opened by the head must be the one closing the span.
  let depth = 0;
  for (let k = from + head[0].length - 1; k < close; k++) {
    if (text[k] === '(' || text[k] === '[' || text[k] === '{') depth++;
    else if (text[k] === ')' || text[k] === ']' || text[k] === '}') {
      depth--;
      if (depth === 0 && k !== close - 1) return null;
    }
  }
  return [from + head[0].length, close - 1];
}

/** Top-level comma positions in text[from, to). */
function commas(text: string, from: number, to: number): number[] {
  const out: number[] = [];
  let depth = 0;
  for (let k = from; k < to; k++) {
    const c = text[k];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) out.push(k);
  }
  return out;
}

/**
 * The slider a constant's right-hand side makes, or null. `userFns` are the
 * document's own functions: one named clamp or round is not the builtin.
 */
export function sliderForm(rhs: string, userFns: ReadonlySet<string> = new Set()): SliderForm | null {
  let whole = false;
  let bounds: SliderForm['bounds'];
  const read = (from: number, to: number): SliderForm | null => {
    const text = rhs.slice(from, to);
    if (SLIDER_NUM_RE.test(text)) {
      const start = from + text.search(/\S/);
      const end = from + text.trimEnd().length;
      return { literal: Number(rhs.slice(start, end)), start, end, whole, ...(bounds ? { bounds } : {}) };
    }
    for (const fn of ROUNDING) {
      const inner = !whole && !userFns.has(fn) ? call(rhs, from, to, fn) : null;
      if (inner) {
        whole = true;
        return read(...inner);
      }
    }
    const inner = !bounds && !userFns.has('clamp') ? call(rhs, from, to, 'clamp') : null;
    if (!inner) return null;
    const at = commas(rhs, ...inner);
    if (at.length !== 2) return null;
    bounds = {
      lo: rhs.slice(at[0] + 1, at[1]).trim(),
      hi: rhs.slice(at[1] + 1, inner[1]).trim(),
      start: at[0] + 1,
      end: inner[1],
    };
    if (!bounds.lo || !bounds.hi) return null;
    return read(inner[0], at[0]);
  };
  return read(0, rhs.length);
}

/** The right-hand side with the literal replaced by `value` (already formatted). */
export function writeSlider(rhs: string, form: SliderForm, value: string): string {
  return rhs.slice(0, form.start) + value + rhs.slice(form.end);
}

/**
 * The right-hand side held to [lo, hi] (formatted): an existing clamp's ends
 * are replaced, otherwise the literal is wrapped, inside any rounding.
 */
export function withBounds(rhs: string, form: SliderForm, lo: string, hi: string): string {
  if (!form.bounds) return writeSlider(rhs, form, `clamp(${rhs.slice(form.start, form.end)}, ${lo}, ${hi})`);
  return `${rhs.slice(0, form.bounds.start)} ${lo}, ${hi}${rhs.slice(form.bounds.end)}`;
}

/** The range's ends at these values, or null when either end is not a
 *  number or they are out of order. */
export function sliderBounds(
  form: SliderForm,
  env: Record<string, number>,
  userFns: ReadonlySet<string> = new Set(),
): [number, number] | null {
  if (!form.bounds) return null;
  try {
    const lo = evaluate(parseExpr(form.bounds.lo, userFns), env);
    const hi = evaluate(parseExpr(form.bounds.hi, userFns), env);
    return Number.isFinite(lo) && Number.isFinite(hi) && lo < hi ? [lo, hi] : null;
  } catch {
    return null;
  }
}

/** `v` as this slider can hold it: within its range, and whole if it steps so. */
export function sliderValue(form: SliderForm, v: number, bounds: [number, number] | null): number {
  if (bounds) v = Math.min(Math.max(v, bounds[0]), bounds[1]);
  return form.whole ? Math.round(v) : v;
}
