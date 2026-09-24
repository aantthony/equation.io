/**
 * The examples menu: [category, [[label, rows], …]] in menu order. Rows are
 * separated by ';', as in the URL hash. Kept apart from main.ts so a PR that
 * adds examples is a diff of this file alone.
 */
export const EXAMPLES: Array<[string, Array<[string, string]>]> = [
  ['curves', [
    ['parabola', 'y = x^2'],
    ['circle', 'x^2 + y^2 = 4'],
    ['tangent', 'y = tan(x)'],
    ['lemniscate', '(x^2+y^2)^2 = 8(x^2-y^2)'],
    ['moire', 'sin(x^2 + y^2) = cos(x y)'],
    ['traveling wave', 'y = sin(x - 2t)'],
  ]],
  ['fields', [
    ['interference', 'sin(x)cos(y)'],
    ['ripples', 'sin(x^2 + y^2 - 4t)/2'],
  ]],
  ['vector fields', [
    ['rotation', '(-y, x)'],
    ['saddle', '(x, -y)'],
    ['shear + swirl', '(sin(y), sin(x))'],
  ]],
  ['regression', [
    ['line fit and residuals', 'P = [(0,1.1),(1,2.9),(2,5.2),(3,6.8),(4,9.1)]; P.y ~ m P.x + b; P; y = m x + b; # residuals; (P.x,P.y-(m P.x+b))'],
    ['quadratic fit', 'P = [(-2,9),(-1,2),(0,1),(1,6),(2,17)]; P.y ~ a P.x^2 + b P.x + c; P; y = a x^2 + b x + c'],
    ['exponential fit', 'P = [(0,2),(0.5,2.84),(1,4.03),(1.5,5.72),(2,8.11)]; P.y ~ a exp(b P.x); P; y = a exp(b x)'],
  ]],
  ['odes (click to trace)', [
    ['slope field', "y' = x - y"],
    ['logistic growth', "dy/dx = y(1 - y/4)"],
    ['pendulum phase portrait', "(x', y') = (y, -sin(x))"],
    ['van der pol', "(x', y') = (y, (1 - x^2)y - x)"],
    // A linear system as its literal matrix; drag the entries' sliders.
    ['matrix phase portrait', "a = -1; b = -1/4; A = [(0, 1), (a, b)]; (x', y') = A (x, y)"],
  ]],
  ['simulations (↻ to restart)', [
    // th = angle (theta), om = angular velocity (omega): the textbook names.
    // Name each bob as a point, draw the rod with segment(), draw the mass by
    // naming the point on its own row.
    ['swinging pendulum',
      "th' = om; om' = -sin(th) - om/8; th(0) = 3; bob = (sin(th), -cos(th)); segment((0, 0), bob); bob"],
    // The Lagrangian form M(th) om' = f(th, om): th and om are 2-vector
    // states (components th_1, th_2), M the mass matrix, solve() Cramer.
    ['double pendulum',
      'g = 9.8; L1 = 1; L2 = 1; m1 = 1; m2 = 1; '
      + 'M = [((m1+m2) L1, m2 L2 cos(th_1 - th_2)), (L1 cos(th_1 - th_2), L2)]; '
      + 'f = (-m2 L2 om_2^2 sin(th_1 - th_2) - (m1+m2) g sin(th_1), L1 om_1^2 sin(th_1 - th_2) - g sin(th_2)); '
      + "th' = om; om' = solve(M, f); "
      + 'th(0) = (2.5, 2.4); '
      + 'b1 = (L1 sin(th_1), -L1 cos(th_1)); '
      + 'b2 = b1 + (L2 sin(th_2), -L2 cos(th_2)); '
      + 'segment((0, 0), b1); segment(b1, b2); b1; b2'],
    // r'' = -mu r/|r|^3, written as the vectors it is. The state r draws as
    // a point; below escape velocity the orbit is an ellipse.
    ['orbit (vector gravity)',
      "r' = vel; vel' = -9 r/|r|^3; r(0) = (2, 0); vel(0) = (0, 1.5); segment((0, 0), r); r; (0, 0)"],
    // pos = displacement, vel = velocity: a phase portrait in (pos, vel).
    ['driven oscillator', "pos' = vel; vel' = sin(2t) - pos - vel/5; (pos, vel)"],
    // One 3-component state; the plot row projects onto the x–z plane.
    ['lorenz attractor',
      "r' = (10(r_2 - r_1), r_1(28 - r_3) - r_2, r_1 r_2 - 8 r_3/3); "
      + 'r(0) = (1, 1, 20); (r_1/4, r_3/4 - 6)'],
  ]],
  ['complex', [
    ['point charge', 'ln(w)'],
    ['dipole', 'ln(w-2) - ln(w+2)'],
    ['quadrupole', 'ln(w-2) + ln(w+2) - ln(w-2i) - ln(w+2i)'],
    ['flow past cylinder', 'w + 4/w'],
    ['orbiting charge', 'ln(w-2) - ln(w + 2e^(i t))'],
    ['domain coloring', 'domain((w^3 - 1)/w)'],
    ['RGB color field', 'rgb(sin(x-t)^2, sin(y-t)^2, sin(x+y+t)^2)'],
    ['HSL color wheel', 'hsl(arg(w)+t/3, 1, 0.5)'],
    ['OKLCH color wheel', 'oklch(0.72, 0.16, arg(w)+t/3)'],
    ['conformal map', 'conformal(w^2/4)'],
    ['joukowski airfoil', 'conformal(w + 1/w)'],
    ['unit circle path', 'exp(i 2 pi u)'],
    ['image of a circle', 'f(w) = w^2 + w; exp(i 2 pi u); f(exp(i 2 pi u))'],
  ]],
  ['fractals', [
    ['mandelbrot set', 'iter(z^2 + w)'],
    ['julia set', 'iter(z^2 - 0.7269 + 0.1889i)'],
    ['julia orbit', 'iter(z^2 + 0.7885e^(i t/8))'],
    ['burning ship', 'iter((|re(z)| - i |im(z)|)^2 + w)'],
  ]],
  ['coordinates', [
    ['polar grid', 'r = sqrt(x^2 + y^2); theta = atan2(y, x)'],
    ['cardioid in polar', 'r = sqrt(x^2 + y^2); theta = atan2(y, x); r = 2(1 + cos(theta))'],
    ['polar spiral', 'r = sqrt(x^2 + y^2); theta = atan2(y, x); r = theta + pi'],
    ['log-polar', 'rho = ln(x^2 + y^2)/2; theta = atan2(y, x)'],
    ['hyperbolic grid', 'p = x y; q = (x^2 - y^2)/2'],
    ['spinning polar', 'r = sqrt(x^2 + y^2); theta = atan2(y, x) + t/4'],
    ['spherical chart', 'rho = sqrt(x^2 + y^2 + z^2); theta = atan2(y, x); phi = acos(z/rho); '
      + 'rho = 2; (rho, theta, phi) = (2, pi/4, pi/3)'],
    ['spherical flower', 'rho = sqrt(x^2 + y^2 + z^2); theta = atan2(y, x); phi = acos(z/rho); rho = 2 + cos(3 theta) sin(phi)^2'],
    ['spherical spiral', 'rho = sqrt(x^2 + y^2 + z^2); theta = atan2(y, x); phi = acos(z/rho); '
      + 'rho = 2; (rho, theta, phi) = (2, 12 pi u, pi u)'],
    ['cylindrical chart', 'r = sqrt(x^2 + y^2); theta = atan2(y, x); r = 1.5 + sin(2 z)/2; (r, theta, z) = (2.5, 6 pi u, 6 u - 3)'],
  ]],
  ['probability', [
    ['normal density', 'X ~ Normal(0, 1)'],
    ['P(X < b)', 'a = 1; b = 0.5; X ~ Normal(0, a); P(X < b)'],
    ['between two bounds', 'X ~ Normal(0, 1); P(-1 < X < 2)'],
    ['uniform + exponential', 'X ~ Uniform(0, 2); Y ~ Exponential(1); P(0.5 < X < 1.5)'],
    ['sum = convolution', 'X ~ Uniform(0, 1); Y ~ Uniform(0, 1); X + Y'],
    ['central limit theorem', 'view(x = -0.5..4.5, y = -0.15..1.35); '
      + 'X1 ~ Uniform(0, 1); X2 ~ Uniform(0, 1); X3 ~ Uniform(0, 1); X4 ~ Uniform(0, 1); '
      + 'S = X1 + X2 + X3 + X4; Z ~ Normal(2, sqrt(1/3)); P(S > 3)'],
    ['gamma waiting times', 'view(x = -1..9, y = -0.1..0.9, ratio = 6); a = 2; b = 1; X ~ Gamma(a, b); Y ~ Exponential(b); '
      + 'P(X > 4); S = X + Y'],
    ['beta shapes', 'view(x = -0.2..1.2, y = -0.3..3.5, ratio = 0.25); a = 0.5; b = 0.5; X ~ Beta(a, b); P(X < 0.2)'],
    ['chi-squared from normals', 'view(x = -1..7, y = -0.1..1.1, ratio = 4); Z ~ Normal(0, 1); Q = Z^2; C ~ ChiSquared(3); '
      + 'P(Q > 3.84)'],
    ['heavy tails: t and Cauchy', 'view(x = -6..6, y = -0.05..0.45, ratio = 15); k = 2; Z ~ Normal(0, 1); X ~ T(k); '
      + 'C ~ Cauchy(0, 1); P(X > 2); E(C)'],
    ['binomial stems', 'view(x = -1.5..21.5, y = -0.02..0.24, ratio = 50); n = 20; p = 0.3; X ~ Binomial(n, p); '
      + 'P(X <= 4); E(X)'],
    ['Poisson: < versus <=', 'view(x = -1.5..13.5, y = -0.02..0.28, ratio = 30); m = 4; X ~ Poisson(m); '
      + 'P(X < 3); P(X <= 3); P(X = 3)'],
    ['waiting for a success', 'view(x = -1.5..21.5, y = -0.02..0.3, ratio = 40); p = 0.25; G ~ Geometric(p); '
      + 'W ~ NegativeBinomial(3, p); P(G > 4)'],
    ['a fair die', 'view(x = -0.5..7.5, y = -0.02..0.3, ratio = 16); D ~ DiscreteUniform(1, 6); P(2 < D <= 5); E(D)'],
    ['two dice', 'view(x = 0.5..13.5, y = -0.02..0.22, ratio = 40); X ~ DiscreteUniform(1, 6); Y ~ DiscreteUniform(1, 6); '
      + 'S = X + Y; P(S >= 10); P(X > Y); P(X >= Y); E(S)'],
    ['a die, halved and squared', 'view(x = -1..38, y = -0.02..0.22, ratio = 120); D ~ DiscreteUniform(1, 6); D / 2; D^2; '
      + 'P(D^2 <= 9); E(D^2)'],
    ['Poisson counts add', 'view(x = -1.5..16.5, y = -0.02..0.3, ratio = 40); a = 2; b = 3; A ~ Poisson(a); B ~ Poisson(b); '
      + 'S = A + B; P(S <= 4); P(A = B)'],
    ['a count plus noise', 'view(x = -2..10, y = -0.03..0.33, ratio = 25); s = 0.25; N ~ Poisson(3); Z ~ Normal(0, s); Y = N + Z; '
      + 'P(Y < 2.5)'],
    ['conditional variable', 'X ~ Normal(0, 1); Y = {X > 0: X^2, 1}; P(Y > 0.5); P(Y > X)'],
    ['expectation', 'X ~ Uniform(0, 1); Y = X^2; E(Y); E(X + Y)'],
  ]],
  ['regions', [
    ['open half-plane', 'y < x/2 + 1'],
    ['closed disc', 'x^2 + y^2 <= 4'],
    ['annulus', '4 <= x^2 + y^2 <= 9'],
    ['band under a wave', '-1 <= y - sin(x) < 1'],
  ]],
  ['sequences + recurrences', [
    ['sequence', 'a_n = 1/n^2'],
    ['alternating harmonic', 'a_n = (-1)^(n+1)/n'],
    ['prime indicator', 'a_n = isprime(n)'],
    ['cobweb', 'r = 2.9; a_0 = 0.15; a_{n+1} = r a_n (1 - a_n)'],
    ['logistic bifurcation', 'a_{n+1} = x a_n (1 - a_n)'],
    ['alternating sum → ln 2', 'a_n = (-1)^(n+1)/n; s_n = sum(k=1..n, a_k); y = ln(2)'],
    ['differences of squares', 'b_n = n^2; a_n = b_[n+1] - b_n'],
  ]],
  ['data + piecewise', [
    ['data list', '[3, 1, 4, 1, 5, 9, 2, 6]'],
    ['scatter', '[(1, 2), (2, 3.5), (3, 3.1), (4, 5)]'],
    ['piecewise', 'y = {x < 0: -x, x >= 0: x^2}'],
    ['domain restriction', 'y = {-2 < x < 2: x^2}'],
    ['coprime cells', '1 / gcd(floor(x), floor(y))'],
  ]],
  ['sliders + calculus', [
    ['slider', 'a = 2; y = sin(a x)/a'],
    ['level sets', 'c = 0.3; sin(x)cos(y) = c'],
    ['function', 'f(x) = x^3 - 3x; y = f(x)'],
    ['derivative', 'y = d/dx (x^3 - 3x)'],
    ['power rule family', 'N = [1..4]; y = x^N; y = d/dx x^N'],
    ['tangent line', 'f(x) = x^3 - 2x; g(x) = d/dx f(x); a = 1; y = f(x); y = f(a) + g(a)(x - a)'],
    ['running integral', 'view(x = -7..7, y = -1.5..4); f(x) = sin(x)^2; y = f(x); y = int[0..x] f(t) dt'],
    ['signed area', 'view(x = -1..7, y = -1.5..1.5); b = 5; y = sin(x); int[0..b] sin(x) dx'],
    ['antiderivative', 'f(x) = x^2 - 1; y = f(x); y = int(f(x) dx)'],
    ['gaussian error fn', 'view(x = -4..4, y = -1.2..1.2); y = int[0..x] exp(-t^2) dt'],
    ['normal cdf', 'view(x = -4..4, y = -0.6..1.2); y = normalpdf(x, 0, 1); y = int[-inf..x] normalpdf(t, 0, 1) dt'],
    ['sine integral Si(x)', 'view(x = -20..20, y = -2.2..2.2); y = int[0..x] sin(t)/t dt'],
    ['orbiting charge', 'r = 2 + sin(t); ln(w - r) - ln(w + r)'],
  ]],
  ['series', [
    ['fourier square wave', 'N = 3; y = (4/pi) sum(n=1..N, sin((2n-1)x)/(2n-1))'],
    ['fourier sawtooth', 'N = 5; y = 2 sum[n=1..N] (-1)^(n+1) sin(n x)/n'],
    ['taylor cosine', 'N = 2; y = sum(n=0..N, (-1)^n x^(2n)/prod(k=1..2n, k)); y = cos(x)'],
    // A list bound draws every partial sum at once: one curve per element.
    ['fourier convergence', 'N = [1, 3, 10]; y = (4/pi) sum(n=1..N, sin((2n-1)x)/(2n-1))'],
    ['taylor sine, term by term', 'N = [0..4]; y = sum(n=0..N, (-1)^n x^(2n+1)/prod(k=1..2n+1, k)); y = sin(x)'],
  ]],
  ['points (drag them)', [
    ['a point', '(2, 3)'],
    ['point on sliders', 'a = 1; b = 2; (a, b)'],
    ['point on a curve', 'a = 1; f(x) = x^3 - 3x; y = f(x); (a, f(a))'],
    ['orbit', '(2cos(t), 2sin(t))'],
    ['lissajous', '(2cos(2pi u), sin(4pi u))'],
    ['spiral', '(u cos(6pi u) 3, u sin(6pi u) 3)'],
  ]],
  ['geometry (drag the points)', [
    ['segment + midpoint', 'A = (-2, -1); B = (2, 1.5); segment(A, B); midpoint(A, B)'],
    ['perpendicular bisector', 'A = (-2, -1); B = (2, 1.5); segment(A, B); M = midpoint(A, B); line(M, M + perp(B - A))'],
    ['circle through a point', 'C = (0, 0); P = (2, 1); circle(C, |P - C|); segment(C, P)'],
    ['square on a segment', 'A = (-1, 0); B = (2, 1); square(A, B)'],
    ['triangle: a side and its angles', 'A = (-2, -1); B = (3, -0.5); C = (0.5, 2.5); polygon(A, B, C); distance(A, B); angle(B, A, C) 180/pi; angle(B, A, C) + angle(C, B, A) + angle(A, C, B)'],
    ['vector sum (parallelogram rule)', 'A = (3, 1); B = (1, 2); vector(A); vector(B); vector(A + B); polyline(A, A + B, B)'],
    ['thébault’s theorem', 'A = (0, 0); B = (4, 0.5); D = (1, 2.5); C = B + D - A; '
      + 'polygon(A, B, C, D); square(B, A); square(C, B); square(D, C); square(A, D); '
      + 'P = midpoint(A, B) - perp(B - A)/2; Q = midpoint(B, C) - perp(C - B)/2; '
      + 'R = midpoint(C, D) - perp(D - C)/2; S = midpoint(D, A) - perp(A - D)/2; '
      + 'polygon(P, Q, R, S)'],
  ]],
  ['coordinates', [
    ['polar point (drag it)', 'r = sqrt(x^2+y^2); theta = atan2(y,x); (r, theta) = (2, 0.8)'],
    ['polar spiral', 'r = sqrt(x^2+y^2); theta = atan2(y,x); (r, theta) = (3u, 6pi u)'],
    ['polar limit cycle', "r = sqrt(x^2+y^2); theta = atan2(y,x); (r', theta') = (r(1-r), 1)"],
    ['hyperbolic pair', 'p = x y; q = (x^2-y^2)/2; (p, q) = (1, 0)'],
    ['complex roots', 'w^3 = 1; 1+2i'],
  ]],
  ['systems', [
    ['curve intersection', 'x^2 + y^2 = 4; x y = 1; (x^2 + y^2 - 4, x y - 1) = (0, 0)'],
    ['three planes', '(x + y, x - y, z) = (1, 2, 3)'],
    // Alpöge's counterexample to the Jacobian conjecture (July 2026), found by
    // Fable: det JF = -2 everywhere, yet the fiber over (-1/4, 0, 0) holds the
    // three points the solver marks. Drag c above 0 and two of them leave —
    // they escape to infinity, which is how an étale map gets to be 3-to-1.
    ['jacobian counterexample', 'c = -0.25; F(x,y,z) = ((1+x y)^3 z + y^2 (1+x y)(4+3 x y), y + 3 x (1+x y)^2 z + 3 x y^2 (4+3 x y), 2 x - 3 x^2 y - x^3 z); F(x,y,z) = (c, 0, 0)'],
  ]],
  ['space, families and sequence values', [
    ['3D triangle and normal', 'A=(0,0,0); B=(3,0,1); C=(0,2,2); polygon(A,B,C); vector(A,cross(B-A,C-A)/3); angle(B-A,C-A)'],
    ['Lorenz field', "camera(-pi/3,0.5,55,(0,0,25)); (x',y',z')=(10(y-x),x(28-z)-y,x y-8z/3)"],
    ['cylindrical flow', "r=sqrt(x^2+y^2); theta=atan2(y,x); (r',theta',z')=(0,1,0.5)"],
    ['family of lines', 'y=[-2,-1,0,1,2]x'],
    ['concentric circles', 'circle((0,0),[1,2,3,4])'],
    ['point-list path', 'P=[(-2,0),(0,2),(2,0),(0,-2)]; Q=P+(1,0); polygon(P); polyline(Q)'],
    ['sequence statistics', 'a_n=1/n; L=a_[1..20]; L; mean(L); hist(L)'],
    ['surface intersection', '(x^2+y^2+z^2,z)=(9,1)'],
    ['certifiable roots', '(x^2,y)=(1,0)'],
    ['decided comparisons', '2+2=4; e=2'],
  ]],
  ['rotations, hulls and solids', [
    // A list is a variable: every use of `th` moves together, while separate
    // [..] literals are independent and cross — the corners of a cube.
    ['regular polygon', 'n = 7; th = 2pi [0..n-1]/n; polygon(rotate((2, 0), th + t/4))'],
    ['rotate a shape (matrix exponential)', 'J = [(0, -1), (1, 0)]; a = 0.7; R = e^(a J); P = [(0, 0), (3, 0), (3, 1), (1, 1), (1, 2), (0, 2)]; polygon(P); polygon(R P)'],
    ['rosette of hulls', 'th = 2pi [0..5]/6; P = [(1, 0), (3, 0.6), (3, -0.6)]; rotate(hull(P), th + t/3)'],
    ['convex hull of moving points', 'P = [(-3, -1), (-1, 2), (0.5, -2), (2, 1.5), (3, -0.5), (0, 0.3), (1, 0.5 + 2sin(t))]; hull(P); P'],
    ['exact linear flow: e^(tA)', "A = [(-0.2, -1), (1, -0.2)]; s = [0..60]/5; (x', y') = A (x, y); e^(s A) (3, 0); e^(t A) (3, 0)"],
    ['deform a lattice (arrows)', 'a = [-10..10]/2; b = [-10..10]/2; P = (a, b); f(x,y) = (x + sin(y + t)/3, y + sin(x)/3); vector(P, f(P)); f(P)'],
    ['corners of a cube', '([0,1], [0,1], [0,1])'],
    ['tumbling cube', 'e^(t cross((1, 1, 1)/sqrt(3))) hull(([-1,1], [-1,1], [-1,1]))'],
    ['octahedron', 'k = 2pi [0..2]/3; hull(rotate(([-2,2], 0, 0), k, (1, 1, 1)))'],
    ['icosahedron', 'phi = (1+sqrt(5))/2; k = 2pi [0..2]/3; hull(rotate((0, [-1,1], [-phi,phi]), k, (1, 1, 1)))'],
    ['prism (slide n)', 'n = 5; th = 2pi [0..n-1]/n; hull(rotate((2, 0, [-1,1]), th, (0, 0, 1)))'],
  ]],
  ['3d surfaces', [
    ['waves', 'z = sin(x)cos(y)'],
    ['sphere', 'x^2 + y^2 + z^2 = 9'],
    ['saddle', 'z = (x^2 - y^2)/4'],
    ['gyroid', 'sin(x)cos(y) + sin(y)cos(z) + sin(z)cos(x) = 0'],
    ['vase (revolve)', 'a = 1; revolve({-3 < y < 3: 1.5 + a sin(y) / 2}, y)'],
  ]],
  ['parametric 3d', [
    ['helix', '(2cos(6pi u), 2sin(6pi u), 4u - 2)'],
    ['torus', '(cos(2pi u)(2+cos(2pi v)), sin(2pi u)(2+cos(2pi v)), sin(2pi v))'],
    ['sphere (u,v)', '(2sin(pi v)cos(2pi u), 2sin(pi v)sin(2pi u), 2cos(pi v))'],
    ['breathing torus', '(cos(2pi u)(2+cos(2pi v+t)), sin(2pi u)(2+cos(2pi v+t)), sin(2pi v+t))'],
  ]],
  ['knots', [
    ['trefoil', 'tube((sin(2pi u) + 2sin(4pi u), cos(2pi u) - 2cos(4pi u), -sin(6pi u)))'],
    ['torus knot (2,5)', 'tube(((2+cos(10pi u))cos(4pi u), (2+cos(10pi u))sin(4pi u), sin(10pi u)))'],
    ['figure eight', 'tube(((2+cos(4pi u))cos(6pi u), (2+cos(4pi u))sin(6pi u), sin(8pi u)))'],
    ['viviani', 'tube((1+cos(4pi u), sin(4pi u), 2sin(2pi u)), 0.06)'],
  ]],
];
