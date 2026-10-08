/**
 * The assistant's eval tasks: a starting graph, a request, and checks a run
 * must pass (on top of checks.ts ALWAYS: no errors or warnings, one shape
 * per row, a reply that names only what was drawn).
 *
 * Each task carries at least one known-good answer, which must pass, and the
 * observed failures as known-bad answers, which must fail (tasks.test.ts):
 * so a task that can't be passed, or a check that misses the failure it was
 * written for, shows up before any model runs.
 */
import { evaluate } from '../../lib/expr.ts';
import { START_WINDOW } from './graph.ts';
import {
  type Check,
  animated,
  anyOf,
  called,
  complexFunction,
  curveAvoids,
  curveFollowsSlider,
  curveThrough,
  curvesThrough,
  drawnCount,
  hasKind,
  keeps,
  labelAt,
  noFailedCalls,
  type Outcome,
  parametric,
  parametricCurve,
  parametricSurface,
  pointAt,
  replySays,
  rowsLike,
  shape3D,
  unitCube,
  sliderUsed,
  surfaceThrough,
  unchanged,
  value,
} from './checks.ts';

/** A tool call, as [tool, arguments]. */
export type Step = [string, Record<string, unknown>];

export interface Answer {
  steps: Step[];
  reply: string;
}

export interface EvalTask {
  id: string;
  /** What the task is about, for the report. */
  tags: string[];
  rows: string[];
  request: string;
  checks: Check[];
  good: Answer[];
  bad?: Answer[];
}

const set = (...equations: string[]): Step => ['set_graph', { equations }];
const move = (target: Record<string, unknown>): Step => ['move_view', target];
const animate = (name: string, to: number, from?: number): Step => [
  'animate_slider',
  from === undefined ? { name, to } : { name, to, from },
];
const answer = (reply: string, ...steps: Step[]): Answer => ({ steps, reply });

const width = (r: unknown) => (Array.isArray(r) && r.length === 2 ? (r[1] as number) - (r[0] as number) : NaN);
const contains = (r: unknown, v: number) => Array.isArray(r) && r.length === 2 && r[0] < v && v < r[1];
const START_WIDTH = START_WINDOW.x[1] - START_WINDOW.x[0];

/** Points that no plane holds: their covariance matrix is not singular. */
const notPlanar = (samples: number[][]) => {
  const n = samples.length;
  const mean = [0, 1, 2].map(i => samples.reduce((s, p) => s + p[i], 0) / n);
  const c = [0, 1, 2].map(i =>
    [0, 1, 2].map(j => samples.reduce((s, p) => s + (p[i] - mean[i]) * (p[j] - mean[j]), 0) / n),
  );
  const det =
    c[0][0] * (c[1][1] * c[2][2] - c[1][2] * c[2][1]) -
    c[0][1] * (c[1][0] * c[2][2] - c[1][2] * c[2][0]) +
    c[0][2] * (c[1][0] * c[2][1] - c[1][1] * c[2][0]);
  return det > 1e-6;
};

export const TASKS: EvalTask[] = [
  // The observed failures.
  {
    id: 'unit-cube',
    tags: ['3d', 'observed'],
    rows: [],
    request: 'Draw a unit cube',
    checks: [unitCube(), drawnCount(1, 1)],
    good: [
      answer('Here is the unit cube.', set('(interval(0, 1), interval(0, 1), interval(0, 1))')),
      answer('A unit cube, drawn as the hull of its corners.', set('hull(([0,1],[0,1],[0,1]))')),
    ],
    bad: [
      // The observed mash-up of the reference's helix and cube examples.
      answer('I drew a unit cube as a solid.', set('(interval(0,1), 0, 0), (2cos(6pi u), 2sin(6pi u), 2u - 2)')),
      answer('I drew a unit cube.', set('(2cos(6pi u), 2sin(6pi u), 4u - 2)')),
      // A 2D triangle: list_kinds' polygon form, copied.
      answer('I drew a unit cube as a polygon.', set('polygon((0, 0), (2, 0), (1, 2))')),
      // A 1 × 2 × 3 box: list_kinds' solid form, copied.
      answer('I drew a unit cube as a solid.', set('(interval(0, 1), interval(0, 2), interval(0, 3))')),
      answer('A unit cube.', set('hull(([0,2],[0,2],[0,2]))')),
    ],
  },
  {
    id: 'unit-cube-beside-sphere',
    tags: ['3d', 'observed', 'keep'],
    rows: ['x^2 + y^2 + z^2 = 4'],
    request: 'Add a unit cube',
    checks: [unitCube(), keeps('x^2 + y^2 + z^2 = 4'), drawnCount(2, 2)],
    good: [
      answer(
        'Added a unit cube inside the sphere.',
        set('x^2 + y^2 + z^2 = 4', '(interval(0, 1), interval(0, 1), interval(0, 1))'),
      ),
    ],
    bad: [
      answer('Added a unit cube.', set('(interval(0, 1), interval(0, 1), interval(0, 1))')),
      answer('Added a unit cube.', set('x^2 + y^2 + z^2 = 4', 'polygon((0, 0), (1, 0), (1, 1), (0, 1))')),
    ],
  },
  {
    id: 'slider-amplitude',
    tags: ['slider', 'observed'],
    rows: ['y = sin(x)'],
    request: 'Add a slider for the amplitude',
    checks: [sliderUsed(), rowsLike(/sin/, 1), drawnCount(1, 1)],
    good: [answer('Added a slider A for the amplitude.', set('A = 1', 'y = A sin(x)'))],
    bad: [answer('Added a slider A for the amplitude.', set('y = sin(x)', 'A = 1'))],
  },
  {
    id: 'slider-radius',
    tags: ['slider', 'observed'],
    rows: ['x^2 + y^2 = 4'],
    request: 'Add a slider for the radius',
    checks: [sliderUsed(), drawnCount(1, 1)],
    good: [answer('The radius is now the slider r.', set('r = 2', 'x^2 + y^2 = r^2'))],
    bad: [answer('Added a radius slider.', set('x^2 + y^2 = 4', 'r = 2'))],
  },
  {
    id: 'make-it-move',
    tags: ['animation', 'observed'],
    rows: ['y = sin(x)'],
    request: 'Make it move',
    checks: [animated(/sin/), rowsLike(/sin/, 1)],
    good: [answer('The sine wave now travels to the right.', set('y = sin(x - t)'))],
    bad: [answer('Now it moves.', set('y = sin(x)', 'y = sin(x - t)'))],
  },
  {
    id: 'animate-parabola',
    tags: ['animation', 'observed'],
    rows: ['y = x^2'],
    request: 'Animate it',
    // Still a parabola: x^2, x*x, or a shifted (x - …)^2, but not sin(x - t)^2.
    checks: [animated(/x\^2|x\s*\*\s*x|(?<![a-z])\(\s*x\s*[-+].*?\)\s*\^\s*2/), drawnCount(1, 1)],
    good: [
      answer('The parabola now rises and falls.', set('y = x^2 + sin(t)')),
      answer('The parabola now slides to the right.', set('y = (x - t)^2')),
      answer('The parabola now sways side to side.', set('y = (x - sin(t))^2')),
    ],
    bad: [
      answer('Animated.', set('y = x^2', 'y = x^2 + sin(t)')),
      answer('The parabola now moves.', set('y = sin(x - t)^2')),
    ],
  },
  {
    id: 'show-frequency',
    tags: ['slider', 'animation', 'observed', 'order'],
    rows: ['y = sin(x)'],
    request: 'Show me what changing the frequency does',
    checks: [
      sliderUsed(),
      rowsLike(/sin/, 1),
      // A frequency, not an amplitude: the slider multiplies x inside sin.
      rowsLike(/sin\(\s*([a-z]\w*\s*\*?\s*x|x\s*\*?\s*[a-z]\w*)\s*\)/i, 1),
      noFailedCalls('animate_slider'),
      called('animate_slider', 'glides a slider'),
    ],
    good: [answer('As k grows the waves bunch up.', set('k = 1', 'y = sin(k x)'), animate('k', 3))],
    bad: [
      // Animating the slider before creating it.
      answer('As k grows the waves bunch up.', animate('k', 3), set('k = 1', 'y = sin(k x)')),
      // Observed: an amplitude slider for a frequency request.
      answer('Watch the wave stretch as A grows.', set('A = 1', 'y = A sin(x)'), animate('A', 2)),
    ],
  },
  {
    id: 'animate-existing-slider',
    tags: ['slider', 'animation'],
    rows: ['a = 1', 'y = a sin(x)'],
    request: 'Animate the amplitude from 1 to 3',
    checks: [
      called('animate_slider', 'glides a to 3', a => a.name === 'a' && a.to === 3),
      rowsLike(/sin/, 1),
      drawnCount(1, 1),
    ],
    good: [answer('The wave grows taller as a goes from 1 to 3.', animate('a', 3, 1))],
    bad: [answer('Animated.', set('a = 1', 'y = a sin(x)', 'y = 3 sin(x)'))],
  },
  {
    id: 'circle-and-line',
    tags: ['2d', 'observed', 'separate rows'],
    rows: [],
    request: 'Draw a circle of radius 2 and the line y = x',
    checks: [
      drawnCount(2, 2),
      curveThrough('a circle of radius 2', [
        [2, 0],
        [0, -2],
        [Math.SQRT2, Math.SQRT2],
      ]),
      curveThrough('the line y = x', [
        [-3, -3],
        [5, 5],
      ]),
    ],
    good: [answer('A circle of radius 2 and the line y = x.', set('x^2 + y^2 = 4', 'y = x'))],
    bad: [answer('A circle and a line.', set('(2cos(2pi u), 2sin(2pi u)), (u, u)'))],
  },
  {
    id: 'honest-reply-helix',
    tags: ['3d', 'observed', 'reply'],
    rows: [],
    request: 'Draw a helix',
    // A helix leaves every plane; a circle drawn in 3D (z = 0, or tilted) doesn't.
    checks: [parametricCurve('a 3D curve, not a flat one', notPlanar, 3)],
    good: [
      answer('Here is a helix winding up the z-axis.', set('(2cos(6pi u), 2sin(6pi u), 4u - 2)')),
      answer('A helix along x.', set('(u, cos(8pi u), sin(8pi u))')),
    ],
    bad: [
      answer('Here is a helix.', set('x^2 + y^2 = 4')),
      // Observed: a circle in the plane z = 0, called a 3D helix.
      answer('I drew a 3D helix.', set('(cos(2pi u), sin(2pi u), 0)')),
      answer('A helix.', set('(cos(2pi u), sin(2pi u), cos(2pi u))')),
    ],
  },

  // Common requests.
  {
    id: 'area-under-sin',
    tags: ['2d', 'integral'],
    rows: ['y = sin(x)'],
    request: 'Shade the area under sin from 0 to π',
    checks: [value(2), keeps('y = sin(x)'), hasKind('value', /int/)],
    good: [answer('The shaded area under sin from 0 to π is 2.', set('y = sin(x)', 'int[0..pi] sin(x) dx'))],
    bad: [answer('Shaded.', set('y = sin(x)', '0 < y < sin(x)'))],
  },
  {
    id: 'integral-value',
    tags: ['2d', 'integral', 'reply'],
    rows: [],
    request: "What's the integral of x² from 0 to 3?",
    checks: [value(9), replySays(/\b9\b/)],
    good: [answer('It is 9: the shaded area under x² from 0 to 3.', set('int[0..3] x^2 dx'))],
    bad: [
      answer('It is 27.', set('int[0..3] x^2 dx')),
      // The app shows a reply as plain text: LaTeX would show its backslashes.
      answer('It is \\(9\\): the area under \\(x^2\\).', set('int[0..3] x^2 dx')),
    ],
  },
  {
    id: 'zoom-zero',
    tags: ['view'],
    rows: ['y = x^3 + x'],
    request: 'Zoom in on where it crosses zero',
    checks: [
      unchanged(),
      called('move_view', 'a narrower window around x = 0', a => contains(a.x, 0) && width(a.x) < START_WIDTH / 2),
    ],
    good: [answer('Zoomed in on the origin, where it crosses zero.', move({ x: [-1, 1], y: [-1, 1] }))],
    bad: [answer('Zoomed in.', move({ x: [2, 4] })), answer('Zoomed in.', set('y = x^3 + x', 'y = 0'))],
  },
  {
    id: 'zoom-out',
    tags: ['view'],
    rows: ['y = x^3 - 3x'],
    request: 'Zoom out so I can see what happens for large x',
    checks: [unchanged(), called('move_view', 'a wider window', a => width(a.x) > START_WIDTH || width(a.y) > 12)],
    good: [answer('Zoomed out: the cubic runs off to ±∞.', move({ x: [-40, 40] }))],
    bad: [answer('Zoomed out.', move({ x: [-2, 2] }))],
  },
  {
    id: 'spin-3d',
    tags: ['3d', 'view'],
    rows: ['z = x^2 - y^2'],
    request: 'Spin it slowly so I can see it from every side',
    checks: [
      unchanged(),
      called('move_view', 'a slow spin', a => typeof a.spin === 'number' && a.spin > 0 && a.spin <= 1),
    ],
    good: [
      answer('The saddle surface is turning slowly.', move({ spin: 0.3 })),
      // A camera row keeps the spin in the graph: framing, not a change to its rows.
      answer(
        'The saddle is turning slowly.',
        set('z = x^2 - y^2', 'camera(-pi/3, 0.5, 7, spin = 0.3)'),
        move({ spin: 0.3 }),
      ),
    ],
    bad: [answer('Spinning.', move({ x: [-5, 5] }))],
  },
  {
    id: 'polar-rose',
    tags: ['polar'],
    rows: [],
    request: 'Draw the polar rose r = sin(4θ)',
    checks: [
      anyOf(
        'the rose r = sin(4θ)',
        parametric(
          'traced with θ = 2πu',
          ([x, y]) => {
            const theta = Math.atan2(y, x);
            // r = ±sin(4θ): the trace may pass through the origin onto the opposite petal.
            return Math.abs(Math.hypot(x, y) - Math.abs(Math.sin(4 * theta))) < 1e-6;
          },
          2,
        ),
        // In the polar chart: 4 of the 8 petals, where sin(4θ) >= 0.
        curveThrough(
          'in the polar chart',
          [Math.PI / 8, Math.PI / 16, (5 * Math.PI) / 8].map(t => [
            Math.sin(4 * t) * Math.cos(t),
            Math.sin(4 * t) * Math.sin(t),
          ]),
        ),
      ),
    ],
    good: [
      answer('The eight-petalled rose r = sin(4θ).', set('(sin(8pi u) cos(2pi u), sin(8pi u) sin(2pi u))')),
      answer(
        'The rose r = sin(4θ), drawn where r ≥ 0.',
        set('r = sqrt(x^2+y^2)', 'theta = atan2(y,x)', 'r = sin(4 theta)'),
      ),
    ],
    bad: [
      answer('The rose r = sin(4θ).', set('r = sin(4 theta)')),
      answer('The rose r = sin(4θ).', set('(sin(4pi u) cos(2pi u), sin(4pi u) sin(2pi u))')),
    ],
  },
  {
    id: 'cardioid',
    tags: ['polar'],
    rows: [],
    request: 'Plot the cardioid r = 1 + cos θ',
    checks: [
      parametric(
        'the cardioid r = 1 + cos θ',
        ([x, y]) => Math.hypot(x, y) < 1e-9 || Math.abs(Math.hypot(x, y) - (1 + Math.cos(Math.atan2(y, x)))) < 1e-6,
        2,
      ),
    ],
    good: [answer('The cardioid r = 1 + cos θ.', set('((1 + cos(2pi u)) cos(2pi u), (1 + cos(2pi u)) sin(2pi u))'))],
    bad: [answer('The cardioid.', set('((1 + cos(2pi u)) cos(2pi u), (1 + cos(2pi u)) sin(4pi u))'))],
  },
  {
    id: 'parametric-circle',
    tags: ['parametric'],
    rows: [],
    request: 'Draw a circle of radius 3 as a parametric curve',
    checks: [parametric('a circle of radius 3', ([x, y]) => Math.abs(Math.hypot(x, y) - 3) < 1e-6, 2)],
    good: [answer('A circle of radius 3, traced as u runs from 0 to 1.', set('(3cos(2pi u), 3sin(2pi u))'))],
    bad: [answer('A circle of radius 3.', set('x^2 + y^2 = 9'))],
  },
  {
    id: 'lissajous',
    tags: ['parametric'],
    rows: [],
    request: 'Draw a Lissajous figure',
    checks: [
      parametricCurve(
        'a 2D curve that is not an ellipse (its frequencies differ)',
        samples => {
          const a = Math.max(...samples.map(([x]) => Math.abs(x)));
          const b = Math.max(...samples.map(([, y]) => Math.abs(y)));
          return a > 0 && b > 0 && samples.some(([x, y]) => Math.abs((x / a) ** 2 + (y / b) ** 2 - 1) > 0.05);
        },
        2,
      ),
    ],
    good: [answer('A 3:2 Lissajous figure.', set('(sin(6pi u), sin(4pi u))'))],
    bad: [
      answer('A Lissajous figure.', set('y = sin(3x)')),
      // Observed: a circle and an ellipse.
      answer('A Lissajous figure.', set('(2cos(2pi u), 2sin(2pi u))')),
      answer('A Lissajous figure.', set('(2cos(2pi u), sin(2pi u))')),
    ],
  },
  {
    id: 'sphere',
    tags: ['3d'],
    rows: [],
    request: 'Draw a sphere of radius 2',
    checks: [
      anyOf(
        'a sphere of radius 2',
        surfaceThrough(
          'a sphere of radius 2',
          [
            [2, 0, 0],
            [0, 0, -2],
          ],
          [0, 0, 0],
        ),
        // Every sample 2 from the origin, and reaching both poles and both sides: not a cap or a band.
        parametricSurface('a parametric sphere of radius 2', samples => {
          const reach = (axis: number, sign: number) => samples.some(p => Math.abs(p[axis] - 2 * sign) < 0.05);
          return (
            samples.every(p => Math.abs(Math.hypot(...p) - 2) < 1e-6) &&
            [0, 2].every(axis => reach(axis, 1) && reach(axis, -1))
          );
        }),
      ),
    ],
    good: [
      answer('A sphere of radius 2, centred at the origin.', set('x^2 + y^2 + z^2 = 4')),
      answer('A sphere of radius 2.', set('(2sin(pi v)cos(2pi u), 2sin(pi v)sin(2pi u), 2cos(pi v))')),
    ],
    bad: [
      answer('A sphere of radius 2.', set('x^2 + y^2 = 4')),
      answer('A sphere of radius 2.', set('(sin(pi v)cos(2pi u), sin(pi v)sin(2pi u), cos(pi v))')),
      // The top half only.
      answer('A sphere of radius 2.', set('(2sin(pi v/2)cos(2pi u), 2sin(pi v/2)sin(2pi u), 2cos(pi v/2))')),
    ],
  },
  {
    id: 'saddle',
    tags: ['3d'],
    rows: [],
    request: 'Plot the saddle z = x² − y²',
    checks: [
      surfaceThrough('the saddle z = x² − y²', [
        [1, 0, 1],
        [0, 1, -1],
        [2, 1, 3],
      ]),
    ],
    good: [answer('The saddle surface z = x² − y².', set('z = x^2 - y^2'))],
    bad: [answer('The saddle.', set('y = x^2 - 1'))],
  },
  {
    id: 'torus',
    tags: ['3d', 'parametric'],
    rows: [],
    request: 'Draw a torus',
    checks: [hasKind(['psurface', 'implicit3d', 'solid'])],
    good: [
      answer(
        'A torus with radii 2 and 0.7.',
        set('(cos(2pi u)(2 + 0.7cos(2pi v)), sin(2pi u)(2 + 0.7cos(2pi v)), 0.7sin(2pi v))'),
      ),
    ],
    bad: [answer('A torus.', set('(2cos(2pi u), 2sin(2pi u), 0)'))],
  },
  {
    id: 'cone',
    tags: ['3d'],
    rows: [],
    request: 'Draw a cone',
    checks: [
      anyOf(
        'a cone',
        surfaceThrough(
          'a cone about the z-axis',
          [
            [1, 0, 1],
            [0, 2, 2],
            [3, 4, 5],
          ],
          [0, 0, 1],
        ),
        // A parametric cone about a vertical axis: the distance from the axis
        // grows in step with z (r = a + b z, b not 0), or with |z| (a double
        // cone). A solid isn't checked for its shape.
        parametricSurface('a parametric cone', samples => {
          const fits = (f: (z: number) => number) => {
            const pts = samples.map(([x, y, z]) => [f(z), Math.hypot(x, y)]);
            const n = pts.length;
            const mz = pts.reduce((s, p) => s + p[0], 0) / n;
            const mr = pts.reduce((s, p) => s + p[1], 0) / n;
            const szz = pts.reduce((s, p) => s + (p[0] - mz) ** 2, 0);
            if (szz < 1e-9) return false;
            const b = pts.reduce((s, p) => s + (p[0] - mz) * (p[1] - mr), 0) / szz;
            return Math.abs(b) > 0.05 && pts.every(([z, r]) => Math.abs(mr + b * (z - mz) - r) < 1e-6);
          };
          return fits(z => z) || fits(Math.abs);
        }),
        hasKind('solid'),
      ),
    ],
    good: [
      answer('A double cone, z² = x² + y².', set('z^2 = x^2 + y^2')),
      answer('A cone opening upward.', set('z = sqrt(x^2 + y^2)')),
      answer('A cone.', set('(2v cos(2pi u), 2v sin(2pi u), 3v)')),
      answer('A double cone.', set('((2v - 1) cos(2pi u), (2v - 1) sin(2pi u), 2v - 1)')),
    ],
    bad: [
      answer('A cone.', set('y = abs(x)')),
      // Observed: a saddle, called a cone.
      answer('Here is a 3D cone surface.', set('z = x^2 - y^2')),
      answer('A 3D cone.', set('z = sqrt(x^2 - y^2)')),
      // Observed: list_kinds' unit sphere, called a cone.
      answer('A cone-shaped surface.', set('(sin(pi v)cos(2pi u), sin(pi v)sin(2pi u), cos(pi v))')),
      answer('A cone.', set('(cos(2pi u), sin(2pi u), v)')),
    ],
  },
  {
    id: 'vector-field',
    tags: ['vector field'],
    rows: [],
    request: 'Show the vector field (−y, x)',
    // The field asked for, not just any field: the kind chart's own example is (y, x).
    checks: [hasKind('vfield2d', /\(\s*-\s*y\s*,\s*x\s*\)/)],
    good: [
      answer('The rotational field (−y, x), flowing in circles.', set('(-y, x)')),
      answer('The streamlines circle around the origin.', set('(-y, x)')),
    ],
    bad: [answer('The vector field.', set('(-1, 1)')), answer('The rotational field (−y, x).', set('(y, x)'))],
  },
  {
    id: 'points',
    tags: ['points'],
    rows: [],
    request: 'Plot the points (1, 2), (3, 4) and (5, 1)',
    checks: [
      hasKind(['plist', 'point', 'definition (point)']),
      ...['1,2', '3,4', '5,1'].map(p => ({
        name: `plots (${p})`,
        test: (o: Outcome) => (o.rows.some(r => r.text.replace(/\s/g, '').includes(`(${p})`)) ? true : `no (${p})`),
      })),
    ],
    good: [
      answer('Plotted the three points.', set('(1, 2), (3, 4), (5, 1)')),
      answer('Plotted the three points.', set('(1, 2)', '(3, 4)', '(5, 1)')),
    ],
    bad: [answer('Plotted the points.', set('y = 2x'))],
  },
  {
    id: 'named-point',
    tags: ['points', 'keep'],
    rows: ['y = x^2'],
    request: 'Add a point A at (2, 3)',
    checks: [hasKind(['definition (point)', 'point'], /\(\s*2\s*,\s*3\s*\)/), keeps('y = x^2')],
    good: [answer('Added the point A at (2, 3).', set('y = x^2', 'A = (2, 3)'))],
    bad: [answer('Added the point A.', set('A = (2, 3)'))],
  },
  {
    id: 'moving-point',
    tags: ['points', 'animation'],
    rows: ['A = (1, 0)'],
    request: 'Make the point go round in a circle',
    checks: [rowsLike(/^\s*A\s*=/, 1), rowsLike(/^\s*A\s*=.*\bt\b/, 1), hasKind('definition (point)')],
    good: [
      answer('A now goes round in a circle, once every 2π seconds.', set('A = (cos(t), sin(t))')),
      answer('I made A orbit the unit circle once every 2π seconds.', set('A = (cos(t), sin(t))')),
    ],
    bad: [answer('A goes round in a circle.', set('A = (1, 0)', 'B = (cos(t), sin(t))'))],
  },
  {
    id: 'label-crossing',
    tags: ['labels', 'keep'],
    rows: ['y = x^2', 'y = 2x'],
    request: 'Label where the two curves cross',
    checks: [hasKind('label', /label\s*\(\s*\(\s*(2\s*,\s*4|0\s*,\s*0)\s*\)/), keeps('y = x^2', 'y = 2x')],
    good: [
      answer(
        'Labelled the crossings at (0, 0) and (2, 4).',
        set('y = x^2', 'y = 2x', 'label((0, 0), "cross")', 'label((2, 4), "cross")'),
      ),
      answer(
        'I drew the two curves, framed their crossing point at (2, 4), and labelled it.',
        set('y = x^2', 'y = 2x', 'label((2, 4), "they cross here")'),
      ),
    ],
    bad: [answer('Labelled the crossing.', set('y = x^2', 'y = 2x', 'label((1, 1), "cross")'))],
  },
  {
    id: 'color-red',
    tags: ['colors'],
    rows: ['y = x^2'],
    request: 'Make the parabola red',
    checks: [
      rowsLike(/^\s*y\s*=\s*x\^2\s*#([0-9a-f]{3}|[0-9a-f]{6})\b/i, 1),
      drawnCount(1, 1),
      {
        name: 'drawn in red',
        test: o => {
          const color = o.rows.find(r => r.color)?.color ?? '';
          const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
          return r > 180 && g < 120 && b < 120 ? true : `color ${color}`;
        },
      },
    ],
    good: [
      answer(
        'I drew the red parabola, showing the points where the curve satisfies the equation.',
        set('y = x^2 #e24'),
      ),
    ],
    bad: [answer('The parabola is red now.', set('y = x^2 #24e')), answer('Red.', set('y = x^2', 'y = x^2 #f00'))],
  },
  {
    id: 'derivative',
    tags: ['functions', 'keep'],
    rows: ['f(x) = x^3 - x'],
    request: 'Draw f and its derivative',
    checks: [
      keeps('f(x) = x^3 - x'),
      drawnCount(2, 2),
      curveThrough('f', [
        [0, 0],
        [2, 6],
      ]),
      curveThrough("f' = 3x² − 1", [
        [0, -1],
        [2, 11],
      ]),
    ],
    good: [
      answer('f in blue and its derivative in red.', set('f(x) = x^3 - x', 'y = f(x)', 'y = d/dx f(x)')),
      answer('f and its derivative.', set('f(x) = x^3 - x', 'y = f(x)', 'y = 3x^2 - 1')),
    ],
    bad: [answer('f and its derivative.', set('f(x) = x^3 - x', "f'(x) = 3x^2 - 1"))],
  },
  {
    id: 'function-draws',
    tags: ['functions'],
    rows: [],
    request: 'Graph g(x) = x² − 4',
    checks: [
      curveThrough('the parabola x² − 4', [
        [0, -4],
        [2, 0],
        [3, 5],
      ]),
    ],
    good: [
      answer('The parabola g(x) = x² − 4.', set('g(x) = x^2 - 4', 'y = g(x)')),
      answer('The parabola y = x² − 4.', set('y = x^2 - 4')),
    ],
    bad: [answer('The parabola g(x) = x² − 4.', set('g(x) = x^2 - 4'))],
  },
  {
    id: 'tangent-line',
    tags: ['2d', 'keep'],
    rows: ['y = x^2'],
    request: 'Add the tangent line at x = 1',
    checks: [
      keeps('y = x^2'),
      // Marking the point of tangency is fine; a second line isn't.
      drawnCount(2, 2, ['point', 'label']),
      curveThrough('the tangent y = 2x − 1', [
        [1, 1],
        [3, 5],
        [-2, -5],
      ]),
    ],
    good: [
      answer('The tangent at x = 1 is y = 2x − 1.', set('y = x^2', 'y = 2x - 1')),
      answer('The tangent at (1, 1) is y = 2x − 1.', set('y = x^2', 'y = 2x - 1', '(1, 1)', 'label((1, 1), "x = 1")')),
    ],
    bad: [
      answer('The tangent line at x = 1.', set('y = x^2', 'y = 2x')),
      answer('The tangent line at x = 1.', set('y = x^2', 'y = 2x - 1', 'y = 2x')),
    ],
  },
  {
    id: 'shift-up',
    tags: ['2d', 'edit'],
    rows: ['y = x^2'],
    request: 'Shift it up by 3',
    checks: [
      drawnCount(1, 1),
      curveThrough('y = x² + 3', [
        [0, 3],
        [2, 7],
      ]),
    ],
    good: [answer('The parabola moved up 3.', set('y = x^2 + 3'))],
    bad: [answer('Shifted up by 3.', set('y = x^2', 'y = x^2 + 3'))],
  },
  {
    id: 'remove-row',
    tags: ['edit'],
    rows: ['y = x^2', 'y = sin(x)'],
    request: 'Remove the sine curve',
    checks: [
      {
        name: 'only the parabola is left',
        test: o =>
          o.rows.length === 1 && o.rows[0].text.replace(/\s/g, '') === 'y=x^2'
            ? true
            : `rows ${JSON.stringify(o.rows.map(r => r.text))}`,
      },
    ],
    good: [answer('Removed the sine curve.', set('y = x^2'))],
    bad: [answer('Removed it.', set('y = sin(x)'))],
  },
  {
    id: 'shade-region',
    tags: ['2d', 'regions'],
    rows: [],
    request: 'Shade the region where y is greater than x squared',
    checks: [hasKind('ineq2d', /y\s*>=?\s*x\^2|x\^2\s*<=?\s*y/)],
    good: [answer('Shaded the region above the parabola.', set('y > x^2'))],
    bad: [answer('Shaded the region.', set('y < x^2'))],
  },

  // Harder tasks (step 3): less common kinds, and requests of several steps.
  // gpt-5.5 passed every task above every time, so these are what separate
  // one way of giving it the language from another.
  {
    id: 'regression-line',
    tags: ['regression', 'hard'],
    rows: ['P = [(0, 1), (1, 3), (2, 4), (3, 7)]'],
    request: 'Fit a straight line to these points and draw it',
    checks: [
      keeps('P = [(0, 1), (1, 3), (2, 4), (3, 7)]'),
      // The least-squares line is y = 1.9x + 0.9, fitted by a regression row or worked out.
      curveThrough('the fitted line y = 1.9x + 0.9', [
        [0, 0.9],
        [3, 6.6],
      ]),
    ],
    good: [
      answer(
        'Fitted y = m x + b to the points: m ≈ 1.9, b ≈ 0.9.',
        set('P = [(0, 1), (1, 3), (2, 4), (3, 7)]', 'P.y ~ m P.x + b', 'y = m x + b'),
      ),
      answer(
        'The least-squares line is y = 1.9x + 0.9.',
        set('P = [(0, 1), (1, 3), (2, 4), (3, 7)]', 'P', 'y = 1.9x + 0.9'),
      ),
    ],
    bad: [
      // Through the end points, not fitted.
      answer('The line through the points.', set('P = [(0, 1), (1, 3), (2, 4), (3, 7)]', 'y = 2x + 1')),
      // Fitted, but not drawn.
      answer('Fitted the line.', set('P = [(0, 1), (1, 3), (2, 4), (3, 7)]', 'P.y ~ m P.x + b')),
    ],
  },
  {
    id: 'label-vertex',
    tags: ['labels', 'points', 'hard'],
    rows: ['y = x^2 - 4x + 3'],
    request: 'Mark the vertex of the parabola with a point and label it',
    checks: [
      keeps('y = x^2 - 4x + 3'),
      pointAt('a point at the vertex (2, −1)', [2, -1]),
      labelAt('a label at the vertex', [2, -1]),
    ],
    good: [
      answer('Marked the vertex V at (2, −1).', set('y = x^2 - 4x + 3', 'V = (2, -1)', 'label(V, "vertex")')),
      answer('The vertex is at (2, −1).', set('y = x^2 - 4x + 3', '(2, -1)', 'label((2, -1), "vertex (2, −1)")')),
    ],
    bad: [
      answer('Marked the vertex.', set('y = x^2 - 4x + 3', 'V = (2, 1)', 'label(V, "vertex")')),
      // A point, but no label.
      answer('Marked the vertex.', set('y = x^2 - 4x + 3', 'V = (2, -1)')),
    ],
  },
  {
    id: 'motion-trail',
    tags: ['trail', 'animation', 'hard'],
    rows: ['A = (2cos(t), sin(2t))'],
    request: 'Show the path the point leaves behind as it moves',
    checks: [
      rowsLike(/^\s*A\s*=/, 1),
      keeps('A = (2cos(t), sin(2t))'),
      hasKind('trail', /trail\s*\(\s*(A\s*\)|\(\s*2\s*cos\s*\(\s*t\s*\)\s*,\s*sin\s*\(\s*2\s*t\s*\)\s*\)\s*\))/),
    ],
    good: [answer('A now leaves a trail behind it.', set('A = (2cos(t), sin(2t))', 'trail(A)'))],
    bad: [
      // The whole path at once, not the trail it leaves.
      answer('Here is the path.', set('A = (2cos(t), sin(2t))', '(2cos(2pi u), sin(4pi u))')),
      answer('A now leaves a trail.', set('A = (2cos(t), sin(2t))', 'trail((cos(t), sin(t)))')),
    ],
  },
  {
    id: 'hyperboloid',
    tags: ['3d', 'hard'],
    rows: [],
    request: 'Draw a hyperboloid of one sheet whose waist is a circle of radius 2',
    checks: [
      anyOf(
        'a hyperboloid of one sheet, waist radius 2',
        // As an equation: on the circle of radius 2 at z = 0 and nowhere else
        // in that plane nearby, and wider (a radius past 2) at z = ±2.
        {
          name: 'as an equation',
          test: o =>
            o.graph.analysis.rows.some(r => {
              if (r.cpu?.type !== 'implicit3d') return false;
              const cpu = r.cpu;
              const f = (x: number, y: number, z: number) =>
                evaluate(cpu.residual, { ...o.graph.analysis.constEnv, t: 0, x, y, z });
              const zero = (v: number) => Math.abs(v) < 1e-3;
              const widens = (z: number) =>
                Array.from({ length: 560 }, (_, k) => 2.05 + k * 0.05).some(
                  (x, k, xs) => k > 0 && Math.sign(f(xs[k - 1], 0, z)) !== Math.sign(f(x, 0, z)),
                );
              return (
                zero(f(2, 0, 0)) &&
                zero(f(0, 2, 0)) &&
                zero(f(-Math.SQRT2, -Math.SQRT2, 0)) &&
                ![0, 1.5, 2.5].some(x => zero(f(x, 0, 0))) &&
                widens(2) &&
                widens(-2)
              );
            })
              ? true
              : 'no such surface',
        },
        // As a parametric surface: never inside radius 2, radius 2 at z = 0,
        // and wider away from it, both ways.
        parametricSurface('as a parametric surface', samples => {
          const r = ([x, y]: number[]) => Math.hypot(x, y);
          return (
            samples.every(p => r(p) > 2 - 1e-6) &&
            samples.some(p => Math.abs(p[2]) < 0.05 && Math.abs(r(p) - 2) < 0.05) &&
            samples.some(p => p[2] > 1) &&
            samples.some(p => p[2] < -1) &&
            samples.filter(p => Math.abs(p[2]) > 1).every(p => r(p) > 2.01)
          );
        }),
      ),
    ],
    good: [
      answer('A hyperboloid of one sheet, waist radius 2.', set('x^2 + y^2 - z^2 = 4')),
      answer(
        'A hyperboloid of one sheet: its waist is the circle of radius 2 at z = 0.',
        set('x^2/4 + y^2/4 - z^2/9 = 1'),
      ),
      answer(
        'A hyperboloid of one sheet, waist radius 2.',
        set('(2cosh(4v - 2) cos(2pi u), 2cosh(4v - 2) sin(2pi u), 2sinh(4v - 2))'),
      ),
    ],
    bad: [
      // Two sheets.
      answer('A hyperboloid.', set('z^2 - x^2 - y^2 = 4')),
      // Waist radius 1.
      answer('A hyperboloid of one sheet.', set('x^2 + y^2 - z^2 = 1')),
      // A cylinder of radius 2.
      answer('A hyperboloid of one sheet.', set('x^2 + y^2 = 4 + 0z')),
      answer('A hyperboloid of one sheet.', set('(2cos(2pi u), 2sin(2pi u), 4v - 2)')),
    ],
  },
  {
    id: 'vector-field-slider',
    tags: ['vector field', 'slider', 'animation', 'order', 'hard'],
    rows: [],
    request: 'Show the vector field (−y, a·x) with a slider for a, then animate a from 1 to −1',
    checks: [
      hasKind('vfield2d', /\(\s*-\s*y\s*,\s*[a-z]\w*\s*\*?\s*x\s*\)/),
      sliderUsed(),
      noFailedCalls('animate_slider'),
      called('animate_slider', 'glides the slider to −1', a => a.to === -1),
    ],
    good: [
      answer('As a goes from 1 to −1 the circles open into a saddle.', set('a = 1', '(-y, a x)'), animate('a', -1, 1)),
    ],
    bad: [
      // Animated before the slider exists.
      answer('As a goes from 1 to −1 the flow changes.', animate('a', -1, 1), set('a = 1', '(-y, a x)')),
      // No slider in the field.
      answer('The field (−y, x).', set('a = 1', '(-y, x)'), animate('a', -1, 1)),
    ],
  },
  {
    id: 'solid-of-revolution',
    tags: ['3d', 'hard'],
    rows: [],
    request: 'Draw the solid formed by rotating y = √x, for x from 0 to 4, about the x-axis',
    checks: [
      anyOf(
        'the paraboloid y² + z² = x, from x = 0 to 4',
        // As an equation: on it at x = 1, 2.25 and 4, and not past x = 4.
        surfaceThrough('as an equation', [
          [1, 1, 0],
          [2.25, 0, -1.5],
          [3.24, 0, 1.8],
        ]),
        // As a parametric surface or solid: inside y² + z² ≤ x over [0, 4],
        // and on it at the rim (x = 4) and halfway (x = 2).
        shape3D('as a surface or solid', samples => {
          const gap = ([x, y, z]: number[]) => y * y + z * z - x;
          return (
            samples.every(p => p[0] > -1e-6 && p[0] < 4 + 1e-6 && gap(p) < 1e-6) &&
            samples.some(p => Math.abs(p[0] - 4) < 1e-6 && Math.abs(gap(p)) < 1e-6) &&
            samples.some(p => Math.abs(p[0] - 2) < 0.25 && Math.abs(gap(p)) < 1e-6)
          );
        }),
      ),
      {
        name: 'stops at x = 4',
        test: o =>
          o.graph.analysis.rows.some(
            r =>
              r.cpu?.type === 'implicit3d' &&
              Math.abs(evaluate(r.cpu.residual, { ...o.graph.analysis.constEnv, x: 6, y: Math.sqrt(6), z: 0 })) < 1e-3,
          )
            ? 'the surface goes on past x = 4'
            : true,
      },
    ],
    good: [
      answer('The solid of revolution of √x from 0 to 4.', set('revolve({0 < x < 4: sqrt(x)})')),
      answer(
        'The solid of revolution of √x from 0 to 4.',
        set('s = interval(0, 4)', 'r = interval(0, 1)', '(s, r sqrt(s) cos(2pi u), r sqrt(s) sin(2pi u))'),
      ),
      answer('The surface of revolution of √x, 0 ≤ x ≤ 4.', set('(4v, 2sqrt(v) cos(2pi u), 2sqrt(v) sin(2pi u))')),
    ],
    bad: [
      // Not stopped at x = 4.
      answer('The solid of revolution of √x.', set('revolve(sqrt(x))')),
      // A cone, through the same rim.
      answer('The solid of revolution.', set('(4v, 2v cos(2pi u), 2v sin(2pi u))')),
    ],
  },
  {
    id: 'piecewise',
    tags: ['2d', 'piecewise', 'hard'],
    rows: [],
    request: 'Graph f(x) = x² for x < 0 and x + 1 for x ≥ 0',
    checks: [
      // Drawn as one row, or piece by piece.
      curvesThrough('both pieces', [
        [-1, 1],
        [-2, 4],
        [0.5, 1.5],
        [2, 3],
      ]),
      curveAvoids('neither piece past x = 0', [
        [1, 1],
        [2, 4],
        [-1, 0],
        [-2, -1],
      ]),
    ],
    good: [
      answer('The piecewise function: x² left of 0, x + 1 from 0 on.', set('y = {x < 0: x^2, x + 1}')),
      answer('f, drawn piece by piece.', set('f(x) = {x < 0: x^2, x >= 0: x + 1}', 'y = f(x)')),
      answer('The two pieces.', set('y = {x < 0: x^2}', 'y = {x >= 0: x + 1}')),
    ],
    bad: [
      answer('The two pieces.', set('y = x^2', 'y = x + 1')),
      answer('The piecewise function.', set('y = {x < 0: x + 1, x^2}')),
    ],
  },
  {
    id: 'domain-colouring',
    tags: ['complex', 'hard'],
    rows: [],
    request: 'Show the domain colouring of f(z) = (z² − 1)/(z² + 1)',
    checks: [
      complexFunction('(z² − 1)/(z² + 1), coloured', 'domain2d', (x, y) => {
        const [a, b] = [x * x - y * y, 2 * x * y];
        const den = (a + 1) ** 2 + b * b;
        return [((a - 1) * (a + 1) + b * b) / den, (b * (a + 1) - (a - 1) * b) / den];
      }),
    ],
    good: [
      answer('Zeros at ±1 (black), poles at ±i (white).', set('domain((w^2 - 1)/(w^2 + 1))')),
      answer('The domain colouring of f.', set('f(z) = (z^2 - 1)/(z^2 + 1)', 'domain(f(w))')),
    ],
    bad: [
      // z is the 3D axis: an error.
      answer('The domain colouring.', set('domain((z^2 - 1)/(z^2 + 1))')),
      answer('The domain colouring.', set('domain((w^2 + 1)/(w^2 - 1))')),
    ],
  },
  {
    id: 'tangent-slider',
    tags: ['functions', 'slider', 'keep', 'hard'],
    rows: ['f(x) = x^3 - 3x', 'y = f(x)'],
    request: 'Add a tangent line at x = a, with a slider for a',
    checks: [
      keeps('f(x) = x^3 - 3x', 'y = f(x)'),
      // f(a) = a³ − 3a and f′(a) = 3a² − 3.
      curveFollowsSlider('the tangent at a, following the slider', a => {
        const [fa, slope] = [a ** 3 - 3 * a, 3 * a * a - 3];
        return [
          [a, fa],
          [a + 1, fa + slope],
          [a - 2, fa - 2 * slope],
        ];
      }),
    ],
    good: [
      answer(
        'Drag a to move the tangent along the curve.',
        set('f(x) = x^3 - 3x', 'y = f(x)', 'g(x) = d/dx f(x)', 'a = 1.5', 'y = f(a) + g(a)(x - a)'),
      ),
      answer('Drag a.', set('f(x) = x^3 - 3x', 'y = f(x)', 'a = 1.5', 'y = f(a) + (3a^2 - 3)(x - a)')),
    ],
    bad: [
      // d/dx f(a) differentiates a constant: a flat line through (a, f(a)).
      answer('Drag a.', set('f(x) = x^3 - 3x', 'y = f(x)', 'a = 1.5', 'y = f(a) + d/dx f(a) (x - a)')),
      // The tangent at 1.5, which doesn't follow the slider.
      answer('Drag a.', set('f(x) = x^3 - 3x', 'y = f(x)', 'a = 1.5', 'y = 3.75x - 6.75')),
    ],
  },
  {
    id: 'normal-probability',
    tags: ['probability', 'integral', 'hard'],
    rows: [],
    request: 'Shade the probability that a standard normal variable lies within one standard deviation of its mean',
    // P(…) of a declared variable, or the integral of the density, which shades it too.
    checks: [
      anyOf('the probability, shaded', hasKind('probability (shaded area)'), hasKind('value', /int/)),
      value(0.6827, 1e-3),
    ],
    good: [
      answer('About 68% of the area lies within one standard deviation.', set('X ~ Normal(0, 1)', 'P(-1 < X < 1)')),
      answer(
        'I shaded the area within one standard deviation: about 68%.',
        set('y = normalpdf(x, 0, 1)', 'int[-1..1] normalpdf(x, 0, 1) dx'),
      ),
      answer('I shaded P(−1 < X < 1) ≈ 0.6827.', set('X ~ Normal(0, 1)', 'P(-1 < X < 1)')),
    ],
    bad: [
      answer('About 68%.', set('X ~ Normal(0, 1)', 'P(X < 1)')),
      answer('About 68%.', set('y = normalpdf(x, 0, 1)', '-1 < x < 1')),
    ],
  },
  {
    id: 'intersection-curve',
    tags: ['3d', 'keep', 'hard'],
    rows: ['x^2 + y^2 + z^2 = 9', 'z = 2'],
    request: 'Draw the curve where the sphere meets the plane',
    checks: [
      keeps('x^2 + y^2 + z^2 = 9', 'z = 2'),
      anyOf(
        'the circle x² + y² = 5 at z = 2',
        hasKind('spacecurve'),
        parametric(
          'as a parametric curve',
          ([x, y, z]) => Math.abs(x * x + y * y - 5) < 1e-6 && Math.abs(z - 2) < 1e-6,
          3,
        ),
      ),
    ],
    good: [
      answer(
        'The circle where they meet, radius √5 at height 2.',
        set('x^2 + y^2 + z^2 = 9', 'z = 2', '(x^2 + y^2 + z^2, z) = (9, 2)'),
      ),
      answer(
        'The circle where they meet.',
        set('x^2 + y^2 + z^2 = 9', 'z = 2', '(sqrt(5) cos(2pi u), sqrt(5) sin(2pi u), 2)'),
      ),
    ],
    bad: [
      answer('The circle where they meet.', set('x^2 + y^2 + z^2 = 9', 'z = 2', '(3cos(2pi u), 3sin(2pi u), 2)')),
      answer('The circle where they meet.', set('x^2 + y^2 + z^2 = 9', 'z = 2', 'x^2 + y^2 = 5')),
    ],
  },
];
