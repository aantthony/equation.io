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
  seconds: number;
  /** The model failed (context overflow, guardrail, timeout) before replying. */
  error?: string;
}

export interface Results {
  model: string;
  date: string;
  runs: number;
  contextSize?: number;
  /** Tokens the instructions and tool definitions take before any request. */
  instructionsTokens?: number;
  toolsTokens?: number;
  tasks: { id: string; request: string; runs: RunResult[] }[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map(x => (x - m) ** 2)));
};
const pct = (x: number) => `${Math.round(x * 100)}%`;
const fixed = (x: number, digits = 1) => (Number.isFinite(x) ? x.toFixed(digits) : '–');

/** Overall pass rate, and its spread across repetitions (each repetition runs every task once). */
export function overall(results: Results) {
  const all = results.tasks.flatMap(t => t.runs);
  const byRepetition = Array.from({ length: results.runs }, (_, k) =>
    mean(results.tasks.filter(t => t.runs[k]).map(t => (t.runs[k].pass ? 1 : 0))),
  );
  return { rate: mean(all.map(r => (r.pass ? 1 : 0))), sd: sd(byRepetition), runs: all.length };
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
  const lines = [
    `${results.model}, ${results.date}: ${results.tasks.length} tasks × ${results.runs} runs`,
    `Pass rate ${pct(rate)} (${all.filter(r => r.pass).length}/${runs}), ±${pct(spread)} across repetitions`,
    `Per run: ${fixed(mean(all.map(r => r.calls.length)))} tool calls, ` +
      `${fixed(mean(all.flatMap(r => r.inputTokens ?? [])), 0)} input + ${fixed(mean(all.flatMap(r => r.outputTokens ?? [])), 0)} output tokens, ` +
      `${fixed(mean(all.map(r => r.seconds)))} s` +
      (results.instructionsTokens !== undefined
        ? `; instructions ${results.instructionsTokens} + tools ${results.toolsTokens} tokens of ${results.contextSize}`
        : ''),
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
  const lines = [
    `${before.model} ${before.date} → ${after.model} ${after.date}`,
    `Pass rate ${pct(a.rate)} ±${pct(a.sd)} → ${pct(b.rate)} ±${pct(b.sd)}`,
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
