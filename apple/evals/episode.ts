/**
 * One run of one task: the graph it starts from, every tool call the model
 * makes on it (answered as the app answers), and the grade at the end.
 */
import type { MoveViewTarget } from '../../web/voice.ts';
import { type Check, type Outcome, type ToolCall, grade } from './checks.ts';
import { EvalGraph, readSyntax } from './graph.ts';

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export class Episode {
  readonly graph: EvalGraph;
  readonly start;
  readonly calls: ToolCall[] = [];

  constructor(rows: string[]) {
    this.graph = new EvalGraph(rows);
    this.start = this.graph.graph().rows;
  }

  /**
   * A tool call as the app's bridge answers it: the JSON text of what
   * window.equationApp returns (GraphBridge.ask stringifies it).
   */
  call(tool: string, args: Record<string, unknown>): string {
    let result: unknown;
    if (tool === 'get_graph') result = this.graph.graph();
    else if (tool === 'set_graph') {
      const rows = Array.isArray(args.equations)
        ? args.equations.filter((e): e is string => typeof e === 'string')
        : [];
      this.graph.set(rows.map(r => r.trim()).filter(Boolean));
      result = this.graph.graph();
    } else if (tool === 'move_view') {
      const { seconds, ...target } = args;
      result = this.graph.moveView(target as MoveViewTarget, num(seconds) ? seconds : 1.5);
    } else if (tool === 'animate_slider') {
      const { name, to, from, seconds } = args;
      result =
        typeof name === 'string' && num(to)
          ? this.graph.animateSlider(name, to, num(seconds) ? seconds : 3, num(from) ? from : undefined)
          : { error: 'name must be a string, to and from numbers' };
    } else if (tool === 'read_syntax') result = readSyntax(typeof args.query === 'string' ? args.query : '');
    else result = { error: `unknown tool ${tool}` };
    this.calls.push({ tool, args, result });
    return JSON.stringify(result);
  }

  outcome(reply: string): Outcome {
    return { start: this.start, rows: this.graph.graph().rows, graph: this.graph, calls: this.calls, reply };
  }

  grade(checks: Check[], reply: string) {
    return grade(checks, this.outcome(reply));
  }
}
