/**
 * Records where the site puts a document's panels (lib/panels.ts
 * layoutPanels, linkRoot, panelAt) and the windows it gives them (lib/view.ts
 * fitView2D, linkedWindow, fitPanelWindow), so the Swift ports
 * (EquationCore/Panels.swift, EquationRender/PanelWindows.swift) are held to
 * the same boxes and windows.
 *
 *   node --experimental-transform-types --no-warnings apple/corpus/panels.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { type SplitSpec, layoutPanels, linkRoot, panelAt, parseDividerRow } from '../../lib/panels.ts';
import { type View2DSpec, type Window2D, fitPanelWindow, fitView2D, linkedWindow } from '../../lib/view.ts';

const num = (_key: string, value: unknown): unknown =>
  typeof value === 'number' && !Number.isSafeInteger(value) ? String(value) : value;

/** Documents' dividers, in order. */
const DIVIDERS: string[][] = [
  [],
  ['---'],
  ['--- right'],
  ['--- left 30%'],
  ['--- below 40%, shared x'],
  ['--- above 25%'],
  ['--- right 40%', '--- below'],
  ['---', '---', '---'],
  ['--- below, shared x', '--- below, shared x'],
  ['--- right, shared y', '--- below 33.3%, shared x y'],
  ['--- inset'],
  ['--- inset top left 30%'],
  ['--- inset bottom-right 90%'],
  ['--- right', '--- inset bottom left 45%, shared x', '--- below 60%'],
  ['--- inset', '--- inset top left', '--- right 1%'],
  ['--- below 99.9%', '--- right 0.1%', '--- left', '--- above', '--- inset 5%', '---', '---'],
];
const SIZES: Array<[number, number, number]> = [
  [1600, 1200, 24],
  [780, 1688, 36],
  [3, 2, 12],
  [1001, 777, 0],
];

const layouts = DIVIDERS.flatMap(rows =>
  SIZES.map(([w, h, margin]) => {
    const splits = rows.map(r => parseDividerRow(r) as SplitSpec);
    const layout = layoutPanels(splits, w, h, margin);
    const points: Array<[number, number]> = [];
    for (let k = 0; k < 12; k++) points.push([((k * 37 + 5) % 23) / 22, ((k * 53 + 11) % 19) / 18]);
    return {
      rows,
      w,
      h,
      margin,
      layout,
      roots: layout.map((_, i) => [linkRoot(layout, i, 'x'), linkRoot(layout, i, 'y')]),
      at: points.map(([fx, fy]) => [fx * w, fy * h, panelAt(layout, fx * w, fy * h)]),
    };
  }),
);
writeFileSync(
  new URL('../EquationCore/Tests/EquationCoreTests/Fixtures/panels.json', import.meta.url),
  JSON.stringify(layouts, num) + '\n',
);

const SPECS: View2DSpec[] = [
  { kind: 'view', x: [-5, 5] },
  { kind: 'view', y: [0, 1] },
  { kind: 'view', x: [-5, 5], y: [-2, 2] },
  { kind: 'view', x: [1, 100], y: [-3, 7], ratio: 2 },
  { kind: 'view', y: [-1, 2], ratio: 0.25 },
];
const WINDOWS: Window2D[] = [
  { cx: 0, cy: 0, upp: 0.01 },
  { cx: 3, cy: -2, upp: 0.02, ratio: 4 },
  { cx: -7.5, cy: 1e3, upp: 5, ratio: 0.1 },
];
const SHARED = [
  { x: false, y: false },
  { x: true, y: false },
  { x: false, y: true },
  { x: true, y: true },
];
const windows = {
  fit: SPECS.flatMap(spec => SIZES.map(([w, h]) => ({ spec, w, h, out: fitView2D(spec, w, h) }))),
  linked: WINDOWS.flatMap(own =>
    SHARED.flatMap(shared =>
      [
        {},
        { x: WINDOWS[1] },
        { y: WINDOWS[2] },
        { x: WINDOWS[2], y: WINDOWS[1] },
      ].map(from => ({ own, shared, from, out: linkedWindow(own, shared, from) })),
    ),
  ),
  panel: SPECS.flatMap(spec =>
    SHARED.flatMap(shared =>
      WINDOWS.map(linked => ({ spec, shared, linked, w: 800, h: 480, out: fitPanelWindow(spec, 800, 480, shared, linked) })),
    ),
  ),
};
const scenes = new URL('../EquationCore/Tests/EquationRenderTests/Scenes/Panels/', import.meta.url);
mkdirSync(scenes, { recursive: true });
writeFileSync(new URL('windows.json', scenes), JSON.stringify(windows, num) + '\n');
console.log(
  `${layouts.length} layouts; ${windows.fit.length + windows.linked.length + windows.panel.length} windows`,
);
