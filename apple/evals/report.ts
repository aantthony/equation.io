/**
 * Summaries of the runner's results files (apple/evals/results/*.json).
 *
 *   node --experimental-transform-types apple/evals/report.ts results/a.json            # one run
 *   node --experimental-transform-types apple/evals/report.ts results/a.json results/b.json  # b against a
 */
import { readFileSync } from 'node:fs';

export interface RunResult {
  pass: boolean;
  checks: { name: string; pass: boolean; why?: string }[];
  reply: string;
  rows: string[];
  calls: { tool: string; args: unknown; error?: unknown }[];
  /** The session's input and output tokens, where the model reports them. */
  inputTokens?: number;
  outputTokens?: number;
  /** Hosted models: input served from the prompt cache, and output spent reasoning. */
  cachedInputTokens?: number;
  reasoningTokens?: number;
  seconds: number;
  /** The model failed (context overflow, guardrail, timeout) before replying. */
  error?: string;
}

export interface Results {
  model: string;
  /** A hosted model's exact snapshot, as its API named it. */
  modelId?: string;
  date: string;
  runs: number;
  contextSize?: number;
  /** Tokens the instructions and tool definitions take before any request. */
  instructionsTokens?: number;
  toolsTokens?: number;
  /** What the model knew the language from: the app's lookup tools, or a whole reference in its instructions (Runner.swift --reference). */
  knowledge?: 'tools' | 'reference';
  reference?: { path: string; bytes: number };
  tasks: { id: string; request: string; runs: RunResult[] }[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map(x => (x - m) ** 2)));
};
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** gpt-5.5's price per million tokens: input, cached input, output (third-party listings; see RESULTS.md). */
const PRICE = { input: 5, cached: 0.5, output: 30 };

/** What a hosted run cost, from its token counts; undefined for the on-device model. */
export function cost(runs: RunResult[]): number | undefined {
  if (!runs.some(r => r.cachedInputTokens !== undefined)) return undefined;
  const sum = (f: (r: RunResult) => number | undefined) => runs.reduce((s, r) => s + (f(r) ?? 0), 0);
  const cached = sum(r => r.cachedInputTokens);
  const input = sum(r => r.inputTokens) - cached;
  return (input * PRICE.input + cached * PRICE.cached + sum(r => r.outputTokens) * PRICE.output) / 1e6;
}
const fixed = (x: number, digits = 1) => (Number.isFinite(x) ? x.toFixed(digits) : '–');

/** Overall pass rate, and its spread across repetitions (each repetition runs every task once). */
export function overall(results: Results) {
  const all = results.tasks.flatMap(t => t.runs);
  const byRepetition = Array.from({ length: results.runs }, (_, k) =>
    mean(results.tasks.filter(t => t.runs[k]).map(t => (t.runs[k].pass ? 1 : 0))),
  );
  return { rate: mean(all.map(r => (r.pass ? 1 : 0))), sd: sd(byRepetition), runs: all.length };
}

/** Runs the 8K context ran out in: the framework says so in two ways. */
const overflowed = (run: RunResult) => /context size exceeded|maximum allowed is/.test(run.error ?? '');

/** Tool calls per run, by tool, most used first. */
function callsByTool(runs: RunResult[]): string {
  const counts = new Map<string, number>();
  for (const call of runs.flatMap(r => r.calls)) counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([tool, n]) => `${tool} ${fixed(n / runs.length, 2)}`)
    .join(', ');
}

/** The check a task fails most often, and how often. */
function commonFailure(runs: RunResult[]): string {
  const counts = new Map<string, number>();
  for (const run of runs) {
    if (run.error) counts.set(`error: ${run.error}`, (counts.get(`error: ${run.error}`) ?? 0) + 1);
    for (const c of run.checks) if (!c.pass) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  // A check named by a regex may hold a |, which would split the table cell.
  return top ? `${top[0].replaceAll('|', '\\|')} (${top[1]}/${runs.length})` : '';
}

export function report(results: Results): string {
  const { rate, sd: spread, runs } = overall(results);
  const all = results.tasks.flatMap(t => t.runs);
  const spent = cost(all);
  const lines = [
    `${results.modelId ?? results.model}, ${results.date}: ${results.tasks.length} tasks × ${results.runs} runs` +
      (results.knowledge === 'reference'
        ? `, the reference in context (${results.reference?.path}, ${results.reference?.bytes} bytes)`
        : ''),
    `Pass rate ${pct(rate)} (${all.filter(r => r.pass).length}/${runs}), ±${pct(spread)} across repetitions`,
    `Per run: ${fixed(mean(all.map(r => r.calls.length)))} tool calls, ` +
      `${fixed(mean(all.flatMap(r => r.inputTokens ?? [])), 0)} input + ${fixed(mean(all.flatMap(r => r.outputTokens ?? [])), 0)} output tokens, ` +
      (all.some(r => r.cachedInputTokens !== undefined)
        ? `(${fixed(mean(all.flatMap(r => r.cachedInputTokens ?? [])), 0)} cached, ${fixed(mean(all.flatMap(r => r.reasoningTokens ?? [])), 0)} reasoning), `
        : '') +
      `${fixed(mean(all.map(r => r.seconds)))} s` +
      (results.instructionsTokens !== undefined
        ? `; instructions ${results.instructionsTokens} + tools ${results.toolsTokens} tokens of ${results.contextSize}`
        : ''),
    `Context overflows: ${all.filter(overflowed).length}. Calls per run by tool: ${callsByTool(all)}` +
      (spent === undefined ? '' : `. Cost about $${spent.toFixed(2)}`),
    '',
    '| task | pass | calls | tokens in/out | most common failure |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const task of results.tasks) {
    const passed = task.runs.filter(r => r.pass).length;
    lines.push(
      `| ${task.id} | ${passed}/${task.runs.length} | ${fixed(mean(task.runs.map(r => r.calls.length)))} | ` +
        `${fixed(mean(task.runs.flatMap(r => r.inputTokens ?? [])), 0)}/${fixed(mean(task.runs.flatMap(r => r.outputTokens ?? [])), 0)} | ` +
        `${commonFailure(task.runs)} |`,
    );
  }
  return lines.join('\n');
}

/** Per-task pass rates of `after` against `before`. */
export function compare(before: Results, after: Results): string {
  const a = overall(before);
  const b = overall(after);
  const runsOf = (r: Results) => r.tasks.flatMap(t => t.runs);
  const lines = [
    `${before.model} ${before.date} → ${after.model} ${after.date}`,
    `Pass rate ${pct(a.rate)} ±${pct(a.sd)} → ${pct(b.rate)} ±${pct(b.sd)}`,
    `Context overflows ${runsOf(before).filter(overflowed).length} → ${runsOf(after).filter(overflowed).length}`,
    '',
    '| task | before | after |',
    '| --- | --- | --- |',
  ];
  const rateOf = (r: Results, id: string) => {
    const runs = r.tasks.find(t => t.id === id)?.runs ?? [];
    return runs.length ? `${runs.filter(x => x.pass).length}/${runs.length}` : '–';
  };
  for (const id of new Set([...before.tasks, ...after.tasks].map(t => t.id)))
    lines.push(`| ${id} | ${rateOf(before, id)} | ${rateOf(after, id)} |`);
  return lines.join('\n');
}

if (import.meta.main) {
  const [first, second] = process.argv.slice(2).map(p => JSON.parse(readFileSync(p, 'utf8')) as Results);
  if (!first) {
    console.error('usage: report.ts results.json [later.json]');
    process.exit(1);
  }
  console.log(second ? compare(first, second) : report(first));
}
