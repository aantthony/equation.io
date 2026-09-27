/**
 * Split views: `---` rows divide the document into panels.
 *
 * Rows below a divider draw in a panel of their own, with its own x, y, z,
 * its own `view(…)` / `camera(…)` row, its own 2D-or-3D mode and its own
 * `grid(…)`. Definitions stay document-wide, so `f(x) = x^2` above a divider
 * is the same f below it. Each divider says where its panel goes:
 *
 *   --- below 40%, shared x     split the panel above; the new one takes 40%
 *   --- right                   side by side
 *   --- inset top left 30%      picture in picture, floating over the panel above
 *
 * A bare `---` splits along the longer side, so a two-panel graph sits side
 * by side on a wide screen and stacked on a phone. Splits tile: each one
 * divides the most recent tiled panel (the tmux rule), so a 3D scene on the
 * left with two 2D panels stacked on its right is `--- right 40%` then
 * `--- below`. Insets float over the most recent tiled panel and are placed
 * after tiling, against that panel's final box.
 *
 * `shared x` keeps the panel's x axis locked to the one it split from —
 * same center and scale, so stacked panels line up column for column, and
 * panning either pans both. `shared y` does the same for rows.
 */
import { parseExpr } from './expr.ts';

export type SplitPlace = 'right' | 'left' | 'below' | 'above' | 'inset';
export type InsetCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface SplitSpec {
  kind: 'split';
  /** Where the new panel goes; undefined splits along the longer side. */
  place?: SplitPlace;
  corner?: InsetCorner;
  /** The new panel's share of the panel it splits (or, for an inset, of its host's width and height). */
  size?: number;
  shared?: { x?: boolean; y?: boolean };
}

/**
 * `grid(off)` draws nothing behind the panel's plots; `grid(axes)` only the
 * two axes; `grid(x, y)` the Cartesian grid even where coordinate fields
 * are defined; `grid(r, theta)` exactly those fields' level sets; `grid(on)`
 * the default (the panel's coordinate fields, or else Cartesian).
 */
export interface GridRowSpec {
  kind: 'grid';
  mode: 'on' | 'off' | 'axes' | 'coords';
  coords?: string[];
}

export const MAX_PANELS = 8;
const DEFAULT_INSET = 0.35;

const DIVIDER_RE = /^-{3,}\s*([\s\S]*)$/;
const SIZE_RE = /^(\d+(?:\.\d+)?)%$/;
const CORNER_RE = /^(top|bottom)-(left|right)$/;
const WORDS: ReadonlySet<string> = new Set(['right', 'left', 'below', 'above', 'top', 'bottom', 'inset', 'shared']);

const DIVIDER_USAGE =
  'Expected --- then where the panel goes (right, left, below, above, or inset top left), ' +
  'a size like 40%, and optionally shared x or shared y.';

/**
 * Parse a divider row, or null when the text is not one. `---x` and `--- x`
 * stay math (negations of x): only a bare run of dashes, or one followed by
 * a placement word or a size, is a divider.
 */
export function parseDividerRow(text: string): SplitSpec | null {
  const m = DIVIDER_RE.exec(text.trim());
  if (!m) return null;
  const tokens = m[1]
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (tokens.length && !WORDS.has(tokens[0]) && !SIZE_RE.test(tokens[0]) && !CORNER_RE.test(tokens[0])) return null;
  const spec: SplitSpec = { kind: 'split' };
  let vertical: 'top' | 'bottom' | undefined;
  let horizontal: 'left' | 'right' | undefined;
  let inset = false;
  const setVertical = (v: 'top' | 'bottom') => {
    if (vertical && vertical !== v) throw new Error('A divider names both top and bottom.');
    vertical = v;
  };
  const setHorizontal = (h: 'left' | 'right') => {
    if (horizontal && horizontal !== h) throw new Error('A divider names both left and right.');
    horizontal = h;
  };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const size = SIZE_RE.exec(tok);
    const corner = CORNER_RE.exec(tok);
    if (size) {
      if (spec.size !== undefined) throw new Error('A divider sets its size twice.');
      const pct = parseFloat(size[1]);
      if (pct <= 0 || pct >= 100) throw new Error('A panel size is a percentage between 0% and 100%.');
      spec.size = pct / 100;
    } else if (corner) {
      inset = true;
      setVertical(corner[1] as 'top' | 'bottom');
      setHorizontal(corner[2] as 'left' | 'right');
    } else if (tok === 'inset') inset = true;
    else if (tok === 'top' || tok === 'above') setVertical('top');
    else if (tok === 'bottom' || tok === 'below') setVertical('bottom');
    else if (tok === 'left' || tok === 'right') setHorizontal(tok);
    else if (tok === 'shared') {
      const axes = /^[xy]+$/;
      if (!axes.test(tokens[i + 1] ?? ''))
        throw new Error('shared names the axes the panels share: shared x, shared y.');
      spec.shared ??= {};
      while (axes.test(tokens[i + 1] ?? '')) for (const axis of tokens[++i]) spec.shared[axis as 'x' | 'y'] = true;
    } else throw new Error(`"${tok}" is not a divider option. ${DIVIDER_USAGE}`);
  }
  if (inset) {
    spec.place = 'inset';
    spec.corner = `${vertical ?? 'top'}-${horizontal ?? 'right'}`;
  } else if (vertical && horizontal) {
    throw new Error(`A split goes one way — for a floating corner panel write --- inset ${vertical} ${horizontal}.`);
  } else if (vertical) spec.place = vertical === 'top' ? 'above' : 'below';
  else if (horizontal) spec.place = horizontal;
  return spec;
}

/** Whether the text is a divider row, well-formed or not. */
export function isDividerRow(text: string): boolean {
  try {
    return parseDividerRow(text) !== null;
  } catch {
    return true;
  }
}

const GRID_RE = /^\s*grid\s*\(([\s\S]*)\)\s*$/;

/** Parse a `grid(…)` row, or null when the text is not one. Coordinate names
 *  are checked against the document by the caller. */
export function parseGridRow(text: string): GridRowSpec | null {
  const m = GRID_RE.exec(text);
  if (!m) return null;
  const args = m[1]
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const usage = 'Expected grid(off), grid(axes), grid(on), or grid(r, theta) naming coordinates.';
  if (!args.length || args.length > 3) throw new Error(usage);
  if (args.length === 1 && /^(off|none|axes|on)$/i.test(args[0])) {
    const word = args[0].toLowerCase();
    return { kind: 'grid', mode: word === 'none' ? 'off' : (word as 'on' | 'off' | 'axes') };
  }
  const coords: string[] = [];
  for (const arg of args) {
    let e;
    try {
      e = parseExpr(arg);
    } catch {
      throw new Error(usage);
    }
    if (e.kind !== 'var') throw new Error(`grid(…) names coordinates, like grid(r, theta) — not "${arg}".`);
    if (coords.includes(e.name)) throw new Error(`grid(…) names ${e.name} twice.`);
    coords.push(e.name);
  }
  return { kind: 'grid', mode: 'coords', coords };
}

/** Why `name` cannot draw as a grid family, or null when it can: x, y, or
 *  one of the document's planar coordinate fields (`gridFields`, the list the
 *  renderers draw from). `fields` tells a field that is not planar apart
 *  from a name that is no field at all. */
export function gridCoordinateProblem(
  name: string,
  gridFields: ReadonlyArray<{ name: string }>,
  fields: ReadonlyMap<string, unknown>,
): string | null {
  if (name === 'x' || name === 'y' || gridFields.some(f => f.name === name)) return null;
  if (name === 'z') return 'z has no level sets in the plane; a grid draws x, y, or coordinates over them.';
  if (fields.has(name))
    return `${name} is not a coordinate over the plane (it uses z, u or v, is complex, or is a point's part).`;
  return `${name} is not a coordinate — define it as a function of x and y first, like r = sqrt(x^2 + y^2).`;
}

/** Each row's panel: 0 until the first divider, then one more per divider.
 *  A divider belongs to the panel it opens. */
export function panelIndices(rows: ReadonlyArray<{ view?: { kind: string } }>): number[] {
  let panel = 0;
  return rows.map(r => (r.view?.kind === 'split' ? ++panel : panel));
}

/** The dividers of a document, in order (panel k + 1 is opened by entry k). */
export function splitsOf(rows: ReadonlyArray<{ view?: { kind: string } }>): SplitSpec[] {
  return rows.filter(r => r.view?.kind === 'split').map(r => r.view as SplitSpec);
}

/** A box in device pixels, from the top-left corner. */
export interface PanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PanelLayout {
  rect: PanelRect;
  /** The panel this one split from or floats over (itself for the first). */
  host: number;
  inset: boolean;
  shared: { x: boolean; y: boolean };
}

/**
 * Lay the panels out in a w×h canvas. `margin` is the gap, in the same
 * pixels, between an inset and its host's edges.
 */
export function layoutPanels(splits: readonly SplitSpec[], w: number, h: number, margin = 0): PanelLayout[] {
  const out: PanelLayout[] = [{ rect: { x: 0, y: 0, w, h }, host: 0, inset: false, shared: { x: false, y: false } }];
  let tile = 0;
  for (const s of splits) {
    const shared = { x: !!s.shared?.x, y: !!s.shared?.y };
    if (s.place === 'inset') {
      out.push({ rect: { x: 0, y: 0, w: 0, h: 0 }, host: tile, inset: true, shared });
      continue;
    }
    const region = out[tile].rect;
    const place = s.place ?? (region.w >= region.h ? 'right' : 'below');
    const f = s.size ?? 0.5;
    const across = place === 'right' || place === 'left';
    const total = across ? region.w : region.h;
    const size = Math.max(1, Math.min(total - 1, Math.round(total * f)));
    const rest = total - size;
    const host = { ...region };
    const rect = { ...region };
    if (across) {
      host.w = rest;
      rect.w = size;
      if (place === 'right') rect.x = region.x + rest;
      else host.x = region.x + size;
    } else {
      host.h = rest;
      rect.h = size;
      if (place === 'below') rect.y = region.y + rest;
      else host.y = region.y + size;
    }
    out[tile].rect = host;
    out.push({ rect, host: tile, inset: false, shared });
    tile = out.length - 1;
  }
  splits.forEach((s, k) => {
    if (s.place !== 'inset') return;
    const p = out[k + 1];
    const box = out[p.host].rect;
    const f = s.size ?? DEFAULT_INSET;
    const iw = Math.max(1, Math.round(box.w * f));
    const ih = Math.max(1, Math.round(box.h * f));
    const m = Math.max(0, Math.min(margin, (box.w - iw) / 2, (box.h - ih) / 2));
    const [v, hz] = (s.corner ?? 'top-right').split('-');
    p.rect = {
      x: Math.round(hz === 'left' ? box.x + m : box.x + box.w - iw - m),
      y: Math.round(v === 'top' ? box.y + m : box.y + box.h - ih - m),
      w: iw,
      h: ih,
    };
  });
  return out;
}

/** The panel whose axis `axis` panel i follows: up the chain of shared hosts. */
export function linkRoot(layout: readonly PanelLayout[], i: number, axis: 'x' | 'y'): number {
  let k = i;
  for (let guard = 0; guard < layout.length && layout[k].shared[axis] && layout[k].host !== k; guard++)
    k = layout[k].host;
  return k;
}

/** The topmost panel containing a point (insets draw over tiles, later over earlier). */
export function panelAt(layout: readonly PanelLayout[], x: number, y: number): number {
  for (let i = layout.length - 1; i >= 0; i--) {
    const { rect: r } = layout[i];
    if (layout[i].inset && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return i;
  }
  for (let i = layout.length - 1; i >= 0; i--) {
    const { rect: r } = layout[i];
    if (!layout[i].inset && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return i;
  }
  return 0;
}
