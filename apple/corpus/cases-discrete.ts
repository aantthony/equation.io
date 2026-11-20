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
];
