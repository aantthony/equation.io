/**
 * Targeted documents for continuous intervals (lib/interval.ts), which
 * apple/corpus/analysis.ts runs with its own: a family over an interval in
 * the plane, intervals swept as u and v are, solids, u and v defined as
 * intervals, the curve and surface operators over them, reductions against
 * their measure, the density of a row's values, and what the site refuses.
 * One concern each, rows separated as the examples' are.
 */
export const INTERVAL_CASES: string[] = [
  // A family over an interval in the plane: the region it sweeps.
  'a = interval(1, 2); y = sin(a x); y = a x; x = a; x^2 + y^2 = a^2; y = x^a; a y = x',
  'a = interval(1, 2); y < a x; y <= a x; a x < y < a x + 1; y > a x^2 >= 0; 0 < y < a > x; a < x',
  'y = interval(0, 1) x; y < interval(-1, 1); x^2 + y^2 = interval(1, 4); y = x + interval(0, 1/2)',
  'k = 3; a = interval(1, k); y = sin(a x); y = k a x; y = a x + t; y < a sin(x - t); c = 2 t; y = c a x',
  'a = interval(1, 2); b = 2 a + 1; y = b x; c = a^2; y < c; d = sin(a); x = d y; y = (a, 1) · (x, 1)',
  'f(q) = interval(0, 1) q; y = f(x); g(x) = x + interval(0, 1); y = g(x); y = g(x) + g(2 x); a = interval(0, 1); h(x) = a x; y = h(x) - h(1)',
  'a = interval(0, 2pi); y = sin(x + a); r = sqrt(x^2 + y^2); r = interval(1, 2); r < interval(1, 2); theta = atan2(y, x); theta = interval(0, 1)',
  'a = interval(1, 2); y = sum(n=1..3, sin(a n x)); y = d/dx (a x^2); y = int[0..x] a q dq; y = {x > 0: a x, x}; y = abs(a x) + floor(a)',
  // What a family over an interval cannot be.
  'a = interval(1, 2); a x; a x + y; (a x, y); z = a x; a x^2 + y^2 + z^2 = 1; y = a x + u; y = a w; y = i a x',
  'a = interval(1, 2); b = interval(0, 1); y = a x + b; y < a x + b; y = interval(0, 1) x + interval(0, 1); (x, y) = (a, b); (a x, b y) = (1, 1)',
  'a = interval(1, 2); 1 < y < a x > 0; y < a x > 0; (y, x) = (a x, 1); domain(a w); iter(z^2 + a); rgb(a, x, y); conformal(a w)',
  'a = interval(1, 2); streamlines((a, x)); (y, -a x); dy/dx = a y; y\' = a x; label((a, 1), "hi"); segment((a, 0), (1, 1)); polygon((a, 0), (1, 1), (0, 1))',
  // Swept as u and v are: curves and regions in the plane.
  'r = interval(1, 2); (r cos(2 pi u), r sin(2 pi u)); (r, 2); (r, r^2); (r, 1) + (0, r); 2 (r, r); (cos(r), sin(r))',
  's = interval(0, 2pi); (cos(s), sin(s)); (s cos(s), s sin(s)); (s, sin(s) + t); k = 2; (k cos(s), sin(k s)); (s, interval(0, 1))',
  'a = interval(0, 1); b = interval(0, 1); (a, b); (a + b, a - b); (a, b, a b); (a u, b); (a, b) + (u, 0); (a u, b v); (a, b, u)',
  '(interval(0, 1), interval(0, 1)); (interval(0, 1), 2); (interval(-1, 1), interval(-1, 1)^2); (u, interval(0, 1)); (v, interval(0, 1)); (u, v + interval(0, 1))',
  's = interval(0, 1); (x, y) = (cos(2 pi s), sin(2 pi s)); (x, y) = (s, s^2) + (1, 0); (x, y) = (s, u); (x, y, z) = (s, s, s); (x, y) = (s, 1); (x + s, y) = (1, 2)',
  's = interval(0, 1); exp(2 pi i s); s + i; (s, i); s i; abs(exp(i s)); tube((cos(2 pi s), sin(2 pi s), s)); tube((s, u, u)); tube((cos(u), sin(u), u), s)',
  // u and v as intervals, and what they may not be.
  'u = interval(0, 2pi); (cos(u), sin(u)); (u, sin(u)); (cos(u), sin(u), u/4); u; 2 u; (u, v); (u, v, u v); (u cos(v), u sin(v))',
  'u = interval(0, 2pi); v = interval(0, pi); (sin(v) cos(u), sin(v) sin(u), cos(v)); (u, v); u + v; u v; (x, y) = (cos(u), sin(u))',
  'u = interval(-1, 1); v = interval(-1, 1); (u, v, u^2 - v^2); (u, v, u v) + (0, 0, 1); s = interval(0, 1); (u, v, s); (u s, v, 1)',
  'u = 3; v = 2; u := 3; v := 2 t; u = (1, 2); v = [1, 2]; u = x; v = interval(0, 1) + 1; u = 2 interval(0, 1)',
  'u := interval(0, 2pi); (cos(u), sin(u)); v := interval(0, 1); (u, v, 0); u = interval(0, 1); v ∈ interval(0, 1); u ∈ [1, 2]',
  'a = 1; u = interval(0, a); (u, u^2); v = interval(a, a + t); (u, v); (u, v, u + v); u(x) = x; v(0) = 1',
  'view((x, y) = (exp(Y) cos(X), exp(Y) sin(X)), X = -pi..pi, Y = -2..2); u = interval(-8, 8); (exp(u/4) cos(u), exp(u/4) sin(u)); x^2 + y^2 = 1',
  'view(x = 10^X, X = -1..1); a = interval(1, 2); y = a x; (a, a); a; y < a',
  // Solids: three parameters in a point in space.
  '(interval(0, 1), interval(0, 1), interval(0, 1)); (interval(0, 1), interval(0, 2), interval(-1, 1)) + (1, 0, 0); 2 (interval(0, 1), interval(0, 1), interval(0, 1))',
  'r = interval(0.7, 1); (r cos(2 pi u), r sin(2 pi u), 2v); s = interval(0, 1); (u, v, s u); (u, v, s); (s, u, v); (u + s, v, s)',
  'k = 0.75; r = interval(0, 1); p = interval(0, pi); q = interval(0, 2 pi k); (r sin(p) cos(q), r sin(p) sin(q), r cos(p)); (r sin(p) cos(q), r sin(p) sin(q), r cos(p)) + (k, 0, t)',
  'r = interval(0, 0.5); ((2 + r cos(2 pi v)) cos(2 pi u), (2 + r cos(2 pi v)) sin(2 pi u), r sin(2 pi v)); a = interval(-0.5, 0.5); b = interval(-0.5, 0.5); (a cos(3u) - b sin(3u), a sin(3u) + b cos(3u), 4u)',
  // Solids that fold, are undefined in part, or are not solids.
  'a = interval(-1, 1); b = interval(0, 1); c = interval(0, 1); (a^2, b, c); (a^3, b, c); (sqrt(a), b, c); ({a > 0: a}, b, c); ({a > 0: a, 0}, b, c); (a, a, c); (a, b, 0)',
  'k = 2; a = interval(-1, 1); b = interval(0, 1); c = interval(0, 1); (k a, b, c); ((a - k)^2, b, c); ((a + k/4)^2, b, c); (a + k, b, c); (a t, b, c); (sqrt(a + k), b, c); (sqrt(a - k), b, c)',
  'a = interval(0, 1); b = interval(0, 1); c = interval(0, 1); d = interval(0, 1); (a, b, c + d); (a, b); (a, b, c, d); (a u, b v, c); tube((a, b, c)); [(a, b, c), (a, b, 2 c)]; (a, b, c) + [0, 2]',
  'a = interval(0, 1); b = interval(0, 1); c = interval(0, 1); (a, b, c x); (a, b, c) = (1, 1, 1); a + b + c; (a b, c); a b c = 1; z = a b c',
  // The curve and surface operators over intervals.
  's = interval(0, 1); C = (s, s^2); curvature(C); curvature(C, 0.5); osculating(C, 0.5); frame((s, sin(s)), 1); (s, curvature(C)); torsion((s, s^2, s^3)); (s, torsion((s, s^2, s^3)), 0)',
  'u = interval(0, 2pi); C = (cos(u), 2 sin(u)); curvature(C); (u, curvature(C)); curvature(C, 1); osculating(C, 1); frame(C, 1); c(q) = (q, q^2); curvature(c, 1); (u, curvature(c))',
  'a = interval(1, 2); C = (a cos(u), a sin(u)); curvature(C, 0.5); osculating(C, 0.5); (u, curvature(C)); s = interval(0, 1); D = (a s, s^2); curvature(D, 0.5); curvature((a, s))',
  'camera(-0.9, 0.7, 11); u = interval(0, 2pi); v = interval(0, 2pi); S = ((3 + cos(v)) cos(u), (3 + cos(v)) sin(u), sin(v)); gaussian(S); gaussian(S, 0, 0); gaussian(S, 0, pi); meancurvature(S); meancurvature(S, 1, 2)',
  'u = interval(-1, 1); S = (u, v, u^2 - v^2); gaussian(S); meancurvature(S); gaussian(S, 0.5, 0.5); (u, v, gaussian(S)); f(a, b) = (a, b, a b); gaussian(f); gaussian(f, 0, 0)',
  's = interval(0, 1); u = interval(0, 1); S = (u, v, s); gaussian(S); T = (u, v, u v s); gaussian(T, 0, 0); p = interval(0, 1); q = interval(0, 1); R = (p, q, p q); gaussian(R); (p, q, p q)',
  // Reductions against an interval's measure.
  'p = interval(0, 1); total(p); count(p); mean(p); max(p^2); min(p - 2); mean(p^2); total(sin(pi p)); count(p < 1/2); total(p < 1/2); mean({p > 1/2: p})',
  'a = interval(1, 3); b = interval(0, 2); count(a); total(a); mean(a b); count({a < 2, b < 1}); total({a < b: 1}); max(a + b); min(a b); count(a + b < 3); mean(a + x)',
  'a = interval(1, 3); stdev(a); median(a); hist(a); sort(a); count(a, 1); total(a = 2); count(a = 2); count({a < x}); k = 2; total(k a); mean(a) + k; y = mean(a) x',
  'mean(interval(0, 1)); total(interval(0, 2)^2); count(interval(-1, 1) > 0); max(interval(0, 1) + interval(0, 1)); count({0 < x < 1, interval(0, 1) < x}); k = 2; count(interval(0, k)); total(interval(0, t))',
  // The density of a row's values.
  'a = interval(1, 2); a; 2 a + 1; a^2; -a; b = 2 a; b; b + 1; a + a; k = 3; k a; a + k; a t',
  'interval(0, 1); interval(0, 10); interval(-2, 2); k = 2; interval(0, k); interval(0, t); interval(k, 2 k) + 1; 3 interval(0, 1); interval(0, 1/0)',
  'a = interval(0, 1); b = interval(0, 1); a + b; a - b; a b; a + u; a + b + u + v; interval(0, 1) + interval(0, 1); interval(0, 2) + interval(0, 2); sin(a)',
  'a = interval(1, 2); a > 1.5; a = 1; a < x; a = a; a == 1; f(x) = a x; f(2); g(x) = x + interval(0, 1); g(1) + g(2); g(a)',
  // The bounds, and where an interval cannot go.
  'interval(1); interval(1, 2, 3); interval(); interval(2, 1); interval(1, 1); interval((1, 2), 3); interval([1, 2], 3); interval(1, "a"); interval(1 < 2, 3)',
  'interval(x, 2); interval(0, y); interval(u, 1); interval(0, v); interval(z, w); interval(0, interval(0, 1)); p = interval(0, 1); interval(p, 2); interval(0, 1/0); interval(-1/0, 0)',
  'k = 2; a = interval(k, 1); a; y = a x; (a, 1); b = interval(0, k - 2); b; c = interval(t, 1); c; (c, c); A = (1, 2); interval(A, 3); interval(A.x, 3)',
  'p = interval(0, 1); [p, 1]; [p, p]; L = [1, 2, p]; L; [1, 2] p; y = [1, 2] p x; ([1, 2] p, 1); (p, [1, 2]); mean([p, 1]); (p, p, p, p); ((p, 0), (0, p))',
  "p = interval(0, 1); c' = p; c(0) = p; d' = -d; d(0) = 1; view(x = 0..p); a_n = p n; X ~ Normal(0, 1); P(X < p); E(p X); X + p; p_1 = 2",
  'p = interval(0, 1); p = 2; q = p; q; r ∈ p; r; s ∈ interval(0, 1); p := interval(0, 2); (p, 1); interval = 3; interval(1, 2)',
  'interval(a, b) = a + b; interval(1, 2); y = interval(1, 2) x; s = interval(0, 1); (s, s)',
  'y = p x; p = interval(0, 1); (q, 1); q = interval(0, 1); f(x) = r x; y = f(x); r = interval(1, 2)',
];
