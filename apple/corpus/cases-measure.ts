/**
 * Targeted documents for the numeric route of lib/measure.ts
 * (apple/corpus/analysis.ts runs them with its own): count, total, mean, min
 * and max over a region, an implicit curve or a set of points — the quadtree
 * over interval enclosures (lib/certify.ts), marching squares, certified root
 * counting — and the error each set it refuses reports. One concern each,
 * rows separated as the examples' are.
 */
import { setMeasureHardStop } from '../../lib/measure.ts';

// The site also stops a measurement on the wall clock, which a slow recording
// would turn into an error: what is recorded comes from the work budget alone.
setMeasureHardStop(Infinity);

export const MEASURE_CASES: string[] = [
  // Regions: areas, with the digits the bounds vouch for.
  'count(x^2 + y^2 < 1); count(x^2 < y < 1); count({x^2+y^2<1, x>0, y>0}); count({y > x^2, y < 1}); count({x > y^2, x < 4})',
  'count((x^2+y^2)^2 < x^2-y^2); count((x-1000)^2+y^2<1); count(x^2 + y^2 <= 4); count(x^2/4 + y^2 < 1); count(abs(x) + abs(y) < 1)',
  'count(sqrt(1 - x^2) > y > 0); count({0 < x < pi, 0 < y < sin(x)}); count({0 < x < 2, 0 < y < exp(-x)}); count(x^4 + y^4 < 1)',
  'a = 2; count(x^2 + y^2 < a); count({0 < x < a, 0 < y < x^2}); count({x^2 + y^2 < a, y > 0}); b = 0.5; count(x^2 + b y^2 < 1)',
  'count({x^2 + y^2 < 1, x^2 + y^2 > 0.25}); count({abs(x) < 1, abs(y) < 1}); count(max(abs(x), abs(y)) < 1); count(x^2 + y^2 < 0)',
  'count(x^2 + y^2 <= 0); count(x^2 + y^2 < -1); count({0 < x < 1, y^2 < x}); count({x^2 + y^2 < 1, y > x}); count({-1 < x < 1, 0 < y < cosh(x)})',
  // On a line: lengths of the part of a range a comparison keeps.
  'count(sqrt(x) < 1); count(ln(x) < 0); count(x^0.5 < 1); count(acos(x) < 1); count({ln(x) < 0, -5 < x < 5}); count(x^2 < 2)',
  'count({0 < x < 10, sin(x) > 0}); count({-1 < x < 1, x^3 < x}); count(exp(x) < 2); count({0 < x < 5, floor(x) < 2}); count(abs(x - 1) < 3)',
  'count({0<x<1, 2<x<3}); count({x^2 < 4, x > 0}); a = 3; count({x^2 < a}); count(x^2 + 1 < 0); count({0 < x < 4, tan(x) > 0})',
  // Totals and means over a region; a value unbounded at a point.
  'total({x^2 + y^2 < 1: x^2}); mean({x^2 + y^2 < 1: x^2 + y^2}); total({sqrt(1 - x^2) > y > 0: y}); mean({x^2 < y < 1: y})',
  'total({x^2+y^2<1: 1/sqrt(x^2+y^2)}); total({x^2+y^2<1: 1/(x^2+y^2)}); total({x^2+y^2<1: x + 0.0000001}); total({x^2+y^2<1: x})',
  'total({x^2 + y^2 < 1: (x, y)}); mean({x^2 < y < 1: (x, y)}); mean({y > x^2, y < 1: (x, y)}); total({x^2 < 2: x^2}); mean({sqrt(x) < 1: x})',
  'mean({x^2 + y^2 < 1, x > 0: x}); total({abs(x) + abs(y) < 1: exp(x)}); total({x^2 + y^2 < 4: sin(x)^2}); mean({ln(x) < 0: x^2})',
  'total(x^2 < 2); mean(sqrt(x) < 1); total(x^2 + y^2 < 1); mean(x^2 < y < 1); min(x^2 + y^2 < 1); max({x^2 + y^2 < 1: x})',
  // Implicit curves: lengths, and what is integrated along them.
  'count({x^2 + y^2 = 1}); count({x^2 + y^2 = 1, y > 0}); count((x^2+y^2)^2 = x^2-y^2); count({y = x^2, y < 1}); count({x > 0, y = x^2, y < 1})',
  'count({x^2/4 + y^2 = 1}); total({x^2 + y^2 = 1: x^2}); mean({x^2 + y^2 = 1, y > 0: y}); count({x^2 + y^2 = 4, x > 1}); count({x^4 + y^4 = 1})',
  'count({y = sqrt(1-x^2)}); count({y=sign(x),-1<x<1}); count({y = abs(x), -1 < x < 1, y < 0.5}); a = 2; count({x^2 + y^2 = a^2})',
  'count({y = sin(x), 0 < x < pi, y > 0.5}); total({x^2 + y^2 = 1: (x, y)}); mean({x^2 + y^2 = 1, x > 0: (x, y)}); count({x y = 1, 0.5 < x < 2})',
  // Points on a line: a polynomial's roots exactly, others certified by monotone pieces.
  'count({x^2 = 2}); count({x^3 - x = 0}); count({x^2 = 2, x > 0}); total({x^3 - x = 0: x^2}); mean({x^2 = 4: x}); min({x^3 - x = 0: x}); max({x^2 = 2})',
  'count({0<x<10, cos(x)=0.3}); count({0<x<10, sin(x)=1}); count({0<x<100, sin(x^2)=0}); count(sqrt(x) = 0.5); count({-1000<x<1000, sin(x)=0})',
  'count({-10<x<10, sin(1/x)=0}); count({-1<x<1, x sin(1/x)=0}); count({0<x<1, sin(10000x)=0}); count({0 < x < 5, sin(x)^2 + cos(x)^2 = 1})',
  'total({0<x<10, cos(x)=0.3: x}); mean({0<x<10, cos(x)=0.3: x}); max({0<x<10, cos(x)=0.3: x}); min({0<x<10, cos(x)=0.3}); count({exp(x) = 2})',
  'count({0 <= x <= 0, x = 0}); count({2 < x < 1, x^2 = 2}); count({x^2 = -1}); max({x^2 = -1}); mean({x^2 = -1: x}); count({0 < x < 3, floor(x) = 1})',
  'a = 0.5; count({0 < x < 20, sin(x) = a}); total({x^2 = a: x^2}); count({x^2 = a, x >= 0}); count({0 < x < 10, erf(x) = a}); count({sin(x) = 0})',
  // Points in the plane: each proved unique by the Krawczyk test.
  'count({x^2 + y^2 = 4, x y = 1}); count({x^5-x=y, y^5-y=x}); count({x^2 + y^2 = 1, y = x}); total({x^2 + y^2 = 4, x y = 1: x^2 + y^2})',
  'count({x^2 + y^2 = 1, y = x^2}); max({x^2 + y^2 = 4, x y = 1: x}); min({x^2 + y^2 = 4, x y = 1: y}); mean({x^2 + y^2 = 1, y = x: (x, y)})',
  'count({x^2 + y^2 = 4, x y = 1, x > 0}); count({-3 < x < 3, -3 < y < 3, sin(x) = y, cos(y) = x}); count({x + y = 1, x - y = 3}); max({x + y = 1, x - y = 3: (x, y)})',
  'count({x = 1, y = 2, x + y = 3}); count({x^2 + y^2 = 1, x^2 + y^2 = 1}); count({0 < x < 1, 0 < y < 1, x = y, y = x^2})',
  // Unbounded sets, and sets too intricate to bound within the budget.
  'count(x > 0); count({x > 0, y > 0}); count(y > x^2); count(x y < 1); total({y > x^2: x}); mean(x^2 + y^2 > 1); count({y = x})',
  'count({-1000<x<1000,-1000<y<1000,sin(x)sin(y)>0}); count({x^2+y^2<1, sin(1000 x y)>0}); count({-10000<x<10000, abs(sin(x))<0.001})',
  'count({-100000<x<100000, sin(x)=0}); count({-1000<x<1000,-1000<y<1000, sin(x y)>0, cos(x+y)>0}); count({y = sin(1/x), 0 < x < 1})',
  // What a filter must be: space, sliders, t, parameters, values.
  'count({x^2+y^2+z^2<1}); count({x^2 + y^2 < z}); count(x^2 + y^2 < q); count(x^2 + y^2 < t); f(a) = count({x^2 < a}); f(2); y = count({x^2 < 2}) x',
  'g(a) = count({x^2 + y^2 < a}); g(1); count({x^2 + y^2 < 1: 2}); total({x^2 + y^2 < 1}); mean({x^2 + y^2 < 1}); count({u^2 + v^2 < 1})',
  'count({u < v}); total({u < v: u}); mean({u^2 < v: (u, v)}); count({u^2 = 0.25}); count({u = v}); count({0 < x < 1, u < x}); y = count({0<v<1, v<x})',
  'r = count(x^2 + y^2 < 1); r; r / pi; A = count(x^2 < y < 1); 3 A; (count(x^2 + y^2 < 1), 1); y = x count({x^2 + y^2 = 1})',
];
