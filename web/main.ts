import { type Env, emptyEnv, evaluateFrame } from '../lib/env.ts';
import { type CpuGrid, type CpuPlan, type GpuPlan, compileGridCpu, compileGridGpu, cpuStructureKey } from '../lib/compiler.ts';
import { analyzePrepared, prepareDocument } from '../lib/analysis.ts';
import { runtimeSliderNames } from '../lib/runtime-sliders.ts';
import { complexRootLabel } from '../lib/complex-label.ts';

import { initSyntaxHelp } from './syntax-help.ts';
import { attachCapture } from './capture.ts';
import { nextFeatured } from '../lib/featured.ts';
import { declaredNames } from '../lib/regression.ts';
import { PointTrail } from '../lib/point-trail.ts';
import {
  constsAnimated,
  definitionDependencies,
  formatTableRow,
  freeTableName,
  scanDefinition,
  TABLE_MAX_ROWS,
  type Definition,
} from '../lib/defs.ts';
import { buildComb, buildTube, combScale, curveExtent, curveFrames } from '../lib/curve3d.ts';
import {
  type DensityCurve,
  type PmfStems,
  RVSystem,
  markerHeight,
  shadePolygon,
  stemGeometry,
} from '../lib/dist.ts';
import { type IntShade, type ShadeRun, type ShadeSampler, evalSampler, minusTint, runPaths, shadeNames, shadeRuns } from '../lib/intshade.ts';
import { compileSampler } from '../lib/vm.ts';
import { SLIDER_NUM_RE as NUM_RE, coordinateDragWriter, dragAxes } from '../lib/drag.ts';
import { type Expr, evaluate, freeVars, substVars } from '../lib/expr.ts';
import { gpuFor, shaderBindings } from './render-plan.ts';
import { typedEscape } from '../lib/escapes.ts';
import { fieldEvaluator, streamline, traceField } from '../lib/flow.ts';
import { pointComps } from '../lib/geom.ts';
import { hullFaces } from '../lib/hull.ts';
import { hullGeometrySampler } from '../lib/hull-geometry.ts';

import { decodePayload, encodePayload } from '../lib/link.ts';
import { type GridField, angularSpacing, sampleGradMag } from '../lib/grid.ts';
import { CURVE_SAMPLES, type PathSampler, pathSampler } from '../lib/path.ts';
import { type Classified, plotReadout } from '../lib/plot.ts';
import { solveSystem } from '../lib/solve.ts';
import { TraceQueue, traceEnvironment, type TraceMessage, type TraceResult } from '../lib/trace-queue.ts';
import { type SpecialPoint, specialPoints } from '../lib/special.ts';

import { type StateSystem, advanceState, initialState } from '../lib/state.ts';
import { splitStatements } from '../lib/statements.ts';
import {
  type ViewSpec,
  clampPhi,
  scaleViewAt,
  fitView2D,
  formatCameraRow,
  formatViewRow,
  parseViewRow,
} from '../lib/view.ts';
import { type Table, tableNameFor } from '../lib/csv.ts';
import { shortHash } from '../lib/hash.ts';
import EmbeddedTraceWorker from './trace-worker.ts?worker&inline';
import { ingest, listFiles, loadRefs, lookup as lookupFile, removeFile } from './filestore.ts';
import { fullscreenQuad } from './gl.ts';
import {
  type GridSpec,
  type Layers2D,
  type Overlay2D,
  Renderer2D,
  type View2D,
  drawLabels2D,
  niceSpacing,
} from './render2d.ts';
import { type Camera3D, Renderer3D, type Scene3D, cameraBoxR, drawLabels3D } from './render3d.ts';
import { initPanelResize } from './panel-resize.ts';
import { initPanelSwipe } from './panel-swipe.ts';
import { initTheme, onThemeChange, theme, toggleTheme } from './theme.ts';

interface Equation {
  familyParent?: Equation;
  familyShade?: number;
  showArrows?: boolean;
  certify?: boolean;
  trail?: PointTrail;
  /** A definite-integral row's shaded area: the integrand compiled once per
   *  shade, and resampled only when the x-window or a value it reads (bounds,
   *  sliders, states, t) changes. */
  shadeCache?: { shade: IntShade; names: string[]; sampler: ShadeSampler; key: string; runs: ShadeRun[] };
  /** A 2D parametric curve's compiled sampler (lib/path.ts) and its last
   *  polyline, resampled only when a value it reads (sliders, states, t)
   *  changes — the shadeCache pattern. */
  pathCache?: { comps: Expr[]; sampler: PathSampler; key: string; pts: number[] };
  id: number;
  text: string;
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
  traceTarget?: string;
  traceClock?: number;
  sysCache?: { key: string; text: string; env: string; stableEnv: string; lo: number[]; hi: number[]; pts: number[][] };
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

/** A run of a discrete variable's stems (or the run a P(…) row selects, drawn
 *  `heavy`) as overlay geometry. What to draw is lib's (stemGeometry), shared
 *  with the og rasterizer; this only hands it to the canvas overlay. */
function pushStems(extras: Overlay2D, run: PmfStems, color: [number, number, number], heavy: boolean, pxPerUnit: number): void {
  if (!run.ks.length) return;
  const g = stemGeometry(run, heavy, pxPerUnit);
  const ink = g.alpha < 1 ? cssColorA(color, g.alpha) : cssColor(color);
  extras.polylines.push(g.fill === null
    ? { pts: g.lines, color: ink, width: g.width }
    : { pts: g.lines, color: ink, width: g.width, closed: true, fill: cssColorA(color, g.fill) });
  const dots = g.dots;
  if (dots) run.ks.forEach((k, n) => extras.points.push({ x: k, y: run.ps[n], color: ink, r: dots.r, bare: !dots.outlined }));
}

/** A solid's edges: its own colour pulled toward white, so they still read
 *  against faces lit in that colour. */
const edgeShade = ([r, g, b]: [number, number, number]): [number, number, number] =>
  [r + (1 - r) * .55, g + (1 - g) * .55, b + (1 - b) * .55];

function cssColorA([r, g, b]: [number, number, number], a: number): string {
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
}

/** RK4 steps in each direction for a dropped integral curve. */
const ODE_STEPS = 1400;
/** Most integral-curve seeds kept at once; older seeds evict first. */
const MAX_DROPS = 12;
/** Above this many points, a typed-array list draws as a bulk cloud rather
 *  than as individual (outlined, hoverable) points. */
const CLOUD_MIN = 400;
/** Most points a cloud may hold in a 3D scene. render3d has no instanced path
 *  — every point is a sprite it sorts and projects — so a cloud is capped
 *  there where a flat one is not, and says so rather than drawing part of the
 *  file. The scene, not the row, is what decides: a 2-column scatter goes down
 *  the same sprite path as soon as any row uses z. */
const CLOUD_3D_MAX = 10_000;

/** Points a row would put in a 3D scene, either representation: a typed-array
 *  scatter, or the symbolic point list a slider or t expands one into. */
const cloudPoints = (plot: CpuPlan): number =>
  (plot.type === 'dscatter' ? plot.coords[0].length : plot.type === 'plist' ? plot.pts.length : 0);
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
let defs: Env = emptyEnv();
let defsAnimated = false;
let constEnv: Record<string, number> = {};
/** Constants used as Σ/Π bounds; their sliders snap to integer steps. */
let sumBoundNames = new Set<string>();
let runtimeSliders = new Set<string>();
/** Constants that are a whole-number distribution parameter (the n of
 *  Binomial(n, p)); their sliders snap to integer steps too. */
let wholeParamNames = new Set<string>();
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
let capture: ReturnType<typeof attachCapture> | undefined;

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
  if (rendererDisposed) return;
  syncCanvasSize();
  requestRender();
}

let renderQueued = false;
let renderFrame = 0;
let renderTimer: ReturnType<typeof setTimeout> | null = null;
let rendererDisposed = false;
let pausedAt: number | null = null;
let pausedMilliseconds = 0;
function cancelRender() {
  cancelAnimationFrame(renderFrame);
  if (renderTimer !== null) clearTimeout(renderTimer);
  renderFrame = 0;
  renderTimer = null;
  renderQueued = false;
}
function requestRender() {
  if (renderQueued || rendererDisposed || pausedAt !== null) return;
  renderQueued = true;
  let ran = false;
  const run = () => {
    if (ran) return;
    ran = true;
    cancelRender();
    if (rendererDisposed || pausedAt !== null) return;
    render();
  };
  renderFrame = requestAnimationFrame(run);
  // rAF stalls entirely in hidden/occluded tabs (embedded previews,
  // screenshot tooling); a timer backstop keeps frames coming there.
  renderTimer = setTimeout(run, 200);
}

let startTime = performance.now();

/** Seconds since load: the value of `t` everywhere in a graph. */
const graphTime = () => ((pausedAt ?? performance.now()) - startTime - pausedMilliseconds) / 1000;

function restartGraphClock() {
  const now = performance.now();
  startTime = now;
  pausedMilliseconds = 0;
  if (pausedAt !== null) pausedAt = now;
}

function setGraphVisible(visible: boolean) {
  if (rendererDisposed) return;
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
function currentConstEnv(time: number): Record<string, number> {
  if (stateSys) stateTime = advanceState(defs, stateSys, stateVals, stateTime, time);
  try {
    return evaluateFrame(defs, time, stateVals);
  } catch {
    return { ...stateVals };
  }
}

/** Send the state system back to its `a(0)` values, starting from now. */
function resetState() {
  for (const eq of equations) eq.trail = undefined;
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
    Object.assign(view, { ratio: 1 }, fitView2D(vRow.viewSpec!, canvas.width, canvas.height));
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
  // Rows can arrive while rendering is paused, before their viewport is live.
  // Only an outstanding interaction authorizes writing the live view back.
  if (viewportWriteTimer === null) return;
  clearTimeout(viewportWriteTimer);
  viewportWriteTimer = null;
  writebackViewport();
}

/** Drop a pending pan and the live window so a new document isn't framed as the old one. */
function resetViewport() {
  if (viewportWriteTimer !== null) {
    clearTimeout(viewportWriteTimer);
    viewportWriteTimer = null;
  }
  appliedViewText = appliedCameraText = null;
  view.cx = 0;
  view.cy = 0;
  delete view.ratio;
  const w = canvas.width;
  const h = canvas.height;
  view.upp = w && h ? 12 / Math.min(w, h) : 0.01;
  camera.target = [0, 0, 0];
  camera.radius = 14;
  camera.theta = -Math.PI / 3;
  camera.phi = Math.PI / 5.5;
}

function ensureViewRow() {
  if (viewportRow('view')) return;
  const id = nextId;
  pushUndo(`viewport:${id}`);
  const hw = canvas.width * view.upp / 2;
  const hh = canvas.height * view.upp / (view.ratio ?? 1) / 2;
  const eq = addEquation(formatViewRow(view.cx - hw, view.cx + hw, view.cy - hh, view.cy + hh, view.ratio));
  appliedViewText = eq.text;
  recompileAll();
  renderAll();
  saveUrl();
}

function writebackViewport() {
  const eq = viewportRow(mode === '2d' ? 'view' : 'camera');
  if (!eq) return;
  let text: string;
  if (mode === '2d') {
    if (!canvas.width || !canvas.height) return;
    const hw = (canvas.width / 2) * view.upp;
    const hh = (canvas.height / 2) * (view.upp / (view.ratio ?? 1));
    text = formatViewRow(view.cx - hw, view.cx + hw, view.cy - hh, view.cy + hh, view.ratio);
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
  // Only the framing changed. Reclassifying the math here discards geometry
  // caches and can block every camera gesture for hundreds of milliseconds.
  // Text the formatter cannot round-trip (a non-finite window) still lands
  // as this row's error, the way a typed view(...) does.
  try {
    eq.viewSpec = parseViewRow(text, {}) ?? undefined;
  } catch {
    recompileAll();
  }
  reconcile();
  saveUrl();
}

// Classification produces new AST objects even when only view(...) changed.
// Compare mathematical content, computed once per classification, not identity.
const systemKeys = new WeakMap<CpuPlan, string>();
const traceEnvironments = new WeakMap<Classified, ReturnType<typeof traceEnvironment>>();
function systemKey(cpu: CpuPlan): string {
  let key = systemKeys.get(cpu);
  if (key === undefined) { key = cpuStructureKey(cpu); systemKeys.set(cpu, key); }
  return key;
}
const mcpApp = document.documentElement.hasAttribute('data-mcp-app');
const framed = document.documentElement.hasAttribute('data-embed');
/** MCP widget or a framed graph: no address-bar writes, no featured default. */
const embedded = mcpApp || framed;
let graphChanged: ((rows: string[]) => void) | undefined;
let graphEdited: (() => void) | undefined;
let traceWorker: Worker | undefined;
const traceQueue = new TraceQueue((message: TraceMessage) => {
  if (rendererDisposed) return;
  const fail = (error: string) => {
    traceWorker?.terminate();
    traceWorker = undefined;
    traceQueue.complete(message.token, { pts: [], error });
  };
  try {
    // The chat iframe is cross-origin; its worker must be created locally.
    // Framed /g/ pages load their worker from their own origin.
    traceWorker ??= mcpApp ? new EmbeddedTraceWorker()
      : new Worker(new URL('./trace-worker.ts', import.meta.url), { type: 'module' });
    traceWorker.onmessage = (event: MessageEvent<{ token: number; result: TraceResult }>) => {
      traceQueue.complete(event.data.token, event.data.result);
    };
    traceWorker.onerror = event => {
      event.preventDefault();
      fail('Could not trace this curve in the background: ' + event.message);
    };
    traceWorker.onmessageerror = () => fail('Could not read the background curve trace.');
    traceWorker.postMessage(message);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
});

const familyRows = new WeakMap<Classified, Equation[]>();
const hullSamplers = new WeakMap<CpuPlan, ReturnType<typeof hullGeometrySampler>>();
let familyId = -100000;
function renderMembers(eq: Equation): Equation[] {
  const cls = eq.cls!, cpu = eq.cpu!;
  if (cpu.type !== 'family') return [eq];
  let children = familyRows.get(cls);
  if (!children) {
    const gpuMembers = eq.gpu?.type === 'family' ? eq.gpu.members : [];
    children = cpu.members.map((m, k) => ({ ...eq, id: familyId--, cls: m.cls, cpu: m.cpu, gpu: gpuMembers[k],
      familyParent: eq, familyShade: .45 * k / Math.max(1, cpu.members.length - 1),
      sysCache: undefined, pathCache: undefined, traceTarget: undefined }));
    familyRows.set(cls, children);
  }
  return children;
}

const rowColor = (eq: Equation): [number, number, number] => theme.palette[eq.colorIndex].map(c => c + (1 - c) * (eq.familyShade ?? 0)) as [number, number, number];
const liveRow = (eq: Equation) => equations.includes(eq.familyParent ?? eq) && (!eq.familyParent || (!!eq.familyParent.cls && renderMembers(eq.familyParent).includes(eq)));

function render() {
  if (!syncCanvasSize()) return;
  applyViewportRows();
  const dpr = window.devicePixelRatio || 1;
  const time = graphTime();
  const active = equations.filter(e => e.cls && !e.error).flatMap(renderMembers);
  mode = active.some(e => e.cls!.needs3D) ? '3d' : '2d';

  // States carry between frames, so they are integrated up to now before
  // anything reads them; the constants may then be formulas in those states.
  constEnv = currentConstEnv(time);

  // Readouts belong to the source row, even when its family has many draws.
  for (const eq of equations) {
    if (!eq.cls || eq.error) continue;
    try {
      const text = plotReadout(eq.cpu!, { ...constEnv, t: time });
      if (text !== null && text !== eq.info) { eq.info = text; if (eq.infoEl) eq.infoEl.textContent = text; }
    } catch { /* incomplete values while editing */ }
  }

  for (const eq of active) {
    if (eq.cpu!.type !== 'trail') continue;
    const plot = eq.cpu!;
    eq.trail ??= new PointTrail(plot.dim);
    let point: number[];
    try { point = plot.coords.map(c => evaluate(c, { ...constEnv, t: time })); }
    catch { point = Array(plot.dim).fill(NaN); }
    eq.trail.sample(time, point);
  }

  // Fresh joint sample every frame: estimated density curves shimmer with
  // their true sampling noise instead of freezing one pairing into wiggles
  // that read as structure. Exact laws don't sample and are unaffected.
  if (rvSys.size() > 0) rvSys.resample();

  gl.clearColor(theme.bg[0], theme.bg[1], theme.bg[2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  // CPU sampling of parametric curves / points, with t bound to seconds.
  const sampleCurve = (eq: Equation, dim: 2 | 3): number[] => {
    const { comps } = eq.cpu! as { comps: Expr[] };
    // A plane curve (a complex path included): compiled, and broken at its
    // jumps — branch cuts, steps, poles.
    if (dim === 2) {
      let c = eq.pathCache;
      if (c?.comps !== comps) c = eq.pathCache = { comps, sampler: pathSampler(comps), key: '', pts: [] };
      const env: Record<string, number> = { ...constEnv, t: time };
      const key = c.sampler.names.map(n => env[n]).join();
      if (key !== c.key || !c.pts.length) {
        c.key = key;
        c.pts = c.sampler.sample(env);
      }
      return c.pts;
    }
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
  const integralCurve = (comps: [Expr, Expr], x0: number, y0: number, time: number, uniforms: Record<string, number> = {}): number[] => {
    const w = 1.5 * gl.drawingBufferWidth * view.upp;
    const h = 1.5 * gl.drawingBufferHeight * view.upp / (view.ratio ?? 1);
    return streamline(fieldEvaluator(comps, { ...constEnv, ...uniforms, t: time }), [x0, y0], 2.5 * view.upp,
      [view.cx - w, view.cy - h], [view.cx + w, view.cy + h], ODE_STEPS, [1, view.ratio ?? 1]).flat();
  };

  const samplePoint = (eq: Equation): number[] | null => {
    const { coords } = eq.cpu! as { coords: import('../lib/expr.ts').Expr[] };
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
      const [tx, ty, tz] = camera.target;
      vlo = [tx - r, ty - r, tz - r];
      vhi = [tx + r, ty + r, tz + r];
    } else {
      const dpr = window.devicePixelRatio || 1;
      const halfW = ((canvas.clientWidth * dpr) / 2) * view.upp;
      const halfH = ((canvas.clientHeight * dpr) / 2) * (view.upp / (view.ratio ?? 1));
      vlo = [view.cx - halfW, view.cy - halfH];
      vhi = [view.cx + halfW, view.cy + halfH];
    }
    const pad = vhi.map((v, k) => 0.25 * (v - vlo[k]));
    const lo = vlo.map((v, k) => v - pad[k]);
    const hi = vhi.map((v, k) => v + pad[k]);
    // Arrow glyphs sample live t so an animated field stays smooth.
    if (eq.cpu!.type === 'vfield3d' && eq.showArrows) {
      traceQueue.cancelPending(eq.id);
      try {
        return traceField(residuals, lo, hi, { ...constEnv, t: time }, true)
          .flatMap(path => [...path, Array(dim).fill(NaN)]);
      } catch (e) {
        (eq.familyParent ?? eq).error = e instanceof Error ? e.message : String(e);
        reconcile();
        return [];
      }
    }
    let environment = traceEnvironments.get(cls);
    if (!environment) {
      environment = traceEnvironment(cls.params, cls.animated, defs);
      traceEnvironments.set(cls, environment);
    }
    const traceTime = eq.cpu!.type === 'vfield3d' ? Math.floor(time * 20) / 20 : time;
    const { env: envKey, stableEnv } = environment(constEnv, traceTime);
    const key = systemKey(eq.cpu!) + ':' + !!eq.showArrows + ':' + !!eq.certify;
    const c = eq.sysCache;
    if (c && c.key === key && c.text === eq.text && c.env === envKey && c.lo.length === dim
      && vlo.every((v, k) => c.lo[k] <= v && c.hi[k] >= vhi[k] && c.hi[k] - c.lo[k] <= 6 * (vhi[k] - v))) {
      eq.traceTarget = undefined;
      traceQueue.cancelPending(eq.id);
      return c.pts;
    }
    if ((eq.cpu!.type === 'system' && eq.cpu!.parametric) || eq.cpu!.type === 'vfield3d' || eq.cpu!.type === 'spacecurve' || (eq.cpu!.type === 'system' && eq.certify)) {
      const jobKey = JSON.stringify([key, envKey, lo, hi]);
      const target = JSON.stringify([key, stableEnv, lo, hi]);
      const retraceMs = eq.cpu!.type === 'vfield3d' ? 50 : 250;
      if ((eq.cpu!.type === 'vfield3d' || eq.certify) && eq.traceTarget === target && performance.now() - (eq.traceClock ?? -Infinity) < retraceMs) return c && c.stableEnv === stableEnv ? c.pts : [];
      eq.traceTarget = target; eq.traceClock = performance.now();
      if (eq.certify && eq.info !== 'Certifying search box…') { eq.info = 'Certifying search box…'; reconcile(); }
      traceQueue.request(eq.id, jobKey, {
        residuals, dim, lo, hi, env: { ...constEnv, t: traceTime },
        kind: eq.certify ? 'certify' : eq.cpu!.type === 'spacecurve' ? 'intersection' : eq.cpu!.type === 'vfield3d' ? 'field' : 'system', glyphs: eq.showArrows,
        angular: eq.cpu!.type === 'system' ? eq.cpu!.angular : undefined,
      }, result => {
        // A result for edited/deleted math must never restore an old curve.
        if (!liveRow(eq) || !eq.cls || systemKey(eq.cpu!) + ':' + !!eq.showArrows + ':' + !!eq.certify !== key) return;
        // A trace from a briefly zoomed-in view must not replace the full
        // curve after the user zooms back out. Only moving values may lag.
        if (eq.traceTarget !== target) return;
        if (result.error) {
          (eq.familyParent ?? eq).error = result.error;
          reconcile();
        } else {
          eq.sysCache = { key, text: eq.text, env: envKey, stableEnv, lo, hi, pts: result.pts };
          if (result.info) { eq.info = result.info; reconcile(); }
        }
        requestRender();
      });
      // Keep projecting existing world-space geometry during pan/zoom.
      // Constants changing invalidate it; animated rows use the last completed
      // frame while their next trace runs in the worker.
      const sameEnv = c && c.stableEnv === stableEnv;
      return c && c.key === key && sameEnv ? c.pts : [];
    }
    const pts = solveSystem(residuals, dim === 3 ? ['x', 'y', 'z'] : ['x', 'y'], lo, hi, {
      env: { ...constEnv, t: time }, angular: eq.cpu!.type === 'system' ? eq.cpu!.angular : undefined,
    });
    eq.sysCache = { key, text: eq.text, env: envKey, stableEnv, lo, hi, pts };
    return pts;
  };

  if (mode === '3d') {
    const scene: Scene3D = { implicits: [], psurfaces: [], curves: [], segments: [], tubes: [], points: [] };
    for (const eq of active) {
      const color = rowColor(eq);
      const plot = eq.cpu!;
      const { params, uniforms } = shaderBindings(eq.gpu);
      switch (plot.type) {
        case 'implicit2d': // extrudes to its true locus (a vertical sheet)
          scene.implicits.push({ field: gpuFor(eq, 'implicit2d').field, color, params, uniforms });
          break;
        case 'implicit3d':
          scene.implicits.push({ ...gpuFor(eq, 'implicit3d'), color, params, uniforms });
          break;
        case 'scalar2d':
        case 'complex2d':
        case 'domain2d':
        case 'rgb2d':
        case 'hsl2d':
        case 'oklch2d':
        case 'conformal2d':
        case 'fractal2d':
        case 'ineq2d':
        case 'vfield2d':
        case 'vlist':
        case 'dlist':
        case 'histogram':
        case 'sequence':
        case 'cobweb':
        case 'bifurcation':
        case 'density':
        case 'pmf':
        case 'prob':
        case 'expect':
          break; // 2D-only plots (densities, flows, sequences, planar figures); skipped in 3D scenes
        case 'spacecurve': {
          const pts = solveFor(eq, 3, plot.residuals);
          scene.curves.push({ pts: new Float32Array(pts.flat()), color });
          break;
        }
        case 'vfield3d': {
          const pts = solveFor(eq, 3, plot.comps);
          if (eq.showArrows) {
            const flat = pts.flat();
            if (flat.length >= 6) scene.curves.push({ pts: new Float32Array(flat), color, arrow: true });
          } else {
            let path: number[] = [];
            const flush = () => { if (path.length >= 6) scene.curves.push({ pts: new Float32Array(path), color, fade: true }); path = []; };
            for (const p of pts) { if (p.every(Number.isFinite)) path.push(...p); else flush(); }
            flush();
          }
          break;
        }
        case 'polygon': {
          const dim = plot.dim ?? 2;
          if (plot.hull) {
            let sample = hullSamplers.get(plot);
            if (!sample) { sample = hullGeometrySampler(plot.pts, dim); hullSamplers.set(plot, sample); }
            const geometry = sample(constEnv, time);
            if (!geometry) break;
            const { mesh, edges } = geometry;
            if (mesh.indices.length) scene.tubes.push({ ...mesh, cells: [1, 1], color, retained: true });
            scene.segments.push({ pts: edges, color: mesh.indices.length ? edgeShade(color) : color, retained: true });
            break;
          }
          const vals = plot.pts.map(p => evaluate(p, { ...constEnv, t: time }));
          if (!vals.every(Number.isFinite)) break;
          const pts: number[] = [];
          for (let k = 0; k < vals.length; k += dim) pts.push(vals[k], vals[k + 1], dim === 3 ? vals[k + 2] : 0);
          const triangle = plot.closed && pts.length === 9;
          if (plot.closed) pts.push(...pts.slice(0, 3));
          scene.curves.push({ pts: new Float32Array(pts), color, arrow: plot.arrow, triangle });
          break;
        }
        case 'dscatter': {
          // One sprite per point (see CLOUD_3D_MAX); any row with more than
          // that is rejected at compile time — flat clouds included, since
          // they reach this path too whenever the scene is 3D — so nothing is
          // dropped here. A gap in ANY coordinate skips the point: an unplaced
          // z would otherwise reach projection and depth sorting as NaN.
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
          scene.psurfaces.push({ ...gpuFor(eq, 'psurface'), color, params, uniforms });
          break;
        case 'trail': {
          scene.curves.push({ pts: new Float32Array(eq.trail!.coordinates(3)), color });
          const p = eq.trail!.head;
          if (p) scene.points.push({ pos: [p[0], p[1], p[2] ?? 0], color });
          break;
        }
        case 'pcurve': {
          const flat = sampleCurve(eq, plot.dim);
          // A broken path carries extra (NaN) points at its jumps.
          const count = flat.length / plot.dim;
          const pts = new Float32Array(count * 3);
          for (let k = 0; k < count; k++) {
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
          if (p) scene.points.push({ pos: [p[0], p[1], p[2] ?? 0], color, label: eq.def?.name });
          break;
        }
        case 'system':
          if (plot.parametric) {
            const pts = solveFor(eq, plot.dim, plot.residuals).flatMap(p => [p[0], p[1], p[2] ?? 0]);
            scene.curves.push({ pts: new Float32Array(pts), color });
            break;
          }
          for (const p of solveFor(eq, plot.dim, plot.residuals)) {
            scene.points.push({ pos: [p[0], p[1], p[2] ?? 0], color });
          }
          break;
      }
    }
    r3d.render(camera, scene, time, constEnv);
    drawLabels3D(overlayCtx, camera, dpr, scene.points);
  } else {
    r3d.clearGeometry();
    const layers: Required<Layers2D> = {
      levels: [], fractals: [], domains: [], colors: [], conformals: [], vfields: [],
      ineqs: [], bifs: [], scalars: [], complexes: [], curves: [],
    };
    const extras: Overlay2D = { points: [], polylines: [], bars: [], clouds: [] };
    // Spacing for any level-set family (custom grids, contour stacks): sample
    // |∇c| around the view to convert the target pixel gap into coordinate
    // units (π-based for angles).
    const halfW = (gl.drawingBufferWidth / 2) * view.upp;
    const halfH = (gl.drawingBufferHeight / 2) * (view.upp / (view.ratio ?? 1));
    const xmin = view.cx - halfW;
    const xmax = view.cx + halfW;
    const stemPx = 1 / (view.upp * dpr); // CSS px between consecutive whole numbers
    const viewPts: Array<[number, number]> = [
      [view.cx, view.cy],
      [view.cx - halfW / 2, view.cy], [view.cx + halfW / 2, view.cy],
      [view.cx, view.cy - halfH / 2], [view.cx, view.cy + halfH / 2],
    ];
    const env: Record<string, number> = { ...constEnv, t: time };
    const seedOf = (a0Name?: string): number => (a0Name !== undefined ? constEnv[a0Name] : undefined) ?? 0.5;
    const levelSpacing = (f: CpuGrid) => {
      const cupp = sampleGradMag(f, viewPts, env, view.upp * 4, view.ratio) * view.upp;
      return f.angular ? angularSpacing(cupp, 90) : niceSpacing(cupp, 90);
    };
    for (const eq of active) {
      const color = rowColor(eq);
      const css = cssColor(color);
      const plot = eq.cpu!;
      const { params, uniforms } = shaderBindings(eq.gpu);
      switch (plot.type) {
        case 'implicit2d':
          layers.curves.push({ field: gpuFor(eq, 'implicit2d').field, color, params, uniforms });
          if (eq.showLevels && plot.levels) {
            const f = plot.levels;
            const shader = gpuFor(eq, 'implicit2d').levels!;
            const sp = levelSpacing(f);
            layers.levels.push({ glsl: shader.glsl, gradGlsl: shader.gradGlsl, params: f.params, major: sp.major, minor: sp.minor, color });
          }
          break;
        case 'ineq2d': layers.ineqs.push({ ...gpuFor(eq, 'ineq2d'), color, params, uniforms }); break;
        case 'scalar2d': layers.scalars.push({ ...gpuFor(eq, 'scalar2d'), color, params, uniforms }); break;
        case 'complex2d': layers.complexes.push({ ...gpuFor(eq, 'complex2d'), color, params, uniforms }); break;
        case 'domain2d': layers.domains.push({ ...gpuFor(eq, 'domain2d'), color, params, uniforms }); break;
        case 'rgb2d': case 'hsl2d': case 'oklch2d':
          layers.colors.push({ ...gpuFor(eq, plot.type), color, params, uniforms }); break;
        case 'conformal2d': layers.conformals.push({ ...gpuFor(eq, 'conformal2d'), color, params, uniforms }); break;
        case 'fractal2d':
          layers.fractals.push({ ...gpuFor(eq, 'fractal2d'), color, params, uniforms });
          break;
        case 'vfield2d': {
          layers.vfields.push({ ...gpuFor(eq, 'vfield2d'), color, params, uniforms });
          drops.forEach((d, i) => {
            extras.polylines.push({ pts: integralCurve(plot.comps, d.x, d.y, time), color: css });
            extras.points.push({ x: d.x, y: d.y, color: css, hot: hotPoint === `drop${i}` });
          });
          break;
        }
        case 'trail': {
          extras.polylines.push({ pts: eq.trail!.coordinates(2), color: css });
          const p = eq.trail!.head;
          if (p) extras.points.push({ x: p[0], y: p[1], color: css });
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
            pts: plot.hull ? hullFaces(pts, 2)[0].outline.flatMap(p => [p[0], p[1]]) : pts,
            color: css,
            closed: plot.closed,
            fill: plot.closed ? cssColorA(color, 0.16) : undefined,
            arrow: plot.arrow,
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
          // (terms that are not finite, like 1/0², are skipped). A term that
          // throws — a Σ(s=1..n, …) past its term limit — is skipped, and a
          // partial sum stops there so the running total does not freeze.
          const termAt = (n: number): number | undefined => {
            env[plot.index] = n;
            try { return evaluate(plot.term, env); } catch { return undefined; }
          };
          const nEnd = Math.min(Math.floor(xmax), eq.partialSum ? 20000 : 100000);
          const n0 = Math.max(0, Math.ceil(xmin));
          const step = Math.max(1, Math.ceil((nEnd - n0 + 1) / 4000));
          if (eq.partialSum) {
            let sum = 0;
            let started = false;
            for (let n = 0; n <= nEnd; n++) {
              const v = termAt(n);
              if (v === undefined) break;
              if (isFinite(v)) { sum += v; started = true; }
              if (started && n >= n0 && (n - n0) % step === 0) {
                extras.points.push({ x: n, y: sum, color: css, r: 3.5 });
              }
            }
          } else {
            for (let n = n0; n <= nEnd; n += step) {
              const v = termAt(n);
              if (v !== undefined && isFinite(v)) extras.points.push({ x: n, y: v, color: css, r: 3.5 });
            }
          }
          delete env[plot.index];
          break;
        }
        case 'cobweb': {
          layers.curves.push({ field: gpuFor(eq, 'cobweb').curveField, color, params, uniforms });
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
          layers.bifs.push({ field: gpuFor(eq, 'bifurcation').field, color, params, uniforms: { uSeed: seedOf(plot.a0Name) } });
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
        case 'value': {
          // A definite-integral row: the number lives in the row's readout;
          // the plot is the area it measures. Parts that add to the value
          // take the row color, parts that subtract its complement.
          if (!plot.shade) break;
          let c = eq.shadeCache;
          if (c?.shade !== plot.shade) {
            const names = shadeNames(plot.shade);
            const sampler = compileSampler(plot.shade.body, plot.shade.v, names) ?? evalSampler(plot.shade);
            c = eq.shadeCache = { shade: plot.shade, names, sampler, key: '', runs: [] };
          }
          const key = [xmin, xmax, ...c.names.map(n => env[n])].join();
          if (key !== c.key) {
            c.key = key;
            c.runs = shadeRuns(plot.shade, env, xmin, xmax, c.sampler);
          }
          const minus = minusTint(color);
          for (const run of c.runs) {
            // Only real edges are stroked: not where the window cut the range.
            const tint = run.sign > 0 ? color : minus;
            const { fill, stroke } = runPaths(run, view.cy - halfH, view.cy + halfH);
            extras.polylines.push({ pts: fill, color: cssColor(tint), closed: true, fill: cssColorA(tint, 0.16), noStroke: true });
            extras.polylines.push({ pts: stroke, color: cssColor(tint) });
          }
          break;
        }
        case 'pmf': {
          // Stems at the atoms in view — whole numbers for a declared law,
          // wherever g put them for a derived one; lib caches them per window.
          try {
            for (const run of rvSys.pmfRuns(plot.rv, env, { lo: xmin, hi: xmax }) ?? []) {
              pushStems(extras, run, color, false, stemPx);
            }
          } catch { /* a parameter is missing this frame */ }
          break;
        }
        case 'prob': {
          // The estimate lives in the row's readout; the plot is the shaded
          // area under the variable's density, when the body has that shape.
          if (!plot.shade) break;
          try {
            // Over a discrete variable: the selected stems, drawn heavier —
            // `X < 3` stops at 2 and `X <= 3` takes the stem at 3.
            const selected = rvSys.pmfRuns(plot.shade.rv, env, { lo: xmin, hi: xmax }, plot.shade);
            if (selected) {
              for (const run of selected) pushStems(extras, run, color, true, stemPx);
              break;
            }
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
            // Where and how high is lib's rule (markerHeight), shared with og.
            const mark = markerHeight(rvSys, plot.rv, env, { lo: xmin, hi: xmax });
            if (!mark) break;
            if (mark.h > 0) extras.polylines.push({ pts: [mark.x, 0, mark.x, mark.h], color: css, width: 2 });
            extras.points.push({ x: mark.x, y: mark.h, color: css, r: 4 });
          } catch { /* not evaluable this frame */ }
          break;
        }
        case 'system':
          // A 3-unknown system forces the 3D view, so only 2D lands here.
          if (plot.dim === 2) {
            const points = solveFor(eq, 2, plot.residuals);
            if (plot.parametric) { extras.polylines.push({ pts: points.flat(), color: css }); break; }
            const set = coordinatePointWriter(eq, plot.coordinates);
            points.forEach((p, i) => {
              const key = `sys${eq.id}:${i}`;
              extras.points.push({ x: p[0], y: p[1], color: css, hot: hotPoint === key, label: complexRootLabel(plot.complexEquation, p, env) });
              if (set) grabs.push({ key, x: p[0], y: p[1], edits: true, set });
            });
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
  capture?.afterFrame();
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

let trailDocument = '';

function resetEditedTrails() {
  // Framing and comment edits preserve trails; changing the math starts a
  // fresh observation so unrelated runs never get joined by a false segment.
  const mathText = equations.map(eq => eq.text.trim()).filter(text =>
    text && !text.startsWith('#') && !/^(view|camera)\s*\(/i.test(text)).join('\n');
  if (mathText !== trailDocument) {
    for (const eq of equations) eq.trail = undefined;
    trailDocument = mathText;
  }
}

/**
 * Drop work derived from the previous constants: hover points and pending
 * traces read them, so a recompile and a direct slider rebind both end here.
 */
function invalidateDerivedState() {
  for (const eq of equations) {
    eq.spCache = undefined;
    eq.traceTarget = undefined;
  }
  spGen++; // queued hover recomputes predate this change: drop them
  spQueue.clear();
  setHover(null);
}

/** Rebuild definitions and plots after edits that may change their structure. */
function recompileAll() {
  resetEditedTrails();
  // Preparation is independent of the running simulation and sampler. Keep
  // their caller-owned state across edits whose state-system key is unchanged.
  const prepared = prepareDocument(equations.map(({ id, text }) => ({ id, text })), {
    tables: ref => lookupFile(ref.file, ref.hash)?.table ?? null,
  });
  defs = prepared.defs;
  ensureTables(prepared.raw);
  sumBoundNames = prepared.sumBoundConsts;
  const wasKey = stateSys?.key;
  stateSys = prepared.stateSystem;
  if (stateSys?.key !== wasKey) resetState();

  const analysis = analyzePrepared(prepared, {
    stateValues: stateVals,
    rvs: rvSys,
    readoutPolicy: 'static',
    backend: 'both',
  });
  runtimeSliders = runtimeSliderNames(analysis);
  gridFields = analysis.gridFields.map(spec => ({ ...compileGridCpu(spec), ...compileGridGpu(spec) }));
  wholeParamNames = rvSys.wholeParamNames();
  for (let i = 0; i < equations.length; i++) {
    const eq = equations[i], row = analysis.rows[i];
    eq.cls = row.cls;
    eq.cpu = row.cpu;
    eq.gpu = row.gpu;
    eq.error = row.error ?? row.dataLocal;
    eq.needsFile = row.needsFile || !!row.dataLocal;
    eq.info = row.info;
    eq.def = row.def;
    eq.viewSpec = row.view;
    eq.comment = row.comment;
    if (!eq.comment) eq.collapsed = undefined;

    // Cloud capacity is a browser renderer limit, independent of analysis.
    const plot = eq.cpu;
    if (!eq.error && plot && (plot.type === 'dscatter' || plot.type === 'plist')
      && plot.dim === 3 && cloudPoints(plot) > CLOUD_3D_MAX) {
      eq.error = `A 3D cloud draws at most ${CLOUD_3D_MAX} points;`
        + ` that is ${cloudPoints(plot)}.`
        + ' Filter it first, or plot two of the columns.';
    }
  }
  defsAnimated = constsAnimated(defs) || defs.states.size > 0;
  // …and a 2D cloud costs the same once ANYTHING makes the scene 3D: the
  // renderer sends every scatter through the sprite path there, z = 0 and
  // all, so a 200 000-point CSV beside one `z = …` row is 200 000 projected,
  // depth-sorted sprites. Whether the scene is 3D is only known once every
  // row has classified, which is why this waits for the loop to finish.
  if (equations.some(eq => eq.cls && !eq.error && eq.cls.needs3D)) {
    for (const eq of equations) {
      if (!eq.cls || eq.error) continue;
      const points = cloudPoints(eq.cpu!);
      if (points <= CLOUD_3D_MAX) continue;
      eq.cls = undefined;
      eq.error = `This graph is 3D, where every point is a sprite: at most ${CLOUD_3D_MAX},`
        + ` and this row has ${points}. Filter it, or drop the row that uses z.`;
    }
  }
  rvSys.prune(); // sample caches of variables that no longer exist
  invalidateDerivedState();
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
function rowNameFor(base: string): string {
  // Scanned from the row TEXT, not from `eq.def`: dropping several files at
  // once appends a row per file and recompiles only at the end, so the rows
  // added moments ago have no def yet. Reading the stale defs gave two files
  // with the same stem (sales.csv, sales.tsv) the same name, and the second
  // row then lost to the duplicate check.
  return freeTableName(base, new Set(equations
    .map(eq => eq.def?.name ?? scanDefinition(eq.text)?.name)
    .filter((n): n is string => !!n)));
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
    // Whether the bytes survive a reload is the same news on either path, and
    // it matters most on this one: a drop that answers "the file is not on
    // this device" would have to answer it again after every reload.
    const fragile = loaded.durable ? ''
      : ' (this browser is not storing files — it will be gone on reload)';
    if (known) {
      added.push(`${loaded.file} reloaded${fragile}`);
      continue;
    }
    const name = rowNameFor(tableNameFor(loaded.file));
    // Land on the trailing blank row if there is one, so dropping twice does
    // not leave gaps.
    const last = equations[equations.length - 1];
    const at = last && !last.text.trim() ? equations.length - 1 : equations.length;
    addEquation(formatTableRow(name, loaded.file, loaded.hash), at);
    const nums = loaded.table.columns.filter(c => c.type === 'num');
    if (nums.length >= 2 && loaded.table.rows <= TABLE_MAX_ROWS) {
      addEquation(`(${name}.${nums[0].name}, ${name}.${nums[1].name})`, at + 1);
    }
    added.push(`${loaded.file}: ${loaded.table.rows} rows as ${name}${fragile}`);
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
  if (embedded) {
    graphChanged?.(equations.map(e => e.text));
    return;
  }
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
  graphEdited?.();
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

/** The DOM position of a character offset in a line (end of line when past it). */
function nodeAt(line: number, offset: number): { node: Node; offset: number } | null {
  const el = lineEls()[line];
  if (!el) return null;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let t: Node | null;
  while ((t = walker.nextNode())) {
    const len = t.textContent!.length;
    if (remaining <= len) return { node: t, offset: remaining };
    remaining -= len;
  }
  return { node: el, offset: el.childNodes.length };
}

function setCaret(line: number, offset: number) {
  const p = nodeAt(line, offset);
  if (p) getSelection()!.setBaseAndExtent(p.node, p.offset, p.node, p.offset);
}

/** Restore a (possibly multi-line) selection by character positions. */
function setSelectionSpan(
  start: { line: number; offset: number },
  end: { line: number; offset: number },
) {
  const a = nodeAt(start.line, start.offset);
  const b = nodeAt(end.line, end.offset);
  if (a && b) getSelection()!.setBaseAndExtent(a.node, a.offset, b.node, b.offset);
}

// --- undo/redo ---
//
// One snapshot stack over the whole document (texts, colors, slider bounds),
// replacing the browser's DOM-level history — programmatic re-renders (Enter,
// paste, ';' splits) would corrupt native undo, and native undo never covered
// structural changes anyway. The full document is a few dozen strings, so
// whole-state snapshots beat operation diffing on simplicity.

interface Snapshot {
  view: View2D;
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
    view: { ...view },
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
  Object.assign(view, { ratio: 1 }, s.view);
  appliedViewText = null;
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
    const rhs = fmtNum(Number(range.value));
    eq.text = `${lhs} = ${rhs}`;
    const line = lineEls()[equations.indexOf(eq)];
    if (line) line.textContent = eq.text;
    if (kind === 'const' && runtimeSliders.has(lhs) && !equations.some(row => row.error || row.needsFile)) {
      defs.drop(lhs);
      defs.bind(lhs, { tag: 'scalar', role: 'const', expr: { kind: 'num', value: Number(rhs) } });
      eq.def = { kind: 'const', name: lhs, rhs };
      // Match a math edit's invalidation without discarding compiled plots,
      // their samplers, or GPU buffers.
      resetEditedTrails();
      invalidateDerivedState();
    } else recompileAll();
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
  if (eq.cpu?.type === 'system' && !eq.cpu!.parametric && !eq.cpu!.angular?.some(Boolean)) return {
    label: 'certify search box', title: 'Prove roots and completeness in the bounded search box; unsupported functions remain unresolved', on: !!eq.certify,
    flip: () => { eq.certify = !eq.certify; eq.info = eq.certify ? 'Certifying search box…' : undefined; eq.sysCache = undefined; eq.traceTarget = undefined; traceQueue.cancelPending(eq.id); },
  };
  if (eq.cpu?.type === 'vfield3d') return {
    label: 'arrows', title: 'Show a lattice of direction arrows', on: !!eq.showArrows,
    flip: () => { eq.showArrows = !eq.showArrows; eq.sysCache = undefined; eq.traceTarget = undefined; traceQueue.cancelPending(eq.id); },
  };
  switch (eq.cpu?.type) {
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
      return eq.cpu!.values.length > CLOUD_MIN ? null : {
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
    // No colour swatch for rows with nothing drawn in it: definitions, and
    // value rows, whose whole output is the readout beneath them — except a
    // definite integral shading its area, which draws in that colour.
    const drawn = eq.error ? undefined : eq.cpu;
    line.classList.toggle('is-def', !!eq.def || (drawn?.type === 'value' && !drawn.shade) || drawn?.type === 'note');
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
      // Σ/Π bounds are integers, so their sliders step whole terms at a time;
      // likewise the n of Binomial(n, p), which no fraction is valid for.
      range.step = sumBoundNames.has(sliderDef.name) || wholeParamNames.has(sliderDef.name) ? '1' : String((eq.sliderMax - eq.sliderMin) / 400);
      range.value = String(v);
      wanted.push(eq.sliderUI.box);
    }
    // `f(x,y) = c` rows can draw the whole contour stack of f, not just the
    // slider's level. The control sits above the readout that may follow it.
    if (eq.cpu?.type === 'implicit2d' && eq.cpu!.levels) {
      eq.levelsBtn ??= makeLevelsBtn(eq);
      setLevelsBtnState(eq.levelsBtn, !!eq.showLevels);
      wanted.push(eq.levelsBtn);
    }
    const plot = eq.cpu;
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
 * Map a DOM position to (line, character offset). Handles container-level
 * boundaries (select-all) and positions inside widgets or stray nodes, which
 * attach to the nearest line above.
 */
function posOf(node: Node, off: number): { line: number; offset: number } {
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
}

/** The selection's endpoints in document order, or null when it lies outside the editor. */
function selectionSpan(): { start: { line: number; offset: number }; end: { line: number; offset: number } } | null {
  const sel = getSelection();
  if (!sel?.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!listEl.contains(range.commonAncestorContainer)) return null;
  const a = posOf(range.startContainer, range.startOffset);
  const b = posOf(range.endContainer, range.endOffset);
  return a.line < b.line || (a.line === b.line && a.offset <= b.offset)
    ? { start: a, end: b }
    : { start: b, end: a };
}

/**
 * The rows a line-level command acts on, as [first, last] indices. A
 * multi-line selection ending at the start of a line doesn't include that
 * line — the convention code editors use for line commands.
 */
function selectedRows(span: NonNullable<ReturnType<typeof selectionSpan>>): [number, number] {
  const first = span.start.line;
  let last = span.end.line;
  if (last > first && span.end.offset === 0) last--;
  return [first, Math.min(last, equations.length - 1)];
}

/**
 * Replace the current selection with pasted/typed multi-statement text,
 * entirely in state space. Statements separate on newlines or ';' (the same
 * separator the examples menu and the URL hash use, so pasted lists and
 * copied blocks both just work).
 */
function insertStatements(text: string) {
  const span = selectionSpan();
  if (!span) return;
  pushUndo(null);
  const { start, end } = span;

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

// --- line-level keyboard commands (the code-editor vocabulary) ---

/**
 * Cmd+/: toggle `# ` comments on the selected rows. Uncomments only when
 * every selected non-blank row is already a comment; otherwise comments the
 * rows that aren't yet. Blank rows stay untouched unless one is alone —
 * commenting it starts a group heading.
 */
function toggleComment() {
  const span = selectionSpan();
  if (!span) return;
  const [first, last] = selectedRows(span);
  const rows = equations.slice(first, last + 1);
  const active = rows.filter(eq => eq.text.trim() || rows.length === 1);
  if (!active.length) return;
  const uncomment = active.every(eq => eq.text.trimStart().startsWith('#'));
  pushUndo(null);
  const deltas = new Map<Equation, number>();
  for (const eq of active) {
    if (uncomment) {
      const h = eq.text.indexOf('#');
      const n = eq.text[h + 1] === ' ' ? 2 : 1;
      eq.text = eq.text.slice(0, h) + eq.text.slice(h + n);
      deltas.set(eq, -n);
    } else if (!eq.text.trimStart().startsWith('#')) {
      eq.text = '# ' + eq.text;
      deltas.set(eq, 2);
    }
  }
  recompileAll();
  renderAll();
  // Uncommenting a heading can drop its rows into a previous collapsed group.
  for (let i = first; i <= last; i++) expandAt(i);
  const shift = (p: { line: number; offset: number }) => ({
    line: p.line,
    offset: Math.max(0, p.offset + (deltas.get(equations[p.line]) ?? 0)),
  });
  setSelectionSpan(shift(span.start), shift(span.end));
  saveUrl();
  requestRender();
}

/**
 * Alt+Up/Down: move the selected rows one step. Collapsed groups the swap
 * would touch are expanded first, so a move never drags rows invisibly and
 * never strands the caret in a hidden row.
 */
function moveLines(dir: -1 | 1) {
  const span = selectionSpan();
  if (!span) return;
  const [first, last] = selectedRows(span);
  if (dir < 0 ? first === 0 : last >= equations.length - 1) return;
  // One undo entry per held-key run, keyed to the block being moved.
  pushUndo(`move:${equations[first].id}`);
  for (let i = Math.max(0, first - 1); i <= Math.min(last + 1, equations.length - 1); i++) {
    for (let j = i; j >= 0; j--) {
      const eq = equations[j];
      if (!eq.comment) continue;
      eq.collapsed = undefined;
      break;
    }
  }
  const [swapped] = equations.splice(dir < 0 ? first - 1 : last + 1, 1);
  equations.splice(dir < 0 ? last : first, 0, swapped);
  recompileAll();
  renderAll();
  const move = (p: { line: number; offset: number }) =>
    p.line + dir >= equations.length
      ? { line: equations.length - 1, offset: equations[equations.length - 1].text.length }
      : { line: Math.max(0, p.line + dir), offset: p.offset };
  setSelectionSpan(move(span.start), move(span.end));
  saveUrl();
  requestRender();
}

/**
 * Shift+Alt+Up/Down: duplicate the selected rows, the selection following
 * the copy in the pressed direction (upper block for Up, lower for Down).
 * Copies keep slider bounds but take fresh colors, like any new row.
 */
function duplicateLines(dir: -1 | 1) {
  const span = selectionSpan();
  if (!span) return;
  const [first, last] = selectedRows(span);
  if (last < first) return;
  pushUndo(null);
  const copies = equations.slice(first, last + 1).map(eq => ({
    id: nextId++,
    text: eq.text,
    colorIndex: (nextId - 2) % theme.palette.length,
    sliderMin: eq.sliderMin,
    sliderMax: eq.sliderMax,
    showLevels: eq.showLevels,
  }));
  equations.splice(last + 1, 0, ...copies);
  recompileAll();
  renderAll();
  const count = dir > 0 ? copies.length : 0;
  for (let i = first + count; i <= last + count; i++) expandAt(i);
  setSelectionSpan(
    { line: span.start.line + count, offset: span.start.offset },
    { line: span.end.line + count, offset: span.end.offset },
  );
  saveUrl();
  requestRender();
}

/** Cmd+Shift+K: delete the selected rows outright, keeping the caret column. */
function deleteLines() {
  const span = selectionSpan();
  if (!span) return;
  const [first, last] = selectedRows(span);
  if (last < first) return;
  pushUndo(null);
  equations.splice(first, last - first + 1);
  if (!equations.length) addEquation('');
  recompileAll();
  renderAll();
  const line = Math.min(first, equations.length - 1);
  expandAt(line);
  setCaret(line, span.start.offset);
  saveUrl();
  requestRender();
}

/** Cmd+Enter / Cmd+Shift+Enter: start a fresh row below/above the caret's,
 *  wherever the caret sits in the line. */
function insertLine(below: boolean) {
  const span = selectionSpan();
  if (!span) return;
  const [first, last] = selectedRows(span);
  pushUndo(null);
  const at = below ? last + 1 : first;
  addEquation('', at);
  recompileAll();
  renderAll();
  expandAt(at);
  setCaret(at, 0);
  saveUrl();
  requestRender();
}

/** Cmd+Alt+[ / ]: collapse or expand the `#` group holding the caret — the
 *  keyboard for the gutter chevron. View state only (like the chevron): no
 *  undo entry, and the URL doesn't carry it. */
function foldGroup(collapse: boolean) {
  const pos = caretPos();
  if (!pos) return;
  for (let i = Math.min(pos.line, equations.length - 1); i >= 0; i--) {
    const eq = equations[i];
    if (!eq.comment) continue;
    eq.collapsed = collapse || undefined;
    reconcile();
    // Folding hides the caret's row: park the caret on the heading instead.
    if (collapse && i !== pos.line) setCaret(i, equations[i].text.length);
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
  // LaTeX-style escapes: the keystroke that completes \pi (or delimits \sin)
  // rewrites it to the symbol in place — same effect as accepting it from
  // the suggestions, but hands-free (lib/escapes.ts says when).
  if (e instanceof InputEvent && !e.isComposing && e.inputType === 'insertText' && e.data?.length === 1) {
    const caret = caretPos();
    const eq = caret && equations[caret.line];
    const edit = caret && eq ? typedEscape(eq.text, caret.offset, e.data) : null;
    if (edit && eq && caret) {
      eq.text = eq.text.slice(0, edit.start) + edit.text + eq.text.slice(edit.end);
      recompileAll();
      renderAll();
      setCaret(caret.line, edit.caret);
    }
  }
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
// Alongside them, the code-editor vocabulary: Cmd+/ toggles comments,
// Alt+arrows move rows (with Shift: duplicate), Cmd+Shift+K deletes rows,
// Cmd+(Shift+)Enter opens a row below/above, Cmd+Alt+brackets fold groups.
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
  // Shift stays unchecked: layouts like German type `/` as Shift+7.
  if (mod && !e.altKey && e.key === '/') {
    e.preventDefault();
    toggleComment();
    return;
  }
  if (mod && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    deleteLines();
    return;
  }
  // Physical bracket keys by e.code (with Alt held, e.key is layout soup on
  // macOS), plus e.key for layouts that type brackets via a modifier and for
  // synthetic events that omit the code.
  if (mod && e.altKey && (e.code === 'BracketLeft' || e.code === 'BracketRight' || e.key === '[' || e.key === ']')) {
    e.preventDefault();
    foldGroup(e.code === 'BracketLeft' || e.key === '[');
    return;
  }
  if (!mod && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    const dir = e.key === 'ArrowUp' ? -1 : 1;
    if (e.shiftKey) duplicateLines(dir);
    else moveLines(dir);
    return;
  }
  if (e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault();
  if (mod) insertLine(!e.shiftKey);
  else insertStatements('\n');
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
    ['moire', 'sin(x^2 + y^2) = cos(x y)'],
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
  ['regression', [
    ['line fit and residuals', 'X = [0,1,2,3,4]; Y = [1.1,2.9,5.2,6.8,9.1]; Y ~ m X + b; (X,Y); y = m x + b; # residuals; (X,Y-(m X+b))'],
    ['quadratic fit', 'X = [-2,-1,0,1,2]; Y = [9,2,1,6,17]; Y ~ a X^2 + b X + c; (X,Y); y = a x^2 + b x + c'],
    ['exponential fit', 'X = [0,0.5,1,1.5,2]; Y = [2,2.84,4.03,5.72,8.11]; Y ~ a exp(b X); (X,Y); y = a exp(b x)'],
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
    ['RGB color field', 'rgb(127.5(1+sin(x-t)), 127.5(1+sin(y-t)), 127.5(1+sin(x+y+t)))'],
    ['HSL color wheel', 'hsl(arg(w)+t/3, 100, 50)'],
    ['OKLCH color wheel', 'oklch(0.72, 0.16, arg(w)+t/3)'],
    ['conformal map', 'conformal(w^2/4)'],
    ['joukowski airfoil', 'conformal(w + 1/w)'],
    ['unit circle path', 'exp(i 2 pi u)'],
    ['image of a circle', 'f(w) = w^2 + w; exp(i 2 pi u); f(exp(i 2 pi u))'],
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
    ['spherical chart', 'rho = sqrt(x^2 + y^2 + z^2); theta = atan2(y, x); phi = acos(z/rho); '
      + 'rho = 2; (rho, theta, phi) = (2, pi/4, pi/3)'],
    ['spherical flower', 'rho = sqrt(x^2 + y^2 + z^2); theta = atan2(y, x); phi = acos(z/rho); rho = 2 + cos(3 theta) sin(phi)^2'],
    ['spherical spiral', 'rho = sqrt(x^2 + y^2 + z^2); theta = atan2(y, x); phi = acos(z/rho); '
      + 'rho = 2; (rho, theta, phi) = (2, 12 pi u, pi u)'],
    ['cylindrical chart', 'r = sqrt(x^2 + y^2); theta = atan2(y, x); r = 1.5 + sin(2 z)/2; (r, theta, z) = (2.5, 6 pi u, 6 u - 3)'],
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
    ['gamma waiting times', 'view(x = -1..9, y = -0.1..0.9, ratio = 6); a = 2; b = 1; X ~ Gamma(a, b); Y ~ Exponential(b); '
      + 'P(X > 4); S = X + Y'],
    ['beta shapes', 'view(x = -0.2..1.2, y = -0.3..3.5, ratio = 0.25); a = 0.5; b = 0.5; X ~ Beta(a, b); P(X < 0.2)'],
    ['chi-squared from normals', 'view(x = -1..7, y = -0.1..1.1, ratio = 4); Z ~ Normal(0, 1); Q = Z^2; C ~ ChiSquared(3); '
      + 'P(Q > 3.84)'],
    ['heavy tails: t and Cauchy', 'view(x = -6..6, y = -0.05..0.45, ratio = 15); k = 2; Z ~ Normal(0, 1); X ~ T(k); '
      + 'C ~ Cauchy(0, 1); P(X > 2); E(C)'],
    ['binomial stems', 'view(x = -1.5..21.5, y = -0.02..0.24, ratio = 50); n = 20; p = 0.3; X ~ Binomial(n, p); '
      + 'P(X <= 4); E(X)'],
    ['Poisson: < versus <=', 'view(x = -1.5..13.5, y = -0.02..0.28, ratio = 30); m = 4; X ~ Poisson(m); '
      + 'P(X < 3); P(X <= 3); P(X = 3)'],
    ['waiting for a success', 'view(x = -1.5..21.5, y = -0.02..0.3, ratio = 40); p = 0.25; G ~ Geometric(p); '
      + 'W ~ NegativeBinomial(3, p); P(G > 4)'],
    ['a fair die', 'view(x = -0.5..7.5, y = -0.02..0.3, ratio = 16); D ~ DiscreteUniform(1, 6); P(2 < D <= 5); E(D)'],
    ['two dice', 'view(x = 0.5..13.5, y = -0.02..0.22, ratio = 40); X ~ DiscreteUniform(1, 6); Y ~ DiscreteUniform(1, 6); '
      + 'S = X + Y; P(S >= 10); P(X > Y); P(X >= Y); E(S)'],
    ['a die, halved and squared', 'view(x = -1..38, y = -0.02..0.22, ratio = 120); D ~ DiscreteUniform(1, 6); D / 2; D^2; '
      + 'P(D^2 <= 9); E(D^2)'],
    ['Poisson counts add', 'view(x = -1.5..16.5, y = -0.02..0.3, ratio = 40); a = 2; b = 3; A ~ Poisson(a); B ~ Poisson(b); '
      + 'S = A + B; P(S <= 4); P(A = B)'],
    ['a count plus noise', 'view(x = -2..10, y = -0.03..0.33, ratio = 25); s = 0.25; N ~ Poisson(3); Z ~ Normal(0, s); Y = N + Z; '
      + 'P(Y < 2.5)'],
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
    ['domain restriction', 'y = {-2 < x < 2: x^2}'],
    ['coprime cells', '1 / gcd(floor(x), floor(y))'],
  ]],
  ['sliders + calculus', [
    ['slider', 'a = 2; y = sin(a x)/a'],
    ['level sets', 'c = 0.3; sin(x)cos(y) = c'],
    ['function', 'f(x) = x^3 - 3x; y = f(x)'],
    ['derivative', 'y = d/dx (x^3 - 3x)'],
    ['tangent line', 'f(x) = x^3 - 2x; g(x) = d/dx f(x); a = 1; y = f(x); y = f(a) + g(a)(x - a)'],
    ['running integral', 'view(x = -7..7, y = -1.5..4); f(x) = sin(x)^2; y = f(x); y = int[0..x] f(t) dt'],
    ['signed area', 'view(x = -1..7, y = -1.5..1.5); b = 5; y = sin(x); int[0..b] sin(x) dx'],
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
    ['triangle: a side and its angles', 'A = (-2, -1); B = (3, -0.5); C = (0.5, 2.5); polygon(A, B, C); distance(A, B); angle(B, A, C) 180/pi; angle(B, A, C) + angle(C, B, A) + angle(A, C, B)'],
    ['vector sum (parallelogram rule)', 'A = (3, 1); B = (1, 2); vector(A); vector(B); vector(A + B); polyline(A, A + B, B)'],
    ['thébault’s theorem', 'A = (0, 0); B = (4, 0.5); D = (1, 2.5); C = B + D - A; '
      + 'polygon(A, B, C, D); square(B, A); square(C, B); square(D, C); square(A, D); '
      + 'P = midpoint(A, B) - perp(B - A)/2; Q = midpoint(B, C) - perp(C - B)/2; '
      + 'R = midpoint(C, D) - perp(D - C)/2; S = midpoint(D, A) - perp(A - D)/2; '
      + 'polygon(P, Q, R, S)'],
  ]],
  ['coordinates', [
    ['polar point (drag it)', 'r = sqrt(x^2+y^2); theta = atan2(y,x); (r, theta) = (2, 0.8)'],
    ['polar spiral', 'r = sqrt(x^2+y^2); theta = atan2(y,x); (r, theta) = (3u, 6pi u)'],
    ['polar limit cycle', "r = sqrt(x^2+y^2); theta = atan2(y,x); (r', theta') = (r(1-r), 1)"],
    ['hyperbolic pair', 'p = x y; q = (x^2-y^2)/2; (p, q) = (1, 0)'],
    ['complex roots', 'w^3 = 1; 1+2i'],
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
  ['space, families and sequence values', [
    ['3D triangle and normal', 'A=(0,0,0); B=(3,0,1); C=(0,2,2); polygon(A,B,C); vector(A,cross(B-A,C-A)/3); angle(B-A,C-A)'],
    ['Lorenz field', "camera(-pi/3,0.5,55,(0,0,25)); (x',y',z')=(10(y-x),x(28-z)-y,x y-8z/3)"],
    ['cylindrical flow', "r=sqrt(x^2+y^2); theta=atan2(y,x); (r',theta',z')=(0,1,0.5)"],
    ['family of lines', 'y=[-2,-1,0,1,2]x'],
    ['concentric circles', 'circle((0,0),[1,2,3,4])'],
    ['point-list path', 'P=[(-2,0),(0,2),(2,0),(0,-2)]; Q=P+(1,0); polygon(P); polyline(Q)'],
    ['sequence statistics', 'a_n=1/n; L=a_[1..20]; L; mean(L); hist(L)'],
    ['surface intersection', '(x^2+y^2+z^2,z)=(9,1)'],
    ['certifiable roots', '(x^2,y)=(1,0)'],
    ['decided comparisons', '2+2=4; e=2'],
  ]],
  ['rotations, hulls and solids', [
    // A list is a variable: every use of `th` moves together, while separate
    // [..] literals are independent and cross — the corners of a cube.
    ['regular polygon', 'n = 7; th = 2pi [0..n-1]/n; polygon(rotate((2, 0), th + t/4))'],
    ['rotate a shape (matrix exponential)', 'J = [(0, -1), (1, 0)]; a = 0.7; R = e^(a J); P = [(0, 0), (3, 0), (3, 1), (1, 1), (1, 2), (0, 2)]; polygon(P); polygon(R P)'],
    ['rosette of hulls', 'th = 2pi [0..5]/6; P = [(1, 0), (3, 0.6), (3, -0.6)]; rotate(hull(P), th + t/3)'],
    ['convex hull of moving points', 'P = [(-3, -1), (-1, 2), (0.5, -2), (2, 1.5), (3, -0.5), (0, 0.3), (1, 0.5 + 2sin(t))]; hull(P); P'],
    ['exact linear flow: e^(tA)', "A = [(-0.2, -1), (1, -0.2)]; s = [0..60]/5; (x', y') = A (x, y); e^(s A) (3, 0); e^(t A) (3, 0)"],
    ['deform a lattice (arrows)', 'a = [-10..10]/2; b = [-10..10]/2; P = (a, b); f(x,y) = (x + sin(y + t)/3, y + sin(x)/3); vector(P, f(P)); f(P)'],
    ['corners of a cube', '([0,1], [0,1], [0,1])'],
    ['tumbling cube', 'e^(t cross((1, 1, 1)/sqrt(3))) hull(([-1,1], [-1,1], [-1,1]))'],
    ['octahedron', 'k = 2pi [0..2]/3; hull(rotate(([-2,2], 0, 0), k, (1, 1, 1)))'],
    ['icosahedron', 'phi = (1+sqrt(5))/2; k = 2pi [0..2]/3; hull(rotate((0, [-1,1], [-phi,phi]), k, (1, 1, 1)))'],
    ['prism (slide n)', 'n = 5; th = 2pi [0..n-1]/n; hull(rotate((2, 0, [-1,1]), th, (0, 0, 1)))'],
  ]],
  ['3d surfaces', [
    ['waves', 'z = sin(x)cos(y)'],
    ['sphere', 'x^2 + y^2 + z^2 = 9'],
    ['saddle', 'z = (x^2 - y^2)/4'],
    ['gyroid', 'sin(x)cos(y) + sin(y)cos(z) + sin(z)cos(x) = 0'],
    ['vase (revolve)', 'a = 1; revolve({-3 < y < 3: 1.5 + a sin(y) / 2}, y)'],
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

/** Rows shown when the URL names no graph. Rotates on each empty visit. */
let emptyDefault = ['y = sin(x)'];

function replaceDocument(rows: string[], share: boolean) {
  pushUndo(null);
  resetViewport();
  equations.length = 0;
  for (const t of rows) if (t.trim()) addEquation(t.trim());
  if (!equations.length) addEquation('');
  recompileAll();
  renderAll();
  // A whole-document replace is one navigation, not a slider drag: write the
  // URL now. saveUrl() would wait out the coalescing window when the page
  // itself is still under a second old (urlLastWrite starts at 0).
  if (share) {
    urlPending = true;
    flushUrl();
  }
  requestRender();
}

function openExample(text: string) {
  // An example is a fresh start: it replaces the whole document (undo brings
  // the old one back). Multi-row examples separate rows with ';' (the same
  // separator as the hash).
  replaceDocument(splitStatements(text).map(s => s.trim()).filter(Boolean), true);
}

function buildExamplesMenu() {
  const list = document.getElementById('examples-list');
  if (!list) return;
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
function snapToPixel(v: number, axis = 0): number {
  const upp = view.upp / (axis === 1 ? (view.ratio ?? 1) : 1);
  const step = Math.pow(10, Math.floor(Math.log10(upp * 3)));
  return Math.round(v / step) * step;
}

/**
 * How a dragged position writes back to a pair like `(2, a)`, or null if
 * nothing about it can move. Axes are independent: a literal is rewritten in
 * place while a slider name moves through its own row. `commit` receives the
 * rewritten pair text.
 */
function makePairWriter(pairText: string, commit: (pair: string) => void, round = snapToPixel, pinned?: ReadonlySet<string>): ((x: number, y: number) => void) | null {
  // A name moves only if it is a slider constant: a plain number in its own
  // row is the only right-hand side a drag knows how to rewrite.
  const drag = dragAxes(pairText, p => equations.find(r =>
    r.def?.kind === 'const' && r.def.name === p && !r.error && NUM_RE.test(r.def.rhs)), pinned);
  if (!drag) return null;
  const { parts, axes } = drag;
  return (x, y) => {
    const coords = [x, y];
    const text = [...parts];
    axes.forEach((axis, k) => {
      if (!axis) return;
      const value = fmtNum(round(coords[k], k));
      if (axis === 'literal') text[k] = value;
      else axis.text = `${axis.def!.name} = ${value}`;
    });
    commit(`(${text[0]}, ${text[1]})`);
  };
}

const pointWriter = (eq: Equation) => makePairWriter(eq.text, p => { eq.text = p; });

/** Evaluate the named coordinates at the pointer before writing the RHS. */
function coordinatePointWriter(eq: Equation, coords: Expr[] | undefined) {
  if (!coords) return null;
  const at = eq.text.indexOf('=');
  if (at < 0) return null;
  const lhs = eq.text.slice(0, at).trim();
  // Writing a slider that defines either chart coordinate changes the map
  // itself, so ordinary coordinate writeback cannot move that axis reliably.
  const pinned = definitionDependencies(coords.flatMap(c => [...freeVars(c)]), defs);
  const write = makePairWriter(eq.text.slice(at + 1), p => { eq.text = `${lhs} = ${p}`; }, v => v, pinned);
  if (!write) return null;
  return coordinateDragWriter(coords, () => {
    const time = graphTime();
    return { ...currentConstEnv(time), t: time };
  }, write, snapToPixel);
}

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
  return [view.cx + px * view.upp, view.cy + py * view.upp / (view.ratio ?? 1)];
}

/** The nearest grabbable point within GRAB_PX of a client position. */
function pointAt(clientX: number, clientY: number): Grabbable | null {
  if (mode !== '2d' || !grabbable.length) return null;
  const [mx, my] = toMath(clientX, clientY);
  const dpr = window.devicePixelRatio || 1;
  let best: Grabbable | null = null;
  let bestDist = GRAB_PX * dpr * view.upp;
  for (const p of grabbable) {
    const d = Math.hypot(p.x - mx, (p.y - my) * (view.ratio ?? 1));
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
    toSy: (y: number) => rect.height / 2 - (y - view.cy) * (view.ratio ?? 1) / uppCss,
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
  if (spSlot !== null || rendererDisposed) return;
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
    halfH: ((canvas.clientHeight * dpr) / 2) * (view.upp / (view.ratio ?? 1)),
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
  if (!cls || eq.error || !eq.cpu || eq.cpu.type !== 'implicit2d' || cls.animated) return;
  const { halfW, halfH } = hoverHalfSpan();
  let expr = eq.cpu.equation;
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
  if (!cls || eq.error || !eq.cpu || eq.cpu.type !== 'implicit2d' || cls.animated) return [];
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
let scaling = false;
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
    const my = view.cy + py * (view.upp / (view.ratio ?? 1));
    view.upp = Math.max(1e-12, view.upp * factor);
    view.cx = mx - px * view.upp;
    view.cy = my - py * (view.upp / (view.ratio ?? 1));
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
    scaling = mode === '2d' && e.button === 0 && e.altKey;
    const hit = e.button === 0 && !e.shiftKey && !scaling ? pointAt(e.clientX, e.clientY) : null;
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
    scaling = false;
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
      view.cy += dy * dpr * (view.upp / (view.ratio ?? 1));
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
  if (mode === '2d' && scaling) {
    if (!dragMoved) return;
    ensureViewRow();
    const rect = canvas.getBoundingClientRect();
    const px = (downX - rect.left - rect.width / 2) * dpr;
    const py = (rect.height / 2 - (downY - rect.top)) * dpr;
    const next = scaleViewAt(view, px, py, Math.exp(-dx * 0.01), Math.exp(dy * 0.01));
    Object.assign(view, next);
  } else if (mode === '2d') {
    view.cx -= dx * dpr * view.upp;
    view.cy += dy * dpr * (view.upp / (view.ratio ?? 1));
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
    flushUrl();
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
  if (scaling || e.altKey || dragMoved || pointers.size || mode !== '2d' || e.button !== 0 || e.shiftKey) return;
  if (!equations.some(q => !q.error && q.cpu?.type === 'vfield2d')) return;
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
const canvasSizeObserver = new ResizeObserver(resize);
canvasSizeObserver.observe(canvas);

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
if (framed) {
  document.getElementById('panel')!.classList.add('is-parked');
  document.getElementById('panel-chip')!.hidden = false;
  document.getElementById('panel-chip')!.classList.add('shown');
  document.documentElement.removeAttribute('data-embed-boot');
}
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
  const path = location.pathname;
  if (path.startsWith('/g/')) return path.slice('/g/'.length);
  return '';
}

const initialPayload = urlPayload();
// decodePayload splits bracket-aware and decodes each row exactly once, so it
// reads both the /g/ form and legacy /#… links.
const initialRows = decodePayload(initialPayload);
if (initialRows.length) initialRows.forEach(t => addEquation(t));
else if (!embedded) {
  try { emptyDefault = nextFeatured(localStorage).eqs; }
  catch { emptyDefault = nextFeatured(null).eqs; }
  emptyDefault.forEach(t => addEquation(t));
}
recompileAll();
// Canonicalize what we loaded (re-encoded /g/ form; stray paths back to /).
// A fresh visit stays at / — the featured graph only enters the URL once
// edited, or when the visitor clicks random / an example.
if (initialPayload) saveUrl();
else if (!embedded && location.pathname !== '/') history.replaceState(null, '', '/');

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
  const wanted = rows.length ? rows : emptyDefault;
  const current = equations.map(e => e.text);
  if (wanted.length === current.length && wanted.every((t, i) => t === current[i])) return;
  resetViewport();
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

if (!embedded) {
  document.getElementById('try-another')?.addEventListener('click', () => {
    const store = typeof localStorage === 'undefined' ? null : localStorage;
    emptyDefault = nextFeatured(store, equations.map(e => e.text)).eqs;
    replaceDocument(emptyDefault, true);
  });

  const shotBtn = document.getElementById('shot') as HTMLButtonElement | null;
  const recBtn = document.getElementById('rec') as HTMLButtonElement | null;
  capture = attachCapture({
    gl: canvas,
    overlay,
    render,
    requestRender,
    notice: showNotice,
    onRecording(on) {
      recBtn?.classList.toggle('recording', on);
      recBtn?.setAttribute('aria-pressed', on ? 'true' : 'false');
      recBtn?.setAttribute('title', on
        ? 'Stop recording'
        : 'Record the graph as video (up to 8 seconds)');
    },
  });
  shotBtn?.addEventListener('click', e => { void capture?.snapshot(e.shiftKey); });
  if (!capture.mime && recBtn) recBtn.hidden = true;
  else recBtn?.addEventListener('click', () => {
    if (capture?.isRecording()) capture.stopRecording();
    else capture?.startRecording();
  });
}

if (mcpApp) {
  void import('./mcp-app.ts').then(({ connectGraphApp }) => connectGraphApp({
    getRows: () => equations.map(e => e.text),
    setRows: rows => {
      // A new tool result replaces the document, including its undo history.
      // Pending gestures belong to the old document, not the incoming rows.
      resetViewport();
      restartGraphClock();
      if (urlTimer !== null) clearTimeout(urlTimer);
      urlTimer = null;
      urlPending = false;
      undoStack.length = redoStack.length = 0;
      equations.length = 0;
      rows.forEach(t => addEquation(t));
      recompileAll();
      resetState();
      renderAll();
      requestRender();
    },
    onChange: cb => { graphChanged = cb; },
    onEdit: cb => { graphEdited = cb; },
    setVisible: setGraphVisible,
    flush: flushViewportWriteback,
    dispose: () => {
      if (rendererDisposed) return;
      rendererDisposed = true;
      r3d.clearGeometry();
      canvasSizeObserver.disconnect();
      window.removeEventListener('resize', resize);
      cancelRender();
      graphChanged = undefined;
      graphEdited = undefined;
      if (urlTimer !== null) clearTimeout(urlTimer);
      if (viewportWriteTimer !== null) clearTimeout(viewportWriteTimer);
      if (noticeTimer !== null) clearTimeout(noticeTimer);
      urlTimer = viewportWriteTimer = noticeTimer = null;
      urlPending = false;
      spGen++;
      spQueue.clear();
      if (spSlot !== null) {
        if (typeof cancelIdleCallback === 'function') cancelIdleCallback(spSlot);
        else clearTimeout(spSlot);
        spSlot = null;
      }
      traceQueue.clear();
      if (traceWorker) {
        traceWorker.onmessage = traceWorker.onerror = traceWorker.onmessageerror = null;
        traceWorker.terminate();
        traceWorker = undefined;
      }
      // Release cached GPU programs/buffers together; this renderer will
      // never be resumed after the host has requested teardown.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  })).catch(() => {
    document.getElementById('app-status')!.textContent = 'Could not connect the graph. Try again.';
  });
}

// Dev-only handle for driving/inspecting the view in automated tests.
if (import.meta.env.DEV) (window as any).__eq = { view, camera, equations, requestRender, flushViewportWriteback, capture };

// Completion is an ordinary text edit, with the same undo and URL path as typing.
initSyntaxHelp(listEl, {
  context: () => {
    const caret = caretPos();
    const eq = caret && equations[caret.line];
    return caret && eq ? { caret, text: eq.text, defs, declared: declaredNames(equations.map(e => e.text)) } : null;
  },
  replace: (caret, start, end, text, offset) => {
    const eq = equations[caret.line];
    if (!eq) return;
    pushUndo(null, caret);
    eq.text = eq.text.slice(0, start) + text + eq.text.slice(end);
    recompileAll();
    renderAll();
    listEl.focus();
    setCaret(caret.line, offset);
    saveUrl();
    requestRender();
  },
});
