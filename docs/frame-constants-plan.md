# Frame constants: computing named values once per frame

Plan, 2026-10-06. Status: **stages 1 and 2 built** (see "As built" at the
end of each).

## The problem

Expressions are trees with no binding form. A subtree used ten times is ten
subtrees to the size limit (lib/size.ts, 8192 nodes per drawn element), to
the CPU evaluator, and to the GLSL a shader is compiled from. Algebra over
symbolic coefficients therefore grows multiplicatively: a product of two
values costs about the sum of their sizes for every term it has.

PGA motors made this concrete (docs/pga.md, "As built (phases 4–5)"). A
motor about an axis through draggable points `A`, `B` has coefficients that
are formulas in `A_x … B_z` and `t`. Built and applied with generic
products it ran to ~10⁵ nodes for the motor and ~7.5 × 10⁵ for one moved
point. PR 2 cut that to ~5k with closed forms and special cases, but moving
a line still does not fit, and `slerp` between motors about moving axes is
refused.

The same ceiling sits over rotors, quaternion slerps and matrix
exponentials; motors only hit it first.

## The observation

Those coefficients depend on sliders, points, states and `t` — never on
`x, y, z, u, v` or a list. They are the same for every pixel and every
vertex of a frame. The app already has the mechanism for such values: a
named point `P = (cos(t), sin(t))` is stored as hidden component constants
`P_x`, `P_y` (lib/defs.ts), which

- `evaluateFrame` (lib/env.ts) evaluates once per frame on the CPU,
- the compiler binds as shader uniforms (`u_P_x`) like any slider,
- carry `t` and animation (`th = 2pi sin(t/2)` already works this way),
- the /g/ preview, readouts and certification read from the same env.

So a named motor (or line, plane, multivector, matrix) can store each of its
coefficients as a hidden constant, and the node written into rows carries
variables instead of formulas.

Measured with the coefficients as variables (motor about a draggable axis,
with a slide):

| | inline (PR 2) | as constants |
|---|---|---|
| move a point | 5,164 nodes | 510 |
| move a line | 109,019 (too large) | 7,771 |
| draw the motor's axis | 5,317 | 1,355 |
| log, for slerp | 18,652 | 2,932 (relative motor hoisted too) |

## Stage 1 — named values (this PR)

- In lib/defs.ts, where a definition's lowered value is a `[pga]` line,
  plane or motor, an `[mv]` multivector or quaternion, or a matrix or
  tensor, each coefficient that is **frame-constant** and not already a
  number or a single variable becomes a hidden constant, and the stored
  value refers to it.
- **Frame-constant**: its free variables are all constants (sliders, point
  components, other hidden constants), states or `t`, and it holds no list,
  data column or interval. Anything else stays inline, as today.
- **Names** are `M#3`: a character the tokenizer never produces, so a row
  can neither name nor collide with one. `uniformName` already encodes any
  character into a valid GLSL identifier.
- **Kind stability**: a coefficient that is the literal `0` stays the
  literal `0`. Kinds (a multivector's grades, a motor's slide factor)
  depend on structural zeros, never on values.
- **Visibility**: hidden constants must not appear as sliders, handles,
  autocomplete entries, hover cards or MCP readouts. Audit every
  enumeration of `defs.consts` / `env.consts` (syntax-help, orbit, state,
  analysis) and skip names containing `#`.

Tests: node counts for the screw and for moving a line about a draggable
axis; slerp between named motors about moving axes; kind stability under
a slider at 0; a row animates through a hidden constant that depends on
`t`; `d/dt` through one (coordinate flows); hidden names never in
autocomplete; uniform counts of the screw example's shaders; every
existing example identical except where a row names one of these values.

## Stage 2 — inline intermediates

Unnamed heavy pieces inside one row — the relative motor of an inline
`slerp`, `motor(…)` written straight into `rotate(…)` — need lowering to
register hidden constants itself (a callback like `getComps`) and those to
join the per-frame evaluation for that row. (The plan said that until then
the message for an oversized value suggested naming it. No message ever
did; see "As built (stage 2)".)

## Risks

- **Uniform budget.** Each hoisted constant a shader reads is a `uniform
  float`; WebGL2 guarantees ~224 vec4 slots and many drivers spend one per
  float. A motor has up to 32 coefficients (16 and a slide). Hoist only
  coefficients that are not a number or a variable, pin counts in tests,
  and pack into `vec4`s if real graphs approach the limit.
- **Lists** broadcast inside coefficients; a value over a list cannot be a
  scalar constant, so it keeps the inline path.
- **`d/dt`** must differentiate through a hidden constant's definition, as
  it does through a named point's components.

## Not covered

Values that vary per pixel (a multivector field, anything in `x, y, z`) still
repeat subtrees. That needs sharing in the expression language itself — a
let node, DAG-aware sizes, and GLSL locals as `colorProgram` already emits
for colour fields (lib/compiler.ts). Separate work.

## As built (stage 1)

- lib/defs.ts `hoist` / `hoistNode`: a named `[pga]` or `[mv]` value, a
  named matrix or tensor, has each coefficient that depends on at least one
  constant, state or t — and on nothing else (no list, data column, interval,
  position or parameter) — stored as `NAME#k`. Coefficients of numbers alone
  stay where they are (`quat(-0.2, 0.8, 0, 0)` has nothing to share), as do
  literal zeros and single names.
- **Intermediates of a named value.** `withHoisting` (lib/pga.ts) lets
  `slerp` hand its unit motors, their relative motor and its log to the same
  hoisting while a definition is lowered: `K = slerp(N, S, 0.5)` between
  motors about draggable axes now works. Inline, the old guard still refuses
  it (stage 2).
- **Validation.** Hidden names join `constNames` (lib/defs.ts) like a
  point's components, or the constant check would drop them. Autocomplete
  skips names with `#`.
- **Animation.** A row reading a hidden constant that moves with t animates
  exactly as one reading `th = t` does: its parameters change
  (`animatedConstNames`, web/main.ts), not its own `t`. `cls.animated` stays
  false for both.
- **d/dt.** Coordinate flows differentiate their own expression in t and
  treat every named constant as fixed, hidden or not — unchanged.
- **Uniforms.** The most parameters any example's row reads is unchanged
  (300, the Lorenz attractor's points); no example gained enough to matter.
- **Compatibility.** Every built-in example and featured graph gives the
  same errors, kinds and readouts as before; three shader keys changed, in
  graphs whose rows read a named line, plane or motor.
- **Tests** (lib/frame-constants.test.ts): what is hoisted and what not,
  structural zeros under a slider at 0, autocomplete, a screw moving a point
  in under 2000 nodes, a named line moved by it, slerp between motors about
  moving axes, and a slider moving a hidden constant's value. Test helpers
  that evaluate a row with a hand-made env take hidden constants from
  `evaluateFrame` (lib/mat.test.ts).

## As built (stage 2)

- **Where they live.** In the document Env, like the named ones. While
  `analyzePrepared` (lib/analysis.ts) lowers each row, `withHoisting`
  (lib/pga.ts) is set to a hoister that binds a frame-constant coefficient
  as the constant `#id.k` (the row's id, or its index, and a counter) and
  adds it to `constNames`, so the row's `params` name it and the compiler
  binds it as a uniform. A leading `#` keeps row names apart from a named
  value's `M#3`, and from each other across rows. Everything that evaluates
  a frame reads the same Env: the app (`currentConstEnv`, slider and drag
  rebinds), readouts (the frame is re-evaluated after the rows), the /g/
  preview (worker/og.ts, from `analysis.constEnv`), certification and
  traces.
- **What is handed over.** A motor's coefficients and slide (`motorPga`),
  a moved line or plane (`moveFlat`), the affine map that moves points
  (`movePoint`'s origin, columns and slide offset), slerp's intermediates
  and result, a rotor's turn matrix (`turnMatrix`, lib/geom.ts) and a
  matrix applied to a point (`M v`, `rotate(P, θ, axis)`). The same steps
  hoist while a named value is lowered (stage 1's `withHoisting`).
- **What is not.** frameConstant (lib/defs.ts) is stage 1's test, shared:
  no number or single name (structural zeros stay), nothing over a list,
  data column, interval, position or parameter. Intermediates must also be
  over `HOIST_NODES` (6) nodes: `cos(t)` costs less inline than as a
  uniform. A named value's own coefficients keep stage 1's rule.
- **One name per coefficient.** `frameHoister` keeps one name per distinct
  coefficient (by `exprKey`), so the map that moves eight vertices of a
  hull, or 200 cubes turned by one matrix, is twelve or nine constants.
- **Pruning and repeat analysis.** After the rows, row constants that no
  row's classified object reads — directly or through another hidden
  constant — are dropped (a row that failed after lowering, say). Each
  `analyzePrepared` first drops the previous run's, so re-analysing a
  prepared document gives the same names and no duplicates.
- **Measured** (rows with `A`, `B` draggable, `S = motor(line(A, B), t,
  t/4)`, `N = motor(line(A, (0, 0, 1)), 1, 0.5)`):

  | row | before | after |
  |---|---|---|
  | `rotate((0, 0, 0), slerp(N, S, 0.5))` | refused | 47 nodes |
  | `rotate(line((0, 0, 0), (1, 0, 0)), S)` | too large | 1,180 |
  | `rotate(hull(cube), motor(line(A, B), t, t/4))` | 5,200 | 125 |
  | `rotate((0, 0, 0), S)` | 1,003 | 197 |
  | a cube turned by a product of five rotors in sliders and t | 24,697 | 52 |
  | a point moved by three matrix exponentials about slider axes | 13,391 | 29 |

  Inline and named forms give the same readouts at every t.
- **Messages.** Naming no longer helps for any of the steps above: a row
  hoists what a definition would. It can still help for multivector or
  matrix algebra written out by hand (`R ⟑ v ⟑ ~R` rather than
  `rotate(v, R)`), since a named multivector or matrix stores every
  coefficient. The size messages do not suggest it: the check that fires
  (8192 nodes per element) cannot tell which piece of a tree is
  frame-constant, and for a field or anything over x, y naming does
  nothing.
- **Compatibility.** Every built-in example and featured graph gives the
  same errors, kinds and readouts as main. Fourteen rows' shaders changed,
  all reading a motor, rotor or matrix; the most parameters any row reads is
  still 300. Two tests that pinned the old limits now pin the new reach:
  inline slerp between moving motors matches the named one
  (lib/pga-values.test.ts), and 200 cubes about a slider axis draw, sharing
  nine constants (lib/hull.test.ts).
- **Tests** (lib/frame-constants.test.ts, "inline intermediates"): the three
  cases above against their named forms, rotors and matrices, structural
  zeros under a slider at 0, nothing hoisted over a list or position,
  pruning and repeat analysis, hidden names in no autocomplete or message.
  worker/og.test.ts draws a row through its own constants in the preview.
