import type { Expr } from './expr.ts';

export interface TraceInput {
  residuals: Expr[];
  dim: 2 | 3;
  lo: number[];
  hi: number[];
  env: Record<string, number>;
  angular?: boolean[];
}
export type TraceResult = { pts: number[][]; error?: string };
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
