# Points as function arguments: `f(P)`

Written 2026-09-20 against `lists-cross-rotations-hull` at 2d2120d (PR #119).
Every "today" below was verified by running the rows through `analyze()`
(worker/graph.ts), not read off the docs.

## The gap

Points are values almost everywhere — `R P`, `P + v`, `rotate(P, a)`,
`hull(P)`, `vector(P, Q)` take a point or a point list — but a user function
of several variables does not:

```
f(x,y) = (x + y/2, y)      A = (1, 2)      a = [0..2]; b = [0..2]; P = (a, b)
```

| Row | Today |
|---|---|
| `f(1, 2)`, `f((1, 2))`, `f(A_x, A_y)` | point ✓ (a tuple literal flattens at parse) |
| `f((a, b))` | 9 points ✓ |
| `f(A)`, `f(P)`, `f(Q)` (Q a literal point list) | ✗ `f takes 2 arguments.` |
| `f(J A)`, `f(A + A)`, `f(rotate(A, 1))`, `f(midpoint(A, B))` | ✗ same |
| `f(f(1, 2))` — composition | ✗ same |
| `g(A)` for scalar `g(x,y) = x y`; `y = g(A) x` | ✗ same |
| `h(A)`, `h(P)` for ONE-parameter `h(p) = 2p` | ✓ already — substitution is textual, so `p` simply becomes the point |

So the one-parameter case needs nothing. The work is the arity mismatch: an
n-parameter function handed ONE argument that is an n-dimensional point.

## The rule

> When a user function with n ≥ 2 parameters is called with exactly one
> argument, that argument is a point (or a list of points) of dimension n, and
> its components are the arguments: `f(P) ≡ f(P_1, …, P_n)`.

- Only on arity mismatch. Every call that works today keeps its meaning; the
  rule turns one error into one reading.
- Dimension must equal n exactly. `f(B)` with a 3D `B` and 2-parameter `f`
  says `f takes 2 arguments, and B has 3 components.`
- Anything that is not a point in the end (a number, a matrix, a scalar list)
  keeps today's `f takes 2 arguments.`
- No spreading among several arguments (`F(A, 3)` for a 3-parameter F stays
  an error). It is easy to add later and hard to take back.
- Built-in functions are untouched (`atan2(A)` stays an error); the geometry
  helpers already take points.

## Why it is not a one-liner

Application happens in the resolver (`rx` in lib/defs.ts:1183–1189): arguments
are resolved, the arity is checked, and `substVars` writes them into the body.
That is BEFORE geometry lowering, so at that moment nothing knows that `J A`
or `rotate(A, 1)` or even the name `A` is a 2-vector — and a point LIST (`P`,
`Q`) is not a point until list lowering, later still.

So the resolver cannot pick the components out itself. It can only say which
component it wants, and leave the picking to the passes that know.

## Design: a deferred component node

One internal call, in the style of `[index]` / `[range]` / `[family]`:

```
[comp](value, k, n)     component k (0-based) of `value`, which must have n components
```

1. **Resolver** (lib/defs.ts, the `fn` branch of `rx`). When
   `args.length === 1 && fn.params.length >= 2`, substitute
   `param_k ↦ [comp](arg, k, n)` instead of throwing. The SAME `arg` node goes
   into every component — that shared identity is what keeps a list argument's
   components zipped (see 3).
2. **Geometry lowering** (lib/geom.ts, `lower`, the `call` case). Lower
   `value`:
   - a vec of n items → item k. This covers `A`, `J A`, `A + B`,
     `rotate(A, 1)`, `midpoint(A, B)`, and a nested `f(...)` result, because
     all of them are vecs by then.
   - a vec of another size → the dimension error above.
   - a scalar that is list-shaped (`listShape(...) !== null`: a list name, a
     literal, `P + (1,0)` …) → leave `[comp]` in place for list lowering.
   - anything else → `f takes n arguments.` The node needs the function's name
     for these messages: carry it as a fourth `str` argument rather than
     threading state.
3. **List lowering** (lib/list.ts, `lower`, the `call` case). Lower `value`;
   it must be a list of vecs (or a data scatter `vec` of columns). Return the
   list of k-th items **with the value's axes** (`withAxes(out, axesOf(value))`).
   Because all n components come from one value with one axis set, `align`
   zips them — `f(P)` on a 21×21 lattice is 441 points, not 441². This is the
   step the "same list zips" rule from PR #119 makes possible.
   - Fast path: a data scatter's k-th component is just its k-th column.
   - `NO_LIST_INSIDE`, masks, text: no change — a component of a point list is
     an ordinary scalar list.
4. **Object expansion** (lib/object-lists.ts). Two touch points:
   - `visit`/`instantiate` already treat any list-valued subexpression as a
     marker, so `vector(P, f(P))` and `y = g(P) x` become families with no new
     code — provided `listValue([comp](P, k, n))` succeeds, which (3) gives.
   - `pushTransforms`/`holdsFigure` are unaffected.
5. **Everything downstream** never sees `[comp]`: it is gone after (2) or (3).
   Add it to the "unknown function" guard list only as a safety net, with a
   message a user could act on.

### Cost guard

`substVars` copies `arg` into each use of each parameter, as it already does
for every call; the only new multiplier is that geometry lowering lowers
`value` once per `[comp]` node. For `f(f(f(P)))` that is n^depth lowerings of
the innermost argument. Memoize by node identity inside one `lowerGeom` —
the `matSeen`-style WeakMap is the pattern — so a shared argument lowers once.
Check with the existing budget test (`worker/graph.test.ts`, "refuses a huge
composition") plus one nested-`f(P)` case; PR #119 already showed how little
slack that test has.

## What falls out

```
vector(P, f(P))                 the lattice arrows, without naming the axes twice
f(f(P)), f(R P), f(P + (1,0))   composition with every other point operation
hull(f(Q))                      the image of a shape under a nonlinear map
A = (1, 2); f(A)                a draggable point and its image
y = g(A) x                      scalar functions of a point
F(B) for F(x,y,z)               3D, same rule
```

## Out of scope (deliberately)

- Point-valued PARAMETERS with component access inside the body
  (`f(p) = p_x^2`). Today `p_x` is just another variable name; making it mean
  "component of the parameter" is a separate feature with its own naming
  questions.
- Spreading a point among other arguments, or two points into four
  parameters.
- Complex `w`-functions: `f(w)` with a point argument stays as it is.
- Dragging: `f(A)` is a computed point, so it is not draggable — same as
  `A + B` today.

## Steps

1. `[comp]` in geom.ts for vec values + resolver emission + errors. Tests:
   every ✗ row in the table that is a single point, including composition and
   the dimension error. (No list support yet: a list argument still errors,
   with the old message.)
2. `[comp]` in list.ts with axes; `f(P)`, `f(Q)`, `f(P + v)`, data scatters.
   Tests: 441-not-441², `f(P)` equals `f(a, b)` pointwise, mixed
   `(P_… , other list)` crossing, a filtered list keeps pairing.
3. Families: `vector(P, f(P))`, `segment(P, f(P))`, `y = g(P) x` (≤ 32),
   `hull(f(Q))`. Mostly tests; fix what the markers miss.
4. Memoization + the budget test.
5. Docs: `llms.txt` (functions section and the lattice example), syntax help
   for user functions if it lists call forms, `math-objects.md`; switch the
   "deform a lattice" example to `P = (a, b); vector(P, f(P)); f(P)`.

Steps 1–2 are the feature; 3 is where surprises are likeliest (the family
expander has the most special cases); 4 is cheap insurance.

## Open question

Should a scalar function of a point LIST plot as a value list
(`g(P)` → dots/bars, like `L^2`)? The rule above gives that for free and it is
consistent, so the plan assumes yes.
