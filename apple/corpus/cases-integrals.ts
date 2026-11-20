/**
 * Targeted documents for integrals (apple/corpus/analysis.ts runs them with
 * its own): every rule of lib/integrate.ts as a row's readout and as a
 * function of x, the notations, the bounds, what a definite integral's row
 * shades (lib/intshade.ts), and integrals inside definitions and other rows.
 * One concern each, rows separated as the examples' are.
 */
export const INTEGRAL_CASES: string[] = [
  // Definite integrals with closed forms: readouts, and the area each shades.
  'int[0..2] x^2 dx; int[1..e] 1/x dx; ∫[0..pi] sin(x) dx; int[2..0] x^2 dx; int[0..1] dx; int[0..1] 1 dx',
  'int[0..1] 3x^5 - 2x + 7 dx; int[0..1] (3x^5 - 2x + 7) dx; int[-1..2] (x^2 + 1)(x - 3) dx; int[0..3] x dx',
  'int[1..2] 1/x^2 dx; int[0..1] (3x + 2)/(x^2 + 1) dx; int[2..3] 1/(x^2 - 1) dx; int[0..1] 1/(x^2 + x + 1) dx',
  'int[3..5] x^3/(x^2 - 4) dx; int[3..4] 1/(x - 2)^2 dx; int[2..3] 1/(x^2 - 1)^2 dx; int[0..1] (x + 1)/(x^2 + 1)^2 dx',
  'int[0..1] 1/(x^4 + 1) dx; int[0..1] 1/(x^3 + 1) dx; int[0..1] x/(x^4 + x^2 + 1) dx; int[2..3] (x^2 + 1)/(x^3 - x) dx',
  'int[0..1] cos(3x - 1) dx; int[0..1] exp(2x) dx; int[0..1] e^x dx; int[0..1] tan(x) dx; int[0..2] sqrt(2x + 5) dx',
  'int[1..3] ln(x) dx; int[0..1] atan(x) dx; int[0..0.5] asin(x) dx; int[0..1] sinh(x) + cosh(2x) dx; int[-1..2] abs(x) dx',
  'int[0..1] erf(x) dx; int[0..1] 2^x dx; int[0..2] normalpdf(x, 1, 2) dx; int[0..2] normalcdf(x, 1, 2) dx; int[1..2] log(x) dx',
  'int[0..1] acos(x) dx; int[0..1] asinh(x) dx; int[1..2] acosh(x) dx; int[0..0.5] atanh(x) dx; int[0..1] tanh(x) dx',
  'int[0..1] sech(x) dx; int[-1..1] sign(x) dx; int[0..1] (2x + 1)^2.5 dx; int[0..1] (2x + 1)^(-1) dx; int[0..1] 1/(2x + 1) dx',
  'int[0..1] 1/(2x + 1)^3 dx; int[0..1] 3^(2x + 1) dx; int[0..1] x^0.5 dx; int[1..2] x^(-1.5) dx; int[1..2] x^pi dx',
  'int[0..1] exp(-x^2) dx; int[0..2] exp(-(x - 1)^2/2) dx; int[0..1] exp(-3x^2 + 2x + 1) dx; int[0..1] exp(x^2) dx',
  'int[0..1] x exp(x^2) dx; int[0..1] sin(x) cos(x) dx; int[1..2] ln(x)/x dx; int[0..1] x/(x^2 + 1)^3 dx',
  'int[0..1] cos(x) exp(sin(x)) dx; int[0..1] x sqrt(x^2 + 1) dx; int[0..1] x sin(x) dx; int[0..1] x^2 exp(x) dx',
  'int[1..2] x ln(x) dx; int[0..1] x exp(-x) dx; int[0..1] x^3 cos(2x) dx; int[0..1] x atan(x) dx',
  'int[0..1] exp(x) sin(x) dx; int[0..1] exp(-x) cos(3x) dx; int[0..1] sin(x)^2 dx; int[0..1] cos(x)^2 dx',
  'int[0..1] sin(x)^3 dx; int[0..1] sin(x)^2 cos(x)^2 dx; int[0..1] sin(x)^5 cos(x)^2 dx; int[0..1] sin(3x) cos(5x) dx',
  'int[0..1] sin(x) sin(2x) dx; int[0..1] cos(x) cos(2x) cos(3x) dx; int[0..1] cos(x)^3 sin(x)^2 dx; int[0..1] cos(x)^4 dx',
  // No closed form: the quadrature sum.
  'int[0..1] exp(x^3) dx; int[1..2] sin(x)/x dx; int[1..2] exp(x)/x dx; int[1..2] x^x dx; int[0..1] sqrt(1 + x^4) dx',
  'int[-1..1] 1/x^2 dx; int[-1..1] 1/x dx; int[0..1] 1/sqrt(x) dx; int[0..1] ln(x) dx; int[0..2] floor(x) dx',
  // Infinite ranges.
  'int[0..inf] exp(-x) dx; int[1..inf] 1/x^2 dx; int[-inf..inf] exp(-x^2) dx; int[inf..1] 1/x^2 dx; int[inf..inf] x dx',
  'int[0..inf] exp(-x)/(1+x) dx; int[-inf..0] exp(x) dx; int[1..inf] 1/x dx; int[-inf..inf] 1/(1 + x^2) dx; int[0..-inf] exp(x) dx',
  'int[-∞..∞] normalpdf(x, 0, 1) dx; int[-inf..-inf] x dx; int[-inf..inf] x exp(-x^2) dx; int[0..inf] sin(x)/(1 + x^2) dx',
  // Functions of x: variable bounds and indefinite forms.
  'y = int[0..x] exp(-t^2) dt; y = int[0..x] sin(t)/t dt; y = int[-inf..x] exp(t) dt; y = ∫[-∞..x] normalpdf(t, 0, 1) dt',
  'y = int(x^2 dx); y = ∫ cos(x) dx; y = int[a..x] cos(x) dx; a = 0.5; y = int[x..2x] 1/t dt; y = int(sin(x)/x dx)',
  'f(x) = sin(x)^2; y = f(x); y = int[0..x] f(t) dt; g(x) = int[0..x] f(t) dt; g(2); y = g(x) - 1; y = d/dx g(x)',
  'F(x) = int(x^2 dx); F(3); y = F(x); G(b) = int[0..b] exp(-x^2) dx; G(1); y = G(x); c = int[0..1] x^2 dx; c; y = c x',
  // Sliders and time: parameters stay symbolic.
  'a = 3; int[0..a] x^2 dx; b = 5; int[0..b] sin(x) dx; int[a..b] 1/x dx; int[0..1] a x^2 + b dx; int[0..1] sin(a x + b) dx',
  'k = 2; int[0..1] exp(-k x^2) dx; int[0..1] exp(k x) sin(a x) dx; a = 1.5; int[0..k] x^a dx; int[-k..k] exp(-x^2/a) dx',
  'int[0..t] x^2 dx; int[0..1] sin(x + t) dx; int[0..t] t^2 dt; a = 2 t; int[0..a] cos(x) dx; int[t..t + 1] exp(-x^2) dx',
  // Notations: the measure's place, iterated integrals, coefficients, sums inside.
  'int[0..1] dx/(1+x^2); int[0..1] int[0..y] x dx dy; int[0..1] int[0..y] x dx y dy; 2 int[0..1] x dx + 1',
  'int[0..1] sum[n=1..3] x^n dx; int[0..2] (d/dt (t^2)) dt; int(0..1, x^2 dx); int[0..1] x^2 dx + int[1..2] x dx',
  'int[0..1] 1/(1+x^2)dx; int[0..1] x^2 du; int[0..1] u^2 du; int[0..1] θ^2 dθ; -int[0..1] x dx; int[0..1] -x dx',
  'int[0..1] (int[0..1] x y dx) dy; int[0..1] x dx int[0..1] y dy; int[0..1] 2 dx; (int[0..1] x dx)^2; int[0..1] x dx/2',
  'sum(n=1..3, int[0..n] x dx); N = 3; y = sum(n=1..N, int[0..x] t^n dt); int[0..1] {x < 0.5: 1, 2} dx; int[0..2] max(x, 1) dx',
  // Malformed.
  'int[0..2]; int(x^2, x); int[0..1] x^2 dq; int(x^2); int; ∫; int[0..1]; int[0..1] x dx + y dy; int[0..1] x dx dx',
  'int[0..1] (x dx + y dy); int[0..1] x; y = int[0..1]; int(1..2); int[0..] x dx; int[a..b] x dx; int[0..1] q dx',
  // What shades: one definite integral of a real integrand, bounds that have values.
  'b = 2; int[0..b] sin(x) dx; int[0..x] t dt; y = int[0..1] x dx; 2 int[0..1] x dx; int[0..1] x dx + 1; (int[0..1] x dx)',
  'int[1..0] x^2 dx; int[0..0] x dx; int[-2..2] x^3 dx; int[0..7] sin(x) dx; int[-1..1] 1/x dx; int[0..3] {x < 1: 1} dx',
  'L = [1, 2, 3]; int[0..1] L x dx; int[0..L] x dx; A = (1, 2); int[0..1] A x dx; int[0..A.x] x dx; int[0..1] x + i dx',
  'x0 = 1; int[0..x0] x^2 dx; u = 3; int[0..1] u^2 du; int[0..q] x dx; int[0..1] q x dx; int[0..y] x dx; int[0..1] y dx',
  'view(x = 0.5..2000, y = 0.001..10, x = 10^X, y = 10^Y); y = 1/x; int[1..100] 1/x dx; int[1..10] 1/x^2 dx',
  'view(x = -1..7, y = -1.5..1.5); b = 5; y = sin(x); int[0..b] sin(x) dx; ---; int[0..1] x dx; y = x',
  // In other rows.
  'y < int[0..x] cos(t) dt; int[0..1] x dx = 0.5; int[0..1] x dx < 1; (int[0..1] x dx, 2); y = x int[0..1] t dt',
  'int[0..1] x dx y; sin(x) int[0..y] t dt; P = (int[0..1] x dx, 1); P; [int[0..1] x dx, int[0..2] x dx]',
  'X ~ Normal(0, 1); int[0..1] x dx; f(a) = int[0..a] sin(x)/x dx; f(1); f(2); y = f(x); mean([f(1), f(2)])',
];
