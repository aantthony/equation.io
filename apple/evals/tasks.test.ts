import { describe, expect, it } from 'vitest';
import { Episode } from './episode.ts';
import { TASKS } from './tasks.ts';

describe('eval tasks', () => {
  it('have unique ids', () => {
    expect(new Set(TASKS.map(t => t.id)).size).toBe(TASKS.length);
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
