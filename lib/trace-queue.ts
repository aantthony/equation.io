import type { Expr } from './expr.ts';
import { type Defs, animatedConstNames, definitionDependencies } from './defs.ts';

/** Separate moving values from the definitions and fixed inputs of a trace.
 * Completed geometry may lag time/state changes, but never edits or sliders. */
export function traceEnvironment(params: readonly string[], animated: boolean, defs: Defs) {
  const moving = new Set([...animatedConstNames(defs), ...defs.states.keys(), 't']);
  const names = [...definitionDependencies(params, defs)];
  const fixed = names.filter(n => !moving.has(n));
  const definitions = JSON.stringify(names.map(n => [n, defs.consts.get(n), defs.states.get(n)]));
  return (env: Record<string, number>, time: number) => ({
    env: JSON.stringify([definitions, params.map(n => env[n] ?? 0), animated ? time : null]),
    stableEnv: JSON.stringify([definitions, fixed.map(n => env[n] ?? 0)]),
  });
}

export interface TraceInput {
  kind?: 'system' | 'field' | 'intersection' | 'certify';
  glyphs?: boolean;
  residuals: Expr[];
  dim: 2 | 3;
  lo: number[];
  hi: number[];
  env: Record<string, number>;
  angular?: boolean[];
}
export type TraceResult = { pts: number[][]; info?: string; error?: string };
export type TraceMessage = { token: number; input: TraceInput };
interface Job extends TraceMessage {
  row: number;
  key: string;
  receive: (result: TraceResult) => void;
}

/** One running trace, at most one latest pending view per row. Wheel events
 * must never build a FIFO backlog of obsolete, expensive solver jobs. */
export class TraceQueue {
  private pending = new Map<number, Job>();
  private active?: Job;
  private token = 0;
  constructor(private send: (message: TraceMessage) => void) {}

  request(row: number, key: string, input: TraceInput, receive: Job['receive']) {
    if (this.active?.row === row && this.active.key === key) {
      this.pending.delete(row);
      return;
    }
    this.pending.set(row, { row, key, input, receive, token: ++this.token });
    this.pump();
  }

  cancelPending(row: number) {
    this.pending.delete(row);
  }

  /** Discard work during teardown; late worker replies cannot restart it. */
  clear() {
    this.pending.clear();
    this.active = undefined;
  }

  complete(token: number, result: TraceResult) {
    if (this.active?.token !== token) return;
    const job = this.active;
    this.active = undefined;
    job.receive(result);
    this.pump();
  }

  private pump() {
    if (this.active) return;
    const job = this.pending.values().next().value;
    if (!job) return;
    this.pending.delete(job.row);
    this.active = job;
    this.send({ token: job.token, input: job.input });
  }
}
