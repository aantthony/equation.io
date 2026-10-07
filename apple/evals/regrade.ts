/**
 * Grades a results file again with the current checks, by replaying each
 * run's tool calls on a fresh graph: for when a check was wrong, without
 * running the model again. Rewrites the file, noting when it was regraded.
 *
 *   node --experimental-transform-types apple/evals/regrade.ts apple/evals/results/a.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Episode } from './episode.ts';
import { type Results, report } from './report.ts';
import { TASKS } from './tasks.ts';

const path = process.argv[2];
const results = JSON.parse(readFileSync(path, 'utf8')) as Results & { regraded?: string };
for (const task of results.tasks) {
  const found = TASKS.find(t => t.id === task.id);
  if (!found) continue;
  for (const run of task.runs) {
    const episode = new Episode(found.rows);
    for (const call of run.calls) episode.call(call.tool, call.args as Record<string, unknown>);
    const { pass, checks } = episode.grade(found.checks, run.reply);
    run.checks = checks;
    // A run the model never finished stays failed.
    run.pass = pass && !run.error;
  }
}
results.regraded = new Date().toISOString();
writeFileSync(path, JSON.stringify(results, null, 2) + '\n');
console.log(report(results));
