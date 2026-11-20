/**
 * The equation editor: the document the user types, and the boot that wires
 * it to the session and the scene.
 */
import { app } from './app-state.ts';
import {
  equations,
  resetState,
  rvSys,
  cloudPoints,
  CLOUD_3D_MAX,
  panels,
  requestRender,
  type Equation,
  graphTime,
  type SliderUI,
  type CurveUI,
  type TableUI,
  cssColor,
  currentConstEnv,
  type Grabbable,
  panelClientRect,
  canvas,
  type Panel,
  withPanel,
  panelOf,
  panelW,
  panelH,
  panelAtClient,
  overlayCtx,
  activate,
  MAX_DROPS,
  resize,
  overlay,
  restartGraphClock,
  setGraphVisible,
  r3d,
  cancelRender,
  gl,
} from './session.ts';
import {
  embedded,
  traceQueue,
  solvedOnScreen,
  baseColor,
  resetViewport,
  panelMaps,
  panelSurface,
  scheduleViewportWriteback,
  ensureViewRow,
  flushViewportWriteback,
  framed,
  mcpApp,
  render,
} from './scene.ts';
import { boundIn, evaluateFrame } from '../lib/env.ts';
import { compileGridCpu, compileGridGpu, compileCpu } from '../lib/compiler.ts';
import { isViewportText, prepareDocument, analyzePrepared } from '../lib/analysis.ts';
import { runtimeSliderNames } from '../lib/runtime-sliders.ts';
import { initHighlight } from './highlight.ts';
import { initSyntaxHelp } from './syntax-help.ts';
import { attachCapture } from './capture.ts';
import { nextFeatured } from '../lib/featured.ts';
import { declaredNames } from '../lib/regression.ts';
import {
  constsAnimated,
  type Definition,
  formatTableRow,
  freeTableName,
  scanDefinition,
  TABLE_MAX_ROWS,
  definitionDependencies,
  definitionHead,
} from '../lib/defs.ts';
import { dragAxes, coordinateDragWriter } from '../lib/drag.ts';
import { type SliderForm, sliderForm, sliderValue, sliderBounds, writeSlider, withBounds } from '../lib/slider.ts';
import { type Expr, freeVars, parseExpr, substVars, evaluate, canonicalName } from '../lib/expr.ts';
import { typedEscape } from '../lib/escapes.ts';
import { encodePayload, decodePayload } from '../lib/link.ts';
import { type Classified, valueReadout } from '../lib/plot.ts';
import { type SpecialPoint, mappedSpecialPoints, specialPoints, curveTracer, fmtTraced } from '../lib/special.ts';
import { stripNote, keepNote, noteStart, noteColor, splitStatements } from '../lib/statements.ts';
import { scaleViewAt, clampPhi } from '../lib/view.ts';
import { type AxisMap, toWorld } from '../lib/axis-map.ts';
import {
  type PlaneMap,
  planeToWorld,
  pixelSpan,
  type ScreenBox,
  planeWorldBox,
  planeInverse,
} from '../lib/plane-map.ts';
import { tableNameFor, type Table } from '../lib/csv.ts';
import { shortHash } from '../lib/hash.ts';
import { lookup as lookupFile, loadRefs, ingest, listFiles, removeFile } from './filestore.ts';
import { panelIndices } from '../lib/panels.ts';
import { type View2D, niceSpacing } from './render2d.ts';
import { type Camera3D, cameraMatrices, projectToScreen } from './render3d.ts';
import { assignColors, takesColor } from '../lib/palette.ts';
import { type SurfaceMap, surfacePoint, surfaceMapping } from '../lib/surface-map.ts';
import { raySurface, surfacePixel, onSurface } from '../lib/surface-pick.ts';
import { initPanelResize } from './panel-resize.ts';
import { initPanelSwipe } from './panel-swipe.ts';
import { theme, initTheme, onThemeChange, toggleTheme } from './theme.ts';

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
/** The document's shadowed names (shadowedNames), for the app's own parses
 *  of its rows: a slider's bounds, a surface's reads. */
let valueNames: ReadonlySet<string> = new Set();

function resetEditedTrails() {
  // Framing and comment edits preserve trails; changing the math starts a
  // fresh observation so unrelated runs never get joined by a false segment.
  const mathText = equations
    .map(eq => stripNote(eq.text).trim())
    .filter(text => text && !text.startsWith('#') && !isViewportText(text))
    .join('\n');
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
    eq.tracer = undefined;
    eq.traceTarget = undefined;
  }
  spGen++; // queued hover recomputes predate this change: drop them
  spQueue.clear();
  setHover(null);
}

/** Rebuild definitions and plots after edits that may change their structure. */
export function recompileAll() {
  resetEditedTrails();
  // Preparation is independent of the running simulation and sampler. Keep
  // their caller-owned state across edits whose state-system key is unchanged.
  const prepared = prepareDocument(
    equations.map(({ id, text }) => ({ id, text })),
    {
      tables: ref => lookupFile(ref.file, ref.hash)?.table ?? null,
    },
  );
  app.defs = prepared.defs;
  app.repaintHighlights();
  ensureTables(prepared.raw);
  app.sumBoundNames = prepared.sumBoundConsts;
  valueNames = prepared.valueNames;
  const wasKey = app.stateSys?.key;
  app.stateSys = prepared.stateSystem;
  if (app.stateSys?.key !== wasKey) resetState();

  const analysis = analyzePrepared(prepared, {
    stateValues: app.stateVals,
    rvs: rvSys,
    readoutPolicy: 'static',
  });
  app.runtimeSliders = runtimeSliderNames(analysis);
  app.gridFields = analysis.gridFields.map(spec => ({ ...compileGridCpu(spec), ...compileGridGpu(spec) }));
  app.wholeParamNames = rvSys.wholeParamNames();
  for (let i = 0; i < equations.length; i++) {
    const eq = equations[i],
      row = analysis.rows[i];
    eq.cls = row.cls;
    eq.cpu = row.cpu;
    eq.gpu = row.gpu;
    eq.error = row.error ?? row.dataLocal;
    eq.needsFile = row.needsFile || !!row.dataLocal;
    eq.info = row.info;
    eq.note = row.note;
    eq.def = row.def;
    eq.viewSpec = row.view;
    eq.comment = row.comment;
    eq.dist = row.dist;
    eq.mark = row.mark;
    if (!eq.comment) eq.collapsed = undefined;

    // Cloud capacity is a browser renderer limit, independent of analysis.
    const plot = eq.cpu;
    if (
      !eq.error &&
      plot &&
      (plot.type === 'dscatter' || plot.type === 'plist') &&
      plot.dim === 3 &&
      cloudPoints(plot) > CLOUD_3D_MAX
    ) {
      eq.error =
        `A 3D cloud draws at most ${CLOUD_3D_MAX} points;` +
        ` that is ${cloudPoints(plot)}.` +
        ' Filter it first, or plot two of the columns.';
    }
  }
  app.defsAnimated = constsAnimated(app.defs) || app.defs.states.size > 0;
  const rowPanels = panelIndices(equations.map(e => ({ view: e.viewSpec })));
  app.gridFieldPanels = new Map();
  equations.forEach((eq, i) => {
    eq.panel = rowPanels[i];
    if (eq.def && !app.gridFieldPanels.has(eq.def.name)) app.gridFieldPanels.set(eq.def.name, eq.panel);
  });
  // …and a 2D cloud costs the same once ANYTHING makes its panel 3D: the
  // renderer sends every scatter through the sprite path there, z = 0 and
  // all, so a 200 000-point CSV beside one `z = …` row is 200 000 projected,
  // depth-sorted sprites. Whether a panel is 3D is only known once every
  // row has classified, which is why this waits for the loop to finish.
  const panels3D = new Set(
    equations.filter(e => !e.error && (e.cls?.needs3D || e.viewSpec?.kind === 'surface')).map(e => e.panel),
  );
  for (const eq of equations) {
    if (!eq.cls || eq.error || !panels3D.has(eq.panel)) continue;
    const points = cloudPoints(eq.cpu!);
    if (points <= CLOUD_3D_MAX) continue;
    eq.cls = undefined;
    eq.error =
      `This ${panels.length > 1 ? 'panel' : 'graph'} is 3D, where every point is a sprite: at most ${CLOUD_3D_MAX},` +
      ` and this row has ${points}. Filter it, or drop the row that uses z.`;
  }
  // New rows are created uncolored and colored here, once the whole document
  // is known and classified: only rows that show a color use up a slot.
  assignColors(
    equations,
    equations.map(eq =>
      takesColor({
        text: eq.text,
        comment: eq.comment,
        def: eq.def,
        point: eq.def?.kind === 'const' && app.defs.points.has(eq.def.name),
        view: eq.viewSpec,
        cpu: eq.cpu,
      }),
    ),
    theme.palette.length,
  );
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
    .catch(() => {
      tableLoad = null;
    });
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
    const text = keepNote(eq.text, formatTableRow(d.name, d.file, f.hash));
    if (text === eq.text.trim()) continue;
    eq.text = text;
    // Write the line through the way a slider drag does, so the pin does not
    // need a full re-render of the list to become visible.
    if (lines[i]) setLineText(lines[i], text);
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
  return freeTableName(
    base,
    new Set(
      equations.map(eq => eq.def?.name ?? scanDefinition(stripNote(eq.text))?.name).filter((n): n is string => !!n),
    ),
  );
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
      const text = keepNote(eq.text, formatTableRow(d.name, d.file, loaded.hash));
      if (text !== eq.text.trim()) eq.text = text;
    }
    if (pinnedElsewhere) {
      added.push(
        `${loaded.file}: ${pinnedElsewhere} row${pinnedElsewhere === 1 ? '' : 's'}` +
          ' pinned to other bytes kept — delete the hash there to use this file',
      );
    }
    // Whether the bytes survive a reload is the same news on either path, and
    // it matters most on this one: a drop that answers "the file is not on
    // this device" would have to answer it again after every reload.
    const fragile = loaded.durable ? '' : ' (this browser is not storing files — it will be gone on reload)';
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
  noticeEl ??= document.body.appendChild(
    Object.assign(document.createElement('div'), {
      className: 'notice',
      role: 'status',
    }),
  );
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
    app.graphChanged?.(equations.map(e => e.text));
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

export function saveUrl() {
  app.graphEdited?.();
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

export function addEquation(text: string, at = equations.length): Equation {
  const eq: Equation = { id: app.nextId++, text, colorIndex: -1 };
  equations.splice(at, 0, eq);
  return eq;
}

const fmtNum = (v: number) => String(parseFloat(v.toPrecision(6)));

/** The slider a row's definition makes (lib/slider.ts), if any. */
function sliderOf(eq: Equation): { def: NonNullable<Equation['def']>; rhs: string; form: SliderForm } | null {
  const def = eq.def;
  // (A binder, p ∈ A, draws from its right side: no slider to drag.)
  if ((def?.kind !== 'const' && def?.kind !== 'init') || eq.error || (def.kind === 'const' && def.draw)) return null;
  const rhs = def.rhs.trim();
  const form = sliderForm(rhs, new Set(app.defs.fns.keys()));
  return form ? { def, rhs, form } : null;
}

/** Whether a slider only takes whole numbers: Σ/Π bounds step whole terms,
 *  the n of Binomial(n, p) has no fractional value, and neither does a
 *  constant written round(…). */
function sliderWhole(eq: Equation): boolean {
  const slider = sliderOf(eq);
  if (!slider) return false;
  const { name } = slider.def;
  return !!slider.form.whole || app.sumBoundNames.has(name) || app.wholeParamNames.has(name);
}

/** The constants now, for a slider range whose ends use them: render()'s
 *  constEnv may not have run yet, and must not advance the states here. */
function sliderEnv(): Record<string, number> {
  try {
    return evaluateFrame(app.defs, graphTime(), app.stateVals);
  } catch {
    return { ...app.stateVals };
  }
}

/** The row text with the slider moved to `v`: held to its range and step,
 *  written into its literal. Returns the value it holds. */
function moveSlider(eq: Equation, v: number): { text: string; rhs: string; value: number } | null {
  const slider = sliderOf(eq);
  if (!slider) return null;
  const { def, form } = slider;
  const value = sliderValue(form, v, sliderBounds(form, sliderEnv(), new Set(app.defs.fns.keys()), valueNames));
  const rhs = writeSlider(slider.rhs, form, fmtNum(value));
  return { text: `${definitionHead(def, stripNote(eq.text))} ${rhs}`, rhs, value: Number(fmtNum(value)) };
}

export const lineEls = (): HTMLElement[] =>
  [...listEl.children].filter((el): el is HTMLElement => el.classList.contains('eq-line'));

/**
 * Write a row's text into its line. A trailing `# note` goes in its own span,
 * which the stylesheet sets on the next visual line in a smaller prose face;
 * it is still the line's text, so caret offsets, copy and undo see one row.
 */
export function setLineText(line: HTMLElement, text: string) {
  const at = noteStart(text);
  if (at < 0) {
    line.textContent = text;
    return;
  }
  const note = document.createElement('span');
  note.className = 'eq-note';
  note.textContent = text.slice(at);
  line.replaceChildren(text.slice(0, at), note);
}

/** Whether the line's DOM already has the shape setLineText gives `text`. */
function lineShaped(line: HTMLElement, text: string): boolean {
  const note = line.querySelector('.eq-note');
  const at = noteStart(text);
  if (at < 0) return !note;
  return note !== null && line.lastChild === note && note.textContent === text.slice(at);
}

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
function setSelectionSpan(start: { line: number; offset: number }, end: { line: number; offset: number }) {
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
  /** Each panel's window, in panel order. */
  views: View2D[];
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
    views: panels.map(p => ({ ...p.view })),
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
export function pushUndo(key: string | null, caret: Snapshot['caret'] = caretPos()) {
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
  s.views.forEach((v, i) => {
    const p = panels[i];
    if (!p) return;
    Object.assign(p.view, { ratio: 1 }, v);
    p.appliedViewText = null;
  });
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

/** Moves a slider row to `v` (held to its range and step) the way dragging
 *  it does: one coalesced undo entry per gesture (none when `undo` is false:
 *  the caller made one), no plot recompile when the constant is a runtime
 *  uniform. Returns the value it holds, or null for a row that is not a slider. */
function setSlider(eq: Equation, v: number, undo = true): number | null {
  const kind = eq.def?.kind;
  const moved = moveSlider(eq, v);
  if (!moved || (kind !== 'const' && kind !== 'init')) return null;
  if (undo) pushUndo(`slider:${eq.id}`);
  const lhs = eq.def!.name;
  eq.text = keepNote(eq.text, moved.text);
  const line = lineEls()[equations.indexOf(eq)];
  if (line) setLineText(line, eq.text);
  if (kind === 'const' && app.runtimeSliders.has(lhs) && !equations.some(row => row.error || row.needsFile)) {
    // The literal was written within the range and step, so it is the value.
    app.defs.drop(lhs);
    app.defs.bind(lhs, { tag: 'scalar', role: 'const', expr: { kind: 'num', value: moved.value } });
    eq.def = { kind: 'const', name: lhs, rhs: moved.rhs };
    // Match a math edit's invalidation without discarding compiled plots,
    // their samplers, or GPU buffers.
    resetEditedTrails();
    invalidateDerivedState();
  } else recompileAll();
  reconcile();
  saveUrl();
  requestRender();
  return moved.value;
}

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
    setSlider(eq, Number(range.value));
  });
  // A drag is one undo entry: coalesced while it lasts, sealed on release.
  range.addEventListener('change', () => {
    coalesce = null;
  });
  // Typed ends become the row's own clamp(…, lo, hi), so the range travels
  // in the link with everything else.
  const onBound = () => {
    const lo = Number(min.value);
    const hi = Number(max.value);
    const slider = sliderOf(eq);
    if (slider && min.value.trim() && max.value.trim() && isFinite(lo) && isFinite(hi) && hi > lo) {
      pushUndo(`bounds:${eq.id}`);
      const { def, rhs, form } = slider;
      eq.text = `${definitionHead(def, stripNote(eq.text))} ${withBounds(rhs, form, fmtNum(lo), fmtNum(hi))}`;
      const line = lineEls()[equations.indexOf(eq)];
      if (line) line.textContent = eq.text;
      recompileAll();
      saveUrl();
      requestRender();
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

type RowToggle = { label: string; title: string; on: boolean; flip: () => void };

/**
 * The display toggles a row offers, if any. Read at click time as well as on
 * reconcile, so the button elements follow the row as its plot type changes.
 */
function rowToggles(eq: Equation): RowToggle[] {
  const one = rowToggle(eq);
  if (eq.cpu?.type !== 'vfield3d') return one ? [one] : [];
  // Trajectories unless one of these is on; they exclude each other.
  const retrace = () => {
    eq.sysCache = undefined;
    eq.traceTarget = undefined;
    traceQueue.cancelPending(eq.id);
  };
  const streamlines: RowToggle[] =
    eq.gpu?.type !== 'vfield3d'
      ? []
      : [
          {
            label: 'streamlines',
            title: 'Fill space with short streamlines drifting along the field',
            on: !!eq.showStreamlines,
            flip: () => {
              eq.showStreamlines = !eq.showStreamlines;
              eq.showArrows = false;
              retrace();
            },
          },
        ];
  return [
    ...streamlines,
    {
      label: 'arrows',
      title: 'Show a lattice of direction arrows',
      on: !!eq.showArrows,
      flip: () => {
        eq.showArrows = !eq.showArrows;
        eq.showStreamlines = false;
        retrace();
      },
    },
  ];
}

function rowToggle(eq: Equation): RowToggle | null {
  // On a mapped panel a real system is solved rewritten in screen
  // coordinates (lib/axis-map.ts): a certificate there would prove roots in those.
  const mapped = solvedOnScreen(eq);
  if (eq.cpu?.type === 'system' && !eq.cpu!.parametric && !eq.cpu!.angular?.some(Boolean) && !mapped)
    return {
      label: 'certify search box',
      title: 'Prove roots and completeness in the bounded search box; unsupported functions remain unresolved',
      on: !!eq.certify,
      flip: () => {
        eq.certify = !eq.certify;
        eq.info = eq.certify ? 'Certifying search box…' : undefined;
        eq.sysCache = undefined;
        eq.traceTarget = undefined;
        traceQueue.cancelPending(eq.id);
      },
    };
  switch (eq.cpu?.type) {
    case 'sequence':
      return {
        label: 'Σ partial sums',
        title: 'Plot the partial sums S_N = Σ aₙ instead of the terms',
        on: !!eq.partialSum,
        flip: () => {
          eq.partialSum = !eq.partialSum;
        },
      };
    case 'tfield2d':
      // streamlines(M) asks for them in the text; nothing to toggle.
      if (eq.gpu?.type === 'tfield2d' && eq.gpu.streamlines) return null;
      return {
        label: 'streamlines',
        title: 'Trace the major eigenvector of the symmetric part instead of drawing glyphs',
        on: !!eq.showStreamlines,
        flip: () => {
          eq.showStreamlines = !eq.showStreamlines;
        },
      };
    default:
      return null;
  }
}

function makeToggles(): { box: HTMLElement; btns: HTMLButtonElement[] } {
  const box = document.createElement('div');
  box.className = 'eq-widget eq-toggles';
  box.contentEditable = 'false';
  return { box, btns: [] };
}

/** Button k of a row's toggles, created on first use. */
function toggleButton(eq: Equation, ui: { box: HTMLElement; btns: HTMLButtonElement[] }, k: number): HTMLButtonElement {
  let btn = ui.btns[k];
  if (!btn) {
    btn = document.createElement('button');
    btn.className = 'eq-toggle';
    btn.addEventListener('click', () => {
      const t = rowToggles(eq)[k];
      if (!t) return;
      t.flip();
      reconcile();
      requestRender();
    });
    ui.btns[k] = btn;
  }
  return btn;
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
export function reconcile() {
  if (stateResetBtn) stateResetBtn.hidden = !app.stateSys;
  const lines = lineEls();
  lines.forEach((line, i) => {
    const eq = equations[i];
    if (!eq) return;
    line.dataset.id = String(eq.id);
    // A row with no palette slot (blank, a view row) keeps the dot's neutral grey.
    if (eq.colorIndex < 0 && !noteColor(eq.text)) line.style.removeProperty('--eq-color');
    else line.style.setProperty('--eq-color', cssColor(baseColor(eq)));
    line.classList.toggle('invalid', !!eq.error);
    // No colour swatch for rows with nothing drawn in it: definitions, and
    // value rows, whose whole output is the readout beneath them — except a
    // definite integral shading its area, which draws in that colour.
    const drawn = eq.error ? undefined : eq.cpu;
    const structure = eq.viewSpec?.kind === 'split' || eq.viewSpec?.kind === 'grid';
    line.classList.toggle(
      'is-def',
      !!eq.def || structure || (drawn?.type === 'value' && !drawn.shade) || drawn?.type === 'note',
    );
    line.classList.toggle('is-divider', eq.viewSpec?.kind === 'split');
    line.classList.toggle('is-view', !!eq.viewSpec && eq.viewSpec.kind !== 'split');
    line.classList.toggle('is-comment', !!eq.comment);
    line.classList.toggle('collapsed', !!(eq.comment && eq.collapsed));
    line.title = eq.error ?? (eq.comment ? 'Click the arrow to collapse or expand this group' : '');
    if (equations.length === 1 && !eq.text.trim()) line.dataset.ph = 'add an equation…';
    else delete line.dataset.ph;

    const wanted: HTMLElement[] = [];
    // Initial values get a slider too: dragging one relaunches the system
    // from there, which is the whole point of `a(0)` in a chaotic system.
    const slider = sliderOf(eq);
    if (slider) {
      const { form } = slider;
      eq.sliderUI ??= makeSlider(eq);
      const { min, range, max } = eq.sliderUI;
      const bounds = sliderBounds(form, sliderEnv(), new Set(app.defs.fns.keys()), valueNames);
      let v = form.literal;
      let lo: number, hi: number;
      if (bounds) {
        [lo, hi] = bounds;
        v = sliderValue(form, v, bounds);
      } else {
        // No written range: one that fits the value, widened as it grows.
        if (eq.sliderMin === undefined || eq.sliderMax === undefined) {
          eq.sliderMin = Math.min(-10, Math.floor(v));
          eq.sliderMax = Math.max(10, Math.ceil(v));
        }
        if (v < eq.sliderMin) eq.sliderMin = v;
        if (v > eq.sliderMax) eq.sliderMax = v;
        lo = eq.sliderMin;
        hi = eq.sliderMax;
      }
      if (document.activeElement !== min) min.value = fmtNum(lo);
      if (document.activeElement !== max) max.value = fmtNum(hi);
      range.min = String(lo);
      range.max = String(hi);
      // Whole-number sliders step one at a time; otherwise a round step
      // (1, 2 or 5 × 10^k), so round values sit on it.
      range.step = sliderWhole(eq) ? '1' : String(niceSpacing((hi - lo) / 400, 1).major);
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
    const toggles = rowToggles(eq);
    if (toggles.length) {
      const ui = (eq.toggleUI ??= makeToggles());
      const btns = toggles.map((toggle, k) => {
        const btn = toggleButton(eq, ui, k);
        btn.textContent = toggle.label;
        btn.title = toggle.title;
        btn.classList.toggle('on', toggle.on);
        return btn;
      });
      // Only when the set changes: re-inserting would drop hover and focus.
      if (btns.length !== ui.box.children.length || btns.some((b, k) => ui.box.children[k] !== b))
        ui.box.replaceChildren(...btns);
      wanted.push(ui.box);
    }
    // A data row's readout is the handle on a preview of the file itself:
    // the summary says what was parsed, opening it shows the first rows.
    const table = eq.def && !eq.error ? app.defs.tables.get(eq.def.name) : undefined;
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
    while (
      ref.nextSibling &&
      !(ref.nextSibling instanceof HTMLElement && ref.nextSibling.classList.contains('eq-line'))
    ) {
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
export function renderAll() {
  listEl.textContent = '';
  for (const eq of equations) {
    const line = document.createElement('div');
    line.className = 'eq-line';
    line.dataset.id = String(eq.id);
    if (eq.text) setLineText(line, eq.text);
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
      eq = { id: app.nextId++, text: '', colorIndex: -1 };
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
 * After a native edit, rebuild only the lines whose note span no longer
 * matches their text — typing or deleting a `#` moves a note onto or off its
 * own line — keeping the selection where it was by character position.
 */
function reshapeLines() {
  const lines = lineEls();
  let span: ReturnType<typeof selectionSpan> | undefined;
  lines.forEach((line, i) => {
    const eq = equations[i];
    if (!eq || lineShaped(line, eq.text)) return;
    span ??= selectionSpan();
    setLineText(line, eq.text);
  });
  if (span) setSelectionSpan(span.start, span.end);
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
  return a.line < b.line || (a.line === b.line && a.offset <= b.offset) ? { start: a, end: b } : { start: b, end: a };
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
  const texts = [before + parts[0], ...parts.slice(1).map(p => p.trim())];
  const caretOffset = texts[texts.length - 1].length;
  texts[texts.length - 1] += after;
  // Enter at the start of a row opens blank rows above it: the row itself
  // moves down with its text, keeping its color and toggles.
  const keep = texts.length > 1 && !texts[0] ? texts.length - 1 : 0;
  const inserted = texts.map((text, i): Equation =>
    i === keep ? Object.assign(first, { text }) : { id: app.nextId++, text, colorIndex: -1 },
  );
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
    id: app.nextId++,
    text: eq.text,
    colorIndex: -1,
    sliderMin: eq.sliderMin,
    sliderMax: eq.sliderMax,
    showLevels: eq.showLevels,
  }));
  // The copies go on the side the selection moves to, so the selected rows
  // are always the new ones and the originals keep their place.
  equations.splice(dir > 0 ? last + 1 : first, 0, ...copies);
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
const fromWidget = (e: Event): boolean => e.target instanceof Element && e.target.closest('.eq-widget') !== null;

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
    reshapeLines();
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
  // A `#hex` note fixes the color: cycling the palette under it would change
  // nothing on screen, yet cost an undo entry and the redo stack. A row with
  // no slot draws nothing to recolor.
  if (noteColor(eq.text) || eq.colorIndex < 0) return;
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
  replaceDocument(
    splitStatements(text)
      .map(s => s.trim())
      .filter(Boolean),
    true,
  );
}

function buildExamplesMenu() {
  const button = document.getElementById('examples');
  if (!button) return;
  // The popup and its thumbnails load on first use; hovering, or holding the
  // shortcut's modifier, starts the fetch.
  let menu: typeof import('./examples-menu.ts') | undefined;
  const load = () =>
    import('./examples-menu.ts').then(m => (menu = m)).catch(err => console.error('examples menu failed to load', err));
  /** An open is waiting on the first load. */
  let opening = false;
  const toggle = () => {
    // Once loaded, open synchronously: keys typed straight after the
    // shortcut then reach the popup's search, not the row being edited.
    if (menu) return menu.toggleExamplesMenu(openExample);
    // A second press during the first load (a double-click, ⌘K twice) would
    // otherwise toggle the popup shut the moment it opens.
    if (opening) return;
    opening = true;
    // The first time, keys have nowhere to go until it arrives.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    void load().then(m => {
      opening = false;
      m?.toggleExamplesMenu(openExample);
    });
  };
  button.addEventListener('pointerenter', () => void load(), { once: true });
  button.addEventListener('click', toggle);
  // Cmd+K on Apple platforms, Ctrl+K elsewhere. Only the platform's own
  // modifier: on a Mac, Ctrl+K is kill-to-end-of-line in the editor. Shift
  // must be up, since Cmd+Shift+K deletes rows.
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  button.title = `Browse examples (${mac ? '⌘K' : 'Ctrl+K'})`;
  addEventListener('keydown', e => {
    if (e.key === (mac ? 'Meta' : 'Control') && !menu) void load();
    if (e.key.toLowerCase() !== 'k' || e.altKey || e.shiftKey) return;
    if (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    toggle();
  });
}

/** Where a drag to screen coordinate s puts a point on a mapped axis: s
 *  rounded to a pixel there (where pixels are even), then to five figures,
 *  so a log axis writes 0.00005 or 116.59, never a pixel-sized 0. */
export function dragTo(map: AxisMap | undefined, s: number, axis: number): number {
  if (!map) return s;
  const upp = app.view.upp / (axis === 1 ? (app.view.ratio ?? 1) : 1);
  const step = Math.pow(10, Math.floor(Math.log10(upp * 3)));
  return parseFloat(toWorld(map, Math.round(s / step) * step).toPrecision(5));
}

/** dragTo through a plane map: the screen point carried to x and y, each
 *  rounded to about a pixel there — the pixel's size in x and y, from the
 *  map's Jacobian — as snapToPixel rounds on a plain panel. */
export function dragToPlane(plane: PlaneMap, sx: number, sy: number): [number, number] {
  const [x, y] = planeToWorld(plane, sx, sy);
  const [px, py] = pixelSpan(plane, sx, sy, app.view.upp, app.view.upp / (app.view.ratio ?? 1));
  const round = (v: number, pixel: number) => {
    if (!(pixel > 0) || !isFinite(pixel)) return parseFloat(v.toPrecision(5));
    const step = Math.pow(10, Math.floor(Math.log10(pixel * 3)));
    return parseFloat((Math.round(v / step) * step).toPrecision(12));
  };
  return [round(x, px), round(y, py)];
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

/** While a point is dragged on a surface, x and y's change across a pixel there. */
let surfaceSnap: [number, number] | null = null;

/** Round to roughly a pixel, so dragging writes short, readable numbers.
 *  A mapped axis's pixels are not even in its own units, so its value was
 *  rounded on the screen already (dragTo) and is left as it is. */
function snapToPixel(v: number, axis = 0): number {
  const maps = panelMaps(app.cur);
  if (maps?.plane || maps?.[axis === 1 ? 'y' : 'x']) return v;
  // On a surface, to the pixel there (as it is when that is unknown).
  const upp =
    app.mode === '3d' ? (surfaceSnap?.[axis] ?? NaN) : app.view.upp / (axis === 1 ? (app.view.ratio ?? 1) : 1);
  if (!(upp > 0)) return v;
  const step = Math.pow(10, Math.floor(Math.log10(upp * 3)));
  return Math.round(v / step) * step;
}

/**
 * How a dragged position writes back to a pair like `(2, a)`, or null if
 * nothing about it can move. Axes are independent: a literal is rewritten in
 * place while a slider name moves through its own row. `commit` receives the
 * rewritten pair text.
 */
function makePairWriter(
  pairText: string,
  commit: (pair: string) => void,
  round = snapToPixel,
  pinned?: ReadonlySet<string>,
): ((x: number, y: number) => void) | null {
  // A name moves only if it is a slider constant: a plain number in its own
  // row is the only right-hand side a drag knows how to rewrite.
  const drag = dragAxes(
    pairText,
    p => equations.find(r => r.def?.kind === 'const' && r.def.name === p && sliderOf(r)),
    pinned,
    name => boundIn(app.defs, name),
  );
  if (!drag) return null;
  const { parts, axes } = drag;
  return (x, y) => {
    const coords = [x, y];
    const text = [...parts];
    axes.forEach((axis, k) => {
      if (!axis) return;
      const value = fmtNum(round(coords[k], k));
      if (axis === 'literal') text[k] = value;
      else {
        const moved = moveSlider(axis, round(coords[k], k));
        if (moved) axis.text = keepNote(axis.text, moved.text);
      }
    });
    commit(`(${text[0]}, ${text[1]})`);
  };
}

export const pointWriter = (eq: Equation) =>
  makePairWriter(stripNote(eq.text), p => {
    eq.text = keepNote(eq.text, p);
  });

/** Evaluate the named coordinates at the pointer before writing the RHS. */
export function coordinatePointWriter(eq: Equation, coords: Expr[] | undefined) {
  if (!coords) return null;
  const code = stripNote(eq.text);
  const at = code.indexOf('=');
  if (at < 0) return null;
  const lhs = code.slice(0, at).trim();
  // Writing a slider that defines either chart coordinate changes the map
  // itself, so ordinary coordinate writeback cannot move that axis reliably.
  const pinned = definitionDependencies(
    coords.flatMap(c => [...freeVars(c)]),
    app.defs,
  );
  const write = makePairWriter(
    code.slice(at + 1),
    p => {
      eq.text = keepNote(eq.text, `${lhs} = ${p}`);
    },
    v => v,
    pinned,
  );
  if (!write) return null;
  return coordinateDragWriter(
    coords,
    () => {
      const time = graphTime();
      return { ...currentConstEnv(time), t: time };
    },
    write,
    snapToPixel,
  );
}

/** Writer for a named-point row `A = (…)`: rewrites the pair after the '='.
 *  Names in `pinned` are held still. */
export const defPointWriter = (eq: Equation, pinned?: ReadonlySet<string>) => {
  const def = eq.def as Definition & { kind: 'const' };
  // A binder's row is `p ∈ …`, never an assignment to rewrite.
  if (def.draw) return null;
  return makePairWriter(
    def.rhs,
    p => {
      eq.text = keepNote(eq.text, `${definitionHead(def, stripNote(eq.text))} ${p}`);
    },
    undefined,
    pinned,
  );
};

/** The names a surface reads (its sliders, and what they are made of). */
const surfaceReadsOf = new WeakMap<SurfaceMap, Set<string>>();
export function surfaceReads(surface: SurfaceMap): Set<string> {
  let reads = surfaceReadsOf.get(surface);
  if (!reads) {
    reads = definitionDependencies(freeVars(parseExpr(surface.text, undefined, undefined, valueNames)), app.defs);
    surfaceReadsOf.set(surface, reads);
  }
  return reads;
}

/** Push text a drag rewrote back into the editor lines. */
function syncLineTexts() {
  const lines = lineEls();
  equations.forEach((eq, i) => {
    const line = lines[i];
    if (line && lineText(line) !== eq.text) setLineText(line, eq.text);
  });
}

/** Pixels of slack around a point when grabbing it. */
const GRAB_PX = 14;
/** The point being dragged, with the offset from its centre to the pointer. */
let grab: { pt: Grabbable; dx: number; dy: number } | null = null;

/** Math coordinates under a client position. */
function toMath(clientX: number, clientY: number): [number, number] {
  const dpr = window.devicePixelRatio || 1;
  const rect = panelClientRect();
  const px = (clientX - rect.left - rect.width / 2) * dpr;
  const py = (rect.height / 2 - (clientY - rect.top)) * dpr;
  return [app.view.cx + px * app.view.upp, app.view.cy + (py * app.view.upp) / (app.view.ratio ?? 1)];
}

/** The nearest grabbable point within GRAB_PX of a client position. */
function pointAt(clientX: number, clientY: number): Grabbable | null {
  if (app.mode === '3d') return surfaceGrabAt(clientX, clientY);
  if (!app.grabbable.length) return null;
  const [mx, my] = toMath(clientX, clientY);
  const dpr = window.devicePixelRatio || 1;
  let best: Grabbable | null = null;
  let bestDist = GRAB_PX * dpr * app.view.upp;
  for (const p of app.grabbable) {
    const d = Math.hypot(p.x - mx, (p.y - my) * (app.view.ratio ?? 1));
    if (d <= bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

/** The nearest grabbable point within GRAB_PX of a client position on a
 *  surface panel, and in sight there. */
function surfaceGrabAt(clientX: number, clientY: number): Grabbable | null {
  const on = app.grabbable.length ? surfaceAt(clientX, clientY) : null;
  if (!on) return null;
  const rect = canvas.getBoundingClientRect();
  let best: Grabbable | null = null;
  let bestDist = GRAB_PX;
  for (const g of app.grabbable) {
    const p = surfacePoint(on.surface, g.x, g.y);
    const at = p.every(isFinite) ? on.toCanvas(p) : null;
    const d = at ? Math.hypot(at[0] - (clientX - rect.left), at[1] - (clientY - rect.top)) : Infinity;
    if (d <= bestDist && on.seen(p)) {
      bestDist = d;
      best = g;
    }
  }
  return best;
}

function setHot(key: string | null) {
  if (app.hotPoint === key) return;
  app.hotPoint = key;
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

// --- hover: intercepts, extrema and tracing ---

/** What hovering shows: a point and its readout. `at` is where it is on
 *  the canvas (CSS pixels from its corner) when not at x and y in a 2D
 *  window — on a surface. */
interface Hover {
  pt: SpecialPoint;
  color: string;
  panel: Panel;
  at?: [number, number];
}

let hover: Hover | null = null;

const tooltip = document.createElement('div');
tooltip.id = 'tooltip';
document.body.append(tooltip);

/** The canvas rect, and the current panel's math → CSS pixels from that
 *  rect's corner, for screen↔world mapping. */
function screenMap() {
  const rect = canvas.getBoundingClientRect();
  const box = panelClientRect();
  const ox = box.left - rect.left;
  const oy = box.top - rect.top;
  const uppCss = app.view.upp * (window.devicePixelRatio || 1);
  return {
    rect,
    toSx: (x: number) => ox + (x - app.view.cx) / uppCss + box.width / 2,
    toSy: (y: number) => oy + box.height / 2 - ((y - app.view.cy) * (app.view.ratio ?? 1)) / uppCss,
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
  if (spSlot !== null || app.rendererDisposed) return;
  const gen = spGen;
  spSlot = idleSlot(() => {
    spSlot = null;
    if (gen !== spGen) return; // the document changed under this slot
    const next: Equation | undefined = spQueue.values().next().value;
    if (next) {
      spQueue.delete(next);
      // Over the row's own panel's window, whichever panel the pointer is in.
      if (equations.includes(next)) withPanel(panels[panelOf(next)] ?? panels[0], () => computeSpecialPoints(next));
      if (spQueue.size) ensureSpSlot();
    }
    if (lastHoverAt) updateHover(lastHoverAt.x, lastHoverAt.y);
  });
}

function hoverHalfSpan() {
  return {
    halfW: (panelW() / 2) * app.view.upp,
    halfH: (panelH() / 2) * (app.view.upp / (app.view.ratio ?? 1)),
  };
}

function hoverEnvKey(cls: Classified): string {
  return cls.params.map(p => `${p}=${app.constEnv[p] ?? 0}`).join(',');
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
    expr = substVars(
      expr,
      Object.fromEntries(cls.params.map(p => [p, { kind: 'num', value: app.constEnv[p] ?? 0 } as Expr])),
    );
  }
  const xlo = app.view.cx - halfW * 1.5;
  const xhi = app.view.cx + halfW * 1.5;
  const ylo = app.view.cy - halfH * 1.5;
  const yhi = app.view.cy + halfH * 1.5;
  const maps = panelMaps(panels[panelOf(eq)]);
  const pts = maps?.plane
    ? planeSpecialPoints(cls, maps.plane, halfW, halfH)
    : maps
      ? mappedSpecialPoints(expr, maps, xlo, xhi, ylo, yhi)
      : specialPoints(expr, xlo, xhi, ylo, yhi);
  eq.spCache = { text: eq.text, env: hoverEnvKey(cls), xlo, xhi, ylo, yhi, pts };
}

/**
 * A curve's intercepts and extrema through a plane map: found in x and y, as
 * the row is written (Classified.world), over the part of the plane the
 * window shows, and placed wherever the screen shows each one. They read in
 * x and y as anywhere else.
 */
function planeSpecialPoints(cls: Classified, plane: PlaneMap, halfW: number, halfH: number): SpecialPoint[] {
  const world = cls.world && compileCpu({ ...cls, object: cls.world });
  if (world?.type !== 'implicit2d') return [];
  const expr = cls.params.length
    ? substVars(
        world.equation,
        Object.fromEntries(cls.params.map(p => [p, { kind: 'num', value: app.constEnv[p] ?? 0 } as Expr])),
      )
    : world.equation;
  // The window the overlay carries through, so the way back is shared.
  const box: ScreenBox = {
    lo: [app.view.cx - halfW, app.view.cy - halfH],
    hi: [app.view.cx + halfW, app.view.cy + halfH],
  };
  // Over the padded window the cache stands for, as anywhere else.
  const shown = planeWorldBox(plane, {
    lo: [app.view.cx - 1.5 * halfW, app.view.cy - 1.5 * halfH],
    hi: [app.view.cx + 1.5 * halfW, app.view.cy + 1.5 * halfH],
  });
  if (!shown) return [];
  const inverse = planeInverse(plane, box);
  return specialPoints(expr, shown.lo[0], shown.hi[0], shown.lo[1], shown.hi[1]).flatMap(p =>
    inverse.all(p.x, p.y).map(([x, y]) => ({ ...p, x, y })),
  );
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
  if (
    c &&
    c.text === eq.text &&
    c.env === envKey &&
    c.xlo <= app.view.cx - halfW &&
    c.xhi >= app.view.cx + halfW &&
    c.xhi - c.xlo <= 6 * halfW &&
    c.ylo <= app.view.cy - halfH &&
    c.yhi >= app.view.cy + halfH &&
    c.yhi - c.ylo <= 6 * halfH
  ) {
    return c.pts;
  }
  scheduleSpecialPoints(eq);
  return c && c.text === eq.text && c.env === envKey ? c.pts : [];
}

/** eq's curve tracer, rebuilt when its text or constants change. Cheap to
 *  build (a compile, no search), so unlike spCache it is made on demand. */
function tracerFor(eq: Equation): ReturnType<typeof curveTracer> {
  const cls = eq.cls;
  if (!cls || eq.error || !eq.cpu || eq.cpu.type !== 'implicit2d' || cls.animated) return null;
  const env = hoverEnvKey(cls);
  if (eq.tracer?.text !== eq.text || eq.tracer.env !== env) {
    const values = Object.fromEntries(cls.params.map(p => [p, app.constEnv[p] ?? 0]));
    eq.tracer = { text: eq.text, env, fn: curveTracer(eq.cpu.equation, values) };
  }
  return eq.tracer.fn;
}

function setHover(next: Hover | null) {
  const same =
    hover?.pt === next?.pt ||
    (hover && next && hover.pt.x === next.pt.x && hover.pt.y === next.pt.y && hover.pt.lines[0] === next.pt.lines[0]);
  const still = hover?.at?.[0] === next?.at?.[0] && hover?.at?.[1] === next?.at?.[1];
  if (same && still && hover?.color === next?.color && hover?.panel === next?.panel) return;
  hover = next;
  if (!hover) {
    tooltip.style.display = 'none';
  } else {
    const { rect, toSx, toSy } = screenMap();
    const [sx, sy] = hover.at ?? [toSx(hover.pt.x), toSy(hover.pt.y)];
    // The first line a muted heading: a span, as ::first-line's smaller
    // font would size the whole box (Chromium) and clip a longer line.
    const [head, ...rest] = hover.pt.lines;
    const heading = document.createElement('span');
    heading.className = 'tip-head';
    heading.textContent = head;
    tooltip.replaceChildren(heading, ...rest.map(line => `\n${line}`));
    tooltip.style.borderColor = hover.color;
    tooltip.style.left = `${rect.left + sx + 14}px`;
    tooltip.style.top = `${rect.top + sy + 12}px`;
    tooltip.style.display = 'block';
  }
  requestRender();
}

/** The camera a surface's hover was last read under (see followSurfaceHover). */
let hoverCamera = '';
const cameraKey = (c: Camera3D) => `${c.theta},${c.phi},${c.radius},${c.target}`;

/** A surface's hover read again under a still pointer when the camera
 *  moves (a spin, a tween), so it stays on what is under the pointer. */
export function followSurfaceHover() {
  if (!lastHoverAt || pointers.size) return;
  const p = panelAtClient(lastHoverAt.x, lastHoverAt.y);
  if (p.mode !== '3d' || !panelSurface(p) || cameraKey(p.camera) === hoverCamera) return;
  withPanel(p, () => updateHover(lastHoverAt!.x, lastHoverAt!.y));
}

function updateHover(clientX: number, clientY: number) {
  if (app.mode !== '2d') {
    hoverCamera = cameraKey(app.camera);
    setHover(surfaceHover(clientX, clientY));
    return;
  }
  const { rect, toSx, toSy } = screenMap();
  const mx = clientX - rect.left;
  const my = clientY - rect.top;
  let best: Hover | null = null;
  let bestD = 16; // CSS px pick radius
  const here = panels.indexOf(app.cur);
  for (const eq of equations) {
    if (panelOf(eq) !== here) continue;
    for (const pt of pointsFor(eq)) {
      const d = Math.hypot(toSx(pt.x) - mx, toSy(pt.y) - my);
      if (d < bestD) {
        bestD = d;
        best = { pt, color: cssColor(baseColor(eq)), panel: app.cur };
      }
    }
  }
  // No notable point near: trace the nearest curve instead, reading (x, y)
  // off wherever the pointer sits along it.
  if (!best) {
    const uppCss = app.view.upp * (window.devicePixelRatio || 1);
    const sx = uppCss;
    const sy = uppCss / (app.view.ratio ?? 1);
    const [wx, wy] = toMath(clientX, clientY);
    let bestT = 10; // CSS px: tighter than a point, so the points stay easy to hit
    // On a mapped panel the curve is traced on the screen, and read in x and
    // y, to the pixel there (lib/axis-map.ts).
    const maps = panelMaps(app.cur);
    const read = (map: AxisMap | undefined, v: number, step: number) => {
      if (!map) return fmtTraced(v, step);
      // A pixel in x there: one-sided where the other side leaves the map.
      const w = toWorld(map, v);
      const ahead = Math.abs(toWorld(map, v + step) - w);
      return fmtTraced(w, isFinite(ahead) ? ahead : Math.abs(w - toWorld(map, v - step)));
    };
    for (const eq of equations) {
      if (panelOf(eq) !== here) continue;
      const hit = tracerFor(eq)?.(wx, wy, sx, sy);
      if (hit && hit.dist < bestT) {
        bestT = hit.dist;
        const lines = maps?.plane
          ? ['on curve', ...readPlane(maps.plane, hit.x, hit.y, sx, sy)]
          : ['on curve', `x = ${read(maps?.x, hit.x, sx)}`, `y = ${read(maps?.y, hit.y, sy)}`];
        best = { pt: { x: hit.x, y: hit.y, lines }, color: cssColor(baseColor(eq)), panel: app.cur };
      }
    }
  }
  setHover(best);
}

/** A traced screen point (X, Y) read in x and y through a plane map, each to
 *  the pixel there (sx, sy screen units a pixel), from the map's Jacobian. */
function readPlane(plane: PlaneMap, X: number, Y: number, sx: number, sy: number): string[] {
  const [x, y] = planeToWorld(plane, X, Y);
  const [px, py] = pixelSpan(plane, X, Y, sx, sy);
  return [`x = ${fmtTraced(x, px || sx)}`, `y = ${fmtTraced(y, py || sx)}`];
}

/**
 * The surface of the current panel (if it draws on one) under a client
 * position: the ray from the eye through it met with the surface
 * (lib/surface-pick.ts). With where a point in space lands on the canvas
 * (CSS pixels from its corner), how much x and y change across a pixel at
 * a point on the surface, and whether a point there is in sight.
 */
function surfaceAt(clientX: number, clientY: number) {
  const surface = app.mode === '3d' ? panelSurface(app.cur) : undefined;
  if (!surface) return null;
  const rect = canvas.getBoundingClientRect();
  const box = panelClientRect();
  const { vp, invVp, eye } = cameraMatrices(app.camera, box.width / box.height);
  // The pixel on the far plane, back into space.
  const nx = ((clientX - box.left) / box.width) * 2 - 1;
  const ny = 1 - ((clientY - box.top) / box.height) * 2;
  const w = invVp[3] * nx + invVp[7] * ny + invVp[11] + invVp[15];
  const dir = [0, 1, 2].map(k => (invVp[k] * nx + invVp[4 + k] * ny + invVp[8 + k] + invVp[12 + k]) / w - eye[k]);
  const toCanvas = (p: readonly number[]): [number, number] | null => {
    const at = projectToScreen(vp, p, box.width, box.height);
    return at && [at[0] + box.left - rect.left, at[1] + box.top - rect.top];
  };
  return {
    surface,
    hit: raySurface(surface, eye, dir),
    toCanvas,
    units: (x: number, y: number) => surfacePixel(surface, x, y, toCanvas),
    // Nothing of the surface nearer along the ray to it.
    seen: (p: readonly number[]) => {
      const h = raySurface(
        surface,
        eye,
        p.map((v, k) => v - eye[k]),
      );
      return !h || h.t > 0.999;
    },
  };
}

/**
 * Hovering a surface: a dot there reads its x and y (and name); near a
 * painted curve, the point traced along it, as in 2D; anywhere else on the
 * surface, x and y there. Each with the scalar and vector fields' values
 * there.
 */
function surfaceHover(clientX: number, clientY: number): Hover | null {
  const on = surfaceAt(clientX, clientY);
  if (!on) return null;
  const { surface, hit, toCanvas, units, seen } = on;
  const rect = canvas.getBoundingClientRect();
  const mx = clientX - rect.left;
  const my = clientY - rect.top;
  const read = (x: number, y: number) => {
    const [ux, uy] = units(x, y);
    return [`x = ${fmtTraced(x, ux)}`, `y = ${fmtTraced(y, uy)}`];
  };
  const near = (x: number, y: number) => {
    const p = surfacePoint(surface, x, y);
    const at = p.every(isFinite) ? toCanvas(p) : null;
    return at ? { p, at, dist: Math.hypot(at[0] - mx, at[1] - my) } : null;
  };
  let best: Hover | null = null;
  let bestD = 16; // CSS px, as in 2D
  for (const d of app.cur.surfaceDots) {
    const n = near(d.x, d.y);
    if (!n || n.dist >= bestD || !seen(n.p)) continue;
    bestD = n.dist;
    const lines = [...(d.label ? [d.label] : []), ...read(d.x, d.y)];
    best = { pt: { x: d.x, y: d.y, lines }, color: cssColor(d.color), panel: app.cur, at: n.at };
  }
  const here = panels.indexOf(app.cur);
  const drawn = equations.filter(eq => panelOf(eq) === here && !eq.error && eq.cls && !eq.cls.needs3D);
  const painted = drawn.filter(eq => surfaceMapping(eq.cls!.object) === 'paint');
  // A painted curve near: traced in x and y to the pixel there. The trace
  // may step off the surface's ranges (near a pole a pixel spans much of
  // x), where the surface repeats but nothing is painted.
  if (!best && hit) {
    const [ux, uy] = units(hit.x, hit.y);
    let bestT = 10; // CSS px: tighter than a dot, as in 2D
    for (const eq of painted) {
      const h = tracerFor(eq)?.(hit.x, hit.y, ux, uy);
      const n = h && onSurface(surface, h.x, h.y) && near(h.x, h.y);
      if (!h || !n || n.dist >= bestT) continue;
      bestT = n.dist;
      best = {
        pt: { x: h.x, y: h.y, lines: ['on curve', ...read(h.x, h.y)] },
        color: cssColor(baseColor(eq)),
        panel: app.cur,
        at: n.at,
      };
    }
    best ??= {
      pt: { x: hit.x, y: hit.y, lines: ['on surface', ...read(hit.x, hit.y)] },
      color: cssColor(theme.axis),
      panel: app.cur,
      at: toCanvas(hit.point) ?? [mx, my],
    };
  }
  if (!best) return null;
  // Each scalar or vector field's value there, named by its row.
  const env = { ...app.constEnv, t: graphTime(), x: best.pt.x, y: best.pt.y };
  const short = (v: number) => valueReadout(v).replace(/^[=≈] /, '');
  for (const eq of drawn) {
    const plot = eq.cpu;
    if (plot?.type !== 'scalar2d' && plot?.type !== 'vfield2d') continue;
    if (!surfaceMapping(eq.cls!.object)) continue;
    let value: string;
    try {
      value =
        plot.type === 'scalar2d'
          ? valueReadout(evaluate(plot.expr, env))
          : `= (${plot.comps.map(c => short(evaluate(c, env))).join(', ')})`;
    } catch {
      continue;
    }
    const name = eq.text.length > 24 ? `${eq.text.slice(0, 23)}…` : eq.text;
    best.pt.lines.push(`${name} ${value}`);
  }
  return best;
}

/** Marker for the hovered point, drawn over the axis labels. */
export function drawHoverMarker(dpr: number) {
  if (!hover || hover.panel !== app.cur || (app.mode !== '2d' && !hover.at)) return;
  const { toSx, toSy } = screenMap();
  const [sx, sy] = hover.at ?? [toSx(hover.pt.x), toSy(hover.pt.y)];
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
export const pointers = new Map<number, { x: number; y: number }>();
let pinchDist = 0;
let downX = 0;
let downY = 0;
let dragMoved = false;

/** Zoom by `factor` keeping the math point under (clientX, clientY) fixed. */
function zoomAt(clientX: number, clientY: number, factor: number) {
  if (app.cur.locked) return;
  if (app.mode === '2d') {
    const dpr = window.devicePixelRatio || 1;
    const rect = panelClientRect();
    const px = (clientX - rect.left - rect.width / 2) * dpr;
    const py = (rect.height / 2 - (clientY - rect.top)) * dpr;
    const mx = app.view.cx + px * app.view.upp;
    const my = app.view.cy + py * (app.view.upp / (app.view.ratio ?? 1));
    app.view.upp = Math.max(1e-12, app.view.upp * factor);
    app.view.cx = mx - px * app.view.upp;
    app.view.cy = my - py * (app.view.upp / (app.view.ratio ?? 1));
  } else {
    app.camera.radius = Math.min(1e6, Math.max(1e-4, app.camera.radius * factor));
  }
  requestRender();
  scheduleViewportWriteback();
}

canvas.addEventListener('pointerdown', e => {
  setHover(null); // a tooltip must not survive the gesture that moves the plot
  lastHoverAt = null; // nor may a deferred recompute re-pick mid-gesture
  // A gesture belongs to the panel it starts in, wherever it wanders.
  if (!pointers.size) activate(panelAtClient(e.clientX, e.clientY));
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {} // synthetic events have no active pointer to capture
  if (pointers.size === 1) {
    // Grabbing an on-screen point wins over panning the view.
    scaling = app.mode === '2d' && e.button === 0 && e.altKey;
    const hit = e.button === 0 && !e.shiftKey && !scaling ? pointAt(e.clientX, e.clientY) : null;
    if (hit) {
      // On a surface the point goes where the pointer meets it (surfaceAt).
      const [mx, my] = app.mode === '3d' ? [hit.x, hit.y] : toMath(e.clientX, e.clientY);
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
    if (app.mode === '2d' && !app.cur.locked) {
      app.view.cx -= dx * dpr * app.view.upp;
      app.view.cy += dy * dpr * (app.view.upp / (app.view.ratio ?? 1));
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
    if (app.mode === '3d') {
      // Along the surface, to the pixel there; held where the pointer leaves it.
      const on = surfaceAt(e.clientX, e.clientY);
      if (on?.hit) {
        surfaceSnap = on.units(on.hit.x, on.hit.y);
        movePoint(grab.pt, on.hit.x, on.hit.y);
        surfaceSnap = null;
      }
      return;
    }
    const [mx, my] = toMath(e.clientX, e.clientY);
    movePoint(grab.pt, mx + grab.dx, my + grab.dy);
    return;
  }
  if (!dragging) {
    // Hover: show what can be picked up, in the panel under the pointer.
    if (!pointers.size) activate(panelAtClient(e.clientX, e.clientY));
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
  // A locked panel's view(…, locked) or camera(…, locked) row holds it still.
  if (app.cur.locked) return;
  if (app.mode === '2d' && scaling) {
    if (!dragMoved) return;
    ensureViewRow();
    const rect = panelClientRect();
    const px = (downX - rect.left - rect.width / 2) * dpr;
    const py = (rect.height / 2 - (downY - rect.top)) * dpr;
    const next = scaleViewAt(app.view, px, py, Math.exp(-dx * 0.01), Math.exp(dy * 0.01));
    Object.assign(app.view, next);
  } else if (app.mode === '2d') {
    app.view.cx -= dx * dpr * app.view.upp;
    app.view.cy += dy * dpr * (app.view.upp / (app.view.ratio ?? 1));
  } else if (panning) {
    // Pan the target in the camera's screen plane.
    const s = app.camera.radius * 0.0022;
    const ct = Math.cos(app.camera.theta),
      st = Math.sin(app.camera.theta);
    const sp = Math.sin(app.camera.phi),
      cp = Math.cos(app.camera.phi);
    // right = (-sinθ, cosθ, 0); up = (-cosθ·sinφ, -sinθ·sinφ, cosφ)
    app.camera.target[0] += (st * dx + ct * sp * dy) * s;
    app.camera.target[1] += (-ct * dx + st * sp * dy) * s;
    app.camera.target[2] += cp * dy * s;
  } else {
    app.camera.theta -= dx * 0.008;
    app.camera.phi = clampPhi(app.camera.phi + dy * 0.008);
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
  if (scaling || e.altKey || dragMoved || pointers.size || app.mode !== '2d' || e.button !== 0 || e.shiftKey) return;
  if (!equations.some(q => !q.error && q.cpu?.type === 'vfield2d')) return;
  // Each seed costs an RK4 integration per field per frame; keep the newest.
  if (app.drops.length >= MAX_DROPS) app.drops.shift();
  const [mx, my] = toMath(e.clientX, e.clientY);
  app.drops.push({ x: mx, y: my });
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
  if (!app.drops.length) return;
  app.drops.length = 0;
  requestRender();
});

canvas.addEventListener(
  'wheel',
  e => {
    e.preventDefault();
    setHover(null);
    if (!pointers.size) activate(panelAtClient(e.clientX, e.clientY));
    const factor = Math.exp(Math.max(-60, Math.min(60, e.deltaY)) * 0.002);
    zoomAt(e.clientX, e.clientY, factor);
  },
  { passive: false },
);

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
// The chat widget opens with the panel shown. Hosts cache the widget HTML,
// whose older copies start parked, so unpark here, where updates still reach.
if (mcpApp) {
  const panel = document.getElementById('panel')!;
  panel.classList.remove('is-parked');
  panel.style.visibility = '';
  document.getElementById('panel-chip')!.hidden = true;
  document.getElementById('panel-chip')!.classList.remove('shown');
}
initPanelSwipe(
  document.getElementById('panel')!,
  document.getElementById('panel-chip')!,
  document.getElementById('panel-grip')!,
  listEl,
);

// Drag the strip on the panel's outer vertical edge to resize it (the width
// persists; double-click resets).
initPanelResize(document.getElementById('panel')!, document.getElementById('panel-resize')!);

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
  try {
    emptyDefault = nextFeatured(localStorage).eqs;
  } catch {
    emptyDefault = nextFeatured(null).eqs;
  }
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
    emptyDefault = nextFeatured(
      store,
      equations.map(e => e.text),
    ).eqs;
    replaceDocument(emptyDefault, true);
  });

  const shotBtn = document.getElementById('shot') as HTMLButtonElement | null;
  const recBtn = document.getElementById('rec') as HTMLButtonElement | null;
  app.capture = attachCapture({
    gl: canvas,
    overlay,
    render,
    requestRender,
    notice: showNotice,
    onRecording(on) {
      recBtn?.classList.toggle('recording', on);
      recBtn?.setAttribute('aria-pressed', on ? 'true' : 'false');
      recBtn?.setAttribute('title', on ? 'Stop recording' : 'Record the graph as video (up to 8 seconds)');
    },
  });
  shotBtn?.addEventListener('click', e => {
    void app.capture?.snapshot(e.shiftKey);
  });
  if (!app.capture.mime && recBtn) recBtn.hidden = true;
  else
    recBtn?.addEventListener('click', () => {
      if (app.capture?.isRecording()) app.capture.stopRecording();
      else app.capture?.startRecording();
    });
}

if (mcpApp) {
  void import('./mcp-app.ts')
    .then(({ connectGraphApp }) =>
      connectGraphApp({
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
        onChange: cb => {
          app.graphChanged = cb;
        },
        onEdit: cb => {
          app.graphEdited = cb;
        },
        setVisible: setGraphVisible,
        flush: flushViewportWriteback,
        dispose: () => {
          if (app.rendererDisposed) return;
          app.rendererDisposed = true;
          r3d.clearGeometry();
          canvasSizeObserver.disconnect();
          window.removeEventListener('resize', resize);
          cancelRender();
          app.graphChanged = undefined;
          app.graphEdited = undefined;
          if (urlTimer !== null) clearTimeout(urlTimer);
          if (app.viewportWriteTimer !== null) clearTimeout(app.viewportWriteTimer);
          if (noticeTimer !== null) clearTimeout(noticeTimer);
          urlTimer = app.viewportWriteTimer = noticeTimer = null;
          urlPending = false;
          spGen++;
          spQueue.clear();
          if (spSlot !== null) {
            if (typeof cancelIdleCallback === 'function') cancelIdleCallback(spSlot);
            else clearTimeout(spSlot);
            spSlot = null;
          }
          traceQueue.clear();
          if (app.traceWorker) {
            app.traceWorker.onmessage = app.traceWorker.onerror = app.traceWorker.onmessageerror = null;
            app.traceWorker.terminate();
            app.traceWorker = undefined;
          }
          // Release cached GPU programs/buffers together; this renderer will
          // never be resumed after the host has requested teardown.
          gl.getExtension('WEBGL_lose_context')?.loseContext();
        },
      }),
    )
    .catch(() => {
      document.getElementById('app-status')!.textContent = 'Could not connect the graph. Try again.';
    });
}

// Dev-only handle for driving/inspecting the view in automated tests.
if (import.meta.env.DEV)
  (window as any).__eq = {
    view: app.view,
    camera: app.camera,
    panels,
    equations,
    requestRender,
    flushViewportWriteback,
    capture: app.capture,
  };

/** The row that defines `name`: its definition, or a `X ~ …` declaration,
 *  a binder or a sequence's recurrence, which carry no Definition. */
function definitionRow(name: string): number {
  const byDef = equations.findIndex(eq => eq.def && eq.def.kind !== 'init' && eq.def.name === name);
  if (byDef >= 0) return byDef;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(`^\\s*${escaped}\\s*(?:'|\\([^)]*\\)|_\\{[^}]*\\})?\\s*(?::?=|~|∈|\\\\in\\b)`);
  return equations.findIndex(eq => !eq.comment && head.test(canonicalName(stripNote(eq.text))));
}

// Colour, and hover cards that say what a name is; ⌘-click goes to its row.
app.repaintHighlights = initHighlight(listEl, {
  lines: lineEls,
  lineText,
  env: () => app.defs,
  definitionRow,
  goTo: row => {
    // A definition inside a collapsed group opens the group.
    for (let i = row; i >= 0; i--) {
      if (!equations[i].comment) continue;
      if (equations[i].collapsed) {
        equations[i].collapsed = undefined;
        reconcile();
      }
      break;
    }
    listEl.focus();
    setCaret(row, equations[row].text.length);
    const line = lineEls()[row];
    line?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    line?.classList.remove('eq-flash');
    void line?.offsetWidth; // restart the animation on a repeat jump
    line?.classList.add('eq-flash');
  },
}).repaint;

// Completion is an ordinary text edit, with the same undo and URL path as typing.
initSyntaxHelp(listEl, {
  context: () => {
    const caret = caretPos();
    const eq = caret && equations[caret.line];
    return caret && eq
      ? { caret, text: eq.text, defs: app.defs, declared: declaredNames(equations.map(e => stripNote(e.text))) }
      : null;
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
