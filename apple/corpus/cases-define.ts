/**
 * Targeted documents for explicit definitions, `a := 2` (lib/defs.ts
 * scanDefinition, lib/expr.ts explicitAssignment and REDEFINABLE), and for
 * rows that read as a product on a reserved name (reservedFnHint): one
 * concern each, rows separated as the examples' are. Recorded by analysis.ts
 * with the rest.
 */
export const DEFINE_CASES: string[] = [
  // Ordinary names, as = defines them.
  'a := 2; y = a x; f(x) := x^2; f(a) + 1; y = f(x) - a',
  "a' := -a; a(0) := 1; y = a x; b := a + 1; b",
  'A := (1, 2); A; B := (a, 1); a := 0.5 # speed; segment(A, B)',
  'a := 2 # a note; b := clamp(1, 0, 3); c := 1.5; n := 3; y = a x^n + b + c',
  // Redefining e, pi, i, w and t for the whole graph.
  'e := 0.6; e; 2e; exp(1); y = e x; e^x',
  'e := sin(32); e; pi := 3; pi; π; 2π; y = sin(pi x)',
  'i := 3; i x; i + 1; (1 + 2i); y = i x; i^2',
  'i := 2; y = i x; e^(i x); |1 + i|',
  'w := 2; w^2; w x; w := x - y',
  'w := x - y; w = 0; w; w^2 = 1',
  't := 2; t^2; b := t + 1; b; y = sin(x + t)',
  "t := 0.5; y = sin(x + t); a' := -a; a(0) := 1; (cos(t), sin(t))",
  'b := e^2; b; e := 2; y = b x',
  // = rows keep their meaning; once redefined, a claim needs no advice.
  'e = 0.6; pi = 3; i = 2; t = 3; w = 1',
  'e := 1; e = 2; e = 1; pi := 3; pi = 3',
  'i = [0..3]; i = [0..239]; e = [1, 2]',
  // What := cannot claim, and why.
  'x := 3; y := 2; z := 1; d := 3; sin := 3; 2 := 3; u_a := 1',
  'u := 3; v := 2; u := interval(0, 2pi); (cos(u), sin(u))',
  'u = interval(0, 2pi); (cos(u), sin(u)); v := interval(0, 1); (u, v, u v)',
  'e(x) := x^2; pi(x) := x; i(x) := x; w(x) := x; t(x) := x; x(t) := t; d(x) := x',
  'f(e) := e^2; f(3); e; g(i) := i + 1; g(2); h(t, w) := t w; h(2, 3); y = h(x, 2)',
  // Defined twice.
  'f(x) := x^2; f(x) := x^3; g(x) = x^2; g(x) := x^3; h(x) = x; h(x) = 2',
  'e := 0.6; e := 2; a := 1; a := 2; a = 3; r := sqrt(x^2 + y^2); r := 2; r = 2',
  'i := 3; i ∈ [1..3]; p ∈ [1..3]; i ∈ [1, 2]',
  // := as a token: text holding one is text; elsewhere it is refused.
  'label((0, 0), "a := b"); (0, 0) "a := b"; "a := b"; "a b"; a := "x := y"',
  'y = 1 + (a := 2); a == 1 := 2; (a := 2); a := b := 3; y = x := 2',
  'a :=; := 2; a : = 2; a ::= 2; a := = 2; a := 2 $',
  // Every row shape, written with :=.
  'X ~ Normal(0, 1); Y := 2X; P(Y > 0); E(Y)',
  'a_n := n^2; a_3; b_0 := 1; b_{n+1} := 2 b_n; b_4',
  'data := open("x.csv", ab12); d2 := open("x.csv"); e := open("x.csv")',
  'L := [1, 2, 3]; L; mean(L); M := ((1, 2), (3, 4)); det(M); T := (1, 2, 3, 4); T',
  // A redefined name everywhere the document parses.
  'e := 2; X ~ Normal(e, 1); E(X); a_n := e n; a_3',
  'pi := 3; view(x = -pi..pi); a := clamp(1, 0, pi); y = a x',
  'pi := 3; camera(pi/3, pi/6); z = x y; e := 2; grid(e x)',
  'e := 2; c_{n+1}[k] := mod(c_n[k-1] + e, 2); c_0[k] := {k = 0: 1, 0}',
  'e := 0.6; P = (e, 1); P; A := (e, e^2); A; segment(P, A)',
  'i := 2; L = [i, 2i, i^2]; L; sum(n = 1..i, n); int[0..i] x dx',
  'e := sin(; y = e x; e',
  'e := q; y = e x; pi := 1/0; pi',
  't := 1; trail((cos(t), sin(t))); y = d/dx (t x^2); int[0..t] x dx',
  // A function row on a reserved name reads as a product.
  'u(x, y) = x^2 + y^2; w(x, y) = x y; t(x) = x; x(y - 1) = 1; v(x) = 2x; z(x, y) = x + y',
  'u(x, y) := x^2 + y^2; y(x) = x^2; x(t) = cos(t); u(x) = 3',
  'f(x, y) = x^2 + y^2; f(x, y) = 4; u(x) + 1; u(x, y)',
  // A Σ in a function's body is bounded by its parameter, expanded at the call.
  'N = 3; f(N) = sum(k=1..N, k); y = f(100); f(2); g(M) = sum(k=1..M, k N); g(2); y = g(3) x',
  'f(N) = prod(k=1..N, k); f(4); y = f(3) x; h(a, b) = sum(k=a..b, k^2); h(1, 3); h(2, x)',
  'f(n) = sum(k=1..n, x^k/k); y = f(4); g(n) = f(n) + f(n + 1); y = g(2); a_n = f(n); a_3',
  'f(P) = sum(k=1..P.x, k); f((3, 1)); q(a, b) = sum(k=1..a, b k); q((2, 5)); q(2, 5)',
  // A Σ up to a clamped whole-number slider: terms gated on it, a loop in the shader.
  'N = round(clamp(19, 1, 50)); y = (4/pi) sum(k=1..N, sin((2k-1)x)/(2k-1))',
  'N = round(clamp(5, 1, 20)); y = 1 - sum(k=1..N, cos(k x)/k^2); y = sum(k=1..N, sin(k x)/k)/2 + 1',
  'N = clamp(round(8), 1, 16); y = sum(k=1..N, -sin(k x)/k); y = sum(k=2..N, cos(k x))',
  'N = floor(clamp(6, 2, 12)); y = sum(k=1..N, 2 sin(k x) + cos(k x)/3); y = -sum(k=1..N, sin(3 k x))/pi',
  'N = clamp(5, 1, 20); y = sum(k=1..N, sin(k x)/k); M = round(clamp(5, 1.5, 20)); y = sum(k=1..M, sin(k x)/k)',
  'N = round(clamp(5, 1, 20)); y = sum(k=1..N, x^k); sum(k=1..N, k); y = sum(k=0..N, sin(k x)); y = prod(k=1..N, cos(k x))',
  'N = round(clamp(5, 1, 300)); y = sum(k=1..N, sin(k x)/k); f(N) = sum(k=1..N, sin(k x)); y = f(3)',
  'N = round(clamp(4, 1, 9)); y = sum(k=1..N, sin(k x + 1)/k); y = sum(k=1..N, sin(k (x - t))/k); (u, sum(k=1..N, sin(k u)/k))',
];
