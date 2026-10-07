# Ask evals: results

How to run, and what the numbers mean: `apple/README.md` (Ask evals). Each
step below is measured on the same 35 tasks (`tasks.ts`), 5 runs each, with
the on-device model (AFM 3 Core Advanced, 8,192-token context). Never
Private Cloud Compute.

## Baseline (step 1, 2026-10-07)

`results/2026-10-07T105734Z-on-device.json`. The app's instructions and tools
as of 785cf92. That file was regraded (`regrade.ts`, which replays each run's
tool calls) after four checks were fixed. The fixes covered a cone check
that passed a saddle the model called a cone, a Lissajous check that passed
a circle, a frequency check that passed an amplitude slider, and
reply-honesty false positives on "showing the points where…", "crossing
point" and "the area around them".

**Pass rate 43% (76/175).** The 5 repetitions passed 13, 15, 15, 16 and 17 of
35 tasks: ±4% across repetitions. Per run: 3.6 tool calls, 9.8 s, and about
7,100 input and 130 output tokens. Input tokens are summed over the model
calls in a session, so they count the transcript again for each tool round.
The instructions take 874 tokens and the tool definitions 820, before any
request.

| task | pass | calls | tokens in/out | most common failure |
| --- | --- | --- | --- | --- |
| unit-cube | 0/5 | 3.4 | 8506/147 | reply names only what was drawn (5/5) |
| unit-cube-beside-sphere | 0/5 | 2.4 | 7283/133 | a solid or polygon row (5/5) |
| slider-amplitude | 4/5 | 2.0 | 5456/98 | 1 row like /sin/ (1/5) |
| slider-radius | 0/5 | 2.2 | 6094/110 | 1 drawn rows (5/5) |
| make-it-move | 0/5 | 2.6 | 6152/107 | a row like /sin/ moves with t (5/5) |
| animate-parabola | 0/5 | 5.0 | 7748/171 | a row like /x\^2\|x\s*\*\s*x/ moves with t (5/5) |
| show-frequency | 0/5 | 2.6 | 5170/106 | 1 row like /sin\(\s*([a-z]\w*\s*\*?\s*x\|x\s*\*?\s*[a-z]\w*)\s*\)/i (5/5) |
| animate-existing-slider | 4/5 | 8.4 | 5389/93 | error: context size exceeded (1/5) |
| circle-and-line | 3/5 | 3.4 | 6628/138 | no errors or warnings (1/5) |
| honest-reply-helix | 0/5 | 3.0 | 8741/124 | a 3D curve (5/5) |
| area-under-sin | 5/5 | 3.0 | 5588/132 |  |
| integral-value | 5/5 | 2.0 | 4357/87 |  |
| zoom-zero | 1/5 | 3.4 | 7116/157 | move_view: a narrower window around x = 0 (4/5) |
| zoom-out | 3/5 | 2.2 | 4320/89 | move_view: a wider window (2/5) |
| spin-3d | 5/5 | 2.0 | 5082/80 |  |
| polar-rose | 5/5 | 3.0 | 7856/136 |  |
| cardioid | 0/5 | 3.0 | 6682/143 | the cardioid r = 1 + cos θ (5/5) |
| parametric-circle | 0/5 | 4.6 | 14008/214 | a circle of radius 3 (5/5) |
| lissajous | 3/5 | 3.4 | 9879/140 | a 2D curve that is not an ellipse (its frequencies differ) (2/5) |
| sphere | 0/5 | 3.8 | 8518/197 | a sphere of radius 2 (5/5) |
| saddle | 5/5 | 1.0 | 3509/61 |  |
| torus | 1/5 | 4.6 | 10486/187 | reply names only what was drawn (4/5) |
| cone | 0/5 | 3.4 | 9035/150 | a cone (5/5) |
| vector-field | 5/5 | 3.0 | 8825/99 |  |
| points | 0/5 | 12.2 | 12852/383 | no errors or warnings (5/5) |
| named-point | 5/5 | 2.0 | 3655/84 |  |
| moving-point | 0/5 | 8.6 | 18735/360 | 1 row like /^\s*A\s*=.*\bt\b/ (5/5) |
| label-crossing | 3/5 | 10.4 | 4413/95 | no errors or warnings (2/5) |
| color-red | 0/5 | 1.6 | 3904/69 | drawn in red (5/5) |
| derivative | 4/5 | 2.4 | 4594/117 | 2 drawn rows (1/5) |
| function-draws | 4/5 | 2.0 | 3568/78 | reply names only what was drawn (1/5) |
| tangent-line | 2/5 | 5.0 | 12465/182 | the tangent y = 2x − 1 (3/5) |
| shift-up | 4/5 | 1.2 | 3509/61 | 1 drawn rows (1/5) |
| remove-row | 5/5 | 2.2 | 4047/72 |  |
| shade-region | 0/5 | 2.0 | 4660/81 | a ineq2d row like /y\s*>=?\s*x\^2\|x\^2\s*<=?\s*y/ (5/5) |

### Failure patterns

**It copies the nearest example instead of adapting it.** When the
instructions or a search result hold a form close to the request, the model
writes it out unchanged:
- "Draw a circle of radius 3 as a parametric curve": 5/5 wrote
  `(2cos(2pi u), sin(2pi u))`, an ellipse with semi-axes 2 and 1, and said
  "radius 3".
- "Plot the cardioid r = 1 + cos θ": 4/5 wrote the instructions' rose
  `(sin(8pi u) cos(2pi u), sin(8pi u) sin(2pi u))` and called it a cardioid.
  The polar rose task, which matches that example exactly, passed 5/5.
- "Draw a helix": 5/5 wrote a plane curve, `(2cos(2pi u), sin(2pi u))` or
  `(2cos(2pi u), sin(4pi u))` (the reference's 2D example), and called it a
  helix.
- "Draw a sphere of radius 2": 0/5. The runs drew a circle, or tried
  `x = 2*cos(2*pi*u)` and other invalid rows.

**read_syntax gives it the wrong shape of knowledge.** 55 of 175 runs
searched the reference, and they passed 27% of the time (15/55) against 51%
(61/120) for runs that didn't. The model searches on the harder requests,
so this doesn't measure what searching itself is worth. A search for "3D cube" returns the "Geometry
in space" and "Convex hulls" entries, with `([0,1],[0,1],[0,1])` as "the 8
corners of a cube", but not the parametric-solid entry that holds the unit
cube. So the cube runs drew points, vectors or surfaces:
- `unit-cube` #1: read_syntax "3D surface cube", then
  `["A = (1, 1, 1)", "z = x * y"]`, and the reply "I drew a small 3D cube from
  (1,1,1) with the surface z = x * y".
- `unit-cube-beside-sphere` #1: read_syntax "3D cube", then
  `[0,1,0],[1,0,0],[0,1,0],[0,0,1]` (a tuple readout), and the reply "I drew
  the 3D cube from the four corner points."

The observed helix and cube mash-up didn't recur in these runs, but three
runs drew a `family` (two shapes in one row), such as
`frame((2cos(2pi u), sin(2pi u)), t/10)` added to a "cardioid".

**The reply describes the request, not the graph.** 18 runs failed the
reply check, and more replies were wrong in ways the check doesn't see:
- `make-it-move` (0/5): every run sent `["y = sin(x)"]` back unchanged,
  moved the view, and replied "I drew a travelling wave by shifting the
  curve leftwards over time". No row used t.
- `color-red` (0/5): the runs left `y = x^2` as it was or wrote
  `y = x^2 #ff`, which isn't a color. They all replied "the parabola in red".
- `cone`: 3/5 drew the saddle `z = x^2 - y^2` and called it "a 3D cone".

**It adds a row instead of changing one.**
- `slider-radius` (0/5): the runs kept `x^2 + y^2 = 4` and added `a = 3` and
  `y = a sin(x)`, a sine wave, then said the circle "visibly expands".
- `animate-parabola` (0/5): the runs added an amplitude slider and a sine
  wave beside the parabola, or replaced it with one.
- `slider-amplitude` passed 4/5 because the instructions spell out this
  exact case ("A = 1 and y = A sin(x)").

**Sliders are animated before they exist.** 8 of the 22 runs that called
animate_slider had a call fail with "no slider named …". In
`animate-parabola` #2 the model called `animate_slider("amplitude")` and
then `animate_slider("a")` twice before it wrote any slider row.
In `show-frequency` (0/5), 4 runs wrote an amplitude slider
(`A = 1`, `y = A sin(x)`) for a frequency request, the instructions' own
example, and 3 of those never animated it.

**Tool arguments come out malformed, and it loops.**
- `move_view`: 9 runs had a call fail, typically with 3D arguments
  (`spin`, `phi`, `radius`) on a 2D graph. `zoom-zero` passed 1/5: the
  windows it sent, like `x: [-4, 0]` with `radius: 0.5`, missed 0 or didn't
  zoom.
- `label-crossing` #1: `label((0,0), "they cross here")` came back as two
  array entries, `"label((0,0),"` and `"\"they cross here\")."`. The model
  then called set_graph 17 more times, adding junk rows each time, until it
  ran out of context.
- `points` (0/5, 12 calls a run): the runs added `A = 1`, `A = 2`, `A = 3`
  before the points, then duplicated them.

**Context.** 6 of 175 runs overflowed the 8K context, all in tool loops.
Runs that loop are also the slow ones: up to 36 tool calls and 44K input
tokens in a session.

### What the checks can't see

- The reply check is keyword-based. It catches a named shape with no row of
  that kind ("cube" while no row is a solid or polygon). It misses a right
  kind with the wrong content ("a red parabola" that is blue, "travelling"
  with no t), and some tasks check those with their own criteria. It can
  also fail an honest reply that names a shape it says it couldn't draw.
- Some checks only test the kind: the torus, a parametric cone, and the
  unit cube's size and position.
- The app answers `move_view` and `animate_slider` once the motion has
  finished. The evals answer at once, with the window or value they would
  end on. The app's window depends on its size; the evals use 16 × 12 units.
- get_graph and set_graph leave out each row's notable points (intercepts in
  view), which the app adds from its hover cache.

## Step 2a: check (2026-10-07)

`results/2026-10-07T120103Z-on-device.json`, at 4235a81. A `check(rows)`
tool (lib/assistant-tools.ts `checkRows`, on the bridge as
`window.equationApp.check`): each proposed row's kind, meaning, value,
error and warning, without changing the graph. The instructions were not
changed; the model learns of it from its description. The tool
definitions grew from 820 to 942 tokens.

**Pass rate 36% (63/175), against 43% (76/175).** The repetitions passed
15, 14, 10, 12 and 12 tasks (±5%, against ±4%). The 13 runs lost are about
two standard errors of the difference, so check on its own is at best no
help to this model:

- Tool calls rose from 3.6 to 4.6 a run, and input tokens from 6,840 to
  8,950 (summed over a session's model calls). Context overflows rose from
  6 to 10.
- The model called check in 68 runs (119 calls), and 47 of those calls were
  followed by a set_graph of exactly the same rows: it used check as a
  dry run of what it was about to send anyway, not to compare a meaning
  with its intent. Runs that called check passed 41% (28/68); runs that
  didn't, 33% (35/107).
- Down: slider-amplitude 4/5 → 0/5, of which 4 runs failed with a tool-call
  error: after set_graph, the model's arguments for animate_slider didn't
  match the tool's schema ("GeneratedContent does not …", cut short by the
  runner). zoom-out 3/5 → 0/5 (all 5 runs sent the window they were
  already on, x = [-8, 8], as the "wider" window), tangent-line 2/5 → 0/5
  (`y = 2x - 2`, `y = 2x`, and a run that set the row
  `"tangent line at x = 1"`, then `frame(y = 2x - 1, (1, 1), color:#e24)`,
  until the context ran out).
- Up: shade-region 0/5 → 1/5, points 0/5 → 1/5, animate-existing-slider
  4/5 → 5/5.
- Unchanged: unit-cube 0/5 (10.8 calls a run, read_syntax "3D surface
  cube", then `["A = (1, 1, 1)", "z = x * y"]` and "I drew a 3D cube"),
  make-it-move, animate-parabola, show-frequency, cardioid, sphere, cone,
  color-red all 0/5. The reply check failed in 19 runs (18 before).

## Step 2b: list_kinds, kind_examples, search_functions, function_doc (2026-10-07)

`results/2026-10-07T124000Z-on-device.json`, at e25469d. read_syntax is
gone; in its place four lookups (lib/assistant-tools.ts), answered as text:

| tool | what it returns | typical size |
| --- | --- | --- |
| list_kinds | 21 common kinds as `kind: smallest form \| what it draws`, the other 27 by topic, and a line on definitions | 806 tokens (2,200 characters), fixed |
| kind_examples(kind) | the kind's KIND_MEANINGS line, its smallest form, and up to 3 whole graphs from the examples menu that draw it (the analyzer labels each menu row by kind; fewest rows first) | 133 tokens on average over the 49 kinds, 345 at most (automaton) |
| search_functions(query) | up to 6 `signature: description` lines, only the strong matches | 73 tokens on average over 7 sample queries, 187 at most |
| function_doc(name) | the signature and description, and up to 2 menu examples that call it | 78 tokens on average over all 139 names, 272 at most (fourier) |
| check(rows) | as in 2a | about 40 tokens a row |

Sizes are the on-device tokenizer's (`SystemLanguageModel.tokenCount`).
The instructions changed by one line (read_syntax → "call list_kinds
first, then kind_examples or function_doc"). The tool definitions are now
1,218 tokens (820 at the baseline) and the instructions 883.

**Check fixes, and every file regraded.** This step's runs showed two
checks wrong, one each way. Both are fixed in this commit, and the
baseline, 2a and 2b files were regraded with regrade.ts:
- The unit-cube tasks (task and reply check) took any `polygon` row as a
  cube. Two 2b runs copied list_kinds' polygon form,
  `polygon((0, 0), (2, 0), (1, 2))`, a 2D triangle, and replied "a unit
  cube as a polygon". They passed. A polygon now counts only when it
  draws in 3D (a hull of 3D points), and a solid always counts.
- The sphere task only took an implicit surface through (2, 0, 0) and
  (0, 0, −2). Two 2b runs drew the menu's correct parametric sphere,
  `(2sin(pi v)cos(2pi u), 2sin(pi v)sin(2pi u), 2cos(pi v))`, and failed.
  A parametric surface now passes when every sample is 2 from the origin
  and it reaches both poles and both sides (a cap or a unit sphere still
  fails; tasks.ts has both as known-bad answers).

No baseline or 2a run changed grade (43% and 36% as before). 2b went from
44% to 44%: unit-cube 4/5 → 2/5, sphere 0/5 → 2/5.

**Pass rate 44% (77/175), against 43% (76/175).** Repetitions 17, 13, 17,
15, 15 (±4%). Context overflows 6, as at the baseline. Tool calls 4.5 a
run (3.6), input tokens 10,080 a session on average (6,840).

The overall rate hides large moves both ways:
- Up: unit-cube 0 → 2, unit-cube-beside-sphere 0 → 3, sphere 0 → 2, torus
  1 → 4, lissajous 3 → 4, tangent-line 2 → 4. These are retrieval: the
  runs called list_kinds, then kind_examples("solid") or ("psurface"),
  and adapted (or copied) a menu example. The solid cube
  `(interval(0, 1), interval(0, 1), interval(0, 1))` came straight from
  kind_examples("solid"); three of four torus passes copied the menu's
  "breathing torus", which moves with t, unasked.
- Also up, with no lookups in those runs: make-it-move 0 → 5 (every run
  now writes `y = sin(x - t)`) and color-red 0 → 4 (`y = x^2 #e24`). The
  instructions' own examples cover both, unchanged since the baseline, so
  this is the model's sensitivity to the rest of its prompt (the tool
  list), not knowledge. Per-task moves of 2 or 3 of 5 need that caveat.
- Down: polar-rose 5 → 0. All five runs called list_kinds, then
  kind_examples("psurface"), and turned the instructions' rose into a 3D
  curve: `(sin(8pi u) cos(2pi u), sin(8pi u) sin(2pi u), cos(8pi u))`,
  "a 3D polar rose". derivative 4 → 1: four runs left `f(x) = x^3 - x`
  undrawn beside `y = d/dx f(x)`. spin-3d 5 → 2: runs wrote the camera
  into a row, `"spin:0.3"`, and looped on set_graph until the context ran
  out. function-draws 4 → 2: `x^2 - 4` as a bare row (a scalar field),
  replied as "a shaded region".
- Lookups: list_kinds in 63 runs, kind_examples in 64 (psurface 21, pcurve
  15, implicit2d 9, solid 8, …), check in 46, function_doc twice (both
  `"psurface"`, a kind), search_functions never. Runs that looked a kind
  up passed 33% (21/64); they are the harder requests.
- The model now copies list_kinds' smallest forms as it copied the
  instructions' examples before. "Draw a helix": 5/5 wrote the unit
  circle `(cos(2pi u), sin(2pi u))`, the pcurve form, and called it a
  helix. "A circle of radius 3 as a parametric curve": 4/5 wrote that same
  unit circle. "The cardioid r = 1 + cos θ": 2/5 wrote the psurface form,
  a unit sphere, as "a 3D cardioid surface". "A cone": the unit circle,
  `x^2 + y^2 = 9`, a paraboloid and a saddle. All four tasks stay 0/5, as
  do slider-radius, animate-parabola, show-frequency and moving-point.
