/**
 * One frame of the graph: viewport rows, and the scene render() hands to the
 * 2D and 3D renderers.
 */
import { app } from './app-state.ts';
import {
  type Equation,
  panels,
  panelOf,
  type Panel,
  equations,
  linkRoots,
  syncLinks,
  defaultCamera,
  panelW,
  panelH,
  requestRender,
  syncCanvasSize,
  graphTime,
  currentConstEnv,
  rvSys,
  gl,
  overlayCtx,
  overlay,
  ODE_STEPS,
  usePanel,
  canvas,
  type Grabbable,
  r2d,
  r3d,
  type SurfaceDot,
  edgeShade,
  TUBE_SEGMENTS,
  COMB_STEP,
  cssColor,
  cssColorA,
  CLOUD_MIN,
  columnStacks,
  CLOUD_DOT_PX,
  POINT_DOT_PX,
  pushStems,
} from './session.ts';
import {
  pointers,
  pushUndo,
  addEquation,
  recompileAll,
  renderAll,
  saveUrl,
  lineEls,
  setLineText,
  reconcile,
  followSurfaceHover,
  defPointWriter,
  surfaceReads,
  drawHoverMarker,
  dragToPlane,
  dragTo,
  pointWriter,
  coordinatePointWriter,
} from './main.ts';
import {
  type CellGrid,
  cellShades,
  runBoard,
  BOARD_STEPS,
  runAutomaton,
  TABLE_MAX,
  evalTable,
  tableShades,
} from '../lib/automaton.ts';
import { type GraphData, edgeText, edgeEvaluator, collectEdges, layoutGraph } from '../lib/graph.ts';
import {
  parametricGLSL,
  type CpuPlan,
  cpuStructureKey,
  compileGridCpu,
  compileGridGpu,
  type CpuGrid,
} from '../lib/compiler.ts';
import { withNote } from '../lib/analysis.ts';
import { complexRootLabel } from '../lib/complex-label.ts';
import { PointTrail } from '../lib/point-trail.ts';
import { curveFrames, buildTube, curveExtent, buildComb, combScale } from '../lib/curve3d.ts';
import { type DensityCurve, scaleCurve, scaleStems, shadePolygon, markerHeight } from '../lib/dist.ts';
import { shadeNames, evalSampler, shadeRuns, minusTint, runPaths } from '../lib/intshade.ts';
import { compileSampler } from '../lib/vm.ts';
import { fieldScale } from '../lib/volume.ts';
import { type Expr, substVars, freeVars, evaluate, writtenName } from '../lib/expr.ts';
import { shaderBindings, gpuFor } from './render-plan.ts';
import { fieldEvaluator, streamline, traceField } from '../lib/flow.ts';
import { pointComps } from '../lib/geom.ts';
import { hullFaces } from '../lib/hull.ts';
import { hullGeometrySampler } from '../lib/hull-geometry.ts';
import { type VertexSampler, vertexSampler, fanFillable } from '../lib/figure-vertices.ts';
import { type GridField, sampleGradMag, angularSpacing } from '../lib/grid.ts';
import { regionSampler, pathSampler, foldAllExcept, CURVE_SAMPLES } from '../lib/path.ts';
import { type Classified, plotReadout } from '../lib/plot.ts';
import { solveSystem } from '../lib/solve.ts';
import { traceEnvironment, TraceQueue, type TraceMessage, type TraceResult } from '../lib/trace-queue.ts';
import { type OrbitInput, orbitInput } from '../lib/orbit.ts';
import { keepNote, stripNote, noteColor } from '../lib/statements.ts';
import {
  type ViewSpec,
  linkedWindow,
  orientLattice,
  fitPanelWindow,
  clampPhi,
  formatViewSpec,
  type View2DSpec,
  formatCameraRow,
  parseViewRow,
} from '../lib/view.ts';
import { axisMapping, type AxisMaps, shownRange, toScreen, toScreenOrEdge } from '../lib/axis-map.ts';
import { type PlaneMap, planeIn, planeWorldBox, type ScreenBox, planeInverse } from '../lib/plane-map.ts';
import EmbeddedTraceWorker from './trace-worker.ts?worker&inline';
import type { Frame } from './gl.ts';
import {
  type Overlay2D,
  type Cells2D,
  type OverlayBox,
  type Layers2D,
  type LatticeLabels,
  LATTICE_VALUE_PX,
  niceSpacing,
  markOverlay,
  mapOverlay,
  GRAPH_NODE_PX,
  type GridSpec,
  drawLabels2D,
} from './render2d.ts';
import { type SurfacePaint, type Scene3D, type Camera3D, cameraEye, cameraBoxR, drawLabels3D } from './render3d.ts';
import {
  type SurfaceMap,
  surfaceInUV,
  surfacePoint,
  surfaceOver,
  surfaceArrows,
  surfaceMapping,
} from '../lib/surface-map.ts';
import { toGLSL, uniformName } from '../lib/glsl.ts';
import {
  geodesicPlanKey,
  GEODESIC_MAX_STEPS,
  GEODESIC_MAX_POINTS,
  numericIn,
  defaultGeodesicLength,
  divergingGain,
  type GeodesicOptions,
} from '../lib/surface-geometry.ts';
import { theme } from './theme.ts';

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

// A camera row's `spin = …`: the live camera turns about the vertical axis at
// its rate (radians per second) while the row keeps its starting angle, so a
// spin never rewrites the URL.
let lastSpinAt: number | null = null;

/** Whether eq is a real system on a mapped panel, solved rewritten in its
 *  screen coordinates (lib/axis-map.ts); a complex one solves in x and y. */
export function solvedOnScreen(eq: Equation): boolean {
  const maps = panelMaps(panels[panelOf(eq)]);
  return !!eq.cls && !!maps && axisMapping(eq.cls.object, maps) === 'substitute';
}

/**
 * Whether eq's system is being certified. A real system on a mapped panel is
 * solved in screen coordinates, where a certificate would prove roots in
 * those, so it offers none, and a row certified before its panel was mapped
 * stops certifying for good rather than resuming unseen when the map goes.
 */
function certifying(eq: Equation): boolean {
  if (eq.certify && solvedOnScreen(eq)) {
    eq.certify = false;
    eq.info = undefined;
  }
  return !!eq.certify;
}

/** Each parsed view row's window, as applyViewportRows compares it. */
const viewKeys = new WeakMap<ViewSpec, string>();

/**
 * The window a view row frames its panel to. A panel reframes when this
 * changes, not its text: a slider the row reads (`x = 0..a`, or a map's
 * `x = b^X`, which moves the screen window for the same x) changes the
 * window without changing a character.
 */
function viewKey(eq: Equation): string | null {
  const spec = eq.viewSpec;
  if (spec?.kind !== 'view') return null;
  let key = viewKeys.get(spec);
  if (key === undefined) {
    key = JSON.stringify([spec.x, spec.y, spec.ratio ?? 1, spec.axes ?? null]);
    viewKeys.set(spec, key);
  }
  return key;
}

/** The surface panel p's 2D rows are drawn on (its on(…) row), if any. */
export function panelSurface(p: Panel): SurfaceMap | undefined {
  const spec = viewportRow('surface', p)?.viewSpec;
  return spec?.kind === 'surface' ? spec.surface : undefined;
}

/** A surface's mesh GLSL, and its x and y, in the mesh's u and v. */
const surfaceGLSLs = new WeakMap<
  SurfaceMap,
  {
    comps: [string, string, string];
    du?: [string, string, string];
    dv?: [string, string, string];
    xy: [string, string];
  }
>();
function surfaceGLSL(surface: SurfaceMap) {
  let out = surfaceGLSLs.get(surface);
  if (!out) {
    const { comps, uv } = surfaceInUV(surface);
    out = { ...parametricGLSL(comps), xy: [toGLSL(uv.x), toGLSL(uv.y)] };
    surfaceGLSLs.set(surface, out);
  }
  return out;
}

/** The bare surface's colour: between the page and its axes, so rows read
 *  on it in either theme. */
const surfaceShade = (): [number, number, number] =>
  theme.bg.map((b, k) => 0.65 * b + 0.35 * theme.axis[k]) as [number, number, number];

/** A 2D row as a surface paints it (web/render3d.ts paintFrag). */
function paintOf(eq: Equation): SurfacePaint['paint'] | null {
  switch (eq.gpu?.type) {
    case 'implicit2d':
      return { kind: 'curve', field: eq.gpu.field };
    case 'ineq2d':
      return { kind: 'region', field: eq.gpu.field, edges: eq.gpu.edges };
    case 'scalar2d':
      return { kind: 'scalar', field: eq.gpu.field };
  }
  return null;
}

/** Where a scene stood before a row added to it. */
function markScene(scene: Scene3D) {
  return {
    curves: scene.curves.length,
    points: scene.points.length,
    texts: scene.texts?.length ?? 0,
    segments: scene.segments.length,
  };
}

/** Steps a straight run in x and y is cut into on the surface, which bends it. */
const SURFACE_PIECES = 24;

/**
 * Carry what a 2D row added to the scene since `mark` — placed in the plane
 * z = 0 — onto the surface: each point to the surface point at its x and y,
 * each line cut into pieces first (a straight run in x and y is a curve on
 * the surface). Everything is lifted a hair toward the eye so the surface
 * does not hide what lies exactly on it.
 */
function carryOntoSurface(scene: Scene3D, mark: ReturnType<typeof markScene>, surface: SurfaceMap, cam: Camera3D) {
  const lifted = towardEye(cam);
  const onto = (x: number, y: number) => lifted(surfacePoint(surface, x, y));
  const line = (pts: ArrayLike<number>, pieces: number): Float32Array => {
    const out: number[] = [];
    for (let i = 0; i + 2 < pts.length; i += 3) {
      const [x0, y0] = [pts[i], pts[i + 1]];
      const next = i + 5 < pts.length;
      const steps = next && Number.isFinite(pts[i + 3]) ? pieces : 1;
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        const [x, y] = next && steps > 1 ? [x0 + (pts[i + 3] - x0) * t, y0 + (pts[i + 4] - y0) * t] : [x0, y0];
        const q = Number.isFinite(x) && Number.isFinite(y) ? onto(x, y) : null;
        // A gap where the surface is undefined, as in a sampled curve.
        out.push(...(q?.every(Number.isFinite) ? q : [NaN, NaN, NaN]));
      }
    }
    return Float32Array.from(out);
  };
  // A sampled curve is short steps already; a figure's edges are long.
  for (const c of scene.curves.slice(mark.curves)) c.pts = line(c.pts, c.pts.length > 300 ? 1 : SURFACE_PIECES);
  for (const s of scene.segments.slice(mark.segments)) {
    const out: number[] = [];
    for (let i = 0; i + 5 < s.pts.length; i += 6) {
      const piece = line([s.pts[i], s.pts[i + 1], 0, s.pts[i + 3], s.pts[i + 4], 0], SURFACE_PIECES);
      for (let k = 0; k + 5 < piece.length; k += 3) {
        const seg = piece.subarray(k, k + 6);
        if (seg.every(Number.isFinite)) out.push(...seg);
      }
    }
    s.pts = Float32Array.from(out);
    s.retained = false;
  }
  // A point where the surface is undefined (1/x at x = 0) is not drawn.
  const placed = <T extends { pos: [number, number, number] }>(items: T[], from: number) => {
    const kept = items.slice(from).filter(it => (it.pos = onto(it.pos[0], it.pos[1])).every(Number.isFinite));
    items.splice(from, items.length - from, ...kept);
  };
  placed(scene.points, mark.points);
  if (scene.texts) placed(scene.texts, mark.texts);
}

/** A point on a surface moved a hair toward the eye, so the surface does
 *  not hide what lies exactly on it. */
function towardEye(cam: Camera3D): (p: readonly number[]) => [number, number, number] {
  const eye = cameraEye(cam);
  const lift = 0.004 * cam.radius;
  return p => {
    const d = Math.hypot(eye[0] - p[0], eye[1] - p[1], eye[2] - p[2]) || 1;
    return [0, 1, 2].map(k => p[k] + (lift * (eye[k] - p[k])) / d) as [number, number, number];
  };
}

/** A parametric region carried onto a surface: the GLSL of its mesh there,
 *  in the region's u and v, its sliders read as uniforms; null if the
 *  shaders cannot take it. */
const surfaceRegions = new WeakMap<SurfaceMap, WeakMap<readonly Expr[], ReturnType<typeof parametricGLSL> | null>>();
function surfaceRegionGLSL(surface: SurfaceMap, comps: readonly [Expr, Expr], params: readonly string[]) {
  let byRegion = surfaceRegions.get(surface);
  if (!byRegion) surfaceRegions.set(surface, (byRegion = new WeakMap()));
  let out = byRegion.get(comps);
  if (out === undefined) {
    const names = Object.fromEntries(params.map(p => [p, { kind: 'var', name: uniformName(p) } as Expr]));
    try {
      out = parametricGLSL(surfaceOver(surface, comps), e => substVars(e, names));
    } catch {
      out = null;
    }
    byRegion.set(comps, out);
  }
  return out;
}

/** A vector field's arrows on a surface, before their lift toward the eye:
 *  kept until the surface, the field or a value it reads (a slider, t)
 *  changes, so a still field costs nothing per frame. */
const surfaceFieldArrows = new WeakMap<
  readonly Expr[],
  { surface: SurfaceMap; reads: string[]; key: string | null; arrows: number[] }
>();
function fieldArrows(surface: SurfaceMap, comps: readonly Expr[], env: Record<string, number>): number[] {
  let c = surfaceFieldArrows.get(comps);
  if (c?.surface !== surface) {
    const reads = new Set(comps.flatMap(e => [...freeVars(e)]));
    reads.delete('x');
    reads.delete('y');
    c = { surface, reads: [...reads], key: null, arrows: [] };
    surfaceFieldArrows.set(comps, c);
  }
  const key = c.reads.map(n => env[n]).join();
  if (key !== c.key) {
    c.key = key;
    try {
      const field = fieldEvaluator([...comps], env);
      c.arrows = surfaceArrows(surface, (x, y) => field([x, y]));
    } catch {
      c.arrows = []; // too large to trace: refused at its row
    }
  }
  return c.arrows;
}

/** A parametric region's fill on a surface: all of its mesh, as an
 *  inequality's area is painted. */
const REGION_FILL: SurfacePaint['paint'] = { kind: 'region', field: '-1.0', edges: [] };

/** The axis maps of panel p's view(…) row (lib/axis-map.ts), if it has any. */
export function panelMaps(p: Panel | undefined): AxisMaps | undefined {
  const spec = p && viewportRow('view', p)?.viewSpec;
  return spec?.kind === 'view' ? spec.maps : undefined;
}

/** The current panel's viewport row of the given kind, if any (duplicates carry errors). */
export function viewportRow(kind: ViewSpec['kind'], p: Panel = app.cur): Equation | undefined {
  const i = panels.indexOf(p);
  return equations.find(eq => !eq.error && eq.viewSpec?.kind === kind && (eq.panel ?? 0) === i);
}

function applyViewportRows() {
  for (const p of panels) {
    const vRow = viewportRow('view', p);
    if (!vRow) p.appliedViewText = null;
    // A pan waiting to be written back is the window; the row catches up.
    else if (
      viewKey(vRow) !== p.appliedViewText &&
      vRow.viewSpec!.kind === 'view' &&
      p.layout.rect.w &&
      !movedPanels.has(p)
    ) {
      p.appliedViewText = viewKey(vRow);
      // Shared axes come from the panels that own them, which are earlier in
      // the list and already framed; the row frames the rest.
      const roots = linkRoots(p);
      const from = { x: roots.x === p ? undefined : roots.x.view, y: roots.y === p ? undefined : roots.y.view };
      const linked = linkedWindow(p.view, p.layout.shared, from);
      const { w, h } = p.layout.rect;
      const spec = p.lattice ? orientLattice(vRow.viewSpec!, p.lattice.axes) : vRow.viewSpec!;
      Object.assign(p.view, fitPanelWindow(spec, w, h, p.layout.shared, linked));
    }
    const cRow = viewportRow('camera', p);
    if (!cRow) {
      p.appliedCameraText = null;
      p.spin = 0;
    } else if (cRow.text !== p.appliedCameraText && cRow.viewSpec!.kind === 'camera') {
      p.appliedCameraText = cRow.text;
      const c = cRow.viewSpec!;
      p.spin = c.spin ?? 0;
      p.camera.theta = c.theta;
      p.camera.phi = clampPhi(c.phi);
      p.camera.radius = c.radius ?? 14;
      p.camera.target = c.target ? [...c.target] : [0, 0, 0];
    }
  }
}

// Pointer moves are hotter than slider inputs, so the row rewrite trails the
// gesture by a beat instead of running per move; release flushes it so the
// row, URL, and undo entry are settled the moment the gesture ends.
/** The pending writeback makes its own undo entry. */
let viewportWriteUndo = false;
/** Panels whose window or camera moved since the last writeback: only their
 *  rows are rewritten, so a gesture never reformats an untouched panel's row. */
const movedPanels = new Set<Panel>();

/** Panel p just moved (the current one, for a gesture): carry its shared
 *  axes to the panels sharing them, and write the rows back shortly. */
export function scheduleViewportWriteback(undo = true, p: Panel = app.cur) {
  movedPanels.add(p);
  for (const q of syncLinks(p)) movedPanels.add(q);
  viewportWriteUndo ||= undo;
  app.viewportWriteTimer ??= setTimeout(() => {
    app.viewportWriteTimer = null;
    writebackViewport(takeWritebackUndo());
  }, 200);
}

function takeWritebackUndo(): boolean {
  const undo = viewportWriteUndo;
  viewportWriteUndo = false;
  return undo;
}

export function flushViewportWriteback() {
  // Rows can arrive while rendering is paused, before their viewport is live.
  // Only an outstanding interaction authorizes writing the live view back.
  if (app.viewportWriteTimer === null) return;
  clearTimeout(app.viewportWriteTimer);
  app.viewportWriteTimer = null;
  writebackViewport(takeWritebackUndo());
}

/** Drop a pending pan and the live window so a new document isn't framed as the old one. */
export function resetViewport() {
  if (app.viewportWriteTimer !== null) {
    clearTimeout(app.viewportWriteTimer);
    app.viewportWriteTimer = null;
  }
  viewportWriteUndo = false;
  movedPanels.clear();
  for (const p of panels) {
    p.appliedViewText = p.appliedCameraText = null;
    p.view.cx = 0;
    p.view.cy = 0;
    delete p.view.ratio;
    const { w, h } = p.layout.rect;
    p.view.upp = w && h ? 12 / Math.min(w, h) : 0.01;
    p.fresh = !(w && h);
    Object.assign(p.camera, defaultCamera());
  }
}

/** Turns each live camera by its spin since the last frame. A hand on the
 *  graph holds it, and it resumes from there. */
function advanceSpin() {
  const now = performance.now();
  const dt = lastSpinAt === null ? 0 : Math.min(0.1, (now - lastSpinAt) / 1000);
  lastSpinAt = now;
  for (const p of panels) {
    if (p.mode !== '3d' || !p.spin || (pointers.size && p === app.activePanel)) continue;
    p.camera.theta += p.spin * dt;
  }
}

/** Where a new viewport row for panel p goes: the end of the panel's rows. */
function panelRowEnd(p: Panel): number {
  const i = panels.indexOf(p);
  const next = equations.findIndex(e => (e.panel ?? 0) > i);
  return next < 0 ? equations.length : next;
}

export function ensureViewRow() {
  if (viewportRow('view')) return;
  const id = app.nextId;
  pushUndo(`viewport:${id}`);
  const hw = (panelW() * app.view.upp) / 2;
  const hh = (panelH() * app.view.upp) / (app.view.ratio ?? 1) / 2;
  const text = formatViewSpec({
    x: [app.view.cx - hw, app.view.cx + hw],
    y: [app.view.cy - hh, app.view.cy + hh],
    ratio: app.view.ratio,
    axes: app.cur.lattice?.axes as [string, string] | undefined,
  });
  const added = addEquation(text, panelRowEnd(app.cur));
  recompileAll();
  app.cur.appliedViewText = viewKey(added);
  renderAll();
  saveUrl();
}

/** The row text framing panel p as it is now, when that differs from its row. */
function panelViewText(p: Panel): { eq: Equation; text: string } | null {
  const eq = viewportRow(p.mode === '2d' ? 'view' : 'camera', p);
  if (!eq || p.locked) return null;
  let text: string;
  if (p.mode === '2d') {
    const { w, h } = p.layout.rect;
    const { x: sx, y: sy } = p.layout.shared;
    // An axis shared with another panel is that panel's row's to write.
    if (!w || !h || (sx && sy)) return null;
    const v = p.view;
    const hw = (w / 2) * v.upp;
    const hh = (h / 2) * (v.upp / (v.ratio ?? 1));
    text = formatViewSpec(
      {
        x: sx ? undefined : [v.cx - hw, v.cx + hw],
        y: sy ? undefined : [v.cy - hh, v.cy + hh],
        ratio: sx || sy ? undefined : v.ratio,
        axes: p.lattice?.axes as [string, string] | undefined,
        maps: (eq.viewSpec as View2DSpec).maps,
      },
      p.lattice?.written,
    );
  } else {
    text = formatCameraRow({ ...p.camera, spin: p.spin });
  }
  // A mapped axis panned past what its map can name (ln(X) left of X = 0)
  // has no row to write: the row keeps the last window it could.
  try {
    parseViewRow(text, app.constEnv);
  } catch {
    return null;
  }
  text = keepNote(eq.text, text);
  return text === eq.text ? null : { eq, text };
}

/** Rewrite the moved panels' viewport rows to the picture on screen (shared
 *  axes move more than one panel, so a gesture can change several rows). */
function writebackViewport(undo: boolean) {
  const moved = panels.filter(p => movedPanels.has(p));
  movedPanels.clear();
  const changes = moved.flatMap(p => {
    const change = panelViewText(p);
    return change ? [{ p, ...change }] : [];
  });
  if (!changes.length) return;
  if (undo) pushUndo(`viewport:${changes[0].eq.id}`);
  let failed = false;
  for (const { p, eq, text } of changes) {
    if (p.mode !== '2d') p.appliedCameraText = text;
    eq.text = text;
    const line = lineEls()[equations.indexOf(eq)];
    if (line) setLineText(line, text);
    // Only the framing changed. Reclassifying the math here discards geometry
    // caches and can block every camera gesture for hundreds of milliseconds.
    // Text the formatter cannot round-trip (a non-finite window) still lands
    // as this row's error, the way a typed view(...) does.
    try {
      // The row's `# note` is prose, not part of the viewport.
      eq.viewSpec = parseViewRow(stripNote(text), app.constEnv) ?? undefined;
    } catch {
      failed = true;
    }
    if (p.mode === '2d') p.appliedViewText = viewKey(eq);
  }
  if (failed) recompileAll();
  reconcile();
  saveUrl();
}

// Classification produces new AST objects even when only view(...) changed.
// Compare mathematical content, computed once per classification, not identity.
/** Generations a 2D board steps in one frame on its way to the one t asks for. */
const BOARD_CATCH_UP = 40;
const boardShapes = new WeakMap<object, string>();
/** What a board is built from: the same rule in a new plan keeps its board. */
function boardShape(plan: Extract<CpuPlan, { type: 'automaton' }>): string {
  let key = boardShapes.get(plan);
  if (key === undefined) {
    key = JSON.stringify([plan.rule, plan.seed ?? null, plan.radius]);
    boardShapes.set(plan, key);
  }
  return key;
}

const systemKeys = new WeakMap<CpuPlan, string>();
const traceEnvironments = new WeakMap<Classified, ReturnType<typeof traceEnvironment>>();
function systemKey(cpu: CpuPlan): string {
  let key = systemKeys.get(cpu);
  if (key === undefined) {
    key = cpuStructureKey(cpu);
    systemKeys.set(cpu, key);
  }
  return key;
}
export const mcpApp = document.documentElement.hasAttribute('data-mcp-app');
export const framed = document.documentElement.hasAttribute('data-embed');
/** MCP widget or a framed graph: no address-bar writes, no featured default. */
export const embedded = mcpApp || framed;
export const traceQueue = new TraceQueue((message: TraceMessage) => {
  if (app.rendererDisposed) return;
  const fail = (error: string) => {
    app.traceWorker?.terminate();
    app.traceWorker = undefined;
    traceQueue.complete(message.token, { pts: [], error });
  };
  try {
    // The chat iframe is cross-origin; its worker must be created locally.
    // Framed /g/ pages load their worker from their own origin.
    app.traceWorker ??= mcpApp
      ? new EmbeddedTraceWorker()
      : new Worker(new URL('./trace-worker.ts', import.meta.url), { type: 'module' });
    app.traceWorker.onmessage = (event: MessageEvent<{ token: number; result: TraceResult }>) => {
      traceQueue.complete(event.data.token, event.data.result);
    };
    app.traceWorker.onerror = event => {
      event.preventDefault();
      fail('Could not trace this curve in the background: ' + event.message);
    };
    app.traceWorker.onmessageerror = () => fail('Could not read the background curve trace.');
    app.traceWorker.postMessage(message);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
});

const familyRows = new WeakMap<Classified, Equation[]>();
const hullSamplers = new WeakMap<CpuPlan, ReturnType<typeof hullGeometrySampler>>();
/** A figure's coordinates: compiled once per plan, run every frame. */
const vertexSamplers = new WeakMap<CpuPlan, VertexSampler>();
const verticesOf = (plot: CpuPlan & { type: 'polygon' }): VertexSampler => {
  let sample = vertexSamplers.get(plot);
  if (!sample) vertexSamplers.set(plot, (sample = vertexSampler(plot.pts, plot.over)));
  return sample;
};
let familyId = -100000;
function renderMembers(eq: Equation): Equation[] {
  const cls = eq.cls!,
    cpu = eq.cpu!;
  if (cpu.type !== 'family') return [eq];
  let children = familyRows.get(cls);
  if (!children) {
    const gpuMembers = eq.gpu?.type === 'family' ? eq.gpu.members : [];
    children = cpu.members.map((m, k) => ({
      ...eq,
      id: familyId--,
      cls: m.cls,
      cpu: m.cpu,
      gpu: gpuMembers[k],
      familyParent: eq,
      familyShade: (0.45 * k) / Math.max(1, cpu.members.length - 1),
      sysCache: undefined,
      pathCache: undefined,
      regionCache: undefined,
      traceTarget: undefined,
      orbitCache: undefined,
      orbitPending: undefined,
    }));
    familyRows.set(cls, children);
  }
  // The row's own display choices (colour, toggles) change without a new
  // classification, so the cached members take them from the row every time.
  for (const child of children) {
    if (child.certify !== eq.certify || child.showArrows !== eq.showArrows) {
      child.sysCache = undefined;
      child.traceTarget = undefined;
      traceQueue.cancelPending(child.id);
    }
    Object.assign(child, familyShared(eq));
  }
  return children;
}
const familyShared = ({
  colorIndex,
  showArrows,
  showStreamlines,
  certify,
  showLevels,
  combK,
  combT,
  partialSum,
}: Equation) => ({ colorIndex, showArrows, showStreamlines, certify, showLevels, combK, combT, partialSum });

/** A row's own color: its `#hex` note if it has one, else its palette slot.
 *  Family members read their parent's note — their own text is generated. */
export function baseColor(eq: Equation): [number, number, number] {
  const src = eq.familyParent ?? eq;
  if (src.noteColor?.text !== src.text) src.noteColor = { text: src.text, rgb: noteColor(src.text) };
  return src.noteColor.rgb ?? theme.palette[eq.colorIndex] ?? theme.palette[0];
}

const rowColor = (eq: Equation): [number, number, number] =>
  baseColor(eq).map(c => c + (1 - c) * (eq.familyShade ?? 0)) as [number, number, number];
const liveRow = (eq: Equation) =>
  equations.includes(eq.familyParent ?? eq) &&
  (!eq.familyParent || (!!eq.familyParent.cls && renderMembers(eq.familyParent).includes(eq)));

/** Which grid families draw behind a 2D panel: those its grid(…) row names,
 *  or else the coordinate fields defined among its rows. Empty is Cartesian. */
/** Coordinate grids through plane maps, compiled once per field and map. */
const planeGrids = new WeakMap<PlaneMap, Map<GridField | 'x' | 'y', GridField>>();

/** A coordinate field (or x or y itself) as a plane-mapped panel grids it:
 *  its level lines, drawn on the screen through the map. */
function planeGridField(f: GridField | 'x' | 'y', plane: PlaneMap): GridField {
  let fields = planeGrids.get(plane);
  if (!fields) planeGrids.set(plane, (fields = new Map()));
  let out = fields.get(f);
  if (!out) {
    const [x, y] = planeIn(plane).forward;
    const spec =
      f === 'x' || f === 'y'
        ? { name: f, expr: f === 'x' ? x : y, params: [] }
        : { name: f.name, expr: substVars(f.expr, { x, y }), params: f.params };
    out = { ...compileGridCpu(spec), ...compileGridGpu(spec) };
    fields.set(f, out);
  }
  return out;
}

function panelGridFields(p: Panel, plane?: PlaneMap): Array<GridField | 'x' | 'y'> {
  const coords = p.grid?.mode === 'coords' ? p.grid.coords! : null;
  if (coords) {
    // grid(x, y) is the plain grid, except through a plane map, where x and
    // y are curves on the screen.
    if (!plane && coords.length === 2 && coords.includes('x') && coords.includes('y')) return [];
    return coords.flatMap<GridField | 'x' | 'y'>(name =>
      name === 'x' || name === 'y' ? [name] : app.gridFields.filter(f => f.name === name),
    );
  }
  const i = panels.indexOf(p);
  return app.gridFields.filter(f => (app.gridFieldPanels.get(f.name) ?? 0) === i);
}

/** Each cloud's scale (lib/volume.ts) and the view and sliders it was read under. */
const volumeScales = new WeakMap<CpuPlan, { key: string; scale: number }>();

/** The names a geodesic reads besides its parameters: what it is traced
 *  again for when they change. */
const geodesicReads = new WeakMap<CpuPlan, string[]>();
/** A family of geodesics shares this budget, each member a share of it. */
const GEODESIC_FAMILY_STEPS = 200000;
const GEODESIC_FAMILY_MS = 1000;
/** …and draws with this many points in all: each is carried onto its
 *  surface every frame. */
const GEODESIC_FAMILY_POINTS = 48000;

/**
 * Where each geodesic's traced points are kept: by its row and, in a family,
 * its member — not on the member rows themselves, which are made afresh each
 * time the row is reanalysed (every move of a dragged point it reads), so
 * the last geodesic keeps drawing through a drag. `id` is the trace queue's
 * row for it, likewise stable, so a newer request replaces an older one
 * still waiting rather than queueing behind it.
 */
/** When the last frame was drawn, and the frame a traced geodesic asks for
 *  if none comes by itself within GEODESIC_FRAME_MS. */
let lastRenderAt = 0;
let geodesicFrame: ReturnType<typeof setTimeout> | undefined;
const GEODESIC_FRAME_MS = 50;
const geodesicSlots = new Map<
  string,
  { id: number; key?: string; pending?: string; pts: Float32Array; note?: string }
>();
/** Each geodesic plan's geodesicPlanKey, worked out once. */
const geodesicPlans = new WeakMap<CpuPlan, string>();
let geodesicIds = -1e9;

/**
 * A geodesic row's note, from its members' traces: where its budget cut one
 * short, or how many of a family it cut. Slots of members a shorter list no
 * longer has are let go here.
 */
function geodesicNote(row: Equation, members: number) {
  const notes: string[] = [];
  for (const [name, slot] of geodesicSlots) {
    const [id, member] = name.split(':');
    if (id !== `${row.id}`) continue;
    if (Number(member) >= members) geodesicSlots.delete(name);
    else if (slot.note) notes.push(slot.note);
  }
  // Budget cuts, and members that could not start (faster than light).
  const cuts = notes.filter(n => n.startsWith('cut short at '));
  const others = notes.filter(n => !n.startsWith('cut short at '));
  const note =
    notes.length === 0
      ? undefined
      : members === 1
        ? notes[0]
        : [
            others.length ? `${others.length} of ${members}: ${others[0]}` : '',
            cuts.length
              ? `${cuts.length} of ${members} cut short by the family's budget (one at ${cuts[0].replace(/^cut short at /, '')})`
              : '',
          ]
            .filter(Boolean)
            .join('; ');
  // (A reanalysis clears the row's info, so it is compared with that.)
  if (note === row.info) return;
  row.info = note;
  reconcile();
}

/**
 * A geodesic's points, traced in the trace worker (lib/surface-geometry.ts
 * geodesicPath) whenever a value it reads changes — a slider, t, a dragged
 * point — and never on this thread. The last one traced keeps drawing until
 * the next arrives, so dragging stays smooth while the worker catches up.
 */
function geodesicFor(eq: Equation, env: Record<string, number>): Float32Array {
  const plot = eq.cpu as Extract<CpuPlan, { type: 'geodesic' }>;
  let names = geodesicReads.get(plot);
  if (!names) {
    const exprs = [...plot.surface, ...plot.derivatives, ...plot.start, ...plot.direction, ...plot.domain];
    if (plot.length) exprs.push(plot.length);
    names = [...freeVars({ kind: 'vec', items: exprs })].filter(n => !plot.params.includes(n));
    geodesicReads.set(plot, names);
  }
  const row = eq.familyParent ?? eq;
  const family = row.cpu?.type === 'family' ? row.cpu.members : null;
  const member = family ? family.findIndex(m => m.cpu === plot) : 0;
  const slotName = `${row.id}:${member}`;
  let slot = geodesicSlots.get(slotName);
  if (!slot) {
    // Forget the rows that are gone, now and then.
    if (geodesicSlots.size > 256) {
      const live = new Set(equations.map(e => `${e.id}`));
      for (const name of geodesicSlots.keys()) if (!live.has(name.split(':')[0])) geodesicSlots.delete(name);
    }
    geodesicSlots.set(slotName, (slot = { id: geodesicIds--, pts: new Float32Array() }));
  }
  let plan = geodesicPlans.get(plot);
  if (plan === undefined) geodesicPlans.set(plot, (plan = geodesicPlanKey(plot)));
  const members = family?.length ?? 1;
  // Its note: how its members' budgets cut them short, if they did.
  geodesicNote(row, members);
  // The plan is in the key, so an edit to a row it reads (S, the list of
  // directions, the panel's surface) traces it again; the last path keeps
  // drawing until the new one arrives.
  const key = `${plan}\n${member}\n${JSON.stringify(names.map(n => env[n]))}`;
  if (slot.key === key || slot.pending === key) return slot.pts;
  slot.pending = key;
  const { type: _, ...spec } = plot;
  const values = Object.fromEntries(names.map(n => [n, env[n]]));
  const target = slot;
  traceQueue.request(
    slot.id,
    key,
    {
      kind: 'geodesic',
      geodesic: {
        spec,
        env: values,
        maxSteps: Math.min(GEODESIC_MAX_STEPS, Math.ceil(GEODESIC_FAMILY_STEPS / members)),
        ms: GEODESIC_FAMILY_MS / members,
        // Carried onto its surface every frame, so held to GEODESIC_MAX_POINTS.
        maxPoints: Math.min(GEODESIC_MAX_POINTS, Math.max(300, Math.floor(GEODESIC_FAMILY_POINTS / members))),
      },
      residuals: [],
      dim: plot.dim,
      lo: [],
      hi: [],
      env: {},
    },
    result => {
      if (!equations.includes(row) || geodesicSlots.get(slotName) !== target) return;
      if (target.pending === key) target.pending = undefined;
      // Kept even when a newer one is on its way: while P is dragged the
      // drawn geodesic follows a frame or two behind rather than not at all.
      target.key = key;
      target.pts = result.flat ?? new Float32Array();
      target.note = result.info;
      geodesicNote(row, members);
      // A frame of its own only when none comes anyway: a drag or t brings
      // frames that draw whatever has arrived, and a frame per result on top
      // of those would halve their rate where drawing is slow.
      clearTimeout(geodesicFrame);
      geodesicFrame = setTimeout(() => {
        if (performance.now() - lastRenderAt > GEODESIC_FRAME_MS) requestRender();
      }, GEODESIC_FRAME_MS);
    },
  );
  return slot.pts;
}

/** The gain a field painted on a surface's panel (gaussian(x, y)) is shaded
 *  with, kept until the surface or a value it reads (a slider, t) changes. */
const fieldGains = new WeakMap<CpuPlan, { key: string; surface: SurfaceMap; gain: number }>();
function surfaceFieldGain(
  surface: SurfaceMap,
  plot: Extract<CpuPlan, { type: 'scalar2d' }>,
  env: Record<string, number>,
): number {
  const names = [...freeVars(plot.expr)].filter(n => n !== 'x' && n !== 'y');
  const key = JSON.stringify(names.map(n => env[n]));
  const last = fieldGains.get(plot);
  if (last?.key === key && last.surface === surface) return last.gain;
  const f = numericIn([plot.expr], ['x', 'y'], env);
  const one = new Float64Array(1);
  const size = defaultGeodesicLength((x, y) => surfacePoint(surface, x, y), [surface.x, surface.y]) / 2;
  const gain = divergingGain(
    (x, y) => (f(x, y, one), one[0]),
    [surface.x, surface.y],
    1e-9 * Math.min(1 / size, 1 / size ** 2),
  );
  fieldGains.set(plot, { key, surface, gain });
  return gain;
}

/** The gain a surface coloured by its curvature (gaussian(S)) shades it
 *  with, kept until a value it reads (a slider, t) changes. */
const paintGains = new WeakMap<CpuPlan, { key: string; gain: number }>();
function paintGain(plot: Extract<CpuPlan, { type: 'psurface' }>, env: Record<string, number>): number {
  const paint = plot.paint!;
  const names = [...freeVars({ kind: 'vec', items: [...plot.comps, paint] })].filter(n => n !== 'u' && n !== 'v');
  const key = JSON.stringify(names.map(n => env[n]));
  const last = paintGains.get(plot);
  if (last?.key === key) return last.gain;
  const unit: GeodesicOptions['domain'] = [
    [0, 1],
    [0, 1],
  ];
  const f = numericIn([paint], ['u', 'v'], env);
  const P = numericIn(plot.comps, ['u', 'v'], env);
  const out = new Float64Array(3);
  // Rounding, not curvature, below 1e-9 of the surface's own size.
  const size = defaultGeodesicLength((u, v) => (P(u, v, out), [...out]), unit) / 2;
  const one = new Float64Array(1);
  const gain = divergingGain((u, v) => (f(u, v, one), one[0]), unit, 1e-9 * Math.min(1 / size, 1 / size ** 2));
  paintGains.set(plot, { key, gain });
  return gain;
}

/** 2D-only plots (densities, flows, sequences, planar fields) a 3D scene leaves out. */
const SKIPPED_IN_3D: ReadonlySet<CpuPlan['type']> = new Set([
  'scalar2d',
  'complex2d',
  'domain2d',
  'rgb2d',
  'hsl2d',
  'oklch2d',
  'conformal2d',
  'fractal2d',
  'ineq2d',
  'projected2d',
  'vfield2d',
  'tfield2d',
  'vlist',
  'dlist',
  'histogram',
  'sequence',
  'cobweb',
  'bifurcation',
  'automaton',
  'lattice',
  'graph',
  'density',
  'pmf',
  'prob',
  'expect',
]);

/**
 * A graph's arrows, vertices and edge labels for the overlay. `node` is a
 * vertex's radius in plane units, so arrows stop at its ring. An arrow whose
 * reverse is also drawn bends to its own side, a loop hangs above its
 * vertex, and the rest are straight.
 */
function graphOverlay(
  data: GraphData,
  pos: ReadonlyMap<number, [number, number]>,
  color: string,
  marks: ReadonlySet<number>,
  node: number,
  extras: Overlay2D,
) {
  const texts = new Map(data.edges.map(e => [`${e.from}>${e.to}`, edgeText(e)]));
  const tags = (extras.tags ??= []);
  for (const e of data.edges) {
    // Both ways with the same labels (an involution's two arrows, s·s = 1)
    // is one plain line, drawn from the smaller end.
    const reverse = texts.get(`${e.to}>${e.from}`);
    const both = e.from !== e.to && reverse === texts.get(`${e.from}>${e.to}`);
    if (both && e.from > e.to) continue;
    const [ax, ay] = pos.get(e.from)!;
    const [bx, by] = pos.get(e.to)!;
    const text = edgeText(e);
    const pts: number[] = [];
    let mid: [number, number];
    if (e.from === e.to) {
      // A loop: a circle above the vertex, entering it from the right.
      const r = node * 1.3;
      const cx = ax,
        cy = ay + node + r * 0.45;
      const start = Math.PI * 1.25,
        end = Math.PI * 1.25 - Math.PI * 1.5;
      // Few enough steps that the last is long enough to carry the head.
      for (let k = 0; k <= 9; k++) {
        const a = start + ((end - start) * k) / 9;
        pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
      }
      mid = [cx, cy + r + node * 0.6];
    } else {
      const len = Math.hypot(bx - ax, by - ay) || 1;
      // Perpendicular, to the arrow's left; bend only when the reverse is drawn too.
      const [nx, ny] = [-(by - ay) / len, (bx - ax) / len];
      const bend = reverse !== undefined && !both ? len * 0.18 : 0;
      const [qx, qy] = [(ax + bx) / 2 + nx * bend, (ay + by) / 2 + ny * bend];
      const t0 = Math.min(0.45, node / len),
        t1 = 1 - Math.min(0.45, (node * 1.1) / len);
      // The arrowhead is as long as the last segment (lib/geom.ts arrowHead),
      // so the curve stops a head short of the tip and one segment finishes it.
      const tHead = Math.max(t0, t1 - (node * 0.95) / len);
      const at = (t: number) => {
        const u = 1 - t;
        pts.push(u * u * ax + 2 * u * t * qx + t * t * bx, u * u * ay + 2 * u * t * qy + t * t * by);
      };
      for (let k = 0; k <= 12; k++) at(t0 + ((tHead - t0) * k) / 12);
      at(t1);
      const lift = bend ? bend / 2 + node * 0.55 : node * 0.55;
      mid = [(ax + bx) / 2 + nx * lift, (ay + by) / 2 + ny * lift];
    }
    extras.polylines.push({ pts, color, width: 1.75, arrow: !both });
    if (text) tags.push({ x: mid[0], y: mid[1], text, color });
  }
  const nodes = (extras.nodes ??= []);
  for (const v of data.vertices) {
    const [x, y] = pos.get(v)!;
    nodes.push({ x, y, text: String(parseFloat(v.toPrecision(6))), color, mark: marks.has(v) });
  }
}

/** Which edges of an automaton's cells run on as background: a 1D diagram's
 *  sides, and every side of a 2D board. */
const ROW_RUNS = { x: true, y: false };
const BOARD_RUNS = { x: true, y: true };

/** Cells for the renderer (web/render2d.ts Cells2D), coloured where drawn. */
function cellsOf(g: CellGrid, runs: Cells2D['runs'], shades = cellShades(g)): Cells2D {
  return { shades, width: g.width, rows: g.rows, x0: g.x0, y0: g.y0, runs, color: [0, 0, 0] };
}

export function render() {
  lastRenderAt = performance.now();
  if (!syncCanvasSize()) return;
  applyViewportRows();
  syncLinks(null);
  const dpr = window.devicePixelRatio || 1;
  const time = graphTime();
  const active = equations.filter(e => e.cls && !e.error).flatMap(renderMembers);
  advanceSpin();

  // States carry between frames, so they are integrated up to now before
  // anything reads them; the constants may then be formulas in those states.
  app.constEnv = currentConstEnv(time);
  followSurfaceHover();

  // Readouts belong to the source row, even when its family has many draws.
  for (const eq of equations) {
    if (!eq.cls || eq.error) continue;
    try {
      const readout = plotReadout(eq.cpu!, { ...app.constEnv, t: time });
      const text = readout === null ? null : withNote(readout, eq.note)!;
      if (text !== null && text !== eq.info) {
        eq.info = text;
        if (eq.infoEl) eq.infoEl.textContent = text;
      }
    } catch {
      /* incomplete values while editing */
    }
  }

  for (const eq of active) {
    if (eq.cpu!.type !== 'trail') continue;
    const plot = eq.cpu!;
    eq.trail ??= new PointTrail(plot.dim);
    let point: number[];
    try {
      point = plot.coords.map(c => evaluate(c, { ...app.constEnv, t: time }));
    } catch {
      point = Array(plot.dim).fill(NaN);
    }
    eq.trail.sample(time, point);
  }

  // Fresh joint sample every frame: estimated density curves shimmer with
  // their true sampling noise instead of freezing one pairing into wiggles
  // that read as structure. Exact laws don't sample and are unaffected.
  if (rvSys.size() > 0) rvSys.resample();

  gl.clearColor(theme.bg[0], theme.bg[1], theme.bg[2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  const split = panels.length > 1;
  // One panel draws its overlay whole, clearing it; split panels each draw
  // clipped to their box, so the overlay is cleared once for all of them.
  if (split) overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

  // A filled parametric region's triangles, resampled when a value it reads changes.
  const sampleRegion = (eq: Equation, comps: readonly [Expr, Expr]): Float64Array => {
    let c = eq.regionCache;
    if (c?.comps !== comps)
      c = eq.regionCache = { comps, sampler: regionSampler(comps), key: '', tris: new Float64Array() };
    const env: Record<string, number> = { ...app.constEnv, t: time };
    const key = c.sampler.names.map(n => env[n]).join();
    if (key !== c.key || !c.tris.length) {
      c.key = key;
      c.tris = c.sampler.sample(env);
    }
    return c.tris;
  };

  // CPU sampling of parametric curves / points, with t bound to seconds.
  // A plane curve (a complex path included): compiled, and broken at its
  // jumps — branch cuts, steps, poles.
  const sampleCurve = (eq: Equation): number[] => {
    const { comps } = eq.cpu! as { comps: Expr[] };
    let c = eq.pathCache;
    if (c?.comps !== comps) c = eq.pathCache = { comps, sampler: pathSampler(comps), key: '', pts: [] };
    const env: Record<string, number> = { ...app.constEnv, t: time };
    const key = c.sampler.names.map(n => env[n]).join();
    if (key !== c.key || !c.pts.length) {
      c.key = key;
      c.pts = c.sampler.sample(env);
    }
    return c.pts;
  };

  /**
   * A space curve at the curve samples, and whichever of r′, r″, r‴ its tube
   * or combs need (undefined where not asked for), as xyz triples; NaN where
   * a sample does not evaluate. What does not move with u is worked out once
   * for the frame, and once for all of them — an osculating circle's
   * derivatives each repeat its whole centre — and what is left compiled.
   */
  const sampleSpaceCurve = (vecs: readonly (readonly Expr[] | undefined)[]): Array<Float32Array | undefined> => {
    const frameEnv: Record<string, number> = { ...app.constEnv, t: time };
    const along = foldAllExcept(
      vecs.flatMap(es => es ?? []),
      'u',
      frameEnv,
    );
    let at = 0;
    return vecs.map(es => {
      if (!es) return undefined;
      const out = new Float32Array(CURVE_SAMPLES * 3);
      for (let c = 0; c < es.length; c++) {
        const e = along[at++];
        const sample =
          compileSampler(e, 'u', [...freeVars(e)])?.(frameEnv) ??
          ((u: number) => {
            try {
              return evaluate(e, { ...frameEnv, u });
            } catch {
              return NaN;
            }
          });
        for (let k = 0; k < CURVE_SAMPLES; k++) out[k * 3 + c] = sample(k / (CURVE_SAMPLES - 1));
      }
      return out;
    });
  };
  // RK4 streamline of the normalized field through (x0, y0), both directions.
  // Normalizing makes it a direction field: uniform arc-length steps, and the
  // same trajectories (dy/dx = f slope fields integrate as (1, f) normalized).
  const integralCurve = (
    comps: [Expr, Expr],
    x0: number,
    y0: number,
    time: number,
    uniforms: Record<string, number> = {},
  ): number[] => {
    const w = 1.5 * panelW() * app.view.upp;
    const h = (1.5 * panelH() * app.view.upp) / (app.view.ratio ?? 1);
    return streamline(
      fieldEvaluator(comps, { ...app.constEnv, ...uniforms, t: time }),
      [x0, y0],
      2.5 * app.view.upp,
      [app.view.cx - w, app.view.cy - h],
      [app.view.cx + w, app.view.cy + h],
      ODE_STEPS,
      [1, app.view.ratio ?? 1],
    ).flat();
  };

  const samplePoint = (eq: Equation): number[] | null => {
    const { coords } = eq.cpu! as { coords: import('../lib/expr.ts').Expr[] };
    try {
      const p = coords.map(c => evaluate(c, { ...app.constEnv, t: time }));
      return p.every(isFinite) ? p : null;
    } catch {
      return null;
    }
  };

  /**
   * An orbit's paths, integrated in the worker whenever something it reads
   * other than the states and t changes — a slider, an edit — and not per
   * frame. The previous orbit keeps drawing while the next one integrates.
   */
  const orbitFor = (eq: Equation): number[][] => {
    const plot = eq.cpu as Extract<CpuPlan, { type: 'orbit' }>;
    const cls = eq.cls!;
    let environment = traceEnvironments.get(cls);
    if (!environment) {
      environment = traceEnvironment(cls.params, false, app.defs);
      traceEnvironments.set(cls, environment);
    }
    const key = eq.text + '\n' + environment(app.constEnv, 0).stableEnv;
    const c = eq.orbitCache;
    if (c?.key === key) return c.pts;
    if (eq.orbitPending !== key) {
      eq.orbitPending = key;
      let orbit: OrbitInput;
      try {
        orbit = orbitInput(
          app.defs,
          plot.paths,
          plot.series,
          evaluate(plot.from, app.constEnv),
          evaluate(plot.to, app.constEnv),
          app.constEnv,
        );
      } catch (e) {
        (eq.familyParent ?? eq).error = e instanceof Error ? e.message : String(e);
        reconcile();
        return [];
      }
      traceQueue.request(
        eq.id,
        key,
        { kind: 'orbit', orbit, residuals: [], dim: plot.dim, lo: [], hi: [], env: {} },
        result => {
          if (!liveRow(eq) || eq.orbitPending !== key) return;
          eq.orbitPending = undefined;
          if (result.error) {
            (eq.familyParent ?? eq).error = result.error;
            reconcile();
          } else eq.orbitCache = { key, pts: result.pts };
          requestRender();
        },
      );
    }
    return c?.pts ?? [];
  };

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
      const r = cameraBoxR(app.camera);
      const [tx, ty, tz] = app.camera.target;
      vlo = [tx - r, ty - r, tz - r];
      vhi = [tx + r, ty + r, tz + r];
    } else {
      const halfW = (panelW() / 2) * app.view.upp;
      const halfH = (panelH() / 2) * (app.view.upp / (app.view.ratio ?? 1));
      vlo = [app.view.cx - halfW, app.view.cy - halfH];
      vhi = [app.view.cx + halfW, app.view.cy + halfH];
      // A system whose solutions are placed on a mapped panel (a complex one,
      // in w) solves in x and y: over the part of the window the maps show.
      const maps = panelMaps(panels[panelOf(eq)]);
      const placed = !!maps && axisMapping(cls.object, maps) === 'place';
      if (placed && maps.plane) {
        const world = planeWorldBox(maps.plane, { lo: [vlo[0], vlo[1]], hi: [vhi[0], vhi[1]] });
        if (!world) return [];
        [vlo, vhi] = [[...world.lo], [...world.hi]];
      } else if (placed)
        for (const [k, map] of [maps.x, maps.y].entries()) {
          if (!map) continue;
          const shown = shownRange(map, vlo[k], vhi[k]);
          if (!shown) return [];
          [vlo[k], vhi[k]] = shown.world;
        }
    }
    const pad = vhi.map((v, k) => 0.25 * (v - vlo[k]));
    const lo = vlo.map((v, k) => v - pad[k]);
    const hi = vhi.map((v, k) => v + pad[k]);
    // Arrow glyphs sample live t so an animated field stays smooth.
    if (eq.cpu!.type === 'vfield3d' && eq.showArrows) {
      traceQueue.cancelPending(eq.id);
      try {
        return traceField(residuals, lo, hi, { ...app.constEnv, t: time }, true).flatMap(path => [
          ...path,
          Array(dim).fill(NaN),
        ]);
      } catch (e) {
        (eq.familyParent ?? eq).error = e instanceof Error ? e.message : String(e);
        reconcile();
        return [];
      }
    }
    let environment = traceEnvironments.get(cls);
    if (!environment) {
      environment = traceEnvironment(cls.params, cls.animated, app.defs);
      traceEnvironments.set(cls, environment);
    }
    const traceTime = eq.cpu!.type === 'vfield3d' ? Math.floor(time * 20) / 20 : time;
    const { env: envKey, stableEnv } = environment(app.constEnv, traceTime);
    const certify = certifying(eq);
    const key = systemKey(eq.cpu!) + ':' + !!eq.showArrows + ':' + certify;
    const c = eq.sysCache;
    if (
      c &&
      c.key === key &&
      c.text === eq.text &&
      c.env === envKey &&
      c.lo.length === dim &&
      vlo.every((v, k) => c.lo[k] <= v && c.hi[k] >= vhi[k] && c.hi[k] - c.lo[k] <= 6 * (vhi[k] - v))
    ) {
      eq.traceTarget = undefined;
      traceQueue.cancelPending(eq.id);
      return c.pts;
    }
    if (
      (eq.cpu!.type === 'system' && eq.cpu!.parametric) ||
      eq.cpu!.type === 'vfield3d' ||
      eq.cpu!.type === 'spacecurve' ||
      (eq.cpu!.type === 'system' && certify)
    ) {
      const jobKey = JSON.stringify([key, envKey, lo, hi]);
      const target = JSON.stringify([key, stableEnv, lo, hi]);
      const retraceMs = eq.cpu!.type === 'vfield3d' ? 50 : 250;
      if (
        (eq.cpu!.type === 'vfield3d' || certify) &&
        eq.traceTarget === target &&
        performance.now() - (eq.traceClock ?? -Infinity) < retraceMs
      )
        return c && c.stableEnv === stableEnv ? c.pts : [];
      eq.traceTarget = target;
      eq.traceClock = performance.now();
      if (certify && eq.info !== 'Certifying search box…') {
        eq.info = 'Certifying search box…';
        reconcile();
      }
      traceQueue.request(
        eq.id,
        jobKey,
        {
          residuals,
          dim,
          lo,
          hi,
          env: { ...app.constEnv, t: traceTime },
          kind: certify
            ? 'certify'
            : eq.cpu!.type === 'spacecurve'
              ? 'intersection'
              : eq.cpu!.type === 'vfield3d'
                ? 'field'
                : 'system',
          glyphs: eq.showArrows,
          angular: eq.cpu!.type === 'system' ? eq.cpu!.angular : undefined,
        },
        result => {
          // A result for edited/deleted math must never restore an old curve.
          if (!liveRow(eq) || !eq.cls || systemKey(eq.cpu!) + ':' + !!eq.showArrows + ':' + certifying(eq) !== key)
            return;
          // A trace from a briefly zoomed-in view must not replace the full
          // curve after the user zooms back out. Only moving values may lag.
          if (eq.traceTarget !== target) return;
          if (result.error) {
            (eq.familyParent ?? eq).error = result.error;
            reconcile();
          } else {
            eq.sysCache = { key, text: eq.text, env: envKey, stableEnv, lo, hi, pts: result.pts };
            if (result.info) {
              eq.info = result.info;
              reconcile();
            }
          }
          requestRender();
        },
      );
      // Keep projecting existing world-space geometry during pan/zoom.
      // Constants changing invalidate it; animated rows use the last completed
      // frame while their next trace runs in the worker.
      const sameEnv = c && c.stableEnv === stableEnv;
      return c && c.key === key && sameEnv ? c.pts : [];
    }
    const pts = solveSystem(residuals, dim === 3 ? ['x', 'y', 'z'] : ['x', 'y'], lo, hi, {
      env: { ...app.constEnv, t: time },
      angular: eq.cpu!.type === 'system' ? eq.cpu!.angular : undefined,
    });
    eq.sysCache = { key, text: eq.text, env: envKey, stableEnv, lo, hi, pts };
    return pts;
  };

  for (const [index, panel] of panels.entries()) {
    usePanel(panel);
    const rows = active.filter(e => panelOf(e) === index);
    const r = panel.layout.rect;
    if (!r.w || !r.h) continue;
    // A graph has no coordinates to grid: a panel of graphs draws none unless asked.
    const graphs =
      rows.some(e => e.cpu!.type === 'graph') && rows.every(e => ['graph', 'value', 'note'].includes(e.cpu!.type));
    const gridMode = panel.grid
      ? panel.grid.mode === 'off'
        ? 'off'
        : panel.grid.mode === 'axes'
          ? 'axes'
          : 'on'
      : graphs
        ? 'off'
        : 'on';
    const maps = panelMaps(panel);
    const frame: Frame = {
      vp: { x: r.x, y: canvas.height - r.y - r.h, w: r.w, h: r.h },
      grid: gridMode,
      lattice: !!panel.lattice,
      ...(maps ? { maps } : {}),
    };
    const box = split ? { x: r.x / dpr, y: r.y / dpr, w: r.w / dpr, h: r.h / dpr } : undefined;
    if (split) {
      // Scissored, so an inset paints over its host and nothing spills over an edge.
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(frame.vp!.x, frame.vp!.y, r.w, r.h);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }
    const grabs: Grabbable[] = [];
    renderPanel(panel, index, rows, frame, box, grabs);
    panel.grabs = app.grabbable = grabs;
  }
  gl.disable(gl.SCISSOR_TEST);
  r2d.endFrame();
  r3d.endFrame();
  if (split) drawPanelEdges(dpr);
  usePanel(app.activePanel);

  const gridAnimated =
    panels.some(p => p.mode === '2d') &&
    app.gridFields.some(f => freeVars(f.expr).has('t') || (app.defsAnimated && f.params.length > 0));
  // A state system is never at rest: keep frames coming so it keeps stepping.
  // Streamlines drift downstream even through a field that holds still.
  const streamlinesAnimated = active.some(
    e =>
      panels[panelOf(e)]?.mode === '3d' &&
      e.cpu!.type === 'vfield3d' &&
      e.gpu?.type === 'vfield3d' &&
      e.showStreamlines,
  );
  // Raymarched surfaces refine once they hold still (Renderer3D.drawImplicits).
  const refineIn = r3d.refineIn();
  if (app.refineTimer !== null) clearTimeout(app.refineTimer);
  app.refineTimer = refineIn ? setTimeout(requestRender, refineIn) : null;
  if (
    app.stateSys ||
    gridAnimated ||
    streamlinesAnimated ||
    refineIn === 0 ||
    panels.some(p => p.mode === '3d' && p.spin !== 0) ||
    active.some(e => e.cls!.animated || (app.defsAnimated && e.cls!.params.length > 0))
  ) {
    requestRender();
  }
  app.capture?.afterFrame();

  /** One panel's plots: `rows` are the live rows drawn in it. */
  function renderPanel(
    panel: Panel,
    index: number,
    rows: Equation[],
    frame: Frame,
    box: OverlayBox | undefined,
    grabs: Grabbable[],
  ) {
    if (app.mode === '3d') {
      const scene: Scene3D = { implicits: [], psurfaces: [], curves: [], segments: [], tubes: [], points: [] };
      // A panel drawing its 2D rows on a surface (lib/surface-map.ts): the
      // surface first, then each 2D row painted on it or carried onto it.
      const surface = panelSurface(panel);
      if (surface) scene.psurfaces.push({ ...surfaceGLSL(surface), color: surfaceShade() });
      // Carried dots are kept in x and y too, for hover.
      const dots: SurfaceDot[] = [];
      const carry = (mark: ReturnType<typeof markScene>) => {
        for (const { pos, color, label } of scene.points.slice(mark.points))
          dots.push({ x: pos[0], y: pos[1], color, label });
        carryOntoSurface(scene, mark, surface!, app.camera);
      };
      for (const eq of rows) {
        const on = surface && eq.cls && !eq.cls.needs3D ? surfaceMapping(eq.cls.object) : null;
        if (on === 'paint') {
          let paint = paintOf(eq);
          // gaussian(x, y): shaded to its own size on the surface.
          if (paint?.kind === 'scalar' && eq.cpu?.type === 'scalar2d' && eq.cpu.autoscale)
            paint = {
              ...paint,
              gain: surfaceFieldGain(surface!, eq.cpu, { ...app.constEnv, ...eq.gpu?.uniforms, t: time }),
            };
          if (paint) {
            const { comps, du, dv, xy } = surfaceGLSL(surface!);
            const { params, uniforms } = shaderBindings(eq.gpu);
            (scene.paints ??= []).push({ comps, du, dv, xy, paint, color: rowColor(eq), params, uniforms });
          }
          continue;
        }
        if (SKIPPED_IN_3D.has(eq.cpu!.type) && on !== 'carry') continue;
        const mark = on === 'carry' ? markScene(scene) : null;
        const color = rowColor(eq);
        const plot = eq.cpu!;
        const { params, uniforms } = shaderBindings(eq.gpu);
        // A parametric region's own mesh, carried onto the surface whole;
        // a vector field as arrows along the surface's tangents.
        if (on === 'carry' && plot.type === 'pregion') {
          const mesh = surfaceRegionGLSL(surface!, plot.comps, params);
          if (mesh)
            (scene.paints ??= []).push({
              ...mesh,
              xy: ['u', 'v'],
              paint: REGION_FILL,
              color,
              params,
              uniforms,
              lift: true,
            });
          continue;
        }
        // A geodesic, on its surface already (the worker places its points
        // there, a panel's surface included): lifted a hair toward the eye so
        // the surface does not hide it.
        if (plot.type === 'geodesic') {
          const pts = geodesicFor(eq, { ...app.constEnv, t: time });
          const lifted = towardEye(app.camera);
          const raised = new Float32Array(pts.length);
          for (let k = 0; k + 2 < pts.length; k += 3) raised.set(lifted([pts[k], pts[k + 1], pts[k + 2]]), k);
          if (raised.length >= 6) scene.curves.push({ pts: raised, color });
          continue;
        }
        if (on === 'carry' && plot.type === 'vfield2d') {
          const lifted = towardEye(app.camera);
          const arrows = fieldArrows(surface!, plot.comps, { ...app.constEnv, ...eq.gpu?.uniforms, t: time });
          const pts = new Float32Array(arrows.length);
          for (let k = 0; k + 2 < arrows.length; k += 3) pts.set(lifted(arrows.slice(k, k + 3)), k);
          if (pts.length) scene.curves.push({ pts, color, arrow: true });
          continue;
        }
        switch (plot.type) {
          case 'implicit2d': // extrudes to its true locus (a vertical sheet)
            scene.implicits.push({ field: gpuFor(eq, 'implicit2d').field, color, params, uniforms });
            break;
          case 'implicit3d': {
            const gpu = gpuFor(eq, 'implicit3d');
            // A plane of projective geometry draws translucent, as a plane.
            if (gpu.plane) (scene.planes ??= []).push({ coeffs: gpu.plane, color, params, uniforms });
            else scene.implicits.push({ ...gpu, color, params, uniforms });
            break;
          }
          case 'scalar3d': {
            const env = { ...app.constEnv, t: time };
            // The largest the field has been since the view or a slider last
            // moved: renormalized every frame, a standing wave would never fade.
            const scale = (center: readonly number[], r: number) => {
              const now = fieldScale(plot.expr, env, center, r);
              const key = JSON.stringify([center, r, params.map(p => app.constEnv[p])]);
              const last = volumeScales.get(plot);
              const scale = last?.key === key ? Math.max(last.scale, now) : now;
              volumeScales.set(plot, { key, scale });
              return scale;
            };
            (scene.volumes ??= []).push({ field: gpuFor(eq, 'scalar3d').field, scale, color, params, uniforms });
            break;
          }
          case 'spacecurve': {
            const pts = solveFor(eq, 3, plot.residuals);
            scene.curves.push({ pts: new Float32Array(pts.flat()), color });
            break;
          }
          case 'vfield3d': {
            if (eq.showStreamlines && eq.gpu?.type === 'vfield3d') {
              (scene.streamlines ??= []).push({ comps: gpuFor(eq, 'vfield3d').comps, color, params, uniforms });
              break;
            }
            const pts = solveFor(eq, 3, plot.comps);
            if (eq.showArrows) {
              const flat = pts.flat();
              if (flat.length >= 6) scene.curves.push({ pts: new Float32Array(flat), color, arrow: true });
            } else {
              let path: number[] = [];
              const flush = () => {
                if (path.length >= 6) scene.curves.push({ pts: new Float32Array(path), color, fade: true });
                path = [];
              };
              for (const p of pts) {
                if (p.every(Number.isFinite)) path.push(...p);
                else flush();
              }
              flush();
            }
            break;
          }
          case 'polygon': {
            const dim = plot.dim ?? 2;
            if (plot.hull) {
              let sample = hullSamplers.get(plot);
              if (!sample) {
                sample = hullGeometrySampler(plot.pts, dim, plot.over);
                hullSamplers.set(plot, sample);
              }
              const geometry = sample(app.constEnv, time);
              if (!geometry) break;
              const { mesh, edges } = geometry;
              // On a surface a hull is its outline: a flat fill would cut
              // through the surface rather than lie on it.
              const solid = mesh.indices.length > 0 && on !== 'carry';
              if (solid) scene.tubes.push({ ...mesh, cells: [1, 1], color, retained: true });
              scene.segments.push({
                pts: edges,
                color: solid ? edgeShade(color) : color,
                retained: true,
              });
              break;
            }
            const vals = verticesOf(plot)(app.constEnv, time);
            if (!vals.every(Number.isFinite)) break;
            const pts: number[] = [];
            for (let k = 0; k < vals.length; k += dim) pts.push(vals[k], vals[k + 1], dim === 3 ? vals[k + 2] : 0);
            // A closed polygon fills translucently when a fan from its first
            // vertex covers it exactly: triangles, convex outlines, and the
            // discs and sectors multivectors draw (lib/glyphs.ts).
            // On a surface it is an outline: the fan's flat triangles would
            // be chords under the surface (fill a region with an inequality).
            const fill = plot.closed && on !== 'carry' && fanFillable(pts);
            if (plot.closed) pts.push(...pts.slice(0, 3));
            scene.curves.push({ pts: new Float32Array(pts), color, arrow: plot.arrow, fill });
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
                scene.points.push({ pos: [xs[k], ys[k], z], color, group: eq });
              }
            }
            break;
          }
          case 'plist': {
            const env = { ...app.constEnv, t: time };
            for (const comps of plot.pts) {
              try {
                const p = comps.map(c => evaluate(c, env));
                if (p.every(isFinite)) scene.points.push({ pos: [p[0], p[1], p[2] ?? 0], color, group: eq });
              } catch {
                /* skip unevaluable points */
              }
            }
            break;
          }
          case 'psurface':
          // A filled planar region lies in z = 0 (compileGpu gives it as a surface).
          case 'pregion': {
            const gpu = gpuFor(eq, 'psurface');
            const gain =
              plot.type === 'psurface' && plot.paint ? paintGain(plot, { ...app.constEnv, t: time }) : undefined;
            scene.psurfaces.push({ ...gpu, color, params, uniforms, gain });
            break;
          }
          case 'orbit': {
            let path: number[] = [];
            const flush = () => {
              if (path.length >= 6) scene.curves.push({ pts: new Float32Array(path), color });
              path = [];
            };
            for (const p of orbitFor(eq)) {
              if (p.every(Number.isFinite)) path.push(p[0], p[1], p[2] ?? 0);
              else flush();
            }
            flush();
            break;
          }
          case 'label': {
            const p = samplePoint(eq);
            if (p) (scene.texts ??= []).push({ pos: [p[0], p[1], p[2] ?? 0], text: plot.text, color });
            break;
          }
          case 'trail': {
            scene.curves.push({ pts: new Float32Array(eq.trail!.coordinates(3)), color });
            const p = eq.trail!.head;
            if (p) scene.points.push({ pos: [p[0], p[1], p[2] ?? 0], color, group: eq });
            break;
          }
          case 'pcurve': {
            // Tubes are opt-in through tube(…): a bare curve stays a line, so
            // it never hides points or curves sharing the scene. The radius may
            // use sliders and t; while it evaluates ≤ 0 (say, mid slider drag)
            // the curve draws as a bare line instead of an inside-out tube.
            let radius = 0;
            if (plot.dim === 3 && plot.tube) {
              try {
                const r = evaluate(plot.tube, { ...app.constEnv, t: time });
                if (isFinite(r) && r > 0) radius = r;
              } catch {
                /* unevaluable this frame: draw the bare curve */
              }
            }
            const combs = plot.dim === 3 && (eq.combK || eq.combT);
            const framed = radius > 0 || combs;
            let pts: Float32Array, d1, d2, d3;
            if (plot.dim === 3) {
              [pts, d1, d2, d3] = sampleSpaceCurve([plot.comps, ...(framed ? [plot.d1, plot.d2, plot.d3] : [])]) as [
                Float32Array,
                ...Array<Float32Array | undefined>,
              ];
            } else {
              // A broken path carries extra (NaN) points at its jumps.
              const flat = sampleCurve(eq);
              pts = new Float32Array((flat.length / 2) * 3);
              for (let k = 0; k < flat.length / 2; k++) {
                pts[k * 3] = flat[k * 2];
                pts[k * 3 + 1] = flat[k * 2 + 1];
              }
            }
            if (!framed) {
              scene.curves.push({ pts, color });
              break;
            }
            const fr = curveFrames(pts, d1, d2, d3);
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
                color[0] * 0.45 + 0.25,
                color[1] * 0.45 + 0.25,
                color[2] * 0.45 + 0.25,
              ];
              const comb = buildComb(pts, fr.frenetBinormal, fr.tau, combScale(fr.tau, extent), COMB_STEP);
              scene.segments.push({ pts: comb.teeth, color: tColor });
              scene.curves.push({ pts: comb.tips, color: tColor });
            }
            break;
          }
          case 'point': {
            const p = samplePoint(eq);
            if (p)
              scene.points.push({
                pos: [p[0], p[1], p[2] ?? 0],
                color,
                label: eq.def && writtenName(eq.def.name),
                group: eq,
              });
            break;
          }
          case 'system':
            if (plot.parametric) {
              const pts = solveFor(eq, plot.dim, plot.residuals).flatMap(p => [p[0], p[1], p[2] ?? 0]);
              scene.curves.push({ pts: new Float32Array(pts), color });
              break;
            }
            // Each solution its own group: discrete answers, solid and full
            // size, not a cloud to shade by depth.
            for (const p of solveFor(eq, plot.dim, plot.residuals)) {
              scene.points.push({ pos: [p[0], p[1], p[2] ?? 0], color, group: p });
            }
            break;
        }
        // What a 2D row placed in the plane z = 0, carried onto the surface.
        if (mark) carry(mark);
      }
      // Named points in x and y (`A = (0.5, 1)`) sit on the surface, labelled.
      if (surface)
        for (const eq of equations) {
          if (eq.def?.kind !== 'const' || eq.error || !app.defs.points.has(eq.def.name)) continue;
          if (panelOf(eq) !== index || app.defs.pointDims.get(eq.def.name) !== 2) continue;
          const [cx, cy] = pointComps(eq.def.name);
          const [px, py] = [app.constEnv[cx], app.constEnv[cy]];
          if (!isFinite(px) || !isFinite(py)) continue;
          const mark = markScene(scene);
          scene.points.push({ pos: [px, py, 0], color: baseColor(eq), label: writtenName(eq.def.name), group: eq });
          carry(mark);
          // Dragged along the surface, in x and y (see surfaceAt); not by a
          // slider the surface itself reads, which would move it under the drag.
          const set = defPointWriter(eq, surfaceReads(surface));
          if (set) grabs.push({ key: `def${eq.id}`, x: px, y: py, edits: true, set });
        }
      panel.surfaceDots = dots;
      r3d.render(app.camera, scene, time, app.constEnv, frame);
      drawLabels3D(overlayCtx, app.camera, dpr, scene.points, scene.texts, box, frame.grid !== 'off');
      drawHoverMarker(dpr);
    } else {
      const layers: Required<Layers2D> = {
        levels: [],
        cells: [],
        fractals: [],
        domains: [],
        colors: [],
        conformals: [],
        vfields: [],
        tfields: [],
        ineqs: [],
        projections: [],
        bifs: [],
        scalars: [],
        complexes: [],
        curves: [],
      };
      const extras: Overlay2D = { points: [], polylines: [], bars: [], clouds: [] };
      // A lattice panel's labels: its axes, and the values of the cells in
      // view once they are big enough to print (docs/discrete.md).
      const lattice: LatticeLabels = { axes: panel.lattice?.axes ?? ['x', 'y'], values: [] };
      const printValues = !!panel.lattice && 1 / (app.view.upp * dpr) >= LATTICE_VALUE_PX;
      /** Print the grid's visible cells; `nonzero` skips an automaton's empty ones. */
      const latticeValues = (g: CellGrid, nonzero: boolean) => {
        if (!printValues) return;
        const r = panel.layout.rect;
        const uppY = app.view.upp / (app.view.ratio ?? 1);
        const iLo = Math.floor(app.view.cx - (r.w / 2) * app.view.upp + 0.5);
        const iHi = Math.floor(app.view.cx + (r.w / 2) * app.view.upp + 0.5);
        const kLo = Math.floor(-app.view.cy - (r.h / 2) * uppY + 0.5);
        const kHi = Math.floor(-app.view.cy + (r.h / 2) * uppY + 0.5);
        for (let k = kLo; k <= kHi; k++) {
          const y = k - g.y0;
          if (y < 0 || y >= g.rows) continue;
          for (let i = iLo; i <= iHi; i++) {
            const x = i - g.x0;
            if (x < 0 || x >= g.width) continue;
            const v = g.values[y * g.width + x];
            if (!Number.isFinite(v) || (nonzero && v === 0)) continue;
            const text = Number.isInteger(v) ? String(v) : String(parseFloat(v.toPrecision(3)));
            lattice.values!.push({ i, k, text });
          }
        }
      };
      // Spacing for any level-set family (custom grids, contour stacks): sample
      // |∇c| around the view to convert the target pixel gap into coordinate
      // units (π-based for angles).
      const halfW = (panelW() / 2) * app.view.upp;
      const halfH = (panelH() / 2) * (app.view.upp / (app.view.ratio ?? 1));
      const xmin = app.view.cx - halfW;
      const xmax = app.view.cx + halfW;
      const stemPx = 1 / (app.view.upp * dpr); // CSS px between consecutive whole numbers
      const viewPts: Array<[number, number]> = [
        [app.view.cx, app.view.cy],
        [app.view.cx - halfW / 2, app.view.cy],
        [app.view.cx + halfW / 2, app.view.cy],
        [app.view.cx, app.view.cy - halfH / 2],
        [app.view.cx, app.view.cy + halfH / 2],
      ];
      const env: Record<string, number> = { ...app.constEnv, t: time };
      const seedOf = (a0Name?: string): number => (a0Name !== undefined ? app.constEnv[a0Name] : undefined) ?? 0.5;
      const levelSpacing = (f: CpuGrid) => {
        const cupp = sampleGradMag(f, viewPts, env, app.view.upp * 4, app.view.ratio) * app.view.upp;
        return f.angular ? angularSpacing(cupp, 90) : niceSpacing(cupp, 90);
      };
      // A mapped panel (lib/axis-map.ts) carries what a placing row adds to
      // the overlay, and the points it lets you grab, to its screen.
      const maps = frame.maps;
      const placed = (eq: Equation) => !!maps && !!eq.cls && axisMapping(eq.cls.object, maps) === 'place';
      const since = (eq: Equation) => (placed(eq) ? { overlay: markOverlay(extras), grabs: grabs.length } : null);
      // The screen window, which a plane map's way back is built over.
      const screenBox: ScreenBox = { lo: [xmin, app.view.cy - halfH], hi: [xmax, app.view.cy + halfH] };
      const carry = (mark: ReturnType<typeof since>) => {
        if (!mark || !maps) return;
        mapOverlay(extras, mark.overlay, maps, screenBox);
        const plane = maps.plane;
        for (const g of grabs.splice(mark.grabs)) {
          const [x, y] = plane
            ? planeInverse(plane, screenBox).first(g.x, g.y)
            : [maps.x ? toScreen(maps.x, g.x) : g.x, maps.y ? toScreen(maps.y, g.y) : g.y];
          if (!isFinite(x) || !isFinite(y)) continue;
          const set = g.set;
          grabs.push({
            ...g,
            x,
            y,
            set: plane
              ? (sx, sy) => set(...dragToPlane(plane, sx, sy))
              : (sx, sy) => set(dragTo(maps.x, sx, 0), dragTo(maps.y, sy, 1)),
          });
        }
      };
      for (const eq of rows) {
        const color = rowColor(eq);
        const css = cssColor(color);
        const plot = eq.cpu!;
        const { params, uniforms } = shaderBindings(eq.gpu);
        const mark = since(eq);
        switch (plot.type) {
          case 'implicit2d':
            layers.curves.push({ ...gpuFor(eq, 'implicit2d'), color, params, uniforms });
            if (eq.showLevels && plot.levels) {
              const f = plot.levels;
              const shader = gpuFor(eq, 'implicit2d').levels!;
              const sp = levelSpacing(f);
              layers.levels.push({
                glsl: shader.glsl,
                gradGlsl: shader.gradGlsl,
                params: f.params,
                major: sp.major,
                minor: sp.minor,
                color,
              });
            }
            break;
          case 'ineq2d':
            layers.ineqs.push({ ...gpuFor(eq, 'ineq2d'), color, params, uniforms });
            break;
          case 'projected2d':
            layers.projections.push({ ...gpuFor(eq, 'projected2d'), color, params, uniforms });
            break;
          case 'pregion':
            (extras.regions ??= []).push({ tris: sampleRegion(eq, plot.comps), fill: cssColorA(color, 0.22) });
            break;
          case 'scalar2d': {
            layers.scalars.push({ ...gpuFor(eq, 'scalar2d'), color, params, uniforms });
            break;
          }
          case 'complex2d':
            layers.complexes.push({ ...gpuFor(eq, 'complex2d'), color, params, uniforms });
            break;
          case 'domain2d':
            layers.domains.push({ ...gpuFor(eq, 'domain2d'), color, params, uniforms });
            break;
          case 'rgb2d':
          case 'hsl2d':
          case 'oklch2d':
            layers.colors.push({ ...gpuFor(eq, plot.type), color, params, uniforms });
            break;
          case 'conformal2d':
            layers.conformals.push({ ...gpuFor(eq, 'conformal2d'), color, params, uniforms });
            break;
          case 'fractal2d':
            layers.fractals.push({ ...gpuFor(eq, 'fractal2d'), color, params, uniforms });
            break;
          case 'tfield2d': {
            const gpu = gpuFor(eq, 'tfield2d');
            layers.tfields.push({
              ...gpu,
              color,
              params,
              uniforms,
              streamlines: !!eq.showStreamlines || !!gpu.streamlines,
            });
            break;
          }
          case 'vfield2d': {
            layers.vfields.push({ ...gpuFor(eq, 'vfield2d'), color, params, uniforms });
            app.drops.forEach((d, i) => {
              extras.polylines.push({ pts: integralCurve(plot.comps, d.x, d.y, time), color: css });
              extras.points.push({ x: d.x, y: d.y, color: css, hot: app.hotPoint === `drop${i}` });
            });
            break;
          }
          case 'orbit':
            extras.polylines.push({ pts: orbitFor(eq).flat(), color: css });
            break;
          case 'automaton': {
            const params = (eq.cls?.params ?? []).map(p => env[p]);
            if (plot.dims === 2) {
              // One generation of the board, 8 a second, stepped on from the
              // last. Kept while the rule is the same rule (classification
              // makes a new plan for any edit), and caught up a few dozen
              // generations a frame, so a jump to generation 1000 draws its
              // way there instead of stopping the page.
              const key = JSON.stringify(params);
              const shape = boardShape(plot);
              let c = eq.boardCache;
              if (c?.shape !== shape || c.key !== key) {
                const board = runBoard(plot, env);
                c = eq.boardCache = { shape, key, board, generation: -1, cells: cellsOf(board.grid, BOARD_RUNS) };
              }
              if (eq.cls?.animated) c.board.update(env);
              const target = Math.floor(time * 8) % (BOARD_STEPS + 1);
              const from = target < c.board.generation ? 0 : c.board.generation;
              c.board.advance(Math.min(target, from + BOARD_CATCH_UP));
              if (c.board.generation !== target) requestRender();
              if (c.generation !== c.board.generation) {
                c.generation = c.board.generation;
                c.cells = cellsOf(c.board.grid, BOARD_RUNS);
              }
              layers.cells.push({ ...c.cells, color });
              lattice.status = `generation ${c.generation}`;
              latticeValues(c.board.grid, true);
              break;
            }
            const key = JSON.stringify([...params, eq.cls?.animated ? time : 0]);
            if (eq.cellCache?.plan !== plot || eq.cellCache.key !== key) {
              const grid = runAutomaton(plot, env);
              eq.cellCache = { plan: plot, key, grid, cells: cellsOf(grid, ROW_RUNS) };
            }
            layers.cells.push({ ...eq.cellCache.cells, color });
            latticeValues(eq.cellCache.grid, true);
            break;
          }
          case 'graph': {
            // Evaluated again only when a value it reads changes: a pan
            // redraws the same arrows.
            const params = (eq.cls?.params ?? []).map(p => env[p]);
            const inputs = JSON.stringify([...params, eq.cls?.animated ? time : 0]);
            let c = eq.graphCache;
            if (c?.plan !== plot || c.inputs !== inputs) {
              const edges = c?.plan === plot ? c.edges : edgeEvaluator(plot.edges);
              const data = collectEdges(edges(env));
              const key = JSON.stringify(data);
              // Laid out again only when the graph changes, from where it was.
              c = eq.graphCache =
                c?.key === key
                  ? { ...c, plan: plot, edges, inputs }
                  : { plan: plot, edges, inputs, key, data, pos: layoutGraph(data, c?.pos) };
            }
            const marks = new Set<number>();
            for (const m of rows)
              if (m.mark && m.cpu?.type === 'value')
                try {
                  marks.add(evaluate(m.cpu.expr, env));
                } catch {
                  /* nothing to mark */
                }
            graphOverlay(c.data, c.pos, css, marks, GRAPH_NODE_PX * app.view.upp * dpr, extras);
            break;
          }
          case 'lattice': {
            // Only the cells in the window, which is all a table ever needs.
            const r = panel.layout.rect;
            const uppY = app.view.upp / (app.view.ratio ?? 1);
            const span = (lo: number, hi: number): [number, number] => {
              const [a, b] = [Math.floor(lo + 0.5), Math.floor(hi + 0.5)];
              if (b - a + 1 <= TABLE_MAX) return [a, b - a + 1];
              return [Math.round((lo + hi) / 2) - TABLE_MAX / 2, TABLE_MAX];
            };
            const [i0, iw] = span(app.view.cx - (r.w / 2) * app.view.upp, app.view.cx + (r.w / 2) * app.view.upp);
            const [k0, kh] = span(-app.view.cy - (r.h / 2) * uppY, -app.view.cy + (r.h / 2) * uppY);
            const params = (eq.cls?.params ?? []).map(p => env[p]);
            const key = JSON.stringify([i0, iw, k0, kh, ...params, eq.cls?.animated ? time : 0]);
            if (eq.tableCache?.plan !== plot || eq.tableCache.key !== key) {
              const grid = evalTable(plot, env, i0, k0, iw, kh);
              eq.tableCache = {
                plan: plot,
                key,
                grid,
                cells: cellsOf(grid, { x: false, y: false }, tableShades(grid)),
              };
            }
            layers.cells.push({ ...eq.tableCache.cells, color });
            latticeValues(eq.tableCache.grid, false);
            break;
          }
          case 'label': {
            const p = samplePoint(eq);
            if (p) (extras.texts ??= []).push({ x: p[0], y: p[1], text: plot.text, color: css });
            break;
          }
          case 'trail': {
            extras.polylines.push({ pts: eq.trail!.coordinates(2), color: css });
            const p = eq.trail!.head;
            if (p) extras.points.push({ x: p[0], y: p[1], color: css });
            break;
          }
          case 'pcurve':
            extras.polylines.push({ pts: sampleCurve(eq), color: css });
            break;
          case 'polygon': {
            let pts: number[];
            try {
              pts = verticesOf(plot)(env);
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
            extras.points.push({ x: p[0], y: p[1], color: css, hot: app.hotPoint === key });
            const set = pointWriter(eq);
            if (set) grabs.push({ key, x: p[0], y: p[1], edits: true, set });
            break;
          }
          case 'vlist': {
            // Numbers on the number line, copies stacked (lib/plot.ts dotPlot).
            const values = plot.values.map(expr => {
              try {
                return evaluate(expr, env);
              } catch {
                return NaN;
              }
            });
            if (values.length > CLOUD_MIN) {
              extras.clouds!.push({ ...columnStacks(plot, values, CLOUD_DOT_PX), color: css });
              break;
            }
            const { xs, ys } = columnStacks(plot, values, POINT_DOT_PX);
            for (let k = 0; k < xs.length; k++) extras.points.push({ x: xs[k], y: ys[k], color: css, r: 4 });
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
              } catch {
                /* skip unevaluable points */
              }
            }
            break;
          }
          // Typed-array lists: nothing to evaluate, so the only question is how
          // to draw them. Few enough to read as individual points, and they go
          // through the same path as any other point (outlines); past that
          // they are a cloud, drawn in bulk, stacked in dot-wide columns.
          case 'dlist': {
            const { values } = plot;
            if (values.length <= CLOUD_MIN) {
              const { xs, ys } = columnStacks(values, values, POINT_DOT_PX);
              for (let k = 0; k < xs.length; k++) extras.points.push({ x: xs[k], y: ys[k], color: css, r: 4 });
              break;
            }
            extras.clouds!.push({ ...columnStacks(values, values, CLOUD_DOT_PX), color: css });
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
              try {
                return evaluate(plot.term, env);
              } catch {
                return undefined;
              }
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
                if (isFinite(v)) {
                  sum += v;
                  started = true;
                }
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
            const dLo = Math.max(xmin, app.view.cy - halfH);
            const dHi = Math.min(xmax, app.view.cy + halfH);
            if (dHi > dLo) {
              // y = x, the guide the orbit reflects off; kept lighter than the axes.
              extras.polylines.push({ pts: [dLo, dLo, dHi, dHi], color: cssColorA(theme.axis, 0.45), width: 1 });
            }
            const pts: number[] = [seed, seed];
            let a = seed;
            for (let k = 0; k < 80; k++) {
              env[plot.recVar] = a;
              let b: number;
              try {
                b = evaluate(plot.f, env);
              } catch {
                break;
              }
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
            layers.bifs.push({
              field: gpuFor(eq, 'bifurcation').field,
              color,
              params,
              uniforms: { uSeed: seedOf(plot.a0Name) },
            });
            break;
          case 'density': {
            let c: DensityCurve | null = null;
            try {
              c = rvSys.curve(plot.rv, env, { lo: xmin, hi: xmax });
              if (c && plot.mass) c = scaleCurve(c, evaluate(plot.mass, env));
            } catch {
              break; /* a parameter is missing this frame */
            }
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
            if (key !== c.key || c.maps !== maps) {
              c.key = key;
              c.maps = maps;
              // On mapped axes, in the panel's screen coordinates already.
              c.runs = shadeRuns(plot.shade, env, xmin, xmax, c.sampler, maps);
            }
            const minus = minusTint(color);
            const zero = maps?.y ? toScreenOrEdge(maps.y, 0) : 0;
            for (const run of c.runs) {
              // Only real edges are stroked: not where the window cut the range.
              const tint = run.sign > 0 ? color : minus;
              const { fill, stroke } = runPaths(run, app.view.cy - halfH, app.view.cy + halfH, zero);
              extras.polylines.push({
                pts: fill,
                color: cssColor(tint),
                closed: true,
                fill: cssColorA(tint, 0.16),
                noStroke: true,
              });
              extras.polylines.push({ pts: stroke, color: cssColor(tint) });
            }
            break;
          }
          case 'pmf': {
            // Stems at the atoms in view — whole numbers for a declared law,
            // wherever g put them for a derived one; lib caches them per window.
            try {
              const mass = plot.mass ? evaluate(plot.mass, env) : 1;
              for (const run of rvSys.pmfRuns(plot.rv, env, { lo: xmin, hi: xmax }) ?? []) {
                pushStems(extras, scaleStems(run, mass), color, false, stemPx);
              }
            } catch {
              /* a parameter is missing this frame */
            }
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
            } catch {
              /* not evaluable this frame */
            }
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
            } catch {
              /* not evaluable this frame */
            }
            break;
          }
          case 'system':
            // A 3-unknown system forces the 3D view, so only 2D lands here.
            if (plot.dim === 2) {
              const points = solveFor(eq, 2, plot.residuals);
              if (plot.parametric) {
                extras.polylines.push({ pts: points.flat(), color: css });
                break;
              }
              // A real system's solutions are on the screen of a mapped
              // panel, and a coordinate writer reads x and y: no drag there. A
              // complex one's are in x and y, carried there like any point.
              const set = maps && !plot.complexEquation ? null : coordinatePointWriter(eq, plot.coordinates);
              points.forEach((p, i) => {
                const key = `sys${eq.id}:${i}`;
                extras.points.push({
                  x: p[0],
                  y: p[1],
                  color: css,
                  hot: app.hotPoint === key,
                  label: complexRootLabel(plot.complexEquation, p, env),
                });
                if (set) grabs.push({ key, x: p[0], y: p[1], edits: true, set });
              });
            }
            break;
        }
        carry(mark);
      }
      // Named points (`A = (0, 0)` rows) draw labeled with their name, in the
      // panel their row is in; rows whose components are plain numbers or
      // slider names can be dragged.
      for (const eq of equations) {
        if (eq.def?.kind !== 'const' || eq.error || !app.defs.points.has(eq.def.name)) continue;
        if (panelOf(eq) !== index) continue;
        const [cx, cy] = pointComps(eq.def.name);
        const px = app.constEnv[cx];
        const py = app.constEnv[cy];
        if (!isFinite(px) || !isFinite(py)) continue;
        const key = `def${eq.id}`;
        const mark = maps ? { overlay: markOverlay(extras), grabs: grabs.length } : null;
        extras.points.push({
          x: px,
          y: py,
          color: cssColor(baseColor(eq)),
          hot: app.hotPoint === key,
          label: writtenName(eq.def.name),
        });
        const set = defPointWriter(eq);
        if (set) grabs.push({ key, x: px, y: py, edits: true, set });
        carry(mark);
      }
      // A seed is one grabbable point however many fields trace a curve from it.
      if (layers.vfields.length) {
        app.drops.forEach((d, i) =>
          grabs.push({
            key: `drop${i}`,
            x: d.x,
            y: d.y,
            edits: false,
            set: (x, y) => {
              d.x = x;
              d.y = y;
            },
          }),
        );
      }
      let gridSpecs: GridSpec[] | undefined;
      // Coordinate fields are written in x and y, not a mapped panel's screen
      // coordinates: a panel with its axes mapped grids them at their ticks
      // instead, and one with a plane map draws them through it, x and y too.
      const plane = frame.maps?.plane;
      const families =
        frame.grid === 'on' && (!frame.maps || plane)
          ? panelGridFields(panel, plane).map(f => (plane ? planeGridField(f, plane) : f))
          : [];
      if (families.length) {
        gridSpecs = families.map(f => {
          if (f === 'x' || f === 'y') {
            const sp = niceSpacing(f === 'x' ? app.view.upp : app.view.upp / (app.view.ratio ?? 1), 90);
            const gradGlsl: [string, string] = f === 'x' ? ['1.0', '0.0'] : ['0.0', '1.0'];
            return { glsl: f, gradGlsl, params: [], major: sp.major, minor: sp.minor };
          }
          const sp = levelSpacing(f);
          return { glsl: f.glsl, gradGlsl: f.gradGlsl, params: f.params, major: sp.major, minor: sp.minor };
        });
      }
      r2d.render(app.view, layers, time, app.constEnv, gridSpecs, frame);
      drawLabels2D(
        overlayCtx,
        app.view,
        dpr,
        extras,
        frame.grid !== 'off' && !gridSpecs,
        box,
        panel.lattice ? lattice : undefined,
        frame.maps,
      );
      drawHoverMarker(dpr);
    }
  }
}

/** Hairlines between tiled panels, and a frame round each inset. */
function drawPanelEdges(dpr: number) {
  const ctx = overlayCtx;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.lineWidth = 1;
  for (const p of panels) {
    const { x, y, w, h } = p.layout.rect;
    const [l, t, pw, ph] = [x / dpr, y / dpr, w / dpr, h / dpr];
    ctx.strokeStyle = cssColorA(theme.axis, p.layout.inset ? 0.55 : 0.35);
    ctx.beginPath();
    if (p.layout.inset) ctx.rect(Math.round(l) + 0.5, Math.round(t) + 0.5, Math.round(pw) - 1, Math.round(ph) - 1);
    else {
      // Every shared edge is some panel's left or top.
      const ex = Math.round(l) + 0.5;
      const ey = Math.round(t) + 0.5;
      if (x > 0) {
        ctx.moveTo(ex, t);
        ctx.lineTo(ex, t + ph);
      }
      if (y > 0) {
        ctx.moveTo(l, ey);
        ctx.lineTo(l + pw, ey);
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}
