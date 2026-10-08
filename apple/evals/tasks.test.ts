import { describe, expect, it } from 'vitest';
import { readReference } from '../../scripts/reference.ts';
import { Episode } from './episode.ts';
import { TASKS } from './tasks.ts';

describe('eval tasks', () => {
  it('have unique ids', () => {
    expect(new Set(TASKS.map(t => t.id)).size).toBe(TASKS.length);
  });

  // The model copies what a lookup shows: no named shape may show a task's answer.
  it("aren't answered by a named shape's rows", () => {
    const tidy = (row: string) => row.replace(/\s+/g, '');
    const answers = new Set(
      TASKS.flatMap(task =>
        task.good.flatMap(answer =>
          answer.steps.flatMap(([tool, args]) =>
            tool === 'set_graph' ? (args.equations as string[]).filter(row => !task.rows.includes(row)) : [],
          ),
        ),
      ).map(tidy),
    );
    const shown = readReference().shapes.flatMap(shape =>
      shape.forms.flatMap(form => [...form.rows, ...form.example.rows].map(row => `${shape.name}: ${row}`)),
    );
    expect(shown.filter(row => answers.has(tidy(row.slice(row.indexOf(': ') + 2))))).toEqual([]);
  });

  for (const task of TASKS) {
    describe(task.id, () => {
      it('starts from a graph without errors', () => {
        expect(new Episode(task.rows).start.filter(r => r.status === 'error')).toEqual([]);
      });

      task.good.forEach((answer, k) =>
        it(`passes known-good answer ${k + 1}`, () => {
          const episode = new Episode(task.rows);
          for (const [tool, args] of answer.steps) episode.call(tool, args);
          const failed = episode.grade(task.checks, answer.reply).checks.filter(c => !c.pass);
          expect(failed).toEqual([]);
        }),
      );

      (task.bad ?? []).forEach((answer, k) =>
        it(`fails known-bad answer ${k + 1}`, () => {
          const episode = new Episode(task.rows);
          for (const [tool, args] of answer.steps) episode.call(tool, args);
          expect(episode.grade(task.checks, answer.reply).pass).toBe(false);
        }),
      );
    });
  }
});
