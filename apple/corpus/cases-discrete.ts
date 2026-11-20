/**
 * Targeted documents for the discrete kinds and the calculus rows that expand
 * when they resolve (apple/corpus/analysis.ts runs them with its own): sums
 * and products, sequences and recurrences, integrals, automata and lattices.
 * One concern each, rows separated as the examples' are.
 */
export const DISCRETE_CASES: string[] = [
  // Σ and Π: the call and the header form, bounds, nesting, limits.
  'y = sum(n=1..5, x^n); sum(n=1..5, n); prod(n=1..5, n); sum(n=1..4, 1/n^2); prod(k=1..3, x - k)',
  'y = 2 sum[n=1..3] sin(n x)/n; y = sum[n=1..3] sin(n x)/n + 1; y = x/sum[n=1..3] n; y = 2/sum[n=1..2] n x',
  'N = 4; y = (4/pi) sum(n=1..N, sin((2n-1)x)/(2n-1)); y = sum(n=0..N, (-1)^n x^(2n)/prod(k=1..2n, k)); N',
  'N = 3; M = 2.5; y = sum(n=1..N, sum(m=1..M, x^n/m)); sum(n=M..N+1, n); a = 2; y = a sum[n=1..N] x^n',
  'N = round(3); y = sum(n=1..N, x^n); k = clamp(4, 1, 9); y = prod(n=1..k, x - n); b = 0.5; y = sum(n=1..2, b x^n)',
  'sum(n=1..0, n); prod(n=1..0, n); sum(n=3..3, n); sum(n=0.5..2.5, n); sum(n=-2..2, n^2)',
  'sum(n=1..501, n); sum(n=1..500, n); sum(n=1..60, sum(m=1..60, n m)); sum(n=1..N, n); sum(n=1..t, n); sum(n=1..x, n)',
  'sum(x=1..3, x); sum(t=1..3, t); sum(n=1..1/0, n); sum(n=1..3); sum(1..3, n); sum[n=1..3]; y = sum',
  'sum(n=1..3, sum(n=1..2, n)); sum[n=1..2] sum[n=1..3] n; sum(n=1..2, n) sum(n=1..3, n); sum(n=1..3, a_n)',
  'f(x) = sum(n=1..N, x^n); N = 3; y = f(x); f(2); g(q) = prod(k=1..3, q + k); g(1); y = g(x)',
  'N = 2 t; y = sum(n=1..N, x^n); M = 3; y = sum(n=1..M, sin(n x - t)); (sum(n=1..M, n), 1)',
  'y < sum(n=1..3, x^n); sum(n=1..3, x^n) y; sum(n=1..3, n) = 6; sum(n=1..3, n) < 5; y = d/dx sum(n=1..3, x^n)',
  'N = 5; y = sum(n=1..N, {mod(n, 2) > 0: sin(n x)/n, 0}); y = sum(n=1..3, abs(x - n)); y = sum(n=1..2, floor(n x))',
  'y = Σ(n=1..3, x^n); y = ∑[n=1..3] x^n; y = Π(n=1..3, x - n); y = ∏[n=1..3] (x - n)',
  // Sequences: explicit terms, their index, what they may read.
  'a_n = 1/n^2; b_k = (-1)^k/k; c_m = isprime(m); d_j = j^2; e_j = 3; T_c = 300; T_c; k_B = 1.5',
  'a_{n} = 1/n; b_(k) = k; c_{ n } = n; d_( n ) = n^2; a_ n = 2; f_nn = 3',
  'r = 2; a_n = r^n/n!; b_n = sin(n + t); c_n = n x; d_n = n q; e_n = (n, 1); g_n = n < 2',
  'a_x = 3; a_t = n; b_i = i; c_e = 2; a_n == 2; a_n =; b_d = d; c_u = u^2',
  'a_n = 1/n; a_n = 2/n; a_k = 3; a_j = j; a_3; a_0; a_k; b_n = n; b_n = 1',
  'a_n = {mod(n, 2) = 0: n, -n}; b_n = {n > 3: 1}; c_n = {n = 2: 1, 0} x; f(q) = {q > 1: 1, 0}; d_n = f(n)',
  // Terms: at a number, at a slider, at another row's index, in sums.
  'a_n = 1/n; a_3; a_10 + a_2; y = a_2 x; k = 4; a_k; a_[k]; a_[k+1]; a_[2 k]; a_[1.5]; a_[-1]; a_1001; a_[x]',
  'a_n = (-1)^(n+1)/n; s_n = sum(k=1..n, a_k); s_4; s_[3]; y = ln(2)',
  'b_n = n^2; a_n = b_[n+1] - b_n; c_n = a_n + b_n; c_3; d_n = b_[2n] + b_(n); e_n = b_{n}',
  'a_n = sum(s=1..n, s); a_5; b_n = prod(s=1..n, s)/n^n; c_n = sum(s=n..2n, 1/s); d_n = sum(s=1..3, s n)',
  'k = 3; a_n = n^2; c = a_k + 1; c; d2 = a_2; y = d2 x; f(q) = a_3 q; f(2); a_k = 7; k = round(2)',
  'a_n = b_n + 1; b_n = a_n; a_n2 = 3; c_n = c_3 + n; d_n = d_n; e_n = e_[n-1] + 1',
  'a_n = n; sum(k=1..5, a_k); N = 3; sum(k=1..N, a_k); y = sum(k=1..N, a_k x^k); prod(k=1..3, a_[k+1])',
  'a_n = 1/n; a_[1..3]; L = a_[1..20]; mean(L); a_n[2]; a_; y = a_n; a_m; (a_2, a_3)',
  // Recurrences: cobwebs, orbit diagrams, seeds.
  'a_{n+1} = r a_n (1 - a_n); r = 2.9; a_0 = 0.15; view(x = 0..1, y = 0..1)',
  'a_{n+1} = x a_n (1 - a_n); b_(n+1) = cos(b_n); c_{k + 1} = c_k/2 + 1; d_{ n+1 } = d_{n}^2 - 1; e_{n+1} = e_(n)/2',
  'a_0 = 3; a_{n+1} = a_n - (a_n^2 - 2)/(2 a_n); y = sqrt(2); a_0',
  'a_{n+1} = y a_n; b_{n+1} = q b_n; c_{n+1} = c_n + t; d_{n+1} = 2; e_{n+2} = e_n; f_{x+1} = f_x',
  'a_{n+1} = a_n/2; a_{n+1} = a_n/3; a_n = 2; b_{n+1} = b_n + (1, 2); r = 0.5 t; c_{n+1} = r c_n; c_0 = t',
  'a_{n+1} = x a_n (1 - a_n) + c; c = 0.1; a_0 = 0.2; b_{n+1} = sin(x b_n) + t',
  // A recurrence's terms: its chain of constants, a step that reads n.
  'a_{n+1} = a_n/2 + 1; a_0 = 4; a_3; a_1 + a_2; y = a_2 x; k = 2; a_k; (a_1, a_2)',
  'a_{n+1} = r a_n; r = 2; a_5; c = a_2 + 1; c; y = c x',
  'a_{n+1} = a_n + n; a_4; b_{n+1} = b_n + 1/(n + 1)^2; b_0 = 0; c_n = n; d_{n+1} = d_n + c_n; d_3',
  'a_{n+1} = 2 a_n; b_n = a_n + 1; b_3; c_{n+1} = c_n + a_n; s_n = sum(k=0..n, a_k)',
  'a_{n+1} = b_n + 1; b_{n+1} = a_n; a_0 = 1; b_0 = 2; a_3; b_3',
  'a_{n+1} = a_n + x; a_3; b_{n+1} = b_n + q; b_2; c_{n+1} = c_n + t; c_2; d_{n+1} = d_n n x',
  'p_{n+1} = (1 - 1.4 p_n[1]^2 + p_n[2], 0.3 p_n[1]); p_0 = (0, 0); s_0 = (); s_{n+1} = push(s_n, n); q_{n+1} = (q_n, 1)',
  'D = (1, 1, 0, 1); step(q, s) = mod(2q + s, 3); q_0 = 0; q_{n+1} = step(q_n, D[n + 1]); N = 2; q_N',
  'f(q) = {q = 0: 1, 0}; a_n = f(n); b_{n+1} = f(b_n); f(2); y = f(x)',
];
