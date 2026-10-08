/**
 * Row colors: the palettes, which rows take a color from them, and which slot
 * each takes. The app (web/main.ts, web/theme.ts) and the share image
 * (worker/og.ts) both color through here, so a shared link opens in the
 * colors its preview showed.
 */
import type { CpuPlan } from './compiler.ts';
import { noteColor } from './statements.ts';

type RGB = [number, number, number];

/** Row colors on the light theme, in the order a document's rows take them. */
export const LIGHT_PALETTE: RGB[] = [
  [0.176, 0.439, 0.702], // blue
  [0.78, 0.267, 0.251], // red
  [0.22, 0.549, 0.275], // green
  [0.376, 0.259, 0.651], // purple
  [0.98, 0.494, 0.098], // orange
  [0.0, 0.0, 0.0], // black
];

/** The same slots on the dark theme. */
export const DARK_PALETTE: RGB[] = [
  [0.4, 0.62, 0.92], // blue
  [0.92, 0.45, 0.42], // red
  [0.42, 0.78, 0.48], // green
  [0.65, 0.52, 0.95], // purple
  [0.98, 0.62, 0.28], // orange
  [0.9, 0.91, 0.93], // light (stands in for black)
];

export interface ColorRow {
  text: string;
  comment?: boolean;
  def?: unknown;
  /** The row names a point (`A = (1, 2)`): a definition, but it draws a dot. */
  point?: boolean;
  view?: unknown;
  cpu?: CpuPlan;
}

/**
 * Whether a row shows a palette color. Blank rows, definitions (other than
 * named points), comments, view/camera/grid rows and `---` dividers draw
 * nothing, a value row shows only its readout, and a `#hex` note picks its
 * own color, so none of them use up a slot. A row with an error does: it is
 * usually a curve being typed.
 */
export function takesColor(row: ColorRow): boolean {
  if (!row.text.trim() || row.comment || (row.def && !row.point) || row.view || noteColor(row.text)) return false;
  const plan = row.cpu;
  return !(plan?.type === 'note' || plan?.type === 'metric' || (plan?.type === 'value' && !plan.shade));
}

/**
 * Give each row that takes a color (`takes[i]`) but has none (colorIndex < 0)
 * a palette slot, in document order, and clear the slot of rows that don't.
 * A new row takes the slot the fewest colored rows use; on a tie, one its
 * nearest colored neighbours above and below don't use; then the earliest.
 * So a freshly loaded document runs through the palette in order, and a row
 * added later fills a gap rather than repeating the row beside it.
 */
export function assignColors(rows: { colorIndex: number }[], takes: boolean[], size: number): void {
  const counts = new Array<number>(size).fill(0);
  for (const [i, row] of rows.entries()) {
    if (takes[i] && row.colorIndex >= 0 && row.colorIndex < size) counts[row.colorIndex]++;
    else row.colorIndex = -1;
  }
  // The nearest colored row below each row, found before any are assigned:
  // rows still waiting for a slot are passed over.
  const below = new Array<number>(rows.length);
  for (let i = rows.length - 1, next = -1; i >= 0; i--) {
    below[i] = next;
    if (rows[i].colorIndex >= 0) next = rows[i].colorIndex;
  }
  let above = -1;
  for (const [i, row] of rows.entries()) {
    if (!takes[i]) continue;
    if (row.colorIndex < 0) {
      const fewest = Math.min(...counts);
      let pick = -1;
      for (let s = 0; s < size; s++) {
        if (counts[s] !== fewest) continue;
        if (pick < 0) pick = s;
        if (s !== above && s !== below[i]) {
          pick = s;
          break;
        }
      }
      row.colorIndex = pick;
      counts[pick]++;
    }
    above = row.colorIndex;
  }
}
