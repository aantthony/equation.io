/**
 * Targeted documents for integrals (apple/corpus/analysis.ts runs them with
 * its own): every rule of lib/integrate.ts as a row's readout and as a
 * function of x, the notations, the bounds, what a definite integral's row
 * shades (lib/intshade.ts), integrals inside definitions and other rows, and
 * the reductions over a continuous set that are integrals (lib/measure.ts).
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
  // Reductions over a continuous set (lib/measure.ts): products of ranges.
  'total(u^2); mean(u); count(u); total(u v); mean(u + v); count({0 < x < 1}); total({0 < x < 1: x^2}); mean({0 < x < 2: x})',
  'count(0 < x < 3); total(0 < x < 1); mean(1 < x < 3); total(u < 0.5); count(x < 1); count(x); total(x); mean(x)',
  'count({2<x<1}); count({0<x<1, 2<x<3}); total({2<x<1: x}); mean({2<x<1: x}); total({0 < x < 1, x > 0.5: x})',
  'a = 2; count({0<x<a}); count({0<x<a, 1<x<3}); total({0<x<a: x}); total(a u); mean({0 < x < a: sin(x)}); b = -1; count({0<x<b})',
  'total({0 < x < 1, 0 < y < 2: x y}); count({0 < x < 1, 0 < y < 2}); mean({0 < x < 1, 0 < y < 1: x + y}); total({0<x<1: u x})',
  'total({0<x<1: (x, x^2)}); mean({0<x<2: (x, 1)}); total({0 < x < pi: sin(x)}); total({0 < x < 1: exp(-x^2)}); total({0<x<1: cos(x)^2})',
  // Integrands with singularities or no closed form: adaptive quadrature.
  'total({0<x<1: 1/sqrt(x)}); total({0<x<1: ln(x)}); total({0<x<1: 1/x}); total(1/u); mean({0<x<1: 1/x}); total({0<x<1: 1/x^2})',
  'total({0<x<2: 1/(x-1)^2}); total({0<x<1: tan(pi x/2)}); total({-1<x<1: 1/x}); total({1 < x < 2: sin(x)/x}); total({0<x<1: x^x})',
  'total({0 < x: exp(-x)}); total({x > 1: 1/x^2}); total(exp(-x^2)); count({x > 0}); total({x > 1: 1/x}); mean({x > 0: exp(-x)})',
  'total({0 < x < 1: sqrt(x)}); total({0<x<1: floor(3 x)}); total({0<x<1: {x < 0.5: 1, 2}}); total({-1 < x < 1: abs(x)}); total({0<x<1: q x})',
  'total({0 < x < 1: t x}); f(k) = total({0 < x < k: 1/x}); f(2); g(k) = total({0 < x < k: x}); g(3); y = total({0 < u < 1: u x})',
  // Curves written as a graph over a bounded range: arc length.
  'count({y = x^2, 0 < x < 1}); count({y = x, 0 < x < 1}); count({x = y, 0 < x < 1}); count({y = x, 0 < y < 1}); count({x = y^3, -1<y<1})',
  'count({y=sqrt(x),0<x<1}); count({y=sqrt(x),-1<x<1}); count({y=1/x,-1<x<1}); count({y=ln(x),-1<x<1}); count({y = tan(x), 0<x<3})',
  'count({y = sin(x), 0 < x < pi}); total({y = x^2, 0 < x < 1: x}); mean({y = x^2, 0 < x < 1: y}); a = -1; count({y = x^2, 0<x<a})',
  'count({y=x^(1/3),-1<x<1}); count({y = sqrt(1-x^2), -1<x<1}); count({y=sign(x),-1<x<1}); count({y = abs(x), -1 < x < 1}); count({y = 2x + 1, 0 < x < 3})',
  // min and max over a product of ranges.
  'min({0 < x < 3: (x - 1)^2}); max({0 < x < 3: (x - 1)^2}); max(sin(2 pi u)); min({0<x<1, 0<y<1: x + y}); max({0<x<1, 0<y<1: x y})',
  'min(x^2); max({0 < x < 1: (x, 1)}); min({2 < x < 1: x}); max({y = x^2, 0 < x < 2: y}); a = 2; max({0 < x < a: x (a - x)}); min(u v w)',
  // What the reductions refuse, and what is another route's (not ported).
  'stdev(x); median(u); hist(x); total(x^2 + y^2 < 1); total({x < 1: y < 2}); count({(x, y) = (1, 2)}); count({x: 1}); mean(0 < x < 1, 2)',
  'int[0..1] total({0 < u < 1: x u}) dx; int[0..1] mean({0 < u < 1: x + u}) dx; int[0..1] count({0 < u < x}) dx; sum(n=1..3, total(u^n))',
  'count(x^2 + y^2 < 1); count(x^2 < y < 1); count({x^2 + y^2 = 4, x y = 1}); count(sqrt(x) < 1); count({0<x<10, cos(x)=0.3}); count({x^2+y^2+z^2<1})',
  'L = [1, 2, 3]; total(L x); mean(L); count(L < 2); total({L > 1: L}); w0 = within; within = 0 < x < 1; count(within); total({within: x})',
];
