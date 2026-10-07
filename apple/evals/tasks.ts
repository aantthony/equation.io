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
import { START_WINDOW } from './graph.ts';
import {
  type Check,
  animated,
  anyOf,
  called,
  curveThrough,
  drawnCount,
  hasKind,
  keeps,
  noFailedCalls,
  type Outcome,
  parametric,
  parametricCurve,
  replySays,
  rowsLike,
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

export const TASKS: EvalTask[] = [
  // The observed failures.
  {
    id: 'unit-cube',
    tags: ['3d', 'observed'],
    rows: [],
    request: 'Draw a unit cube',
    checks: [hasKind(['solid', 'polygon']), drawnCount(1, 1)],
    good: [
      answer('Here is the unit cube.', set('(interval(0, 1), interval(0, 1), interval(0, 1))')),
      answer('A unit cube, drawn as the hull of its corners.', set('hull(([0,1],[0,1],[0,1]))')),
    ],
    bad: [
      // The observed mash-up of the reference's helix and cube examples.
      answer('I drew a unit cube as a solid.', set('(interval(0,1), 0, 0), (2cos(6pi u), 2sin(6pi u), 2u - 2)')),
      answer('I drew a unit cube.', set('(2cos(6pi u), 2sin(6pi u), 4u - 2)')),
    ],
  },
  {
    id: 'unit-cube-beside-sphere',
    tags: ['3d', 'observed', 'keep'],
    rows: ['x^2 + y^2 + z^2 = 4'],
    request: 'Add a unit cube',
    checks: [hasKind(['solid', 'polygon']), keeps('x^2 + y^2 + z^2 = 4'), drawnCount(2, 2)],
    good: [
      answer(
        'Added a unit cube inside the sphere.',
        set('x^2 + y^2 + z^2 = 4', '(interval(0, 1), interval(0, 1), interval(0, 1))'),
      ),
    ],
    bad: [answer('Added a unit cube.', set('(interval(0, 1), interval(0, 1), interval(0, 1))'))],
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
    checks: [animated(/x\^2|x\s*\*\s*x/), drawnCount(1, 1)],
    good: [answer('The parabola now rises and falls.', set('y = x^2 + sin(t)'))],
    bad: [answer('Animated.', set('y = x^2', 'y = x^2 + sin(t)'))],
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
    checks: [parametric('a 3D curve', () => true, 3)],
    good: [answer('Here is a helix winding up the z-axis.', set('(2cos(6pi u), 2sin(6pi u), 4u - 2)'))],
    bad: [answer('Here is a helix.', set('x^2 + y^2 = 4'))],
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
    bad: [answer('It is 27.', set('int[0..3] x^2 dx'))],
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
    good: [answer('The saddle surface is turning slowly.', move({ spin: 0.3 }))],
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
      surfaceThrough(
        'a sphere of radius 2',
        [
          [2, 0, 0],
          [0, 0, -2],
        ],
        [0, 0, 0],
      ),
    ],
    good: [answer('A sphere of radius 2, centred at the origin.', set('x^2 + y^2 + z^2 = 4'))],
    bad: [answer('A sphere of radius 2.', set('x^2 + y^2 = 4'))],
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
        // A parametric cone or solid isn't checked for its shape.
        hasKind(['psurface', 'solid']),
      ),
    ],
    good: [
      answer('A double cone, z² = x² + y².', set('z^2 = x^2 + y^2')),
      answer('A cone opening upward.', set('z = sqrt(x^2 + y^2)')),
    ],
    bad: [
      answer('A cone.', set('y = abs(x)')),
      // Observed: a saddle, called a cone.
      answer('Here is a 3D cone surface.', set('z = x^2 - y^2')),
      answer('A 3D cone.', set('z = sqrt(x^2 - y^2)')),
    ],
  },
  {
    id: 'vector-field',
    tags: ['vector field'],
    rows: [],
    request: 'Show the vector field (−y, x)',
    checks: [hasKind('vfield2d')],
    good: [answer('The rotational field (−y, x), flowing in circles.', set('(-y, x)'))],
    bad: [answer('The vector field.', set('(-1, 1)'))],
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
    good: [answer('A now goes round in a circle, once every 2π seconds.', set('A = (cos(t), sin(t))'))],
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
      drawnCount(2, 2),
      curveThrough('the tangent y = 2x − 1', [
        [1, 1],
        [3, 5],
        [-2, -5],
      ]),
    ],
    good: [answer('The tangent at x = 1 is y = 2x − 1.', set('y = x^2', 'y = 2x - 1'))],
    bad: [answer('The tangent line at x = 1.', set('y = x^2', 'y = 2x'))],
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
];
