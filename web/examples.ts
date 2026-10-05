/**
 * The tags an example can carry: what cuts across the categories, so a search
 * for `#animated` or `#physics` gathers examples from all over the menu.
 * Space-separated in each example; lib/examples.test.ts holds every example
 * to at least one, all from this list.
 */
export const TAGS = [
  // how it behaves
  'animated',
  'slider',
  'draggable',
  '3d',
  'split-view',
  // what it draws
  'implicit',
  'inequality',
  'parametric',
  'piecewise',
  'surface',
  'scalar-field',
  'vector-field',
  'color',
  'coordinates',
  // the mathematics
  'polynomial',
  'trig',
  'conic',
  'special-function',
  'number-theory',
  'derivative',
  'integral',
  'measure',
  'sequence',
  'series',
  'fourier',
  'recursion',
  'automaton',
  'graph',
  'fractal',
  'chaos',
  'complex',
  'conformal',
  'geometry',
  'vector',
  'matrix',
  'tensor',
  'geometric-algebra',
  'quaternion',
  'knot',
  'ode',
  'pde',
  'waves',
  'list',
  'data',
  'statistics',
  'regression',
  'probability',
  // where it comes from
  'physics',
  'biology',
] as const;

/**
 * The examples menu: [category, [[label, rows, tags], …]] in menu order. Rows
 * are separated by ';', as in the URL hash; tags by spaces, from TAGS. Kept
 * apart from main.ts so a PR that adds examples is a diff of this file alone.
 *
 * Categories run roughly from first plots to showcases. Labels are lowercase
 * except for proper nouns and acronyms. lib/examples.test.ts compiles every
 * row, so a broken example fails CI rather than a visitor's first click.
 */
export const EXAMPLES: Array<[string, Array<[string, string, string]>]> = [
  [
    'curves',
    [
      ['parabola', 'y = x^2', 'polynomial'],
      ['circle', 'x^2 + y^2 = 4', 'conic implicit'],
      ['tan(x)', 'y = tan(x)', 'trig'],
      ['lemniscate', '(x^2+y^2)^2 = 8(x^2-y^2)', 'implicit polynomial'],
      ['moiré', 'sin(x^2 + y^2) = cos(x y)', 'implicit trig'],
      ['beats', 'y = sin(5x) + sin(5.5x)', 'trig waves'],
      ['traveling wave', 'y = sin(x - 2t)', 'trig waves animated'],
      [
        'standing wave = two traveling',
        'y = sin(x - 2t); y = sin(x + 2t); y = sin(x - 2t) + sin(x + 2t)',
        'trig waves animated',
      ],
      ['factorial', 'view(x = -5..5, y = -5..5); y = x!', 'special-function'],
      ['piecewise', 'y = {x < 0: -x, x >= 0: x^2}', 'piecewise polynomial'],
      ['domain restriction', 'y = {-2 < x < 2: x^2}', 'piecewise polynomial'],
      ['half a circle', 'x^2 + y^2 = {x > 0: 4}', 'piecewise conic implicit'],
    ],
  ],
  [
    'regions',
    [
      ['open half-plane', 'y < x/2 + 1', 'inequality'],
      ['closed disc', 'x^2 + y^2 <= 4', 'inequality conic'],
      ['annulus', '4 <= x^2 + y^2 <= 9', 'inequality conic'],
      ['band under a wave', '-1 <= y - sin(x) < 1', 'inequality trig'],
      // A continuous interval is a parameter like u: with u it fills the
      // region it traces, and beside x and y it sweeps the region its family
      // of curves covers.
      ['annulus traced by an interval', 'r = interval(1, 2); (r cos(2 pi u), r sin(2 pi u))', 'parametric trig'],
      [
        'curves swept over an interval',
        'view(x = -6..6, y = -2..2); a = interval(1, 2); y = sin(a x); y = sin(x); y = sin(2x)',
        'trig',
      ],
      // A reduction over a filter measures the set in its own dimension:
      // area for a region, length for a curve.
      ['area of the unit disc', 'x^2 + y^2 < 1; count(x^2 + y^2 < 1)', 'measure inequality conic'],
      ['length of a parabola arc', 'y = {0 < x < 1: x^2}; count({y = x^2, 0 < x < 1})', 'measure polynomial'],
      ['area between curves', 'y = x^2; y = 1; x^2 < y < 1; count(x^2 < y < 1)', 'measure inequality polynomial'],
      // A recursive function runs as a loop per pixel; the region is where it
      // terminates with f >= 0.
      [
        'Koch snowflake (recursion)',
        'view(y = -2.2..2.2); f(z) = {re(z) >= 1: 1, f(4 - 3(z^6)^(1/6))}; f(x i - |y|) >= 0',
        'fractal recursion inequality',
      ],
    ],
  ],
  [
    'parametric curves',
    [
      ['lissajous', '(2cos(2pi u), sin(4pi u))', 'parametric trig'],
      ['spiral', '(u cos(6pi u) 3, u sin(6pi u) 3)', 'parametric trig'],
      ['rose (slide k)', 'k = 4; (2cos(2pi k u)cos(2pi u), 2cos(2pi k u)sin(2pi u))', 'parametric trig slider'],
      ['nephroid', '(3cos(2pi u) - cos(6pi u), 3sin(2pi u) - sin(6pi u))', 'parametric trig'],
      // The pen lifts at each pole rather than drawing a vertical asymptote.
      ['tangent, lifted at poles', '(4u - 2, tan(12u - 6))', 'parametric trig'],
      // curvature, osculating and frame differentiate the curve along u; t
      // as the point rides them round.
      [
        'osculating circle rides an ellipse',
        'C = (3cos(2pi u), 1.5sin(2pi u)); C; osculating(C, t/10); frame(C, t/10); curvature(C, t/10)',
        'parametric derivative geometry animated',
      ],
      [
        'signed curvature flips at inflections (slide s)',
        'view(x = -3..3, y = -2..2); s = clamp(0.1, 0, 1); C = (2sin(2pi u), sin(4pi u)); C; osculating(C, s); frame(C, s); curvature(C, s)',
        'parametric derivative geometry slider',
      ],
    ],
  ],
  [
    'fields + color',
    [
      ['egg crate', 'sin(x)cos(y)', 'scalar-field trig'],
      ['ripples', 'sin(x^2 + y^2 - 4t)/2', 'scalar-field trig waves animated'],
      ['level sets', 'c = 0.3; sin(x)cos(y) = c', 'implicit trig slider'],
      ['coprime cells', '1 / gcd(floor(x), floor(y))', 'scalar-field number-theory'],
      ['RGB color field', 'rgb(sin(x-t)^2, sin(y-t)^2, sin(x+y+t)^2)', 'color trig animated'],
      ['HSL color wheel', 'hsl(arg(w)+t/3, 1, 0.5)', 'color complex animated'],
      ['OKLCH color wheel', 'oklch(0.72, 0.16, arg(w)+t/3)', 'color complex animated'],
    ],
  ],
  [
    'sliders + calculus',
    [
      ['slider', 'a = 2; y = sin(a x)/a', 'slider trig'],
      ['function', 'f(x) = x^3 - 3x; y = f(x)', 'polynomial'],
      ['derivative', 'y = d/dx (x^3 - 3x)', 'derivative polynomial'],
      ['second derivative', 'f(x) = x^4 - 3x^2; y = f(x); y = d/dx f(x); y = d^2/dx^2 f(x)', 'derivative polynomial'],
      ['power rule family', 'N = [1..4]; y = x^N; y = d/dx x^N', 'derivative polynomial list'],
      [
        'secant → tangent (slide h)',
        'f(x) = x^3 - 2x; a = 1; h = 1; y = f(x); m = (f(a + h) - f(a))/h; y = f(a) + m (x - a); (a, f(a)); (a + h, f(a + h))',
        'derivative polynomial slider',
      ],
      [
        'tangent line',
        'f(x) = x^3 - 2x; g(x) = d/dx f(x); a = 1; y = f(x); y = f(a) + g(a)(x - a)',
        'derivative polynomial slider',
      ],
      [
        'running integral',
        'view(x = -7..7, y = -1.5..4); f(x) = sin(x)^2; y = f(x); y = int[0..x] f(t) dt',
        'integral trig',
      ],
      ['signed area', 'view(x = -1..7, y = -1.5..1.5); b = 5; y = sin(x); int[0..b] sin(x) dx', 'integral trig slider'],
      // One rectangle per element of k; the total over the same k beside the
      // exact integral.
      [
        'Riemann sum (slide n)',
        'view(x = -1..7, y = -0.5..3); f(x) = sin(x) + 1.5; n = 8; a = 0; b = 6; h = (b - a)/n; k = [0..n-1]; y = f(x); ' +
          'polygon((a + k h, 0), (a + k h + h, 0), (a + k h + h, f(a + k h)), (a + k h, f(a + k h))); ' +
          'total(f(a + k h) h); int[a..b] f(x) dx',
        'integral slider list',
      ],
      ['antiderivative', 'f(x) = x^2 - 1; y = f(x); y = int(f(x) dx)', 'integral polynomial'],
      [
        'Gaussian integral = √π',
        'view(x = -3.5..3.5, y = -0.6..1.6); y = exp(-x^2); int[-inf..inf] exp(-x^2) dx',
        'integral',
      ],
      [
        'Gaussian error fn',
        'view(x = -4..4, y = -1.2..1.2); y = (2/sqrt(pi)) int[0..x] exp(-t^2) dt',
        'integral special-function',
      ],
      [
        'normal cdf',
        'view(x = -4..4, y = -0.6..1.2); y = normalpdf(x, 0, 1); y = int[-inf..x] normalpdf(t, 0, 1) dt',
        'integral probability',
      ],
      [
        'sine integral Si(x)',
        'view(x = -20..20, y = -2.2..2.2); y = int[0..x] sin(t)/t dt',
        'integral trig special-function',
      ],
    ],
  ],
  [
    'sequences + series',
    [
      ['sequence', 'a_n = 1/n^2', 'sequence'],
      ['alternating harmonic', 'a_n = (-1)^(n+1)/n', 'sequence'],
      ['prime indicator', 'a_n = isprime(n)', 'sequence number-theory'],
      ['alternating sum → ln 2', 'a_n = (-1)^(n+1)/n; s_n = sum(k=1..n, a_k); y = ln(2)', 'sequence series'],
      ['differences of squares', 'b_n = n^2; a_n = b_[n+1] - b_n', 'sequence'],
      ['sequence statistics', 'a_n = 1/n; L = a_[1..20]; L; mean(L); hist(L)', 'sequence statistics list'],
      [
        'cobweb',
        'view(x = 0..1, y = 0..1); r = 2.9; a_0 = 0.15; a_{n+1} = r a_n (1 - a_n)',
        'sequence recursion chaos slider',
      ],
      ['logistic bifurcation', 'a_{n+1} = x a_n (1 - a_n)', 'sequence recursion chaos'],
      ['Newton’s method for √2', 'a_0 = 3; a_{n+1} = a_n - (a_n^2 - 2)/(2 a_n); y = sqrt(2)', 'sequence recursion'],
      ['Fourier square wave', 'N = 3; y = (4/pi) sum(n=1..N, sin((2n-1)x)/(2n-1))', 'fourier series trig slider'],
      ['Fourier sawtooth', 'N = 5; y = 2 sum[n=1..N] (-1)^(n+1) sin(n x)/n', 'fourier series trig slider'],
      // A list bound draws every partial sum at once: one curve per element.
      [
        'Fourier convergence',
        'N = [1, 3, 10]; y = (4/pi) sum(n=1..N, sin((2n-1)x)/(2n-1))',
        'fourier series trig list',
      ],
      [
        'Taylor cosine',
        'N = 2; y = sum(n=0..N, (-1)^n x^(2n)/prod(k=1..2n, k)); y = cos(x)',
        'series polynomial trig slider',
      ],
      [
        'Taylor sine, term by term',
        'N = [0..4]; y = sum(n=0..N, (-1)^n x^(2n+1)/prod(k=1..2n+1, k)); y = sin(x)',
        'series polynomial trig list',
      ],
    ],
  ],
  // The integer lattice (docs/discrete.md): these draw in a lattice panel,
  // whose axes are the rows' own indices.
  [
    'lattices + automata',
    [
      [
        'rule 30',
        'r = floor(clamp(30, 0, 255)); c_{n+1}[i] = mod(floor(r / 2^(4 c_n[i-1] + 2 c_n[i] + c_n[i+1])), 2); view(i = -60..60, n = 0..80)',
        'automaton recursion slider',
      ],
      [
        'rule 110 from a random row',
        'r = floor(clamp(110, 0, 255)); c_0[i] = {i < 0: mod(floor(i i 0.618), 2), 0}; c_{n+1}[i] = mod(floor(r / 2^(4 c_n[i-1] + 2 c_n[i] + c_n[i+1])), 2); view(i = -120..20, n = 0..100)',
        'automaton recursion slider',
      ],
      [
        'Pascal’s triangle mod m',
        'm = 2; p_{n+1}[k] = mod(p_n[k-1] + p_n[k], m); view(k = -4..68, n = 0..64)',
        'automaton number-theory slider',
      ],
      [
        'Game of Life: a glider',
        'life(c, s) = {s = 3: 1, s = 4: c, 0}; L_0 = [(0, 1), (1, 2), (2, 0), (2, 1), (2, 2)]; L_{n+1}[i, j] = life(L_n[i, j], sum(a=-1..1, sum(b=-1..1, L_n[i+a, j+b]))); view(i = -4..24, j = -4..24)',
        'automaton animated',
      ],
      [
        'Game of Life: a random soup',
        'life(c, s) = {s = 3: 1, s = 4: c, 0}; L_0[i, j] = {-20 < i < 20: {-20 < j < 20: mod(floor(43758.5 fract(sin(12.9898 i + 78.233 j))), 2), 0}, 0}; L_{n+1}[i, j] = life(L_n[i, j], sum(a=-1..1, sum(b=-1..1, L_n[i+a, j+b]))); view(i = -60..60, j = -60..60)',
        'automaton animated',
      ],
      ['Cayley table of ℤ/n', 'n = 6; T[i, j] = {0 <= i < n: {0 <= j < n: mod(i + j, n)}}', 'number-theory slider'],
      [
        'units mod n',
        'n = 12; T[i, j] = {0 < i < n: {0 < j < n: {gcd(i, n) = 1: {gcd(j, n) = 1: mod(i j, n)}}}}',
        'number-theory slider',
      ],
      ['gcd table', 'T[i, j] = {i > 0: {j > 0: gcd(i, j)}}', 'number-theory'],
    ],
  ],
  // graph(from, to, label) reads its arguments as one tuple, so the multiset
  // rule builds the edges (lib/graph.ts, docs/discrete.md §4).
  [
    'graphs + state machines',
    [
      ['Cayley graph of ℤ/12', 'n = 12; k = [0..n-1]; g = [1, 4]; graph(k, mod(k + g, n), g)', 'graph number-theory'],
      [
        'D₃: Cayley table and graph',
        '# k = a + 3b is the rotation r^a, then the flip s^b; rot(k) = mod(k, 3); flip(k) = floor(k/3); m(i, j) = mod(rot(i) + (-1)^flip(i) rot(j), 3) + 3 mod(flip(i) + flip(j), 2); T[i, j] = {0 <= i < 6: {0 <= j < 6: m(i, j)}}; --- right; # generated by r = 1 and s = 3; k = [0..5]; g = [1, 3]; graph(k, m(k, g), g)',
        'graph number-theory split-view',
      ],
      [
        'state machine: divisible by 3',
        '# the remainder mod 3 of a binary number, read left to right; Q = [0..2]; S = [0, 1]; step(q, s) = mod(2q + s, 3); graph(Q, step(Q, S), S); # read 13 = 1101, one digit at a time; digit(k) = mod(floor(13 / 2^(3 - k)), 2); run(q, k, m) = {k >= m: q, run(step(q, digit(k)), k + 1, m)}; N = floor(clamp(0, 0, 4)); mark(run(0, 0, N))',
        'graph slider recursion',
      ],
      [
        'matrix multiplication as arrows',
        '# a matrix is a multiset of arrows i → j (Wildberger); A = [(1, 1), (1, 2), (2, 2), (2, 2)]; B = [(1, 2), (2, 1), (2, 2)]; graph(A); --- right; graph(B); --- below; # compose: i → j, then j → k, where they meet; c(p, q) = {p.y = q.x: (p.x, q.y)}; AB = c(A, B); graph(AB); --- right; # two draws from A: A composed with itself, A²; a ∈ A; b ∈ A; graph(c(a, b))',
        'graph matrix list split-view',
      ],
      [
        'Collatz graph',
        'c(m) = {mod(m, 2) = 0: m/2, 3m + 1}; k = [1..12]; graph(k, c(k))',
        'graph number-theory recursion',
      ],
    ],
  ],
  [
    'lists + data',
    [
      // A dot plot on the number line: 1, 3 and 5 repeat, so they stack.
      ['data list', '[3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5]', 'list data'],
      ['scatter', '[(1, 2), (2, 3.5), (3, 3.1), (4, 5)]', 'list data'],
      // A list is a variable: both uses of s move together, one point each.
      ['sampled curve', 's = [0..50]/5; (s, sin(s))', 'list trig'],
      [
        'filters + summaries',
        'view(x = -7..12, y = -1..10); L = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5]; L; L > 3; count(L > 3); mean(L); median(L); stdev(L)',
        'list data statistics',
      ],
      ['family of lines', 'y = [-2, -1, 0, 1, 2] x', 'list'],
      ['concentric circles', 'circle((0, 0), [1, 2, 3, 4])', 'list conic'],
    ],
  ],
  [
    'regression',
    [
      [
        'line fit and residuals',
        'view(x = -1..6, y = -1..10); P = [(0,1.1),(1,2.9),(2,5.2),(3,6.8),(4,9.1)]; P.y ~ m P.x + b; P; y = m x + b; # above the line; P.y > m P.x + b; ' +
          '# residuals; (P.x,P.y-(m P.x+b)); total((P.y - (m P.x + b))^2)',
        'regression data statistics',
      ],
      [
        'quadratic fit',
        'view(x = -3..3, y = -1..18); P = [(-2,9),(-1,2),(0,1),(1,6),(2,17)]; P.y ~ a P.x^2 + b P.x + c; P; ' +
          'y = a x^2 + b x + c',
        'regression data polynomial',
      ],
      [
        'exponential fit',
        'P = [(0,2),(0.5,2.84),(1,4.03),(1.5,5.72),(2,8.11)]; P.y ~ a exp(b P.x); P; y = a exp(b x)',
        'regression data',
      ],
    ],
  ],
  [
    'points + motion',
    [
      ['a point (drag it)', '(2, 3)', 'draggable'],
      ['point on sliders', 'a = 1; b = 2; (a, b)', 'draggable slider'],
      ['point on a curve', 'a = 1; f(x) = x^3 - 3x; y = f(x); (a, f(a))', 'draggable slider polynomial'],
      ['orbiting point', '(2cos(t), 2sin(t))', 'animated trig'],
      [
        'sine as a projection',
        'P = (cos(t), sin(t)); circle((0, 0), 1); segment((0, 0), P); segment(P, (P_x, 0)); P',
        'animated trig geometry',
      ],
      ['motion trail', 'A = (2cos(3t), 2sin(2t)); trail(A)', 'animated trig'],
    ],
  ],
  [
    'geometry (drag the points)',
    [
      ['segment + midpoint', 'A = (-2, -1); B = (2, 1.5); segment(A, B); midpoint(A, B)', 'geometry draggable'],
      [
        'perpendicular bisector',
        'A = (-2, -1); B = (2, 1.5); segment(A, B); M = midpoint(A, B); line(M, M + perp(B - A))',
        'geometry draggable vector',
      ],
      [
        'circle through a point',
        'C = (0, 0); P = (2, 1); circle(C, |P - C|); segment(C, P)',
        'geometry draggable conic',
      ],
      ['square on a segment', 'A = (-1, 0); B = (2, 1); square(A, B)', 'geometry draggable'],
      [
        'triangle: a side and its angles',
        'A = (-2, -1); B = (3, -0.5); C = (0.5, 2.5); polygon(A, B, C); distance(A, B); angle(B, A, C) 180/pi; angle(B, A, C) + angle(C, B, A) + angle(A, C, B)',
        'geometry draggable measure',
      ],
      [
        'vector sum (parallelogram rule)',
        'A = (3, 1); B = (1, 2); vector(A); vector(B); vector(A + B); polyline(A, A + B, B)',
        'geometry draggable vector',
      ],
      [
        'Thébault’s theorem',
        '# a parallelogram; A = (0, 0); B = (4, 0.5); D = (1, 2.5); C = B + D - A; polygon(A, B, C, D); ' +
          '# squares on its sides; square(B, A); square(C, B); square(D, C); square(A, D); ' +
          '# their centres make a square; P = midpoint(A, B) - perp(B - A)/2; Q = midpoint(B, C) - perp(C - B)/2; ' +
          'R = midpoint(C, D) - perp(D - C)/2; S = midpoint(D, A) - perp(A - D)/2; ' +
          'polygon(P, Q, R, S)',
        'geometry draggable',
      ],
      [
        'Bézier curve',
        'A = (-3, -1); B = (-1, 2); C = (1, 2); D = (3, -1); polyline(A, B, C, D); ' +
          '(1-u)^3 A + 3(1-u)^2 u B + 3(1-u) u^2 C + u^3 D',
        'geometry draggable parametric polynomial',
      ],
      [
        '3D triangle and its normal',
        'A = (0, 0, 0); B = (3, 0, 1); C = (0, 2, 2); polygon(A, B, C); vector(A, cross(B - A, C - A)/3); angle(B - A, C - A)',
        'geometry draggable 3d vector',
      ],
    ],
  ],
  [
    'matrices, rotations + hulls',
    [
      [
        'determinant = signed area',
        'A = (2, 0.5); B = (0.5, 1.5); polygon((0, 0), A, A + B, B); det((A, B))',
        'matrix draggable measure',
      ],
      [
        'a matrix maps a circle',
        'p = 2; q = 1; r = 1; s = 1; M = ((p, q), (r, s)); (cos(2pi u), sin(2pi u)); ' +
          'M (cos(2pi u), sin(2pi u)); det(M)',
        'matrix slider parametric',
      ],
      // A list is a variable: every use of `th` moves together. sort makes
      // the turns a tuple, so the polygon has an order to join them in.
      [
        'regular polygon',
        'n = 7; th = 2pi sort([0..n-1])/n; polygon(rotate((2, 0), th + t/4))',
        'geometry slider animated',
      ],
      [
        'rotate a shape (matrix exponential)',
        'J = ((0, -1), (1, 0)); a = 0.7; R = e^(a J); P = ((0, 0), (3, 0), (3, 1), (1, 1), (1, 2), (0, 2)); polygon(P); polygon(R P)',
        'matrix geometry slider',
      ],
      [
        'rosette of hulls',
        'th = 2pi [0..5]/6; P = [(1, 0), (3, 0.6), (3, -0.6)]; rotate(hull(P), th + t/3)',
        'geometry list animated',
      ],
      [
        'convex hull of moving points',
        'P = [(-3, -1), (-1, 2), (0.5, -2), (2, 1.5), (3, -0.5), (0, 0.3), (1, 0.5 + 2sin(t))]; hull(P); P',
        'geometry list animated',
      ],
      [
        'exact linear flow: e^(tA)',
        "A = ((-0.2, -1), (1, -0.2)); s = [0..60]/5; (x', y') = A (x, y); e^(s A) (3, 0); e^(t A) (3, 0)",
        'matrix ode animated',
      ],
      [
        'deform a lattice (arrows)',
        'a = [-10..10]/2; b = [-10..10]/2; P = (a, b); f(x,y) = (x + sin(y + t)/3, y + sin(x)/3); vector(P, f(P)); f(P)',
        'vector list animated',
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
        'tensor vector slider',
      ],
      [
        'reflection: I − 2 n ⊗ n',
        'a = 0.5; n = (cos(a), sin(a)); n · (x, y) = 0; H = ((1, 0), (0, 1)) - 2 n ⊗ n; ' +
          'S = ((0, 0), (3, 0), (3, 1), (1, 1), (1, 2), (0, 2)); polygon(S); H polygon(S)',
        'tensor matrix geometry slider',
      ],
      // A ⊗ B is rank 4; contracting its middle pair is the matrix product.
      [
        'product = outer, then contract',
        'A = ((1, 2), (3, 4)); B = ((0, 1), (1, 0)); A ⊗ B; contract(A ⊗ B, 2, 3); A B',
        'tensor matrix',
      ],
      // e_x ∧ e_y ∧ e_z is the Levi-Civita symbol; fed three edges it is
      // the box's signed volume.
      [
        'volume element e_x ∧ e_y ∧ e_z',
        'a = (2, 0, 0); b = (0.5, 1.5, 0); c = (0.3, 0.4, 1.2); hull([0, 1] a + [0, 1] b + [0, 1] c); ' +
          'V = e_x ∧ e_y ∧ e_z; V c b a; det((a, b, c))',
        'geometric-algebra 3d measure',
      ],
      // A bivector a ∧ b generates the rotation in the plane of a and b.
      [
        'rotate in the plane a ∧ b (slide k)',
        'k = 1; a = (1, 0, 0); b = (0, cos(k), sin(k)); e^(t a ∧ b) hull(([-1,1], [-1,1], [-1,1])); vector(3 a); vector(3 b)',
        'geometric-algebra 3d slider animated',
      ],
      // total and mean take a multiset of tensors entry by entry. The level
      // sets of the Mahalanobis distance through C⁻¹ are the 1σ and 2σ ellipses.
      [
        'covariance: mean of (P − m) ⊗ (P − m)',
        'P = [(-3, -2), (-2, -2.5), (-1, 0), (0, -0.5), (0, 1), (1, 0.5), (2, 2.5), (3, 1.5), (-1.5, -1), (1.5, 2)]; ' +
          'm = mean(P); C = mean((P - m) ⊗ (P - m)); C; P; m; ' +
          '((x, y) - m) · C^-1 ((x, y) - m) = 1; ((x, y) - m) · C^-1 ((x, y) - m) = 4',
        'tensor statistics data',
      ],
      // action(M) draws the images of the unit square, circle and axes.
      ['action of a shear', 'action(((1, 1), (0, 1)))', 'matrix'],
      [
        'action of a turn and a stretch',
        'J = ((0, -1), (1, 0)); action(e^(t J) ((1.5, 0), (0, 0.6)))',
        'matrix animated',
      ],
      // A matrix field draws as glyphs, the image of a small circle at each
      // cell; a conformal map's Jacobian gives circles everywhere.
      ['Jacobian of z²: conformal circles', 'jacobian((x^2 - y^2, 2 x y)/4)', 'derivative complex conformal'],
      ['Hessian: curvature glyphs', 'f(x, y) = sin(x) cos(y); f(x, y); hessian(f)', 'derivative scalar-field'],
      // streamlines(M) traces the major eigenvector instead: here the
      // direction of greatest curvature, round the saddle's degenerate point.
      [
        'monkey saddle: Hessian streamlines',
        'f(x, y) = x^3 - 3 x y^2; f(x, y) = [-6..6]; streamlines(hessian(f))',
        'tensor derivative scalar-field',
      ],
    ],
  ],
  // Multivectors draw grade by grade: vectors as arrows, bivectors as
  // oriented discs, trivectors as cubes; quaternions are the even ones.
  [
    'geometric algebra + quaternions',
    [
      [
        'bivector: an oriented area',
        'a = (2, 0); b = (1, 1.5); vector(a); vector(b); polygon((0, 0), a, a + b, b); grade(a ⟑ b, 2)',
        'geometric-algebra draggable measure',
      ],
      // b ⟑ a = a · b + b ∧ a is a rotor turning twice the angle from a to
      // b: it sends a to its mirror image across b.
      [
        'geometric product: twice the turn from a to b',
        'a = (2, 0.5); b = (0.5, 1.5); vector(a); vector(b); b ⟑ a; vector(rotate(a, b ⟑ a))',
        'geometric-algebra draggable',
      ],
      [
        'a rotor turns a vector',
        'camera(-pi/3, 0.6, 5); R = e^(-(t/2) e_xy); p = (1, 0, 0.8); vector(p); vector(rotate(p, R)); R',
        'geometric-algebra 3d animated',
      ],
      [
        'quaternion slerp between orientations',
        'camera(-pi/3, 0.5, 7); q1 = quat(1, 0, 0, 0); q2 = quat(cos(1), sin(1) (1, 1, 1)/sqrt(3)); ' +
          'rotate(hull(([-1, 1], [-1, 1], [-1, 1])), slerp(q1, q2, (1 - cos(t))/2))',
        'quaternion 3d animated',
      ],
      // Each fiber of S³ → S² is q₀ times the circle e^(iθ); projected
      // stereographically they are linked circles on a torus.
      [
        'Hopf fibration',
        'camera(-pi/3, 0.6, 6); a = 2pi [0..7]/8; h = pi/4; ' +
          'q = quat(cos(h), 0, sin(h) cos(a), sin(h) sin(a)) quat(cos(2pi u), sin(2pi u), 0, 0); ' +
          'vec(q)/(1 - grade(q, 0))',
        'quaternion 3d',
      ],
      // Dirac's belt trick: the cube spins forever while the ribbons' far ends
      // stay put. Each sphere of radius |P| turns rigidly by Q, a chord across
      // the disk the cube's quaternion circles in S³, so the ribbons never
      // touch; at t = 2π (one turn, Q = −1) they are tangled, at 4π straight.
      [
        'belt trick: untangled every 720°',
        'camera(-0.49, 0.31, 7); b = clamp(0.72, 0.2, 1.4) # ribbon width; q = 0.58; k = 2pi [0..2]/3; f = t/2; ' +
          'g = (sqrt((q + 3u)^2 + (b(v-0.5))^2) - sqrt(3) q)/(q + 3 - sqrt(3) q); p = pi clamp(g, 0, 1); ' +
          'c = (1 + cos(p))/2; ' +
          'Q = quat(1 - c(1 - cos(f)), c sin(f) (1,1,1)/sqrt(3) + sin(f/2) sin(p) (1,-1,0)/sqrt(2)); ' +
          'rotate(rotate(([-1,1](q + 3u), b(v-0.5), 0), k, (1,1,1)), Q); ' +
          'rotate(hull(([-q,q], [-q,q], [-q,q])), t, (1,1,1))',
        'quaternion 3d animated slider',
      ],
      [
        'quaternion Julia set (slide s)',
        // q ↦ q² + C in quaternion algebra; the surface is a level of the
        // orbit's Green function ln|q|/2^k, as the Mandelbulb's is.
        'camera(-pi/3, 0.5, 3); s = 0; C = quat(-0.2, 0.8, 0, 0); ' +
          'Q(a, b, c, d, k) = {|quat(a, b, c, d)| > 2: ln(|quat(a, b, c, d)|)/2^k, k >= 12: ln(|quat(a, b, c, d)|)/2^k, Q(quat(a, b, c, d)^2 + C, k + 1)}; ' +
          'Q(x, y, z, s, 0) = 0.001',
        'quaternion fractal 3d slider recursion',
      ],
    ],
  ],
  [
    'vector fields + odes (click to trace)',
    [
      ['rotation', '(-y, x)', 'vector-field'],
      ['saddle', '(x, -y)', 'vector-field'],
      ['shear + swirl', '(sin(y), sin(x))', 'vector-field trig'],
      ['slope field', "y' = x - y", 'ode'],
      ['logistic growth', 'dy/dx = y(1 - y/4)', 'ode biology'],
      ['pendulum phase portrait', "(x', y') = (y, -sin(x))", 'ode physics'],
      // The flow conserves the energy H = y²/2 + V(x), so it runs along H's
      // level sets: the one through the saddles is the separatrix, between
      // swinging (inside) and spinning or crossing over (outside).
      ['pendulum separatrix', "view(x = -7..7, y = -4..4); (x', y') = (y, -sin(x)); y^2/2 - cos(x) = 1", 'ode physics'],
      [
        'double well (slide k)',
        "view(x = -3..3, y = -2..2); k = clamp(1, 0.1, 2); (x', y') = (y, k x - x^3); y^2/2 + x^4/4 - k x^2/2 = 0",
        'ode physics slider',
      ],
      ['Lotka–Volterra', "view(x = -4..11, y = -1..6); (x', y') = (x - x y/2, x y/4 - y)", 'ode biology'],
      ['Van der Pol', "(x', y') = (y, (1 - x^2)y - x)", 'ode physics'],
      // A linear system as its literal matrix; drag the entries' sliders.
      ['matrix phase portrait', "a = -1; b = -1/4; A = ((0, 1), (a, b)); (x', y') = A (x, y)", 'ode matrix slider'],
      [
        'Lorenz field (3D)',
        "camera(-pi/3, 0.5, 55, (0, 0, 25)); (x', y', z') = (10(y - x), x(28 - z) - y, x y - 8z/3)",
        'ode chaos 3d',
      ],
    ],
  ],
  // ∇ rows expand symbolically; a row reading “Holds everywhere” is an
  // identity checked numerically, not drawn.
  [
    'vector calculus',
    [
      [
        'gradient ⟂ level curves',
        'f(x, y) = x^2 + 2y^2; f(x, y) = [1, 4, 9, 16]; ∇f',
        'derivative vector-field implicit',
      ],
      ['gradient of a saddle', 'f(x, y) = x^2 - y^2; f(x, y); ∇f', 'derivative vector-field scalar-field'],
      [
        'directional derivative (slide a)',
        'f(x, y) = sin(x) cos(y); a = clamp(0.3, 0, 2pi); dir = (cos(a), sin(a)); vector((0, 0), dir); ∇f · dir',
        'derivative scalar-field slider',
      ],
      ['divergence: sources and sinks', 'F = (sin(x), sin(y)); F; ∇·F', 'derivative vector-field'],
      ['source: divergence-free off the origin', 's = (x, y); s/|s|^2; ∇·(s/|s|^2) = 0', 'derivative vector-field'],
      ['rotation: curl 2', 'F = (-y, x); F; ∇×F', 'derivative vector-field'],
      ['vortex: curl-free off the origin', 'F = (-y, x)/(x^2 + y^2); F; ∇×F = 0', 'derivative vector-field'],
      ['curl in 3D', 'F = (0, 0, x^2 + y^2); ∇×F', 'derivative vector-field 3d'],
      ['harmonic: Laplacian 0', 'f(x, y) = x^3 - 3x y^2; f(x, y); ∇²f = 0', 'derivative scalar-field'],
      [
        'd’Alembert wave solution',
        'view(x = -8..8, y = -0.5..1.5); c = clamp(1, 0.25, 2); g(s) = exp(-s^2); f(x, t) = (g(x - c t) + g(x + c t))/2; y = f(x, mod(t, 8)); d^2/dt^2 f(x, t) = c^2 ∇^2 f(x, t)',
        'pde waves slider animated',
      ],
      [
        'drum membrane mode',
        'h = sin(x) sin(y) cos(sqrt(2) t); h; d^2/dt^2 h = ∇^2 h',
        'pde waves scalar-field animated',
      ],
      // The wave lives in space; its slice through z = 0 draws in the plane.
      [
        'spherical wave (slice z = 0)',
        'rho = sqrt(x^2 + y^2 + z^2); sin(sqrt(x^2 + y^2) - t)/sqrt(x^2 + y^2); d^2/dt^2 (sin(rho - t)/rho) = ∇^2 (sin(rho - t)/rho)',
        'pde waves scalar-field animated',
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
        'ode physics animated',
      ],
      // th(0..30) is the orbit ahead of time, (t, th) the pendulum riding it.
      [
        'pendulum over time',
        "view(x = -1..31, y = -3.5..3.5, ratio = 3); th' = om; om' = -sin(th) - om/8; th(0) = 3; th(0..30); (t, th)",
        'ode physics',
      ],
      // A list of starting values runs the system once per element.
      [
        'a dozen pendulums',
        "(x', y') = (y, -sin(x)); th' = om; om' = -sin(th); th(0) = [1..12]/4; (th, om)",
        'ode physics vector-field list animated',
      ],
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
        'ode physics chaos animated',
      ],
      // r'' = -mu r/|r|^3, written as the vectors it is. The state r draws as
      // a point; below escape velocity the orbit is an ellipse.
      [
        'orbit (vector gravity)',
        "r' = vel; vel' = -9 r/|r|^3; r(0) = (2, 0); vel(0) = (0, 1.5); segment((0, 0), r); r; (0, 0)",
        'ode physics vector animated',
      ],
      // pos = displacement, vel = velocity: a phase portrait in (pos, vel).
      // X(0..60) draws the path settling from rest onto the driven cycle.
      [
        'driven oscillator',
        "view(x = -2..2, y = -2..2); pos' = vel; vel' = sin(2t) - pos - vel/5; X = (pos, vel); X(0..60); X",
        'ode physics',
      ],
      [
        'SIR epidemic',
        'view(x = -45..105, y = -0.1..1.1, ratio = 50); b = 0.3; g = 0.1; ' +
          "S' = -b S sick; sick' = b S sick - g sick; S(0) = 0.99; sick(0) = 0.01; R = 1 - S - sick; " +
          'S(0..100); sick(0..100); R(0..100)',
        'ode biology',
      ],
      // One 3-component state; q projects it onto the x–z plane, q(5..40)
      // draws the attractor past the transient and q rides along it. (Not P:
      // P(…) is a probability.)
      [
        'Lorenz attractor',
        "r' = (10(r_2 - r_1), r_1(28 - r_3) - r_2, r_1 r_2 - 8 r_3/3); " +
          'r(0) = (1, 1, 20); q = (r_1/4, r_3/4 - 6); q(5..40); q',
        'ode chaos',
      ],
      // 100 runs from nearby starts spread over the attractor one run traces;
      // the starts are a tuple, so p[1] is the first run.
      [
        'Lorenz attractor in 3D',
        "camera(-pi/3, 0.5, 55, (0, 0, 25)); p' = (10(p_2 - p_1), p_1(28 - p_3) - p_2, p_1 p_2 - 8 p_3/3); " +
          'p(0) = (sort([0..99])/10, 1, 20); p[1](5..40); p',
        'ode chaos 3d',
      ],
    ],
  ],
  [
    'probability: continuous',
    [
      ['normal density', 'X ~ Normal(0, 1)', 'probability'],
      ['expectation', 'X ~ Uniform(0, 1); Y = X^2; E(Y); E(X + Y)', 'probability'],
      ['P(X < b)', 'a = 1; b = 0.5; X ~ Normal(0, a); P(X < b)', 'probability slider'],
      ['between two bounds', 'X ~ Normal(0, 1); P(-1 < X < 2)', 'probability'],
      ['uniform + exponential', 'X ~ Uniform(0, 2); Y ~ Exponential(1); P(0.5 < X < 1.5)', 'probability'],
      ['sum = convolution', 'X ~ Uniform(0, 1); Y ~ Uniform(0, 1); X + Y', 'probability'],
      ['conditional variable', 'X ~ Normal(0, 1); Y = {X > 0: X^2, 1}; P(Y > 0.5); P(Y > X)', 'probability piecewise'],
      [
        'central limit theorem',
        'view(x = -0.5..4.5, y = -0.15..1.35); ' +
          'X1 ~ Uniform(0, 1); X2 ~ Uniform(0, 1); X3 ~ Uniform(0, 1); X4 ~ Uniform(0, 1); ' +
          'S = X1 + X2 + X3 + X4; Z ~ Normal(2, sqrt(1/3)); P(S > 3)',
        'probability statistics',
      ],
      [
        'gamma waiting times',
        'view(x = -1..9, y = -0.1..0.9, ratio = 6); a = 2; b = 1; X ~ Gamma(a, b); Y ~ Exponential(b); ' +
          'P(X > 4); S = X + Y',
        'probability slider',
      ],
      [
        'beta shapes',
        'view(x = -0.2..1.2, y = -0.3..3.5, ratio = 0.25); a = 0.5; b = 0.5; X ~ Beta(a, b); P(X < 0.2)',
        'probability slider',
      ],
      [
        'chi-squared from normals',
        'view(x = -1..7, y = -0.1..1.1, ratio = 4); Z ~ Normal(0, 1); Q = Z^2; C ~ ChiSquared(3); ' + 'P(Q > 3.84)',
        'probability statistics',
      ],
      [
        'heavy tails: t and Cauchy',
        'view(x = -6..6, y = -0.05..0.45, ratio = 15); k = 2; Z ~ Normal(0, 1); X ~ T(k); ' +
          'C ~ Cauchy(0, 1); P(X > 2); E(C)',
        'probability slider',
      ],
      [
        'lognormal + Weibull',
        'view(x = -0.5..4, y = -0.1..1, ratio = 2); X ~ LogNormal(0, 0.5); Y ~ Weibull(2, 1); P(X > 2)',
        'probability',
      ],
    ],
  ],
  [
    'probability: discrete',
    [
      [
        'a fair die',
        'view(x = -0.5..7.5, y = -0.02..0.3, ratio = 16); D ~ DiscreteUniform(1, 6); P(2 < D <= 5); E(D)',
        'probability',
      ],
      [
        'two dice',
        'view(x = 0.5..13.5, y = -0.02..0.22, ratio = 40); X ~ DiscreteUniform(1, 6); Y ~ DiscreteUniform(1, 6); ' +
          'S = X + Y; P(S >= 10); P(X > Y); P(X >= Y); E(S)',
        'probability',
      ],
      [
        'a die, halved and squared',
        'view(x = -1..38, y = -0.02..0.22, ratio = 120); D ~ DiscreteUniform(1, 6); D / 2; D^2; ' +
          'P(D^2 <= 9); E(D^2)',
        'probability',
      ],
      [
        'binomial stems',
        'view(x = -1.5..21.5, y = -0.02..0.24, ratio = 50); n = 20; p = 0.3; X ~ Binomial(n, p); ' + 'P(X <= 4); E(X)',
        'probability slider',
      ],
      [
        'Poisson: < versus <=',
        'view(x = -1.5..13.5, y = -0.02..0.28, ratio = 30); m = 4; X ~ Poisson(m); ' + 'P(X < 3); P(X <= 3); P(X = 3)',
        'probability slider',
      ],
      [
        'Poisson counts add',
        'view(x = -1.5..16.5, y = -0.02..0.3, ratio = 40); a = 2; b = 3; A ~ Poisson(a); B ~ Poisson(b); ' +
          'S = A + B; P(S <= 4); P(A = B)',
        'probability slider',
      ],
      [
        'waiting for a success',
        'view(x = -1.5..21.5, y = -0.02..0.3, ratio = 40); p = 0.25; G ~ Geometric(p); ' +
          'W ~ NegativeBinomial(3, p); P(G > 4)',
        'probability slider',
      ],
      [
        'a count plus noise',
        'view(x = -2..10, y = -0.03..0.33, ratio = 25); s = 0.25; N ~ Poisson(3); Z ~ Normal(0, s); Y = N + Z; ' +
          'P(Y < 2.5)',
        'probability slider',
      ],
    ],
  ],
  [
    'complex',
    [
      ['point charge', 'ln(w)', 'complex physics'],
      ['dipole', 'ln(w-2) - ln(w+2)', 'complex physics'],
      ['quadrupole', 'ln(w-2) + ln(w+2) - ln(w-2i) - ln(w+2i)', 'complex physics'],
      ['flow past cylinder', 'w + 4/w', 'complex physics'],
      ['orbiting charge', 'ln(w-2) - ln(w + 2e^(i t))', 'complex physics animated'],
      ['breathing dipole', 'r = 2 + sin(t); ln(w - r) - ln(w + r)', 'complex physics animated'],
      ['domain coloring', 'domain((w^3 - 1)/w)', 'complex color'],
      ['conformal map', 'conformal(w^2/4)', 'complex conformal'],
      ['Joukowski airfoil', 'conformal(w + 1/w)', 'complex conformal physics'],
      ['unit circle path', 'exp(i 2 pi u)', 'complex parametric'],
      ['image of a circle', 'f(w) = w^2 + w; exp(i 2 pi u); f(exp(i 2 pi u))', 'complex parametric polynomial'],
      ['roots of unity', 'w^3 = 1', 'complex polynomial'],
      ['complex numbers as points', '1+2i; 2e^(i t)', 'complex animated'],
    ],
  ],
  [
    'fractals',
    [
      // Framed on the set: the default view is ~12 units across, where these
      // are a smudge at the origin.
      ['Mandelbrot set', 'view(x = -2.2..0.8, y = -1.3..1.3); iter(z^2 + w)', 'fractal complex'],
      ['Julia set', 'view(x = -1.7..1.7, y = -1.1..1.1); iter(z^2 - 0.7269 + 0.1889i)', 'fractal complex'],
      ['Julia orbit', 'view(x = -1.8..1.8, y = -1.3..1.3); iter(z^2 + 0.7885e^(i t/8))', 'fractal complex animated'],
      ['burning ship', 'view(x = -2.4..1.7, y = -1.2..1.9); iter((|re(z)| - i |im(z)|)^2 + w)', 'fractal complex'],
      // The "triplex" power raises r to n and multiplies both spherical
      // angles by n. An escape count jumps, which the raymarcher cannot
      // draw; the orbit's Green function ln|p|/n^k is continuous, and a small
      // level of it hugs the set.
      [
        'Mandelbulb (slide n)',
        'camera(-pi/3, 0.4, 5); n = 8; S(R, t, p) = R (sin(t) cos(p), sin(t) sin(p), cos(t)); ' +
          'r(a, b, c) = sqrt(a^2 + b^2 + c^2); T(a, b, c) = S(r(a, b, c)^n, n acos(c/r(a, b, c)), n atan2(b, a)); ' +
          'G(a, b, c, k) = {r(a, b, c) > 2: ln(r(a, b, c))/n^k, k >= 12: ln(r(a, b, c))/n^k, G(T(a, b, c) + (x, y, z), k + 1)}; ' +
          'G(x, y, z, 0) = 0.001',
        'fractal 3d slider recursion',
      ],
    ],
  ],
  [
    'polar + plane coordinates',
    [
      ['polar grid', 'r = sqrt(x^2 + y^2); theta = atan2(y, x)', 'coordinates'],
      [
        'polar point (drag it)',
        'r = sqrt(x^2 + y^2); theta = atan2(y, x); (r, theta) = (2, 0.8)',
        'coordinates draggable',
      ],
      // Not `e`: that is the constant, so `e = 0.6` would read as a false claim.
      [
        'conics by eccentricity',
        'r = sqrt(x^2 + y^2); theta = atan2(y, x); ecc = 0.6; r = 2/(1 + ecc cos(theta))',
        'coordinates conic slider',
      ],
      ['cardioid in polar', 'r = sqrt(x^2 + y^2); theta = atan2(y, x); r = 2(1 + cos(theta))', 'coordinates trig'],
      ['Archimedean spiral', 'r = sqrt(x^2 + y^2); theta = atan2(y, x); r = theta + pi', 'coordinates'],
      [
        'spiral traced in (r, θ)',
        'r = sqrt(x^2 + y^2); theta = atan2(y, x); (r, theta) = (3u, 6pi u)',
        'coordinates parametric',
      ],
      ['spinning polar', 'r = sqrt(x^2 + y^2); theta = atan2(y, x) + t/4', 'coordinates animated'],
      ['polar limit cycle', "r = sqrt(x^2 + y^2); theta = atan2(y, x); (r', theta') = (r(1-r), 1)", 'coordinates ode'],
      ['log-polar', 'rho = ln(x^2 + y^2)/2; theta = atan2(y, x)', 'coordinates'],
      ['hyperbolic grid', 'p = x y; q = (x^2 - y^2)/2', 'coordinates'],
      ['hyperbolic pair', 'p = x y; q = (x^2 - y^2)/2; (p, q) = (1, 0)', 'coordinates'],
    ],
  ],
  [
    'spherical + cylindrical',
    [
      [
        'spherical chart',
        'rho = sqrt(x^2 + y^2 + z^2); theta = atan2(y, x); phi = acos(z/rho); ' +
          'rho = 2; (rho, theta, phi) = (2, pi/4, pi/3)',
        'coordinates 3d',
      ],
      [
        'spherical flower',
        'rho = sqrt(x^2 + y^2 + z^2); theta = atan2(y, x); phi = acos(z/rho); rho = 2 + cos(3 theta) sin(phi)^2',
        'coordinates 3d surface trig',
      ],
      [
        'spherical spiral',
        'rho = sqrt(x^2 + y^2 + z^2); theta = atan2(y, x); phi = acos(z/rho); ' +
          'rho = 2; (rho, theta, phi) = (2, 12 pi u, pi u)',
        'coordinates 3d parametric',
      ],
      [
        'cylindrical chart',
        'r = sqrt(x^2 + y^2); theta = atan2(y, x); r = 1.5 + sin(2 z)/2; (r, theta, z) = (2.5, 6 pi u, 6 u - 3)',
        'coordinates 3d surface parametric',
      ],
      [
        'cylindrical flow',
        "r = sqrt(x^2 + y^2); theta = atan2(y, x); (r', theta', z') = (0, 1, 0.5)",
        'coordinates 3d ode',
      ],
    ],
  ],
  [
    'systems',
    [
      [
        'curve intersection',
        'x^2 + y^2 = 4; x y = 1; (x^2 + y^2 - 4, x y - 1) = (0, 0); count({x^2 + y^2 = 4, x y = 1})',
        'implicit conic measure',
      ],
      // The planes are cut to a ball about where they meet, so the solution
      // the system marks sits at the centre of what is drawn.
      [
        'three planes',
        'within = (x - 1.5)^2 + (y + 0.5)^2 + (z - 3)^2 < 4; x + y = {within: 1}; x - y = {within: 2}; z = {within: 3}; (x + y, x - y, z) = (1, 2, 3)',
        '3d implicit piecewise',
      ],
      ['sphere meets plane', '(x^2 + y^2 + z^2, z) = (9, 1)', '3d conic'],
      // Alpöge's counterexample to the Jacobian conjecture (July 2026), found by
      // Fable: det JF = -2 everywhere, yet the fiber over (-1/4, 0, 0) holds the
      // three points the solver marks. JF's rows are the gradients of F's
      // components, and its determinant reads -2 at the fiber point (1, -1.5,
      // 6.5). Drag c above 0 and two of the points leave — they escape to
      // infinity, which is how an étale map gets to be 3-to-1. The camera
      // lifts the frame to z = 6.5 and turns so the two high points separate;
      // it stays close because the solver's search box grows with the camera
      // distance, and from radius 20 its seeds miss one of the pair.
      [
        'Jacobian counterexample',
        'camera(0.6, 0.35, 14, (0, 0, 3)); c = -0.25; F = ((1 + x y)³ z + y² (1 + x y)(4 + 3x y), y + 3x (1 + x y)² z + 3x y² (4 + 3x y), 2x − 3x² y − x³ z); JF(x,y,z) = (∇F_x, ∇F_y, ∇F_z); det(JF(1, −1.5, 6.5)); (F_x, F_y, F_z) = (c, 0, 0)',
        '3d polynomial derivative',
      ],
    ],
  ],
  [
    '3D surfaces',
    [
      ['waves', 'z = sin(x)cos(y)', '3d surface trig'],
      ['sphere', 'x^2 + y^2 + z^2 = 9', '3d surface implicit conic'],
      ['saddle', 'z = x^2 - y^2', '3d surface polynomial'],
      // Unbounded, the gyroid surrounds the camera; a ball cuts out a piece.
      ['gyroid', 'sin(x)cos(y) + sin(y)cos(z) + sin(z)cos(x) = {x^2 + y^2 + z^2 < 36: 0}', '3d surface implicit trig'],
      ['vase (revolve)', 'a = 1; revolve({-3 < y < 3: 1.5 + a sin(y) / 2}, y)', '3d surface slider'],
      ['torus', '(cos(2pi u)(2+cos(2pi v)), sin(2pi u)(2+cos(2pi v)), sin(2pi v))', '3d surface parametric'],
      ['sphere (u,v)', '(2sin(pi v)cos(2pi u), 2sin(pi v)sin(2pi u), 2cos(pi v))', '3d surface parametric'],
      // The tube radius swells and shrinks with t (shifting v by t would
      // only slide the same torus along itself).
      [
        'breathing torus',
        '(cos(2pi u)(2+(1+sin(t)/2)cos(2pi v)), sin(2pi u)(2+(1+sin(t)/2)cos(2pi v)), (1+sin(t)/2)sin(2pi v))',
        '3d surface parametric animated',
      ],
    ],
  ],
  [
    'fields in space',
    [
      // A bare expression in x, y, z is a cloud: row colour where it is
      // positive, the complement where negative, denser where it is larger.
      ['Gaussian cloud', 'exp(-(x^2 + y^2 + z^2)/4)', '3d scalar-field'],
      ['octants of x y z', 'x y z', '3d scalar-field polynomial'],
      ['hydrogen 2p orbital', 'z exp(-sqrt(x^2 + y^2 + z^2)/2)', '3d scalar-field physics'],
      ['dipole potential', '1/sqrt(x^2 + y^2 + (z - 1)^2) - 1/sqrt(x^2 + y^2 + (z + 1)^2)', '3d scalar-field physics'],
      // The ray stops at the surface, so the cloud in front of it tints it.
      [
        'a level surface inside its cloud',
        'f(x, y, z) = exp(-(x^2 + y^2 + z^2)/4); f(x, y, z); f(x, y, z) = 0.8',
        '3d scalar-field surface implicit',
      ],
      ['standing wave', 'sin(x) sin(y) sin(z) cos(2t)', '3d scalar-field animated waves'],
    ],
  ],
  [
    'solids',
    [
      // Separate [..] literals are independent and cross: 2 × 2 × 2 corners.
      ['corners of a cube', '([0,1], [0,1], [0,1])', '3d geometry list'],
      ['tumbling cube', 'e^(t cross((1, 1, 1)/sqrt(3))) hull(([-1,1], [-1,1], [-1,1]))', '3d geometry matrix animated'],
      ['octahedron', 'k = 2pi [0..2]/3; hull(rotate(([-2,2], 0, 0), k, (1, 1, 1)))', '3d geometry list'],
      [
        'icosahedron',
        'phi = (1+sqrt(5))/2; k = 2pi [0..2]/3; hull(rotate((0, [-1,1], [-phi,phi]), k, (1, 1, 1)))',
        '3d geometry list',
      ],
      [
        'prism (slide n)',
        'n = 5; th = 2pi [0..n-1]/n; hull(rotate((2, 0, [-1,1]), th, (0, 0, 1)))',
        '3d geometry slider',
      ],
      // Three intervals in a point fill the solid they trace, drawn as the
      // faces of their parameter box: a continuous cube beside the corners.
      ['solid cube', '(interval(0, 1), interval(0, 1), interval(0, 1))', '3d parametric geometry'],
      ['thick pipe', 'r = interval(0.7, 1); (r cos(2 pi u), r sin(2 pi u), 2v)', '3d parametric trig'],
      [
        'ball with a slice cut (slide k)',
        'k = 0.75; r = interval(0, 1); p = interval(0, pi); q = interval(0, 2 pi k); (r sin(p) cos(q), r sin(p) sin(q), r cos(p))',
        '3d parametric trig slider coordinates',
      ],
      [
        'solid torus',
        'r = interval(0, 0.5); ((2 + r cos(2 pi v)) cos(2 pi u), (2 + r cos(2 pi v)) sin(2 pi u), r sin(2 pi v))',
        '3d parametric trig',
      ],
      [
        'twisted bar',
        'a = interval(-0.5, 0.5); b = interval(-0.5, 0.5); (a cos(3u) - b sin(3u), a sin(3u) + b cos(3u), 4u)',
        '3d parametric trig',
      ],
    ],
  ],
  [
    '3D curves + knots',
    [
      ['helix', '(2cos(6pi u), 2sin(6pi u), 4u - 2)', '3d parametric'],
      ['stacked circles (a list)', '(2cos(2pi u), 2sin(2pi u), [-1, 0, 1])', '3d parametric list'],
      ['trefoil', 'tube((sin(2pi u) + 2sin(4pi u), cos(2pi u) - 2cos(4pi u), -sin(6pi u)))', '3d parametric knot'],
      [
        'torus knot (2,5)',
        'tube(((2+cos(10pi u))cos(4pi u), (2+cos(10pi u))sin(4pi u), sin(10pi u)))',
        '3d parametric knot',
      ],
      ['figure eight', 'tube(((2+cos(4pi u))cos(6pi u), (2+cos(4pi u))sin(6pi u), sin(8pi u)))', '3d parametric knot'],
      ['Viviani', 'tube((1+cos(4pi u), sin(4pi u), 2sin(2pi u)), 0.06)', '3d parametric'],
      // T, N and B ride the curve; the osculating circle lies in the plane
      // of T and N, and torsion is how fast that plane turns. A helix does
      // not close up, so s runs up it and back down.
      [
        'Frenet frame on a helix',
        'C = (2cos(4pi u), 2sin(4pi u), 3u - 1.5); s = (1 - cos(pi t/10))/2; C; frame(C, s); osculating(C, s); curvature(C, s); torsion(C, s)',
        '3d parametric derivative animated',
      ],
      [
        'Frenet frame on a trefoil',
        'C = (sin(2pi u) + 2sin(4pi u), cos(2pi u) - 2cos(4pi u), -sin(6pi u)); C; frame(C, t/20); osculating(C, t/20); torsion(C, t/20)',
        '3d parametric knot derivative animated',
      ],
    ],
  ],
  [
    // `---` rows split the graph into panels, each with its own x, y and
    // viewport rows (lib/panels.ts); definitions are shared by all of them.
    'split views',
    [
      [
        'a function over its derivative',
        'view(x = -3..3, y = -3..3); f(x) = x^3 - 3x; y = f(x); --- below 40%, shared x; view(y = -4..10); y = d/dx f(x)',
        'split-view derivative polynomial',
      ],
      [
        'circle beside its sine',
        'grid(axes); view(x = -1.4..1.4, y = -1.4..1.4); P = (cos(t), sin(t)); circle((0, 0), 1); segment((0, 0), P); P; ' +
          '--- right 65%, shared y; grid(axes); view(x = -0.5..8); y = {x >= 0: sin(t - x)}; (0, sin(t))',
        'split-view trig geometry animated',
      ],
      [
        'surface beside its contour map',
        'camera(-pi/3, 0.6, 14); z = sin(x) cos(y); --- right; view(x = -4..4, y = -4..4); sin(x) cos(y)',
        'split-view 3d surface scalar-field',
      ],
      [
        'pendulum inset on its phase plane',
        "view(x = -4..4, y = -3..3); th' = om; om' = -sin(th) - om/6; th(0) = 3; trail((th, om)); " +
          '--- inset top left 35%; grid(off); view(x = -1.3..1.3, y = -1.3..1.1, locked); ' +
          'segment((0, 0), (sin(th), -cos(th))); (sin(th), -cos(th))',
        'split-view ode physics animated',
      ],
    ],
  ],
  [
    'Fourier analysis',
    [
      [
        'signal, spectrum and reconstruction',
        'N = clamp(round(2), 0, 16); f(x) = 0.3 + cos(4pi x) + 0.5sin(10pi x + 0.6); s = interval(0, 1); ' +
          '# amplitude spectrum of f over s (cycles per unit); view(x = -0.5..8, y = -0.1..1.2, ratio = 5); ' +
          'S = fourier(f(s)); segment((S.x, 0), S); S; ' +
          '--- right 65%; # original signal; view(x = -0.05..1.05, y = -1.6..2, ratio = 0.2); y = f(x); ' +
          '--- below 50%, shared x; # reconstruction: increase N; view(y = -1.6..2, ratio = 0.2); y = reconstruct(f(s), N)',
        'fourier series trig slider split-view',
      ],
      [
        'square wave reconstruction',
        'N = clamp(round(5), 0, 48); f(x) = sign(sin(2pi x)); s = interval(0, 1); ' +
          '# amplitude spectrum: odd harmonics; view(x = -0.5..16, y = -0.1..1.5, ratio = 8); ' +
          'S = fourier(f(s)); segment((S.x, 0), S); S; ' +
          '--- right 65%; # original square wave; view(x = -0.05..1.05, y = -1.5..1.5, ratio = 0.2); y = f(x); ' +
          '--- below 50%, shared x; # reconstruction: Gibbs overshoot at the jumps; view(y = -1.5..1.5, ratio = 0.2); y = reconstruct(f(s), N)',
        'fourier series piecewise slider split-view',
      ],
    ],
  ],
];

/**
 * The example whose screenshot stands for its category in the menu's first
 * screen, by label. A category left out uses its first example.
 */
export const COVERS: Record<string, string> = {
  curves: 'moiré',
  regions: 'Koch snowflake (recursion)',
  'parametric curves': 'rose (slide k)',
  'fields + color': 'RGB color field',
  'sliders + calculus': 'Riemann sum (slide n)',
  'sequences + series': 'cobweb',
  'lattices + automata': 'rule 30',
  'graphs + state machines': 'state machine: divisible by 3',
  'lists + data': 'concentric circles',
  'points + motion': 'motion trail',
  'geometry (drag the points)': 'Thébault’s theorem',
  'matrices, rotations + hulls': 'deform a lattice (arrows)',
  tensors: 'Hessian: curvature glyphs',
  'geometric algebra + quaternions': 'quaternion Julia set (slide s)',
  'vector fields + odes (click to trace)': 'Lorenz field (3D)',
  'vector calculus': 'divergence: sources and sinks',
  'simulations (↻ to restart)': 'Lorenz attractor',
  'probability: continuous': 'central limit theorem',
  'probability: discrete': 'Poisson counts add',
  complex: 'domain coloring',
  'polar + plane coordinates': 'spiral traced in (r, θ)',
  'spherical + cylindrical': 'cylindrical chart',
  '3D surfaces': 'gyroid',
  'fields in space': 'hydrogen 2p orbital',
  solids: 'icosahedron',
  '3D curves + knots': 'torus knot (2,5)',
};

/** Lowercase, accents dropped: `Thébault` → `thebault`. */
function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Lowercase ASCII words joined by '-': `moiré` → `moire`, `tan(x)` → `tan-x`. */
function slugify(s: string): string {
  return fold(s)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Every space-separated word of `query`, folded; empty for a blank query. */
function searchWords(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean);
}

/** An example as the menu shows it. */
export interface ExampleEntry {
  category: string;
  label: string;
  text: string;
  tags: string[];
}

/**
 * The examples matching a search, in menu order: every space-separated word
 * of `query` appears in the category, label, rows or tags (`julia`,
 * `3d torus`, `sin(`), and a `#word` must be one of the tags exactly
 * (`#animated`). Accents and case don't count. `within` limits it to one
 * category.
 */
export function searchExamples(query: string, within?: string): ExampleEntry[] {
  const words = searchWords(query);
  if (!words.length) return [];
  return EXAMPLES.flatMap(([category, items]) =>
    within !== undefined && category !== within
      ? []
      : items
          .map(([label, text, tags]) => ({ category, label, text, tags: tags.split(' ') }))
          .filter(e => {
            const hay = fold(`${category} ${e.label} ${e.text} ${e.tags.join(' ')}`);
            return words.every(w => (w.startsWith('#') ? e.tags.includes(w.slice(1)) : hay.includes(w)));
          }),
  );
}

/** The categories whose name holds every word of `query`, in menu order. */
export function searchCategories(query: string): string[] {
  const words = searchWords(query);
  // A #tag asks for examples; categories carry no tags.
  if (!words.length || words.some(w => w.startsWith('#'))) return [];
  return EXAMPLES.map(([category]) => category).filter(c => words.every(w => fold(c).includes(w)));
}

/**
 * Where an example's screenshot lives under web/shots/examples/, without the
 * extension: `<category>/<label>`. scripts/screenshots.ts writes it and the
 * menu reads it, so renaming a label means reshooting (the test says so).
 */
export function exampleShotPath(category: string, label: string): string {
  return `${slugify(category)}/${slugify(label)}`;
}

/** The label of the example shown on a category's tile. */
export function coverLabel(category: string, items: ReadonlyArray<readonly [string, string, string]>): string {
  return COVERS[category] ?? items[0][0];
}
