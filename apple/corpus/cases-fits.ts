/**
 * Targeted documents for the kinds that wait on lists or on numerics
 * (apple/corpus/analysis.ts runs them with its own): fits (`Y ~ m X + b`),
 * Fourier rows over lists, systems of equations and complex equations, and
 * the approximate tiers of random variables. One concern each, rows separated
 * as the examples' are.
 */
export const FITS_CASES: string[] = [
  // Fits: linear, polynomial, nonlinear; what the coefficients then are.
  'P = [(0,1.1),(1,2.9),(2,5.2),(3,6.8),(4,9.1)]; P.y ~ m P.x + b; y = m x + b; m; b; m + b; (P.x, P.y - (m P.x + b))',
  'X = [0, 1, 2, 3, 4]; Y = [1, 3, 4.5, 7.2, 9]; Y ~ m X + b; y = m x + b; total((Y - (m X + b))^2); k = 2 m; k',
  'X = [-2, -1, 0, 1, 2]; Y = [9, 2, 1, 6, 17]; Y ~ a X^2 + b X + c; y = a x^2 + b x + c; a; b; c',
  'X = [0, 0.5, 1, 1.5, 2]; Y = [2, 2.84, 4.03, 5.72, 8.11]; Y ~ a exp(b X); y = a exp(b x); a b',
  'X = [1, 2, 3, 4]; Y = [2, 4.1, 5.9, 8.2]; Y ~ m X; y = m x; Y - m X; mean(Y - m X)',
  'X = [1, 2, 3, 4]; Y = [2, 4.1, 5.9, 8.2]; s = 2; Y ~ s X + b; b; Y ~ q X + s; q',
  '[1, 2, 3.2, 3.9] ~ m [0, 1, 2, 3] + b; m; b; y = m x + b',
  'X = [1, 2, 3]; Y = [2, 4, 6]; Y + 1 ~ m X + b; m; b; Y.z ~ m X; X ~ Y',
  // What a fit refuses.
  'X = [1, 2, 3]; Y = [2, 4, 6]; Y ~ 2 X; Y ~ m X + t; Y ~ m X + x; Y ~ a b X; Y ~ m [1, 2] + c',
  'X = [1, 2, 3]; Y = [2, 4, 6]; Y ~ m Z + b; m; Z = [1, 2, 4]; Y ~ p ln(-X) + r; p',
  'X = [1, 2, 3]; Y = [2, k, 6]; Y ~ m X + b; k = 4; m; Y ~ n X + j; j = 3; n',
  'X = [1, 1, 1]; Y = [2, 4, 6]; Y ~ m X + b; m; y = m x + b; Y ~ c; c; y = c',
  'X = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; Y = X^2; Y ~ a + b X + c X^2 + d2 X^3 + f X^4 + g X^5 + h X^6 + j X^7 + k X^8; a',
  'A = (1, 2); X = [1, 2, 3]; Y = [2.1, 3.9, 6.2]; Y ~ m X + A.x; m; Y ~ g X + h; g; h',
  'X = [1, 2, 3]; Y = [2, 4.5, 6]; Y ~ m X + b; Y ~ m X + c; m; c; m = 3',
  'X = [1, 2, 3, 4]; Y = [1.2, 1.9, 3.2, 3.8]; f(q) = m q + b; Y ~ f(X); m; b; y = f(x)',
  'X = [0, 1, 2, 3]; Y = [1, 2.7, 7.4, 20]; Y ~ exp(k X); k; ln(Y) ~ r X + s; r; s; Y ~ gamma X; gamma',
  'L = [1, 2, 3]; Y ~ m L + b; Y = [2, 4, 7]; m; X ~ Normal(0, 1); L ~ n X; n',
  'X = [1, 2, none, 4]; Y = [2, 4, 6, 8.5]; Y ~ m X + b; m; b',
  // Fourier analysis: samples in a tuple, a signal over an interval, the series it reconstructs.
  'T = (0, 1, 0, -1, 0, 1, 0, -1); S = fourier(T); S; segment((S.x, 0), S); y = reconstruct(T, 2); fourier(T)',
  'T = (1, 3, 2, 5, 4, 2, 1, 0); fourier(T, interval(0, 10)); y = reconstruct(T, 3, interval(0, 10)); reconstruct(T, 4)',
  'L = [0, 1, 0, -1]; fourier(L); T = sort(L); fourier(T); fourier((1, 2)); fourier((1)); fourier(T, 8); fourier()',
  's = interval(0, 1); S = fourier(sin(2pi s) + 0.5 cos(6pi s)); S; S.y; y = reconstruct(sin(2pi s), 1); fourier(sin(2pi s), 16)',
  's = interval(0, 2pi); N = clamp(round(3), 0, 8); f(x) = sign(sin(x)); y = reconstruct(f(s), N); fourier(f(s), 32); N',
  's = interval(0, 1); N = 2; y = reconstruct(s^2, N); y = reconstruct(s^2, 2.5); y = reconstruct(s^2, 200); y = reconstruct(s^2, N, 4)',
  'N = clamp(round(3), 0, 200); s = interval(0, 1); y = reconstruct(abs(s - 0.5), N); M = clamp(2, 0, 8); y = reconstruct(s, M)',
  's = interval(0, 1); a = 2; fourier(a sin(2pi s)); fourier(sin(2pi s) x); fourier(sin(2pi s + t)); fourier(sin(q s)); fourier(3)',
  's = interval(0, 1); r = interval(1, 2); fourier(s r); fourier(sin(2pi s), r); f(x) = x^2; fourier(f); reconstruct(f, 2)',
  'fourier(sin(2pi interval(0, 1))); y = reconstruct(interval(0, 1)^2, 3); fourier(interval(0, 1) + interval(0, 1))',
  's = interval(0, 1); g(x) = reconstruct(s (1 - s), 4); y = g(2x); g(0.25); h(q) = reconstruct(q s, 2); y = h(3)',
  's = interval(0, 1); S = fourier(e^(2pi i s)); fourier(re(e^(2pi i s))); fourier(i s); k = s; fourier(sin(2pi k))',
  // An interval anywhere else is another kind's.
  's = interval(0, 1); s; y = s x; (s, s^2); mean(s^2); b = 2 s; b; s = interval(2, 1); interval(1); q = interval(1, x)',
];
