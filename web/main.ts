import {
  MissingDataError,
  animatedConstNames,
  badTableRow,
  buildDefs,
  compsOf,
  constsAnimated,
  defKey,
  emptyDefs,
  evalConstEnv,
  formatTableRow,
  listGetter,
  listNamesOf,
  nameable,
  resolveExpr,
  scanDefinition,
  usesIntegral,
  TABLE_MAX_ROWS,
  type Definition,
  type Defs,
} from '../lib/defs.ts';
import { buildComb, buildTube, combScale, curveExtent, curveFrames } from '../lib/curve3d.ts';
import {
  type BaseDist,
  type DensityCurve,
  RVSystem,
  buildRVSystem,
  checkDerived,
  densityAt,
  densityExpr,
  matchExpectation,
  matchProbability,
  pdfExpr,
  probabilityValue,
  regionExpr,
  scanRandomRows,
  shadePolygon,
  toExpectation,
  toProbability,
} from '../lib/dist.ts';
import { SLIDER_NUM_RE as NUM_RE, dragAxes } from '../lib/drag.ts';
import { type Expr, evaluate, freeVars, parseExpr, substVars } from '../lib/expr.ts';
import { lowerGeom, pointComps } from '../lib/geom.ts';
import { lowerLists, usesListReduction } from '../lib/list.ts';
import { decodePayload, encodePayload } from '../lib/link.ts';
import { type GridField, angularSpacing, buildGridField, sampleGradMag } from '../lib/grid.ts';
import { type Classified, classify } from '../lib/plot.ts';
import { solveSystem } from '../lib/solve.ts';
import { type SpecialPoint, specialPoints } from '../lib/special.ts';
import { classifySeqRec, scanSeqRec } from '../lib/seq.ts';
import { type StateSystem, advanceState, buildStateSystem, initialState } from '../lib/state.ts';
import { splitStatements } from '../lib/statements.ts';
import {
  type ViewSpec,
  clampPhi,
  fitView2D,
  formatCameraRow,
  formatViewRow,
  parseViewRow,
} from '../lib/view.ts';
import { type Table, tableNameFor } from '../lib/csv.ts';
import { shortHash } from '../lib/hash.ts';
import { ingest, listFiles, loadRefs, lookup as lookupFile, removeFile } from './filestore.ts';
import { fullscreenQuad } from './gl.ts';
import {
  type GridSpec,
  type Layers2D,
  type LevelSpec,
  type Overlay2D,
  Renderer2D,
  type VField2D,
  type View2D,
  drawLabels2D,
  niceSpacing,
} from './render2d.ts';
import { type Camera3D, Renderer3D, type Scene3D, cameraBoxR, drawLabels3D } from './render3d.ts';
import { initPanelResize } from './panel-resize.ts';
import { initPanelSwipe } from './panel-swipe.ts';
import { initTheme, onThemeChange, theme, toggleTheme } from './theme.ts';

interface Equation {
  id: number;
  text: string;
  colorIndex: number;
  cls?: Classified;
  /** The resolved expression behind cls (user functions/fields inlined). */
  parsed?: Expr;
  error?: string;
  /** The error is only that a data file is not on this device, so the message
   *  doubles as the file picker (any row that reads a column, not just the
   *  `open(…)` row that names it). */
  needsFile?: boolean;
  /** Extra readout under the line (e.g. the numeric value of a P(…) row). */
  info?: string;
  /** Set when the row is a definition (`a = 2`, `f(x) = …`) rather than a plot. */
  def?: Definition;
  /** Set when the row is a viewport row (`view(…)` / `camera(…)`). */
  viewSpec?: ViewSpec;
  /** Set when the row is a `# label` comment heading a collapsible group. */
  comment?: boolean;
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
  /** Numeric-list rows: draw bars instead of dots. */
  barMode?: boolean;
  /** Interleaved non-editable widgets, created lazily and kept across edits. */
  sliderUI?: SliderUI;
  levelsBtn?: HTMLButtonElement;
  curveUI?: CurveUI;
  errorEl?: HTMLElement;
  infoEl?: HTMLElement;
  /** Data rows: the collapsible grid of the file's first rows. */
  tableUI?: TableUI;
  /** Cached hover points (axis intercepts/roots) for the cached view range. */
  spCache?: { text: string; env: string; xlo: number; xhi: number; ylo: number; yhi: number; pts: SpecialPoint[] };
  toggleUI?: { box: HTMLElement; btn: HTMLButtonElement };
  /** Cached system solutions for the box and constants they were solved at. */
  sysCache?: { text: string; env: string; lo: number[]; hi: number[]; pts: number[][] };
}

/**
 * An on-screen point the pointer can pick up. `set` writes the dragged
 * position back to whatever defines the point, so the equation list stays the
 * source of truth.
 */
interface Grabbable {
  key: string;
  x: number;
  y: number;
  /** True when `set` rewrites row text (so the drag is undoable and re-saved). */
  edits: boolean;
  set: (x: number, y: number) => void;
}

/** Read-only preview of a data file, under its `open(…)` row. */
interface TableUI {
  box: HTMLDetailsElement;
  summary: HTMLElement;
  scroll: HTMLElement;
  /** The parsed table the grid was built from. Identity is the test: a file
   *  keeps one Table across recompiles, while a filtered copy is rebuilt
   *  whenever anything it depends on moves — exactly when the grid is stale. */
  data?: Table;
}

interface SliderUI {
  box: HTMLElement;
  min: HTMLInputElement;
  range: HTMLInputElement;
  max: HTMLInputElement;
}

/** κ/τ comb toggles for a 3D parametric curve. (The tube radius is not here:
 *  it belongs to tube(…) in the expression, so share links carry it.) */
interface CurveUI {
  box: HTMLElement;
  kappa: HTMLInputElement;
  tau: HTMLInputElement;
}

function cssColor([r, g, b]: [number, number, number]): string {
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

function cssColorA([r, g, b]: [number, number, number], a: number): string {
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
}

const CURVE_SAMPLES = 400;
/** RK4 steps in each direction for a dropped integral curve. */
const ODE_STEPS = 1400;
/** Most integral-curve seeds kept at once; older seeds evict first. */
const MAX_DROPS = 12;
/** Above this many points, a typed-array list draws as a bulk cloud rather
 *  than as individual (outlined, hoverable) points. */
const CLOUD_MIN = 400;
/** Most points a 3D cloud may hold. render3d has no instanced path — every
 *  point is a sprite it sorts and projects — so a 3-column scatter is capped
 *  where a flat one is not, and says so rather than drawing part of the file. */
const CLOUD_3D_MAX = 10_000;
const TUBE_SEGMENTS = 24;

/**
 * The 1…n a value list is drawn against, kept per column. Drawing runs every
 * frame while anything on the page animates, and a 200k-point column would
 * otherwise allocate and fill 1.6 MB of the same numbers each time.
 */
const indexXs = new WeakMap<Float64Array, Float64Array>();
function indexCoords(values: Float64Array): Float64Array {
  let xs = indexXs.get(values);
  if (!xs) {
    xs = new Float64Array(values.length);
    for (let k = 0; k < xs.length; k++) xs[k] = k + 1;
    indexXs.set(values, xs);
  }
  return xs;
}
const COMB_STEP = 4;

// --- state ---

let nextId = 1;
const equations: Equation[] = [];
let mode: '2d' | '3d' = '2d';
let defs: Defs = emptyDefs();
let defsAnimated = false;
let constEnv: Record<string, number> = {};
/** Constants used as Σ/Π bounds; their sliders snap to integer steps. */
let sumBoundNames = new Set<string>();
/** The `a' = …` system being integrated, its current values, and the graph
 *  time they have been carried to. Null when no row defines a state. */
let stateSys: StateSystem | null = null;
let stateVals: Record<string, number> = {};
let stateTime = 0;
/** Compiled coordinate fields; non-empty replaces the Cartesian grid. */
let gridFields: GridField[] = [];
/** Declared random variables and their sample caches (persists across
 *  recompiles; definition-aware caching makes stale samples impossible). */
const rvSys = new RVSystem();
/** Every declared random-variable name, healthy or not. */
let rvNames: ReadonlySet<string> = new Set();
/** Click-dropped seeds for integral curves through vector fields / ODEs. */
const drops: Array<{ x: number; y: number }> = [];
/** What the pointer can grab, in math coords; rebuilt by every 2D frame. */
let grabbable: Grabbable[] = [];
/** Key of the point under the pointer (or being dragged): drawn with a ring. */
let hotPoint: string | null = null;

const view: View2D = { cx: 0, cy: 0, upp: 0.01 };
const camera: Camera3D = { target: [0, 0, 0], radius: 14, theta: -Math.PI / 3, phi: Math.PI / 5.5 };

// --- canvas / renderers ---

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLCanvasElement;
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
const gl = glCtx;
const quad = fullscreenQuad(gl);
const r2d = new Renderer2D(gl, quad);
const r3d = new Renderer3D(gl, quad);
const overlayCtx = overlay.getContext('2d')!;

/** True until the canvas has been measured once and the opening zoom picked. */
let awaitingFirstSize = true;

/** Point the drawing buffers at the canvas's real CSS box. Returns false while
 *  the element has no box yet (not laid out, hidden), in which case the old
 *  buffer is left alone rather than blanked. Called before every frame as well
 *  as on resize: a buffer whose aspect drifts from the box gets stretched by
 *  CSS, which is what made shared links open squashed and at a random zoom. */
function syncCanvasSize(): boolean {
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
  // hover work carried: the same boot bug, fixed at the source.)
  if (awaitingFirstSize) {
    awaitingFirstSize = false;
    view.upp = 12 / Math.min(w, h); // ~12 math units across the short edge
  }
  return true;
}

function resize() {
  syncCanvasSize();
  requestRender();
}

let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  let ran = false;
  const run = () => {
    if (ran) return;
    ran = true;
    renderQueued = false;
    render();
  };
  requestAnimationFrame(run);
  // rAF stalls entirely in hidden/occluded tabs (embedded previews,
  // screenshot tooling); a timer backstop keeps frames coming there.
  setTimeout(run, 200);
}

const startTime = performance.now();

/** Seconds since load: the value of `t` everywhere in a graph. */
const graphTime = () => (performance.now() - startTime) / 1000;

/** Send the state system back to its `a(0)` values, starting from now. */
function resetState() {
  stateVals = stateSys ? initialState(defs, stateSys) : {};
  stateTime = graphTime();
}

// --- viewport rows: the two-way binding ---
//
// A `view(…)` / `camera(…)` row is the framing as document state. Row → view:
// applied before a frame whenever the row's text changed (load, edit, undo,
// popstate). View → row: interaction rewrites the row the way dragging a
// slider rewrites its constant — so the URL always names the exact picture on
// screen. Without a viewport row, interaction stays ephemeral as it always
// was. The applied-text markers make the loop convergent: a writeback marks
// its own text as applied, so the re-apply never snaps the live view to the
// row's rounded numbers mid-gesture.

let appliedViewText: string | null = null;
let appliedCameraText: string | null = null;

/** The viewport row of the given kind, if any (duplicates carry errors). */
function viewportRow(kind: ViewSpec['kind']): Equation | undefined {
  return equations.find(eq => !eq.error && eq.viewSpec?.kind === kind);
}

function applyViewportRows() {
  const vRow = viewportRow('view');
  if (!vRow) appliedViewText = null;
  else if (vRow.text !== appliedViewText && vRow.viewSpec!.kind === 'view') {
    appliedViewText = vRow.text;
    Object.assign(view, fitView2D(vRow.viewSpec!, canvas.width, canvas.height));
  }
  const cRow = viewportRow('camera');
  if (!cRow) appliedCameraText = null;
  else if (cRow.text !== appliedCameraText && cRow.viewSpec!.kind === 'camera') {
    appliedCameraText = cRow.text;
    const c = cRow.viewSpec!;
    camera.theta = c.theta;
    camera.phi = clampPhi(c.phi);
    camera.radius = c.radius ?? 14;
    camera.target = c.target ? [...c.target] : [0, 0, 0];
  }
}

// Pointer moves are hotter than slider inputs, so the row rewrite trails the
// gesture by a beat instead of running per move; release flushes it so the
// row, URL, and undo entry are settled the moment the gesture ends.
let viewportWriteTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleViewportWriteback() {
  viewportWriteTimer ??= setTimeout(() => {
    viewportWriteTimer = null;
    writebackViewport();
  }, 200);
}

function flushViewportWriteback() {
  if (viewportWriteTimer !== null) {
    clearTimeout(viewportWriteTimer);
    viewportWriteTimer = null;
  }
  writebackViewport();
}

function writebackViewport() {
  const eq = viewportRow(mode === '2d' ? 'view' : 'camera');
  if (!eq) return;
  let text: string;
  if (mode === '2d') {
    if (!canvas.width || !canvas.height) return;
    const hw = (canvas.width / 2) * view.upp;
    const hh = (canvas.height / 2) * view.upp;
    text = formatViewRow(view.cx - hw, view.cx + hw, view.cy - hh, view.cy + hh);
  } else {
    text = formatCameraRow(camera);
  }
  if (text === eq.text) return;
  pushUndo(`viewport:${eq.id}`);
  if (mode === '2d') appliedViewText = text;
  else appliedCameraText = text;
  eq.text = text;
  const line = lineEls()[equations.indexOf(eq)];
  if (line) line.textContent = text;
  recompileAll();
  reconcile();
  saveUrl();
}

function render() {
  if (!syncCanvasSize()) return;
  applyViewportRows();
  const dpr = window.devicePixelRatio || 1;
  const time = graphTime();
  const active = equations.filter(e => e.cls && !e.error);
  mode = active.some(e => e.cls!.needs3D) ? '3d' : '2d';

  // States carry between frames, so they are integrated up to now before
  // anything reads them; the constants may then be formulas in those states.
  if (stateSys) stateTime = advanceState(defs, stateSys, stateVals, stateTime, time);
  try {
    constEnv = evalConstEnv(defs, time, stateVals);
  } catch {
    constEnv = { ...stateVals };
  }

  // Fresh joint sample every frame: estimated density curves shimmer with
  // their true sampling noise instead of freezing one pairing into wiggles
  // that read as structure. Exact laws don't sample and are unaffected.
  if (rvSys.size() > 0) rvSys.resample();

  gl.clearColor(theme.bg[0], theme.bg[1], theme.bg[2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  // CPU sampling of parametric curves / points, with t bound to seconds.
  const sampleCurve = (eq: Equation, dim: 2 | 3): number[] => {
    const { comps } = eq.cls!.plot as { comps: import('../lib/expr.ts').Expr[] };
    const out: number[] = [];
    for (let k = 0; k < CURVE_SAMPLES; k++) {
      const u = k / (CURVE_SAMPLES - 1);
      for (let c = 0; c < dim; c++) {
        try {
          out.push(evaluate(comps[c], { ...constEnv, u, t: time }));
        } catch {
          out.push(NaN);
        }
      }
    }
    return out;
  };
  // RK4 streamline of the normalized field through (x0, y0), both directions.
  // Normalizing makes it a direction field: uniform arc-length steps, and the
  // same trajectories (dy/dx = f slope fields integrate as (1, f) normalized).
  const integralCurve = (comps: [Expr, Expr], x0: number, y0: number, time: number): number[] => {
    const env: Record<string, number> = { ...constEnv, t: time, x: 0, y: 0 };
    const f = (x: number, y: number): [number, number] | null => {
      env.x = x;
      env.y = y;
      let vx: number, vy: number;
      try {
        vx = evaluate(comps[0], env);
        vy = evaluate(comps[1], env);
      } catch {
        return null;
      }
      const m = Math.hypot(vx, vy);
      if (!isFinite(m) || m < 1e-12) return null;
      return [vx / m, vy / m];
    };
    const h = 2.5 * view.upp; // ~2.5 px of arc per step
    const boundW = 1.5 * gl.drawingBufferWidth * view.upp;
    const boundH = 1.5 * gl.drawingBufferHeight * view.upp;
    const side = (sgn: number): number[] => {
      const out: number[] = [];
      let x = x0;
      let y = y0;
      for (let i = 0; i < ODE_STEPS; i++) {
        const k1 = f(x, y);
        if (!k1) break;
        const k2 = f(x + sgn * (h / 2) * k1[0], y + sgn * (h / 2) * k1[1]);
        if (!k2) break;
        const k3 = f(x + sgn * (h / 2) * k2[0], y + sgn * (h / 2) * k2[1]);
        if (!k3) break;
        const k4 = f(x + sgn * h * k3[0], y + sgn * h * k3[1]);
        if (!k4) break;
        x += sgn * (h / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
        y += sgn * (h / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
        if (!isFinite(x) || !isFinite(y)) break;
        out.push(x, y);
        if (Math.abs(x - view.cx) > boundW || Math.abs(y - view.cy) > boundH) break;
      }
      return out;
    };
    const back = side(-1);
    const pts: number[] = [];
    for (let i = back.length - 2; i >= 0; i -= 2) pts.push(back[i], back[i + 1]);
    pts.push(x0, y0);
    pts.push(...side(1));
    return pts;
  };

  const samplePoint = (eq: Equation): number[] | null => {
    const { coords } = eq.cls!.plot as { coords: import('../lib/expr.ts').Expr[] };
    try {
      const p = coords.map(c => evaluate(c, { ...constEnv, t: time }));
      return p.every(isFinite) ? p : null;
    } catch {
      return null;
    }
  };

  // Evaluate a symbolic derivative vector at the curve samples; NaN on failure.
  const sampleDeriv = (es: import('../lib/expr.ts').Expr[] | undefined): Float32Array | undefined => {
    if (!es) return undefined;
    const out = new Float32Array(CURVE_SAMPLES * 3);
    for (let k = 0; k < CURVE_SAMPLES; k++) {
      const u = k / (CURVE_SAMPLES - 1);
      for (let c = 0; c < 3; c++) {
        try {
          out[k * 3 + c] = evaluate(es[c], { ...constEnv, u, t: time });
        } catch {
          out[k * 3 + c] = NaN;
        }
      }
    }
    return out;
  };

  const grabs: Grabbable[] = [];

  /**
   * Solutions of a square system over the box in view, cached until the text,
   * constants, or box change materially — the same bargain pointsFor() makes
   * for intercepts. A solve costs tens of milliseconds, far too much to repeat
   * on every rotate, so it runs over a padded box that small pans and zooms
   * stay inside.
   */
  const solveFor = (eq: Equation, dim: 2 | 3, residuals: Expr[]): number[][] => {
    const cls = eq.cls!;
    let vlo: number[];
    let vhi: number[];
    if (dim === 3) {
      const r = cameraBoxR(camera);
      vlo = [-r, -r, -r];
      vhi = [r, r, r];
    } else {
      const dpr = window.devicePixelRatio || 1;
      const halfW = ((canvas.clientWidth * dpr) / 2) * view.upp;
      const halfH = ((canvas.clientHeight * dpr) / 2) * view.upp;
      vlo = [view.cx - halfW, view.cy - halfH];
      vhi = [view.cx + halfW, view.cy + halfH];
    }
    const envKey = cls.params.map(p => `${p}=${constEnv[p] ?? 0}`).join(',')
      + (cls.animated ? `,t=${time}` : '');
    const c = eq.sysCache;
    if (c && c.text === eq.text && c.env === envKey && c.lo.length === dim
      && vlo.every((v, k) => c.lo[k] <= v && c.hi[k] >= vhi[k] && c.hi[k] - c.lo[k] <= 6 * (vhi[k] - v))) {
      return c.pts;
    }
    const pad = vhi.map((v, k) => 0.25 * (v - vlo[k]));
    const lo = vlo.map((v, k) => v - pad[k]);
    const hi = vhi.map((v, k) => v + pad[k]);
    const pts = solveSystem(residuals, dim === 3 ? ['x', 'y', 'z'] : ['x', 'y'], lo, hi, {
      env: { ...constEnv, t: time },
    });
    eq.sysCache = { text: eq.text, env: envKey, lo, hi, pts };
    return pts;
  };

  if (mode === '3d') {
    const scene: Scene3D = { implicits: [], psurfaces: [], curves: [], segments: [], tubes: [], points: [] };
    for (const eq of active) {
      const color = theme.palette[eq.colorIndex];
      const plot = eq.cls!.plot;
      const params = eq.cls!.params;
      switch (plot.type) {
        case 'implicit2d': // extrudes to its true locus (a vertical sheet)
          scene.implicits.push({ field: plot.field, color, params });
          break;
        case 'implicit3d':
          scene.implicits.push({ field: plot.field, grad: plot.grad, color, params });
          break;
        case 'scalar2d':
        case 'complex2d':
        case 'domain2d':
        case 'conformal2d':
        case 'fractal2d':
        case 'ineq2d':
        case 'vfield2d':
        case 'polygon':
        case 'vlist':
        case 'dlist':
        case 'histogram':
        case 'sequence':
        case 'cobweb':
        case 'bifurcation':
        case 'density':
        case 'prob':
        case 'expect':
          break; // 2D-only plots (densities, flows, sequences, planar figures); skipped in 3D scenes
        case 'dscatter': {
          // One sprite per point (see CLOUD_3D_MAX); the row is rejected at
          // compile time if there are more than that, so nothing is dropped
          // here. A gap in ANY coordinate skips the point — an unplaced z
          // would otherwise reach projection and depth sorting as NaN.
          const [xs, ys, zs] = plot.coords;
          for (let k = 0; k < xs.length; k++) {
            const z = zs ? zs[k] : 0;
            if (isFinite(xs[k]) && isFinite(ys[k]) && isFinite(z)) {
              scene.points.push({ pos: [xs[k], ys[k], z], color });
            }
          }
          break;
        }
        case 'plist': {
          const env = { ...constEnv, t: time };
          for (const comps of plot.pts) {
            try {
              const p = comps.map(c => evaluate(c, env));
              if (p.every(isFinite)) scene.points.push({ pos: [p[0], p[1], p[2] ?? 0], color });
            } catch { /* skip unevaluable points */ }
          }
          break;
        }
        case 'psurface':
          scene.psurfaces.push({ comps: plot.comps, du: plot.du, dv: plot.dv, color, params });
          break;
        case 'pcurve': {
          const flat = sampleCurve(eq, plot.dim);
          const pts = new Float32Array(CURVE_SAMPLES * 3);
          for (let k = 0; k < CURVE_SAMPLES; k++) {
            pts[k * 3] = flat[k * plot.dim];
            pts[k * 3 + 1] = flat[k * plot.dim + 1];
            pts[k * 3 + 2] = plot.dim === 3 ? flat[k * plot.dim + 2] : 0;
          }
          // Tubes are opt-in through tube(…): a bare curve stays a line, so
          // it never hides points or curves sharing the scene. The radius may
          // use sliders and t; while it evaluates ≤ 0 (say, mid slider drag)
          // the curve draws as a bare line instead of an inside-out tube.
          let radius = 0;
          if (plot.dim === 3 && plot.tube) {
            try {
              const r = evaluate(plot.tube, { ...constEnv, t: time });
              if (isFinite(r) && r > 0) radius = r;
            } catch { /* unevaluable this frame: draw the bare curve */ }
          }
          const combs = plot.dim === 3 && (eq.combK || eq.combT);
          if (radius <= 0 && !combs) {
            scene.curves.push({ pts, color });
            break;
          }
          const fr = curveFrames(pts, sampleDeriv(plot.d1), sampleDeriv(plot.d2), sampleDeriv(plot.d3));
          if (radius > 0) {
            scene.tubes.push({ ...buildTube(pts, fr, radius, TUBE_SEGMENTS), color });
          } else {
            scene.curves.push({ pts, color });
          }
          const extent = curveExtent(pts);
          if (eq.combK) {
            // Teeth point along −N (away from the center of curvature).
            const kColor: [number, number, number] = [color[0] * 0.7, color[1] * 0.7, color[2] * 0.7];
            const comb = buildComb(pts, fr.frenetNormal, fr.kappa, -combScale(fr.kappa, extent), COMB_STEP);
            scene.segments.push({ pts: comb.teeth, color: kColor });
            scene.curves.push({ pts: comb.tips, color: kColor });
          }
          if (eq.combT) {
            // Signed teeth along ±B expose where torsion changes hand.
            const tColor: [number, number, number] = [
              color[0] * 0.45 + 0.25, color[1] * 0.45 + 0.25, color[2] * 0.45 + 0.25,
            ];
            const comb = buildComb(pts, fr.frenetBinormal, fr.tau, combScale(fr.tau, extent), COMB_STEP);
            scene.segments.push({ pts: comb.teeth, color: tColor });
            scene.curves.push({ pts: comb.tips, color: tColor });
          }
          break;
        }
        case 'point': {
          const p = samplePoint(eq);
          if (p) scene.points.push({ pos: [p[0], p[1], p[2] ?? 0], color });
          break;
        }
        case 'system':
          for (const p of solveFor(eq, plot.dim, plot.residuals)) {
            scene.points.push({ pos: [p[0], p[1], p[2] ?? 0], color });
          }
          break;
      }
    }
    r3d.render(camera, scene, time, constEnv);
    drawLabels3D(overlayCtx, camera, dpr);
  } else {
    const layers: Required<Layers2D> = {
      levels: [], fractals: [], domains: [], conformals: [], vfields: [],
      ineqs: [], bifs: [], scalars: [], complexes: [], curves: [],
    };
    const extras: Overlay2D = { points: [], polylines: [], bars: [], clouds: [] };
    // Spacing for any level-set family (custom grids, contour stacks): sample
    // |∇c| around the view to convert the target pixel gap into coordinate
    // units (π-based for angles).
    const halfW = (gl.drawingBufferWidth / 2) * view.upp;
    const halfH = (gl.drawingBufferHeight / 2) * view.upp;
    const xmin = view.cx - halfW;
    const xmax = view.cx + halfW;
    const viewPts: Array<[number, number]> = [
      [view.cx, view.cy],
      [view.cx - halfW / 2, view.cy], [view.cx + halfW / 2, view.cy],
      [view.cx, view.cy - halfH / 2], [view.cx, view.cy + halfH / 2],
    ];
    const env: Record<string, number> = { ...constEnv, t: time };
    const seedOf = (a0Name?: string): number => (a0Name !== undefined ? constEnv[a0Name] : undefined) ?? 0.5;
    const levelSpacing = (f: GridField) => {
      const cupp = sampleGradMag(f, viewPts, env, view.upp * 4) * view.upp;
      return f.angular ? angularSpacing(cupp, 90) : niceSpacing(cupp, 90);
    };
    for (const eq of active) {
      const color = theme.palette[eq.colorIndex];
      const css = cssColor(color);
      const plot = eq.cls!.plot;
      const params = eq.cls!.params;
      switch (plot.type) {
        case 'implicit2d':
          layers.curves.push({ field: plot.field, color, params });
          if (eq.showLevels && plot.levels) {
            const f = plot.levels;
            const sp = levelSpacing(f);
            layers.levels.push({ glsl: f.glsl, gradGlsl: f.gradGlsl, params: f.params, major: sp.major, minor: sp.minor, color });
          }
          break;
        case 'ineq2d': layers.ineqs.push({ field: plot.field, edges: plot.edges, color, params }); break;
        case 'scalar2d': layers.scalars.push({ field: plot.field, color, params }); break;
        case 'complex2d': layers.complexes.push({ field: plot.field, color, params }); break;
        case 'domain2d': layers.domains.push({ field: plot.field, color, params }); break;
        case 'conformal2d': layers.conformals.push({ field: plot.field, color, params }); break;
        case 'fractal2d':
          layers.fractals.push({ step: plot.step, seed: plot.seed, maxIter: plot.maxIter, color, params });
          break;
        case 'vfield2d': {
          layers.vfields.push({ fx: plot.fx, fy: plot.fy, color, params });
          drops.forEach((d, i) => {
            extras.polylines.push({ pts: integralCurve(plot.comps, d.x, d.y, time), color: css });
            extras.points.push({ x: d.x, y: d.y, color: css, hot: hotPoint === `drop${i}` });
          });
          break;
        }
        case 'pcurve': extras.polylines.push({ pts: sampleCurve(eq, 2), color: css }); break;
        case 'polygon': {
          const pts: number[] = [];
          try {
            for (const c of plot.pts) pts.push(evaluate(c, env));
          } catch {
            break;
          }
          if (!pts.every(isFinite)) break;
          extras.polylines.push({
            pts,
            color: css,
            closed: plot.closed,
            fill: plot.closed ? cssColorA(color, 0.16) : undefined,
          });
          break;
        }
        case 'point': {
          const p = samplePoint(eq);
          if (!p) break;
          const key = `eq${eq.id}`;
          extras.points.push({ x: p[0], y: p[1], color: css, hot: hotPoint === key });
          const set = pointWriter(eq);
          if (set) grabs.push({ key, x: p[0], y: p[1], edits: true, set });
          break;
        }
        case 'vlist': {
          plot.values.forEach((expr, k) => {
            let v: number;
            try { v = evaluate(expr, env); } catch { return; }
            if (!isFinite(v)) return;
            if (eq.barMode) extras.bars!.push({ x: k + 1, y: v, halfWidth: 0.35, color: css });
            else extras.points.push({ x: k + 1, y: v, color: css, r: 4 });
          });
          break;
        }
        case 'plist': {
          // A handful of points read as points; a few thousand read as a
          // cloud, where fat outlined dots would merge into one white smear.
          const dense = plot.pts.length > 200;
          const r = dense ? 2 : 4;
          for (const comps of plot.pts) {
            try {
              const px = evaluate(comps[0], env);
              const py = evaluate(comps[1], env);
              if (isFinite(px) && isFinite(py)) extras.points.push({ x: px, y: py, color: css, r, bare: dense });
            } catch { /* skip unevaluable points */ }
          }
          break;
        }
        // Typed-array lists: nothing to evaluate, so the only question is how
        // to draw them. Few enough to read as individual points, and they go
        // through the same path as any other point (outlines, bars); past
        // that they are a cloud, drawn in bulk.
        case 'dlist': {
          const { values } = plot;
          if (values.length <= CLOUD_MIN) {
            values.forEach((v, k) => {
              if (!isFinite(v)) return;
              if (eq.barMode) extras.bars!.push({ x: k + 1, y: v, halfWidth: 0.35, color: css });
              else extras.points.push({ x: k + 1, y: v, color: css, r: 4 });
            });
            break;
          }
          extras.clouds!.push({ xs: indexCoords(values), ys: values, color: css });
          break;
        }
        case 'dscatter': {
          if (plot.dim === 3) break; // drawn in the 3D pass
          const [xs, ys] = plot.coords;
          if (xs.length <= CLOUD_MIN) {
            for (let k = 0; k < xs.length; k++) {
              if (isFinite(xs[k]) && isFinite(ys[k])) {
                extras.points.push({ x: xs[k], y: ys[k], color: css, r: 4 });
              }
            }
            break;
          }
          extras.clouds!.push({ xs, ys, color: css });
          break;
        }
        case 'histogram': {
          const { centers, counts, width } = plot;
          for (let k = 0; k < centers.length; k++) {
            extras.bars!.push({ x: centers[k], y: counts[k], halfWidth: width / 2, color: css });
          }
          break;
        }
        case 'sequence': {
          // Dots at integer n in view; partial-sum mode accumulates from n = 0
          // (terms that are not finite, like 1/0², are skipped).
          const termAt = (n: number): number => {
            env[plot.index] = n;
            try { return evaluate(plot.term, env); } catch { return NaN; }
          };
          const nEnd = Math.min(Math.floor(xmax), eq.partialSum ? 20000 : 100000);
          const n0 = Math.max(0, Math.ceil(xmin));
          const step = Math.max(1, Math.ceil((nEnd - n0 + 1) / 4000));
          if (eq.partialSum) {
            let sum = 0;
            let started = false;
            for (let n = 0; n <= nEnd; n++) {
              const v = termAt(n);
              if (isFinite(v)) { sum += v; started = true; }
              if (started && n >= n0 && (n - n0) % step === 0) {
                extras.points.push({ x: n, y: sum, color: css, r: 3.5 });
              }
            }
          } else {
            for (let n = n0; n <= nEnd; n += step) {
              const v = termAt(n);
              if (isFinite(v)) extras.points.push({ x: n, y: v, color: css, r: 3.5 });
            }
          }
          delete env[plot.index];
          break;
        }
        case 'cobweb': {
          layers.curves.push({ field: plot.curveField, color, params });
          const seed = seedOf(plot.a0Name);
          const dLo = Math.max(xmin, view.cy - halfH);
          const dHi = Math.min(xmax, view.cy + halfH);
          if (dHi > dLo) {
            // y = x, the guide the orbit reflects off; kept lighter than the axes.
            extras.polylines.push({ pts: [dLo, dLo, dHi, dHi], color: cssColorA(theme.axis, 0.45), width: 1 });
          }
          const pts: number[] = [seed, seed];
          let a = seed;
          for (let k = 0; k < 80; k++) {
            env[plot.recVar] = a;
            let b: number;
            try { b = evaluate(plot.f, env); } catch { break; }
            if (!isFinite(b) || Math.abs(b) > 1e9) break;
            pts.push(a, b, b, b);
            a = b;
          }
          delete env[plot.recVar];
          extras.polylines.push({ pts, color: css, width: 1.5 });
          extras.points.push({ x: seed, y: seed, color: css, r: 3.5 });
          break;
        }
        case 'bifurcation':
          layers.bifs.push({ field: plot.field, color, params, uniforms: { uSeed: seedOf(plot.a0Name) } });
          break;
        case 'density': {
          let c: DensityCurve | null = null;
          try {
            c = rvSys.curve(plot.rv, env, { lo: xmin, hi: xmax });
          } catch { break; /* a parameter is missing this frame */ }
          if (!c) break;
          if (c.pts.length >= 4) extras.polylines.push({ pts: c.pts, color: css, width: 2 });
          // Point masses draw as probability stems (height = mass, not density).
          for (const a of c.atoms ?? []) {
            extras.polylines.push({ pts: [a.x, 0, a.x, a.p], color: css, width: 2 });
            extras.points.push({ x: a.x, y: a.p, color: css, r: 4 });
          }
          break;
        }
        case 'prob': {
          // The estimate lives in the row's readout; the plot is the shaded
          // area under the variable's density, when the body has that shape.
          if (!plot.shade) break;
          try {
            const c = rvSys.curve(plot.shade.rv, env, { lo: xmin, hi: xmax });
            if (!c) break;
            const lo = plot.shade.lo ? evaluate(plot.shade.lo, env) : undefined;
            const hi = plot.shade.hi ? evaluate(plot.shade.hi, env) : undefined;
            const poly = shadePolygon(c, lo, hi);
            if (poly) {
              extras.polylines.push({ pts: poly, color: css, closed: true, fill: cssColorA(color, 0.16) });
            }
          } catch { /* not evaluable this frame */ }
          break;
        }
        case 'expect': {
          // The value lives in the row's readout; the plot is a vertical
          // marker at x = E under the variable's density.
          try {
            const m = rvSys.mean(plot.rv, env);
            if (!isFinite(m)) break;
            const exact = rvSys.exactDist(plot.rv);
            let h = exact
              ? evaluate(pdfExpr(exact, { kind: 'num', value: m }), env)
              : (c => (c ? densityAt(c, m) : 0))(rvSys.curve(plot.rv, env, { lo: xmin, hi: xmax }));
            if (!isFinite(h) || h < 0) h = 0;
            if (h > 0) extras.polylines.push({ pts: [m, 0, m, h], color: css, width: 2 });
            extras.points.push({ x: m, y: h, color: css, r: 4 });
          } catch { /* not evaluable this frame */ }
          break;
        }
        case 'system':
          // A 3-unknown system forces the 3D view, so only 2D lands here.
          if (plot.dim === 2) {
            for (const p of solveFor(eq, 2, plot.residuals)) {
              extras.points.push({ x: p[0], y: p[1], color: cssColor(color) });
            }
          }
          break;
      }
    }
    // Named points (`A = (0, 0)` rows) draw labeled with their name; rows
    // whose components are plain numbers or slider names can be dragged.
    for (const eq of equations) {
      if (eq.def?.kind !== 'const' || eq.error || !defs.points.has(eq.def.name)) continue;
      const [cx, cy] = pointComps(eq.def.name);
      const px = constEnv[cx];
      const py = constEnv[cy];
      if (!isFinite(px) || !isFinite(py)) continue;
      const key = `def${eq.id}`;
      extras.points.push({
        x: px,
        y: py,
        color: cssColor(theme.palette[eq.colorIndex]),
        hot: hotPoint === key,
        label: eq.def.name,
      });
      const set = defPointWriter(eq);
      if (set) grabs.push({ key, x: px, y: py, edits: true, set });
    }
    // A seed is one grabbable point however many fields trace a curve from it.
    if (layers.vfields.length) {
      drops.forEach((d, i) => grabs.push({
        key: `drop${i}`,
        x: d.x,
        y: d.y,
        edits: false,
        set: (x, y) => { d.x = x; d.y = y; },
      }));
    }
    let gridSpecs: GridSpec[] | undefined;
    if (gridFields.length) {
      gridSpecs = gridFields.map(f => {
        const sp = levelSpacing(f);
        return { glsl: f.glsl, gradGlsl: f.gradGlsl, params: f.params, major: sp.major, minor: sp.minor };
      });
    }
    r2d.render(view, layers, time, constEnv, gridSpecs);
    drawLabels2D(overlayCtx, view, dpr, extras, !gridFields.length);
    drawHoverMarker(dpr);
  }
  grabbable = grabs;

  const gridAnimated = mode === '2d'
    && gridFields.some(f => freeVars(f.expr).has('t') || (defsAnimated && f.params.length > 0));
  // A state system is never at rest: keep frames coming so it keeps stepping.
  if (stateSys || gridAnimated
    || active.some(e => e.cls!.animated || (defsAnimated && e.cls!.params.length > 0))) {
    requestRender();
  }
}

// --- equation list UI ---
//
// One contentEditable document: each equation is a `.eq-line` div, so a whole
// system of equations can be selected, copied, and pasted as plain text.
// Sliders and error messages are `contenteditable=false` `.eq-widget` blocks
// interleaved between lines; they live outside the text model (copy/cut skip
// them) and are reconciled from state after every edit.

const listEl = document.getElementById('equations')!;
/** Shown only while a state system exists; sends it back to its `a(0)`s. */
const stateResetBtn = document.getElementById('state-reset') as HTMLButtonElement | null;

/**
 * Recompile every row: scan definitions first (they affect how every other
 * row parses), then classify the plot rows against them. Cheap enough to run
 * on every keystroke.
 */
function recompileAll() {
  // Random-variable rows resolve outside the definition system: `X ~ …` is
  // never a definition, and `Y = X^2` with X random declares a *derived*
  // random variable, not a constant. The scan is transitive (`Z = Y + 1`
  // follows Y into the set), so it must see the whole document first.
  const rvScan = scanRandomRows(equations.map(eq => {
    const text = eq.text.trim();
    return !text || text.startsWith('#') || scanSeqRec(text) ? null : text;
  }));
  const rvRowIdx = new Set([...rvScan.base.keys(), ...rvScan.derived.keys()]);

  const raw: Definition[] = [];
  const defRows = new Map<string, Equation>();
  const dupRows: Equation[] = [];
  for (const [i, eq] of equations.entries()) {
    eq.cls = undefined;
    eq.parsed = undefined;
    eq.error = undefined;
    eq.needsFile = undefined;
    eq.info = undefined;
    eq.def = undefined;
    eq.viewSpec = undefined;
    eq.spCache = undefined;
    const text = eq.text.trim();
    eq.comment = text.startsWith('#');
    if (!eq.comment) eq.collapsed = undefined;
    if (!text || eq.comment) continue;
    if (rvRowIdx.has(i)) continue;
    // Sequence/recurrence rows (a_n = …, a_{n+1} = …) are plots, not definitions.
    if (scanSeqRec(text)) continue;
    const d = scanDefinition(text);
    if (!d) continue;
    eq.def = d;
    if (defRows.has(defKey(d))) {
      dupRows.push(eq);
      continue;
    }
    defRows.set(defKey(d), eq);
    raw.push(d);
  }

  // Data files resolve out of the local store, which is already in memory:
  // this runs on every keystroke, so nothing here may await (see filestore.ts).
  const built = buildDefs(raw, ref => lookupFile(ref.file, ref.hash)?.table ?? null);
  defs = built.defs;
  ensureTables(raw);
  for (const [name, table] of defs.tables) {
    const row = defRows.get(name);
    if (!row || row.error || !table.data) continue;
    const cols = table.data.columns.map(c => (c.type === 'num' ? c.name : `${c.name} (text)`));
    row.info = [`${table.data.rows} rows`, cols.join(', '), ...table.data.warnings].join(' · ');
  }
  // A state moves every frame, so anything reading one is animated too.
  defsAnimated = constsAnimated(defs) || defs.states.size > 0;
  sumBoundNames = built.sumBoundConsts;
  for (const [name, message] of built.errors) {
    const row = defRows.get(name);
    if (!row) continue;
    row.error = message;
    row.needsFile = built.needsFile.has(name);
  }

  // A second row naming something already defined is a plot, not a
  // redefinition: `r = 1 + cos(theta)` is a curve in the coordinate system r,
  // and `P(x,y,z) = -1/4` is a level set of the function P defined above
  // (with a vector right-hand side, the fiber of a map).
  for (const eq of dupRows) {
    const { name, kind } = eq.def!;
    // A row identical to the one that defined the name is a duplicate, not a
    // level set: `f(x) = x^2` twice means f = f, which is true everywhere and
    // would flood the view rather than say so.
    const levelSet = kind === 'fn' && defs.fns.has(name)
      && eq.text.trim() !== defRows.get(name)?.text.trim();
    if (defs.fields.has(name) || levelSet) eq.def = undefined;
    else eq.error = `${defKey(eq.def!)} is already defined.`;
  }

  // States are constants as far as every consumer is concerned — uniforms in
  // GLSL, entries in constEnv on the CPU — so they join the same name set.
  const constNames = new Set([...defs.consts.keys(), ...defs.states.keys()]);
  const wasKey = stateSys?.key;
  stateSys = buildStateSystem(defs);
  // Editing an unrelated row must not restart a run in progress; editing the
  // system or its starting values must.
  if (stateSys?.key !== wasKey) resetState();

  gridFields = [];
  for (const [name, e] of defs.fields) {
    try {
      gridFields.push(buildGridField(name, e, constNames));
    } catch (e) {
      const row = defRows.get(name);
      if (row && !row.error) row.error = e instanceof Error ? e.message : String(e);
    }
  }
  const fieldEnv = Object.fromEntries(defs.fields);
  const fnNames = new Set(raw.filter(d => d.kind === 'fn').map(d => d.name));
  const listNames = listNamesOf(defs);
  const getList = listGetter(defs);
  const getFn = (name: string) => {
    const fn = defs.fns.get(name);
    if (!fn && fnNames.has(name)) throw new Error(`${name} has an error in its definition.`);
    return fn;
  };
  // Σ/Π bounds in plot rows expand against the constants' current values
  // (animated ones excluded: expansion is static, so t may not reach bounds).
  let constVals: Record<string, number> = {};
  try {
    constVals = evalConstEnv(defs, 0, stateVals);
  } catch { /* a broken definition; bounds using it will report the error */ }
  for (const name of animatedConstNames(defs)) delete constVals[name];
  for (const name of defs.states.keys()) delete constVals[name];
  const ropts = { consts: constVals, boundConsts: sumBoundNames };

  // Random-variable rows resolve before plot rows so P(…) and bare
  // expressions can reference them regardless of row order.
  const builtRVs = buildRVSystem(rvSys, rvScan, {
    fnNames,
    getFn,
    ropts,
    constNames,
    taken: n => defs.consts.has(n) || defs.fns.has(n) || defs.fields.has(n)
      || defs.states.has(n) || defs.points.has(n) || defs.mats.has(n) || defs.lists.has(n)
      || defs.tables.has(n),
  });
  rvNames = builtRVs.names;
  const distRows = new Set<Equation>();
  // Readout environment: constants at t = 0. Animated or state-fed variables
  // simply skip their readout (the sampler throws on the missing name).
  let envT0: Record<string, number> | null = null;
  try {
    envT0 = evalConstEnv(defs, 0);
  } catch { /* a broken constant: rows using it already carry errors */ }
  const rvInfo = (eq: Equation, name: string) => {
    if (!envT0) return;
    try {
      // Exact moments where the law has a closed form; the sample estimate
      // (with its ≈) everywhere else.
      const m = rvSys.exactMoments(name, envT0);
      if (m && isFinite(m.mean) && isFinite(m.sd)) {
        eq.info = `μ = ${fmtNum(m.mean)}, σ = ${fmtNum(m.sd)}`;
        return;
      }
      // One-variable transforms integrate against the base pdf (quadrature):
      // still ≈, but good to display precision rather than sampling noise.
      const s = rvSys.quadMoments(name, envT0) ?? rvSys.curve(name, envT0);
      if (!s) return;
      // Heavy tails make μ/σ truncation artifacts (1/W through a pole has
      // no finite moments): show robust location/spread instead of noise.
      const r = (s as Partial<DensityCurve>).robust;
      eq.info = (r
        ? `median ≈ ${r.median.toFixed(3)}, IQR ≈ ${r.iqr.toFixed(3)} (heavy tails: μ, σ unstable)`
        : `μ ≈ ${s.mean.toFixed(3)}, σ ≈ ${s.sd.toFixed(3)}`)
        + (s.mass < 0.9995 ? `, P(defined) ≈ ${s.mass.toFixed(3)}` : '');
    } catch { /* not numerically computable right now (e.g. animated) */ }
  };
  // A derived variable whose law is a closed-form pdf (affine in normals, or
  // a single scaled uniform/exponential) plots exactly through the shader; a
  // uniform-sum law plots its exact piecewise polynomial via curve(); only
  // the rest estimate from samples.
  const classifyDerived = (eq: Equation, name: string) => {
    const exact = rvSys.exactDist(name);
    if (exact && rvSys.get(name)!.kind === 'derived') {
      eq.cls = classify(densityExpr(exact), constNames);
    } else {
      eq.cls = densityCls(name);
    }
    rvInfo(eq, name);
  };
  const densityCls = (name: string): Classified => {
    const ps = rvSys.paramsOf(name);
    return {
      plot: { type: 'density', rv: name },
      animated: ps.has('t'),
      needs3D: false,
      params: [...ps].filter(p => p !== 't'),
    };
  };
  for (const [i, name] of builtRVs.rowRV) {
    const eq = equations[i];
    distRows.add(eq);
    const message = builtRVs.errors.get(i);
    if (message) {
      eq.error = message;
      continue;
    }
    const rv = rvSys.get(name)!;
    if (rv.kind === 'base') {
      eq.cls = classify(densityExpr(rv.dist), constNames);
    } else {
      classifyDerived(eq, name);
    }
  }

  const seenViewport = new Set<string>();
  for (const eq of equations) {
    if (eq.def || eq.comment || distRows.has(eq)) continue;
    const text = eq.text.trim();
    if (!text) continue;
    try {
      const badRow = badTableRow(text);
      if (badRow) throw new Error(badRow);
      const vspec = parseViewRow(text, constVals);
      if (vspec) {
        if (seenViewport.has(vspec.kind)) throw new Error(`${vspec.kind} is already set by another row.`);
        seenViewport.add(vspec.kind);
        eq.viewSpec = vspec;
        continue;
      }
      const probBody = defs.consts.has('P') || defs.fns.has('P') ? null : matchProbability(text);
      if (probBody !== null) {
        if (!rvNames.size) throw new Error('Define a random variable first, e.g. X ~ Normal(0, 1).');
        const p = toProbability(resolveExpr(parseExpr(probBody, fnNames), getFn, ropts), rvNames);
        for (const name of p.rvs) {
          if (!rvSys.has(name)) throw new Error(`${name} has an error in its definition.`);
        }
        // Bounds around an inline expression (`P(0.5 < X + Y < 1.5)`) become
        // bounds on an anonymous derived variable, so exactness and shading
        // work exactly as for a named one.
        let single = p.single;
        if (!single && p.inline) {
          checkDerived(p.inline.e, rvNames, constNames);
          const anon = `@P${eq.id}`;
          rvSys.add({ name: anon, kind: 'derived', expr: p.inline.e });
          single = { rv: anon, lo: p.inline.lo, hi: p.inline.hi };
        }
        // Constant bounds on one variable whose law is a closed-form pdf get
        // the exact CDF and the shader-drawn region.
        const exact = single ? rvSys.exactDist(single.rv) : null;
        if (single && exact) {
          eq.cls = classify(regionExpr(exact, single.lo, single.hi), constNames);
          try {
            const value = probabilityValue(exact, single.lo, single.hi, evalConstEnv(defs, 0));
            if (isFinite(value)) eq.info = `≈ ${value.toFixed(4)}`;
          } catch {
            // Not numerically computable right now (e.g. animated); no readout.
          }
        } else {
          // Everything else draws/estimates through the sampled channel —
          // but a uniform-sum law still gets its exact value (and its shade
          // fills under the exact piecewise-polynomial curve).
          const ps = rvSys.bodyParams(p.body);
          eq.cls = {
            plot: { type: 'prob', body: p.body, shade: single },
            animated: ps.has('t'),
            needs3D: false,
            params: [...ps].filter(v => v !== 't'),
          };
          if (envT0) {
            try {
              const value = single
                ? rvSys.exactProbability(single.rv, single.lo, single.hi, envT0)
                : null;
              if (value !== null) {
                if (isFinite(value)) eq.info = `≈ ${value.toFixed(4)}`;
              } else {
                const mc = rvSys.probability(p.body, envT0);
                if (isFinite(mc)) eq.info = `≈ ${mc.toFixed(3)}`;
              }
            } catch { /* animated or broken: no readout */ }
          }
        }
        continue;
      }
      const expectBody = defs.consts.has('E') || defs.fns.has('E') ? null : matchExpectation(text);
      if (expectBody !== null) {
        if (!rvNames.size) throw new Error('Define a random variable first, e.g. X ~ Normal(0, 1).');
        const ex = toExpectation(resolveExpr(parseExpr(expectBody, fnNames), getFn, ropts), rvNames);
        for (const name of ex.rvs) {
          if (!rvSys.has(name)) throw new Error(`${name} has an error in its definition.`);
        }
        // The body becomes the variable whose density carries the marker: a
        // bare name is itself, anything else an anonymous derived variable —
        // so exact laws (affine in normals, uniform sums) apply unchanged.
        let name: string;
        if (ex.body.kind === 'var' && rvSys.has(ex.body.name)) {
          name = ex.body.name;
        } else {
          checkDerived(ex.body, rvNames, constNames);
          name = `@E${eq.id}`;
          rvSys.add({ name, kind: 'derived', expr: ex.body });
        }
        const ps = rvSys.bodyParams(ex.body);
        eq.cls = {
          plot: { type: 'expect', rv: name },
          animated: ps.has('t'),
          needs3D: false,
          params: [...ps].filter(p => p !== 't'),
        };
        if (envT0) {
          try {
            // Closed form and quadrature both earn full display precision;
            // only the Monte Carlo fallback rounds to its noise floor.
            const m = rvSys.exactMoments(name, envT0) ?? rvSys.quadMoments(name, envT0);
            const value = m ? m.mean : rvSys.mean(name, envT0);
            if (isFinite(value)) eq.info = `≈ ${value.toFixed(m ? 4 : 3)}`;
          } catch { /* animated or broken: no readout */ }
        }
        continue;
      }
      const seq = scanSeqRec(text);
      if (seq) {
        eq.cls = classifySeqRec(seq, fnNames, getFn, constNames, ropts);
        continue;
      }
      const rawParsed = parseExpr(text, fnNames, listNames);
      let parsed = resolveExpr(rawParsed, getFn, ropts);
      // A bare expression in random variables (`X + Y`, `X^2`) plots the
      // density of that derived variable — distribution arithmetic in place.
      const rvRefs = [...freeVars(parsed)].filter(n => rvNames.has(n));
      if (rvRefs.length) {
        for (const n of rvRefs) {
          if (!rvSys.has(n)) throw new Error(`${n} has an error in its definition.`);
        }
        if (parsed.kind === 'ineq') {
          throw new Error(`An inequality in random variables is a probability: try P(${text}).`);
        }
        checkDerived(parsed, rvNames, constNames);
        const name = `@${eq.id}`;
        rvSys.add({ name, kind: 'derived', expr: parsed });
        classifyDerived(eq, name);
        continue;
      }
      // Expand point arithmetic and geometry statements (segment, polygon, …)
      // into scalar expressions; a point name A becomes (A_x, A_y).
      parsed = lowerGeom(parsed, n => compsOf(defs, n), n => defs.mats.get(n) ?? null);
      // Lists broadcast/reduce away: the row becomes a plain list literal
      // (dots, bars, or a scatter) or a scalar expression (reductions).
      parsed = lowerLists(parsed, getList, ropts);
      // Coordinate fields substitute in as functions of the plane, so
      // `r = 1 + cos(theta)` classifies as an implicit curve in x, y.
      if (defs.fields.size) parsed = substVars(parsed, fieldEnv);
      eq.cls = classify(parsed, constNames);
      // A 3-column scatter only ever draws in 3D, where every point is a
      // sprite. Say so here rather than plotting the first CLOUD_3D_MAX of a
      // sorted file, which looks like the whole thing. BOTH representations
      // count: crossing a column with a slider or t expands the same cloud
      // into a symbolic plist, which is if anything the more expensive one
      // (every point re-evaluated per frame).
      const cloud3d = eq.cls.plot.type === 'dscatter' && eq.cls.plot.dim === 3
        ? eq.cls.plot.coords[0].length
        : eq.cls.plot.type === 'plist' && eq.cls.plot.dim === 3 ? eq.cls.plot.pts.length : 0;
      if (cloud3d > CLOUD_3D_MAX) {
        throw new Error(`A 3D cloud draws at most ${CLOUD_3D_MAX} points; that is ${cloud3d}.`
          + ' Filter it first, or plot two of the columns.');
      }
      eq.parsed = parsed;
      // A row that wrote an ∫ or a list reduction and resolved to a constant
      // gets its value as a readout (the plot is the horizontal line there).
      if (envT0 && (usesIntegral(rawParsed) || usesListReduction(rawParsed))) {
        try {
          const value = evaluate(parsed, envT0);
          if (isFinite(value)) eq.info = `≈ ${Number(value.toPrecision(6))}`;
        } catch { /* depends on plot coordinates: the curve is the answer */ }
      }
    } catch (e) {
      eq.error = e instanceof Error ? e.message : String(e);
      // "…is not on this device": the row is one file away from working, and
      // saying so is only half an answer without a way to supply it.
      eq.needsFile = e instanceof MissingDataError;
    }
  }
  rvSys.prune(); // sample caches of variables that no longer exist
  spGen++; // queued hover recomputes predate this compile: drop them
  spQueue.clear();
  setHover(null);
  // A row that named a file with no hash and found it here gets pinned, on
  // this path as much as after a load from storage — otherwise a row typed
  // against a file already in memory would be shared unpinned, and open
  // elsewhere against whatever bytes happen to share the name.
  if (!pinning) {
    pinning = true;
    try {
      pinTableHashes(); // recompiles once more, without re-entering here
    } finally {
      pinning = false;
    }
  }
}

/** Guards recompile → pin → recompile from recurring. */
let pinning = false;

// --- local data files (drag a CSV in) ---

/** In flight: the IndexedDB read for files the document names. */
let tableLoad: Promise<void> | null = null;
/** A row named a file while that read was running: ask again when it lands. */
let tableLoadAgain = false;

/**
 * Fetch the files an `open(…)` row names out of local storage. Compiling is
 * synchronous, so this runs beside it and recompiles once bytes arrive; each
 * (hash, name) is asked for only once, so a genuinely missing file settles on
 * its error instead of spinning.
 */
function ensureTables(raw: Definition[]) {
  const refs = raw
    .filter((d): d is Definition & { kind: 'table' } => d.kind === 'table')
    .filter(d => !lookupFile(d.file, d.hash))
    .map(({ file, hash }) => ({ file, hash }));
  if (!refs.length) return;
  // A read is already running: this row was typed while it was. Remember to
  // come back, or a file named mid-read is never asked for. (When the running
  // read DID find something it recompiles anyway, which lands here again.)
  if (tableLoad) {
    tableLoadAgain = true;
    return;
  }
  tableLoadAgain = false; // this read asks for what is named right now
  tableLoad = loadRefs(refs)
    .then(added => {
      tableLoad = null;
      if (added) refreshRows();
      else if (tableLoadAgain) {
        tableLoadAgain = false;
        refreshRows();
      }
    })
    .catch(() => { tableLoad = null; });
}

/** Recompile and redraw after something outside the document changed (a file
 *  arrived), keeping the caret where the user left it. */
function refreshRows() {
  const caret = caretPos();
  recompileAll();
  if (pinTableHashes()) renderAll();
  else reconcile();
  if (caret && caret.line < equations.length) {
    setCaret(caret.line, Math.min(caret.offset, equations[caret.line].text.length));
  }
  requestRender();
}

/**
 * Write the resolved hash back into a row that named a file without one, so
 * the link pins the exact data it was built against — the same two-way
 * binding sliders, point drags, and `view(…)` rows already have.
 *
 * The row being typed is left alone: rewriting `p = open("people.csv")` into
 * `p = open("people.csv", 3a7f…)` under the caret, mid-keystroke, would fight
 * the typist. It pins as soon as the caret leaves, so a hand-typed row that
 * resolved straight out of memory still gets pinned before it is shared.
 */
function pinTableHashes(): boolean {
  let changed = false;
  const editing = caretPos()?.line;
  const lines = lineEls();
  for (const [i, eq] of equations.entries()) {
    const d = eq.def;
    if (d?.kind !== 'table' || d.hash || eq.error || i === editing) continue;
    const f = lookupFile(d.file, '');
    if (!f) continue;
    const text = formatTableRow(d.name, d.file, f.hash);
    if (text === eq.text.trim()) continue;
    eq.text = text;
    // Write the line through the way a slider drag does, so the pin does not
    // need a full re-render of the list to become visible.
    if (lines[i]) lines[i].textContent = text;
    changed = true;
  }
  if (changed) {
    recompileAll();
    saveUrl();
  }
  return changed;
}

/** A row name for a dropped file that no definition has claimed. */
function freeTableName(base: string): string {
  // Scanned from the row TEXT, not from `eq.def`: dropping several files at
  // once appends a row per file and recompiles only at the end, so the rows
  // added moments ago have no def yet. Reading the stale defs gave two files
  // with the same stem (sales.csv, sales.tsv) the same name, and the second
  // row then lost to the duplicate check.
  const taken = new Set(equations
    .map(eq => eq.def?.name ?? scanDefinition(eq.text)?.name)
    .filter((n): n is string => !!n));
  if (nameable(base) && !taken.has(base)) return base;
  for (let k = 2; ; k++) {
    const name = `${base}_${k}`;
    if (nameable(name) && !taken.has(name)) return name;
  }
}

/**
 * Read dropped/picked files into the local store and wire them into the
 * document: an existing row naming the same file is re-pinned to the new
 * bytes, otherwise a fresh `open(…)` row appears (with a scatter of the first
 * two numeric columns, so the drop draws something immediately).
 */
async function openDataFiles(files: File[]) {
  const added: string[] = [];
  let changed = false;
  for (const file of files) {
    let loaded;
    try {
      loaded = await ingest(file.name, new Uint8Array(await file.arrayBuffer()));
    } catch (e) {
      showNotice(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!changed) pushUndo(null);
    changed = true;
    // Re-dropping a file the document already names re-pins those rows,
    // rather than adding a second copy under another name — but only rows
    // that asked for it. A row pinned to a DIFFERENT hash named those exact
    // bytes on purpose; silently repointing it is the substitution the pin
    // exists to prevent, and it would happen to whoever opened a shared graph
    // and picked their own file of the same name. Those rows keep their
    // hash, and the new bytes arrive as a row of their own.
    let known = false;
    let pinnedElsewhere = 0;
    for (const eq of equations) {
      const d = eq.def;
      if (d?.kind !== 'table' || d.file !== loaded.file) continue;
      if (d.hash && !loaded.hash.startsWith(d.hash)) {
        pinnedElsewhere++;
        continue;
      }
      known = true;
      const text = formatTableRow(d.name, d.file, loaded.hash);
      if (text !== eq.text.trim()) eq.text = text;
    }
    if (pinnedElsewhere) {
      added.push(`${loaded.file}: ${pinnedElsewhere} row${pinnedElsewhere === 1 ? '' : 's'}`
        + ' pinned to other bytes kept — delete the hash there to use this file');
    }
    if (known) {
      added.push(`${loaded.file} reloaded`);
      continue;
    }
    const name = freeTableName(tableNameFor(loaded.file));
    // Land on the trailing blank row if there is one, so dropping twice does
    // not leave gaps.
    const last = equations[equations.length - 1];
    const at = last && !last.text.trim() ? equations.length - 1 : equations.length;
    addEquation(formatTableRow(name, loaded.file, loaded.hash), at);
    const nums = loaded.table.columns.filter(c => c.type === 'num');
    if (nums.length >= 2 && loaded.table.rows <= TABLE_MAX_ROWS) {
      addEquation(`(${name}.${nums[0].name}, ${name}.${nums[1].name})`, at + 1);
    }
    added.push(`${loaded.file}: ${loaded.table.rows} rows as ${name}`
      + (loaded.durable ? '' : ' (this browser is not storing files — it will be gone on reload)'));
  }
  if (!changed) return;
  recompileAll();
  renderAll();
  saveUrl();
  requestRender();
  if (added.length) showNotice(added.join(' · '));
  void refreshFileMenu();
}

const DATA_EXT = /\.(csv|tsv|txt)$/i;

const dataFilesIn = (dt: DataTransfer | null): File[] =>
  [...(dt?.files ?? [])].filter(f => DATA_EXT.test(f.name) || f.type.includes('csv'));

/** Transient message for things with no row to live on (a file that would
 *  not parse, a drop that landed). */
let noticeEl: HTMLElement | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

function showNotice(text: string) {
  // A live region: this is the ONLY feedback that a file parsed, failed, or
  // will not survive a reload, and it disappears after five seconds — with no
  // announcement, a screen-reader user has nothing to go back and read.
  noticeEl ??= document.body.appendChild(Object.assign(document.createElement('div'), {
    className: 'notice',
    role: 'status',
  }));
  noticeEl.setAttribute('aria-live', 'polite');
  noticeEl.textContent = text;
  noticeEl.classList.add('show');
  if (noticeTimer !== null) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => noticeEl?.classList.remove('show'), 5000);
}

/** Depth counter: dragenter/dragleave fire for every element crossed, so a
 *  single counter is what tells a real exit from a child boundary. */
let dragDepth = 0;

addEventListener('dragenter', e => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  if (++dragDepth === 1) document.body.classList.add('file-drag');
});
addEventListener('dragover', e => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
addEventListener('dragleave', () => {
  if (dragDepth && --dragDepth === 0) document.body.classList.remove('file-drag');
});
addEventListener('drop', e => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('file-drag');
  const files = dataFilesIn(e.dataTransfer);
  if (files.length) void openDataFiles(files);
  else if (e.dataTransfer.files.length) showNotice('Only .csv, .tsv, and .txt data files can be opened here.');
});

/**
 * The panel's list of files this browser is holding: what a graph can open,
 * and the only place to throw one away again.
 */
async function refreshFileMenu() {
  const box = document.getElementById('data-files') as HTMLDetailsElement | null;
  const list = document.getElementById('data-files-list');
  if (!box || !list) return;
  const files = await listFiles();
  // Nothing to manage until a file is here. Opening the first one is the
  // "+ csv" link in the panel's bottom row, which is always present.
  box.hidden = !files.length;
  list.textContent = '';
  for (const f of files) {
    const item = document.createElement('div');
    item.className = 'file-item';
    const label = document.createElement('span');
    label.textContent = `${f.name} — ${f.rows} rows`;
    label.title = f.columns.join(', ');
    const hash = document.createElement('code');
    hash.textContent = shortHash(f.hash);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'file-del';
    del.textContent = '✕';
    del.title = `Forget ${f.name} (rows that open it will ask for it again)`;
    // The glyph is the whole visible label, so the file name has to come from
    // somewhere a screen reader reads — title is not that place.
    del.setAttribute('aria-label', `Forget ${f.name}`);
    del.addEventListener('click', async () => {
      await removeFile(f.hash);
      await refreshFileMenu();
      refreshRows();
    });
    item.append(label, hash, del);
    list.append(item);
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'file-add';
  add.textContent = '+ open a CSV…';
  add.addEventListener('click', pickDataFiles);
  list.append(add);
}

// "+ csv" beside github: the way in before any file has been dropped, when
// the data-files section is not there to hold one.
document.getElementById('open-csv')?.addEventListener('click', () => pickDataFiles());

/** File picker, for the "drop the file here" row error and the menu. */
function pickDataFiles() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,.tsv,.txt,text/csv';
  input.multiple = true;
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])];
    if (files.length) void openDataFiles(files);
  });
  input.click();
}

// The address bar shows the /g/ share form: it survives chat-app URL
// linkifiers (lib/link.ts escapes parens etc.) and unfurls with a rendered
// preview, so copying the URL is the share mechanism. /#payload links still
// load (boot below) — they just normalize to /g/ on the next edit.
function writeUrl() {
  const payload = encodePayload(equations.map(e => e.text));
  history.replaceState(null, '', payload ? '/g/' + payload : '/');
}

// Browsers rate-limit replaceState (Safari: 100 per 10s) and throw once it is
// exceeded, so a fast slider drag must not rewrite the URL on every frame.
// Leading edge writes immediately; further calls coalesce into one trailing
// write per second.
const URL_INTERVAL = 1000;
let urlTimer: ReturnType<typeof setTimeout> | null = null;
let urlPending = false;
let urlLastWrite = 0;

function saveUrl() {
  urlPending = true;
  const wait = URL_INTERVAL - (performance.now() - urlLastWrite);
  if (wait <= 0) {
    flushUrl();
    return;
  }
  if (urlTimer === null) urlTimer = setTimeout(flushUrl, wait);
}

function flushUrl() {
  if (urlTimer !== null) {
    clearTimeout(urlTimer);
    urlTimer = null;
  }
  if (!urlPending) return;
  urlPending = false;
  urlLastWrite = performance.now();
  writeUrl();
}

// Don't lose the last edit if the page goes away mid-interval.
addEventListener('pagehide', flushUrl);
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushUrl();
});

function addEquation(text: string, at = equations.length): Equation {
  const eq: Equation = { id: nextId++, text, colorIndex: (nextId - 2) % theme.palette.length };
  equations.splice(at, 0, eq);
  return eq;
}

const fmtNum = (v: number) => String(parseFloat(v.toPrecision(6)));

const lineEls = (): HTMLElement[] =>
  [...listEl.children].filter((el): el is HTMLElement => el.classList.contains('eq-line'));

const lineText = (line: HTMLElement): string => (line.textContent ?? '').replace(/ /g, ' ');

// --- caret mapped to (line index, character offset) ---

function caretPos(): { line: number; offset: number } | null {
  const sel = getSelection();
  if (!sel?.focusNode || !listEl.contains(sel.focusNode)) return null;
  let node: Node | null = sel.focusNode;
  while (node && node !== listEl) {
    if (node instanceof HTMLElement && node.classList.contains('eq-line')) break;
    node = node.parentNode;
  }
  if (!node || node === listEl) return null;
  const line = lineEls().indexOf(node as HTMLElement);
  if (line < 0) return null;
  const r = document.createRange();
  r.selectNodeContents(node);
  r.setEnd(sel.focusNode, sel.focusOffset);
  return { line, offset: r.toString().length };
}

function setCaret(line: number, offset: number) {
  const el = lineEls()[line];
  if (!el) return;
  const sel = getSelection()!;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let t: Node | null;
  while ((t = walker.nextNode())) {
    const len = t.textContent!.length;
    if (remaining <= len) {
      sel.setBaseAndExtent(t, remaining, t, remaining);
      return;
    }
    remaining -= len;
  }
  sel.setBaseAndExtent(el, el.childNodes.length, el, el.childNodes.length);
}

// --- undo/redo ---
//
// One snapshot stack over the whole document (texts, colors, slider bounds),
// replacing the browser's DOM-level history — programmatic re-renders (Enter,
// paste, ';' splits) would corrupt native undo, and native undo never covered
// structural changes anyway. The full document is a few dozen strings, so
// whole-state snapshots beat operation diffing on simplicity.

interface Snapshot {
  eqs: Array<Pick<Equation, 'id' | 'text' | 'colorIndex' | 'sliderMin' | 'sliderMax' | 'showLevels'>>;
  caret: { line: number; offset: number } | null;
}

const undoStack: Snapshot[] = [];
const redoStack: Snapshot[] = [];
const UNDO_LIMIT = 100;
const COALESCE_MS = 1000;
let coalesce: { key: string; time: number } | null = null;
/** Caret captured on beforeinput, so native edits snapshot their pre-edit caret. */
let pendingCaret: { line: number; offset: number } | null = null;

function takeSnapshot(caret: Snapshot['caret']): Snapshot {
  return {
    eqs: equations.map(e => ({
      id: e.id,
      text: e.text,
      colorIndex: e.colorIndex,
      sliderMin: e.sliderMin,
      sliderMax: e.sliderMax,
      showLevels: e.showLevels,
    })),
    caret,
  };
}

/**
 * Record pre-mutation state; call before changing `equations`. A non-null
 * `key` merges runs of the same operation (typing on one line, one slider
 * drag, cycling a color) into a single undo entry while the run continues
 * within COALESCE_MS.
 */
function pushUndo(key: string | null, caret: Snapshot['caret'] = caretPos()) {
  const now = performance.now();
  if (key && coalesce?.key === key && now - coalesce.time < COALESCE_MS) {
    coalesce.time = now;
    return;
  }
  undoStack.push(takeSnapshot(caret));
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
  coalesce = key ? { key, time: now } : null;
}

function restoreSnapshot(s: Snapshot) {
  // Reuse Equation objects by id so widget elements survive the round-trip.
  const byId = new Map(equations.map(e => [e.id, e]));
  equations.length = 0;
  for (const se of s.eqs) {
    const eq = byId.get(se.id) ?? { id: se.id, text: '', colorIndex: se.colorIndex };
    Object.assign(eq, se);
    equations.push(eq);
  }
  recompileAll();
  renderAll();
  if (s.caret && s.caret.line < equations.length) {
    setCaret(s.caret.line, Math.min(s.caret.offset, equations[s.caret.line].text.length));
  }
  saveUrl();
  requestRender();
}

function doUndo() {
  const s = undoStack.pop();
  if (!s) return;
  redoStack.push(takeSnapshot(caretPos()));
  coalesce = null;
  restoreSnapshot(s);
}

function doRedo() {
  const s = redoStack.pop();
  if (!s) return;
  undoStack.push(takeSnapshot(caretPos()));
  coalesce = null;
  restoreSnapshot(s);
}

// --- rendering & reconciliation ---

function makeSlider(eq: Equation): SliderUI {
  const box = document.createElement('div');
  box.className = 'eq-widget eq-slider';
  box.contentEditable = 'false';
  const min = document.createElement('input');
  min.type = 'number';
  min.className = 'eq-slider-bound';
  min.title = 'Slider minimum';
  const range = document.createElement('input');
  range.type = 'range';
  range.className = 'eq-slider-range';
  const max = document.createElement('input');
  max.type = 'number';
  max.className = 'eq-slider-bound';
  max.title = 'Slider maximum';
  box.append(min, range, max);

  range.addEventListener('input', () => {
    const kind = eq.def?.kind;
    if (kind !== 'const' && kind !== 'init') return;
    pushUndo(`slider:${eq.id}`);
    const lhs = kind === 'init' ? `${eq.def!.name}(0)` : eq.def!.name;
    eq.text = `${lhs} = ${fmtNum(Number(range.value))}`;
    const line = lineEls()[equations.indexOf(eq)];
    if (line) line.textContent = eq.text;
    recompileAll();
    reconcile();
    saveUrl();
    requestRender();
  });
  // A drag is one undo entry: coalesced while it lasts, sealed on release.
  range.addEventListener('change', () => {
    coalesce = null;
  });
  const onBound = () => {
    const lo = Number(min.value);
    const hi = Number(max.value);
    if (isFinite(lo) && isFinite(hi) && hi > lo) {
      pushUndo(`bounds:${eq.id}`);
      eq.sliderMin = lo;
      eq.sliderMax = hi;
    }
    reconcile();
  };
  min.addEventListener('change', onBound);
  max.addEventListener('change', onBound);
  return { box, min, range, max };
}

/** Paint the toggle's state for both eyes and screen readers. Clicking and
 *  reconcile() both land here, so the two can never disagree. */
function setLevelsBtnState(btn: HTMLButtonElement, on: boolean) {
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
}

/** Toggle that draws every level set of f, not just the slider's (f(x,y) = c). */
function makeLevelsBtn(eq: Equation): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'eq-widget eq-levels';
  btn.contentEditable = 'false';
  btn.textContent = 'all levels';
  btn.title = 'Draw the whole family of level sets (topographic map)';
  setLevelsBtnState(btn, !!eq.showLevels);
  btn.addEventListener('click', () => {
    pushUndo(null);
    eq.showLevels = !eq.showLevels;
    setLevelsBtnState(btn, !!eq.showLevels);
    requestRender();
  });
  return btn;
}

function makeCurveUI(eq: Equation): CurveUI {
  const box = document.createElement('div');
  box.className = 'eq-widget eq-curve';
  box.contentEditable = 'false';
  const label = document.createElement('span');
  label.className = 'eq-curve-label';
  label.textContent = 'combs';
  const makeToggle = (glyph: string, title: string): [HTMLLabelElement, HTMLInputElement] => {
    const toggle = document.createElement('label');
    toggle.className = 'eq-curve-toggle';
    toggle.title = title;
    const check = document.createElement('input');
    check.type = 'checkbox';
    toggle.append(check, glyph);
    return [toggle, check];
  };
  const [kLabel, kappa] = makeToggle('κ', 'Curvature comb: tooth length κ, away from the center of curvature');
  const [tLabel, tau] = makeToggle('τ', 'Torsion comb: signed teeth along the binormal');
  box.append(label, kLabel, tLabel);
  // Combs are view styling, not document state: no undo entries, no hash.
  // (The tube radius is not here — it lives in tube(…), so it survives a
  // share link, which a widget-only slider never did.)
  kappa.addEventListener('change', () => {
    eq.combK = kappa.checked;
    requestRender();
  });
  tau.addEventListener('change', () => {
    eq.combT = tau.checked;
    requestRender();
  });
  return { box, kappa, tau };
}

/**
 * The display toggle a row offers, if any. Read at click time as well as on
 * reconcile, so one button element follows the row as its plot type changes.
 */
function rowToggle(eq: Equation): { label: string; title: string; on: boolean; flip: () => void } | null {
  switch (eq.cls?.plot.type) {
    case 'sequence':
      return {
        label: 'Σ partial sums',
        title: 'Plot the partial sums S_N = Σ aₙ instead of the terms',
        on: !!eq.partialSum,
        flip: () => { eq.partialSum = !eq.partialSum; },
      };
    case 'vlist':
      return {
        label: 'bars',
        title: 'Draw the list as bars instead of dots',
        on: !!eq.barMode,
        flip: () => { eq.barMode = !eq.barMode; },
      };
    case 'dlist':
      // Bars only while the list is small enough to draw as shapes; past
      // that it is a cloud and a bar per point would be a solid block.
      return eq.cls.plot.values.length > CLOUD_MIN ? null : {
        label: 'bars',
        title: 'Draw the list as bars instead of dots',
        on: !!eq.barMode,
        flip: () => { eq.barMode = !eq.barMode; },
      };
    default:
      return null;
  }
}

function makeToggle(eq: Equation): { box: HTMLElement; btn: HTMLButtonElement } {
  const box = document.createElement('div');
  box.className = 'eq-widget eq-toggles';
  box.contentEditable = 'false';
  const btn = document.createElement('button');
  btn.className = 'eq-toggle';
  btn.addEventListener('click', () => {
    const t = rowToggle(eq);
    if (!t) return;
    t.flip();
    reconcile();
    requestRender();
  });
  box.append(btn);
  return { box, btn };
}

/** Data rows shown in the preview grid under an `open(…)` row. */
const PREVIEW_ROWS = 8;

function makeTablePreview(): TableUI {
  const box = document.createElement('details');
  box.className = 'eq-widget eq-table';
  box.contentEditable = 'false';
  const summary = document.createElement('summary');
  const scroll = document.createElement('div');
  scroll.className = 'eq-table-scroll';
  box.append(summary, scroll);
  return { box, summary, scroll };
}

/**
 * Fill the preview: the readout as its summary, and — once opened — the head
 * of the file as it was actually parsed, which is the only way to see that
 * a column really did read as numbers.
 */
function fillTablePreview(ui: TableUI, info: string, data: Table) {
  ui.summary.textContent = info;
  if (ui.data === data) return;
  ui.data = data;
  const table = document.createElement('table');
  const head = table.insertRow();
  for (const col of data.columns) {
    const th = document.createElement('th');
    th.textContent = col.name;
    th.title = col.label === col.name ? col.type : `${col.label} (${col.type})`;
    th.className = col.type === 'num' ? 'num' : '';
    head.append(th);
  }
  const shown = Math.min(data.rows, PREVIEW_ROWS);
  for (let r = 0; r < shown; r++) {
    const tr = table.insertRow();
    for (const col of data.columns) {
      const td = tr.insertCell();
      if (col.type === 'num') {
        const v = col.nums![r];
        td.textContent = Number.isNaN(v) ? '—' : fmtNum(v);
        td.className = 'num';
      } else {
        td.textContent = col.strs![r];
      }
    }
  }
  if (data.rows > shown) {
    const tr = table.insertRow();
    const td = tr.insertCell();
    td.colSpan = data.columns.length;
    td.className = 'more';
    td.textContent = `${data.rows - shown} more row${data.rows - shown === 1 ? '' : 's'}`;
  }
  ui.scroll.textContent = '';
  ui.scroll.append(table);
}

/**
 * Sync per-line decorations (color, error state, placeholder) and the
 * interleaved widget blocks with current state. Never touches line text, so
 * it is safe to run while the user is typing (the caret stays put).
 */
function reconcile() {
  if (stateResetBtn) stateResetBtn.hidden = !stateSys;
  const lines = lineEls();
  lines.forEach((line, i) => {
    const eq = equations[i];
    if (!eq) return;
    line.dataset.id = String(eq.id);
    line.style.setProperty('--eq-color', cssColor(theme.palette[eq.colorIndex]));
    line.classList.toggle('invalid', !!eq.error);
    line.classList.toggle('is-def', !!eq.def);
    line.classList.toggle('is-comment', !!eq.comment);
    line.classList.toggle('collapsed', !!(eq.comment && eq.collapsed));
    line.title = eq.error ?? (eq.comment ? 'Click the arrow to collapse or expand this group' : '');
    if (equations.length === 1 && !eq.text.trim()) line.dataset.ph = 'add an equation…';
    else delete line.dataset.ph;

    const wanted: HTMLElement[] = [];
    // Initial values get a slider too: dragging one relaunches the system
    // from there, which is the whole point of `a(0)` in a chaotic system.
    const sliderDef = (eq.def?.kind === 'const' || eq.def?.kind === 'init')
      && !eq.error && NUM_RE.test(eq.def.rhs) ? eq.def : null;
    if (sliderDef) {
      eq.sliderUI ??= makeSlider(eq);
      const { min, range, max } = eq.sliderUI;
      const v = Number(sliderDef.rhs);
      if (eq.sliderMin === undefined || eq.sliderMax === undefined) {
        eq.sliderMin = Math.min(-10, Math.floor(v));
        eq.sliderMax = Math.max(10, Math.ceil(v));
      }
      if (v < eq.sliderMin) eq.sliderMin = v;
      if (v > eq.sliderMax) eq.sliderMax = v;
      min.value = fmtNum(eq.sliderMin);
      max.value = fmtNum(eq.sliderMax);
      range.min = String(eq.sliderMin);
      range.max = String(eq.sliderMax);
      // Σ/Π bounds are integers, so their sliders step whole terms at a time.
      range.step = sumBoundNames.has(sliderDef.name) ? '1' : String((eq.sliderMax - eq.sliderMin) / 400);
      range.value = String(v);
      wanted.push(eq.sliderUI.box);
    }
    // `f(x,y) = c` rows can draw the whole contour stack of f, not just the
    // slider's level. The control sits above the readout that may follow it.
    if (eq.cls?.plot.type === 'implicit2d' && eq.cls.plot.levels) {
      eq.levelsBtn ??= makeLevelsBtn(eq);
      setLevelsBtnState(eq.levelsBtn, !!eq.showLevels);
      wanted.push(eq.levelsBtn);
    }
    const plot = eq.cls?.plot;
    if (!eq.error && plot?.type === 'pcurve' && plot.dim === 3) {
      eq.curveUI ??= makeCurveUI(eq);
      eq.curveUI.kappa.checked = !!eq.combK;
      eq.curveUI.tau.checked = !!eq.combT;
      wanted.push(eq.curveUI.box);
    }
    const toggle = rowToggle(eq);
    if (toggle) {
      eq.toggleUI ??= makeToggle(eq);
      const { box, btn } = eq.toggleUI;
      btn.textContent = toggle.label;
      btn.title = toggle.title;
      btn.classList.toggle('on', toggle.on);
      wanted.push(box);
    }
    // A data row's readout is the handle on a preview of the file itself:
    // the summary says what was parsed, opening it shows the first rows.
    const table = eq.def && !eq.error ? defs.tables.get(eq.def.name) : undefined;
    if (table?.data && eq.info) {
      eq.tableUI ??= makeTablePreview();
      fillTablePreview(eq.tableUI, eq.info, table.data);
      wanted.push(eq.tableUI.box);
    } else if (eq.info) {
      eq.infoEl ??= (() => {
        const el = document.createElement('div');
        el.className = 'eq-widget eq-info';
        el.contentEditable = 'false';
        return el;
      })();
      eq.infoEl.textContent = eq.info;
      wanted.push(eq.infoEl);
    }
    if (eq.error) {
      eq.errorEl ??= (() => {
        const el = document.createElement('div');
        el.className = 'eq-widget eq-error';
        el.contentEditable = 'false';
        return el;
      })();
      eq.errorEl.textContent = eq.error;
      // A row whose file is not here heals by supplying the file, so the error
      // is also the button that asks for it — for every row that reads the
      // file, not only the `open(…)` row that names it. It is a real button
      // when it is one: reachable by Tab, activated by Enter or Space, and
      // announced as a control rather than as a sentence.
      const wantsFile = !!eq.needsFile;
      eq.errorEl.classList.toggle('eq-error-pick', wantsFile);
      eq.errorEl.onclick = wantsFile ? pickDataFiles : null;
      eq.errorEl.title = wantsFile ? 'Choose the file' : '';
      eq.errorEl.onkeydown = wantsFile
        ? ev => {
          if (ev.key !== 'Enter' && ev.key !== ' ') return;
          ev.preventDefault();
          pickDataFiles();
        }
        : null;
      if (wantsFile) {
        eq.errorEl.setAttribute('role', 'button');
        eq.errorEl.tabIndex = 0;
      } else {
        eq.errorEl.removeAttribute('role');
        eq.errorEl.removeAttribute('tabindex');
      }
      wanted.push(eq.errorEl);
    }
    // Place widgets directly after their line, then drop anything stale
    // before the next line.
    let ref: ChildNode = line;
    for (const w of wanted) {
      if (ref.nextSibling !== w) listEl.insertBefore(w, ref.nextSibling);
      ref = w;
    }
    while (ref.nextSibling && !(ref.nextSibling instanceof HTMLElement && ref.nextSibling.classList.contains('eq-line'))) {
      ref.nextSibling.remove();
    }
  });

  // Collapsed groups: a collapsed `# comment` hides every row (and its
  // widgets) until the next comment row. Hidden rows stay in the DOM so
  // select-all, copy, undo, and share links still carry the full document.
  let hide = false;
  let head: HTMLElement | null = null;
  let hiddenCount = 0;
  const badge = () => {
    if (!head) return;
    if (hiddenCount) head.dataset.hidden = `${hiddenCount} hidden`;
    else delete head.dataset.hidden;
  };
  let i = -1;
  for (const el of [...listEl.children] as HTMLElement[]) {
    if (el.classList.contains('eq-line')) {
      i++;
      const eq = equations[i];
      if (eq?.comment) {
        badge();
        hide = !!eq.collapsed;
        head = hide ? el : null;
        hiddenCount = 0;
        el.classList.remove('eq-hidden');
        if (!hide) delete el.dataset.hidden;
        continue;
      }
      if (hide) hiddenCount++;
    }
    el.classList.toggle('eq-hidden', hide);
  }
  badge();
}

/** Full rebuild of the editable DOM from state (loses caret; callers restore). */
function renderAll() {
  listEl.textContent = '';
  for (const eq of equations) {
    const line = document.createElement('div');
    line.className = 'eq-line';
    line.dataset.id = String(eq.id);
    if (eq.text) line.textContent = eq.text;
    else line.append(document.createElement('br'));
    listEl.append(line);
  }
  reconcile();
}

/**
 * Read the DOM back into `equations` after a native edit. Normalizes stray
 * nodes the browser may create (bare text at container level, unclassed divs
 * from splits), matches lines to state by data-id (first occurrence wins —
 * Chrome clones attributes when Enter splits a line), and creates/drops
 * Equation entries to mirror the document.
 */
function syncFromDOM() {
  for (const node of [...listEl.childNodes]) {
    if (node instanceof HTMLElement) {
      if (node.classList.contains('eq-line') || node.classList.contains('eq-widget')) continue;
      if (node.tagName === 'BR') node.remove();
      else node.classList.add('eq-line');
    } else if (node.nodeType === Node.TEXT_NODE && node.textContent) {
      const div = document.createElement('div');
      div.className = 'eq-line';
      listEl.insertBefore(div, node);
      div.append(node); // moving (not copying) the text node keeps the caret in it
    } else if (node.nodeType === Node.TEXT_NODE) {
      node.remove();
    }
  }
  const lines = lineEls();
  if (!lines.length) {
    equations.length = 0;
    addEquation('');
    renderAll();
    setCaret(0, 0);
    return;
  }
  const byId = new Map(equations.map(e => [String(e.id), e]));
  const seen = new Set<string>();
  const next: Equation[] = [];
  for (const line of lines) {
    const id = line.dataset.id;
    let eq = id && !seen.has(id) ? byId.get(id) : undefined;
    if (!eq) {
      eq = { id: nextId++, text: '', colorIndex: (nextId - 2) % theme.palette.length };
      line.dataset.id = String(eq.id);
    }
    seen.add(String(eq.id));
    eq.text = lineText(line);
    next.push(eq);
  }
  equations.length = 0;
  equations.push(...next);
}

/**
 * Replace the current selection with pasted/typed multi-statement text,
 * entirely in state space. Statements separate on newlines or ';' (the same
 * separator the examples menu and the URL hash use, so pasted lists and
 * copied blocks both just work).
 */
function insertStatements(text: string) {
  const sel = getSelection();
  if (!sel?.rangeCount) return;
  pushUndo(null);
  // Map both selection endpoints to (line, offset) before touching anything.
  const posOf = (node: Node, off: number): { line: number; offset: number } => {
    const lines = lineEls();
    const atEndOf = (from: Node | null): { line: number; offset: number } => {
      // Nearest line at or before `from` (walking previous siblings).
      for (let p = from; p; p = p.previousSibling) {
        if (p instanceof HTMLElement && p.classList.contains('eq-line')) {
          return { line: lines.indexOf(p), offset: lineText(p).length };
        }
      }
      return { line: 0, offset: 0 };
    };
    let el: Node | null = node;
    while (el && el !== listEl && el.parentNode !== listEl) el = el.parentNode;
    if (!el) return { line: 0, offset: 0 };
    // Container-level boundary (e.g. select-all): position sits between children.
    if (el === listEl) return atEndOf(listEl.childNodes[Math.min(off, listEl.childNodes.length) - 1] ?? null);
    if (el instanceof HTMLElement && el.classList.contains('eq-line')) {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.setEnd(node, off);
      return { line: lines.indexOf(el), offset: r.toString().length };
    }
    return atEndOf(el); // widget or stray node: attach to the line above it
  };
  const range = sel.getRangeAt(0);
  const a = posOf(range.startContainer, range.startOffset);
  const b = posOf(range.endContainer, range.endOffset);
  const [start, end] = a.line < b.line || (a.line === b.line && a.offset <= b.offset) ? [a, b] : [b, a];

  const parts = splitStatements(text);
  const before = equations[start.line]?.text.slice(0, start.offset) ?? '';
  const after = equations[end.line]?.text.slice(end.offset) ?? '';
  const first = equations[start.line] ?? addEquation('');
  const inserted: Equation[] = [first];
  first.text = before + parts[0];
  for (let i = 1; i < parts.length; i++) {
    inserted.push({ id: nextId++, text: parts[i].trim(), colorIndex: (nextId - 2) % theme.palette.length });
  }
  const caretOffset = inserted[inserted.length - 1].text.length;
  inserted[inserted.length - 1].text += after;
  equations.splice(start.line, end.line - start.line + 1, ...inserted);

  recompileAll();
  renderAll();
  expandAt(start.line + inserted.length - 1);
  setCaret(start.line + inserted.length - 1, caretOffset);
  saveUrl();
  requestRender();
}

/**
 * Expand the collapsed group holding `lineIdx`, so an edit that lands inside
 * it (Enter at the end of a collapsed heading, a merge into its last row)
 * never leaves the caret or new rows invisible.
 */
function expandAt(lineIdx: number) {
  for (let i = Math.min(lineIdx, equations.length - 1); i >= 0; i--) {
    const eq = equations[i];
    if (!eq?.comment) continue;
    if (i !== lineIdx && eq.collapsed) {
      eq.collapsed = undefined;
      reconcile();
    }
    return;
  }
}

/** Selected lines as clean newline-joined text — widget content never leaks in. */
function selectionAsText(): string | null {
  const sel = getSelection();
  if (!sel?.rangeCount || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  const parts: string[] = [];
  for (const line of lineEls()) {
    if (!r.intersectsNode(line)) continue;
    const lr = document.createRange();
    lr.selectNodeContents(line);
    // Clamp only when the boundary lies inside this line: a boundary at the
    // container level or in a widget must never widen lr past line contents.
    if (line.contains(r.startContainer) && r.compareBoundaryPoints(Range.START_TO_START, lr) > 0) {
      lr.setStart(r.startContainer, r.startOffset);
    }
    if (line.contains(r.endContainer) && r.compareBoundaryPoints(Range.END_TO_END, lr) < 0) {
      lr.setEnd(r.endContainer, r.endOffset);
    }
    parts.push(lr.toString().replace(/ /g, ' '));
  }
  return parts.length ? parts.join('\n') : null;
}

// --- editor events ---

// Sliders and error messages sit inside the contentEditable as
// `contenteditable=false` widgets, so their inputs bubble key, clipboard and
// beforeinput events to the host. Document editing must ignore those: while
// focus is in a widget input the document selection still points at whatever
// line the caret last touched, so acting on it edits an unrelated equation.
const fromWidget = (e: Event): boolean =>
  e.target instanceof Element && e.target.closest('.eq-widget') !== null;

// First beforeinput listener: route undo/redo to our stack and capture the
// pre-edit caret for the snapshot the upcoming 'input' event will push.
listEl.addEventListener('beforeinput', e => {
  if (fromWidget(e)) return;
  if (e.inputType === 'historyUndo') {
    e.preventDefault();
    doUndo();
    return;
  }
  if (e.inputType === 'historyRedo') {
    e.preventDefault();
    doRedo();
    return;
  }
  pendingCaret = caretPos();
});

listEl.addEventListener('input', e => {
  if (e.target !== listEl) return; // slider/bound inputs bubble their 'input' here
  pushUndo(`edit:${pendingCaret?.line ?? -1}`, pendingCaret ?? caretPos());
  syncFromDOM();
  // Typing ';' splits the line into rows, matching the old per-input behavior.
  if (equations.some(eq => eq.text.includes(';'))) {
    const caret = caretPos();
    let caretLine = caret?.line ?? 0;
    let caretOff = caret?.offset ?? 0;
    for (let i = equations.length - 1; i >= 0; i--) {
      const eq = equations[i];
      if (!eq.text.includes(';')) continue;
      const parts = splitStatements(eq.text).map(s => s.trim());
      if (parts.length === 1) continue; // ';' inside brackets: not a separator
      if (i === caretLine) {
        const sepsBefore = splitStatements(eq.text.slice(0, caretOff)).length - 1;
        caretLine += sepsBefore;
        caretOff = parts[Math.min(sepsBefore, parts.length - 1)].length;
      }
      eq.text = parts[0];
      parts.slice(1).forEach((p, k) => addEquation(p, i + 1 + k));
    }
    recompileAll();
    renderAll();
    setCaret(caretLine, caretOff);
  } else {
    recompileAll();
    reconcile();
  }
  saveUrl();
  requestRender();
});

// Enter splits the line in state space rather than letting the browser pick a
// DOM shape for the new paragraph (div vs br varies across engines). Undo
// shortcuts are handled here too — keydown wins over beforeinput, and some
// engines skip the historyUndo beforeinput when their native stack is empty.
listEl.addEventListener('keydown', e => {
  if (fromWidget(e)) return; // let bound inputs handle their own keys natively
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.altKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) doRedo();
    else doUndo();
    return;
  }
  if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    doRedo();
    return;
  }
  if (e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault();
  insertStatements('\n');
});

// Structural edits the browser would get wrong on its own: newlines that
// bypass the Enter keydown path (mobile IME commits, dictation, autocomplete),
// and Backspace/Delete at a widget boundary — there the browser deletes the
// widget block, which reappears on reconcile as an infinite wall, so the
// adjacent lines are merged in state instead.
listEl.addEventListener('beforeinput', e => {
  if (fromWidget(e)) return;
  if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
    e.preventDefault();
    insertStatements('\n');
    return;
  }
  if (e.inputType !== 'deleteContentBackward' && e.inputType !== 'deleteContentForward') return;
  const sel = getSelection();
  if (!sel?.isCollapsed) return;
  const pos = caretPos();
  if (!pos) return;
  const lines = lineEls();
  const back = e.inputType === 'deleteContentBackward';
  const from = back ? pos.line : pos.line + 1;
  if (back && (pos.offset !== 0 || pos.line === 0)) return;
  if (!back && (pos.offset !== equations[pos.line].text.length || pos.line === lines.length - 1)) return;
  if (lines[from - 1].nextElementSibling === lines[from]) return; // no widget between: native merge is fine
  e.preventDefault();
  pushUndo(null);
  const offset = equations[from - 1].text.length;
  equations[from - 1].text += equations[from].text;
  equations.splice(from, 1);
  recompileAll();
  renderAll();
  expandAt(from - 1);
  setCaret(from - 1, offset);
  saveUrl();
  requestRender();
});

listEl.addEventListener('paste', e => {
  if (fromWidget(e)) return; // pasting a number into a slider bound
  e.preventDefault();
  insertStatements(e.clipboardData?.getData('text/plain') ?? '');
});

listEl.addEventListener('copy', e => {
  if (fromWidget(e)) return;
  const text = selectionAsText();
  if (text === null) return;
  e.preventDefault();
  e.clipboardData?.setData('text/plain', text);
});

listEl.addEventListener('cut', e => {
  if (fromWidget(e)) return;
  const text = selectionAsText();
  if (text === null) return;
  e.preventDefault();
  e.clipboardData?.setData('text/plain', text);
  insertStatements('');
});

// Click on a line's left gutter: comment rows toggle their group collapsed
// (the ::before chevron), other rows cycle their color dot.

/** The equation whose gutter (chevron / color dot) an event lands on. */
function gutterHit(e: { target: EventTarget | null; clientX: number }): Equation | null {
  const line = e.target instanceof HTMLElement ? e.target.closest('.eq-line') : null;
  if (!line) return null;
  if (e.clientX - line.getBoundingClientRect().left > 22) return null;
  const eq = equations[lineEls().indexOf(line as HTMLElement)];
  return !eq || eq.def ? null : eq;
}

function gutterAct(eq: Equation) {
  if (eq.comment) {
    eq.collapsed = !eq.collapsed || undefined;
    reconcile();
    return;
  }
  pushUndo(`color:${eq.id}`);
  eq.colorIndex = (eq.colorIndex + 1) % theme.palette.length;
  reconcile();
  requestRender();
}

// Mouse acts on press. Touch waits for the click — which never comes if the
// touch turns into a scroll or a panel-dismiss swipe (panel-swipe.ts), so
// flinging the panel away from the gutter cannot also recolor a row.
let gutterTouchPending = false;
listEl.addEventListener('pointerdown', e => {
  const eq = gutterHit(e);
  gutterTouchPending = !!eq && e.pointerType === 'touch';
  if (!eq) return;
  e.preventDefault(); // keep the caret and selection out of the gutter
  if (!gutterTouchPending) gutterAct(eq);
});
listEl.addEventListener('click', e => {
  if (!gutterTouchPending) return;
  gutterTouchPending = false;
  const eq = gutterHit(e);
  if (eq) gutterAct(eq);
});

// Highlight the line holding the caret (no per-line focus to key off).
let focusedLine: number | undefined;
document.addEventListener('selectionchange', () => {
  const pos = caretPos();
  lineEls().forEach((line, i) => line.classList.toggle('focused', i === pos?.line));
  // Leaving a row is when its hash gets pinned. pinTableHashes skips whatever
  // line the caret is on, so without this the exception outlives the editing:
  // type `open("people.csv")`, click away, share, and the link is unpinned.
  if (pos?.line === focusedLine) return;
  focusedLine = pos?.line;
  if (pinTableHashes()) reconcile();
});

// --- examples menu ---

const EXAMPLES: Array<[string, Array<[string, string]>]> = [
  ['curves', [
    ['parabola', 'y = x^2'],
    ['circle', 'x^2 + y^2 = 4'],
    ['tangent', 'y = tan(x)'],
    ['lemniscate', '(x^2+y^2)^2 = 8(x^2-y^2)'],
    ['traveling wave', 'y = sin(x - 2t)'],
  ]],
  ['fields', [
    ['interference', 'sin(x)cos(y)'],
    ['ripples', 'sin(x^2 + y^2 - 4t)/2'],
  ]],
  ['vector fields', [
    ['rotation', '(-y, x)'],
    ['saddle', '(x, -y)'],
    ['shear + swirl', '(sin(y), sin(x))'],
  ]],
  ['odes (click to trace)', [
    ['slope field', "y' = x - y"],
    ['logistic growth', "dy/dx = y(1 - y/4)"],
    ['pendulum phase portrait', "(x', y') = (y, -sin(x))"],
    ['van der pol', "(x', y') = (y, (1 - x^2)y - x)"],
    // A linear system as its literal matrix; drag the entries' sliders.
    ['matrix phase portrait', "a = -1; b = -1/4; A = [(0, 1), (a, b)]; (x', y') = A (x, y)"],
  ]],
  ['simulations (↻ to restart)', [
    // th = angle (theta), om = angular velocity (omega): the textbook names.
    // Name each bob as a point, draw the rod with segment(), draw the mass by
    // naming the point on its own row.
    ['swinging pendulum',
      "th' = om; om' = -sin(th) - om/8; th(0) = 3; bob = (sin(th), -cos(th)); segment((0, 0), bob); bob"],
    // The Lagrangian form M(th) om' = f(th, om): th and om are 2-vector
    // states (components th_1, th_2), M the mass matrix, solve() Cramer.
    ['double pendulum',
      'g = 9.8; L1 = 1; L2 = 1; m1 = 1; m2 = 1; '
      + 'M = [((m1+m2) L1, m2 L2 cos(th_1 - th_2)), (L1 cos(th_1 - th_2), L2)]; '
      + 'f = (-m2 L2 om_2^2 sin(th_1 - th_2) - (m1+m2) g sin(th_1), L1 om_1^2 sin(th_1 - th_2) - g sin(th_2)); '
      + "th' = om; om' = solve(M, f); "
      + 'th(0) = (2.5, 2.4); '
      + 'b1 = (L1 sin(th_1), -L1 cos(th_1)); '
      + 'b2 = b1 + (L2 sin(th_2), -L2 cos(th_2)); '
      + 'segment((0, 0), b1); segment(b1, b2); b1; b2'],
    // r'' = -mu r/|r|^3, written as the vectors it is. The state r draws as
    // a point; below escape velocity the orbit is an ellipse.
    ['orbit (vector gravity)',
      "r' = vel; vel' = -9 r/|r|^3; r(0) = (2, 0); vel(0) = (0, 1.5); segment((0, 0), r); r; (0, 0)"],
    // pos = displacement, vel = velocity: a phase portrait in (pos, vel).
    ['driven oscillator', "pos' = vel; vel' = sin(2t) - pos - vel/5; (pos, vel)"],
    // One 3-component state; the plot row projects onto the x–z plane.
    ['lorenz attractor',
      "r' = (10(r_2 - r_1), r_1(28 - r_3) - r_2, r_1 r_2 - 8 r_3/3); "
      + 'r(0) = (1, 1, 20); (r_1/4, r_3/4 - 6)'],
  ]],
  ['complex', [
    ['point charge', 'ln(w)'],
    ['dipole', 'ln(w-2) - ln(w+2)'],
    ['quadrupole', 'ln(w-2) + ln(w+2) - ln(w-2i) - ln(w+2i)'],
    ['flow past cylinder', 'w + 4/w'],
    ['orbiting charge', 'ln(w-2) - ln(w + 2e^(i t))'],
    ['domain coloring', 'domain((w^3 - 1)/w)'],
    ['conformal map', 'conformal(w^2/4)'],
    ['joukowski airfoil', 'conformal(w + 1/w)'],
  ]],
  ['fractals', [
    ['mandelbrot set', 'iter(z^2 + w)'],
    ['julia set', 'iter(z^2 - 0.7269 + 0.1889i)'],
    ['julia orbit', 'iter(z^2 + 0.7885e^(i t/8))'],
    ['burning ship', 'iter((|re(z)| - i |im(z)|)^2 + w)'],
  ]],
  ['coordinates', [
    ['polar grid', 'r = sqrt(x^2 + y^2); theta = atan2(y, x)'],
    ['cardioid in polar', 'r = sqrt(x^2 + y^2); theta = atan2(y, x); r = 2(1 + cos(theta))'],
    ['polar spiral', 'r = sqrt(x^2 + y^2); theta = atan2(y, x); r = theta + pi'],
    ['log-polar', 'rho = ln(x^2 + y^2)/2; theta = atan2(y, x)'],
    ['hyperbolic grid', 'p = x y; q = (x^2 - y^2)/2'],
    ['spinning polar', 'r = sqrt(x^2 + y^2); theta = atan2(y, x) + t/4'],
  ]],
  ['probability', [
    ['normal density', 'X ~ Normal(0, 1)'],
    ['P(X < b)', 'a = 1; b = 0.5; X ~ Normal(0, a); P(X < b)'],
    ['between two bounds', 'X ~ Normal(0, 1); P(-1 < X < 2)'],
    ['uniform + exponential', 'X ~ Uniform(0, 2); Y ~ Exponential(1); P(0.5 < X < 1.5)'],
    ['sum = convolution', 'X ~ Uniform(0, 1); Y ~ Uniform(0, 1); X + Y'],
    ['central limit theorem', 'view(x = -0.5..4.5, y = -0.15..1.35); '
      + 'X1 ~ Uniform(0, 1); X2 ~ Uniform(0, 1); X3 ~ Uniform(0, 1); X4 ~ Uniform(0, 1); '
      + 'S = X1 + X2 + X3 + X4; Z ~ Normal(2, sqrt(1/3)); P(S > 3)'],
    ['conditional variable', 'X ~ Normal(0, 1); Y = {X > 0: X^2, 1}; P(Y > 0.5); P(Y > X)'],
    ['expectation', 'X ~ Uniform(0, 1); Y = X^2; E(Y); E(X + Y)'],
  ]],
  ['regions', [
    ['open half-plane', 'y < x/2 + 1'],
    ['closed disc', 'x^2 + y^2 <= 4'],
    ['annulus', '4 <= x^2 + y^2 <= 9'],
    ['band under a wave', '-1 <= y - sin(x) < 1'],
  ]],
  ['sequences + recurrences', [
    ['sequence', 'a_n = 1/n^2'],
    ['alternating harmonic', 'a_n = (-1)^(n+1)/n'],
    ['prime indicator', 'a_n = isprime(n)'],
    ['cobweb', 'r = 2.9; a_0 = 0.15; a_{n+1} = r a_n (1 - a_n)'],
    ['logistic bifurcation', 'a_{n+1} = x a_n (1 - a_n)'],
  ]],
  ['data + piecewise', [
    ['data list', '[3, 1, 4, 1, 5, 9, 2, 6]'],
    ['scatter', '[(1, 2), (2, 3.5), (3, 3.1), (4, 5)]'],
    ['piecewise', 'y = {x < 0: -x, x >= 0: x^2}'],
    ['coprime cells', '1 / gcd(floor(x), floor(y))'],
  ]],
  ['sliders + calculus', [
    ['slider', 'a = 2; y = sin(a x)/a'],
    ['level sets', 'c = 0.3; sin(x)cos(y) = c'],
    ['function', 'f(x) = x^3 - 3x; y = f(x)'],
    ['derivative', 'y = d/dx (x^3 - 3x)'],
    ['tangent line', 'f(x) = x^3 - 2x; g(x) = d/dx f(x); a = 1; y = f(x); y = f(a) + g(a)(x - a)'],
    ['running integral', 'view(x = -7..7, y = -1.5..4); f(x) = sin(x)^2; y = f(x); y = int[0..x] f(t) dt'],
    ['antiderivative', 'f(x) = x^2 - 1; y = f(x); y = int(f(x) dx)'],
    ['gaussian error fn', 'view(x = -4..4, y = -1.2..1.2); y = int[0..x] exp(-t^2) dt'],
    ['normal cdf', 'view(x = -4..4, y = -0.6..1.2); y = normalpdf(x, 0, 1); y = int[-inf..x] normalpdf(t, 0, 1) dt'],
    ['sine integral Si(x)', 'view(x = -20..20, y = -2.2..2.2); y = int[0..x] sin(t)/t dt'],
    ['orbiting charge', 'r = 2 + sin(t); ln(w - r) - ln(w + r)'],
  ]],
  ['series', [
    ['fourier square wave', 'N = 3; y = (4/pi) sum(n=1..N, sin((2n-1)x)/(2n-1))'],
    ['fourier sawtooth', 'N = 5; y = 2 sum[n=1..N] (-1)^(n+1) sin(n x)/n'],
    ['taylor cosine', 'N = 2; y = sum(n=0..N, (-1)^n x^(2n)/prod(k=1..2n, k)); y = cos(x)'],
  ]],
  ['points (drag them)', [
    ['a point', '(2, 3)'],
    ['point on sliders', 'a = 1; b = 2; (a, b)'],
    ['point on a curve', 'a = 1; f(x) = x^3 - 3x; y = f(x); (a, f(a))'],
    ['orbit', '(2cos(t), 2sin(t))'],
    ['lissajous', '(2cos(2pi u), sin(4pi u))'],
    ['spiral', '(u cos(6pi u) 3, u sin(6pi u) 3)'],
  ]],
  ['geometry (drag the points)', [
    ['segment + midpoint', 'A = (-2, -1); B = (2, 1.5); segment(A, B); midpoint(A, B)'],
    ['perpendicular bisector', 'A = (-2, -1); B = (2, 1.5); segment(A, B); M = midpoint(A, B); line(M, M + perp(B - A))'],
    ['circle through a point', 'C = (0, 0); P = (2, 1); circle(C, |P - C|); segment(C, P)'],
    ['square on a segment', 'A = (-1, 0); B = (2, 1); square(A, B)'],
    ['thébault’s theorem', 'A = (0, 0); B = (4, 0.5); D = (1, 2.5); C = B + D - A; '
      + 'polygon(A, B, C, D); square(B, A); square(C, B); square(D, C); square(A, D); '
      + 'P = midpoint(A, B) - perp(B - A)/2; Q = midpoint(B, C) - perp(C - B)/2; '
      + 'R = midpoint(C, D) - perp(D - C)/2; S = midpoint(D, A) - perp(A - D)/2; '
      + 'polygon(P, Q, R, S)'],
  ]],
  ['systems', [
    ['curve intersection', 'x^2 + y^2 = 4; x y = 1; (x^2 + y^2 - 4, x y - 1) = (0, 0)'],
    ['three planes', '(x + y, x - y, z) = (1, 2, 3)'],
    // Alpöge's counterexample to the Jacobian conjecture (July 2026), found by
    // Fable: det JF = -2 everywhere, yet the fiber over (-1/4, 0, 0) holds the
    // three points the solver marks. Drag c above 0 and two of them leave —
    // they escape to infinity, which is how an étale map gets to be 3-to-1.
    ['jacobian counterexample', 'c = -0.25; F(x,y,z) = ((1+x y)^3 z + y^2 (1+x y)(4+3 x y), y + 3 x (1+x y)^2 z + 3 x y^2 (4+3 x y), 2 x - 3 x^2 y - x^3 z); F(x,y,z) = (c, 0, 0)'],
  ]],
  ['3d surfaces', [
    ['waves', 'z = sin(x)cos(y)'],
    ['sphere', 'x^2 + y^2 + z^2 = 9'],
    ['saddle', 'z = (x^2 - y^2)/4'],
    ['gyroid', 'sin(x)cos(y) + sin(y)cos(z) + sin(z)cos(x) = 0'],
  ]],
  ['parametric 3d', [
    ['helix', '(2cos(6pi u), 2sin(6pi u), 4u - 2)'],
    ['torus', '(cos(2pi u)(2+cos(2pi v)), sin(2pi u)(2+cos(2pi v)), sin(2pi v))'],
    ['sphere (u,v)', '(2sin(pi v)cos(2pi u), 2sin(pi v)sin(2pi u), 2cos(pi v))'],
    ['breathing torus', '(cos(2pi u)(2+cos(2pi v+t)), sin(2pi u)(2+cos(2pi v+t)), sin(2pi v+t))'],
  ]],
  ['knots', [
    ['trefoil', 'tube((sin(2pi u) + 2sin(4pi u), cos(2pi u) - 2cos(4pi u), -sin(6pi u)))'],
    ['torus knot (2,5)', 'tube(((2+cos(10pi u))cos(4pi u), (2+cos(10pi u))sin(4pi u), sin(10pi u)))'],
    ['figure eight', 'tube(((2+cos(4pi u))cos(6pi u), (2+cos(4pi u))sin(6pi u), sin(8pi u)))'],
    ['viviani', 'tube((1+cos(4pi u), sin(4pi u), 2sin(2pi u)), 0.06)'],
  ]],
];

function openExample(text: string) {
  pushUndo(null);
  // An example is a fresh start: it replaces the whole document (undo brings
  // the old one back). Multi-row examples separate rows with ';' (the same
  // separator as the hash).
  equations.length = 0;
  for (const part of splitStatements(text)) addEquation(part.trim());
  recompileAll();
  saveUrl();
  renderAll();
  requestRender();
}

function buildExamplesMenu() {
  const list = document.getElementById('examples-list')!;
  for (const [category, items] of EXAMPLES) {
    const group = document.createElement('details');
    const label = document.createElement('summary');
    label.textContent = category;
    group.append(label);
    for (const [name, text] of items) {
      const item = document.createElement('button');
      item.className = 'ex-item';
      item.textContent = name;
      const code = document.createElement('code');
      code.textContent = text;
      item.append(code);
      item.addEventListener('click', () => openExample(text));
      group.append(item);
    }
    list.append(group);
  }
}

// --- draggable points ---
//
// A point row whose coordinates are plain numbers or bare slider names can be
// picked up and moved on the canvas; the drag rewrites those numbers, so the
// equation list stays the source of truth and the move is undoable and
// shareable. Coordinates that are computed — (2cos(t), 2sin(t)), (a+1, b) —
// have nothing to write back to and stay pinned on that axis. Which
// coordinates can move is decided by lib/drag.ts, shared with the MCP server
// so its "draggable" report matches what the app actually does.

/** Round to roughly a pixel, so dragging writes short, readable numbers. */
function snapToPixel(v: number): number {
  const step = Math.pow(10, Math.floor(Math.log10(view.upp * 3)));
  return Math.round(v / step) * step;
}

/**
 * How a dragged position writes back to a pair like `(2, a)`, or null if
 * nothing about it can move. Axes are independent: a literal is rewritten in
 * place while a slider name moves through its own row. `commit` receives the
 * rewritten pair text.
 */
function makePairWriter(pairText: string, commit: (pair: string) => void): ((x: number, y: number) => void) | null {
  // A name moves only if it is a slider constant: a plain number in its own
  // row is the only right-hand side a drag knows how to rewrite.
  const drag = dragAxes(pairText, p => equations.find(r =>
    r.def?.kind === 'const' && r.def.name === p && !r.error && NUM_RE.test(r.def.rhs)));
  if (!drag) return null;
  const { parts, axes } = drag;
  return (x, y) => {
    const coords = [x, y];
    const text = [...parts];
    axes.forEach((axis, k) => {
      if (!axis) return;
      const value = fmtNum(snapToPixel(coords[k]));
      if (axis === 'literal') text[k] = value;
      else axis.text = `${axis.def!.name} = ${value}`;
    });
    commit(`(${text[0]}, ${text[1]})`);
  };
}

const pointWriter = (eq: Equation) => makePairWriter(eq.text, p => { eq.text = p; });

/** Writer for a named-point row `A = (…)`: rewrites the pair after the '='. */
const defPointWriter = (eq: Equation) => {
  const def = eq.def as Definition & { kind: 'const' };
  return makePairWriter(def.rhs, p => { eq.text = `${def.name} = ${p}`; });
};

/** Push text a drag rewrote back into the editor lines. */
function syncLineTexts() {
  const lines = lineEls();
  equations.forEach((eq, i) => {
    const line = lines[i];
    if (line && lineText(line) !== eq.text) line.textContent = eq.text;
  });
}

/** Pixels of slack around a point when grabbing it. */
const GRAB_PX = 14;
/** The point being dragged, with the offset from its centre to the pointer. */
let grab: { pt: Grabbable; dx: number; dy: number } | null = null;

/** Math coordinates under a client position. */
function toMath(clientX: number, clientY: number): [number, number] {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const px = (clientX - rect.left - rect.width / 2) * dpr;
  const py = (rect.height / 2 - (clientY - rect.top)) * dpr;
  return [view.cx + px * view.upp, view.cy + py * view.upp];
}

/** The nearest grabbable point within GRAB_PX of a client position. */
function pointAt(clientX: number, clientY: number): Grabbable | null {
  if (mode !== '2d' || !grabbable.length) return null;
  const [mx, my] = toMath(clientX, clientY);
  const dpr = window.devicePixelRatio || 1;
  let best: Grabbable | null = null;
  let bestDist = GRAB_PX * dpr * view.upp;
  for (const p of grabbable) {
    const d = Math.hypot(p.x - mx, p.y - my);
    if (d <= bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

function setHot(key: string | null) {
  if (hotPoint === key) return;
  hotPoint = key;
  requestRender();
}

function movePoint(pt: Grabbable, x: number, y: number) {
  // One undo entry per drag: coalesced while it lasts, sealed on release.
  if (pt.edits) pushUndo(`drag:${pt.key}`);
  pt.set(x, y);
  if (pt.edits) {
    syncLineTexts();
    recompileAll();
    reconcile();
    saveUrl();
  }
  requestRender();
}

// --- hover: intercepts and roots ---

let hover: { pt: SpecialPoint; color: string } | null = null;

const tooltip = document.createElement('div');
tooltip.id = 'tooltip';
document.body.append(tooltip);

/** Math units per CSS pixel and the canvas rect, for screen↔world mapping. */
function screenMap() {
  const rect = canvas.getBoundingClientRect();
  const uppCss = view.upp * (window.devicePixelRatio || 1);
  return {
    rect,
    toSx: (x: number) => (x - view.cx) / uppCss + rect.width / 2,
    toSy: (y: number) => rect.height / 2 - (y - view.cy) / uppCss,
  };
}

// specialPoints costs tens of milliseconds per row — far too much for a
// pointermove handler, and pan/zoom invalidates spCache, so a pan-then-hover
// would otherwise freeze once per row. Rows that miss the cache are queued
// here and recomputed one per idle slot (one row per slot so a heavy row
// cannot starve the rest); until a row's result lands, the pick reuses its
// stale points when the equation itself is unchanged.
const spQueue = new Set<Equation>();
let spSlot: number | null = null;
let spGen = 0; // bumped on recompile: slots scheduled before it do nothing
let lastHoverAt: { x: number; y: number } | null = null;

const idleSlot: (fn: () => void) => number =
  typeof requestIdleCallback === 'function'
    ? fn => requestIdleCallback(fn, { timeout: 250 })
    : fn => window.setTimeout(fn, 80);

function scheduleSpecialPoints(eq: Equation) {
  spQueue.add(eq);
  ensureSpSlot();
}

function ensureSpSlot() {
  if (spSlot !== null) return;
  const gen = spGen;
  spSlot = idleSlot(() => {
    spSlot = null;
    if (gen !== spGen) return; // the document changed under this slot
    const next: Equation | undefined = spQueue.values().next().value;
    if (next) {
      spQueue.delete(next);
      if (equations.includes(next)) computeSpecialPoints(next);
      if (spQueue.size) ensureSpSlot();
    }
    if (lastHoverAt) updateHover(lastHoverAt.x, lastHoverAt.y);
  });
}

function hoverHalfSpan() {
  const dpr = window.devicePixelRatio || 1;
  return {
    halfW: ((canvas.clientWidth * dpr) / 2) * view.upp,
    halfH: ((canvas.clientHeight * dpr) / 2) * view.upp,
  };
}

function hoverEnvKey(cls: Classified): string {
  return cls.params.map(p => `${p}=${constEnv[p] ?? 0}`).join(',');
}

/**
 * Recompute eq's intercept/root points over a padded view range. Reads the
 * live view/env when it runs, so a queued row always lands current data;
 * only ever called from the deferred slot, never from an input handler.
 */
function computeSpecialPoints(eq: Equation) {
  const cls = eq.cls;
  if (!cls || eq.error || !eq.parsed || cls.plot.type !== 'implicit2d' || cls.animated) return;
  const { halfW, halfH } = hoverHalfSpan();
  let expr = eq.parsed;
  if (cls.params.length) {
    expr = substVars(expr, Object.fromEntries(
      cls.params.map(p => [p, { kind: 'num', value: constEnv[p] ?? 0 } as Expr]),
    ));
  }
  const xlo = view.cx - halfW * 1.5;
  const xhi = view.cx + halfW * 1.5;
  const ylo = view.cy - halfH * 1.5;
  const yhi = view.cy + halfH * 1.5;
  const pts = specialPoints(expr, xlo, xhi, ylo, yhi);
  eq.spCache = { text: eq.text, env: hoverEnvKey(cls), xlo, xhi, ylo, yhi, pts };
}

/**
 * The equation's cached intercept/root points. On a cache miss this queues a
 * deferred recompute and returns the stale points (same equation, older view
 * range — slightly out of date beats a frozen frame), or nothing if the
 * equation itself changed.
 */
function pointsFor(eq: Equation): SpecialPoint[] {
  const cls = eq.cls;
  if (!cls || eq.error || !eq.parsed || cls.plot.type !== 'implicit2d' || cls.animated) return [];
  const { halfW, halfH } = hoverHalfSpan();
  const envKey = hoverEnvKey(cls);
  const c = eq.spCache;
  if (c && c.text === eq.text && c.env === envKey
    && c.xlo <= view.cx - halfW && c.xhi >= view.cx + halfW && c.xhi - c.xlo <= 6 * halfW
    && c.ylo <= view.cy - halfH && c.yhi >= view.cy + halfH && c.yhi - c.ylo <= 6 * halfH) {
    return c.pts;
  }
  scheduleSpecialPoints(eq);
  return c && c.text === eq.text && c.env === envKey ? c.pts : [];
}

function setHover(next: { pt: SpecialPoint; color: string } | null) {
  if (hover?.pt === next?.pt && hover?.color === next?.color) return;
  hover = next;
  if (!hover) {
    tooltip.style.display = 'none';
  } else {
    const { rect, toSx, toSy } = screenMap();
    tooltip.textContent = hover.pt.lines.join('\n');
    tooltip.style.borderColor = hover.color;
    tooltip.style.left = `${rect.left + toSx(hover.pt.x) + 14}px`;
    tooltip.style.top = `${rect.top + toSy(hover.pt.y) + 12}px`;
    tooltip.style.display = 'block';
  }
  requestRender();
}

function updateHover(clientX: number, clientY: number) {
  if (mode !== '2d') {
    setHover(null);
    return;
  }
  const { rect, toSx, toSy } = screenMap();
  const mx = clientX - rect.left;
  const my = clientY - rect.top;
  let best: { pt: SpecialPoint; color: string } | null = null;
  let bestD = 16; // CSS px pick radius
  for (const eq of equations) {
    for (const pt of pointsFor(eq)) {
      const d = Math.hypot(toSx(pt.x) - mx, toSy(pt.y) - my);
      if (d < bestD) {
        bestD = d;
        best = { pt, color: cssColor(theme.palette[eq.colorIndex]) };
      }
    }
  }
  setHover(best);
}

/** Marker for the hovered point, drawn over the axis labels. */
function drawHoverMarker(dpr: number) {
  if (!hover || mode !== '2d') return;
  const { toSx, toSy } = screenMap();
  const sx = toSx(hover.pt.x);
  const sy = toSy(hover.pt.y);
  const ctx = overlayCtx;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.beginPath();
  ctx.arc(sx, sy, 5.5, 0, Math.PI * 2);
  ctx.fillStyle = theme.pointOutline; // reads as a halo in either theme
  ctx.fill();
  ctx.lineWidth = 2.25;
  ctx.strokeStyle = hover.color;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(sx, sy, 2, 0, Math.PI * 2);
  ctx.fillStyle = hover.color;
  ctx.fill();
  ctx.restore();
}

// --- interaction ---

let dragging = false;
let lastX = 0;
let lastY = 0;
let panning = false;
const pointers = new Map<number, { x: number; y: number }>();
let pinchDist = 0;
let downX = 0;
let downY = 0;
let dragMoved = false;

/** Zoom by `factor` keeping the math point under (clientX, clientY) fixed. */
function zoomAt(clientX: number, clientY: number, factor: number) {
  if (mode === '2d') {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const px = (clientX - rect.left - rect.width / 2) * dpr;
    const py = (rect.height / 2 - (clientY - rect.top)) * dpr;
    const mx = view.cx + px * view.upp;
    const my = view.cy + py * view.upp;
    view.upp *= factor;
    view.cx = mx - px * view.upp;
    view.cy = my - py * view.upp;
  } else {
    camera.radius = Math.min(1e6, Math.max(1e-4, camera.radius * factor));
  }
  requestRender();
  scheduleViewportWriteback();
}

canvas.addEventListener('pointerdown', e => {
  setHover(null); // a tooltip must not survive the gesture that moves the plot
  lastHoverAt = null; // nor may a deferred recompute re-pick mid-gesture
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {} // synthetic events have no active pointer to capture
  if (pointers.size === 1) {
    // Grabbing an on-screen point wins over panning the view.
    const hit = e.button === 0 && !e.shiftKey ? pointAt(e.clientX, e.clientY) : null;
    if (hit) {
      const [mx, my] = toMath(e.clientX, e.clientY);
      grab = { pt: hit, dx: hit.x - mx, dy: hit.y - my };
      setHot(hit.key);
      canvas.style.cursor = 'grabbing';
    }
    dragging = !hit;
    panning = e.button === 2 || e.shiftKey;
    lastX = e.clientX;
    lastY = e.clientY;
    downX = e.clientX;
    downY = e.clientY;
    dragMoved = false;
  } else if (pointers.size === 2) {
    // Second finger: switch from drag to pinch, anchored at the midpoint.
    dragging = false;
    grab = null;
    dragMoved = true; // a pinch is never a seed-dropping click
    const [a, b] = [...pointers.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    lastX = (a.x + b.x) / 2;
    lastY = (a.y + b.y) / 2;
  }
});
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('pointerleave', () => {
  lastHoverAt = null;
  setHover(null);
});
canvas.addEventListener('pointermove', e => {
  const p = pointers.get(e.pointerId);
  if (p) {
    p.x = e.clientX;
    p.y = e.clientY;
  }
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dx = mx - lastX;
    const dy = my - lastY;
    const dpr = window.devicePixelRatio || 1;
    if (mode === '2d') {
      view.cx -= dx * dpr * view.upp;
      view.cy += dy * dpr * view.upp;
    }
    if (dist > 0 && pinchDist > 0) zoomAt(mx, my, pinchDist / dist);
    pinchDist = dist;
    lastX = mx;
    lastY = my;
    requestRender();
    scheduleViewportWriteback();
    return;
  }
  if (grab) {
    const [mx, my] = toMath(e.clientX, e.clientY);
    movePoint(grab.pt, mx + grab.dx, my + grab.dy);
    return;
  }
  if (!dragging) {
    // Hover: show what can be picked up.
    const hit = pointAt(e.clientX, e.clientY);
    canvas.style.cursor = hit ? 'grab' : '';
    setHot(hit?.key ?? null);
    lastHoverAt = { x: e.clientX, y: e.clientY };
    updateHover(e.clientX, e.clientY);
    return;
  }
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 3) dragMoved = true;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  const dpr = window.devicePixelRatio || 1;
  if (mode === '2d') {
    view.cx -= dx * dpr * view.upp;
    view.cy += dy * dpr * view.upp;
  } else if (panning) {
    // Pan the target in the camera's screen plane.
    const s = camera.radius * 0.0022;
    const ct = Math.cos(camera.theta), st = Math.sin(camera.theta);
    const sp = Math.sin(camera.phi), cp = Math.cos(camera.phi);
    // right = (-sinθ, cosθ, 0); up = (-cosθ·sinφ, -sinθ·sinφ, cosφ)
    camera.target[0] += (st * dx + ct * sp * dy) * s;
    camera.target[1] += (-ct * dx + st * sp * dy) * s;
    camera.target[2] += cp * dy * s;
  } else {
    camera.theta -= dx * 0.008;
    camera.phi = clampPhi(camera.phi + dy * 0.008);
  }
  requestRender();
  scheduleViewportWriteback();
});
const endPointer = (e: PointerEvent) => {
  pointers.delete(e.pointerId);
  if (!pointers.size) grab = null;
  if (pointers.size === 1) {
    // Pinch ended with one finger still down: resume dragging from it.
    const [p] = pointers.values();
    dragging = true;
    panning = false;
    lastX = p.x;
    lastY = p.y;
  } else if (pointers.size === 0) {
    dragging = false;
    // Settle the row/URL now and seal the gesture as one undo entry.
    flushViewportWriteback();
    coalesce = null;
  }
};
canvas.addEventListener('pointerup', e => {
  const dragged = grab !== null;
  endPointer(e);
  if (dragged) {
    coalesce = null; // seal the drag as one undo entry
    canvas.style.cursor = 'grab';
    return; // releasing a point never drops a seed
  }
  // A motionless primary-button click in 2D drops an integral-curve seed on
  // vector fields; right/shift clicks are pan gestures, not seeds.
  if (dragMoved || pointers.size || mode !== '2d' || e.button !== 0 || e.shiftKey) return;
  if (!equations.some(q => !q.error && q.cls?.plot.type === 'vfield2d')) return;
  // Each seed costs an RK4 integration per field per frame; keep the newest.
  if (drops.length >= MAX_DROPS) drops.shift();
  const [mx, my] = toMath(e.clientX, e.clientY);
  drops.push({ x: mx, y: my });
  requestRender();
});
canvas.addEventListener('pointercancel', e => {
  endPointer(e);
  if (!grab) canvas.style.cursor = '';
});
// Hover state is set on pointermove, so a pointer that exits the canvas
// without another move would leave the last point haloed; clear it unless a
// drag is in progress (pointer capture keeps those events flowing).
canvas.addEventListener('pointerleave', () => {
  if (grab || pointers.size) return;
  setHot(null);
  canvas.style.cursor = '';
});
canvas.addEventListener('dblclick', () => {
  if (!drops.length) return;
  drops.length = 0;
  requestRender();
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  setHover(null);
  const factor = Math.exp(Math.max(-60, Math.min(60, e.deltaY)) * 0.002);
  zoomAt(e.clientX, e.clientY, factor);
}, { passive: false });

// touch-action stops the viewport pinch-zoom everywhere it is honored, but
// WebKit still runs its own two-finger zoom off these non-standard gesture
// events. Swallowing them at the document is what actually pins the page at
// scale 1 on iOS; the canvas's own pinch (pointerdown/move above) is unaffected
// because it never depended on them.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, e => e.preventDefault(), { passive: false });
}

// The canvas box changes without a window resize event on mobile (URL bar
// collapsing, safe-area shifts, an in-app browser animating to full height),
// so observe the element itself. The window listener stays for devicePixelRatio
// changes, which move no box at all.
window.addEventListener('resize', resize);
new ResizeObserver(resize).observe(canvas);

// --- simulation reset ---

stateResetBtn?.addEventListener('click', () => {
  resetState();
  requestRender();
});

// --- theme ---

const themeToggle = document.getElementById('theme-toggle') as HTMLButtonElement | null;
function syncThemeToggle() {
  if (!themeToggle) return;
  themeToggle.textContent = theme.dark ? '☀' : '☾';
  const next = theme.dark ? 'light' : 'dark';
  themeToggle.setAttribute('aria-label', `Switch to ${next} mode`);
  themeToggle.title = `Switch to ${next} mode`;
}
initTheme();
// Color dots and every WebGL pass read `theme` live; redraw both on a switch.
onThemeChange(() => {
  syncThemeToggle();
  reconcile();
  requestRender();
});
syncThemeToggle();
themeToggle?.addEventListener('click', toggleTheme);

// --- panel flinging ---

// The panel is a corner-pinned floating card: flick it (touch anywhere on
// it; mouse via the grip strip) to another corner, or throw it past any
// edge to dismiss it — the y= chip it leaves behind brings it back. The
// equation list is passed in so text gestures (iOS caret and selection-
// handle drags) are never mistaken for throws.
initPanelSwipe(
  document.getElementById('panel')!,
  document.getElementById('panel-chip')!,
  document.getElementById('panel-grip')!,
  listEl,
);

// Drag the strip on the panel's outer vertical edge to resize it (the width
// persists; double-click resets).
initPanelResize(
  document.getElementById('panel')!,
  document.getElementById('panel-resize')!,
);

// --- boot ---

/** The graph payload the current URL names: the /g/ path, or a legacy
 *  #fragment (which wins, so an appended #… can steer a /g/ page). */
function urlPayload(): string {
  const hash = location.hash.slice(1);
  if (hash) return hash;
  return location.pathname.startsWith('/g/') ? location.pathname.slice('/g/'.length) : '';
}

const initialPayload = urlPayload();
// decodePayload splits bracket-aware and decodes each row exactly once, so it
// reads both the /g/ form and legacy /#… links.
const initialRows = decodePayload(initialPayload);
if (initialRows.length) initialRows.forEach(t => addEquation(t));
else addEquation('y = sin(x)');
recompileAll();
// Canonicalize what we loaded (re-encoded /g/ form; stray paths back to /).
// A fresh visit stays at / — the default row only enters the URL once edited.
if (initialPayload) saveUrl();
else if (location.pathname !== '/') history.replaceState(null, '', '/');

/**
 * The URL is an input, not only an output.
 *
 * Back/forward and an externally set URL both have to reach the graph, and
 * they have to reach it *without* a reload: re-navigating discards the WebGL
 * context and the camera and costs a server round-trip. Editing the address is
 * how browser automation drives this app, and until now setting location.hash
 * did nothing at all — only a full reload took effect.
 *
 * saveUrl() writes with replaceState, which fires neither event, so the app
 * cannot loop against its own writes; the equality check covers the rest.
 */
function loadFromUrl() {
  const rows = decodePayload(urlPayload());
  const wanted = rows.length ? rows : ['y = sin(x)'];
  const current = equations.map(e => e.text);
  if (wanted.length === current.length && wanted.every((t, i) => t === current[i])) return;
  equations.length = 0;
  wanted.forEach(t => addEquation(t));
  recompileAll();
  renderAll();
  requestRender();
}
addEventListener('popstate', loadFromUrl);
addEventListener('hashchange', loadFromUrl);

// Size the canvas (which also picks the opening zoom) before the first frame.
resize();
renderAll();
buildExamplesMenu();
void refreshFileMenu();

// Dev-only handle for driving/inspecting the view in automated tests.
if (import.meta.env.DEV) (window as any).__eq = { view, camera, equations, requestRender, flushViewportWriteback };
