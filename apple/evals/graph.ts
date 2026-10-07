/**
 * The graph the evals' tools act on: the app's renderer (web/main.ts) without
 * the renderer. Rows go through the real analyzer (lib/analysis.ts), and
 * get_graph / set_graph answer with voice mode's GraphState, each row's status
 * and meaning built as web/main.ts `rowStatus` builds them. The camera and
 * sliders are simulated: their arguments are checked as the app checks them,
 * and the result is what the app would answer once the move had finished.
 *
 * Left out: a row's notable points (intercepts in view), which need the
 * renderer's hover cache, and the app's color matching across edits (colors
 * are assigned afresh, in document order).
 */
import { type Analysis, type RowInfo, analyzeRows } from '../../lib/analysis.ts';
import type { CpuPlan } from '../../lib/compiler.ts';
import { type Definition, animatedConstNames, definitionDependencies } from '../../lib/defs.ts';
import { canonicalName } from '../../lib/expr.ts';
import { mvOfNode } from '../../lib/clifford.ts';
import { LIGHT_PALETTE, assignColors, takesColor } from '../../lib/palette.ts';
import { publicKind } from '../../lib/plot.ts';
import { KIND_MEANINGS, rowKind } from '../../lib/row-kind.ts';
import { sliderForm, writeSlider } from '../../lib/slider.ts';
import { noteColor, stripNote } from '../../lib/statements.ts';
import { searchSyntax, syntaxEntries } from '../../lib/syntax-search.ts';
import type { GraphState, MoveViewTarget, RowStatus } from '../../web/voice.ts';
import { readFileSync } from 'node:fs';

/** The window a fresh 2D graph opens on in the app's window (12 units on the short side). */
export const START_WINDOW = { x: [-8, 8] as [number, number], y: [-6, 6] as [number, number] };
const ASPECT = 16 / 12;
/** web/main.ts defaultCamera. */
const START_CAMERA = { theta: -Math.PI / 3, phi: Math.PI / 5.5, radius: 14, target: [0, 0, 0], spin: 0 };

/** 2D-only plots a 3D scene leaves out (web/main.ts SKIPPED_IN_3D). */
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

const round6 = (v: number) => parseFloat(v.toPrecision(6));
const hexColor = (rgb: [number, number, number]) =>
  '#' +
  rgb
    .map(c =>
      Math.round(c * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');

let reference: ReturnType<typeof syntaxEntries> | undefined;

/** read_syntax as the app answers it (web/native-app.ts): 4 entries, 2,500 characters. */
export function readSyntax(query: string): string {
  reference ??= syntaxEntries(readFileSync(new URL('../../web/public/llms.txt', import.meta.url), 'utf8'));
  return searchSyntax(reference, query, 4, 2500);
}

/** One open graph: its rows, the analyzer's reading of them, and the view. */
export class EvalGraph {
  rows: string[] = [];
  analysis!: Analysis;
  window = { x: [...START_WINDOW.x] as [number, number], y: [...START_WINDOW.y] as [number, number] };
  camera = { ...START_CAMERA, target: [...START_CAMERA.target] };

  constructor(rows: string[]) {
    this.set(rows);
  }

  /** Replace the rows, as the app's set_graph does (empty rows dropped by Chat.swift). */
  set(rows: string[]): void {
    this.rows = rows;
    this.analysis = analyzeRows(rows, { readouts: true });
  }

  get mode(): '2d' | '3d' {
    return this.analysis.rows.some(r => !r.error && r.cls?.needs3D) ? '3d' : '2d';
  }

  /** voice mode's get_graph (web/main.ts voiceGraph). */
  graph(): GraphState {
    const mode = this.mode;
    const animated = animatedConstNames(this.analysis.defs);
    const colors = this.colors();
    return {
      mode,
      ...(mode === '2d'
        ? {
            window: {
              x: this.window.x.map(round6) as [number, number],
              y: this.window.y.map(round6) as [number, number],
            },
          }
        : {
            camera: {
              theta: round6(this.camera.theta),
              phi: round6(this.camera.phi),
              radius: round6(this.camera.radius),
              target: this.camera.target.map(round6) as [number, number, number],
              spin: this.camera.spin,
            },
          }),
      rows: this.analysis.rows.map((row, i) => this.rowStatus(row, i, animated, colors[i])),
    };
  }

  /** What the app's editor shows under each row (web/main.ts nativeRowStatus): what each prompt starts with. */
  nativeStatus(): { error: string | null; info: string | null; comment: boolean; view: boolean; divider: boolean }[] {
    return this.analysis.rows.map(row => ({
      error: row.error ?? null,
      info: row.info ?? null,
      comment: !!row.comment,
      view: !!row.view && row.view.kind !== 'split',
      divider: row.view?.kind === 'split',
    }));
  }

  /** Each drawn row's color, as the app would give a freshly loaded document. */
  private colors(): (string | undefined)[] {
    const rows = this.analysis.rows.map((row, i) => ({
      text: this.rows[i],
      comment: row.comment,
      def: row.def,
      point: row.def?.kind === 'const' && this.analysis.defs.points.has(row.def.name),
      view: row.view,
      cpu: row.error ? undefined : row.cpu,
      colorIndex: -1,
    }));
    const takes = rows.map(takesColor);
    assignColors(rows, takes, LIGHT_PALETTE.length);
    return rows.map((row, i) => {
      const rgb = noteColor(this.rows[i]) ?? LIGHT_PALETTE[row.colorIndex];
      return rgb && hexColor(rgb);
    });
  }

  private rowStatus(eq: RowInfo, index: number, animated: ReadonlySet<string>, color?: string): RowStatus {
    const text = this.rows[index];
    const { defs } = this.analysis;
    if (eq.error) {
      const row: RowStatus = { index, text, status: 'error', error: eq.error };
      const unknown = /^Unknown variable: (\w+)\./.exec(eq.error)?.[1];
      const call = unknown && new RegExp(`(?<![\\w])${unknown}\\s*\\(`);
      const fns = this.analysis.rows.filter(o => o.def?.kind === 'fn').map(o => o.text);
      if (call && [text, ...fns].some(t => call.test(stripNote(t)))) {
        row.hint = `${unknown}(…) is not a built-in function; call read_syntax to find the right form`;
      }
      return row;
    }
    const row: RowStatus = { index, text, status: 'ok' };
    if (!text.trim()) return row;
    row.kind = rowKind(eq, defs);
    row.meaning = eq.comment
      ? 'group heading; draws nothing'
      : eq.def
        ? this.definitionMeaning(eq.def, eq, animated)
        : eq.view
          ? {
              view: 'sets the 2D window',
              camera: 'sets the 3D camera',
              grid: "sets what draws behind its panel's plots",
              split: 'starts a new panel; the rows below it draw there',
            }[eq.view.kind]
          : eq.dist
            ? row.kind
            : eq.cls
              ? KIND_MEANINGS[publicKind(eq.cls.object)] +
                (eq.cls.needs3D && !KIND_MEANINGS[publicKind(eq.cls.object)].includes('3D') ? ' (in 3D)' : '') +
                (eq.cls.animated ? '; moves with time t' : '')
              : undefined;
    const members = eq.cpu?.type === 'family' ? eq.cpu.members.map(m => m.cpu) : eq.cpu ? [eq.cpu] : [];
    const skipped = this.mode === '3d' && !!eq.cls && !eq.def && members.every(m => SKIPPED_IN_3D.has(m.type));
    if (skipped) {
      row.warning = 'not drawn: another row makes this graph 3D, and a 3D scene leaves out 2D-only plots like this one';
    }
    const draws = eq.cls && !eq.def && !eq.comment && !eq.view && !skipped;
    if (draws && color) row.color = color;
    if (eq.info) row.value = eq.info;
    else if (eq.def?.kind === 'const' && this.analysis.constEnv[eq.def.name] !== undefined)
      row.value = String(round6(this.analysis.constEnv[eq.def.name]));
    if (eq.cls?.animated) row.animated = true;
    const def = eq.def;
    if (
      (def?.kind === 'const' || def?.kind === 'fn') &&
      !defs.points.has(def.name) &&
      !this.usedElsewhere(index, def.name)
    ) {
      row.warning = `this defines ${def.name}, but no other row uses it, so nothing is drawn`;
    }
    return row;
  }

  /** web/main.ts usedElsewhere: whether any other row reads `name`. */
  private usedElsewhere(index: number, name: string): boolean {
    const others = this.analysis.rows.filter((other, i) => i !== index && !other.comment && !other.view);
    const read = definitionDependencies(
      others.flatMap(other => other.cls?.params ?? []),
      this.analysis.defs,
    );
    if (read.has(name)) return true;
    const word = new RegExp(`(?<![\\p{L}_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'u');
    return this.rows
      .filter((_, i) => i !== index && !this.analysis.rows[i].comment && !this.analysis.rows[i].view)
      .some(other => word.test(canonicalName(stripNote(other).replace(/"[^"]*"/g, '""'))));
  }

  /** web/main.ts definitionMeaning: what a definition row makes. */
  private definitionMeaning(def: Definition, eq: RowInfo, animated: ReadonlySet<string>): string {
    const { name } = def;
    const { defs } = this.analysis;
    switch (def.kind) {
      case 'init':
        return `sets where the state ${name} starts (its value at t = 0)`;
      case 'table':
        return `opens the data file ${def.file} as the table ${name}`;
      case 'regression':
        return `fits the model ${def.lhs} ~ ${def.rhs} to data, defining its parameters`;
      case 'fn':
        return `defines the function ${name}(${def.params.join(', ')}); draws nothing until another row uses it${
          def.params.length === 1 && def.params[0] === 'x' ? `, e.g. y = ${name}(x)` : ''
        }`;
    }
    const entry = defs.names.get(name);
    const b = entry?.kind === 'binding' ? entry.binding : undefined;
    const quiet = '; draws nothing by itself';
    if (!b) return `defines ${name}${quiet}`;
    switch (b.tag) {
      case 'scalar':
        if (b.role === 'state')
          return `defines ${name}: a scalar state, integrated forward in time from its derivative${quiet}`;
        if (b.role === 'complex') return `defines ${name}: a complex number${quiet}`;
        if (b.role === 'condition') return `defines ${name}: a condition, read in braces like {${name}: 1}${quiet}`;
        if (b.role === 'field')
          return `defines ${name}: a scalar field (a value at every point, e.g. a coordinate like r or theta)${quiet}`;
        if (this.slider(eq)) return `defines ${name}: a scalar constant with a slider${quiet}`;
        return `defines ${name}: a scalar constant${animated.has(name) ? ' that changes with time (t)' : ''}${quiet}`;
      case 'vector': {
        const dim = b.role === 'state' ? b.init.length : b.components.length;
        if (b.role === 'state')
          return `defines ${name}: a ${dim}D vector state, integrated forward in time from its derivative${quiet}; a row "${name}" draws it as a moving point`;
        if (b.role === 'field') return `defines ${name}: a ${dim}D vector field${quiet}`;
        return defs.points.has(name)
          ? `defines ${name}: a named ${dim}D point, drawn on the graph`
          : `defines ${name}: a ${dim}D vector${quiet}`;
      }
      case 'fn':
        return `defines the function ${name}${quiet}`;
      case 'matrix':
        return `defines ${name}: a matrix${quiet}`;
      case 'tensor':
        return `defines ${name}: a ${b.tensor.shape.join('×')} tensor${quiet}`;
      case 'seq':
        return `defines ${name}: a list${quiet}`;
      case 'table':
        return `defines ${name}: a data table${quiet}`;
      case 'rv':
        return `defines ${name}: a random variable`;
      case 'missing':
        return `defines ${name} from a data file that is not on this device`;
      case 'multivector':
        return `defines ${name}: a ${mvOfNode(b.value)?.quat ? 'quaternion' : 'multivector'}${quiet}`;
      case 'interval':
        return `defines ${name}: a continuous interval, one hidden parameter shared by every row that uses ${name}${quiet}`;
    }
  }

  /** web/main.ts sliderOf: the slider a row's definition makes, if any. */
  slider(eq: RowInfo) {
    const def = eq.def;
    if ((def?.kind !== 'const' && def?.kind !== 'init') || eq.error || (def.kind === 'const' && def.draw)) return null;
    const rhs = def.rhs.trim();
    const form = sliderForm(rhs, new Set(this.analysis.defs.fns.keys()));
    return form ? { def, rhs, form } : null;
  }

  /**
   * animate_slider (web/main.ts animateSlider), finished at once: the
   * slider's row is left at the value it glides to.
   */
  animateSlider(name: string, to: number, seconds: number, from?: number): object {
    const index = this.analysis.rows.findIndex(eq => this.slider(eq)?.def.name === name);
    if (index < 0) {
      const names = this.analysis.rows.flatMap(eq => this.slider(eq)?.def.name ?? []);
      return { error: `no slider named "${name}"${names.length ? `; sliders: ${names.join(', ')}` : ''}` };
    }
    const slider = this.slider(this.analysis.rows[index])!;
    const start = from ?? slider.form.literal;
    const end = slider.form.whole ? Math.round(to) : to;
    const text = this.rows[index];
    const at = text.indexOf(slider.rhs);
    if (at >= 0) {
      const rows = [...this.rows];
      rows[index] =
        text.slice(0, at) +
        writeSlider(slider.rhs, slider.form, String(round6(end))) +
        text.slice(at + slider.rhs.length);
      this.set(rows);
    }
    return { slider: name, from: start, to: end, seconds };
  }

  /** move_view (web/main.ts movePanelView), answered as though the move had finished. */
  moveView(target: MoveViewTarget, seconds: number): object {
    if (this.mode === '2d') {
      if (target.spin !== undefined) return { error: 'spin turns the 3D camera; this graph is 2D' };
      if (!target.x && !target.y) return { error: 'the graph is 2D: give x and/or y ranges' };
      const bad = [target.x, target.y].some(r => r && !(r[1] > r[0]));
      if (bad) return { error: 'each range must be [low, high] with high > low' };
      // The window keeps its shape: the ranges given fit inside it (lib/view.ts fitView2D).
      const [x0, x1] = target.x ?? this.window.x;
      const [y0, y1] = target.y ?? this.window.y;
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const halfW = Math.max(target.x ? (x1 - x0) / 2 : 0, target.y ? ((y1 - y0) / 2) * ASPECT : 0);
      const halfH = halfW / ASPECT;
      this.window = { x: [cx - halfW, cx + halfW], y: [cy - halfH, cy + halfH] };
      return { ...this.graph().window!, seconds };
    }
    const moves =
      target.theta !== undefined || target.phi !== undefined || target.radius !== undefined || !!target.target;
    if (!moves && target.spin === undefined)
      return { error: 'the graph is 3D: give theta, phi, radius, target and/or spin' };
    if (target.spin !== undefined) this.camera.spin = target.spin;
    if (!moves) return { spin: target.spin, note: 'saved in the camera row' };
    if (target.theta !== undefined) this.camera.theta = target.theta;
    if (target.phi !== undefined) this.camera.phi = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, target.phi));
    if (target.radius !== undefined) this.camera.radius = target.radius;
    if (target.target) this.camera.target = [...target.target];
    return {
      ...this.graph().camera!,
      seconds,
      ...(target.spin !== undefined ? { note: 'spinning now; saved in the camera row' } : {}),
    };
  }
}
