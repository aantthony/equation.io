/**
 * The curated gallery shown on /about/, shared with scripts/screenshots.ts so
 * every image on the page is rendered by the app itself and clicking a card
 * opens exactly what the screenshot shows.
 */

export interface ShowcaseItem {
  /**
   * Filename stem for the rendered screenshot. Gallery shots live in
   * web/shots/ (bundled + content-hashed by Vite); the hero stays in
   * web/public/shots/ so its og:image URL is stable.
   */
  slug: string;
  title: string;
  blurb: string;
  /** Equation rows, in the same form the URL hash and the input rows use. */
  eqs: string[];
  group: string;
  /** Seconds to let `t` advance before capturing (animated scenes). */
  settle?: number;
  /**
   * Canvas clicks (viewport-fraction coordinates) made before capturing —
   * used to drop integral-curve seeds on vector fields / ODEs. The card's
   * link still opens just the equations; visitors click to trace their own.
   */
  clicks?: Array<[number, number]>;
  /**
   * Camera for the shot: `span` math units across the canvas's short edge,
   * centered on (cx, cy). Defaults to the app's opening view, which frames
   * ~12 units — too wide for anything whose detail lives in a small window
   * (fractals especially). Cards still link to the plain equations, so a
   * visitor lands on the default view and scrolls in themselves.
   */
  view?: { cx?: number; cy?: number; span?: number };
}

/** The app URL that loads these equations (the same format saveHash writes). */
export function hashUrl(eqs: string[]): string {
  return '/#' + eqs.map(encodeURIComponent).join(';');
}

/** Full-app screenshot at the top of the page, panel included. */
export const HERO: ShowcaseItem = {
  slug: 'hero',
  title: 'Equation.io',
  blurb: 'Type an equation. See it instantly.',
  eqs: ['x^2 + y^2 = 4', 'y = sin(x - 2t)', '-1 <= y - x/2 < 1'],
  group: 'hero',
  settle: 1.1,
};

export const SHOWCASE: ShowcaseItem[] = [
  {
    slug: 'lemniscate',
    title: 'Any implicit curve',
    blurb: 'No solving for y — write the equation as-is and it plots.',
    eqs: ['(x^2+y^2)^2 = 8(x^2-y^2)'],
    group: 'Curves & regions',
  },
  {
    slug: 'moire',
    title: 'However tangled',
    blurb: 'Equations compile to shaders, so even wild loci stay smooth.',
    eqs: ['sin(x^2 + y^2) = cos(x y)'],
    group: 'Curves & regions',
  },
  {
    slug: 'annulus',
    title: 'Inequalities shade regions',
    blurb: 'Chained comparisons carve out exactly the region you wrote.',
    eqs: ['4 <= x^2 + y^2 <= 9', 'y > x'],
    group: 'Curves & regions',
  },
  {
    slug: 'wave-band',
    title: 'Regions follow curves',
    blurb: 'Strict edges dash, inclusive edges stay solid.',
    eqs: ['-1 <= y - sin(x) < 1'],
    group: 'Curves & regions',
  },
  {
    slug: 'ripples',
    title: 'Scalar fields as height maps',
    blurb: 'A bare expression in x and y renders as a shaded field — with t, it moves.',
    eqs: ['sin(x^2 + y^2 - 4t)/2'],
    group: 'Fields & complex maps',
    settle: 1.3,
  },
  {
    slug: 'flow-cylinder',
    title: 'Complex potentials',
    blurb: 'Write f(w) and its streamlines and equipotentials appear — here, flow past a cylinder.',
    eqs: ['w + 4/w'],
    group: 'Fields & complex maps',
  },
  {
    slug: 'quadrupole',
    title: 'Fields with structure',
    blurb: 'A quadrupole from four logarithms.',
    eqs: ['ln(w-2) + ln(w+2) - ln(w-2i) - ln(w+2i)'],
    group: 'Fields & complex maps',
  },
  {
    slug: 'orbiting-charge',
    title: 'Live physics',
    blurb: 'Definitions can depend on time — the whole field follows.',
    eqs: ['r = 2 + sin(t)', 'ln(w - r) - ln(w + r)'],
    group: 'Fields & complex maps',
    settle: 0.9,
  },
  {
    slug: 'domain-coloring',
    title: 'Domain coloring',
    blurb: 'Wrap f in domain(…): hue is the argument, brightness the magnitude. Zeros go black, poles white.',
    eqs: ['domain((w^3 - 1)/w)'],
    group: 'Fields & complex maps',
    view: { span: 3 },
    settle: 0.8,
  },
  {
    slug: 'conformal-square',
    title: 'Conformal maps',
    blurb: 'conformal(f) draws where f sends the grid — stretched, but every crossing still square.',
    eqs: ['conformal(w^2/4)'],
    group: 'Fields & complex maps',
    settle: 0.8,
  },
  {
    slug: 'joukowski',
    title: 'The Joukowski transform',
    blurb: 'The map that turns circles into aerofoils, applied to the whole plane.',
    eqs: ['conformal(w + 1/w)'],
    group: 'Fields & complex maps',
    view: { span: 8 },
    settle: 0.8,
  },
  {
    slug: 'mandelbrot',
    title: 'Fractals from a recurrence',
    blurb: 'iter(z² + w) iterates z ↦ z² + w from 0 — the Mandelbrot set, straight from its definition.',
    eqs: ['iter(z^2 + w)'],
    group: 'Fractals',
    view: { cx: -0.5, span: 2.7 },
    settle: 1,
  },
  {
    slug: 'seahorse-valley',
    title: 'Zoom until it surprises you',
    blurb: 'Seahorse valley, 200× in. A second argument buys more iterations for deep zooms.',
    // The framing rides in the link as a view(…) row: landing on the default
    // view would show the whole set, not the valley the caption promises.
    // Equal x/y spans make fitView2D match the shot's span convention exactly
    // (span 0.042 centered on -0.7627 + 0.1085i), so no `view:` override.
    eqs: ['iter(z^2 + w, 600)', 'view(x = -0.7837..-0.7417, y = 0.0875..0.1295)'],
    group: 'Fractals',
    settle: 1.2,
  },
  {
    slug: 'julia',
    title: 'Julia sets',
    blurb: 'Fix the constant instead of reading it from the plane, and the pixel becomes the starting point.',
    eqs: ['iter(z^2 - 0.7269 + 0.1889i)'],
    group: 'Fractals',
    view: { span: 2.8 },
    settle: 1,
  },
  {
    slug: 'burning-ship',
    title: 'Any map you can write',
    blurb: 'Nothing is hard-coded: fold absolute values into the step and the burning ship appears.',
    eqs: ['iter((|re(z)| - i |im(z)|)^2 + w)'],
    group: 'Fractals',
    view: { cx: -0.35, cy: 0.5, span: 2.9 },
    settle: 1,
  },
  {
    slug: 'pendulum-phase',
    title: 'ODEs and phase portraits',
    blurb: "Write (x′, y′) = (P, Q) and the flow appears — click to trace an orbit.",
    eqs: ["(x', y') = (y, -sin(x))"],
    group: 'Vector fields & ODEs',
    settle: 0.8,
    clicks: [[0.55, 0.40], [0.50, 0.14]],
  },
  {
    slug: 'slope-field',
    title: 'Slope fields from dy/dx',
    blurb: 'An equation in dy/dx or y′ paints its direction field; clicked solutions follow it.',
    eqs: ["y' = x - y"],
    group: 'Vector fields & ODEs',
    settle: 0.8,
    clicks: [[0.42, 0.25], [0.56, 0.78]],
  },
  {
    slug: 'vector-swirl',
    title: 'Vector fields as flow',
    blurb: 'A tuple in x and y is a vector field, rendered as animated streamlines.',
    eqs: ['(sin(y), sin(x))'],
    group: 'Vector fields & ODEs',
    settle: 0.8,
  },
  {
    slug: 'double-pendulum',
    title: 'Simulations that have no formula',
    blurb: 'The double pendulum as it is derived: M(θ) ω′ = f, a vector state solved by Cramer each step.',
    eqs: [
      'g = 9.8', 'L1 = 1', 'L2 = 1', 'm1 = 1', 'm2 = 1',
      'M = [((m1+m2) L1, m2 L2 cos(th_1 - th_2)), (L1 cos(th_1 - th_2), L2)]',
      'f = (-m2 L2 om_2^2 sin(th_1 - th_2) - (m1+m2) g sin(th_1), L1 om_1^2 sin(th_1 - th_2) - g sin(th_2))',
      "th' = om",
      "om' = solve(M, f)",
      'th(0) = (2.5, 2.4)',
      'b1 = (L1 sin(th_1), -L1 cos(th_1))',
      'b2 = b1 + (L2 sin(th_2), -L2 cos(th_2))',
      'segment((0, 0), b1)',
      'segment(b1, b2)',
      'b1',
      'b2',
    ],
    group: 'Vector fields & ODEs',
    settle: 3.4,
    view: { cy: -0.9, span: 4.6 },
  },
  {
    slug: 'cardioid-polar',
    title: 'Define your own coordinates',
    blurb: 'Declare r and θ, and the grid itself becomes polar.',
    eqs: ['r = sqrt(x^2 + y^2)', 'theta = atan2(y, x)', 'r = 2(1 + cos(theta))'],
    group: 'Coordinate systems',
  },
  {
    slug: 'log-polar',
    title: 'Any chart you like',
    blurb: 'Log-polar, hyperbolic, or anything you can write down.',
    eqs: ['rho = ln(x^2 + y^2)/2', 'theta = atan2(y, x)'],
    group: 'Coordinate systems',
  },
  {
    slug: 'hyperbolic-grid',
    title: 'Grids from level sets',
    blurb: 'The gridlines are the level curves of your coordinate functions.',
    eqs: ['p = x y', 'q = (x^2 - y^2)/2'],
    group: 'Coordinate systems',
  },
  {
    slug: 'tangent-line',
    title: 'Calculus built in',
    blurb: 'd/dx is symbolic — drag the slider for a to slide the tangent point.',
    eqs: ['f(x) = x^3 - 2x', 'g(x) = d/dx f(x)', 'a = 1', 'y = f(x)', 'y = f(a) + g(a)(x - a)'],
    group: 'Calculus & sliders',
  },
  {
    slug: 'fourier-series',
    title: 'Sums and series',
    blurb: 'Σ expands symbolically before compiling — drag N to add harmonics.',
    eqs: ['N = 8', 'y = 2 sum[n=1..N] (-1)^(n+1) sin(n x)/n'],
    group: 'Calculus & sliders',
  },
  {
    slug: 'running-integral',
    title: 'Integrals too',
    blurb: '∫ is symbolic where a closed form exists — a running integral plots like any other curve, and definite ones report their value.',
    eqs: ['f(x) = sin(x)^2', 'y = f(x)', 'y = int[0..x] f(t) dt'],
    group: 'Calculus & sliders',
    view: { cy: 0.85, span: 4 },
  },
  {
    slug: 'sine-integral',
    title: 'Beyond closed forms',
    blurb: 'Si(x) has no elementary antiderivative — a quadrature sum expands instead, so it still compiles to the GPU.',
    eqs: ['y = int[0..x] sin(t)/t dt'],
    group: 'Calculus & sliders',
    view: { span: 5.5 },
  },
  {
    slug: 'lissajous',
    title: 'Parametric motion',
    blurb: 'Curves in u, moving points in t — on the same axes.',
    eqs: ['(2cos(2pi u), sin(4pi u))', '(2cos(t), sin(2t))'],
    group: 'Calculus & sliders',
    settle: 2.6,
  },
  {
    slug: 'piecewise',
    title: 'Piecewise definitions',
    blurb: 'Cases with inequality conditions, tried in order; the last bare value is the default. With no default the curve is undefined elsewhere, so {0 < x < 2: x^2} restricts a domain.',
    eqs: ['y = {x < 0: -x, x >= 0: x^2/4}'],
    group: 'Curves & regions',
    view: { cx: 0, cy: 2, span: 6.7 },
  },
  {
    slug: 'basel',
    title: 'Sequences plot as dots',
    blurb: 'Integer abscissae only — and a Σ toggle on the row sums the series.',
    eqs: ['a_n = 1/n^2'],
    group: 'Sequences & data',
    view: { cx: 4.5, cy: 0.55, span: 7 },
  },
  {
    slug: 'cobweb',
    title: 'Recurrences draw cobwebs',
    blurb: 'The map, the diagonal, and the orbit from a_0 — drag r to watch it destabilize.',
    eqs: ['r = 2.9', 'a_0 = 0.15', 'a_{n+1} = r a_n (1 - a_n)'],
    group: 'Sequences & data',
    view: { cx: 0.45, cy: 0.42, span: 1.75 },
  },
  {
    slug: 'logistic-bifurcation',
    title: 'Put the parameter on an axis',
    blurb: 'With x free in the map, every pixel column iterates its own orbit: the bifurcation diagram.',
    eqs: ['a_{n+1} = x a_n (1 - a_n)'],
    group: 'Sequences & data',
    view: { cx: 1, cy: 0.3, span: 4.9 },
  },
  {
    slug: 'data-list',
    title: 'Data lists',
    blurb: 'A bracketed list scatters at (k, value) — or as points, or bars via the row toggle.',
    eqs: ['[3, 1, 4, 1, 5, 9, 2, 6]', '[(1, 2), (2, 3.5), (3, 3.1), (4, 5)]'],
    group: 'Sequences & data',
    view: { cx: 4.5, cy: 4.2, span: 10.7 },
  },
  {
    slug: 'circle-drag',
    title: 'Named points you can drag',
    blurb: 'Define points and build on them — drag P and the circle keeps radius |P − C|.',
    eqs: ['C = (0, 0)', 'P = (2, 1)', 'circle(C, |P - C|)', 'segment(C, P)'],
    group: 'Geometry',
    view: { span: 6.5 },
  },
  {
    slug: 'varignon',
    title: 'Point arithmetic',
    blurb: 'midpoint, perp, and |A − B| work on points — the midpoints of any quadrilateral make a parallelogram.',
    eqs: [
      'A = (-3, -1)', 'B = (2, -2)', 'C = (3, 2)', 'D = (-2, 3)',
      'polygon(A, B, C, D)',
      'polygon(midpoint(A, B), midpoint(B, C), midpoint(C, D), midpoint(D, A))',
    ],
    group: 'Geometry',
    view: { cy: 0.5, span: 8 },
  },
  {
    slug: 'rosette',
    title: 'Rotate, repeat, take the hull',
    blurb: 'A list is a variable: rotate a shape by a list of angles and you get one copy per angle. hull(…) wraps any points — even moving ones — in their convex hull.',
    eqs: ['th = 2pi [0..5]/6', 'P = [(1, 0), (3, 0.6), (3, -0.6)]', 'rotate(hull(P), th + t/3)', 'n = 7', 'polygon(rotate((0.8, 0), 2pi [0..n-1]/n - t/3))'],
    group: 'Geometry',
    view: { span: 8 },
    settle: 0.6,
  },
  {
    slug: 'matrix-exponential',
    title: 'Rotations are matrix exponentials',
    blurb: 'e^(tA) solves (x′, y′) = A(x, y) exactly: with A = J it is a rotation, and with any other 2×2 a spiral, saddle or node. The dots are e^(sA) applied to one point for a list of times s; the last row rides along them with t.',
    eqs: ['A = [(-0.2, -1), (1, -0.2)]', 's = [0..60]/5', 'e^(s A) (3, 0)', 'e^(t A) (3, 0)'],
    group: 'Geometry',
    view: { span: 8 },
  },
  {
    slug: 'thebault',
    title: 'Theorems you can drag',
    blurb: "Squares on a parallelogram: Thébault's theorem says their centers form a square. Drag a corner — it keeps being true.",
    eqs: [
      'A = (0, 0)', 'B = (4, 0.5)', 'D = (1, 2.5)', 'C = B + D - A',
      'polygon(A, B, C, D)',
      'square(B, A)', 'square(C, B)', 'square(D, C)', 'square(A, D)',
      'P = midpoint(A, B) - perp(B - A)/2',
      'Q = midpoint(B, C) - perp(C - B)/2',
      'R = midpoint(C, D) - perp(D - C)/2',
      'S = midpoint(D, A) - perp(A - D)/2',
      'polygon(P, Q, R, S)',
    ],
    group: 'Geometry',
    view: { cx: 2.5, cy: 1.5, span: 12.5 },
  },
  {
    slug: 'normal-prob',
    title: 'Random variables',
    blurb: 'X ~ Normal(m, s) plots its density; P(a < X < b) shades the area and reports the number.',
    eqs: ['m = 1', 's = 0.5', 'X ~ Normal(m, s)', 'P(0 < X < 2)'],
    group: 'Probability',
    view: { cx: 1, cy: 0.35, span: 2 },
  },
  {
    slug: 'clt',
    title: 'Sums are convolutions',
    blurb: 'Distinct variables are independent, so the density of S is a real convolution — four uniforms already hug the matching normal.',
    eqs: [
      'X1 ~ Uniform(0, 1)', 'X2 ~ Uniform(0, 1)', 'X3 ~ Uniform(0, 1)', 'X4 ~ Uniform(0, 1)',
      'S = X1 + X2 + X3 + X4', 'Z ~ Normal(2, sqrt(1/3))',
    ],
    group: 'Probability',
    // Crops just under y = 1 and right of x = 1, so the four unit-box base
    // densities stay out of frame and the two bells carry the shot.
    view: { cx: 2, cy: 0.42, span: 1.15 },
  },
  {
    slug: 'conditional-rv',
    title: 'Compute with random variables',
    blurb: 'Derived variables get densities of their own — the stem is Y’s point mass — and P works on any event, even P(Y > X).',
    eqs: ['X ~ Normal(0, 1)', 'Y = {X > 0: X^2, 1}', 'P(Y > 0.5)'],
    group: 'Probability',
    view: { cx: 0.3, cy: 0.4, span: 1.7 },
  },
  {
    slug: 'blob',
    title: 'Implicit surfaces in 3D',
    blurb: 'Add a z and the same equation ray-marches on the GPU.',
    eqs: ['x^2 + y^2 + z^2 + sin(2x)sin(2y)sin(2z) = 4'],
    group: 'The third dimension',
  },
  {
    slug: 'torus',
    title: 'Parametric surfaces',
    blurb: 'Three components in u and v make a surface.',
    eqs: ['(cos(2pi u)(2+cos(2pi v)), sin(2pi u)(2+cos(2pi v)), sin(2pi v))'],
    group: 'The third dimension',
  },
  {
    slug: 'sphere-helix',
    title: 'Mix and match',
    blurb: 'Surfaces, curves and points share one scene.',
    eqs: ['x^2 + y^2 + z^2 = 4', '(2cos(6pi u), 2sin(6pi u), 4u - 2)'],
    group: 'The third dimension',
  },
  {
    slug: 'icosahedron',
    title: 'Solids from a few points',
    blurb: 'Independent lists cross — (0, [-1,1], [-φ,φ]) is four points — three turns about (1,1,1) make twelve, and hull(…) wraps them in a shaded icosahedron. The cube beside it is hull(([-1,1],[-1,1],[-1,1])), tumbling by e^(t cross(n)).',
    eqs: [
      'phi = (1+sqrt(5))/2', 'k = 2pi [0..2]/3',
      'hull(rotate((0, [-1,1], [-phi,phi]), k, (1, 1, 1)))',
      'e^(t cross((1, 1, 1)/sqrt(3))) hull(([-1,1], [-1,1], [-1,1])) + (4, 0, 0)',
    ],
    group: 'The third dimension',
    settle: 0.8,
  },
  {
    slug: 'trefoil',
    title: 'Knots as solid tubes',
    blurb: 'Wrap a space curve in tube(…) and it sweeps a shaded solid — knots read at a glance, with curvature and torsion combs a click away.',
    eqs: ['tube((sin(2pi u) + 2sin(4pi u), cos(2pi u) - 2cos(4pi u), -sin(6pi u)))'],
    group: 'The third dimension',
  },
];
