/**
 * Targeted documents for geometry on curves and surfaces and the operators
 * that expand when they resolve (apple/corpus/analysis.ts runs them with its
 * own): vector calculus, the curve operators, coordinates named in a tuple,
 * plane maps and rows drawn on a surface. One concern each, rows separated
 * as the examples' are.
 */
export const SURFACE_CASES: string[] = [
  // Vector calculus: the calls, over expressions, functions, fields and points.
  'grad(x^2 + y^2); div((x y, y^2)); curl((-y, x)); laplacian(x^2 - y^2); jacobian((x^2 - y^2, 2 x y)); hessian(x^2 - y^2)',
  'f(x, y) = x^2 y; grad(f); laplacian(f); hessian(f); grad(f(x, y)); grad(f(y, x)); y = laplacian(f) x',
  'g = sin(x) cos(y); grad(g); laplacian(g) = 0; F = (x y, y - x); div(F); curl(F); jacobian(F); det(jacobian(F))',
  'grad(x y z); div((x, y, z)); curl((y, z, x)); laplacian(x^2 + y^2 + z^2); hessian(x y z); jacobian((x y, y z, z x))',
  'F(x, y, z) = (y z, x z, x y); curl(F); div(F); a = 2; grad(a x^2 + t y); laplacian(sin(a x - t))',
  'h(q) = q^2; grad(h); grad(k); grad(); grad(x, y); grad((x, y)); div(x); curl(x y); curl((x, y, z, 1)); laplacian((x, y))',
  'hessian((x, y)); jacobian(x); jacobian((x, y, z, 1)); grad(y = x); grad([x, y]); L = [1, 2]; grad(L); grad(x > 1)',
  'A = (1, 2); grad(A); div(A); grad(abs(x) + floor(y)); div((x!, y)); r = sqrt(x^2 + y^2); grad(r); laplacian(ln(r))',
  'f(n) = {n < 1: 1, n f(n - 1)}; grad(f); p(x, t) = x t; grad(p); q(x, w) = x w; grad(q)',
  // ∇ as a prefix operator.
  'f(x, y) = x^2 - y^2; ∇f; ∇·(x, y); ∇×(-y, x); ∇²f; ∇^2 f = 0; -∇f; 2 ∇f; ∇f · (1, 0); ∇ x^2 y; ∇f(x, y)',
  'F = (-y, x); ∇·F; ∇×F; ∇×F = 0; a = 2; a ∇·F; ∇·F a; ∇; ∇/2; ∇²·F; ∇∧F; ∇⊗F; y = ∇²(x^3)',
  's = (x, y); ∇·(s/|s|^2) = 0; f = x^2 + y^2; dir = (cos(a), sin(a)); a = 1; ∇f · dir; ∇f × dir; (∇f)·(∇f)',
  'grad = 3; ∇; y = grad x; ---; grad(q) = 2 q; y = grad(x)',
  'c = 1; h = sin(x) cos(t); d^2/dt^2 h = ∇^2 h; f(x, t) = sin(x - c t); d^2/dt^2 f(x, t) = c^2 ∇^2 f(x, t)',
  'F = (x + y, y z, x z); JF(x, y, z) = (∇F_x, ∇F_y, ∇F_z); det(JF(1, -1.5, 6.5)); sum(n=1..2, n) ∇ x; ∇ sum(n=1..2, x^n)',
  // The curve operators: along the curve, at a point, in the plane and in space.
  'C = (cos(2pi u), 2 sin(2pi u)); curvature(C); curvature(C, 0.25); osculating(C, 0.25); frame(C, 0.25); torsion(C)',
  'C = (cos(u), sin(u), u/2); curvature(C); torsion(C); curvature(C, 1); torsion(C, 1); osculating(C, 1); frame(C, 1)',
  's = 0.3; C = (u, sin(4 u)); curvature(C, s); osculating(C, s); frame(C, s); osculating(C, t/10); y = curvature(C, x)',
  'c(q) = (q, q^2); curvature(c); curvature(c, 1); osculating(c, 0.5); frame(c, 0.5); k(u) = curvature(c, u); k(1)',
  'curvature((u, u^3)); curvature((u, u^3), 0.5); osculating((cos(u), sin(u)), 1); frame((cos(u), sin(u), u), 1)',
  'curvature(); curvature(C); curvature(3, 1); frame(C); osculating(C); a = 2; curvature(a); L = [1, 2]; curvature(L)',
  'C = (u, u^2); curvature(C, u); osculating(C, u); frame(C, (1, 2)); frame(C, [0.2, 0.5]); osculating(C, [0.2, 0.5])',
  'C = (1, 2); curvature(C); D = (u, v); curvature(D); E = (u, x); curvature(E); G = (u, u, u, u); curvature(G); torsion((u, u^2))',
  'f(a, b) = (a, b); curvature(f); r = 2; C = (r cos(u), r sin(u)); curvature(C); curvature(C, 0); (curvature(C, 0), 1)',
  'C = (cos(3 u), sin(2 u)); y = curvature(C, x/10); curvature(C, t); z = torsion((cos(u), sin(u), u^2), x)',
  // Coordinates named in a tuple: flows in field coordinates, and positions.
  "r = sqrt(x^2 + y^2); theta = atan2(y, x); (r', theta') = (r(1 - r), 1); (theta', r') = (1, 0); (r', theta') = (1, t)",
  "r = sqrt(x^2 + y^2); theta = atan2(y, x); (r', theta') = (1, 2, 3); (r', theta') = 1; (r', theta) = (1, 1); (r', r') = (1, 1)",
  "p = x + y; q = 2x + 2y; (p', q') = (1, 0); s = x^2; (s', p') = (1, x); (x', p') = (y, 1); (y', x') = (x, -y); (k', x') = (1, 1)",
  "r = sqrt(x^2 + y^2); theta = atan2(y, x); (r', theta', z') = (0, 1, 0.5); (z', r', theta') = (1, 0, 1); (r', theta', z') = (0, 1)",
  "rho = sqrt(x^2 + y^2 + z^2); (rho', x') = (1, 1); (z', x') = (1, 1); (x', y', z', w') = (1, 1, 1, 1); (x', y') = (y, -x); (x', y', z') = (y, -x, 1)",
  "a = 2; r = sqrt(x^2 + y^2); theta = atan2(y, x); (r', theta') = (a - r, sin(t)); u2 = x t; v2 = y - t; (u2', v2') = (1, 0); (r', theta') = (abs(r), 1)",
  "r = sqrt(x^2 + y^2); theta = atan2(y, x); (r, theta) = (2, 0.8); (r, theta) = (3u, 6pi u); (x, y) = (1, 2); (r, r) = (1, 2); (r, theta) = 2",
  "p = x^2 - y^2; q = 2 x y; (p, q) = (1, 0); (p, q, x) = (1, 0, 1); (p, q) = (1, 2, 3); (p, k) = (1, 0); (x, y, z) = (1, 2, 3); (p, x, y, z) = (1, 2, 3, 4)",
  // Systems in the plane: isolated solutions, an angle that wraps, a parametric one.
  'a = 1; (x^2 + y^2 - 4, x y - 1) = (0, 0); (x^2 + y^2, y) = (4, a x); (sin(x), cos(y)) = (0, 0); (atan2(y, x), x^2 + y^2) = (a, 4)',
  '(x + y, x - y) = (cos(u), sin(u)); (x, y) = (cos(t), 1); (x^2, y) = 1; (x, y) = (1, 2, 3); (x y, x + z) = (1, 2); (x, y, x) = (1, 2, 3)',
  'view(x = 10^X); (x, y) = (100, 2); (x^2 + y^2, x y) = (4, 1)',
  // Rows drawn on a surface: the on(…) row, what is painted and what is carried.
  'on((X, Y, Z) = (2cos(y) cos(x), 2cos(y) sin(x), 2sin(y)), x = -pi..pi, y = -pi/2..pi/2); y = sin(x); y < 0; cos(x) y; x^2 + y^2 = 1',
  "a = 1; on((X, Y, Z) = (x, y, a x y), x = -2..2, y = -2..2); (1, 1); A = (0.5, a); A; (cos(2pi u), sin(2pi u)); (-y, x); (x', y') = (1, sin(t))",
  'on((X, Y, Z) = (x, y, x^2 - y^2), x = -1..1, y = -1..1); segment((0, 0), (1, 1)); polygon((0, 0), (1, 0), (0, 1)); label((0, 0), "o"); [(0, 0), (1, 1)]; 2 + 2; (1, 2, 3)',
  'on((X, Y, Z) = (x, y, 0), x = 0..1, y = 0..1); z = x y; (u, v, u v); x^2 + y^2 + z^2 = 1; (cos(u), sin(u), u); x y z; (y, z, x)',
  'on((X, Y, Z) = (x, y, 0), x = 0..1, y = 0..1); a_n = 1/n; domain(w^2); iter(z^2 + w); ((1, 2), (3, 4)) (x, y); (x^2, y) = (1, 1); trail((cos(t), sin(t))); e^(i t)',
  'on((X, Y, Z) = (x, y, 0), x = 0..1, y = 0..1); view(x = 0..1); camera(1, 0.5); ---; view(x = 0..1); on((X, Y, Z) = (x, y, 1), x = 0..1, y = 0..1); on((X, Y, Z) = (x, y, 2), x = 0..1, y = 0..1)',
  'on(); on(x = 0..1, y = 0..1); on((X, Y, Z) = (x, y, 0)); on((X, Y, Z) = (x, y, 0), x = 0..1); ---; on((X, Y, Z) = (x, y, 0), x = 1..0, y = 0..1); ---; on((X, Y, Z) = (x, y, 0), x = 0..1, x = 0..1, y = 0..1)',
  'on((X, Y, Z) = (x, y, 0), x = 0..1, y = 0..1, locked); ---; on((X, Y, Z) = (x, y), x = 0..1, y = 0..1); ---; on((X, Y, Z) = (1, 2, 3), x = 0..1, y = 0..1); ---; on((X, Y, Z) = (x, x, x), x = 0..1, y = 0..1)',
  'on((X, Y, Z) = (x, y, k), x = 0..1, y = 0..1); ---; on((X, Y, Z) = (x, y, t), x = 0..1, y = 0..1); ---; on((X, Y, Z) = (x, y, cos x), x = 0..1, y = 0..1); ---; on((X, Y, Z) = (x, y, x!), x = 0..1, y = 0..1); ---; on((X, Y, Z) = (x, y, 0), z = 0..1, y = 0..1)',
  'on(x) = 2 x; on(3); y = on(x); ---; on((X, Y, Z) = (x, y, 0), x = 0..1, y = 0..1); gaussian(x, y); geodesic((0, 0), (1, 1)); y = x; ds^2 = dx^2 + dy^2',
  'b = 2; on((X, Y, Z) = (b x, y, sum[n=1..2] sin(n x)), x = 0..1, y = 0..1); y = x; ---; on((X, Y, Z) = ((3 + cos(y)) cos(x), (3 + cos(y)) sin(x), sin(y)), x = -pi..pi, y = -pi..pi); p = 2; q = 3; sin((p y - q x)/2) = 0',
  // Parametric regions: a pair in u and v fills what it traces.
  '(u, v); a = 2; (a u cos(2pi v), u sin(2pi v) + t); (u^2, v, 1); (u, v, u v, 1); (v, 1); (u + x, v); y = u v',
  'view(x = 10^X); (u, v); ---; on((X, Y, Z) = (x, y, x y), x = -1..1, y = -1..1); (u/2, v/2); a = 0.5; (a u, v - 1); ---; z = 1; (u, v)',
];
