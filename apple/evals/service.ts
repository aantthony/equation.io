/**
 * The evals' graph, as a service for the Swift runner (Runner.swift): one
 * JSON request per line on stdin, one JSON answer per line on stdout.
 *
 *   {"cmd": "tasks"}                          → {tasks: [{id, tags, rows, request}]}
 *   {"cmd": "start", "task": id, "variant"?}  → {rows, status}: the starting graph, as the app's editor reports it
 *                                               (variant: whose instructions, lib/assistant-instructions.ts)
 *   {"cmd": "tool", "name": …, "args": {…}}   → {output}: the tool's answer, as the app's bridge returns it
 *   {"cmd": "status"}                         → {rows, status}: the graph now, as "start" reports it
 *   {"cmd": "grade", "reply": …}              → {pass, checks, rows, calls}
 *   {"cmd": "report", "path": …}              → {text}: the summary of a results file (report.ts)
 *
 *   node --experimental-transform-types apple/evals/service.ts
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Episode } from './episode.ts';
import { report } from './report.ts';
import { TASKS } from './tasks.ts';

let task = TASKS[0];

/** The rows and Chat.swift's RowStatus for each: the fields the prompt's row report and the follow-up read, and the rest it decodes. */
const nativeState = (episode: Episode) => ({
  rows: episode.graph.rows,
  status: episode.graph.nativeStatus().map(s => ({ ...s, color: null, note: null, spans: [], slider: null })),
});
let episode: Episode | undefined;

function answer(request: Record<string, unknown>): unknown {
  switch (request.cmd) {
    case 'tasks':
      return { tasks: TASKS.map(({ id, tags, rows, request }) => ({ id, tags, rows, request })) };
    case 'start': {
      const found = TASKS.find(t => t.id === request.task);
      if (!found) return { error: `no task ${String(request.task)}` };
      task = found;
      episode = new Episode(task.rows, request.variant === 'reference' ? 'reference' : 'text');
      return nativeState(episode);
    }
    case 'status':
      return episode ? nativeState(episode) : { error: 'no task started' };
    case 'tool': {
      if (!episode) return { error: 'no task started' };
      const args = request.args && typeof request.args === 'object' ? (request.args as Record<string, unknown>) : {};
      return { output: episode.call(String(request.name), args) };
    }
    case 'grade': {
      if (!episode) return { error: 'no task started' };
      const reply = typeof request.reply === 'string' ? request.reply : '';
      const { pass, checks } = episode.grade(task.checks, reply);
      const calls = episode.calls.map(({ tool, args, result }) => ({
        tool,
        args,
        ...(result && typeof result === 'object' && 'error' in result ? { error: result.error } : {}),
      }));
      return { pass, checks, rows: episode.graph.rows, calls };
    }
    case 'report':
      return { text: report(JSON.parse(readFileSync(String(request.path), 'utf8'))) };
    default:
      return { error: `unknown command ${String(request.cmd)}` };
  }
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  let out: unknown;
  try {
    out = answer(JSON.parse(line));
  } catch (e) {
    out = { error: e instanceof Error ? e.message : String(e) };
  }
  process.stdout.write(JSON.stringify(out) + '\n');
}
