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
import type { Variant } from '../../lib/assistant-instructions.ts';
import { describeRow, is3D, sliderOf } from '../../lib/assistant-tools.ts';
import { LIGHT_PALETTE, assignColors, takesColor } from '../../lib/palette.ts';
import { writeSlider } from '../../lib/slider.ts';
import { noteColor } from '../../lib/statements.ts';
import { searchSyntax, syntaxEntries } from '../../lib/syntax-search.ts';
import type { GraphState, RowStatus, MoveViewTarget } from '../../web/voice.ts';
import { readFileSync } from 'node:fs';

/** The window a fresh 2D graph opens on in the app's window (12 units on the short side). */
export const START_WINDOW = { x: [-8, 8] as [number, number], y: [-6, 6] as [number, number] };
const ASPECT = 16 / 12;
/** web/main.ts defaultCamera. */
const START_CAMERA = { theta: -Math.PI / 3, phi: Math.PI / 5.5, radius: 14, target: [0, 0, 0], spin: 0 };

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

/** read_syntax as the app answered it until list_kinds and the rest replaced it: 4 entries, 2,500 characters. */
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

  /** Whose assistant reads it: a row's hint names that variant's lookup. */
  constructor(
    rows: string[],
    readonly variant: Variant = 'text',
  ) {
    this.set(rows);
  }

  /** Replace the rows, as the app's set_graph does (empty rows dropped by Chat.swift). */
  set(rows: string[]): void {
    this.rows = rows;
    this.analysis = analyzeRows(rows, { readouts: true });
  }

  get mode(): '2d' | '3d' {
    return is3D(this.analysis) ? '3d' : '2d';
  }

  /** voice mode's get_graph (web/main.ts voiceGraph). */
  graph(): GraphState {
    const mode = this.mode;
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
      rows: this.analysis.rows.map((row, i) => this.rowStatus(row, i, colors[i])),
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

  private rowStatus(eq: RowInfo, index: number, color?: string): RowStatus {
    const { status, ...report } = describeRow(this.analysis, this.rows, index, this.variant);
    const row: RowStatus = { index, text: this.rows[index], status, ...report };
    const draws = !!eq.cls && !eq.def && !eq.comment && !eq.view && !report.warning?.startsWith('not drawn');
    if (status === 'ok' && draws && color) row.color = color;
    return row;
  }

  /** web/main.ts sliderOf: the slider a row's definition makes, if any. */
  slider(eq: RowInfo) {
    return sliderOf(this.analysis, eq);
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
