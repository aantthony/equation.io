/**
 * Mutable graph state shared by the session, the scene, and the editor.
 * A `let` binding cannot be reassigned from another ES module, so every
 * field that more than one of those files writes lives here.
 */
import { attachCapture } from './capture.ts';
import { emptyEnv, type Env } from '../lib/env.ts';
import type { GridField } from '../lib/grid.ts';
import type { StateSystem } from '../lib/state.ts';
import type { Camera3D } from './render3d.ts';
import type { View2D } from './render2d.ts';
import type { Grabbable, Panel } from './session.ts';

export const app = {
  nextId: 1,
  mode: '2d' as '2d' | '3d',
  defs: emptyEnv() as Env,
  /** Recolours names after `defs` changes. Set once the highlighter exists. */
  repaintHighlights: () => {},
  defsAnimated: false,
  constEnv: {} as Record<string, number>,
  /** Constants used as Σ/Π bounds; their sliders snap to integer steps. */
  sumBoundNames: new Set<string>(),
  runtimeSliders: new Set<string>(),
  /** Constants that are a whole-number distribution parameter. */
  wholeParamNames: new Set<string>(),
  /** The `a' = …` system being integrated. Null when no row defines a state. */
  stateSys: null as StateSystem | null,
  stateVals: {} as Record<string, number>,
  gridFields: [] as GridField[],
  /** The panel each coordinate field is defined in. */
  gridFieldPanels: new Map<string, number>(),
  /** Key of the point under the pointer, drawn with a ring. */
  hotPoint: null as string | null,
  activePanel: undefined as unknown as Panel,
  cur: undefined as unknown as Panel,
  view: undefined as unknown as View2D,
  camera: undefined as unknown as Camera3D,
  drops: undefined as unknown as Array<{ x: number; y: number }>,
  grabbable: undefined as unknown as Grabbable[],
  capture: undefined as ReturnType<typeof attachCapture> | undefined,
  refineTimer: null as ReturnType<typeof setTimeout> | null,
  rendererDisposed: false,
  viewportWriteTimer: null as ReturnType<typeof setTimeout> | null,
  graphChanged: undefined as ((rows: string[]) => void) | undefined,
  graphEdited: undefined as (() => void) | undefined,
  traceWorker: undefined as Worker | undefined,
};
