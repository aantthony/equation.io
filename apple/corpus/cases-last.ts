/**
 * Targeted documents for the last rows the port left alone: a matrix read as
 * the list of its rows, a matrix with a list among its entries, orbits of a
 * list, a state whose rate reads a list, an interval inside a state, a
 * sequence, P(…) or E(…), a stray ~, and what := cannot claim; and rows too
 * deep to walk, which say what the site's engine says. apple/corpus/analysis.ts
 * runs them with its own. One concern each, rows separated as the examples' are.
 */
const terms = (n: number, term: (k: number) => string, join = ' + '): string =>
  Array.from({ length: n }, (_, k) => term(k + 1)).join(join);

export const LAST_CASES: string[] = [
  // A matrix where a call asks for points is the list of its rows.
  'M = ((1, 2), (3, 4)); R = M; R[1]; M[2]; M[3]; M.x; M.y; polyline(M); polygon(M); hull(M + (1, 0)); distance(M, (0, 0)); f(p) = p.x; f(M); f(2 M)',
  'M = ((1, 2), (3, 4)); count(M); mean(M); total(M); sin(M); det(M, M); sort(M, M.x); M[1] + M[2]; M[1].x; [M]; M[M.x > 1]; M.z; M[0]; M[1.5]',
  'S = ((0, 0), (1, 0), (1, 1)); polygon(S); hull(S); S[2]; S.x; total(S.y); f(a, b) = a + b; f(S); mean(S); count(S); 2 S; polyline(2 S); S + (1, 1)',
  'T = ((1, 0, 0), (0, 1, 0), (0, 0, 1)); T[1]; T.z; polyline(T); hull(T); f(a, b, c) = a + b + c; f(T); T[2] + T[3]',
  'th = 0.5; R = ((cos(th), -sin(th)), (sin(th), cos(th))); M = ((1, 2), (3, 4)); polyline(R M); polygon(M R); hull(R); segment(R[1], R[2]); R[1]; (R M)[1]',
  'M = ((1, 2), (3, 4)); A = (1, 1); distance(M, A); M - A; |M[1] - A|; midpoint(M[1], M[2]); P = [(0, 0), (1, 1)]; distance(P, M); M P; P M; M[1] P',
  'M = ((1, 2), (3, 4)); g(p) = |p|; g(M); h(p, q) = p + q; h(M, M); h(M[1], M[2]); k(a) = a^2; k(M); k(M.x); max(M.x); M.x + M.y; (M.x, M.y)',
  'M = ((1, 2), (3, 4)); N = M; N[1]; N.x; O = 2 M; O[2]; O.y; polyline(O); L = M[1]; L; C = M.x; C; C[2]; total(C)',
  // With a list among its entries a matrix is a multiset of matrices.
  'a = [1, 2]; M = ((a, 0), (0, 1)); M (1, 1); P = [(1, 0), (0, 1)]; M P; polygon(M); M; det(M); M[1]; trace(M); Q = M (1, 2); Q; M Q',
  'a = [1, 2, 3]; b = [1, 2]; M = ((a, b), (0, 1)); M; M (1, 1); N = ((a, 0), (0, a)); N; N (x, y); N polygon((0, 0), (1, 0), (0, 1)); hull(N); N N; 2 N; N + N',
  'a = [0.5, 1]; R = ((cos(a), -sin(a)), (sin(a), cos(a))); R (1, 0); R polygon((0, 0), (1, 0), (0, 1)); R; R[1]; polyline(R); transpose(R) (1, 0); det(R); R^2 (1, 0); solve(R, (1, 0))',
  // An orbit of a list: one path a member.
  'L = [1, 2]; (L cos(t), sin(t))(0..5); (cos(t), L)(0..2pi); (L, L)(0..1); P = [(1, 0), (0, 1)]; (P + (t, 0))(0..3); (t, L[1])(0..2)',
  "th' = om; om' = -sin(th); th(0) = [1, 2]; om(0) = 0; (th, om)(0..10); th(0..5); (th[1], om[1])(0..10); (t, th)(0..10)",
  "L = [1, 2]; p' = (L, 0); p(0) = (0, 0); p(0..3); p; a = 2; (a L t, t)(0..1); (t, t^2)([0, 1]..2)",
  // A state whose rate reads a list.
  "L = [1, 2]; s' = L; s(0) = 0; s; (t, s); c' = [1, 2] c; c(0) = 1; c; d' = L[1] d; d(0) = 1; d; e' = total(L); e(0) = 0; e",
  "L = [1, 2]; s' = mean(L) s; s(0) = 1; s; u' = L + u; u(0) = [0, 1]; u; w' = (L[1], L[2]); w(0) = (0, 0); w; z' = count(L); z(0) = L; z",
  // An interval inside a state, a sequence, P(…) or E(…).
  "a = interval(0, 1); s' = a; s(0) = 0; s; r' = -r; r(0) = a; r; q' = 1; q(0) = 0; (q, a); q a",
  'a = interval(0, 1); b_n = a n; b_3; c_1 = a; c_{n+1} = c_n / 2; c_3; d_n = n; d_3 + a; sum(n=1..3, a n); (n, a n)',
  'a = interval(0, 1); X ~ Normal(0, 1); P(X < a); E(a X); P(a < 0.5); E(a); P(X < a) = 0.5; Y = a X; Y; P(Y > 0); X + a',
  'X ~ Uniform(0, 1); a = 0.5; P(X < a); P(X < a) = 0.5; P(X < x); E(X); E(X^2) - E(X)^2; P(X > 0.2, X < 0.7); P(X); P(); E(); E(X, X); P(X < a | X > 0.1)',
  'X ~ Normal(0, 1); Y ~ Normal(1, 2); P(X < Y); P(X + Y < 1); E(X Y); P(X < 1) + 1; 2 P(X < 1); E(X) x; y = P(X < x); y = E(X) x; P(X = 0); P(0 < X < 1)',
  // A ~ that is no declaration, fit or draw.
  '2 ~ 3; ~; a ~; ~ a; X ~ 3; X ~ Normal(0, 1) ~ 2; y = x ~ 2; f(x) ~ 2 x; A = (1, 2); A ~ Normal(0, 1); x ~ 3; 3 ~ x; ~~',
  // What := claims, and what it cannot.
  'u := 3; u; x := 2; t := 1; t; i := 2; i; e := 3; y = e x; v := interval(0, 1); (v, v^2); z := 1; pi := 3; pi; d := 2; d',
  'u := interval(0, 2pi); (cos(u), sin(u)); v := 2; v; y := 3; w := 2; w; theta := 1; r := 2; r; n := 3; n; k := 2; k x',
  'f(x) := x^2; f(2); f(x) := x^3; g(u) := u; g(1); x(t) := t; x(2); e(x) := x; e(2); sin(x) := x; sin(1); a := ; := 3; a := b := 2',
  // Families of trails, and of vector fields.
  'A = [(cos(t), sin(t)), (2 cos(t), sin(t))]; trail(A); trail(A[1]); k = [1, 2]; (k y, -x); [1, 2] (y, -x); (y, -k x); B = (k cos(t), sin(t)); trail(B); B',
  "p' = (p_y, -p_x); p(0) = [(1, 0), (2, 0)]; p; trail(p); trail(p[1]); q' = -q; q(0) = [1, 2]; trail((t, q)); (t, q)",
  // Rows too deep to walk: what the engine says of them on the site.
  `y = ${terms(20000, k => `sin(${k} x)`)}; y = x`,
  `y = ${'sin('.repeat(20000)}x${')'.repeat(20000)}; ${terms(20000, k => `${k}`)}; y = ${'-'.repeat(20000)}x; y = ${terms(20000, () => 'x', '^')}`,
  `y = ${'('.repeat(20000)}x${')'.repeat(20000)}; y = d/dx (${terms(20000, k => `sin(${k} x)`)}); a = ${terms(20000, k => `${k}`)}; a`,
];
