/**
 * The renderer's side of the Apple app (apple/Equation).
 *
 * There the rows belong to a native editor, and this page only draws them.
 * Swift drives it through `window.equationApp`; everything this page has to
 * say goes back as messages to the `equation` script message handler:
 *
 *   ready              the page can take a document
 *   rows    {rows}     the graph rewrote rows itself (a slider, a dragged point)
 *   status  {rows}     each row's color, error, readout and slider, once current
 *
 * The app's chat calls the voice prototype's graph tools here too (graph,
 * moveView, animateSlider), and its own (check, searchFunctions,
 * functionDoc, listKinds, kindExamples, from lib/assistant-tools.ts), and
 * awaits what they return.
 */

import {
  type CheckedRow,
  type ExamplesIndex,
  checkRows,
  functionDoc,
  kindExamples,
  listKinds,
  searchFunctions,
} from '../lib/assistant-tools.ts';
import type { SpanClass } from '../lib/highlight.ts';
import type { GraphState, MoveViewTarget } from './voice.ts';

export interface NativeRow {
  /** The native editor's id for the row, stable across edits and moves. */
  id: number;
  text: string;
}

export interface NativeRowStatus {
  /** The row's color as linear 0–1 RGB, or null when it draws nothing in a color. */
  color: [number, number, number] | null;
  error: string | null;
  info: string | null;
  /** A `# heading` row. */
  comment: boolean;
  /** A viewport row, written by panning. */
  view: boolean;
  /** A `---` row, splitting the graph into panels. */
  divider: boolean;
  /** Where the row's trailing `# note` starts (UTF-16), or null. */
  note: number | null;
  /** Syntax colors over the row's text, in UTF-16 offsets (lib/highlight.ts). */
  spans: { start: number; end: number; cls: SpanClass }[];
  slider: { min: number; max: number; step: number; value: number } | null;
}

interface NativeGraph {
  /** A different document: resets the view and the clock. */
  loadRows(rows: NativeRow[]): void;
  /** An edit to the open document: the view stays where it is. */
  editRows(rows: NativeRow[]): void;
  setSlider(index: number, value: number): void;
  /** Glide the zoom about the graph's center: below 1 zooms in, above 1 out. */
  zoom(factor: number): void;
  /** Every row's status and meaning, and the window or camera (the voice prototype's get_graph). */
  graph(): GraphState;
  /** Ease to a new framing; settles once it has arrived. */
  moveView(target: MoveViewTarget, seconds: number): object | Promise<object>;
  /** Glide a slider to a value. */
  animateSlider(name: string, to: number, seconds: number, from?: number): object;
  onChange(callback: (rows: string[]) => void): void;
  onStatus(callback: (rows: NativeRowStatus[]) => void): void;
  setTheme(mode: 'light' | 'dark'): void;
}

type Message = { type: 'ready' } | { type: 'rows'; rows: string[] } | { type: 'status'; rows: NativeRowStatus[] };

declare global {
  interface Window {
    webkit?: { messageHandlers?: { equation?: { postMessage(message: Message): void } } };
    equationApp?: Pick<
      NativeGraph,
      'loadRows' | 'editRows' | 'setSlider' | 'zoom' | 'setTheme' | 'graph' | 'moveView' | 'animateSlider'
    > & {
      /** What rows would draw, without drawing them. */
      check(rows: string[]): CheckedRow[];
      searchFunctions(query: string): string;
      functionDoc(name: string): Promise<string>;
      listKinds(): string;
      kindExamples(kind: string): Promise<string>;
    };
  }
}

export function connectNativeApp(graph: NativeGraph): void {
  const post = (message: Message) => window.webkit?.messageHandlers?.equation?.postMessage(message);
  graph.onChange(rows => post({ type: 'rows', rows }));
  graph.onStatus(rows => post({ type: 'status', rows }));
  window.equationApp = {
    loadRows: rows => graph.loadRows(rows),
    editRows: rows => graph.editRows(rows),
    setSlider: (index, value) => graph.setSlider(index, value),
    zoom: factor => graph.zoom(factor),
    setTheme: mode => graph.setTheme(mode),
    graph: () => graph.graph(),
    moveView: (target, seconds) => graph.moveView(target, seconds),
    animateSlider: (name, to, seconds, from) => graph.animateSlider(name, to, seconds, from),
    check: rows => checkRows(rows),
    searchFunctions: query => searchFunctions(query),
    functionDoc: async name => functionDoc(await examples(), name),
    listKinds: () => listKinds(),
    kindExamples: async kind => kindExamples(await examples(), kind),
  };
  post({ type: 'ready' });
}

let index: Promise<ExamplesIndex> | undefined;

/** The examples menu indexed by kind and by function, built with the app (apple/vite.config.ts), read once. */
function examples(): Promise<ExamplesIndex> {
  index ??= fetch('/assistant.json').then(res =>
    res.ok ? (res.json() as Promise<ExamplesIndex>) : Promise.reject(new Error(`HTTP ${res.status}`)),
  );
  return index;
}
