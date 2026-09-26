# Equation.io

**[equation.io](https://equation.io)** — a graphing calculator with a built-in
CAS. Type equations; they compile to GPU shaders and render as 2D curves, 3D
surfaces, vector fields, ODE phase portraits, probability densities, and more.
Every graph lives entirely in its URL, so the address bar is the share button.

## The graph.tk story

This is the successor to **graph.tk**, which started in this repository in
May 2010 as an HTML5-canvas grapher and picked up 400+ stars over the years.
The site ran on a free `.tk` domain — which turned out to be the fatal flaw:
the registrar (Freenom) eventually seized the domain to serve ads on it, and
after Meta sued Freenom the whole `.tk` registry collapsed and the domain
stopped resolving entirely.

The lesson was learned and the grapher was rebuilt from scratch — new parser,
new CAS, WebGL rendering instead of canvas — on a domain that's actually owned:
[equation.io](https://equation.io). The original code is preserved on the
[`legacy`](../../tree/legacy) branch (tag `graph.tk-final`) under its original
LGPL-3.0 terms; everything on `main` is a clean-room rewrite, MIT licensed.
The old UI remains usable at [graph.equation.io](https://graph.equation.io).

## Architecture

Deployed as a Cloudflare Worker.

- `lib/` — tokenizer, shunting-yard parser, symbolic expression core (`expr.ts`),
  and a GLSL compiler (`glsl.ts`) used for plotting.
- `web/` — the grapher. Every equation is compiled to a GLSL scalar field F whose
  zero set is the graph:
  - **2D**: fullscreen-quad fragment shader; the curve is drawn where the
    distance estimate |F|/|∇F| is under a pixel, with a two-scale consistency
    test rejecting fake lines at poles/asymptotes (e.g. `y=tan(x)`).
  - **3D** (automatic when `z` appears): raymarched implicit surface —
    sign-change detection along each ray, bisection refinement,
    finite-difference normals, `gl_FragDepth` so multiple surfaces intersect
    correctly. Equations without `z` extrude to their true locus in R³.

The whole graph state lives in the URL (`/g/eq1;eq2;…`, each equation
percent-encoded via `lib/link.ts`, which also escapes parens so chat-app
linkifiers don't truncate the URL; legacy `/#…` links still load), so any set
of equations is linkable and the address bar is the share mechanism.
Agent-facing surface:

- `/llms.txt` — link format + expression syntax reference
  ([`web/public/llms.txt`](web/public/llms.txt))
- `/g/<eqs>` — share form of a graph link; the worker injects og:/twitter:
  meta tags and `/api/og/<eqs>` renders the preview PNG on the CPU
  (expressions compile to a stack machine — no WebGL in Workers)
- `/mcp` — stateless MCP server (Streamable HTTP) with `encode_graph_url`
  (validates rows, returns links), `decode_graph_url` (decodes links for editing),
  and `show_graph` (renders the interactive grapher inside MCP Apps hosts).
  See [MCP Apps integration and testing](docs/mcp-app.md).

## Usage

```sh
pnpm web        # dev server (grapher + worker API)
pnpm test       # vitest
pnpm typecheck  # lib + web + worker
pnpm web:build  # build to dist-web/ (client + worker)
pnpm deploy     # build and deploy to Cloudflare
```

### Voice mode (credit keys)

A mic button talks to an OpenAI Realtime model
([`web/voice.ts`](web/voice.ts)) over WebRTC, and the model edits the graph
with `get_graph` / `set_graph` tools, which report each row's readouts (values,
intercepts, extrema in view). `look_at_graph` puts a screenshot of the canvas
into the conversation as an image.

The page never holds an OpenAI credential. It opens a control WebSocket to the
Worker ([`worker/voice-call.ts`](worker/voice-call.ts)) and sends its WebRTC
offer with a **credit key**. The Worker checks the key's balance in D1, creates
the call with a fixed session, and attaches a sideband WebSocket to it before
answering. The sideband charges every response's token usage to the key
([`worker/voice-credit.ts`](worker/voice-credit.ts)); the call is hung up when
the balance runs out, after 30 minutes, if the page changes the session, or
when the page's control socket closes. Audio flows between the browser and OpenAI directly.

```sh
wrangler secret put OPENAI_API_KEY     # locally: in .dev.vars
wrangler d1 migrations apply DB --remote   # locally: --local
node scripts/voice-key.ts create "Sam" 5   # a key with $5; prints it once
node scripts/voice-key.ts list             # balances and spend
node scripts/voice-key.ts grant <id> 10    # top up; disable/enable <id>
```

Each `scripts/voice-key.ts` command takes `--remote` for the deployed database.
Visit any page once with `#voice=<key>` to show the mic in that browser
(`#voice=` forgets it). `?voice=<key>` works too, but a query string reaches
the server, which may log it; the fragment never does.

## Examples

**Basics**

- `y = x^2` · `x^2+y^2=4` · `y = tan(x)` — 2D curves
- `y = sin(2πx)` · `θ = 1; r = θ x` · `y = x³` — unicode input: π and τ,
  Greek-letter names, superscript exponents, subscripts (`T₀` ≡ `T_0`, so
  `a₃` is a sequence term), and `·`/`×`/`÷`/`≤`/`≥`/`≠`;
  in the editor, typing `\pi`, `\theta`, `\nabla`, … inserts the symbol, and
  `\` before any function name just drops (`\trail` → `trail`)
- `z = sin(x)cos(y)` · `x^2+y^2+z^2=9` — 3D surfaces (automatic when `z` appears)
- `y < x/2 + 1` — inequalities shade their region; strict `<`/`>` have no
  border, `<=`/`>=` draw the boundary line, and chains like
  `4 <= x^2 + y^2 <= 9` intersect with an edge per non-strict bound
- `y = {x < 0: -x, x >= 0: x^2}` — piecewise: `cond: value` cases tried in
  order, an optional last bare value is the default; conditions chain like
  `{0 < x < 1: 1, 0}`, and a bare condition counts 1 (`{x > 0, 5}`)
- `y = {0 < x < 2: x^2}` — a domain restriction: with no default, the value
  is undefined outside the conditions, so nothing is drawn there
- `sin(x)cos(y)` — a bare expression in x, y is a 2D scalar/density field
- `2+2`, `sqrt(a)`, `|A - B|` — a bare number draws nothing and reads out
  `= 4` under the row, live with sliders and `t`; write `y = 4` for the line

**Sliders and animation**

- `a = 2` — a named constant with a slider; other equations can use `a`, and
  it compiles to a uniform so dragging never rebuilds a shader. `b = a^2 + t`
  defines a computed/animated constant
- `(2, 3)` / `(3, 12, 0)` — points. In 2D, coordinates that are plain numbers
  or slider names can be dragged on the canvas, and the drag rewrites them:
  `a = 1; b = 2; (a, b)` moves both sliders, `(2sin(t), 3)` only its literal
  height
- `(2cos(t), 2sin(t))` — `t` is seconds since load, so this point orbits

**Calculus**

- `f(x) = x^3 - a x` — user-defined functions, inlined symbolically
- `f(z) = {re(z) >= 1: 1, f(4 - 3(z^6)^(1/6))}` then `f(x i - |y|) >= 0` —
  a tail-recursive function (every self-call a whole case of its `{…}`)
  runs as a bounded loop per pixel; this one shades the Koch snowflake
- `y = d/dx f(x)` / `d^2/dx^2 (x^4)` — symbolic Leibniz derivatives; works for
  any single-letter variable, nests, and flows through function definitions:
  `g(x) = d/dx f(x)` then `y = f(a) + g(a)(x - a)` is a live tangent line

**Probability**

- `X ~ Normal(0, a)` — a random variable; the row plots its density, and
  parameters may use sliders. Then `P(X < b)`, `P(X > b)`, or `P(-1 < X < 2)`
  shades that area under the density and shows the numeric probability
- Also `Uniform(lo, hi)`, `Exponential(rate)`, `Gamma(shape, rate)`, `Beta(a, b)`,
  `ChiSquared(df)`, `StudentT(df)` (or `T(5)`), `LogNormal(mu, sigma)`,
  `Cauchy(location, scale)`, `Weibull(shape, scale)` — exact densities, exact
  `P(…)`, and median/IQR readouts where heavy tails leave no σ to report
- `erf`, `normalpdf(x, mean, sd)`, and `normalcdf(x, mean, sd)` are also plain
  functions, so `y = normalcdf(x, 0, 1)` graphs the CDF

**Vector fields and ODEs**

- `(-y, x)` — a tuple depending on x, y is a vector field, rendered as
  animated streamlines via GPU line-integral convolution; `t` works too:
  `(cos(t)-y, x)`
- `grad(x^2 + y^2)` (or `∇(…)`) — the symbolic gradient as a tuple, so it
  plots as a vector field and works in `dot(grad(f), (1, 0))`
- `dy/dx = x y` / `y' = sin(x) - y` — ODEs plot the slope/direction field
  `(1, f)`; click the canvas to drop an RK4 integral curve through that point,
  double-click to clear
- `(x', y') = (y, -sin(x))` — a system plots its phase portrait, with the same
  click-to-trace trajectories

**Simulation (states)**

- `th' = om` (angle) with `om' = -sin(th)` (angular velocity) and `th(0) = 3` —
  a *state*: a prime on a name of your own is d/dt of it, integrated forward
  by RK4 at a fixed step as the graph animates — see
  [`lib/state.ts`](lib/state.ts). Everywhere else `th` behaves exactly like a
  constant, uniform and all, so drawing the system is ordinary plotting:
  `(sin(th), -cos(th))` is the bob, `(u sin(th), -u cos(th))` the rod. It is
  the one value in a graph that is not a formula in `t`, which is what makes a
  double pendulum — chaotic, no closed form — possible. Initial values get a
  slider that relaunches the run; ↻ in the panel restarts it
- `r' = vel` with `vel' = -r/|r|^3` and `r(0) = (1, 0)` — a *vector state*: a
  derivative that is a 2- or 3-vector integrates componentwise as `r_1`,
  `r_2`(, `r_3`), and the bare name draws as a moving point and joins point
  arithmetic — an orbit in two rows
- `label((2, 4), "peak")` / `label(A, "vertex")` — text beside a point,
  in the row's color; the point follows sliders and `t` like any other
- `y = x^2 #e24` — a note that opens with a hex color draws the row in it
- `trail(A)` — leaves a live motion trail behind a 2D or 3D point.
  For example, `A = (cos(t), sin(t)); trail(A)` draws an orbit as it runs;
  `trail((cos(t), sin(t), t/5))` draws a rising helix. Vector states work too.
  Trails retain up to 30 seconds / 2048 observed positions, reset when the
  equations or simulation restart, and are local to the current session.
- `p(0) = ([0..299]/30, 0, 0)` — a *state family*: a list of starting values
  runs the system once per element (up to 1024), and states coupled to it run
  along. `p` then draws a cloud of moving points and `mean(p_1)` reduces
  across runs. Started from a tuple, `p(0) = (sort([0..299])/30, 0, 0)`, the
  runs are in order and `p[1]` is the first
- `p(50..400)` — an *orbit*: where the state goes between those times,
  integrated ahead of time with the live simulation's own steps
  ([`lib/orbit.ts`](lib/orbit.ts)), so moving points ride their orbit. A
  family draws one path per run (`p[1](50..400)` draws one, when the runs
  start from a tuple); a scalar state plots against time, `th(0..20)` being
  the curve (t, th). With both, the Rössler attractor is a thin band of
  orbit with particles flowing along it

**Custom coordinates and complex roots**

- `r = sqrt(x^2+y^2); theta = atan2(y,x)` defines polar coordinates.
  `(r, theta) = (2, 9pi/4)` draws their point, with angles wrapping modulo 2π.
  Use literal or slider values on the right to drag the point in those coordinates.
- `(r, theta) = (3u, 6pi u)` traces a three-turn spiral;
  `(r', theta') = (r(1-r), 1)` draws a polar limit-cycle field.
- `1+2i` draws an Argand point; `w^3 = 1` draws the three cube roots of unity.
  Systems use a numerical search in the current view; small solution branches
  may be missed. Coordinate examples are available in the examples menu.

**Matrices**

- `M = ((a, b), (c, d))` — a tuple of rows is a 2×2 or 3×3 matrix (a
  bracket of tuples, `[(a, b), (c, d)]`, is two points); `det(M)`,
  `trace(M)`, the matvec `M v`, and `solve(M, v)` (Cramer's rule) expand
  symbolically at lowering time, see [`lib/mat.ts`](lib/mat.ts). So `(x', y') = A (x, y)` is a
  phase portrait with sliders in the entries, and `om' = solve(M, f)`
  integrates the double pendulum in the Lagrangian form M(θ)ω′ = f it is
  derived in

**Parametric curves and surfaces**

- `(2cos(2pi u), 2sin(2pi u), 3u)` — parametric curve, u ∈ (0,1)
- `(cos(2pi u)(2+cos(2pi v)), sin(2pi u)(2+cos(2pi v)), sin(2pi v))` —
  parametric surface, u,v ∈ (0,1); per-fragment Newton ray/surface
  intersection with a glossy specular material

**Sequences and data**

- `a_n = 1/n^2` — a sequence: dots at integer n ≥ 0; the Σ toggle on the row
  switches to partial sums S_N (this one converges to π²/6)
- `a_{n+1} = r a_n (1 - a_n)` — a recurrence: draws the map's curve, the
  diagonal y = x, and the cobweb path from the seed `a_0` (define `a_0 = 0.2`
  for a slider, default ½). With `x` free on the right side, x becomes the
  parameter axis and the plot is the orbit/bifurcation diagram:
  `a_{n+1} = x a_n (1 - a_n)` is the logistic bifurcation
- `[3, 1, 4, 1, 5]` — a data list: dots at (k, value), k = 1, 2, …; the row's
  bar toggle draws it as a bar chart. `[(1, 2), (3, 4)]` is a scatter of points

**Regression**

- `P = [(0, 1), (1, 3), (2, 5), (3, 7)]; P.y ~ m P.x + b` fits a line
  through the points. `P.x` and `P.y` are the lists of their coordinates,
  paired point by point like a data file's columns (two separately written
  lists `X`, `Y` are independent, so `(X, Y)` would be their grid).
  Unbound names `m` and `b` become fitted constants; `y = m x + b` draws the
  model and `(P.x, P.y - (m P.x + b))` draws its residuals. A fit row reports the
  coefficients, RMSE, R² (when defined), and observation count.
- `P.y ~ a P.x^2 + b P.x + c` fits a polynomial; `P.y ~ a exp(b P.x)` fits a nonlinear
  model. Already defined constants stay fixed and changing them refits the
  other coefficients. Define data and fixed constants above the fit.
- `data.height ~ m data.age + b` works with CSV columns. Missing/nonfinite
  data pairs are skipped with a count; mismatched lengths and unidentifiable
  coefficients are errors. Missing CSVs remain device-local in shared links.
- Fits are static, with at most 8 coefficients and 10,000 observations
  (2,000 for nonlinear models). Nonlinear fitting uses deterministic starts
  and reports a local fit; it does not guarantee a global optimum.

**Contextual syntax help**

The equation editor suggests functions, defined names, and loaded CSV columns
as you type, and shows signatures inside function calls. Tab or a click
inserts a suggestion; arrow keys select one for Enter to insert. Enter
otherwise creates an equation row, Escape dismisses help, and completion is
one undoable text edit. Comments and quoted strings do not trigger suggestions.

**Number theory and complex analysis**

- `gcd(a, b)` / `isprime(n)` — number theory; try `a_n = isprime(n)`
- `ln(w-2) - ln(w+2)` — complex analysis: `i` is the imaginary unit and
  `w = x + iy`; a complex-valued expression renders the level curves of its
  imaginary part (field lines) and real part (equipotentials), so complex
  potentials draw electrostatics directly. `re`/`im`/`arg`/`abs`/`conj` bring
  values back to ℝ, e.g. `im(ln(w)) = 1` plots as an ordinary implicit curve

Equations persist in the URL hash. Drag to pan/orbit, wheel to zoom,
right-drag (or shift) to pan in 3D, click a color dot to cycle colors. Points
and dropped ODE seeds highlight under the cursor and drag with it. The
equations panel is a corner-pinned card: flick it — touch anywhere on it, or
drag the grip strip along its top edge with a mouse — to send it to any
corner, or throw it past any edge to clear the view entirely; it tracks the
pointer and leaves along the throw. The `y=` chip left behind brings it back
(tap it, or drag it to pull the panel in), and the chosen corner sticks.

`worker/` — the Cloudflare Worker entry: serves the built app and handles
`/api/*` routes.

## Contributing

You need Node 24 and pnpm. Run `pnpm install`, then `pnpm web` for the dev server.
Before opening a PR, run the same checks CI runs:

```sh
pnpm typecheck    # tsc over lib, web and worker
pnpm lint         # Oxlint, including type-aware rules
pnpm fmt:check    # Oxfmt (pnpm fmt rewrites files in place)
pnpm vitest run   # unit tests
```

`pnpm lint:fix` applies the fixes Oxlint can make automatically. In VS Code,
install the recommended Oxc extension to see lint errors as you type.

## License

MIT — see [LICENSE](LICENSE). The pre-2026 graph.tk code on the
[`legacy`](../../tree/legacy) branch remains under its original LGPL-3.0
terms; no code from it was reused in the current codebase.

## Axis scaling

Option/Alt + drag the 2D canvas to scale each axis independently: horizontal
movement scales x and vertical movement scales y, anchored at the initial
pointer position. Normal zoom preserves the ratio. Set `ratio = 1` in the
viewport row to restore equal axis units.

Scaling creates or updates a shareable viewport row:
`view(x = -10..10, y = -1..1, ratio = 5)`. The positive `ratio` is pixels per
y unit divided by pixels per x unit; omitted means 1. The bounds are fitted
with that ratio preserved, including on different screen sizes.
