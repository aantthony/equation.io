/**
 * The examples menu: [category, [[label, rows], …]] in menu order. Rows are
 * separated by ';', as in the URL hash. Kept apart from main.ts so a PR that
 * adds examples is a diff of this file alone.
 *
 * Categories run roughly from first plots to showcases. Labels are lowercase
 * except for proper nouns and acronyms. lib/examples.test.ts compiles every
 * row, so a broken example fails CI rather than a visitor's first click.
 */
export const EXAMPLES: Array<[string, Array<[string, string]>]> = [
  [
    'curves',
    [
      ['parabola', 'y = x^2'],
      ['circle', 'x^2 + y^2 = 4'],
      ['tan(x)', 'y = tan(x)'],
      ['lemniscate', '(x^2+y^2)^2 = 8(x^2-y^2)'],
      ['moiré', 'sin(x^2 + y^2) = cos(x y)'],
      ['beats', 'y = sin(5x) + sin(5.5x)'],
      ['traveling wave', 'y = sin(x - 2t)'],
      ['standing wave = two traveling', 'y = sin(x - 2t); y = sin(x + 2t); y = sin(x - 2t) + sin(x + 2t)'],
      ['factorial', 'view(x = -5..5, y = -5..5); y = x!'],
      ['piecewise', 'y = {x < 0: -x, x >= 0: x^2}'],
      ['domain restriction', 'y = {-2 < x < 2: x^2}'],
      ['half a circle', 'x^2 + y^2 = {x > 0: 4}'],
    ],
  ],
  [
    'regions',
    [
      ['open half-plane', 'y < x/2 + 1'],
      ['closed disc', 'x^2 + y^2 <= 4'],
      ['annulus', '4 <= x^2 + y^2 <= 9'],
      ['band under a wave', '-1 <= y - sin(x) < 1'],
      // A continuous interval is a parameter like u: with u it fills the
      // region it traces, and beside x and y it sweeps the region its family
      // of curves covers.
      ['annulus traced by an interval', 'r = interval(1, 2); (r cos(2 pi u), r sin(2 pi u))'],
      [
        'curves swept over an interval',
        'view(x = -6..6, y = -2..2); a = interval(1, 2); y = sin(a x); y = sin(x); y = sin(2x)',
      ],
      // A reduction over a filter measures the set in its own dimension:
      // area for a region, length for a curve.
      ['area of the unit disc', 'x^2 + y^2 < 1; count(x^2 + y^2 < 1)'],
      ['length of a parabola arc', 'y = {0 < x < 1: x^2}; count({y = x^2, 0 < x < 1})'],
      ['area between curves', 'y = x^2; y = 1; x^2 < y < 1; count(x^2 < y < 1)'],
      // A recursive function runs as a loop per pixel; the region is where it
      // terminates with f >= 0.
      [
        'Koch snowflake (recursion)',
        'view(y = -2.2..2.2); f(z) = {re(z) >= 1: 1, f(4 - 3(z^6)^(1/6))}; f(x i - |y|) >= 0',
      ],
    ],
  ],
  [
    'parametric curves',
    [
      ['lissajous', '(2cos(2pi u), sin(4pi u))'],
      ['spiral', '(u cos(6pi u) 3, u sin(6pi u) 3)'],
      ['rose (slide k)', 'k = 4; (2cos(2pi k u)cos(2pi u), 2cos(2pi k u)sin(2pi u))'],
      ['nephroid', '(3cos(2pi u) - cos(6pi u), 3sin(2pi u) - sin(6pi u))'],
      // The pen lifts at each pole rather than drawing a vertical asymptote.
      ['tangent, lifted at poles', '(4u - 2, tan(12u - 6))'],
    ],
  ],
  [
    'fields + color',
    [
      ['egg crate', 'sin(x)cos(y)'],
      ['ripples', 'sin(x^2 + y^2 - 4t)/2'],
      ['level sets', 'c = 0.3; sin(x)cos(y) = c'],
      ['coprime cells', '1 / gcd(floor(x), floor(y))'],
      ['RGB color field', 'rgb(sin(x-t)^2, sin(y-t)^2, sin(x+y+t)^2)'],
      ['HSL color wheel', 'hsl(arg(w)+t/3, 1, 0.5)'],
      ['OKLCH color wheel', 'oklch(0.72, 0.16, arg(w)+t/3)'],
    ],
  ],
  [
    'sliders + calculus',
    [
      ['slider', 'a = 2; y = sin(a x)/a'],
      ['function', 'f(x) = x^3 - 3x; y = f(x)'],
      ['derivative', 'y = d/dx (x^3 - 3x)'],
      ['second derivative', 'f(x) = x^4 - 3x^2; y = f(x); y = d/dx f(x); y = d^2/dx^2 f(x)'],
      ['power rule family', 'N = [1..4]; y = x^N; y = d/dx x^N'],
      [
        'secant → tangent (slide h)',
        'f(x) = x^3 - 2x; a = 1; h = 1; y = f(x); m = (f(a + h) - f(a))/h; y = f(a) + m (x - a); (a, f(a)); (a + h, f(a + h))',
      ],
      ['tangent line', 'f(x) = x^3 - 2x; g(x) = d/dx f(x); a = 1; y = f(x); y = f(a) + g(a)(x - a)'],
      ['running integral', 'view(x = -7..7, y = -1.5..4); f(x) = sin(x)^2; y = f(x); y = int[0..x] f(t) dt'],
      ['signed area', 'view(x = -1..7, y = -1.5..1.5); b = 5; y = sin(x); int[0..b] sin(x) dx'],
      // One rectangle per element of k; the total over the same k beside the
      // exact integral.
      [
        'Riemann sum (slide n)',
        'view(x = -1..7, y = -0.5..3); f(x) = sin(x) + 1.5; n = 8; a = 0; b = 6; h = (b - a)/n; k = [0..n-1]; y = f(x); ' +
          'polygon((a + k h, 0), (a + k h + h, 0), (a + k h + h, f(a + k h)), (a + k h, f(a + k h))); ' +
          'total(f(a + k h) h); int[a..b] f(x) dx',
      ],
      ['antiderivative', 'f(x) = x^2 - 1; y = f(x); y = int(f(x) dx)'],
      ['Gaussian integral = √π', 'view(x = -3.5..3.5, y = -0.6..1.6); y = exp(-x^2); int[-inf..inf] exp(-x^2) dx'],
      ['Gaussian error fn', 'view(x = -4..4, y = -1.2..1.2); y = int[0..x] exp(-t^2) dt'],
      ['normal cdf', 'view(x = -4..4, y = -0.6..1.2); y = normalpdf(x, 0, 1); y = int[-inf..x] normalpdf(t, 0, 1) dt'],
      ['sine integral Si(x)', 'view(x = -20..20, y = -2.2..2.2); y = int[0..x] sin(t)/t dt'],
    ],
  ],
  [
    'sequences + series',
    [
      ['sequence', 'a_n = 1/n^2'],
      ['alternating harmonic', 'a_n = (-1)^(n+1)/n'],
      ['prime indicator', 'a_n = isprime(n)'],
      ['alternating sum → ln 2', 'a_n = (-1)^(n+1)/n; s_n = sum(k=1..n, a_k); y = ln(2)'],
      ['differences of squares', 'b_n = n^2; a_n = b_[n+1] - b_n'],
      ['sequence statistics', 'a_n = 1/n; L = a_[1..20]; L; mean(L); hist(L)'],
      ['cobweb', 'r = 2.9; a_0 = 0.15; a_{n+1} = r a_n (1 - a_n)'],
      ['logistic bifurcation', 'a_{n+1} = x a_n (1 - a_n)'],
      [
        'rule 30',
        'r = floor(clamp(30, 0, 255)); c_{n+1}[i] = mod(floor(r / 2^(4 c_n[i-1] + 2 c_n[i] + c_n[i+1])), 2); view(x = -60..60, y = -80..2)',
      ],
      [
        'rule 110 from a random row',
        'r = floor(clamp(110, 0, 255)); c_0[i] = {i < 0: mod(floor(i i 0.618), 2), 0}; c_{n+1}[i] = mod(floor(r / 2^(4 c_n[i-1] + 2 c_n[i] + c_n[i+1])), 2); view(x = -120..20, y = -100..2)',
      ],
      ['Newton’s method for √2', 'a_0 = 3; a_{n+1} = a_n - (a_n^2 - 2)/(2 a_n); y = sqrt(2)'],
      ['Fourier square wave', 'N = 3; y = (4/pi) sum(n=1..N, sin((2n-1)x)/(2n-1))'],
      ['Fourier sawtooth', 'N = 5; y = 2 sum[n=1..N] (-1)^(n+1) sin(n x)/n'],
      // A list bound draws every partial sum at once: one curve per element.
      ['Fourier convergence', 'N = [1, 3, 10]; y = (4/pi) sum(n=1..N, sin((2n-1)x)/(2n-1))'],
      ['Taylor cosine', 'N = 2; y = sum(n=0..N, (-1)^n x^(2n)/prod(k=1..2n, k)); y = cos(x)'],
      ['Taylor sine, term by term', 'N = [0..4]; y = sum(n=0..N, (-1)^n x^(2n+1)/prod(k=1..2n+1, k)); y = sin(x)'],
    ],
  ],
  [
    'lists + data',
    [
      // A dot plot on the number line: 1, 3 and 5 repeat, so they stack.
      ['data list', '[3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5]'],
      ['scatter', '[(1, 2), (2, 3.5), (3, 3.1), (4, 5)]'],
      // A list is a variable: both uses of s move together, one point each.
      ['sampled curve', 's = [0..50]/5; (s, sin(s))'],
      [
        'filters + summaries',
        'view(x = -7..12, y = -1..10); L = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5]; L; L > 3; count(L > 3); mean(L); median(L); stdev(L)',
      ],
      ['family of lines', 'y = [-2, -1, 0, 1, 2] x'],
      ['concentric circles', 'circle((0, 0), [1, 2, 3, 4])'],
    ],
  ],
  [
    'regression',
    [
      [
        'line fit and residuals',
        'view(x = -1..6, y = -1..10); P = [(0,1.1),(1,2.9),(2,5.2),(3,6.8),(4,9.1)]; P.y ~ m P.x + b; P; y = m x + b; # above the line; P.y > m P.x + b; ' +
          '# residuals; (P.x,P.y-(m P.x+b)); total((P.y - (m P.x + b))^2)',
      ],
      ['quadratic fit', 'P = [(-2,9),(-1,2),(0,1),(1,6),(2,17)]; P.y ~ a P.x^2 + b P.x + c; P; y = a x^2 + b x + c'],
      ['exponential fit', 'P = [(0,2),(0.5,2.84),(1,4.03),(1.5,5.72),(2,8.11)]; P.y ~ a exp(b P.x); P; y = a exp(b x)'],
    ],
  ],
  [
    'points + motion',
    [
      ['a point (drag it)', '(2, 3)'],
      ['point on sliders', 'a = 1; b = 2; (a, b)'],
      ['point on a curve', 'a = 1; f(x) = x^3 - 3x; y = f(x); (a, f(a))'],
      ['orbiting point', '(2cos(t), 2sin(t))'],
      ['sine as a projection', 'P = (cos(t), sin(t)); circle((0, 0), 1); segment((0, 0), P); segment(P, (P_x, 0)); P'],
      ['motion trail', 'A = (2cos(3t), 2sin(2t)); trail(A)'],
    ],
  ],
  [
    'geometry (drag the points)',
    [
      ['segment + midpoint', 'A = (-2, -1); B = (2, 1.5); segment(A, B); midpoint(A, B)'],
      [
        'perpendicular bisector',
        'A = (-2, -1); B = (2, 1.5); segment(A, B); M = midpoint(A, B); line(M, M + perp(B - A))',
      ],
      ['circle through a point', 'C = (0, 0); P = (2, 1); circle(C, |P - C|); segment(C, P)'],
      ['square on a segment', 'A = (-1, 0); B = (2, 1); square(A, B)'],
      [
        'triangle: a side and its angles',
        'A = (-2, -1); B = (3, -0.5); C = (0.5, 2.5); polygon(A, B, C); distance(A, B); angle(B, A, C) 180/pi; angle(B, A, C) + angle(C, B, A) + angle(A, C, B)',
      ],
      [
        'vector sum (parallelogram rule)',
        'A = (3, 1); B = (1, 2); vector(A); vector(B); vector(A + B); polyline(A, A + B, B)',
      ],
      [
        'Thébault’s theorem',
        '# a parallelogram; A = (0, 0); B = (4, 0.5); D = (1, 2.5); C = B + D - A; polygon(A, B, C, D); ' +
          '# squares on its sides; square(B, A); square(C, B); square(D, C); square(A, D); ' +
          '# their centres make a square; P = midpoint(A, B) - perp(B - A)/2; Q = midpoint(B, C) - perp(C - B)/2; ' +
          'R = midpoint(C, D) - perp(D - C)/2; S = midpoint(D, A) - perp(A - D)/2; ' +
          'polygon(P, Q, R, S)',
      ],
      [
        'Bézier curve',
        'A = (-3, -1); B = (-1, 2); C = (1, 2); D = (3, -1); polyline(A, B, C, D); ' +
          '(1-u)^3 A + 3(1-u)^2 u B + 3(1-u) u^2 C + u^3 D',
      ],
      [
        '3D triangle and its normal',
        'A = (0, 0, 0); B = (3, 0, 1); C = (0, 2, 2); polygon(A, B, C); vector(A, cross(B - A, C - A)/3); angle(B - A, C - A)',
      ],
    ],
  ],
  [
    'matrices, rotations + hulls',
    [
      ['determinant = signed area', 'A = (2, 0.5); B = (0.5, 1.5); polygon((0, 0), A, A + B, B); det((A, B))'],
      [
        'a matrix maps a circle',
        'p = 2; q = 1; r = 1; s = 1; M = ((p, q), (r, s)); (cos(2pi u), sin(2pi u)); ' +
          'M (cos(2pi u), sin(2pi u)); det(M)',
      ],
      // A list is a variable: every use of `th` moves together. sort makes
      // the turns a tuple, so the polygon has an order to join them in.
      ['regular polygon', 'n = 7; th = 2pi sort([0..n-1])/n; polygon(rotate((2, 0), th + t/4))'],
      [
        'rotate a shape (matrix exponential)',
        'J = ((0, -1), (1, 0)); a = 0.7; R = e^(a J); P = ((0, 0), (3, 0), (3, 1), (1, 1), (1, 2), (0, 2)); polygon(P); polygon(R P)',
      ],
      ['rosette of hulls', 'th = 2pi [0..5]/6; P = [(1, 0), (3, 0.6), (3, -0.6)]; rotate(hull(P), th + t/3)'],
      [
        'convex hull of moving points',
        'P = [(-3, -1), (-1, 2), (0.5, -2), (2, 1.5), (3, -0.5), (0, 0.3), (1, 0.5 + 2sin(t))]; hull(P); P',
      ],
      [
        'exact linear flow: e^(tA)',
        "A = ((-0.2, -1), (1, -0.2)); s = [0..60]/5; (x', y') = A (x, y); e^(s A) (3, 0); e^(t A) (3, 0)",
      ],
      [
        'deform a lattice (arrows)',
        'a = [-10..10]/2; b = [-10..10]/2; P = (a, b); f(x,y) = (x + sin(y + t)/3, y + sin(x)/3); vector(P, f(P)); f(P)',
      ],
    ],
  ],
  [
    'tensors',
    [
      // n ⊗ n is the matrix of v ↦ n (n·v): every point drops onto the line.
      [
        'outer product projects: n ⊗ n',
        'a = 0.5; n = (cos(a), sin(a)); (4u - 2) n; th = 2pi [0..11]/12; p = 2(cos(th), sin(th)); p; vector(p, (n ⊗ n) p)',
      ],
      [
        'reflection: I − 2 n ⊗ n',
        'a = 0.5; n = (cos(a), sin(a)); n · (x, y) = 0; H = ((1, 0), (0, 1)) - 2 n ⊗ n; ' +
          'S = ((0, 0), (3, 0), (3, 1), (1, 1), (1, 2), (0, 2)); polygon(S); H polygon(S)',
      ],
      // A ⊗ B is rank 4; contracting its middle pair is the matrix product.
      [
        'product = outer, then contract',
        'A = ((1, 2), (3, 4)); B = ((0, 1), (1, 0)); A ⊗ B; contract(A ⊗ B, 2, 3); A B',
      ],
      // e_x ∧ e_y ∧ e_z is the Levi-Civita symbol; fed three edges it is
      // the box's signed volume.
      [
        'volume element e_x ∧ e_y ∧ e_z',
        'a = (2, 0, 0); b = (0.5, 1.5, 0); c = (0.3, 0.4, 1.2); hull([0, 1] a + [0, 1] b + [0, 1] c); ' +
          'V = e_x ∧ e_y ∧ e_z; V c b a; det((a, b, c))',
      ],
      // A bivector a ∧ b generates the rotation in the plane of a and b.
      [
        'rotate in the plane a ∧ b (slide k)',
        'k = 1; a = (1, 0, 0); b = (0, cos(k), sin(k)); e^(t a ∧ b) hull(([-1,1], [-1,1], [-1,1])); vector(3 a); vector(3 b)',
      ],
      // total and mean take a multiset of tensors entry by entry. The level
      // sets of the Mahalanobis distance through C⁻¹ are the 1σ and 2σ ellipses.
      [
        'covariance: mean of (P − m) ⊗ (P − m)',
        'P = [(-3, -2), (-2, -2.5), (-1, 0), (0, -0.5), (0, 1), (1, 0.5), (2, 2.5), (3, 1.5), (-1.5, -1), (1.5, 2)]; ' +
          'm = mean(P); C = mean((P - m) ⊗ (P - m)); C; P; m; ' +
          '((x, y) - m) · C^-1 ((x, y) - m) = 1; ((x, y) - m) · C^-1 ((x, y) - m) = 4',
      ],
    ],
  ],
  [
    'vector fields + odes (click to trace)',
    [
      ['rotation', '(-y, x)'],
      ['saddle', '(x, -y)'],
      ['shear + swirl', '(sin(y), sin(x))'],
      ['slope field', "y' = x - y"],
      ['logistic growth', 'dy/dx = y(1 - y/4)'],
      ['pendulum phase portrait', "(x', y') = (y, -sin(x))"],
      ['Lotka–Volterra', "view(x = -4..11, y = -1..6); (x', y') = (x - x y/2, x y/4 - y)"],
      ['Van der Pol', "(x', y') = (y, (1 - x^2)y - x)"],
      // A linear system as its literal matrix; drag the entries' sliders.
      ['matrix phase portrait', "a = -1; b = -1/4; A = ((0, 1), (a, b)); (x', y') = A (x, y)"],
      [
        'Lorenz field (3D)',
        "camera(-pi/3, 0.5, 55, (0, 0, 25)); (x', y', z') = (10(y - x), x(28 - z) - y, x y - 8z/3)",
      ],
    ],
  ],
  // ∇ rows expand symbolically; a row reading “Holds everywhere” is an
  // identity checked numerically, not drawn.
  [
    'vector calculus',
    [
      ['gradient ⟂ level curves', 'f(x, y) = x^2 + 2y^2; f(x, y) = [1, 4, 9, 16]; ∇f'],
      ['gradient of a saddle', 'f(x, y) = x^2 - y^2; f(x, y); ∇f'],
      [
        'directional derivative (slide a)',
        'f(x, y) = sin(x) cos(y); a = clamp(0.3, 0, 2pi); dir = (cos(a), sin(a)); vector((0, 0), dir); ∇f · dir',
      ],
      ['divergence: sources and sinks', 'F = (sin(x), sin(y)); F; ∇·F'],
      ['source: divergence-free off the origin', 's = (x, y); s/|s|^2; ∇·(s/|s|^2) = 0'],
      ['rotation: curl 2', 'F = (-y, x); F; ∇×F'],
      ['vortex: curl-free off the origin', 'F = (-y, x)/(x^2 + y^2); F; ∇×F = 0'],
      ['curl in 3D', 'F = (0, 0, x^2 + y^2); ∇×F'],
      ['harmonic: Laplacian 0', 'f(x, y) = x^3 - 3x y^2; f(x, y); ∇²f = 0'],
      [
        'd’Alembert wave solution',
        'view(x = -8..8, y = -0.5..1.5); c = clamp(1, 0.25, 2); g(s) = exp(-s^2); f(x, t) = (g(x - c t) + g(x + c t))/2; y = f(x, mod(t, 8)); d^2/dt^2 f(x, t) = c^2 ∇^2 f(x, t)',
      ],
      ['drum membrane mode', 'h = sin(x) sin(y) cos(sqrt(2) t); h; d^2/dt^2 h = ∇^2 h'],
      // The wave lives in space; its slice through z = 0 draws in the plane.
      [
        'spherical wave (slice z = 0)',
        'rho = sqrt(x^2 + y^2 + z^2); sin(sqrt(x^2 + y^2) - t)/sqrt(x^2 + y^2); d^2/dt^2 (sin(rho - t)/rho) = ∇^2 (sin(rho - t)/rho)',
      ],
    ],
  ],
  [
    'simulations (↻ to restart)',
    [
      // th = angle (theta), om = angular velocity (omega): the textbook names.
      // Name each bob as a point, draw the rod with segment(), draw the mass by
      // naming the point on its own row.
      [
        'swinging pendulum',
        "th' = om; om' = -sin(th) - om/8; th(0) = 3; bob = (sin(th), -cos(th)); segment((0, 0), bob); bob",
      ],
      // th(0..30) is the orbit ahead of time, (t, th) the pendulum riding it.
      [
        'pendulum over time',
        "view(x = -1..31, y = -3.5..3.5, ratio = 3); th' = om; om' = -sin(th) - om/8; th(0) = 3; th(0..30); (t, th)",
      ],
      // A list of starting values runs the system once per element.
      ['a dozen pendulums', "(x', y') = (y, -sin(x)); th' = om; om' = -sin(th); th(0) = [1..12]/4; (th, om)"],
      // The Lagrangian form M(th) om' = f(th, om): th and om are 2-vector
      // states (components th_1, th_2), M the mass matrix, solve() Cramer.
      [
        'double pendulum',
        '# parameters; g = 9.8; L1 = 1; L2 = 1; m1 = 1; m2 = 1; ' +
          '# equations of motion; ' +
          'M = (((m1+m2) L1, m2 L2 cos(th_1 - th_2)), (L1 cos(th_1 - th_2), L2)); ' +
          'f = (-m2 L2 om_2^2 sin(th_1 - th_2) - (m1+m2) g sin(th_1), L1 om_1^2 sin(th_1 - th_2) - g sin(th_2)); ' +
          "th' = om; om' = solve(M, f); " +
          'th(0) = (2.5, 2.4); ' +
          '# drawing; ' +
          'b1 = (L1 sin(th_1), -L1 cos(th_1)); ' +
          'b2 = b1 + (L2 sin(th_2), -L2 cos(th_2)); ' +
          'segment((0, 0), b1); segment(b1, b2); b1; b2; trail(b2)',
      ],
      // r'' = -mu r/|r|^3, written as the vectors it is. The state r draws as
      // a point; below escape velocity the orbit is an ellipse.
      [
        'orbit (vector gravity)',
        "r' = vel; vel' = -9 r/|r|^3; r(0) = (2, 0); vel(0) = (0, 1.5); segment((0, 0), r); r; (0, 0)",
      ],
      // pos = displacement, vel = velocity: a phase portrait in (pos, vel).
      ['driven oscillator', "pos' = vel; vel' = sin(2t) - pos - vel/5; (pos, vel)"],
      [
        'SIR epidemic',
        'view(x = -45..105, y = -0.1..1.1, ratio = 50); b = 0.3; g = 0.1; ' +
          "S' = -b S sick; sick' = b S sick - g sick; S(0) = 0.99; sick(0) = 0.01; R = 1 - S - sick; " +
          'S(0..100); sick(0..100); R(0..100)',
      ],
      // One 3-component state; the plot row projects onto the x–z plane.
      [
        'Lorenz attractor',
        "r' = (10(r_2 - r_1), r_1(28 - r_3) - r_2, r_1 r_2 - 8 r_3/3); " + 'r(0) = (1, 1, 20); (r_1/4, r_3/4 - 6)',
      ],
      // 100 runs from nearby starts spread over the attractor one run traces;
      // the starts are a tuple, so p[1] is the first run.
      [
        'Lorenz attractor in 3D',
        "camera(-pi/3, 0.5, 55, (0, 0, 25)); p' = (10(p_2 - p_1), p_1(28 - p_3) - p_2, p_1 p_2 - 8 p_3/3); " +
          'p(0) = (sort([0..99])/10, 1, 20); p[1](5..40); p',
      ],
    ],
  ],
  [
    'probability: continuous',
    [
      ['normal density', 'X ~ Normal(0, 1)'],
      ['expectation', 'X ~ Uniform(0, 1); Y = X^2; E(Y); E(X + Y)'],
      ['P(X < b)', 'a = 1; b = 0.5; X ~ Normal(0, a); P(X < b)'],
      ['between two bounds', 'X ~ Normal(0, 1); P(-1 < X < 2)'],
      ['uniform + exponential', 'X ~ Uniform(0, 2); Y ~ Exponential(1); P(0.5 < X < 1.5)'],
      ['sum = convolution', 'X ~ Uniform(0, 1); Y ~ Uniform(0, 1); X + Y'],
      ['conditional variable', 'X ~ Normal(0, 1); Y = {X > 0: X^2, 1}; P(Y > 0.5); P(Y > X)'],
      [
        'central limit theorem',
        'view(x = -0.5..4.5, y = -0.15..1.35); ' +
          'X1 ~ Uniform(0, 1); X2 ~ Uniform(0, 1); X3 ~ Uniform(0, 1); X4 ~ Uniform(0, 1); ' +
          'S = X1 + X2 + X3 + X4; Z ~ Normal(2, sqrt(1/3)); P(S > 3)',
      ],
      [
        'gamma waiting times',
        'view(x = -1..9, y = -0.1..0.9, ratio = 6); a = 2; b = 1; X ~ Gamma(a, b); Y ~ Exponential(b); ' +
          'P(X > 4); S = X + Y',
      ],
      ['beta shapes', 'view(x = -0.2..1.2, y = -0.3..3.5, ratio = 0.25); a = 0.5; b = 0.5; X ~ Beta(a, b); P(X < 0.2)'],
      [
        'chi-squared from normals',
        'view(x = -1..7, y = -0.1..1.1, ratio = 4); Z ~ Normal(0, 1); Q = Z^2; C ~ ChiSquared(3); ' + 'P(Q > 3.84)',
      ],
      [
        'heavy tails: t and Cauchy',
        'view(x = -6..6, y = -0.05..0.45, ratio = 15); k = 2; Z ~ Normal(0, 1); X ~ T(k); ' +
          'C ~ Cauchy(0, 1); P(X > 2); E(C)',
      ],
      [
        'lognormal + Weibull',
        'view(x = -0.5..4, y = -0.1..1, ratio = 2); X ~ LogNormal(0, 0.5); Y ~ Weibull(2, 1); P(X > 2)',
      ],
    ],
  ],
  [
    'probability: discrete',
    [
      ['a fair die', 'view(x = -0.5..7.5, y = -0.02..0.3, ratio = 16); D ~ DiscreteUniform(1, 6); P(2 < D <= 5); E(D)'],
      [
        'two dice',
        'view(x = 0.5..13.5, y = -0.02..0.22, ratio = 40); X ~ DiscreteUniform(1, 6); Y ~ DiscreteUniform(1, 6); ' +
          'S = X + Y; P(S >= 10); P(X > Y); P(X >= Y); E(S)',
      ],
      [
        'a die, halved and squared',
        'view(x = -1..38, y = -0.02..0.22, ratio = 120); D ~ DiscreteUniform(1, 6); D / 2; D^2; ' +
          'P(D^2 <= 9); E(D^2)',
      ],
      [
        'binomial stems',
        'view(x = -1.5..21.5, y = -0.02..0.24, ratio = 50); n = 20; p = 0.3; X ~ Binomial(n, p); ' + 'P(X <= 4); E(X)',
      ],
      [
        'Poisson: < versus <=',
        'view(x = -1.5..13.5, y = -0.02..0.28, ratio = 30); m = 4; X ~ Poisson(m); ' + 'P(X < 3); P(X <= 3); P(X = 3)',
      ],
      [
        'Poisson counts add',
        'view(x = -1.5..16.5, y = -0.02..0.3, ratio = 40); a = 2; b = 3; A ~ Poisson(a); B ~ Poisson(b); ' +
          'S = A + B; P(S <= 4); P(A = B)',
      ],
      [
        'waiting for a success',
        'view(x = -1.5..21.5, y = -0.02..0.3, ratio = 40); p = 0.25; G ~ Geometric(p); ' +
          'W ~ NegativeBinomial(3, p); P(G > 4)',
      ],
      [
        'a count plus noise',
        'view(x = -2..10, y = -0.03..0.33, ratio = 25); s = 0.25; N ~ Poisson(3); Z ~ Normal(0, s); Y = N + Z; ' +
          'P(Y < 2.5)',
      ],
    ],
  ],
  [
    'complex',
    [
      ['point charge', 'ln(w)'],
      ['dipole', 'ln(w-2) - ln(w+2)'],
      ['quadrupole', 'ln(w-2) + ln(w+2) - ln(w-2i) - ln(w+2i)'],
      ['flow past cylinder', 'w + 4/w'],
      ['orbiting charge', 'ln(w-2) - ln(w + 2e^(i t))'],
      ['breathing dipole', 'r = 2 + sin(t); ln(w - r) - ln(w + r)'],
      ['domain coloring', 'domain((w^3 - 1)/w)'],
      ['conformal map', 'conformal(w^2/4)'],
      ['Joukowski airfoil', 'conformal(w + 1/w)'],
      ['unit circle path', 'exp(i 2 pi u)'],
      ['image of a circle', 'f(w) = w^2 + w; exp(i 2 pi u); f(exp(i 2 pi u))'],
      ['roots of unity', 'w^3 = 1'],
      ['complex numbers as points', '1+2i; 2e^(i t)'],
    ],
  ],
  [
    'fractals',
    [
      ['Mandelbrot set', 'iter(z^2 + w)'],
      ['Julia set', 'iter(z^2 - 0.7269 + 0.1889i)'],
      ['Julia orbit', 'iter(z^2 + 0.7885e^(i t/8))'],
      ['burning ship', 'iter((|re(z)| - i |im(z)|)^2 + w)'],
    ],
  ],
  [
    'polar + plane coordinates',
    [
      ['polar grid', 'r = sqrt(x^2 + y^2); theta = atan2(y, x)'],
      ['polar point (drag it)', 'r = sqrt(x^2 + y^2); theta = atan2(y, x); (r, theta) = (2, 0.8)'],
      // Not `e`: that is the constant, so `e = 0.6` would read as a false claim.
      ['conics by eccentricity', 'r = sqrt(x^2 + y^2); theta = atan2(y, x); ecc = 0.6; r = 2/(1 + ecc cos(theta))'],
      ['cardioid in polar', 'r = sqrt(x^2 + y^2); theta = atan2(y, x); r = 2(1 + cos(theta))'],
      ['Archimedean spiral', 'r = sqrt(x^2 + y^2); theta = atan2(y, x); r = theta + pi'],
      ['spiral traced in (r, θ)', 'r = sqrt(x^2 + y^2); theta = atan2(y, x); (r, theta) = (3u, 6pi u)'],
      ['spinning polar', 'r = sqrt(x^2 + y^2); theta = atan2(y, x) + t/4'],
      ['polar limit cycle', "r = sqrt(x^2 + y^2); theta = atan2(y, x); (r', theta') = (r(1-r), 1)"],
      ['log-polar', 'rho = ln(x^2 + y^2)/2; theta = atan2(y, x)'],
      ['hyperbolic grid', 'p = x y; q = (x^2 - y^2)/2'],
      ['hyperbolic pair', 'p = x y; q = (x^2 - y^2)/2; (p, q) = (1, 0)'],
    ],
  ],
  [
    'spherical + cylindrical',
    [
      [
        'spherical chart',
        'rho = sqrt(x^2 + y^2 + z^2); theta = atan2(y, x); phi = acos(z/rho); ' +
          'rho = 2; (rho, theta, phi) = (2, pi/4, pi/3)',
      ],
      [
        'spherical flower',
        'rho = sqrt(x^2 + y^2 + z^2); theta = atan2(y, x); phi = acos(z/rho); rho = 2 + cos(3 theta) sin(phi)^2',
      ],
      [
        'spherical spiral',
        'rho = sqrt(x^2 + y^2 + z^2); theta = atan2(y, x); phi = acos(z/rho); ' +
          'rho = 2; (rho, theta, phi) = (2, 12 pi u, pi u)',
      ],
      [
        'cylindrical chart',
        'r = sqrt(x^2 + y^2); theta = atan2(y, x); r = 1.5 + sin(2 z)/2; (r, theta, z) = (2.5, 6 pi u, 6 u - 3)',
      ],
      ['cylindrical flow', "r = sqrt(x^2 + y^2); theta = atan2(y, x); (r', theta', z') = (0, 1, 0.5)"],
    ],
  ],
  [
    'systems',
    [
      [
        'curve intersection',
        'x^2 + y^2 = 4; x y = 1; (x^2 + y^2 - 4, x y - 1) = (0, 0); count({x^2 + y^2 = 4, x y = 1})',
      ],
      ['three planes', '(x + y, x - y, z) = (1, 2, 3)'],
      ['sphere meets plane', '(x^2 + y^2 + z^2, z) = (9, 1)'],
      // Alpöge's counterexample to the Jacobian conjecture (July 2026), found by
      // Fable: det JF = -2 everywhere, yet the fiber over (-1/4, 0, 0) holds the
      // three points the solver marks. JF's rows are the gradients of F's
      // components, and its determinant reads -2 at the fiber point (1, -1.5,
      // 6.5). Drag c above 0 and two of the points leave — they escape to
      // infinity, which is how an étale map gets to be 3-to-1.
      [
        'Jacobian counterexample',
        'c = -0.25; F = ((1 + x y)³ z + y² (1 + x y)(4 + 3x y), y + 3x (1 + x y)² z + 3x y² (4 + 3x y), 2x − 3x² y − x³ z); JF(x,y,z) = (∇F_x, ∇F_y, ∇F_z); det(JF(1, −1.5, 6.5)); (F_x, F_y, F_z) = (c, 0, 0)',
      ],
    ],
  ],
  [
    '3D surfaces',
    [
      ['waves', 'z = sin(x)cos(y)'],
      ['sphere', 'x^2 + y^2 + z^2 = 9'],
      ['saddle', 'z = (x^2 - y^2)/4'],
      ['gyroid', 'sin(x)cos(y) + sin(y)cos(z) + sin(z)cos(x) = 0'],
      ['vase (revolve)', 'a = 1; revolve({-3 < y < 3: 1.5 + a sin(y) / 2}, y)'],
      ['torus', '(cos(2pi u)(2+cos(2pi v)), sin(2pi u)(2+cos(2pi v)), sin(2pi v))'],
      ['sphere (u,v)', '(2sin(pi v)cos(2pi u), 2sin(pi v)sin(2pi u), 2cos(pi v))'],
      ['breathing torus', '(cos(2pi u)(2+cos(2pi v+t)), sin(2pi u)(2+cos(2pi v+t)), sin(2pi v+t))'],
    ],
  ],
  [
    'solids',
    [
      // Separate [..] literals are independent and cross: 2 × 2 × 2 corners.
      ['corners of a cube', '([0,1], [0,1], [0,1])'],
      ['tumbling cube', 'e^(t cross((1, 1, 1)/sqrt(3))) hull(([-1,1], [-1,1], [-1,1]))'],
      ['octahedron', 'k = 2pi [0..2]/3; hull(rotate(([-2,2], 0, 0), k, (1, 1, 1)))'],
      ['icosahedron', 'phi = (1+sqrt(5))/2; k = 2pi [0..2]/3; hull(rotate((0, [-1,1], [-phi,phi]), k, (1, 1, 1)))'],
      ['prism (slide n)', 'n = 5; th = 2pi [0..n-1]/n; hull(rotate((2, 0, [-1,1]), th, (0, 0, 1)))'],
    ],
  ],
  [
    '3D curves + knots',
    [
      ['helix', '(2cos(6pi u), 2sin(6pi u), 4u - 2)'],
      ['stacked circles (a list)', '(2cos(2pi u), 2sin(2pi u), [-1, 0, 1])'],
      ['trefoil', 'tube((sin(2pi u) + 2sin(4pi u), cos(2pi u) - 2cos(4pi u), -sin(6pi u)))'],
      ['torus knot (2,5)', 'tube(((2+cos(10pi u))cos(4pi u), (2+cos(10pi u))sin(4pi u), sin(10pi u)))'],
      ['figure eight', 'tube(((2+cos(4pi u))cos(6pi u), (2+cos(4pi u))sin(6pi u), sin(8pi u)))'],
      ['Viviani', 'tube((1+cos(4pi u), sin(4pi u), 2sin(2pi u)), 0.06)'],
    ],
  ],
];
