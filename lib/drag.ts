/**
 * Draggable-point analysis, shared by the web app (which wires up the actual
 * drags) and the MCP server (which reports whether a point will be draggable).
 *
 * A coordinate can move under a drag only if the drag knows how to write the
 * new value back into the equation text: it is a plain number literal
 * (rewritten in place) or the bare name of a slider constant (moved through
 * its own row). Computed coordinates — (2cos(t), 2sin(t)), (a+1, b) — have
 * nothing to write back to and stay pinned on that axis.
 */

import { NAME_SRC, type Expr, canonicalName, evaluate } from './expr.ts';

const NUM_LITERAL_RE = /^-?(?:\d+\.?\d*|\.\d+)$/;
const NAME_RE = new RegExp(`^${NAME_SRC}$`);

/**
 * A slider appears when a constant's right-hand side is a plain number.
 * No exponent form: the grammar has no scientific notation, so `1e-3` is
 * 1·e − 3 and must stay an expression rather than become a 0.001 slider.
 */
export const SLIDER_NUM_RE = /^\s*-?(\d+\.?\d*|\.\d+)\s*$/;

/** The two top-level coordinates of `(A, B)`, or null if it is not a pair. */
export function splitPair(text: string): [string, string] | null {
  if (!text.startsWith('(') || !text.endsWith(')')) return null;
  const inner = text.slice(1, -1);
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
    if (depth < 0) return null; // the outer parens don't wrap the whole row
  }
  if (depth !== 0) return null;
  parts.push(inner.slice(start));
  return parts.length === 2 ? [parts[0].trim(), parts[1].trim()] : null;
}

/**
 * How each coordinate of a pair responds to a drag: 'literal' is rewritten in
 * place, a slider (whatever `slider` resolves the name to) moves through its
 * own row, and null stays pinned. Returns null when the text is not a pair or
 * nothing about it can move.
 */
export function dragAxes<S>(
  pairText: string,
  slider: (name: string) => S | null | undefined,
  pinned: ReadonlySet<string> = new Set(),
): { parts: [string, string]; axes: Array<'literal' | S | null> } | null {
  const parts = splitPair(pairText.trim());
  if (!parts) return null;
  const axes = parts.map(p => {
    if (NUM_LITERAL_RE.test(p)) return 'literal' as const;
    // Sliders and pins live under canonical names: (r₁, 2) drags r_1's row.
    if (!NAME_RE.test(p) || pinned.has(canonicalName(p))) return null;
    return slider(canonicalName(p)) ?? null;
  });
  if (!axes.some(a => a !== null)) return null;
  return { parts, axes };
}

/** Evaluate a chart with fresh time/parameters on every pointer movement. */
export function coordinateDragWriter(
  coords: Expr[],
  getEnv: () => Record<string, number>,
  write: (a: number, b: number) => void,
  round: (v: number) => number = v => v,
): (x: number, y: number) => void {
  return (x, y) => {
    try {
      // Pixel precision belongs to Cartesian space, before changing units.
      const env = { ...getEnv(), x: round(x), y: round(y) };
      const values = coords.map(c => evaluate(c, env));
      if (values.every(Number.isFinite)) write(values[0], values[1]);
    } catch { /* singular coordinate: keep the previous values */ }
  };
}
