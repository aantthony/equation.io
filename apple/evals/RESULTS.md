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
| list_kinds | 21 common kinds as `kind: smallest form \| what it draws`, the other 27 by topic, and a line on definitions | 800 tokens (2,172 characters), fixed |
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

## Step 2c: the instructions as a primer (2026-10-07)

`results/2026-10-07T130535Z-on-device.json`, at e6fce0e. The instructions
are rewritten (Assistant.swift `ChatModel.instructions`): a short primer
of the commonest forms; the voice prototype's rules (polar through u, as a
template `(f(2pi u) cos(2pi u), f(2pi u) sin(2pi u))` instead of the rose;
a function definition draws nothing; reserved names); "for any other
shape, call list_kinds, then kind_examples for the kind you need, and
adapt an example"; and two new rules, "one shape per row" and "check
before claiming". **Fixed overhead: 806 instruction tokens and 1,218
tool-definition tokens, 2,024 in all**, against 874 + 820 = 1,694 at the
baseline: the four lookups and check cost 398 tokens of definitions, the
shorter primer saves 68.

**Another check fix, and every file regraded again.** The cone task took
any parametric surface or solid unchecked. In this run all five cone runs
copied list_kinds' psurface form, a unit sphere, called it "a cone-like
surface", and passed. A parametric surface now passes only when its
distance from the z-axis is a linear function of z or of |z| (a cone or a
double cone, not a cylinder); tasks.ts has the copied sphere and a
cylinder as known-bad answers, and two parametric cones as known-good. A
solid still isn't checked for its shape. Regraded: the baseline, 2a and
2b files are unchanged (43%, 36%, 44%; no earlier run drew a parametric
surface for a cone); this run went from 46% (81/175) to 43%.

**Pass rate 43% (76/175), against 43% at the baseline and 44% after 2b.**
The repetitions are much steadier: 15, 16, 15, 15, 15 (±1%, against ±4%).
Tool calls 3.3 a run (3.6 at the baseline, 4.5 after 2b), input tokens
8,810 a session on average, context overflows 3 (6 at the baseline and
after 2b). The reply check failed in 21 runs (18 at the baseline).

Against 2b:
- Up: spin-3d 2 → 5 and shift-up 2 → 5 (no more camera rows like
  `"spin:0.3"`, no loops), named-point 3 → 5, torus 4 → 5 (all five copy
  the menu's breathing torus, which moves with t).
- Down: unit-cube-beside-sphere 3 → 0. Four of five runs copied
  kind_examples' label into the row:
  `"solid cube: (interval(0, 1), interval(0, 1), interval(0, 1))"`, an
  error, then answered without fixing it ("the second row should define a
  solid cube"). saddle 5 → 2: three runs wrote list_kinds' psurface form,
  the unit sphere, as "a 3D saddle". tangent-line 4 → 0: every run wrote
  the derivative, `y = 2x`, as the tangent. lissajous 4 → 2.

Against the baseline the totals are level, but which tasks pass has
changed: color-red 0 → 5, make-it-move 0 → 4, torus 1 → 5, unit-cube
0 → 2, sphere 0 → 2 up; polar-rose 5 → 0, tangent-line 2 → 0, saddle
5 → 2, derivative 4 → 2, function-draws 4 → 1, vector-field 5 → 3 down.

### What still fails, and why (after 2c)

**Copying the nearest form, now from the lookups.** The model calls
list_kinds and kind_examples (68 and 72 of 175 runs) and then, as at the
baseline, writes the first form it sees with the request's name on it:
- `(sin(pi v)cos(2pi u), sin(pi v)sin(2pi u), cos(pi v))`, list_kinds'
  psurface form (a unit sphere), for "a cone" (5/5), "the cardioid r = 1 +
  cos θ" (4/5, "a cardioid as a parametric surface"), "the saddle z = x² −
  y²" (3/5) and once for the polar rose.
- The unit circle `(cos(2pi u), sin(2pi u))`, the pcurve form, for "a
  helix" and "a circle of radius 3" (both 0/5, every step).
- kind_examples' labels: `"solid cube: (interval(0, 1), …)"` as a row.

**The polar template isn't instantiated.** polar-rose 0/5 in 2b and 2c,
after 5/5 at the baseline, where the instructions held the rose itself.
With the template, runs wrote `(sin(2pi u) cos(4pi u), sin(2pi u) sin(4pi
u))` (θ and r swapped), or kept a bare `r = sin(4θ)` row beside it. The
cardioid is 0/5 at every step.

**It adds instead of changing, and every slider is the amplitude.**
slider-radius, animate-parabola and show-frequency are 0/5 at every step,
and all three get the instructions' own example back: `A = 2` and
`y = A sin(x)` beside the circle for "a slider for the radius" (or `a = 4`
used by nothing); the parabola replaced by `a = 2`, `y = a sin(x)` for
"animate it"; an amplitude slider for "show me what changing the
frequency does". moving-point is 0/5 at every step: `A = (1, 0)` stays
put beside new rows (a parametric circle in 2b; `x = u`, `y = a cos(u)`
or `y = (1 - t)^2` in 2c) and the reply says the point moves.

**Points with names.** "Plot the points (1, 2), (3, 4) and (5, 1)" is 0/5:
`A = 2`, `A = 3`, `A = 1`, or one point `A = (1, 2)` after
"A is already defined" errors.

**Camera and window.** zoom-zero and zoom-out pass 2/5 and 3/5: runs
never call move_view and say they zoomed, send the window they are
already on (x = [-8, 8]) as the "wider" one, or send 3D arguments (`phi`,
`radius`, `spin`) to a 2D graph. Only get_graph tells the model the
current window.

**check is used as a dry run.** 52 runs called it; most sent exactly the
rows they then passed to set_graph. "Check before claiming" didn't stop
replies like "a 3D cone-like surface" over a sphere: the meaning said
"parametric surface over u and v in 0..1", which is true of both.

## Step 2d: kind examples rows first, in 2D and 3D (2026-10-08)

`results/2026-10-07T133425Z-on-device.json`, at 463eee8. Two changes to
what kind_examples (and function_doc) return, both from 2b and 2c's runs:
- Each example is written rows first, label after:
  `- ["(interval(0, 1), interval(0, 1), interval(0, 1))"] (solid cube)`,
  in place of `- solid cube: [...]`, which 4 of 5 runs of
  unit-cube-beside-sphere copied into a row in 2c.
- A kind that draws in 2D and 3D shows an example of each where the menu
  has one. pcurve's examples were three plane curves (lissajous, spiral,
  rose); now lissajous, helix, spiral. Every "draw a helix" run in 2b
  and 2c had copied a plane circle.

Sizes barely change: kind_examples averages 136 tokens (348 at most).
Instructions and tool definitions are as in 2c.

**Two more check fixes, and every file regraded again.** This run showed
two more checks too lenient, both exploited by copying:
- The unit-cube tasks took any solid. Four of five unit-cube runs wrote
  list_kinds' solid form, `(interval(0, 1), interval(0, 2), interval(0,
  3))`, a 1 × 2 × 3 box, and called it "a unit cube". The check now
  samples the solid's faces (or the hull's vertices) and wants an extent
  of 1 along each axis; the box and a 2 × 2 × 2 hull are known-bad answers.
- The helix task took any 3D parametric curve. One run drew the circle
  `(cos(2pi u), sin(2pi u), 0)` and replied "a 3D helix". The check now
  wants a curve no plane holds (its samples' covariance is not singular);
  that circle and a tilted circle are known-bad answers, and a helix
  along x known-good.

Regraded: baseline 43%, 2a 36%, 2b 44%, 2c 43%, all unchanged; this run
went from 49% (86/175) to 46%.

**Pass rate 46% (81/175), against 43% (76/175) at the baseline.**
Repetitions 17, 17, 18, 15, 14 (±4%). 3.4 tool calls a run, 8,630 input
tokens a session on average, 3 context overflows.

- Against 2c: honest-reply-helix 0 → 3 (`(2cos(6pi u), 2sin(6pi u), 4u -
  2)`, the menu's helix, from kind_examples("pcurve")), unit-cube-beside-
  sphere 0 → 2 (no label copied into a row), vector-field 3 → 5,
  function-draws 1 → 3, sphere 2 → 3, saddle 2 → 3 up; zoom-zero, unit-cube,
  torus, lissajous, label-crossing, derivative and animate-existing-slider
  down by 1 each.
- lissajous 1/5: four runs called kind_examples("psurface") and drew the
  menu's torus as "a 3D Lissajous figure".
- The 1 × 2 × 3 box is the solid form in list_kinds because it isn't a
  task's answer (list_kinds' forms are plain shapes at unit size, so the
  model has to adapt one); the model copied it as "a unit cube" anyway.

## Step 2: summary

| step | pass | ± across repetitions | tool calls a run | input tokens a session | overflows | fixed tokens (instructions + tools) |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | 43% (76/175) | 4% | 3.6 | 6,840 | 6 | 874 + 820 |
| 2a check | 36% (63/175) | 5% | 4.6 | 8,950 | 10 | 874 + 942 |
| 2b lookups | 44% (77/175) | 4% | 4.5 | 10,080 | 6 | 883 + 1,218 |
| 2c primer | 43% (76/175) | 1% | 3.3 | 8,810 | 3 | 806 + 1,218 |
| 2d examples | 46% (81/175) | 4% | 3.4 | 8,630 | 3 | 806 + 1,218 |

With 175 runs a step, a difference of 5 points is about one standard
error: no step has moved the overall rate measurably. What the steps did
change is which tasks pass. The cube, sphere, torus and helix tasks went
from 0–1 of 5 to 1–4 of 5 through kind_examples. polar-rose went from 5/5
to 0/5 from 2b on: in 2b the model looked up psurface and lifted the
instructions' rose into 3D; from 2c the instructions hold a template, not
the rose, and it isn't filled in. The model copies whatever form is
nearest, now from the lookups. The model also
uses the lookups on the wrong requests: kind_examples("psurface") for
"a Lissajous figure", "a polar rose", "a cardioid" and "a cone".

What the next step should test, from these runs: smallest forms that
can't be copied as an answer (a form with its parameters named, like
`r = 2` then `(r cos(2pi u), r sin(2pi u))`); a kind lookup that matches
the request's words to example labels ("helix", "torus", "cube") rather
than relying on the model to pick a kind; and the slider and "change the
row" failures, which no lookup touches.

## Hosted baseline: OpenAI gpt-5.5 (2026-10-08)

`results/2026-10-07T214025Z-openai-gpt-5.5.json`, with the app's
instructions and tools as in 2d (463eee8): `pnpm app:eval --model openai`.
The runner sends the same instructions (as the system message), the same
per-turn prompt (the rows, then the request) and the same nine tools to
OpenAI's Chat Completions API. Each tool's parameters are its `@Generable`
arguments encoded as JSON Schema (`GenerationSchema` is `Encodable`), so
names, descriptions and argument schemas can't drift from the app's, and
each call runs the tool's own `call` (trimming, clamping) against the same
eval service. The API answered as `gpt-5.5-2026-04-23`, at its default
reasoning effort (55 reasoning tokens a run on average). Its context is not
8K, so this measures the model with the app's knowledge and tools, not the
app's budget.

**Three check fixes, and every file regraded.** gpt-5.5 failed 8 of 175
runs on first grading (95%, ±1%). All 8 were correct answers that a check
rejected, so the checks are fixed and every results file regraded with
regrade.ts:
- animate-parabola (5 runs): `y = (x - t)^2`, the parabola sliding right,
  failed the check's text pattern, which only took a literal `x^2` or
  `x*x`. It now also takes a shifted square, `(x - …)^2`, but not
  `sin(x - t)^2`. tasks.ts has `y = (x - t)^2` and `y = (x - sin(t))^2`
  as known-good answers and `y = sin(x - t)^2` as known-bad.
- tangent-line (2 runs): `y = x^2`, `y = 2x - 1` and a point or label at
  (1, 1) failed "2 drawn rows". Marking the point of tangency is good
  teaching. The count now leaves out points and labels, so a second line
  still fails (a known-bad answer).
- moving-point (1 run): the reply "I made A orbit the unit circle" failed
  the reply check ("circle" with no circle row). Like "goes round in a
  circle", that names the motion, not a shape, and the check's exceptions
  now include "orbits the (unit) circle".

No on-device run changed grade (baseline 43%, 2a 36%, 2b 44%, 2c 43%, 2d
46%, run for run as before). gpt-5.5 went from 95% to 100%.

**Pass rate 100% (175/175), ±0% across repetitions, against 46% (81/175)
±4% on-device.** Every answer was read, not just its grade. The cube is
`(interval(0, 1), interval(0, 1), interval(0, 1))`, or centred at the
origin inside the sphere. The rose is `(sin(8pi u) cos(2pi u), sin(8pi u)
sin(2pi u))`, the instructions' template with r = sin(4θ) filled in, and
the cardioid `((1 + cos(2pi u)) cos(2pi u), …)`. The cone is
`((1 - v) cos(2pi u), (1 - v) sin(2pi u), 2v)` or `z = sqrt(x^2 + y^2)`,
the frequency slider `k = 4`, `y = sin(k x)` animated from 1, and the
moving point `A = (cos(t), sin(t))` with no copy left behind.

| | on-device (2d) | gpt-5.5 |
| --- | --- | --- |
| pass | 46% (81/175) | 100% (175/175) |
| ± across repetitions | 4% | 0% |
| tool calls a run | 3.4 | 2.5 (5 at most) |
| failed tool calls | 40, in 11 runs | 0 |
| runs that looked a kind up | 70 | 51 |
| check / function_doc and search_functions calls | 62 / 5 | 0 / 0 |
| input tokens a session | 8,630 | 7,020 (3,005 from cache) |
| output tokens a session | 120 | 166 (55 reasoning) |
| seconds a run | 8.8 | 5.8 |
| runs that ended in an error | 3 (context overflows) | 0 |

Per task, on-device (2d) against gpt-5.5, out of 5:

| task | on-device | gpt-5.5 |
| --- | --- | --- |
| slider-amplitude, make-it-move, area-under-sin, integral-value, spin-3d, vector-field, named-point, color-red, shift-up, remove-row | 5 | 5 |
| torus | 4 | 5 |
| circle-and-line, honest-reply-helix, zoom-out, sphere, saddle, function-draws | 3 | 5 |
| unit-cube-beside-sphere, animate-existing-slider | 2 | 5 |
| unit-cube, zoom-zero, lissajous, label-crossing, derivative | 1 | 5 |
| slider-radius, animate-parabola, show-frequency, polar-rose, cardioid, parametric-circle, cone, points, moving-point, tangent-line, shade-region | 0 | 5 |

**Cost.** 1,228,316 input tokens (525,952 of them cached) and 29,063
output tokens for the 175 runs: about $4.65 at $5 / $0.50 cached / $30
per million (third-party listings of gpt-5.5's price; not confirmed on
OpenAI's own page). About 2.7 cents a run.

### What this says about the gap

- **No task fails on both.** With the same instructions, tools and
  lookups, gpt-5.5 passes every task every time, so nothing in the suite
  is beyond the knowledge the app gives the model. The 11 tasks the
  on-device model fails 5/5 (sliders, animating the parabola, polar
  curves, cone, points, the moving point, the tangent, shading) are the
  on-device model failing to use what it is given, not missing knowledge
  or broken tools.
- **The instructions already hold the answers the device misses.** For
  the slider, parabola, moving-point, points, tangent and shading tasks
  ("change the row rather than adding a near copy", `y < x^2`, `A = (1,
  2)` in the primer) gpt-5.5 called no lookup at all, and passed. The
  rose and cardioid come from the polar template (it also looked up
  pcurve in 4 of 5 runs each). The device's failures there are copying
  the nearest example instead of adapting it, as recorded in steps 1 to
  2d.
- **The lookups work when the model picks the right kind.** gpt-5.5 called
  list_kinds then kind_examples only on the 3D, parametric, polar and
  vector-field tasks (51 runs, all on those 11 tasks), with the right
  kind: "solid" for the cubes, "pcurve" for the helix, rose, cardioid and
  Lissajous (one cardioid run tried "curve" first), "psurface" for the
  sphere, torus and cone, "vfield2d" for the field. It adapted the
  example (radius 2, a 3:4 Lissajous of its own) rather than copying it.
  The device called a lookup in more runs (70), often with the wrong kind
  (psurface for a Lissajous, a rose, a cardioid).
- **So the remaining work is fitting the device.** Since a capable model
  scores 100% on this knowledge, the next steps should make it easier for
  a small model to use: fewer, more direct forms; examples that can't be
  copied as an answer; and changes the device can act on in one step. The
  suite no longer separates good knowledge from bad at the top: harder
  tasks are needed for a hosted model, or for Private Cloud Compute later.

### What gpt-5.5 does that the checks don't grade

- **LaTeX in replies:** 34 of 175 replies wrote `\(y=x^2\)` or
  `\(2\pi\)`. The app shows the reply as plain text, so these would show
  their backslashes. The on-device model never did.
- **Colors unasked:** most rows carry a hex color the request didn't ask
  for (`#e24`, `#2563eb`). Harmless, but it changes rows the person may
  want to keep as they were.
- **move_view in 81% of runs,** often a slow 3D spin. That is the
  instructions' "teach by showing", not an error.

## Step 3: one reference, three outputs (2026-10-08)

`results/2026-10-07T230237Z-on-device.json`, at a5afc3f. The language
now has one human-written source, `docs/reference/` (an index of the 49
kinds by group, a page per kind with its forms, examples, pitfalls and
details, general pages, notes on functions), and three outputs generated
from it: the site's `/docs/` pages, `web/public/llms.txt`, and the app's
`assistant.json` (list_kinds, kind_examples, function_doc). The app's and
the voice prototype's instructions come from one file,
`lib/assistant-instructions.ts` (Instructions.swift is generated). What
the model sees changed in three ways:

- **Instructions**: the slider line now has a non-sine example ("r = 2"
  and "x^2 + y^2 = r^2", the radius of a circle), the polar line says why
  a bare `r = …` draws nothing, and replies are asked for in plain text,
  with no LaTeX. 885 tokens (806 in 2d); tool definitions unchanged
  (1,218).
- **list_kinds** follows the reference's groups, so its order changed:
  pregion now sits right after pcurve. The forms are the same.
- **kind_examples** leads with the reference's own examples (named, one
  shape each, checked by the analyzer to draw the kind), topped up to
  three from the menu. **function_doc** adds the reference's note where
  there is one (28 functions).

**A new common check, and every file regraded.** gpt-5.5 wrote LaTeX
(`\(y=x^2\)`) in 34 of 175 replies, which the app shows raw. Every task
now fails a reply with `\(`, `\[`, a `\command` or `$…$`. Regraded with
regrade.ts: gpt-5.5 100% → 81% (141/175; the 34 runs, nothing else). No
on-device run changed (43%, 36%, 44%, 43%, 46%, run for run): the device
never wrote LaTeX. Three other check fixes, found by the new tasks'
known-good answers, changed no grade in any file: a readout written
"≈ 0.6827" was read as no number (the value check stripped only "="); a
reply calling a flow's fixed point a "saddle" failed the reply check
(saddle now also allows a vector field); "circle" for a curve of
intersection failed it too (now allowed).

**11 harder tasks (46 in all)**, because gpt-5.5 passed all 35: a fitted
regression line, a labelled vertex, a motion trail, a hyperboloid of one
sheet with waist radius 2, a vector field (−y, a·x) with a slider animated
from 1 to −1, the solid of revolution of √x on [0, 4] (bounded), a
piecewise function, the domain colouring of a function written in z (the
app's complex variable is w), a tangent that follows a slider (the
analyzer reads `d/dx f(a)` as a flat line), a normal probability within
one standard deviation, and the curve where a sphere meets a plane. Each
has known-good and known-bad answers, all rendered and read
(tasks.test.ts runs them through the analyzer).

### On-device, after the switch

**On the same 35 tasks: 41% (72/175), against 46% (81/175) in 2d.**
Repetitions 16, 15, 13, 14, 14 (±1 task). The 9 runs lost are under two
standard errors of the difference. 5.3 tool calls a run (3.4), 10,925
input tokens a session (8,626), 14.2 s (8.8); context overflows 8 (3 in
2d), all set_graph loops: polar-rose 3, cardioid 2, label-crossing 2,
slider-radius 1 (and 2 more on the new tasks).

- Up: tangent-line 0 → 4 (every pass `y = 2x - 1` with no lookup),
  honest-reply-helix 3 → 5, saddle 3 → 5, torus 4 → 5.
- Down: sphere 3 → 0, circle-and-line 3 → 0, function-draws 3 → 0,
  unit-cube-beside-sphere 2 → 0, zoom-out 3 → 1.
- **The new list_kinds order sent it to pregion.** kind_examples was
  called with "pregion" 20 times (psurface 31, pcurve 15): for "a sphere
  of radius 2" 3 runs copied its first example, the annulus
  `r = interval(1, 2); (r cos(2pi u), r sin(2pi u))`, and replied "a
  sphere of radius 2"; the circle, rose and cardioid runs did the same.
  The model picks a kind by its place in the list as much as by meaning.
- **It still copies the nearest example.** "A circle of radius 3 as a
  parametric curve": 5/5 wrote pcurve's first reference example,
  `(2cos(2pi u), 2sin(2pi u))`, "a circle of radius 2" (no longer
  hidden: the reply says 2). "A hyperboloid": the psurface page's
  helicoid, verbatim. "The curve where the sphere meets the plane z = 2":
  the spacecurve form `(x^2 + y^2 + z^2, z) = (9, 1)`, with 1 for 2.
- **The radius slider didn't take.** slider-radius stays 0/5: the runs
  added `r = 2` beside `x^2 + y^2 = 4` without using it, or a pregion.
  The new example is in the instructions, two lines from the amplitude
  one; the model doesn't adapt either.

**On the 11 harder tasks: 4% (2/55).** domain-colouring and
intersection-curve passed once each. The failures are the same kind as
above: an amplitude slider and a sine wave for the regression line and
the tangent slider, an annulus for the normal probability, the vertex at
(2, −2), `z = (x^(1/2))^2` for the solid of revolution.

### gpt-5.5: tools, old llms.txt, new llms.txt (2026-10-08)

Three runs on the same 46 tasks, the app's knowledge unchanged from the
on-device run above (measurement only):

- `results/2026-10-08T000204Z-openai-gpt-5.5.json`: the app's
  instructions and tools, 5 runs a task.
- `results/2026-10-08T024726Z-openai-gpt-5.5-reference.json`: the old
  llms.txt (15b3d4e, 113,073 bytes) after `referenceInstructions`, with
  get_graph, set_graph, move_view, animate_slider and check, 3 runs a task.
- `results/2026-10-08T002920Z-openai-gpt-5.5-reference.json`: the same
  with the new llms.txt (148,557 bytes), 3 runs a task. The account ran
  out of credit partway: 38 runs of 14 tasks failed with "no credits
  remaining". Those 14 tasks were rerun whole (3 runs each) once it was
  topped up, and their results replace the failed ones (the file's
  `rerun` field lists them).

All answered as `gpt-5.5-2026-04-23`.

**Check fixes, and every file regraded again.** Reading the failures
showed checks rejecting correct answers in ten places, listed below. All
are fixed, most with the rejected answer added to tasks.ts as known-good;
the known-bad answers still fail. No earlier file changed grade, run for run (on-device 43%,
36%, 44%, 43%, 46%, 32%; the first gpt-5.5 run 81%). The three new files
went from their graded-at-run-time 206, 125 and 122+40 to the numbers
below.
- The reply check took "shaded" to need a `prob` row, but rows report
  probabilities as "probability (shaded area)". Every correct
  normal-probability answer failed.
- "circle" failed a hyperboloid's "waist is a circle of radius 2" and a
  field whose "streamlines circle the origin". "surface" failed a solid
  ("the filled volume, not just the surface"). "marked both intersection
  points" failed when labels mark them.
- A viewport row counted as a drawn row and as a change to the rows: a
  saved `camera(…, spin = 0.3)` failed spin-3d and unit-cube.
- label-vertex wanted the label exactly on the vertex. A label set beside
  it (0.15 off) is how labels are placed; within 0.5 now passes.
- hyperboloid wanted x² + y² − z² = 4 exactly. The request fixes only
  the waist (`x^2/4 + y^2/4 - z^2/9 = 1` and `2cosh(2v−1)…` are right).
  The check now wants the waist circle of radius 2, nothing else in that
  plane nearby, and a radius past 2 at z = ±2. A cylinder of radius 2 and
  the old known-bad answers still fail.
- piecewise wanted one row through both pieces. Two bounded rows draw
  the same graph. Each point must now be on some curve, and neither
  piece may run on past 0.
- normal-probability wanted a `P(…)` row. The integral of the density,
  `int[-1..1] normalpdf(x, 0, 1) dx`, shades the same area with the same
  value, so either now passes.
- regression-line wanted a `~` fit row. The least-squares line worked
  out (`y = 1.9x + 0.9`) is the same line, so only the line is checked.

One false positive is left as it is: "every arrow is tangent to a circle"
fails the reply check ("tangent" with no tangent line). It is 1 run, in
the old-llms.txt run on vector-field. A keyword check will always have
some.

**Spend: about $27.60**, from the runs' token counts at $5 / $0.50 cached
/ $30 per million:

| run | cost |
| --- | --- |
| smoke tests (3 one-run tasks) | $0.48 |
| tools, 230 runs | $5.80 |
| new llms.txt, 138 runs | $8.69 |
| new llms.txt, rerun of 14 tasks, 42 runs | $3.41 |
| old llms.txt, 138 runs | $9.21 |

The failed runs cost nothing. An llms.txt run is about $0.065: 1.8 calls
of about 145K tokens (new) or 108K (old), 99% from the prompt cache.

### Summary on the 46 tasks

| | on-device (step 3) | gpt-5.5 tools | gpt-5.5 old llms.txt | gpt-5.5 new llms.txt |
| --- | --- | --- | --- | --- |
| runs a task | 5 | 5 | 3 | 3 |
| pass, 46 tasks | 32% (74/230) | 96% (221/230) | 98% (135/138) | 96% (133/138) |
| tasks passed per repetition | 16, 16, 13, 14, 15 | 45, 45, 43, 44, 44 | 45, 45, 45 | 44, 44, 45 |
| first 35 tasks | 41% (72/175) | 100% (175/175) | 97% (102/105) | 98% (103/105) |
| 11 harder tasks | 4% (2/55) | 84% (46/55) | 100% (33/33) | 91% (30/33) |
| tool calls a run | 5.4 | 2.7 | 1.8 | 1.8 |
| input tokens a session (cached) | 11,867 | 8,031 (4,795) | 107,579 (105,790) | 145,160 (143,897) |
| output tokens a run | 154 | 221 | 164 | 170 |
| seconds a run | 14.4 | 7.1 | 5.7 | 6.7 |
| runs that ended in an error | 11 (overflows, tool errors) | 0 | 0 | 0 |
| spend | – | $5.80 | $9.21 | $12.10 |

No gpt-5.5 reply in these runs wrote LaTeX (34 of 175 did before the
instructions asked for plain text).

Per task, where any column missed:

| task | on-device | tools | old llms.txt | new llms.txt |
| --- | --- | --- | --- | --- |
| tangent-line | 4/5 | 5/5 | 1/3 | 1/3 |
| vector-field | 5/5 | 5/5 | 2/3 | 3/3 |
| intersection-curve | 1/5 | 5/5 | 3/3 | 1/3 |
| regression-line | 0/5 | 2/5 | 3/3 | 2/3 |
| motion-trail | 0/5 | 0/5 | 3/3 | 3/3 |
| tangent-slider | 0/5 | 4/5 | 3/3 | 3/3 |

**Old against new llms.txt: no difference that shows at 3 runs.**
135 against 133 of 138. Every per-task difference is one run, or two in
intersection-curve:
- intersection-curve 3 → 1: two new-llms.txt runs replaced the sphere
  and the plane with `(x^2 + y^2 + z^2, z) = (9, 2)`, "I replaced the
  two surfaces with their intersection curve". The curve is right; the
  rows the request didn't touch were dropped. A model slip. Nothing in
  either file says to replace rows, and the same mistake doesn't appear
  elsewhere.
- regression-line 3 → 2: one run wrote the data row without its closing
  `]`, a typo.
- vector-field 2 → 3: the old run's "tangent to a circle" false positive
  (above).
- tangent-line 1/3 in both: the runs restructured `y = x^2` into
  `f(x) = x^2; y = f(x)` before adding the tangent. Both files' guidance
  for assistants says to do exactly that ("prefer restructuring into named
  definitions"), and the app's instructions say to keep every other row.
  A knowledge conflict that the new file keeps. The one old-file run that
  also failed the line wrote `(d/dx f(x))(a)`, a product with a.

What the new file was meant to fix (a name before every formula, one
shape per example, guidance first) didn't move gpt-5.5, which already
read the old file correctly. It costs 35% more tokens a call. The
on-device copying failures it was aimed at aren't measurable with a
reference this size: it doesn't fit 8K.

**What gpt-5.5 still fails on the harder tasks (with tools):**
- motion-trail 0/5 is knowledge. Every run drew the whole path as a
  parametric curve, `(2cos(2pi u), sin(4pi u))`, "the full trail of the
  moving point". With either llms.txt in context all 6 runs wrote
  `trail(A)`. With tools it never looked a kind up: the instructions don't
  mention trails, and list_kinds is only consulted for shapes it doesn't
  know.
- regression-line 2/5 is model. All 5 runs worked out the right line,
  y = 1.9x + 0.9, by hand. 3 left the data list `P` undrawn, which the
  app warns about ("this defines P, but no other row uses it").
- tangent-slider 4/5 is model, a valid-but-wrong formula: one run wrote
  `y = f(a) + (d/dx f(a))(x - a)`, which differentiates a constant, so
  the line is flat. The other four wrote the slope out, `(3a^2 - 3)`.
- label-vertex, hyperboloid, piecewise and normal-probability failed
  only on the check fixes above, and all pass now.

## Kind names in the instructions (2026-10-08)

**A single-task test, not a suite measurement**: motion-trail only,
on-device only, 5 runs. gpt-5.5 was not run.

The change (bd43f888): the instructions name every kind, a line per
reference group, generated from docs/reference/ (lib/reference.ts
kindNames), and the lookup line now reads "call kind_examples for the kind
you need (listed below; list_kinds gives each one's smallest form)".
kind_examples also takes a kind's name ("motion trail"): most names didn't
resolve before. Tools and every other line unchanged. Instructions 885 →
1,106 tokens (+221; tools 1,218).

```
Kinds:
- 2D curves and regions: curve, region, parametric curve, parametric region, swept region, system of equations
- Points, figures and labels: point, geometric figure, label, motion trail
- Readouts and families: value readout, true/false readout, family
- 3D: surface, parametric surface, parametric solid, curve of intersection
- Fields: vector field, vector field in space, scalar field, scalar field in space
- Sequences and simulations: sequence, cobweb diagram, bifurcation diagram, orbit, cellular automaton
- Lists and data: number list, point list, histogram, data column, data scatter, tuple readout
- Probability: random variable, discrete random variable, probability, expectation
- Complex functions: complex function, domain colouring, conformal map, escape-time fractal
- Colour fields: RGB colour field, HSL colour field, OKLCH colour field
- Algebra: matrix field, multivector, line or plane, matrix action, graph (network), table
```

`results/2026-10-08T032737Z-on-device.json` against motion-trail in
`results/2026-10-07T230237Z-on-device.json`:

| | before | kind names |
| --- | --- | --- |
| pass | 0/5 | 5/5 |
| tool calls a run | 2.6 | 2.4 |
| input tokens a session | 8,774 | 7,514 |
| seconds a run | 6.3 | 5.6 |
| overflows | 0 | 0 |

Before, 3 runs never looked a kind up or looked up the wrong one
(kind_examples "parametric" twice, "psurface" once) and left the point
alone or added `y = 2cos(t)`, `z = sin(2t)`; one found `trail` through
list_kinds but copied the example's point, `A = (2cos(3t), 2sin(2t))`,
over the user's. After, all 5 runs called kind_examples("motion trail")
first and wrote `A = (2cos(t), sin(2t))`, `trail(A)`, replying e.g. "I
drew a point moving in a looping path, with its motion trail behind it."

Verdict: on this one task the names send the device straight to the right
kind, 0/5 → 5/5, for 221 tokens, and the session is shorter. Whether it
costs elsewhere (a name in the list pulling the model to the wrong kind, as
list_kinds' order did with pregion) needs the 46-task run on both models.

### Kind names: the full on-device suite

`results/2026-10-08T035827Z-on-device.json`, all 46 tasks, 5 runs each, against
`2026-10-07T230237Z-on-device.json`: 32% ±3% → **36% ±3%** (72 → 82 of 175, 41% → 47%, on the
first 35 tasks; the gain is within noise). Context overflows went from 10 to 17.
Up: circle-and-line 0 → 4, parametric-circle 0 → 4, derivative 0 → 4. Down:
honest-reply-helix 5 → 1, torus 5 → 3.

motion-trail passed only 1/5 here (5/5 in the single-task test). Three runs
called kind_examples("parametric region") rather than "motion trail", and four
ended in a loop of 20–45 set_graph calls until the 8K context overflowed. In
honest-reply-helix four runs called kind_examples("helix"), which isn't a kind
name: the tool answered "No kind" with the list of ids, and the model then wrote
rows like `u = 0` and `x = cos(u)` and called them a helix.

## Kind chart in the instructions (2026-10-08)

The change (940d45b3): the 2D and 3D lines of the kind-name list became a
chart of each kind's id, as check and set_graph report it, and its form in
placeholder syntax (`- psurface: (uv, uv, uv)`, `- ineq2d: xy > 0, xy >= 0`),
with slider, family and motion lines; the other six groups stay as names under
"Other kinds (names only):". A test draws an instance of every chart line as
its kind (lib/assistant-instructions.test.ts). Instructions 1,106 → 1,401
tokens (+295; tools 1,218).

unit-cube alone (`results/2026-10-08T060509Z-on-device.json`): 0/5, as before.
Two runs copied the chart's notation into rows: `psurface: (uv, uv, uv)`,
then seven set_graph calls nesting it until the context overflowed, and
`psurface((0,0,0), (0,0,0), (0,0,0))`. Two looked up psurface and drew the
example's sphere; one drew `z = x^2 - y^2` and three planes.

Full suite, `results/2026-10-08T060822Z-on-device.json`:

| | before names | kind names | kind chart |
| --- | --- | --- | --- |
| pass | 32% ±3% (74) | 36% ±3% (83) | 33% ±4% (75) |
| first 35 tasks | 72/175 | 82/175 | 72/175 |
| overflows | 10 | 17 | 9 |
| input tokens a session | 12,463 | 10,575 | 9,402 |
| tool calls a run | 5.4 | 4.8 | 3.5 |
| kind_examples("psurface") | 31 of 104 | 43 of 105 | 72 of 111 |

Down against kind names: parametric-circle 4 → 0, circle-and-line 4 → 1,
saddle 5 → 2, honest-reply-helix 1 → 0 (5/5 before names), motion-trail
1 → 0. Up: zoom-out 1 → 3, label-vertex 0 → 2.

The losses share a cause: with kinds now named by id, the model asks
kind_examples for "psurface", the id in that tool's description, whatever the
request. It did so in 19 tasks. parametric-circle 5/5 looked up psurface and
drew the example sphere, "I drew a sphere of radius 3 as a parametric
surface"; honest-reply-helix 5/5 drew the helicoid
`(2v cos(4pi u), 2v sin(4pi u), 3u)`; saddle 3/5 drew the example sphere
and called it the saddle; motion-trail 4/5 looked up psurface and left
`A = (2cos(t), sin(2t))` without a trail. Copying the notation itself was
rare in the suite: `solid: (interval(0, 1), …)` twice in
unit-cube-beside-sphere, `pregion: (r, 1)` once in normal-probability.
circle-and-line's losses are `A = 2` and `r = 2 (cos(u), sin(u))` for the
circle. The gains are a point and its label kept with the parabola
(label-vertex) and wider windows (zoom-out), neither near the chart.

Verdict: no gain. 33% is within noise of both earlier runs, and the first 35
tasks fell back from 82 to 72 of 175. Sessions are shorter (fewer calls and
overflows, 1,173 fewer input tokens) despite 295 more instruction tokens.
The chart's ids made kind_examples("psurface"), the tool description's
example, the default lookup (72 of 111 calls). Measure again after that
example changes before judging the chart itself; the colon form also wants a
watch, as unit-cube copied it twice in five.

### No example kind in kind_examples' argument

`5f894353` changed the argument's description from `A kind from list_kinds, e.g.
"psurface".` to `A kind from the Kinds list in the instructions.`; nothing else.
`results/2026-10-08T070319Z-on-device.json`, 46 tasks × 5, against the kind
chart run (`2026-10-08T060822Z`): 33% ±4% → **37% ±3%** (85/230; 80/175 on the
first 35 tasks), within noise. "psurface" lookups fell from 72 of 111 to 21 of
120. Overflows rose from 9 to 15; tool calls a run from 3.5 to 4.9.
Up: saddle 2 → 5, circle-and-line 1 → 3, points 1 → 3, shade-region 1 → 3.
Down: derivative 4 → 1, zoom-out 3 → 0. Still 0/5: unit-cube, slider-radius,
parametric-circle, polar-rose, cardioid, sphere, cone, moving-point.

### A 12-call cap in the runner

`ac3f28a6`: a run fails at its 13th tool call (evals only; the app has no
limit). `results/2026-10-08T084753Z-on-device.json`, same knowledge as the run
before it (`2026-10-08T070319Z`): 37% ±3% → 34% ±3% (85 → 78 of 230), 23 runs
stopped by the cap, overflows 15 → 1, and the suite took **38 minutes instead
of 58**. Nothing the model sees changed, so the 3-point drop is run-to-run
noise: a useful reminder that two runs of identical code differ by that much.

### Well-known shapes as equations

`dac88c4c` adds one line to the instructions: a shape with a well-known
equation (circle, ellipse, sphere, cone, hyperboloid, paraboloid) is written as
that equation, e.g. an ellipse is x^2/9 + y^2/4 = 1. `results/2026-10-08T101038Z-on-device.json`:
34% ±3% → 33% ±5%, noise. hyperboloid stayed 0/5: it stopped copying the
helicoid, but 4 of 5 single-task runs copied the chart's placeholder `xy = 0`
as a row (a constant named xy). color-red fell 5 → 0 because every run wrote
`#ff`, a two-digit color the renderer silently ignores; nothing in this change
touches colors.

### The kind chart with real examples

`93020f27` replaces the chart's placeholders (`xy = 0`, `(uv, uv, uv)`) with a
small real example per kind (`x + y = 1`, `(u, v, u v)`), none a task's answer.
`results/2026-10-08T105415Z-on-device.json`: **42% (97/230)**, against 33%
(77/230) for the run before it, the largest on-device gain so far and about
twice the 4-point spread between two runs of identical code (`084753Z`,
`070319Z`). unit-cube went 0 → 4 of 5, every pass
`(interval(0, 1), interval(0, 1), interval(0, 1))` (the fifth had a trailing
comma). color-red 0 → 5 and shade-region 1 → 4. The model still copies the
chart: hyperboloid drew `x + y + z = 1`, and 2 vector-field runs wrote
`vfield2d = x`.

**Check fix, all files regraded.** vector-field only checked the kind, so the
chart's example `(y, x)` passed for "(−y, x)", and so did `(x, -y)` in earlier
runs. It now requires `(-y, x)`. On-device files moved by up to 5 runs (the
step 3 run 74 → 69, the kind chart run 75 → 71, the no-example run 85 → 81);
the comparisons above use the regraded numbers.

### set_graph's intent

`dd5d6857` adds an `intent` argument to set_graph, generated before the rows
("what the rows will draw, and which kind of row each one is"), as a stand-in
for reasoning, which the on-device model doesn't support.
`results/2026-10-08T113304Z-on-device.json`: 42% ±2% → 40% ±3%, noise, for 35
more tool-definition tokens. The intents mostly restate the request rather than
plan the rows ("Draw a unit cube in 3D with edges from 0 to 1 in all
directions" → `z = x^2 - y^2`, `x = 0`, `y = 0`, `z = 0`), and rows often
contradict them ("Add two curves: the cubic and its derivative" →
`f(x) = x^3 - x`, `y = d/dx f(x)`, one curve). unit-cube 4 → 1, derivative
5 → 1; parametric-circle 1 → 4.

### No intent; z = x y in the primer; trailing commas trimmed

`d50cb7d3` removes set_graph's intent (and a kindReason variant: 3/10 on
unit-cube, the same as without it). `3bd0e7b6` changes the primer's 3D surface
from `z = x^2 - y^2` to `z = x y`, and `da191b86` drops a trailing comma from a
row. `results/2026-10-08T210936Z-on-device.json`: 42% ±2% → **44% ±5%**, noise,
but the best so far. parametric-circle 1 → 5, zoom-zero 0 → 3; sphere 3 → 0,
motion-trail 2 → 0. saddle still passes (its request gives the equation).

### The primer without task answers, 10 runs a task

`9374ea55` replaced three primer examples that were eval answers verbatim:
`x^2 + y^2 = 4` (circle-and-line), `y < x^2` (the mirror of shade-region's
`y > x^2`) and `int[0..pi] sin(x) dx` (area-under-sin). Instructions 1,528 →
1,526 tokens. `results/2026-10-08T220125Z-on-device.json`, **10 runs a task**
(460 runs), against `2026-10-08T210936Z` (5 runs a task, 230):
44% ±5% (101/230) → **44% ±5% (203/460)**; tasks passed per repetition 17–25.
3.2 tool calls a run (3.5), 9,389 input tokens a session (8,717), 9.4 s a run
(11.8), one context overflow in each.

The three tasks didn't need the answers in the primer: circle-and-line 5/5 →
10/10 (`circle((0,0),2)` 7 times, `x^2 + y^2 = 4` 3), shade-region 5/5 → 10/10
(`y > x^2` every run), area-under-sin 4/5 → 10/10 (`int[0..π] sin(x) dx` 9
times: the analyzer reads π). Other differences are within what 5 runs can
tell: saddle 4/5 → 10/10, torus 4/5 → 10/10, label-vertex 1/5 → 6/10, zoom-out
4/5 → 2/10, parametric-circle 5/5 → 7/10. Named shapes stay the weak spot:
polar-rose 0/10, lissajous 0/10, cone 0/10, hyperboloid 0/10, cardioid 1/10,
sphere 1/10, honest-reply-helix 2/10.

Verdict: removing the answers cost nothing, and this run is the baseline (10
runs a task) for the next change.

## Named shapes: a catalogue and a shape tool (2026-10-09)

`5c434305` adds `docs/reference/shapes.md`, 35 named curves and surfaces
(circle, disc, ellipse, parabola, hyperbola, cardioid, limaçon, rose,
lemniscate, Archimedean and logarithmic spirals, astroid, cycloid, Lissajous
curve, catenary, folium of Descartes, helix, trefoil knot, plane, sphere, ball,
ellipsoid, cylinder, cone, paraboloid, hyperbolic paraboloid, both
hyperboloids, torus, Möbius strip, catenoid, helicoid, cube, tetrahedron,
octahedron), each with aliases, forms in named parameters, the kind each draws
and one instance with neutral numbers (tasks.test.ts checks none is a task's
answer). It is generated into /docs/shapes/, llms.txt and assistant.json.
`326a53e1` adds the `shape(name)` tool (the entry, a few lines; on a miss,
every name) and one instruction line: "For a named curve or surface, call shape
with its name first, and adapt its form to the request." Instructions 1,526 →
1,549 tokens (+23), tools 1,214 → 1,300 (+86).

`results/2026-10-08T231719Z-on-device.json`, 10 runs a task, against the
primer run above (`2026-10-08T220125Z`): **44% ±5% (203/460) → 37% ±3%
(171/460)**, tasks passed per repetition 15–20 (17–25). 2.7 tool calls a run
(3.2), 8,357 input tokens a session (9,389).

shape was called in 148 of 460 runs (159 calls), always with a sensible name:
sphere 22, cardioid 16, cube 11, circle 11, helix, polar rose, saddle, torus,
cone and "hyperboloid of one sheet" 10 each, plane 8, solid 7, domain colouring
7 (a miss), Lissajous 5. It never missed a named-shape task.

**The tool's answer reads as done.** In 78 of the 148 runs the model called
shape and then replied without calling set_graph: "I drew a torus, a
doughnut-shaped ring" over an empty graph. That is every run of saddle 10 → 0
and torus 10 → 0, cone 10/10, cardioid 9/10, hyperboloid 8/10, sphere 7/10,
unit-cube 6/10, parametric-circle 5/10. Its reply often paraphrases the entry
("two nappes sharing a common apex").

**It copies the kind label.** The answer's `kind: ["rows"]` lines were written
into rows: `solid: (interval(0,1), interval(0,1), interval(0,1))` in
unit-cube (4/10), `pcurve: [(1.5*cos(10*pi*u), …)]` and the helix's whole
heading in honest-reply-helix, `solid: (…)` in solid-of-revolution. kind_examples
learned the same lesson (rows first, then the label).

**Where it drew, it mostly adapted.** sphere 1 → 3 (all three `x^2 + y^2 + z^2 =
4`, from the entry's `= 9`), honest-reply-helix 2 → 8 (the instance verbatim 5
times, with the turns changed 3 times), lissajous 0 → 3 (the instance, the
form with its parameters defined, and once a = b, an ellipse that fails),
hyperboloid 0 → 1. cardioid's one drawing copied the instance (r = 2(1 + cos θ)
for r = 1 + cos θ).

Elsewhere: motion-trail 3 → 0 (6 runs called shape("cardioid") for "the path
the point leaves behind" and stopped), slider-radius 0 → 9 (`a = 2`,
`x^2 + y^2 = a`, a slider on r², which the check accepts; nothing in this change
explains it), label-vertex 6 → 0 (points at (2, ±1) and (2, 0), no shape call)
and color-red 9 → 4 (`#ff` again, no shape call): run-to-run noise or a shift
from the new line, not the catalogue.

Verdict: a loss, 7 points, from one cause: the model treats shape's answer as
having drawn the shape. The lookup itself works (right names, right entries,
adaptation where it drew). Next: rows first in the answer, and say it draws
nothing.

### shape's answer says it draws nothing

`1d698120`: each form's rows come first, its kind after (`- ["…"] (psurface)`),
the answer ends "Nothing is drawn yet: adapt a form to the request and pass its
rows to set_graph.", the tool description adds "It draws nothing: set_graph
draws.", and the instruction line now reads "…call shape with its name first,
then draw its form, adapted to the request, with set_graph." Instructions 1,556
tokens (+30 over the primer run), tools 1,309 (+95).

`results/2026-10-09T002200Z-on-device.json`, 10 runs a task: **45% ±3%
(209/460)**, against 44% ±5% (203/460) for the primer run and 37% for the first
shape run; tasks passed per repetition 19–23. 2.7 tool calls a run, 8,851 input
tokens a session, three context overflows (one before). Mean seconds a run
are 27 because of one 1,038 s run (the machine slept); the median is 6.3 s.

| | primer (220125Z) | shape (231719Z) | shape, draws nothing (002200Z) |
| --- | --- | --- | --- |
| pass | 44% ±5% (203) | 37% ±3% (171) | 45% ±3% (209) |
| 10 named-shape tasks | 25/100 | 17/100 | 36/100 |
| the other 36 tasks | 178/360 | 154/360 | 173/360 |
| runs calling shape | – | 148 | 172 |
| of those, no set_graph after | – | 78 | 7 |

Named-shape tasks, primer → this run: honest-reply-helix 2 → 9, lissajous
0 → 6, cone 0 → 5, parametric-circle 7 → 9, hyperboloid 0 → 2, torus 10 → 4,
unit-cube 4 → 1, sphere 1 → 0, cardioid 1 → 0, polar-rose 0 → 0. shape was
called with the right name every time (sphere 19, circle 17, cardioid 12, cube
11, helix, polar rose, saddle, torus, cone, "hyperboloid of one sheet" 10 each);
it was also asked for "solid" 10 times (solid-of-revolution, a miss) and for
"path" and "cardioid" in motion-trail, which stays 0/10.

**Adapt or copy:** it adapts a parameter the request names as a word and copies
the instance when the request gives numbers.
- Adapted: parametric-circle 8 × `(3 cos(2pi u), 3 sin(2pi u))` from the
  entry's radius 1.5; lissajous `(sin(2pi u + 0.5), sin(4pi u))` (a = 1, b = 2);
  cone 5 × `x^2 + y^2 = z^2` with `z = sqrt(x^2 + y^2)` (k = 1, both forms).
- Copied: cardioid 10/10 drew the instance, r = 2(1 + cos θ), for "r = 1 + cos
  θ"; unit-cube 5 × `(interval(-1, 1), …)`, a cube of side 2; hyperboloid 3 ×
  both waist-3 instances; helix 9 × the instance (passes: any helix does).
- Adapted wrongly: sphere 10/10 wrote `x^2 + y^2 + z^2 = 8` for radius 2 (R^2
  squared as 2 × 2 × 2, or the entry's 9 minus 1), replying "radius 2".
  polar-rose kept θ's factor in both components, `(sin(4*2pi*u) cos(4*2pi*u),
  …)`, despite the pitfall.
- Drew every form: torus, cone and hyperboloid runs often set both of the
  entry's forms as two rows; torus lost 6 of 10 to a broken second row (`a
  sin(2pi v)` with `a` undefined, `cos(2pi u), sin(2pi u)`).

Verdict: with the fix, no loss overall (45% against 44%, within noise) and a
gain on named shapes (25 → 36 of 100), with the other tasks flat (178 → 173 of
360, noise). Not the step change hoped for: the model now finds the right entry
and draws, but copies its numbers or draws every form. Next candidates: one
form per entry in the answer (the one the request's word implies, implicit
first), instances that state their numbers next to the parameters ("R = 3:
x^2 + y^2 + z^2 = 9"), and checking arithmetic like R^2 with check's value
readout.

**Check fix, all files regraded (2026-10-09).** lissajous wanted "a 2D curve
that is not an ellipse (its frequencies differ)", but tested only for an
ellipse with its axes along x and y: a tilted ellipse, `(sin(2pi u + 0.5),
sin(2pi u))`, and the segment `(sin(2pi u), sin(2pi u))` passed, both with
equal frequencies, copied from the shape entry's form with a = b = 1. It now
also requires x and y to turn back a different number of times; both are
known-bad answers, and `(sin(6pi u + 0.5), 2sin(4pi u))` a known-good one.
Regraded with regrade.ts, only lissajous changed, in four files:
`2026-10-08T035827Z` 83 → 82, `2026-10-08T231719Z` (the first shape run)
171 → 170 (37%), `2026-10-09T002200Z` (the run above) 209 → 206 (45% ±4%;
lissajous 6 → 3, the named-shape tasks 36 → 33) and the step below.

## One form per shape (2026-10-09)

`a621d013`: shape answers one form per entry, the equation (implicit2d or
implicit3d) where the entry has one, else its first; /docs/ and llms.txt keep
every form. Instructions and tools unchanged (1,556 and 1,309 tokens). The
answer for "hyperboloid":

```
Hyperboloid of one sheet (also hyperboloid, one-sheeted hyperboloid, cooling tower): A connected surface with a narrow circular waist that flares out above and below.
- ["x^2/a^2 + y^2/a^2 - z^2/c^2 = 1"] (implicit3d) — about the z-axis
  a: the radius of the waist, the circle at z = 0
  c: the height scale: larger c flares more slowly
  e.g. ["x^2/9 + y^2/9 - z^2/4 = 1"] — waist radius 3
Pitfall: one minus sign gives one sheet; two minus signs give two sheets. With no z term it is a cylinder.
Nothing is drawn yet: adapt this form to the request and pass its rows to set_graph.
```

`results/2026-10-09T052258Z-on-device.json`, 10 runs a task, against
`2026-10-09T002200Z` (regraded): **45% ±4% (206/460) → 45% ±3% (205/460)**;
named-shape tasks 33 → 31 of 100, the other 36 tasks 173 → 174 of 360. shape
called in 182 runs, 2 without a set_graph after.

- Up: torus 4 → 7 (`(sqrt(x^2 + y^2) - 3)^2 + z^2 = 1`, the instance: one row
  now, where both forms broke it before), hyperboloid 2 → 5 (5 ×
  `x^2/4 + y^2/4 - z^2/4 = 1`, adapted; 4 × the instance), sphere 0 → 4
  (`x^2 + y^2 + z^2 = 4`; still 5 × `= 8`).
- Down: parametric-circle 9 → 1. The request asks for a parametric curve and
  the answer now shows only the equation: `circle((0, 0), 3)` 5 times,
  `x^2 + y^2 = 9` 3 times. honest-reply-helix 9 → 7, unit-cube 1 → 0 (8 × the
  side-2 instance).
- cardioid stays 0/10, now from the equation: 8 ×
  `(x^2 + y^2 - 1)^2 = 1(x^2 + y^2)`, a = 1 substituted but the `- a x` term
  dropped. (The check wants a parametric curve; a correct equation would fail
  it too, but none was written.) lissajous 3/10: a = b = 1 in 6 runs despite
  "equal to a, it is only an ellipse".

Verdict: no change overall. One form ends the both-forms rows (torus,
hyperboloid up) but costs requests that name the other form
(parametric-circle). Copying the instance's numbers is unchanged.

## Instances that name their values (2026-10-09)

`22cd1fe5`: every instance in shapes.md names its parameters' values, and
shape shows them before the rows, so the substitution is visible:
`e.g. a = 3, c = 2 → ["x^2/9 + y^2/9 - z^2/4 = 1"]`. Instances that weren't the
form with values put in now are (the cube's side-2 box is `(interval(0, 2), …)`,
the cylinder's `4v`, the ellipsoid's c = 1.5, the cone's `(0.5z)^2`; a script
checked every substitution numerically). Instructions and tools unchanged.
The answer for "hyperboloid":

```
Hyperboloid of one sheet (also hyperboloid, one-sheeted hyperboloid, cooling tower): A connected surface with a narrow circular waist that flares out above and below.
- ["x^2/a^2 + y^2/a^2 - z^2/c^2 = 1"] (implicit3d) — about the z-axis
  a: the radius of the waist, the circle at z = 0
  c: the height scale: larger c flares more slowly
  e.g. a = 3, c = 2 → ["x^2/9 + y^2/9 - z^2/4 = 1"]
Pitfall: one minus sign gives one sheet; two minus signs give two sheets. With no z term it is a cylinder.
Nothing is drawn yet: adapt this form to the request and pass its rows to set_graph.
```

**Two check fixes, all files regraded.** Both rejected right answers the shape
entries led to:
- cone passed an equation only through (1, 0, 1), (0, 2, 2) and (3, 4, 5),
  so only a 45° cone: `x^2 + y^2 = (0.5z)^2` and `z = sqrt(x^2 + y^2)/2` are
  cones too. It now finds the slope along x at z = 1 and wants the surface
  crossed at that slope times z all the way round, at three heights; the
  saddle, `z = sqrt(x^2 - y^2)` and the other known-bad answers still fail,
  `x^2 + y^2 = (0.4z)^2` is a new known-good one.
- cardioid wanted a parametric curve, but the request ("plot the cardioid
  r = 1 + cos θ") is met by its equation, `(x^2 + y^2 - x)^2 = x^2 + y^2`,
  now a known-good answer: an implicit curve passes when it is crossed at
  r = 1 + cos θ in six directions and nowhere between. The device's
  `(x^2 + y^2 - 1)^2 = 1(x^2 + y^2)` and the a = 2 instance are known-bad.
Regraded with regrade.ts: only these two tasks changed, in two files. One
form per shape (`2026-10-09T052258Z`) 205 → 210 (46% ±3%; cone 4 → 9, the
named-shape tasks 31 → 36), and this step's run below (cone 0 → 8, cardioid
0 → 8). No earlier file changed.

`results/2026-10-09T063021Z-on-device.json`, 10 runs a task, against
`2026-10-09T052258Z` (regraded): **46% ±3% (210/460) → 49% ±4% (225/460)**,
the best on-device result so far; tasks passed per repetition 20–26.
Named-shape tasks 36 → 54 of 100; the other 36 tasks 174 → 171 of 360.
shape called in 180 runs, 1 without a set_graph after.

Adapted, the substitution done as shown:
- unit-cube 0 → 7: `(interval(0, 1), interval(0, 1), interval(0, 1))` from
  "a = 2 → (interval(0, 2), …)" (unit-cube-beside-sphere 2 → 6 too).
- hyperboloid 5 → 9: `x^2/4 + y^2/4 - z^2/4 = 1` (a = 2, c = 2), 9 runs.
- sphere 4 → 6: `x^2 + y^2 + z^2 = 4` 6 times; `= 8` only once now (5 before).
- cardioid 0 → 8: `(x^2 + y^2 - 1x)^2 = 1(x^2 + y^2)`, a = 1 put in
  everywhere (the a x term was dropped in step 1).

Copied: cone 9/10 drew the instance, `x^2 + y^2 = (0.5z)^2` (a cone, so it
passes); helix 7 × the instance; torus 5/10, all the instance (the failures
are the same rows with a reply that misnames them). Not helped: polar-rose
0/10 (`(sin(4pi u) cos(4pi u), …)`: θ's factor in both components),
parametric-circle 0/10 (`x^2 + y^2 = 9`: the one form shown is the equation),
lissajous 3/10. Elsewhere, shift-up 9 → 5 and color-red 10 → 7 (`#ff` again)
moved without shape calls.

Verdict: a gain. Showing the values next to the instance turned copying into
substitution on cube, hyperboloid, sphere and cardioid (named-shape tasks
36 → 54), with the rest flat.

## No instance (2026-10-09), reverted

`2acb2e58`: shape answers the form and what each parameter sets, with no
instance. The answer for "hyperboloid":

```
Hyperboloid of one sheet (also hyperboloid, one-sheeted hyperboloid, cooling tower): A connected surface with a narrow circular waist that flares out above and below.
- ["x^2/a^2 + y^2/a^2 - z^2/c^2 = 1"] (implicit3d) — about the z-axis
  a: the radius of the waist, the circle at z = 0
  c: the height scale: larger c flares more slowly
Pitfall: one minus sign gives one sheet; two minus signs give two sheets. With no z term it is a cylinder.
Nothing is drawn yet: adapt this form to the request and pass its rows to set_graph.
```

`results/2026-10-09T073554Z-on-device.json`, 10 runs a task, against the
values run (`2026-10-09T063021Z`): **49% ±4% (225/460) → 47% ±4%
(217/460)**; named-shape tasks 54 → 45 of 100, the other 36 tasks 171 → 172.
shape called in 176 runs, every one followed by set_graph.

- Where the request gives the value, the bare form is enough: unit-cube 7 → 9,
  sphere 6 → 8 (`x^2 + y^2 + z^2 = 4` 8 times), cone 8 → 9 (`x^2 + y^2 =
  z^2`), torus 5 → 7 (often the form itself with `R = 1`, `a = 1` defined as
  sliders, which draws), hyperboloid 9 → 8.
- Where it doesn't, the model has nothing to work from: honest-reply-helix
  8 → 0 (`(cos(2pi u), sin(2pi u), u)` beside an unused `A = 1`, `(u, u^2,
  u^3)`, `(1, 1, 0)`), and cardioid 8 → 0: without "a = 2 → …" beside it the
  substitution breaks again (`(x^2 + y^2 - 1)^2 = 1*(x^2 + y^2)`, the a x
  term dropped, as in the one-form step).
- polar-rose 0/10 now copies the pitfall's own example: "r = sin(5θ) is
  `sin(10pi u)`" became `(sin(10pi u) cos(10pi u), …)` 4 times. A pitfall's
  example is copied like any other.

Verdict: worse than the step before (named shapes 54 → 45), so reverted: the
instance with its values stays in shape's answer.
