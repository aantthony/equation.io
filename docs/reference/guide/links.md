---
title: Deep links
summary: Open the app with any graph: the link format, and paste-ready examples.
---

Format:

    https://equation.io/g/<equation>;<equation>;...

- Percent-encode each equation (JavaScript `encodeURIComponent`), then
  additionally escape ( ) ! ' * as %28 %29 %21 %27 %2A — chat apps cut
  auto-linked URLs at bare parentheses, silently truncating the graph.
- Encoded equations are joined with `;`, and that literal `;` is only ever the
  row separator (a reader also accepts `%3B` there, since clients re-encode
  it). A `;` that belongs to an equation — inside quoted text, like
  `p[p.city == "a;b"]` or `open("sales;2026.csv")` — is encoded TWICE, as
  `%253B`, so the two can never be confused: the payload encodes the quotes
  too, and a singly-encoded one comes back as a row separator, splitting the
  equation in half.
- Every equation gets its own row and color. Definitions (constants,
  functions, coordinate fields) are rows too — order does not matter.
- `/g/` links unfurl with a rendered preview image (og:image) in chat apps
  and social cards; the image itself is served at
  `https://equation.io/api/og/<same payload>`. An equivalent fragment form,
  `https://equation.io/#<same payload>`, also opens the graph and keeps the
  equations out of server logs, but gets no preview card.

Examples (paste-ready):

- [Parabola](https://equation.io/#y%3Dx%5E2): `y = x^2`
- [Circle](https://equation.io/#x%5E2%2By%5E2%3D4): `x^2 + y^2 = 4`
- [Cubic + tangent line](https://equation.io/#f(x)%3Dx%5E3-2x;g(x)%3Dd%2Fdx%20f(x);a%3D1;y%3Df(x);y%3Df(a)%2Bg(a)(x-a)): `f(x) = x^3 - 2x; g(x) = d/dx f(x); a = 1; y = f(x); y = f(a) + g(a)(x-a)`
- [Slider-controlled wave](https://equation.io/#a%3D2;y%3Dsin(a%20x)%2Fa): `a = 2; y = sin(a x)/a`
- [Fourier series](https://equation.io/#N%20%3D%208;y%20%3D%202%20sum%5Bn%3D1..N%5D%20(-1)%5E(n%2B1)%20sin(n%20x)%2Fn): `N = 8; y = 2 sum[n=1..N] (-1)^(n+1) sin(n x)/n` — drag N for more harmonics
- [Animated ripples](https://equation.io/#sin(x%5E2%2By%5E2-4t)%2F2): `sin(x^2+y^2-4t)/2`
- [3D saddle](https://equation.io/#z%20%3D%20x%5E2%20-%20y%5E2): `z = x^2 - y^2`
- [Torus (parametric 3D)](https://equation.io/#(cos(2pi%20u)(2%2Bcos(2pi%20v))%2C%20sin(2pi%20u)(2%2Bcos(2pi%20v))%2C%20sin(2pi%20v))): `(cos(2pi u)(2+cos(2pi v)), sin(2pi u)(2+cos(2pi v)), sin(2pi v))`
- [Complex dipole field](https://equation.io/#ln(w-2)-ln(w%2B2)): `ln(w-2) - ln(w+2)`
- [Domain coloring](https://equation.io/#domain((w%5E3%20-%201)%2Fw)): `domain((w^3 - 1)/w)`
- [Conformal grid image](https://equation.io/#conformal(w%5E2%2F4)): `conformal(w^2/4)`
- [Mandelbrot set](https://equation.io/#iter(z%5E2%20%2B%20w)): `iter(z^2 + w)`
- [Julia set](https://equation.io/#iter(z%5E2%20-%200.7269%20%2B%200.1889i)): `iter(z^2 - 0.7269 + 0.1889i)`
- [Koch snowflake (recursive function)](https://equation.io/#f(z)%20%3D%20%7Bre(z)%20%3E%3D%201%3A%201%2C%20f(4%20-%203(z%5E6)%5E(1%2F6))%7D;f(x%20i%20-%20%7Cy%7C)%20%3E%3D%200): `f(z) = {re(z) >= 1: 1, f(4 - 3(z^6)^(1/6))}; f(x i - |y|) >= 0` — a tail-recursive function shades where its recursion terminates
- [Vector field](https://equation.io/#(-y%2C%20x)): `(-y, x)` — drawn as animated streamlines
- [Pendulum phase portrait](https://equation.io/#(x'%2C%20y')%20%3D%20(y%2C%20-sin(x))): `(x', y') = (y, -sin(x))`
- [Slope field](https://equation.io/#y'%20%3D%20x%20-%20y): `y' = x - y`
- [Polar cardioid](https://equation.io/#r%3Dsqrt(x%5E2%2By%5E2);theta%3Datan2(y%2Cx);r%3D2(1%2Bcos(theta))): `r = sqrt(x^2+y^2); theta = atan2(y,x); r = 2(1 + cos(theta))`
- [Circle through a draggable point](https://equation.io/#C%20%3D%20(0%2C%200);P%20%3D%20(2%2C%201);circle(C%2C%20%7CP%20-%20C%7C);segment(C%2C%20P)): `C = (0, 0); P = (2, 1); circle(C, |P - C|); segment(C, P)`
- [Triangle: a side and its angles](https://equation.io/#A%20%3D%20(-2%2C%20-1);B%20%3D%20(3%2C%20-0.5);C%20%3D%20(0.5%2C%202.5);polygon(A%2C%20B%2C%20C);distance(A%2C%20B);angle(B%2C%20A%2C%20C)%20180%2Fpi;angle(B%2C%20A%2C%20C)%20%2B%20angle(C%2C%20B%2C%20A)%20%2B%20angle(A%2C%20C%2C%20B)): `A = (-2, -1); B = (3, -0.5); C = (0.5, 2.5); polygon(A, B, C); distance(A, B); angle(B, A, C) 180/pi; angle(B, A, C) + angle(C, B, A) + angle(A, C, B)` — distance() and angle() are numbers, so the bare rows read out "= value" and follow the points as you drag; the angle sum stays π (−π once the triangle turns clockwise: angles are signed)
- [Vector sum (parallelogram rule)](https://equation.io/#A%20%3D%20(3%2C%201);B%20%3D%20(1%2C%202);vector(A);vector(B);vector(A%20%2B%20B);polyline(A%2C%20A%20%2B%20B%2C%20B)): `A = (3, 1); B = (1, 2); vector(A); vector(B); vector(A + B); polyline(A, A + B, B)` — vector() draws arrows (from the origin with one argument), polyline() the open path completing the parallelogram; drag A or B
- [Thébault's theorem (squares on a parallelogram)](https://equation.io/#A%20%3D%20(0%2C%200);B%20%3D%20(4%2C%200.5);D%20%3D%20(1%2C%202.5);C%20%3D%20B%20%2B%20D%20-%20A;polygon(A%2C%20B%2C%20C%2C%20D);square(B%2C%20A);square(C%2C%20B);square(D%2C%20C);square(A%2C%20D);P%20%3D%20midpoint(A%2C%20B)%20-%20perp(B%20-%20A)%2F2;Q%20%3D%20midpoint(B%2C%20C)%20-%20perp(C%20-%20B)%2F2;R%20%3D%20midpoint(C%2C%20D)%20-%20perp(D%20-%20C)%2F2;S%20%3D%20midpoint(D%2C%20A)%20-%20perp(A%20-%20D)%2F2;polygon(P%2C%20Q%2C%20R%2C%20S)): `A = (0, 0); B = (4, 0.5); D = (1, 2.5); C = B + D - A; polygon(A, B, C, D); square(B, A); square(C, B); square(D, C); square(A, D); P = midpoint(A, B) - perp(B - A)/2; …; polygon(P, Q, R, S)` — drag A, B or D; the square centers stay a square
- [Normal probability](https://equation.io/#m%20%3D%201;s%20%3D%200.5;X%20~%20Normal(m%2C%20s);P(0%20%3C%20X%20%3C%202)): `m = 1; s = 0.5; X ~ Normal(m, s); P(0 < X < 2)` — the density with the area between 0 and 2 shaded; drag m or s and the probability follows
- [Swinging pendulum (integrated state)](https://equation.io/#th'%20%3D%20om;om'%20%3D%20-sin(th)%20-%20om%2F8;th(0)%20%3D%203;bob%20%3D%20(sin(th)%2C%20-cos(th));segment((0%2C%200)%2C%20bob);bob): `th' = om; om' = -sin(th) - om/8; th(0) = 3; bob = (sin(th), -cos(th)); segment((0, 0), bob); bob` — th is the angle, om the angular velocity; segment() draws the rod, the named point draws the bob
- [Double pendulum](https://equation.io/#g%20%3D%209.8;L1%20%3D%201;L2%20%3D%201;m1%20%3D%201;m2%20%3D%201;M%20%3D%20(((m1%2Bm2)%20L1%2C%20m2%20L2%20cos(th_1%20-%20th_2))%2C%20(L1%20cos(th_1%20-%20th_2)%2C%20L2));f%20%3D%20(-m2%20L2%20om_2%5E2%20sin(th_1%20-%20th_2)%20-%20(m1%2Bm2)%20g%20sin(th_1)%2C%20L1%20om_1%5E2%20sin(th_1%20-%20th_2)%20-%20g%20sin(th_2));th'%20%3D%20om;om'%20%3D%20solve(M%2C%20f);th(0)%20%3D%20(2.5%2C%202.4);b1%20%3D%20(L1%20sin(th_1)%2C%20-L1%20cos(th_1));b2%20%3D%20b1%20%2B%20(L2%20sin(th_2)%2C%20-L2%20cos(th_2));segment((0%2C%200)%2C%20b1);segment(b1%2C%20b2);b1;b2): `M = (((m1+m2) L1, m2 L2 cos(th_1 - th_2)), (L1 cos(th_1 - th_2), L2)); f = (…); th' = om; om' = solve(M, f); th(0) = (2.5, 2.4); …` — the Lagrangian form M(θ)ω′ = f: th and om are 2-vector states with components th_1, th_2; solve() is Cramer's rule; segment()s between named bob points draw the linkage
- [Orbit (vector gravity)](https://equation.io/#r'%20%3D%20vel;vel'%20%3D%20-9%20r%2F%7Cr%7C%5E3;r(0)%20%3D%20(2%2C%200);vel(0)%20%3D%20(0%2C%201.5);segment((0%2C%200)%2C%20r);r;(0%2C%200)): `r' = vel; vel' = -9 r/|r|^3; r(0) = (2, 0); vel(0) = (0, 1.5); segment((0, 0), r); r; (0, 0)` — vector states with point arithmetic; the bare state name draws as a moving point
- [Rössler attractor (state family + orbit)](https://equation.io/#a%20%3D%200.2;b%20%3D%200.2;c%20%3D%205.7;k%20%3D%204;p'%20%3D%20k%20(-p_2%20-%20p_3%2C%20p_1%20%2B%20a%20p_2%2C%20b%20%2B%20p_3%20(p_1%20-%20c));s%20%3D%202pi%20sort(%5B0..299%5D)%2F300;p(0)%20%3D%20(8cos(s)%2C%208sin(s)%2C%200);p%5B1%5D(10..100);p;camera(-0.9%2C%200.35%2C%2045%2C%20(0%2C%200%2C%207))): `p' = k (-p_2 - p_3, p_1 + a p_2, b + p_3 (p_1 - c)); s = 2pi sort([0..299])/300; p(0) = (8cos(s), 8sin(s), 0); p[1](10..100); p` — a tuple of starting values runs 300 copies of the system, in order; `p[1](10..100)` draws one run's path over that time as the attractor, and `p` the 300 particles flowing along it; k speeds the flow up
- [Matrix phase portrait](https://equation.io/#a%20%3D%20-1;b%20%3D%20-1%2F4;A%20%3D%20((0%2C%201)%2C%20(a%2C%20b));(x'%2C%20y')%20%3D%20A%20(x%2C%20y)): `a = -1; b = -1/4; A = ((0, 1), (a, b)); (x', y') = A (x, y)` — a linear system as its literal matrix, sliders in the entries
- [Poisson: strict versus non-strict](https://equation.io/#m%20%3D%204;X%20~%20Poisson(m);P(X%20%3C%203);P(X%20%3C%3D%203);P(X%20%3D%203)): `m = 4; X ~ Poisson(m); P(X < 3); P(X <= 3); P(X = 3)` — a discrete variable draws its pmf as stems; each P(…) row highlights exactly the stems it counts, so `<` stops at 2, `<=` takes the stem at 3, and `P(X = 3)` is that one stem
- [Two dice](https://equation.io/#X%20~%20DiscreteUniform(1%2C%206);Y%20~%20DiscreteUniform(1%2C%206);S%20%3D%20X%20%2B%20Y;P(S%20%3E%3D%2010);P(X%20%3E%20Y);P(X%20%3E%3D%20Y);E(S)): `X ~ DiscreteUniform(1, 6); Y ~ DiscreteUniform(1, 6); S = X + Y; P(S >= 10); P(X > Y); P(X >= Y); E(S)` — arithmetic over discrete variables is exact: the sum's pmf is the triangle on 2…12, drawn as stems; `P(X > Y)` = 15/36 and `P(X >= Y)` = 21/36 differ by the ties, `P(X = Y)`
- [Central limit theorem](https://equation.io/#X1%20~%20Uniform%280%2C%201%29;X2%20~%20Uniform%280%2C%201%29;X3%20~%20Uniform%280%2C%201%29;X4%20~%20Uniform%280%2C%201%29;S%20%3D%20X1%20%2B%20X2%20%2B%20X3%20%2B%20X4;Z%20~%20Normal%282%2C%20sqrt%281%2F3%29%29;P%28S%20%3E%203%29): `X1 ~ Uniform(0, 1); X2 ~ Uniform(0, 1); X3 ~ Uniform(0, 1); X4 ~ Uniform(0, 1); S = X1 + X2 + X3 + X4; Z ~ Normal(2, sqrt(1/3)); P(S > 3)` — the sum of four uniforms hugs the matching normal
- [Conditional random variable](https://equation.io/#X%20~%20Normal%280%2C%201%29;Y%20%3D%20%7BX%20%3E%200%3A%20X%5E2%2C%201%7D;P%28Y%20%3E%200.5%29;P%28Y%20%3E%20X%29): `X ~ Normal(0, 1); Y = {X > 0: X^2, 1}; P(Y > 0.5); P(Y > X)` — a piecewise transform of X, with probabilities of derived and joint events
