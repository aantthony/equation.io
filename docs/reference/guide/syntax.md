---
title: Expression syntax
summary: Operators, functions, piecewise cases, derivatives, integrals, sums, lists, data columns, notes and colors.
---

- Operators: `+ - * / ^`, parentheses, unary minus. Multiplication is
  implicit: `2x`, `x y`, `2cos(t)`, `a(x-1)` all work. After a `/`, spacing
  groups: factors written touching stay in the divisor (`1/2pi` is 1/(2π),
  `x^2/2s^2` is x²/(2s²), `1/x(x+1)` is 1/(x(x+1))), while a space ends it
  (`g/L sin(th)` is (g/L)·sin(th), `1/2 m v^2` is m v²/2, `(y - b)/h (x - a)`
  is a slope times (x - a)). `·` and `×` multiply
  numbers too, and between two vectors are the dot and cross product (see
  Vector calculus); `⊗` and `∧` are the outer and wedge products (see
  Tensors). All four bind like `*`.
- Absolute value bars: `|x|`, including nested/multiplied forms like `2|x-1|`.
- Unicode: Greek letters are ordinary names (`θ = 1` makes a θ slider; `Δx`
  is a name like `dx`), superscript digits are exponents (`x³` is `x^3`,
  `x⁻²` is `x^(-2)`), and subscript digits are the `_` subscript syntax in
  its unicode spelling — `T₀` IS `T_0`, so `r₁` reads a vector state's `r_1`
  component and `a₃` a sequence's third term. A single name or number in
  braces is the same subscript: `T_{c}` is `T_c`, `a_{10}` is `a_10`.
  `·`, `⋅`, `×`, `÷`, `−`, `≤`,
  `≥`, `≠` mean their ASCII counterparts (`⊗` is `outer(a, b)`, `∧` is
  `wedge(a, b)`; the editor types them from `\otimes` and `\wedge`). π never joins a longer name,
  so `2πr` is 2·π·r. In the editor, typing `\pi`, `\theta`, `\nabla`, …
  inserts the symbol itself, and a `\` before any built-in function name
  simply drops (`\sin(x)` → `sin(x)`, `\trail` → `trail`), so `\` also works
  as a function search.
- Constants: `pi`, `e` (π also parses directly; τ and `tau` are ordinary
  names, free to define), and the unit
  vectors `e_x`, `e_y`, `e_z` = `(1,0,0)`, `(0,1,0)`, `(0,0,1)` (always 3D,
  so a row using one is a 3D scene; defining `e_x` yourself replaces it).
  Imaginary unit `i` in complex expressions.
- Functions: sin cos tan asin acos atan atan2(y,x) sinh cosh tanh sech coth
  asinh acosh atanh sqrt abs exp ln (natural) log (base 10) log2 floor ceil round
  min max mod sign fract sinc gamma factorial, complex helpers re im arg conj,
  and point helpers dot cross perp midpoint unit. Also `erf(x)`,
  `normalpdf(x, mean, sd)` and `normalcdf(x, mean, sd)`; `gcd(a, b)`, the
  greatest common divisor of whole numbers (other arguments round to the
  nearest one), so `1/gcd(floor(x), floor(y))` is 1 on the coprime cells of
  the grid; and `isprime(n)`, 1 for a prime and 0 otherwise
  (`a_n = isprime(n)`), which gives no value past 2048² − 1 rather than
  guess. Vector calculus has `grad`, `div`, `curl`, `laplacian`, `jacobian`
  and `hessian`, and the geometry of a curve `curvature`, `torsion`,
  `osculating` and `frame` (all below).
  Function names are
  case-insensitive: `Sin(x)`, `SQRT(x)` and `sin(x)` are the same call. Always
  use parentheses for arguments — write `sin(x)`, not `sin x`.
- Factorial: postfix `!` — `5!` is 120, `y = x!` plots Γ(x+1), `2^3!` is 2^6.
  Non-integers use the Gamma function; negative integers are undefined.
- Piecewise: `{x < 0: -x, x >= 0: x^2}` — `cond: value` cases tried in order,
  with an optional last bare value as the default (`{0 < x < 1: 1, 0}`).
  Conditions are inequalities and may chain. With no default the value is
  undefined wherever no case holds and nothing is drawn there, which makes
  one case a domain restriction: `y = {0 < x < 2: x^2}` plots the parabola
  on (0, 2) only. It works in any row kind — `x^2 + y^2 = {x > 0: 16}` is a
  half circle, `(2cos(u), {sin(u) > 0: 2sin(u)})` cuts a parametric curve.
  A bare condition is a case worth 1, as in Desmos: `{x > 0, 5}` is
  `{x > 0: 1, 5}`. Values may be complex (`{x > 0: w, conj(w)}`); the
  conditions themselves compare real values (`re(w) > 0`, `|w| < 1`).
  A condition can be named and reused: `r = x^2 + y^2 + z^2`;
  `within = r < 16`; `x + y = {within: 1}` — the name reads as the
  inequality it stands for, in a function body too (its x is the plane's,
  not the function's parameter), and filters reductions: `count(within)`,
  `mean({within: x})` (in a function body, a filter whose condition reads a
  parameter's name is an error: rename the parameter). The definition draws nothing; a row of just the
  name draws what the inequality would; arithmetic on it is an error. A
  function may return a condition too: `inside(p) = p < 2`;
  `y = {inside(x): x^2}`. A name as a bare condition needs a `cond: value`
  part beside it, `{within, x > 0: 1}`: `{within, 5}` is a tuple, so write
  `{within: 1, 5}`.
- Vector calculus: these operators expand symbolically like d/dx, so
  sliders and t work inside them.
  - `grad(f)` is the tuple (∂f/∂x, ∂f/∂y), plus ∂f/∂z when f uses z:
    `grad(x^2 - y^2)` plots as a vector field.
  - `div(F)` is ∂F₁/∂x + ∂F₂/∂y (+ ∂F₃/∂z), a scalar field:
    `div((x y, y^2))`.
  - `curl(F)` of a 3D field is a vector field: `curl((y z, -x z, 0))`. Of a
    plane field it is the scalar ∂F₂/∂x − ∂F₁/∂y: `curl((-y, x))` is 2.
  - `laplacian(f)` is div(grad(f)), for a scalar f: `laplacian(x^2 + y^2)`
    is 4.
  - `jacobian(F)` is the matrix of partials, row i the gradient of F's
    component i (2 components: over x, y; 3: over x, y, z), and `hessian(f)`
    the matrix of second partials of a scalar f. A 2×2 one in x and y draws
    as a matrix field: `jacobian((x^2 - y^2, 2 x y))` is all circles, the
    mark of a conformal map.
  - With ∇ (in the editor, type `\nabla`): `∇f` is grad(f), `∇·F` is div(F),
    `∇×F` is curl(F), and `∇²f` (or `∇^2 f`) is laplacian(f). ∇ takes the
    rest of the product, as d/dx does: `∇ x^2 y` and `∇f(x, y)`.
  - Names work as arguments. With `f(x, y) = x^2 - y^2`, `grad(f)` and `∇f`
    mean grad(f(x, y)). With a field `r = sqrt(x^2 + y^2)`, `grad(1/r)`
    differentiates through r (so does `d/dx r`). With a named vector
    `F = (-y, x)`, `curl(F)` and `∇×F` work.
  - The Laplacian of a vector field is not supported. grad of a vector and
    div or curl of a scalar are errors.
  - Between two vectors, `A · B` (also `⋅`) is dot(A, B) and `A × B` is
    cross(A, B). `*` between vectors is an error, since it could mean either.
    `·` binds like `*`, so `∇f · (1, 1)/sqrt(2)` is a directional
    derivative.
- Fourier analysis: `fourier(signal)` draws a one-sided amplitude spectrum
  as points (frequency, amplitude). The signal is either a real expression
  over one interval, which is its variable and its period —
  `s = interval(0, 1); fourier(sin(2pi s))`, or `fourier(f(s))` for a
  function f — or ordered, equally spaced real samples
  (`fourier((0, 1, 0, -1))`). A signal in x (`fourier(sin(2pi x))`) or a
  bare function name (`fourier(f)`) is an error that shows the interval
  form: nothing binds x for you. A bracket list is an unordered multiset;
  give samples as a tuple. For CSV row order, use
  `S = sort(data.signal, data.row); fourier(S)`; rows must be equally spaced.
  `sort(data.signal)` sorts by VALUE and changes the signal.
  - The interval interval(lo, hi) is one period [lo, hi): frequency is in
    cycles per unit of it, bins k/(hi-lo), from DC through Nyquist.
    Amplitude is the sinusoid's peak amplitude; DC is the absolute mean,
    and DC and an even-length Nyquist bin are not doubled. No window is
    applied. A nonperiodic endpoint mismatch causes spectral leakage.
  - A signal over an interval uses 256 equally spaced samples; an optional
    second argument sets a whole sample count from 2 to 4096:
    `s = interval(0, 2pi); fourier(sin(3s), 512)`. The endpoint hi is
    excluded. Samples span [0, 1), or the interval given after them:
    `fourier(S, interval(0, 10))`; they use their own length (2–4096), so
    give no sample count. Odd lengths and non-powers of two work.
  - `reconstruct(signal, N)` returns a periodic real expression in x:
    its signed mean plus frequency bins 1 through N, with phase preserved
    and the signal's interval as the period. Draw it with
    `y = reconstruct(f(s), N)`. N is a whole number from 0 to
    min(128, floor(sample count/2)); N = 0 is the mean. Use a bounded
    slider such as `N = clamp(round(5), 0, 48)` to add harmonics.
    The optional sample count, or a tuple's interval, follows N:
    `y = reconstruct(f(s), N, 512)`. Defaults match fourier.
    At full available N, the reconstruction interpolates the samples;
    discontinuities can exhibit Gibbs overshoot.
  - Coefficients are numeric approximations computed when the document
    changes. Static sliders in signals or interval bounds recompute them;
    signals cannot depend on t or simulation states. Missing/nonfinite
    samples are errors, rather than removed (removing them would change
    spacing). CSV data stays device-local in shared links, like other data
    plots.
  - Name a spectrum to draw stems with existing geometry:
    `S = fourier(f(s)); segment((S.x, 0), S); S`. Use split views with a shared
    x axis for the original and reconstruction; the spectrum has its own
    frequency axis. The Fourier analysis examples demonstrate all three.
- Curves: the differential geometry of a parametric curve in u — a tuple
  `(f(u), g(u))` or `(f(u), g(u), h(u))`, a named one `C = (…)`, or a
  function of one parameter `f(s) = (…)`. These expand symbolically like
  d/dx, so sliders and t work inside them.
  - `curvature(C, u0)` reads out κ at u = u0. In the plane it is signed,
    positive where the curve turns left (counterclockwise):
    `curvature((u, u^2), 0)` is 2, and `curvature((2cos(u), -2sin(u)), 0)`
    is −0.5. In space it is |r′ × r″|/|r′|³ ≥ 0.
  - `torsion(C, u0)` of a space curve: how fast it twists out of its
    osculating plane. The helix `C = (2cos(u), 2sin(u), u)` has curvature
    0.4 and torsion 0.2 everywhere. A plane curve has none (an error).
  - Without u0 both are functions of u, for use in other rows:
    `(u, curvature(C))` plots κ against u, and `k(u) = curvature(C, u)`
    names it. Alone on a row (or `1/curvature(C)`) they are an error that
    says so (a row in u alone would draw the density of its values). A
    list u0 reads each point: `curvature(C, [0.2, 0.4])`.
  - `osculating(C, u0)` draws the osculating circle at u = u0: through the
    point, radius 1/|κ|, centred on the concave side. A space curve's lies in
    its osculating plane. Where κ = 0 (an inflection) it is the tangent line,
    and near one a large circle that flattens into it. A list u0 draws one
    circle per point.
  - `frame(C, u0)` draws the Frenet frame at u = u0 as unit arrows from the
    point: T (tangent), N and, in space, B = T × N; one point at a time. In
    the plane N is T turned left (with κ signed, κN points toward the centre
    of curvature); in space N points toward the centre, and N and B are
    undefined where κ = 0. With t for u0 it rides along; a `C` row draws u from 0 to 1,
    so trace the curve once over that and wrap t into it:
    `C = (2cos(2pi u), sin(2pi u))`, `C`, `frame(C, t/10)`,
    `osculating(C, t/10)` (u0 past 1 is the same point again).
- Surfaces: the curvature of a parametric surface in u and v — a tuple
  `(f(u, v), g(u, v), h(u, v))`, a named one `S = (…)`, or a function of two
  parameters. Expanded symbolically from the first and second fundamental
  forms like `curvature(C)`, so sliders and t work inside them (central
  differences stand in where a part cannot be differentiated: floor, gamma).
  - `gaussian(S)` is the Gaussian curvature K = (LN − M²)/(EG − F²), a
    function of u and v; `gaussian(S, u0, v0)` (or `gaussian(S, (u0, v0))`,
    `gaussian(S, P)`) reads it at a point. The sphere of radius R has
    K = 1/R² everywhere; the saddle `(u, v, u^2 - v^2)` has −4 at (0, 0); a
    torus `((3 + cos(v)) cos(u), (3 + cos(v)) sin(u), sin(v))` has
    cos(v)/(3 + cos(v)): positive on the outside, negative round the hole.
  - `meancurvature(S)` is the mean curvature H = (EN − 2FM + GL)/(2(EG − F²)),
    with the normal ∂S/∂u × ∂S/∂v: H is negative where the surface bends away
    from that normal, so the sphere `(R cos(v) cos(u), R cos(v) sin(u),
    R sin(v))`, whose normal points out, has H = −1/R (swap u and v and it is
    +1/R). Minimal surfaces (catenoid, helicoid, Enneper's) have H = 0.
  - Alone on a row, `gaussian(S)` (or `meancurvature(S)`) draws S coloured
    by it on a diverging scale: toward the row's colour where it is
    positive, its complement where negative, grey at 0, scaled to the
    surface's typical size of it (so read values with the point form). With
    `u = interval(0, 2pi)` and `v = interval(0, 2pi)` above, the torus is
    `S = ((3 + cos(v)) cos(u), (3 + cos(v)) sin(u), sin(v))` and `gaussian(S)`.
    Elsewhere they are numbers in u and v: `(u, v, gaussian(S))` is K as a
    height over the parameter square.
  - On a panel drawn on a surface (an `on(…)` row), `gaussian(x, y)` and
    `meancurvature(x, y)` are K and H of that surface in the panel's x and
    y: a scalar field painted on it on the same diverging scale, read on
    hover; `gaussian(P)` or `gaussian(0.5, 1)` is the number at a point.
  - `geodesic(S, (u0, v0), (du, dv))` draws the geodesic of S — the
    straightest curve on it — from the point at (u0, v0) in the direction
    (du, dv), given in u and v. It is integrated in the background as it is
    drawn (the last one stays on screen until the next is ready), at unit
    speed along the surface, from the geodesic equations with the
    Christoffel symbols of S's metric (expanded symbolically). A fourth
    argument is its length on the surface (`geodesic(S, P, (1, 0), 5)`;
    negative runs backwards); without it, it runs twice the size of the
    surface's bounding box. It stops where it leaves u's and v's ranges
    (0..1, or their intervals) — except across a range the surface repeats
    over, like a torus's angles or a sphere's longitude, where it runs on —
    and where the metric degenerates (a sphere's pole, a cone's apex). The
    start, direction and length may use sliders, t and named points, so
    dragging P moves a `geodesic(S, P, …)`; a list draws a fan:
    `a = [0..11] pi/6` and `geodesic(S, (0, 0), (cos(a), sin(a)))`. It must be
    the whole row. A fan of very long geodesics shares a fixed amount of
    work, so its members may end short of the length asked for; the row's
    note then says so ("cut short at L ≈ 472 of 1000"). On a sphere
    they are great circles, on a cylinder helices,
    on a plane straight lines; on a surface of revolution r cos ψ is constant
    along one (Clairaut).
  - On a panel drawn on a surface, `geodesic((x0, y0), (dx, dy))` (or
    `geodesic(P, (dx, dy), L)`) draws on that surface, in the panel's x and
    y, and runs on across x and y's ranges where the surface repeats. Drag P
    along the surface to move it.
- Metrics: a row `ds^2 = …` (or `ds² = …`) gives a plane panel its own
  metric, a quadratic form in differentials `d<name>`, and `geodesic` and
  `lightray` rows in that panel follow it. Only in that row is `dr` the
  differential of r; elsewhere names starting with d keep their meaning.
  - The differentials are those of the panel's two coordinates — `dx` and
    `dy`, or of two coordinates defined from x and y (`r = sqrt(x^2 + y^2)`,
    `phi = atan2(y, x)`) — and of at most one more, a time no component
    depends on. Coefficients are any expressions in x, y, those coordinates
    and sliders; cross terms (`2 a dt dphi`) are allowed:
    `ds^2 = (dx^2 + dy^2)/y^2` (the Poincaré half-plane) or `M = 1`,
    `ds^2 = -(1 - 2M/r) dt^2 + dr^2/(1 - 2M/r) + r^2 dphi^2` (Schwarzschild,
    in its equatorial plane). Define r and phi first: `dr` and `dphi` with
    no such coordinates are refused. Inside ds² `dt` (or `dτ`, `dtau`) is
    a differential even beside a slider named dt, dτ or τ; another defined
    name like `dw` keeps its value there. A component using t (or τ, when
    dτ is the time) is refused
    (time-dependent metrics are not supported yet), as is one using the
    extra coordinate, a missing differential of the panel's coordinates, two
    extra coordinates, `dpi` or `de` (constants are no coordinates), a term
    not quadratic in the differentials, and a metric with no usable
    signature (checked over scales from 0.001 to 100 000 round the origin):
    with no extra coordinate it must be positive definite (a plane) or
    Lorentzian, det g < 0 (a spacetime diagram, below), somewhere, and may
    be both (mixed signature, read out as such: each geodesic takes the
    kind at its start and stops where it changes, the row's note saying
    "stops where the metric stops being Lorentzian (a plane beyond)" or
    the reverse; negative for every
    direction is refused); with one, the panel's
    coordinates are space and det g < 0, so the other is a time.
    One ds² row a panel; not on an `on(…)` panel or one whose `view(…)` maps
    its axes. The row reads out its signature and coordinates and draws
    nothing.
  - Points and directions are in the panel's x and y, like any point (named
    points drag); the metric is pulled back to x and y through the
    coordinates' Jacobian, and the curve is drawn there.
  - With no time coordinate, `geodesic(P, (dx, dy))` runs at unit speed; a
    third argument is its length in the metric. Poincaré's geodesics are
    half-circles on y = 0: from (0, 1) along (1, 0), the unit circle.
  - In a spacetime, `geodesic(P, (vx, vy))` is a massive particle: (vx, vy)
    is its coordinate velocity d(x, y)/dt, so its size matters — round
    Schwarzschild with M = 1, `geodesic((10, 0), (0, sqrt(1/10)))` is a
    circular orbit — and the length is proper time. Faster than light at P
    draws nothing and the row's note says how fast it may go ("faster than
    light here: at most ≈ 0.894 in this direction"). A spinning hole works
    too (equatorial Kerr, with a `dt dphi` term): geodesics run on into the
    ergoregion, where g_tt > 0 and nothing can stand still, down to the
    horizon.
  - `lightray(P, (dx, dy))` is a light ray: only the direction matters, and
    its length runs in the affine parameter that moves like t at the start.
    `b = [-6..6]` and `lightray((-30, b), (1, 0))` bend round a black hole;
    those with |b| < 3√3 M fall in.
  - Without a length they run until they leave a box round the window (four
    times its size, kept through small pans and zooms, and grown to take in
    the start, so a ray sent in from far off still crosses a zoomed window)
    or have drawn as far as that is across. They stop where the metric
    degenerates or blows up — a horizon (r = 2M), an ideal boundary
    (y = 0) — and lists fan out as for surfaces. Orbits precess as they
    should: 2π((1 − 6M/r)^−½ − 1) an orbit near a circle of radius r.
  - A spacetime diagram: with no third coordinate, a Lorentzian metric in
    the panel's own two (one minus sign) makes the panel space against time,
    and the metric decides which is which: `ds^2 = -dy^2 + dx^2`
    (Minkowski, y up as time), `g = 0.1` and `ds^2 = -(1 + 2 g x) dy^2 +
    dx^2` (a uniform field: a plane where 1 + 2 g x < 0), `M = 1` and
    `ds^2 = -(1 - 2M/x) dy^2 + dx^2/(1 - 2M/x)` (Schwarzschild's r and t
    as x and y), `ds^2 = -(1 - 2M/x) dy^2 + 2 dy dx` (ingoing
    Eddington–Finkelstein, r and v). Declared coordinates work as above.
    `geodesic(P, (vx, vy))` is a particle whose coordinate direction is
    (vx, vy), normalised to proper time (the length); it must point inside
    the light cone, else the note says "v must point inside the light cone
    here". `lightray(P, (dx, dy))` runs along the null direction nearest
    (dx, dy) by angle in x and y — one of four, the two null lines either
    way, so `(1, 1)` and `(-1, 1)` are the two future rays in Minkowski
    and any direction picks one wherever P is dragged; its length is an
    affine parameter, distance in the panel at the start. They stop where
    the metric degenerates or blows up, or the coordinates freeze (a
    particle falling toward r = 2M in Schwarzschild's t only creeps up the
    line x = 2M; in Eddington–Finkelstein it crosses and stops at r → 0).
  - `gaussian(x, y)` alone on a row is the metric's Gaussian curvature K,
    painted over the panel on the diverging scale of a surface's (row colour
    where K > 0, its complement where K < 0, nothing at 0), scaled to the
    90th percentile of |K| over the view (but at least a thousandth of its
    largest), and read on hover where no curve or point is near. Where K is
    only rounding (a flat metric) nothing is painted and hover reads 0.
    `-gaussian(x, y)` and `c gaussian(x, y)` (c a number or slider) are
    shaded to their own size too. `gaussian(P)` or `gaussian(0.3, 2)` is the
    number at a point. K comes from the metric alone (Brioschi's formula, from g and its
    first and second derivatives), taken in the coordinates it is written
    in — r and phi, say — and then written in x and y (K is a scalar). The
    Poincaré half-plane `(dx^2 + dy^2)/y^2` and disk
    `4(dx^2 + dy^2)/(1 - x^2 - y^2)^2` have K = −1 everywhere, the
    stereographic sphere `4(dx^2 + dy^2)/(1 + x^2 + y^2)^2` +1,
    `dr^2 + sin(r)^2 dphi^2` +1, `dr^2 + r^2 dphi^2` 0 (painted nothing).
    `meancurvature` needs a surface in space and is refused here.
  - With a time, `gaussian(x, y)` is the curvature of space at one instant:
    K of the slice t = constant, whose metric is g's spatial block (cross
    terms like dt dphi do not reach it). Schwarzschild's slice
    `dr^2/(1 - 2M/r) + r^2 dphi^2` is Flamm's paraboloid's: K = −M/r³. It
    is left unpainted where the slice is not space (inside the horizon).
  - On a spacetime diagram (a Lorentzian ds² in x and y alone),
    `gaussian(x, y)` is K = R/2, half the scalar curvature (Brioschi's K is
    R₁₂₁₂/det g for any signature): `-(1 - 2M/x) dy^2 + dx^2/(1 - 2M/x)`
    has K = 2M/r³, Rindler `-x^2 dy^2 + dx^2` 0, de Sitter's static patch
    `-(1 - x^2/L^2) dy^2 + dx^2/(1 - x^2/L^2)` +1/L², anti-de Sitter's
    −1/L². It is painted where the metric is Lorentzian (and, of mixed
    signature, where it is positive definite: the plane's K there), and
    left out where it degenerates.
- Light cones: `lightcones` alone on a row draws the light cones of its
  panel's ds² metric on a lattice over the window (spaced like a tensor
  field's glyphs, a power of two near 56 px, and fixed in the plane as it
  pans); `lightcone(P)` draws one at a point (P drags; a list of points
  draws one each). Refused with no metric, or a Riemannian one.
  - On a spacetime diagram each is the two null directions, a filled wedge
    opening to the future and two strokes to the past, a fixed size on the
    screen, only where the metric is Lorentzian. The future is the half
    along which the time coordinate increases, and the time coordinate is
    the one the row writes as such: that of the first term (left to right)
    that is a squared differential carrying a minus sign — subtracted, or
    with a unary minus or negative number among its factors; a sum factor
    holding differentials is split into its terms (`s (-dx^2 + dy^2)`,
    `(dy^2 - dx^2)/x^2`), and `dx dx` and `(dx/c)^2` are squares, while a
    sign inside a factor that is a plain value, like (1 - 2M/x), does not
    count. With no such term, the coordinate whose own d²-term is negative
    wherever the metric is Lorentzian, else y. So
    `-(1 - 2M/x) dy^2 + dx^2/(1 - 2M/x)` and `dx^2 - f dy^2` have time y,
    `-dx^2 + dy^2` and `-(1 - 2M/y) dx^2 + 2 dx dy` have time x, and
    `2 dx dy` alone has y; it never changes as sliders move. That is
    continuous wherever that coordinate is a time, inside a horizon too.
    Where the cone lies across it exactly (inside Schwarzschild's horizon in
    r and t, where r is the time) the future is the other coordinate
    decreasing: smaller r. Round a horizon in
    Schwarzschild's r and t the cones close up (half-angle
    atan(1 − 2M/r)); in Eddington–Finkelstein they tip over through it.
  - With a time besides the panel's coordinates (equatorial Schwarzschild
    or Kerr in r and phi) each is the light-speed ellipse: the coordinate
    velocities v = d(x, y)/dt light can have, g_tt + 2 g_ti vⁱ + g_ij vⁱ vʲ
    = 0, drawn round a dot at its point at one scale for the whole panel
    (a power of two, so that the median ellipse in view reaches about a
    third of a lattice cell): each is where light from its dot gets in the
    same short time. Flat space gives circles centred on their dots; round
    Schwarzschild at r, 1 − 2M/r across and √(1 − 2M/r) round, shrinking
    toward the horizon (nothing inside it); round a spinning hole they are
    dragged in its sense of spin, and inside the ergoregion (g_tt > 0) an
    ellipse no longer holds its own dot. A lattice ellipse wider than its
    cell is left out, and so is one cut off from the outside by a horizon
    (inside a spinning hole's inner horizon, where x and y are space
    again) — unless every way out meets a horizon (de Sitter's cosmological
    one), when none is. A lone `lightcone(P)` with no ellipse in view on the lattice is
    drawn at its own such scale.
- Tidal forces: `tidal` alone on a row draws what the panel's ds² metric
  does to a small cloud of free particles held at rest, on the same lattice
  as light cones; `tidal(P)` draws it at a point (P drags; a list of points
  draws one each). The observer is static, moving along the time
  coordinate (u = ∂t/√(−g_tt)), and its tidal tensor E_ij = R_iαjβ u^α u^β
  gives the separation ξ of two nearby particles ξ'' = −E ξ. Each glyph is
  two crossed bars along E's eigenvectors (in the panel's x and y), half as
  long as |λ| times one scale for the panel (a power of two, so the median
  glyph in view reaches about a fifth of a lattice cell; kept as you pan
  while the median allows, taken afresh when a slider moves), with
  arrowheads pointing out where it stretches (λ < 0) and in where it
  squeezes (λ > 0). One stronger than its cell
  allows is shrunk whole, keeping its shape. Round Schwarzschild
  (`-(1 - 2M/r) dt^2 + dr^2/(1 - 2M/r) + r^2 dphi^2`) λ = −2M/r³ along the
  radius and +M/r³ round, exactly; Reissner–Nordström −2M/r³ + 3Q²/r⁴ and
  M/r³ − Q²/r⁴; de Sitter's static patch −1/L² both ways; flat space draws
  nothing. There is no glyph where no observer can stand still (g_tt ≥ 0:
  inside a horizon, or a spinning hole's ergoregion, where g_tφ drags
  everything round), nor behind a horizon (as for light cones). Cross terms
  are taken into account: space is h_ij = g_ij − g_ti g_tj/g_tt. Riemann
  comes from symbolic first and second derivatives of g in the coordinates
  it is written in (r and phi), so a metric flat in polar coordinates is
  exactly flat.
  - On a spacetime diagram (a Lorentzian ds² in x and y alone) there is one
    direction of space and one bar: λ = −K = −R/2 for any observer, along
    the direction orthogonal to the written time coordinate's ∂τ (the one
    light cones take as time) — −2M/r³ in Schwarzschild's r and t.
  - Refused with no metric, or a Riemannian one: tidal forces need a time,
    so write the ds² with a dt term.
- Derivatives: `d/dx (x^3)` differentiates symbolically; higher order
  `d^2/dx^2 (...)`; works for any single-letter variable, e.g. `d/dq (q^2)`.
  The operand is every factor written after `dx`, with or without spaces,
  up to the next operator or closing bracket: `d/dx x sin(x)` is the
  derivative of x sin(x), while `d/dx x^3/x` is 3x²/x, `d/dx x * x` is
  1·x, and `(d/dx x^2) x` is 2x·x.
  Along x, y, or z it works through lists too: with `N = [1..4]`,
  `y = d/dx x^N` is a family of curves, and `y = d/dx [sin(x), x^2]` draws
  `y = cos(x)` and `y = 2x`.
  Along t a named list is refused (its elements may use t).
- Sums and products: `sum(n=1..N, sin(n x)/n)` and `prod(k=1..N, k)`, also
  written `Σ`/`Π`. The bracket form `sum[n=1..N] sin(n x)/n` takes everything
  after it in the product chain as the body (`2 sum[n=1..N] ...` keeps the 2
  outside). Bounds must be numbers or constants defined in another row (not
  `t`), because the sum is expanded symbolically before compiling — which makes
  `N` a slider that adds terms as you drag it. A bound may also be a named
  list of numbers: with `N = [3..5]`, `y = sum(n=1..N, sin(n x)/n)` draws one
  partial sum per element (a family that pairs with other uses of `N`).
  Inside a sum over `n`, a sequence term `a_n` is each term: `sum(n=1..N, a_n)`.
- Integrals: `int[a..b] f(x) dx` (definite) and `int(f(x) dx)`
  (antiderivative), also written `∫`. The trailing `dx` names the variable;
  any letter works, so `y = int[0..x] exp(-t^2) dt` plots a function of x,
  and bounds may use sliders, t, or x. Integration is symbolic where a
  verified antiderivative exists — polynomials and rational functions
  (exactly), the elementary families, u-substitution, integration by parts,
  Gaussians via erf — and falls back to Gauss–Legendre quadrature expanded
  in place otherwise, so non-elementary rows like `y = int[0..x] sin(t)/t dt`
  (Si) still plot. A row whose integral resolves to a constant shows the
  numeric value as a readout — and when the row is exactly one definite
  integral of a real integrand (`int[0..b] sin(x) dx`; bounds may be sliders,
  states, t or `±inf`), it also shades the area between the integrand and the
  axis over [a, b], in 2D: parts that add to the value in the row color,
  parts that subtract in its complement (so reversed bounds swap the tints).
  The dx variable runs along the horizontal axis whatever its letter; add
  `y = sin(x)` as its own row to see the curve beyond [a, b]. A coefficient,
  a sum of integrals, an iterated integral or a definition
  (`A = int[0..1] x^2 dx`) stays a plain number. Classic notations work: `int[0..1] dx/(1+x^2)`,
  and iterated integrals pair inside-out: `int[0..1] int[0..y] x dx dy`.
  Bounds may be `±inf` (or `∞`): `int[-inf..x] exp(t) dt` is exp(x),
  `int[-inf..inf] exp(-x^2) dx` reads √π, and `int[-inf..x] normalpdf(t, 0, 1) dt`
  is the normal cdf. Divergent limits are refused (the closed form is checked
  against real quadrature), not misreported.
- Lists: `[3, 1, 4]`, or ranges `[1..20]`, `[0, 0.5..10]` (the first two
  elements set the step), `[10..1]` (counts down). Range bounds are numbers
  or constants defined in another row, like Σ bounds. List math broadcasts
  elementwise — `2L + 1`, `sin(L)`, `L^2`. A list is a variable that ranges
  over its values: the row is evaluated once per instance, so every use of
  the SAME list moves together (zips) — `s = [1..50]/5` then `(s, sin(s))`
  is a scatter of samples, and lists derived from `s` (`q = s^2`,
  `s[s > 2]`, `a_[s]`) stay paired with it. Lists with DIFFERENT origins are
  independent and cross: each `[…]` literal is its own origin, so
  `([0,1],[0,1],[0,1])` is the 8 corners of a cube, `[1,2] + [10,20,30]` has
  6 elements, and two separately defined lists `(a, b)` make a grid. Columns
  of one data file share its rows, so `(data.x, data.y)` pairs up. To pair
  literal values write the points out: `P = [(1,4), (2,5), (3,6)]`; then
  `P.x` and `P.y` (and `P.z`) are the lists of their coordinates, paired the
  same way — `(P.x, 2 P.y)` is 3 points, not 9. Brackets add: a list
  inside a list contributes its elements, so with `n = [1,2]`, `[n, 3, 5]`
  is `[1, 2, 3, 5]` (a new list, independent of `n`). A bracket around one
  item is that item: `[n]` is `n` (so `n + [n]` has 2 elements, like
  `n + n`), and `[x + 1] 2` groups.
  `[]` is the empty list: combined with anything it gives `[]`, and
  `count([])` and `total([])` are 0.
- Cases over a list decide each element: `{L > 2: L}` with `L = [1..4]` is
  `[3, 4]`, and an element no case holds for (with no otherwise) is not in
  the list at all, so `count({L > 2: L})` is 2. A whole point goes at once,
  and over lists a case may test equality. A function's point parameters
  read coordinates as `p.x`, `p.y`, `p.z`: `c(p, q) = {p.y = q.x: (p.x,
  q.y)}` composes arrows i → j and j → k, and with lists of arrows `A`, `B`,
  `AB = c(A, B)` is the arrows that meet (their matrix product, as a multiset
  of arrows), and `c(A, A)` pairs each arrow with itself: one name is one
  choice. Two independent draws from one list are binders, rows of their
  own: `p ∈ A` (or `p \in A`) names a choice from A, equal to A but never
  identical, so with `p ∈ A` and `q ∈ A`, `c(p, q)` is A composed with
  itself (`p + p` still zips; `p + q` crosses). A binder cannot use a name
  the language has: x, y, z, t, u, v, w, d, e, i, pi, a name starting
  u_, or a built-in function such as sin. A binder draws members, not a
  range: `a ∈ [0, 10]` is 0 or 10; every number from 0 to 10 is
  `a = interval(0, 10)`, and the whole numbers are `a ∈ [0..10]`.
- List reductions: `mean(L)`, `total(L)`, `count(L)`, `min(L)`, `max(L)`,
  `stdev(L)` (sample), `median(L)`. A row that reduces to a
  constant shows the numeric value as a readout. mean/total/count/min/max
  expand symbolically, so elements may animate (`mean([sin(t), 2])`);
  stdev/median/sort need constant elements. A function applies to one
  member of a list argument at a time, a reduction in its body included:
  with `f(m) = total(L m)`, `f(M)` is one total per member of M (and
  `total(f(M))` their total), a number reduces as its one member (`mean(5)`
  is 5), so a wrapper `avg(s) = mean(s)` gives `avg(L)` = L back: reduce
  a list in the row, `mean(L)`. Over a list of points the body reads `p.x`,
  `p.y`. Over a column, a missing cell is
  left out of every reduction (as it is of `hist`) except `count(L)`, which
  answers how many rows there are.
- Order lives in tuples. A list `[ … ]` has no order — `[3, 1, 2]` and
  `[1, 2, 3]` are the same list — so anything that needs one takes a tuple
  `( … )`. `sort(L)` is L's values in ascending order, as a tuple, and
  `sort(P, key)` orders a list by a key written in that list: `sort(P, P.x)`,
  `sort((s, sin(s)), s)`. A tuple of 2 or 3 numbers is a point
  (`sort([3, 1, 2])` draws the point (1, 2, 3)); a longer one reads out,
  `sort([5, 3, 8, 1, 2])` = (1, 2, 3, 5, 8), and draws nothing. Tuples of one
  length combine position by position, like vectors: `sort(A) + sort(B)`. A
  tuple of points, `T = ((0, 0), (1, 1), (2, 0))`, is one value in order —
  `polyline(T)` walks it — and a square one is also a matrix.
- Indexing is 1-based and needs a tuple: with `T = sort([7, 5, 6])` in a row
  above, `T[2]` is 6 and `T[k]` takes k from a slider. `T[2..3]` is (6, 7),
  and a list of indices picks one element each: `T[[3, 1]]` is `[7, 5]`, and
  `T[N]` for a named list `N` pairs with `N`. `L[2]` on a list `[ … ]` is an
  error that says to sort it first; a filter `L[L > 2]` is no index and
  works on any list. A named tuple or list indexes, and so does a sort
  call, `sort(L)[2]`; `x[2]` is plain multiplication (2x) for any other
  name. On a list of points or tuples, which has no k-th element, `[k]` is
  position k of each: with `A = [(1, 1), (1, 2)]`, `A[1]` is `A.x`, paired
  with `A.y`, and `Q[4]` is the 4th entry of every 4-tuple in Q. `.x`,
  `.y`, `.z` name the coordinates of a point (2 or 3 of them), on one named
  point too (`P.x`); a longer tuple is read by position only. A function's
  parameters index (`c(p) = p[4]`), and tuple arguments arrive whole when
  they fill the parameters: `c((3, 12, 6, 2))`, `c((1, 2), (3, 4))`. A
  recursive function's parameters are numbers: pass a point's coordinates.
- Data columns: with `person = open("people.csv", 3a7f9c1d2e4b)` in a row
  above (see Definitions), `person.age` is a list of that column's numbers.
  Everything lists can do applies: `(person.age, person.height)` is a
  scatter, `mean(person.age)` a readout. File order is not part of the
  data: each record's position in the file is `person.row` (`row_index`
  when the file has its own `row` column), so `sort(person.age, person.row)`
  is the column in file order, and
  `polyline(sort((person.x, person.y), person.row))` draws a series in it
  (or sort by the x column itself). Naming
  works throughout — `half = person.age / 2`, `P = (person.age, person.height)`
  — and a named scatter is still a scatter. Only the
  device that dropped the file has its data — the link carries the file's
  name and hash, not its bytes.
- A comparison over a list keeps the members it holds for: `L > 2` (or
  `L[L > 2]`) is the elements above 2, `count(L > 2)` how many. It keeps
  members of the list, not the values compared: `L^2 < 4` keeps elements
  of L, `P.x < 0` keeps points of P. Inside `{…}` a comparison is still one
  condition per element: `{L > 2: 1, 0}`. Index by a comparison to choose
  one column by another: `person.height[person.age >= 18]` (rows stay
  aligned), chains, `person.age[30 <= person.age < 40]`, and text,
  `person.height[person.city == "NYC"]` (`!=` too, and either quote).
  Filtering a whole file names a new one,
  `adults = person[person.age >= 18]`, whose columns work like any others
  (`(adults.age, adults.height)`). A filter settles when the row compiles, so
  it may use constants and sliders but not t; a comparison with a missing
  cell is false, so filtering also drops gaps.
- Text columns are lists of text. They are not plottable and have no
  arithmetic directly. `person.name.length` returns a numeric list of character
  counts (Unicode code points) and plots one count per row. Missing cells stay
  gaps; counts use the parsed, trimmed text. Use it in arithmetic, reductions,
  histograms, and filters: `hist(person.name.length)` or
  `long_names = person[person.name.length > 10]`. `count(person.name)` still
  counts rows. `==` and `!=` exist only for filters: an equation still takes
  a single `=`.
- Comments: a row starting with `#` (e.g. `# tangent lines`) plots nothing; in
  the app it renders as a heading whose group (the rows until the next `#` row)
  can be collapsed. Use them to label sections of longer documents.
- Notes: `#` after a row's math starts a note to the end of the row
  (`y = x^2 # parabola`, `a = 2 # slope`). Only the math before it is read;
  the app shows the note in small text under the row. A `;` still ends the
  row, note included.
- Row colors: a note that opens with a hex color draws the row in that color
  (`y = x^2 #e24`, `y = sin(x) #1f77b4 wave`). The 3 or 6 hex digits must
  touch the `#`; `# 100 samples` (with a space) stays a plain note. Without
  one, the rows that draw take the palette in order (blue, red, green,
  purple, orange, black); definitions, comments and view rows take no color.
