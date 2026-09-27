import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { layoutPanels, linkRoot, panelAt, panelIndices, parseDividerRow, parseGridRow, splitsOf } from './panels.ts';
import { formatCameraRow, formatViewRow, parseViewRow } from './view.ts';

describe('divider rows', () => {
  it('reads placement, size and shared axes in any order', () => {
    expect(parseDividerRow('---')).toEqual({ kind: 'split' });
    expect(parseDividerRow('----------')).toEqual({ kind: 'split' });
    expect(parseDividerRow('--- below 40%, shared x')).toEqual({
      kind: 'split',
      place: 'below',
      size: 0.4,
      shared: { x: true },
    });
    expect(parseDividerRow('--- 30% right shared y')).toEqual({
      kind: 'split',
      place: 'right',
      size: 0.3,
      shared: { y: true },
    });
    expect(parseDividerRow('--- shared x y above')).toEqual({
      kind: 'split',
      place: 'above',
      shared: { x: true, y: true },
    });
    expect(parseDividerRow('--- shared xy')?.shared).toEqual({ x: true, y: true });
    expect(parseDividerRow('--- top')?.place).toBe('above');
    expect(parseDividerRow('--- bottom')?.place).toBe('below');
  });

  it('reads insets with a corner, defaulting to the top right', () => {
    expect(parseDividerRow('--- inset')).toEqual({ kind: 'split', place: 'inset', corner: 'top-right' });
    expect(parseDividerRow('--- inset bottom left 25%')).toEqual({
      kind: 'split',
      place: 'inset',
      corner: 'bottom-left',
      size: 0.25,
    });
    expect(parseDividerRow('--- top-left')).toEqual({ kind: 'split', place: 'inset', corner: 'top-left' });
    expect(parseDividerRow('--- inset left')?.corner).toBe('top-left');
  });

  it('leaves negations as math', () => {
    expect(parseDividerRow('---x')).toBeNull();
    expect(parseDividerRow('--- x')).toBeNull();
    expect(parseDividerRow('---3')).toBeNull();
    expect(parseDividerRow('y = ---x')).toBeNull();
    expect(parseDividerRow('--')).toBeNull();
  });

  it('explains a malformed divider', () => {
    expect(() => parseDividerRow('--- below sideways')).toThrow(/"sideways" is not a divider option/);
    expect(() => parseDividerRow('--- top right')).toThrow(/inset top right/);
    expect(() => parseDividerRow('--- left right')).toThrow(/both left and right/);
    expect(() => parseDividerRow('--- below 100%')).toThrow(/between 0% and 100%/);
    expect(() => parseDividerRow('--- below shared')).toThrow(/shared x/);
    expect(() => parseDividerRow('--- 40% 50%')).toThrow(/twice/);
  });
});

describe('grid rows', () => {
  it('reads the modes and coordinate names', () => {
    expect(parseGridRow('grid(off)')).toEqual({ kind: 'grid', mode: 'off' });
    expect(parseGridRow('grid(none)')).toEqual({ kind: 'grid', mode: 'off' });
    expect(parseGridRow('grid(axes)')).toEqual({ kind: 'grid', mode: 'axes' });
    expect(parseGridRow('grid(on)')).toEqual({ kind: 'grid', mode: 'on' });
    expect(parseGridRow('grid(r, theta)')).toEqual({ kind: 'grid', mode: 'coords', coords: ['r', 'theta'] });
    expect(parseGridRow('grid(x, y)')).toEqual({ kind: 'grid', mode: 'coords', coords: ['x', 'y'] });
    expect(parseGridRow('y = grid(x)')).toBeNull();
    expect(() => parseGridRow('grid()')).toThrow(/grid\(off\)/);
    expect(() => parseGridRow('grid(r + 1)')).toThrow(/names coordinates/);
    expect(() => parseGridRow('grid(r, r)')).toThrow(/twice/);
  });
});

describe('locked viewports', () => {
  it('round-trip through the formatters', () => {
    expect(parseViewRow('view(x = -1..1, locked)', {})).toEqual({ kind: 'view', x: [-1, 1], locked: true });
    expect(parseViewRow('camera(0, 0.5, locked, 10)', {})).toEqual({
      kind: 'camera',
      theta: 0,
      phi: 0.5,
      radius: 10,
      locked: true,
    });
    const view = formatViewRow(-1, 1, -2, 2, 1, true);
    expect(view).toBe('view(x = -1..1, y = -2..2, locked)');
    expect(parseViewRow(view, {})).toMatchObject({ locked: true });
    const camera = formatCameraRow({ theta: 1, phi: 0.5, radius: 9, target: [0, 0, 0], locked: true });
    expect(camera).toBe('camera(1, 0.5, 9, locked)');
    expect(parseViewRow(camera, {})).toMatchObject({ locked: true });
  });
});

describe('layout', () => {
  const layout = (rows: string[], w = 1000, h = 600, margin = 0) =>
    layoutPanels(splitsOf(rows.map(t => ({ view: parseDividerRow(t) ?? undefined }))), w, h, margin);

  it('fills the canvas with one panel when nothing divides it', () => {
    expect(layout([]).map(p => p.rect)).toEqual([{ x: 0, y: 0, w: 1000, h: 600 }]);
  });

  it('splits along the longer side when no side is named', () => {
    expect(layout(['---']).map(p => p.rect)).toEqual([
      { x: 0, y: 0, w: 500, h: 600 },
      { x: 500, y: 0, w: 500, h: 600 },
    ]);
    expect(layout(['---'], 400, 800).map(p => p.rect)).toEqual([
      { x: 0, y: 0, w: 400, h: 400 },
      { x: 0, y: 400, w: 400, h: 400 },
    ]);
  });

  it('gives the new panel its share on the named side', () => {
    expect(layout(['--- below 25%']).map(p => p.rect)).toEqual([
      { x: 0, y: 0, w: 1000, h: 450 },
      { x: 0, y: 450, w: 1000, h: 150 },
    ]);
    expect(layout(['--- left 30%']).map(p => p.rect)).toEqual([
      { x: 300, y: 0, w: 700, h: 600 },
      { x: 0, y: 0, w: 300, h: 600 },
    ]);
    expect(layout(['--- above 50%'])[1].rect).toEqual({ x: 0, y: 0, w: 1000, h: 300 });
  });

  it('splits the most recent tiled panel, so a 3D scene can sit beside a stack of two', () => {
    const panels = layout(['--- right 40%', '--- below']);
    expect(panels.map(p => p.rect)).toEqual([
      { x: 0, y: 0, w: 600, h: 600 },
      { x: 600, y: 0, w: 400, h: 300 },
      { x: 600, y: 300, w: 400, h: 300 },
    ]);
    expect(panels.map(p => p.host)).toEqual([0, 0, 1]);
  });

  it('floats insets over their host after tiling', () => {
    const panels = layout(['--- inset bottom left 20%', '--- right 50%'], 1000, 600, 10);
    // The inset's host was narrowed by the later split; the inset follows it.
    expect(panels[0].rect).toEqual({ x: 0, y: 0, w: 500, h: 600 });
    expect(panels[1]).toMatchObject({ inset: true, host: 0, rect: { x: 10, y: 470, w: 100, h: 120 } });
    expect(panels[2].rect).toEqual({ x: 500, y: 0, w: 500, h: 600 });
  });

  it('finds the panel under a point, insets first', () => {
    const panels = layout(['--- right', '--- inset top-left 50%'], 1000, 600);
    expect(panelAt(panels, 100, 100)).toBe(0);
    expect(panelAt(panels, 600, 100)).toBe(2);
    expect(panelAt(panels, 900, 500)).toBe(1);
  });

  it('follows shared axes back to the panel that owns them', () => {
    const panels = layout(['--- below, shared x', '--- below, shared x', '--- right, shared y']);
    expect(linkRoot(panels, 2, 'x')).toBe(0);
    expect(linkRoot(panels, 1, 'y')).toBe(1);
    expect(linkRoot(panels, 3, 'y')).toBe(2);
    expect(linkRoot(panels, 3, 'x')).toBe(3);
  });
});

describe('panels in a document', () => {
  it('assign rows to the panel their divider opens', () => {
    const rows = ['y = x', '--- below', 'y = 2x', '---', 'z = x'];
    const a = analyzeRows(rows);
    expect(a.rows.map(r => r.error)).toEqual(rows.map(() => undefined));
    expect(panelIndices(a.rows)).toEqual([0, 1, 1, 2, 2]);
  });

  it('frames each panel with its own viewport rows', () => {
    const a = analyzeRows(['view(x = -1..1)', 'y = x', '---', 'view(x = -2..2)', 'camera(0, 0.5)', 'z = x y']);
    expect(a.rows.map(r => r.error)).toEqual(Array(6).fill(undefined));
    const again = analyzeRows(['---', 'view(x = -1..1)', 'view(x = -2..2)']);
    expect(again.rows[2].error).toMatch(/already set by another row in this panel/);
    const first = analyzeRows(['view(x = -1..1)', 'view(x = -2..2)']);
    expect(first.rows[1].error).toMatch(/--- row starts a new panel/);
  });

  it('checks grid coordinates against the document', () => {
    const a = analyzeRows(['r = sqrt(x^2 + y^2)', 'theta = atan2(y, x)', 'grid(r, theta)', 'grid(q)']);
    expect(a.rows[2].error).toBeUndefined();
    expect(a.rows[2].view).toEqual({ kind: 'grid', mode: 'coords', coords: ['r', 'theta'] });
    expect(a.rows[3].error).toMatch(/grid is already set|q is not a coordinate/);
    expect(analyzeRows(['grid(q)']).rows[0].error).toMatch(/q is not a coordinate/);
    expect(analyzeRows(['rho = sqrt(x^2+y^2+z^2)', 'grid(rho)']).rows[1].error).toMatch(/uses z/);
  });

  it('leaves a user-defined grid function alone', () => {
    const a = analyzeRows(['grid(x) = x^2', 'y = grid(x)']);
    expect(a.rows.map(r => r.error)).toEqual([undefined, undefined]);
  });

  it('reports a malformed divider on its row and still reads math negations', () => {
    const a = analyzeRows(['--- below sideways', 'y = ---x']);
    expect(a.rows[0].error).toMatch(/"sideways" is not a divider option/);
    expect(a.rows[1].error).toBeUndefined();
    expect(a.rows[1].cls).toBeDefined();
  });

  it('caps the number of panels', () => {
    const a = analyzeRows(Array(9).fill('---'));
    expect(a.rows[6].error).toBeUndefined();
    expect(a.rows[7].error).toMatch(/at most 8 panels/);
  });
});
