import { describe, expect, it } from 'vitest';
import { MAX_LEGEND_CHARS, screenshotLegend } from './voice-agent.ts';

describe('screenshotLegend', () => {
  it('lists each row with its color and kind, and the window', () => {
    const legend = screenshotLegend({
      window: { x: [-10, 10], y: [-6, 6] },
      rows: [
        { text: 'y = x^2', status: 'ok', kind: 'implicit2d', color: '#2d70b3' },
        { text: '', status: 'ok' },
        { text: 'y = foo(x)', status: 'error', error: 'Unknown function foo.' },
      ],
    });
    expect(legend).toContain('- y = x^2 (#2d70b3, implicit2d)');
    expect(legend).toContain('- y = foo(x) (not drawn: Unknown function foo.)');
    expect(legend).toContain('Visible window: x from -10 to 10, y from -6 to 6.');
    expect(legend).not.toContain('panel');
  });

  it('stays under the Worker limit for a long inline list and many rows', () => {
    const list = `L = [${Array.from({ length: 1100 }, (_, i) => i * 1.2345).join(', ')}]`;
    const many = Array.from({ length: 400 }, (_, i) => ({
      text: `y = x + ${i} # a note on row ${i}`,
      status: 'ok' as const,
      kind: 'implicit2d',
      color: '#123456',
    }));
    const legend = screenshotLegend({ rows: [{ text: list, status: 'ok', kind: 'vlist' }, ...many] });
    expect(legend.length).toBeLessThanOrEqual(MAX_LEGEND_CHARS);
    expect(legend).toMatch(/- L = \[0, 1\.2345, .*… \(vlist\)/);
    expect(legend).toMatch(/- … and \d+ more rows\n/);
    expect(legend).toContain('The graph is a 3D view.');
  });
});
