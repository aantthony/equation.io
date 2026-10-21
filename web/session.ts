/**
 * Graph session: the document, the panels, and the shared WebGL renderers.
 * Fields that the scene and the editor also write live on `app`.
 */
import { app } from './app-state.ts';
import { viewportRow, render } from './scene.ts';
import { evaluateFrame } from '../lib/env.ts';
import { type CellGrid, type Board, latticeFrame } from '../lib/automaton.ts';
import type { GraphData } from '../lib/graph.ts';
import type { CpuPlan, GpuPlan } from '../lib/compiler.ts';
import { PointTrail } from '../lib/point-trail.ts';
import type { Definition } from '../lib/defs.ts';
import { type PmfStems, stemGeometry, RVSystem } from '../lib/dist.ts';
import type { IntShade, ShadeSampler, ShadeRun } from '../lib/intshade.ts';
import type { Expr } from '../lib/expr.ts';
import type { PathSampler, RegionSampler } from '../lib/path.ts';
import { type Classified, dotPlot } from '../lib/plot.ts';
import { type SpecialPoint, curveTracer } from '../lib/special.ts';
import { advanceState, initialState } from '../lib/state.ts';
import { type ViewSpec, type View2DSpec, linkedWindow } from '../lib/view.ts';
import type { AxisMaps } from '../lib/axis-map.ts';
import type { Table } from '../lib/csv.ts';
import { fullscreenQuad } from './gl.ts';
import { type PanelLayout, type GridRowSpec, panelAt, splitsOf, layoutPanels, linkRoot } from '../lib/panels.ts';
import { type Cells2D, type Overlay2D, type View2D, Renderer2D, LATTICE_VALUE_PX } from './render2d.ts';
import { type Camera3D, Renderer3D } from './render3d.ts';

export interface Equation {
  familyParent?: Equation;
  familyShade?: number;
  showArrows?: boolean;
  /** A 3D vector field drawn as animated streamlines instead of trajectories;
   *  a 2D matrix field as streamlines of its major eigenvector, not glyphs. */
  showStreamlines?: boolean;
  certify?: boolean;
  trail?: PointTrail;
  /** A definite-integral row's shaded area: the integrand compiled once per
   *  shade, and resampled only when the x-window or a value it reads (bounds,
   *  sliders, states, t) changes. */
  shadeCache?: {
    shade: IntShade;
    names: string[];
    sampler: ShadeSampler;
    key: string;
    runs: ShadeRun[];
    /** The panel's axis maps the runs were drawn on. */
    maps?: AxisMaps;
  };
  /** A 2D parametric curve's compiled sampler (lib/path.ts) and its last
   *  polyline, resampled only when a value it reads (sliders, states, t)
   *  changes — the shadeCache pattern. */
  pathCache?: { comps: Expr[]; sampler: PathSampler; key: string; pts: number[] };
  /** A filled parametric region's sampler and triangles (lib/path.ts), kept
   *  the same way. */
  regionCache?: { comps: readonly Expr[]; sampler: RegionSampler; key: string; tris: Float64Array };
  /** An automaton's cells (lib/automaton.ts), rerun only when its plan or a
   *  value it reads (sliders, t) changes — the shadeCache pattern. */
  cellCache?: { plan: CpuPlan; key: string; grid: CellGrid; cells: Cells2D };
  /** A 2D automaton's board (lib/automaton.ts runBoard), stepped on as t
   *  runs, and its shades at the generation last drawn. */
  boardCache?: { shape: string; key: string; board: Board; generation: number; cells: Cells2D };
  /** A table's cells over the window last drawn (the cellCache pattern). */
  tableCache?: { plan: CpuPlan; key: string; grid: CellGrid; cells: Cells2D };
  /** A graph's edges as last evaluated from `inputs` (the values it reads:
   *  sliders, t), and its layout (lib/graph.ts), kept while `key` holds. */
  graphCache?: {
    plan: CpuPlan;
    /** The plan's edges compiled (lib/graph.ts edgeEvaluator). */
    edges: (env: Record<string, number>) => number[][];
    inputs: string;
    key: string;
    data: GraphData;
    pos: Map<number, [number, number]>;
  };
  id: number;
  text: string;
  /** The row's palette slot; -1 until recompileAll colors it (lib/palette.ts),
   *  and for rows that show no color. */
  colorIndex: number;
  cls?: Classified;
  cpu?: CpuPlan;
  gpu?: GpuPlan;
  error?: string;
  /** The error is only that a data file is not on this device, so the message
   *  doubles as the file picker (any row that reads a column, not just the
   *  `open(…)` row that names it). */
  needsFile?: boolean;
  /** Extra readout under the line (e.g. the numeric value of a P(…) row). */
  info?: string;
  /** The row's note (lib/analysis.ts), kept after each frame's readout. */
  note?: string;
  /** Set when the row is a definition (`a = 2`, `f(x) = …`) rather than a plot. */
  def?: Definition;
  /** Set when the row is a viewport row (`view(…)`, `camera(…)`, `grid(…)`, a `---` divider). */
  viewSpec?: ViewSpec;
  /** The split-view panel the row draws in (lib/panels.ts); 0 without dividers. */
  panel?: number;
  /** Set when the row is a `# label` comment heading a collapsible group. */
  comment?: boolean;
  /** The `#hex` note color parsed from `text`, cached until the text changes. */
  noteColor?: { text: string; rgb: [number, number, number] | null };
  /** Set for probability rows (`X ~ …`, `P(…)`, `E(…)`). */
  dist?: 'density' | 'pmf' | 'probability' | 'expectation';
  /** A `mark(v)` row: v highlighted as a vertex of its panel's graphs. */
  mark?: true;
  /** Comment rows: hide the group (rows until the next comment) in the list. */
  collapsed?: boolean;
  sliderMin?: number;
  sliderMax?: number;
  /** Draw the whole family of level sets (for `f(x,y) = c` plots). */
  showLevels?: boolean;
  /** Curvature comb: teeth along −N of length κ. */
  combK?: boolean;
  /** Torsion comb: teeth along ±B of length |τ|. */
  combT?: boolean;
  /** Sequence rows: plot partial sums S_N = Σ aₙ instead of the terms. */
  partialSum?: boolean;
  /** Interleaved non-editable widgets, created lazily and kept across edits. */
  sliderUI?: SliderUI;
  levelsBtn?: HTMLButtonElement;
  curveUI?: CurveUI;
  errorEl?: HTMLElement;
  infoEl?: HTMLElement;
  /** Data rows: the collapsible grid of the file's first rows. */
  tableUI?: TableUI;
  /** Cached hover points (intercepts, extrema) for the cached view range. */
  spCache?: { text: string; env: string; xlo: number; xhi: number; ylo: number; yhi: number; pts: SpecialPoint[] };
  /** Projects the pointer onto the curve, for the constants it was built at. */
  tracer?: { text: string; env: string; fn: ReturnType<typeof curveTracer> };
  toggleUI?: { box: HTMLElement; btns: HTMLButtonElement[] };
  /** Cached system solutions for the box and constants they were solved at. */
  traceTarget?: string;
  traceClock?: number;
  sysCache?: { key: string; text: string; env: string; stableEnv: string; lo: number[]; hi: number[]; pts: number[][] };
  /** The last integrated orbit, and the one being integrated now. */
  orbitCache?: { key: string; pts: number[][] };
  orbitPending?: string;
}

/**
 * An on-screen point the pointer can pick up. `set` writes the dragged
 * position back to whatever defines the point, so the equation list stays the
 * source of truth.
 */
export interface Grabbable {
  key: string;
  x: number;
  y: number;
  /** True when `set` rewrites row text (so the drag is undoable and re-saved). */
  edits: boolean;
  set: (x: number, y: number) => void;
}

/** A dot on a surface panel's surface, at x and y there. */
export interface SurfaceDot {
  x: number;
  y: number;
  color: [number, number, number];
  label?: string;
}

/** Read-only preview of a data file, under its `open(…)` row. */
export interface TableUI {
  box: HTMLDetailsElement;
  summary: HTMLElement;
  scroll: HTMLElement;
  /** The parsed table the grid was built from. Identity is the test: a file
   *  keeps one Table across recompiles, while a filtered copy is rebuilt
   *  whenever anything it depends on moves — exactly when the grid is stale. */
  data?: Table;
}

export interface SliderUI {
  box: HTMLElement;
  min: HTMLInputElement;
  range: HTMLInputElement;
  max: HTMLInputElement;
}

/** κ/τ comb toggles for a 3D parametric curve. (The tube radius is not here:
 *  it belongs to tube(…) in the expression, so share links carry it.) */
export interface CurveUI {
  box: HTMLElement;
  kappa: HTMLInputElement;
  tau: HTMLInputElement;
}

export function cssColor([r, g, b]: [number, number, number]): string {
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

/** A run of a discrete variable's stems (or the run a P(…) row selects, drawn
 *  `heavy`) as overlay geometry. What to draw is lib's (stemGeometry), shared
 *  with the og rasterizer; this only hands it to the canvas overlay. */
export function pushStems(
  extras: Overlay2D,
  run: PmfStems,
  color: [number, number, number],
  heavy: boolean,
  pxPerUnit: number,
): void {
  if (!run.ks.length) return;
  const g = stemGeometry(run, heavy, pxPerUnit);
  const ink = g.alpha < 1 ? cssColorA(color, g.alpha) : cssColor(color);
  extras.polylines.push(
    g.fill === null
      ? { pts: g.lines, color: ink, width: g.width }
      : { pts: g.lines, color: ink, width: g.width, closed: true, fill: cssColorA(color, g.fill) },
  );
  const dots = g.dots;
  if (dots)
    run.ks.forEach((k, n) => extras.points.push({ x: k, y: run.ps[n], color: ink, r: dots.r, bare: !dots.outlined }));
}

/** A solid's edges: its own colour pulled toward white, so they still read
 *  against faces lit in that colour. */
export const edgeShade = ([r, g, b]: [number, number, number]): [number, number, number] => [
  r + (1 - r) * 0.55,
  g + (1 - g) * 0.55,
  b + (1 - b) * 0.55,
];

export function cssColorA([r, g, b]: [number, number, number], a: number): string {
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
}

/** RK4 steps in each direction for a dropped integral curve. */
export const ODE_STEPS = 1400;
/** Most integral-curve seeds kept at once; older seeds evict first. */
export const MAX_DROPS = 12;
/** Above this many points, a typed-array list draws as a bulk cloud rather
 *  than as individual (outlined, hoverable) points. */
export const CLOUD_MIN = 400;
/** Most points a cloud may hold in a 3D scene. render3d has no instanced path
 *  — every point is a sprite it sorts and projects — so a cloud is capped
 *  there where a flat one is not, and says so rather than drawing part of the
 *  file. The scene, not the row, is what decides: a 2-column scatter goes down
 *  the same sprite path as soon as any row uses z. */
export const CLOUD_3D_MAX = 10_000;

/** Points a row would put in a 3D scene, either representation: a typed-array
 *  scatter, or the symbolic point list a slider or t expands one into. */
export const cloudPoints = (plot: CpuPlan): number =>
  plot.type === 'dscatter' ? plot.coords[0].length : plot.type === 'plist' ? plot.pts.length : 0;
export const TUBE_SEGMENTS = 24;

/**
 * A large column's dot plot, stacked in columns one cloud dot wide at the
 * current zoom, kept per column until the zoom changes. Drawing runs every
 * frame while anything on the page animates, and a 200k-point column would
 * otherwise rebuild 3.2 MB of the same stacks each time; panning keeps them.
 */
const stacks = new WeakMap<object, { width: number; values: ArrayLike<number>; xs: Float64Array; ys: Float64Array }>();
export function columnStacks(
  key: object,
  values: ArrayLike<number>,
  dotPx: number,
): { xs: Float64Array; ys: Float64Array } {
  const width = dotPx * app.view.upp * (window.devicePixelRatio || 1);
  let hit = stacks.get(key);
  if (!hit || hit.width !== width || !sameValues(hit.values, values)) {
    // Dots that would overlap at this zoom share a column; values at least a
    // dot apart keep their exact place, so small lists stack exact copies.
    const binned = values.length > CLOUD_MIN || crowded(values, width);
    hit = {
      width,
      values: values === key ? values : Float64Array.from(values),
      ...dotPlot(values, binned ? width : 0),
    };
    stacks.set(key, hit);
  }
  return hit;
}
function sameValues(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (!Object.is(a[k], b[k])) return false;
  return true;
}
/** Whether two different values lie closer than a dot's width. */
function crowded(values: ArrayLike<number>, width: number): boolean {
  const sorted = Float64Array.from(values).filter(Number.isFinite).sort();
  for (let k = 1; k < sorted.length; k++) {
    const gap = sorted[k] - sorted[k - 1];
    if (gap > 0 && gap < width) return true;
  }
  return false;
}
/** Dot diameters in CSS px: a listed point (r 4) and a cloud dot
 *  (render2d drawLabels2D). */
export const POINT_DOT_PX = 8;
export const CLOUD_DOT_PX = 3;
export const COMB_STEP = 4;

// --- state ---

export const equations: Equation[] = [];
/** Recolours the editor's names when `defs` changes (set once the editor's highlighter exists). */
/** Constants used as Σ/Π bounds; their sliders snap to integer steps. */
/** Constants that are a whole-number distribution parameter (the n of
 *  Binomial(n, p)); their sliders snap to integer steps too. */
/** The `a' = …` system being integrated, its current values, and the graph
 *  time they have been carried to. Null when no row defines a state. */
let stateTime = 0;
/** Compiled coordinate fields; non-empty replaces the Cartesian grid. */
/** The panel each coordinate field is defined in: its grid draws there. */
/** Declared random variables and their sample caches (persists across
 *  recompiles; definition-aware caching makes stale samples impossible). */
export const rvSys = new RVSystem();
/** Key of the point under the pointer (or being dragged): drawn with a ring. */

// --- canvas / renderers ---

export const canvas = document.getElementById('gl') as HTMLCanvasElement;
export const overlay = document.getElementById('overlay') as HTMLCanvasElement;
// alpha: false — passes blend with low src alpha, and a non-opaque buffer
// would be composited over the page as premultiplied, washing fills white.
const glCtx = canvas.getContext('webgl2', { antialias: true, alpha: false });
if (!glCtx) {
  const message = document.createElement('p');
  message.textContent = 'WebGL2 is required.';
  message.style.padding = '2em';
  document.body.replaceChildren(message);
  throw new Error('WebGL2 unavailable');
}
export const gl = glCtx;
const quad = fullscreenQuad(gl);
export const overlayCtx = overlay.getContext('2d')!;

// --- panels ---
//
// `---` rows split the canvas into panels (lib/panels.ts). Each has its own
// window, camera, 2D-or-3D mode, seeds and grabbable points; the renderers
// are shared, drawing each panel into its own viewport, and free what no
// panel drew once per frame (endFrame).
// `view`, `camera`, `mode`, `drops` and `grabbable` name the current panel's:
// render() points them at each panel in turn, and a gesture at the panel
// under the pointer, so the code below keeps reading one viewport.

export interface Panel {
  /** Which panel this is across edits: the id of the divider row that opens
   *  it, 0 for the first. A divider added above keeps the panels below it. */
  key: number;
  layout: PanelLayout;
  view: View2D;
  camera: Camera3D;
  mode: '2d' | '3d';
  /**
   * A 2D panel on the integer lattice (docs/discrete.md): its view row names
   * index axes, or every row it draws is an automaton or a table. Cell
   * (i, k) is centred on (i, -k), so the down index runs down the page.
   */
  lattice: { axes: readonly [string, string]; written?: readonly [string, string] } | null;
  /** The panel's view(…) / camera(…) row pins it (`locked`). */
  locked: boolean;
  /** The panel's grid(…) row, if any. */
  grid?: GridRowSpec;
  /** Row texts last applied to the live view/camera (see applyViewportRows). */
  appliedViewText: string | null;
  appliedCameraText: string | null;
  /** A camera row's `spin = …` in radians per second. */
  spin: number;
  /** Click-dropped seeds for integral curves through vector fields / ODEs. */
  drops: Array<{ x: number; y: number }>;
  /** What the pointer can grab, in math coords (x and y on a surface);
   *  rebuilt by every 2D or surface frame. */
  grabs: Grabbable[];
  /** The dots a surface panel carries onto its surface, in x and y, for
   *  hover; rebuilt by every frame. */
  surfaceDots: SurfaceDot[];
  /** Set until the panel has a size, when its opening zoom is picked. */
  fresh: boolean;
}

export const r2d = new Renderer2D(gl, quad);
export const r3d = new Renderer3D(gl, quad);

export const defaultCamera = (): Camera3D => ({
  target: [0, 0, 0],
  radius: 14,
  theta: -Math.PI / 3,
  phi: Math.PI / 5.5,
});

function makePanel(key: number): Panel {
  return {
    key,
    layout: { rect: { x: 0, y: 0, w: 0, h: 0 }, host: 0, inset: false, shared: { x: false, y: false } },
    view: { cx: 0, cy: 0, upp: 0.01 },
    camera: defaultCamera(),
    mode: '2d',
    lattice: null,
    locked: false,
    appliedViewText: null,
    appliedCameraText: null,
    spin: 0,
    drops: [],
    grabs: [],
    surfaceDots: [],
    fresh: true,
  };
}

export const panels: Panel[] = [makePanel(0)];
app.activePanel = panels[0];
app.cur = panels[0];
app.view = app.cur.view;
app.camera = app.cur.camera;
app.drops = app.cur.drops;
app.grabbable = app.cur.grabs;
/** The panel gestures and hover act on: the one under the pointer. */

export function usePanel(p: Panel) {
  app.cur = p;
  app.view = p.view;
  app.camera = p.camera;
  app.mode = p.mode;
  app.drops = p.drops;
  app.grabbable = p.grabs;
}

/** Run `fn` with `p` as the current panel. */
export function withPanel<T>(p: Panel, fn: () => T): T {
  const prev = app.cur;
  usePanel(p);
  try {
    return fn();
  } finally {
    usePanel(prev);
  }
}

/** The current panel's size in device pixels. */
export const panelW = () => app.cur.layout.rect.w;
export const panelH = () => app.cur.layout.rect.h;

export const panelOf = (eq: Equation): number => (eq.familyParent ?? eq).panel ?? 0;

/** The current panel's box on the page, in CSS pixels. */
export function panelClientRect(): { left: number; top: number; width: number; height: number } {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const r = app.cur.layout.rect;
  return { left: rect.left + r.x / dpr, top: rect.top + r.y / dpr, width: r.w / dpr, height: r.h / dpr };
}

/** The panel under a client position. */
export function panelAtClient(clientX: number, clientY: number): Panel {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const i = panelAt(
    panels.map(p => p.layout),
    (clientX - rect.left) * dpr,
    (clientY - rect.top) * dpr,
  );
  return panels[i] ?? panels[0];
}

/** Point gestures and hover at `p` from now on. */
export function activate(p: Panel) {
  app.activePanel = p;
  usePanel(p);
}

/**
 * Match the panels to the document's dividers and lay them out in the
 * canvas: one panel per divider plus the first, each with the rows between
 * its divider and the next. A panel is 3D when one of its rows is.
 */
function syncPanels() {
  const rows = equations.map(e => ({ view: e.viewSpec }));
  const splits = splitsOf(rows);
  const byKey = new Map(panels.map(p => [p.key, p]));
  const keys = [0, ...equations.filter(e => e.viewSpec?.kind === 'split').map(e => e.id)];
  panels.splice(0, panels.length, ...keys.map(k => byKey.get(k) ?? makePanel(k)));
  if (!panels.includes(app.activePanel)) app.activePanel = panels[0];
  if (!panels.includes(app.cur)) app.cur = app.activePanel;
  const dpr = window.devicePixelRatio || 1;
  const layout = layoutPanels(splits, canvas.width, canvas.height, Math.round(12 * dpr));
  const wasLattice = new Set(panels.filter(p => p.lattice));
  panels.forEach((p, i) => {
    p.layout = layout[i];
    p.mode = '2d';
    p.lattice = null;
    p.locked = false;
    p.grid = undefined;
    if (p.fresh && p.layout.rect.w && p.layout.rect.h) {
      p.fresh = false;
      p.view.upp = 12 / Math.min(p.layout.rect.w, p.layout.rect.h);
    }
  });
  for (const eq of equations) {
    if (eq.error) continue;
    const p = panels[eq.panel ?? 0] ?? panels[0];
    if (eq.cls?.needs3D) p.mode = '3d';
    const spec = eq.viewSpec;
    // A panel drawing on a surface (on(…)) is 3D.
    if (spec?.kind === 'surface') p.mode = '3d';
    if (spec?.kind === 'grid') p.grid = spec;
    if ((spec?.kind === 'view' || spec?.kind === 'camera') && spec.locked) p.locked = true;
  }
  panels.forEach((p, i) => {
    if (p.mode !== '2d') return;
    const rows = equations.filter(e => !e.error && (e.panel ?? 0) === i);
    const written = (rows.find(e => e.viewSpec?.kind === 'view' && e.viewSpec.axes)?.viewSpec as View2DSpec)?.axes;
    // Readouts draw nothing, so they leave a lattice a lattice.
    const drawn = rows.filter(e => e.cpu && !['value', 'note', 'tuple'].includes(e.cpu.type));
    const cells = drawn.filter(e => e.cpu!.type === 'automaton' || e.cpu!.type === 'lattice');
    // The rows say which index runs across; a view row naming the same two
    // in the other order still frames them (orientLattice).
    const own = (cells[0]?.cpu as Extract<CpuPlan, { type: 'automaton' | 'lattice' }> | undefined)?.axes;
    const agrees = own && written && new Set([...own, ...written]).size === 2;
    if (written) p.lattice = { axes: agrees ? own : written, written };
    else if (own && cells.length === drawn.length) p.lattice = { axes: own };
    // A panel that just became a lattice, with no view row, opens on its cells.
    if (p.lattice && !wasLattice.has(p) && !viewportRow('view', p) && p.layout.rect.w) frameLattice(p, cells);
  });
  usePanel(app.cur);
}

/**
 * The opening window of a lattice panel with no view row: a 1D diagram from
 * its first row down, centred; a board around its origin; a table from cell
 * (0, 0) in the top-left corner, big enough to print its values.
 */
function frameLattice(p: Panel, cells: Equation[]) {
  const { w, h } = p.layout.rect;
  const cpu = cells[0]?.cpu as Parameters<typeof latticeFrame>[0];
  const dpr = window.devicePixelRatio || 1;
  delete p.view.ratio;
  // This runs from syncCanvasSize, ahead of render's own constEnv, which may
  // not yet hold the sliders a table reads (on first load it is empty).
  app.constEnv = currentConstEnv(graphTime());
  Object.assign(p.view, latticeFrame(cpu, app.constEnv, w, h, (LATTICE_VALUE_PX + 30) * dpr));
}

/** The panels owning panel p's shared axes (lib/panels.ts linkRoot); an
 *  axis p does not share is its own. */
export function linkRoots(p: Panel): { x: Panel; y: Panel } {
  const layouts = panels.map(q => q.layout);
  const k = panels.indexOf(p);
  return { x: panels[linkRoot(layouts, k, 'x')] ?? p, y: panels[linkRoot(layouts, k, 'y')] ?? p };
}

/**
 * Carry shared axes between panels (`--- below, shared x`, lib/view.ts
 * linkedWindow). A panel a gesture `moved` first pushes its shared axes up
 * to the panels that own them; then every sharing panel takes them from
 * there, in panel order, so an owner (always earlier) is settled before the
 * panels that follow it. Without `moved` the owners win: a row edited in an
 * owner reaches every panel sharing it. Returns the panels whose window
 * changed.
 */
export function syncLinks(moved: Panel | null): Set<Panel> {
  const changed = new Set<Panel>();
  const assign = (p: Panel, w: View2D) => {
    const v = p.view;
    if (v.cx === w.cx && v.cy === w.cy && v.upp === w.upp && (v.ratio ?? 1) === (w.ratio ?? 1)) return;
    Object.assign(v, w);
    changed.add(p);
  };
  if (moved) {
    const roots = linkRoots(moved);
    const m = moved.view;
    const { shared } = moved.layout;
    if (shared.x && shared.y && roots.x === roots.y) assign(roots.x, { ...m });
    else {
      if (shared.x && roots.x !== moved) assign(roots.x, { ...roots.x.view, cx: m.cx, upp: m.upp });
      if (shared.y && roots.y !== moved) {
        const r = roots.y.view;
        assign(roots.y, { ...r, cy: m.cy, upp: (m.upp / (m.ratio ?? 1)) * (r.ratio ?? 1) });
      }
    }
  }
  for (const p of panels) {
    const roots = linkRoots(p);
    const from = { x: roots.x === p ? undefined : roots.x.view, y: roots.y === p ? undefined : roots.y.view };
    assign(p, linkedWindow(p.view, p.layout.shared, from));
  }
  return changed;
}

/** Point the drawing buffers at the canvas's real CSS box. Returns false while
 *  the element has no box yet (not laid out, hidden), in which case the old
 *  buffer is left alone rather than blanked. Called before every frame as well
 *  as on resize: a buffer whose aspect drifts from the box gets stretched by
 *  CSS, which is what made shared links open squashed and at a random zoom. */
export function syncCanvasSize(): boolean {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (!w || !h) return false;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    overlay.width = w;
    overlay.height = h;
  }
  // The opening scale comes from the buffer we just sized, not from
  // window.innerWidth * devicePixelRatio — those agree only once the page has
  // settled, and a link opened mid-transition would otherwise keep whatever
  // zoom the guess produced. (This supersedes the non-finite-upp repair the
  // hover work carried: the same boot bug, fixed at the source.) Each panel
  // opens at ~12 math units across its short edge (syncPanels).
  syncPanels();
  return true;
}

export function resize() {
  if (app.rendererDisposed) return;
  syncCanvasSize();
  requestRender();
}

let renderQueued = false;
let renderFrame = 0;
/** The frame raymarched surfaces are due to refine in, once at rest. */
let renderTimer: ReturnType<typeof setTimeout> | null = null;
let pausedAt: number | null = null;
let pausedMilliseconds = 0;
export function cancelRender() {
  cancelAnimationFrame(renderFrame);
  if (renderTimer !== null) clearTimeout(renderTimer);
  renderFrame = 0;
  renderTimer = null;
  renderQueued = false;
}
export function requestRender() {
  if (renderQueued || app.rendererDisposed || pausedAt !== null) return;
  renderQueued = true;
  let ran = false;
  const run = () => {
    if (ran) return;
    ran = true;
    cancelRender();
    if (app.rendererDisposed || pausedAt !== null) return;
    render();
  };
  renderFrame = requestAnimationFrame(run);
  // rAF stalls entirely in hidden/occluded tabs (embedded previews,
  // screenshot tooling); a timer backstop keeps frames coming there.
  renderTimer = setTimeout(run, 200);
}

let startTime = performance.now();

/** Seconds since load: the value of `t` everywhere in a graph. */
export const graphTime = () => ((pausedAt ?? performance.now()) - startTime - pausedMilliseconds) / 1000;

export function restartGraphClock() {
  const now = performance.now();
  startTime = now;
  pausedMilliseconds = 0;
  if (pausedAt !== null) pausedAt = now;
}

export function setGraphVisible(visible: boolean) {
  if (app.rendererDisposed) return;
  if (!visible && pausedAt === null) {
    pausedAt = performance.now();
    cancelRender();
  } else if (visible && pausedAt !== null) {
    pausedMilliseconds += performance.now() - pausedAt;
    pausedAt = null;
    requestRender();
  }
}

/** The same current state and constant values for rendering and drag updates. */
export function currentConstEnv(time: number): Record<string, number> {
  if (app.stateSys) stateTime = advanceState(app.defs, app.stateSys, app.stateVals, stateTime, time);
  try {
    return evaluateFrame(app.defs, time, app.stateVals);
  } catch {
    return { ...app.stateVals };
  }
}

/**
 * Send the state system back to its `a(0)` values, and `t` back to 0 with it:
 * a derivative that reads `t` (a driving force) would otherwise restart at a
 * different phase and the run would not retrace the first one.
 */
export function resetState() {
  for (const eq of equations) eq.trail = undefined;
  if (app.stateSys) restartGraphClock();
  app.stateVals = app.stateSys ? initialState(app.defs, app.stateSys) : {};
  stateTime = graphTime();
}
