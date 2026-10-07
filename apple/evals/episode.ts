/**
 * One run of one task: the graph it starts from, every tool call the model
 * makes on it (answered as the app answers), and the grade at the end.
 */
import {
  type ExamplesIndex,
  checkRows,
  examplesIndex,
  functionDoc,
  kindExamples,
  listKinds,
  searchFunctions,
} from '../../lib/assistant-tools.ts';
import { EXAMPLES } from '../../web/examples.ts';
import type { MoveViewTarget } from '../../web/voice.ts';
import { type Check, type Outcome, type ToolCall, grade } from './checks.ts';
import { EvalGraph, readSyntax } from './graph.ts';

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The examples menu by kind and function, as the app bundles it (apple/vite.config.ts). */
let index: ExamplesIndex | undefined;
const examples = () =>
  (index ??= examplesIndex(EXAMPLES.flatMap(([, items]) => items.map(([label, rows]) => [label, rows] as const))));

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
   * window.equationApp returns (GraphBridge.ask stringifies it), or the text
   * itself (GraphAccess decodes a string). read_syntax answers as it did
   * before list_kinds and the rest replaced it, for regrading older results.
   */
  call(tool: string, args: Record<string, unknown>): string {
    let result: unknown;
    const rows = Array.isArray(args.equations) ? args.equations.filter((e): e is string => typeof e === 'string') : [];
    if (tool === 'get_graph') result = this.graph.graph();
    else if (tool === 'set_graph') {
      this.graph.set(rows.map(r => r.trim()).filter(Boolean));
      result = this.graph.graph();
    } else if (tool === 'check') result = checkRows(rows);
    else if (tool === 'move_view') {
      const { seconds, ...target } = args;
      result = this.graph.moveView(target as MoveViewTarget, num(seconds) ? seconds : 1.5);
    } else if (tool === 'animate_slider') {
      const { name, to, from, seconds } = args;
      result =
        typeof name === 'string' && num(to)
          ? this.graph.animateSlider(name, to, num(seconds) ? seconds : 3, num(from) ? from : undefined)
          : { error: 'name must be a string, to and from numbers' };
    } else if (tool === 'search_functions') result = searchFunctions(text(args.query));
    else if (tool === 'function_doc') result = functionDoc(examples(), text(args.name));
    else if (tool === 'list_kinds') result = listKinds();
    else if (tool === 'kind_examples') result = kindExamples(examples(), text(args.kind));
    else if (tool === 'read_syntax') result = readSyntax(text(args.query));
    else result = { error: `unknown tool ${tool}` };
    this.calls.push({ tool, args, result });
    return typeof result === 'string' ? result : JSON.stringify(result);
  }

  outcome(reply: string): Outcome {
    return { start: this.start, rows: this.graph.graph().rows, graph: this.graph, calls: this.calls, reply };
  }

  grade(checks: Check[], reply: string) {
    return grade(checks, this.outcome(reply));
  }
}
