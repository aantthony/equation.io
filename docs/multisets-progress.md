# Multisets implementation — progress notes

Working notes for implementing [multisets.md](multisets.md). Branch `multisets`.
Baseline 2026-09-26: 82 files / 2283 tests pass, typecheck clean.

Each phase lands as its own commit. Status: todo / doing / done / blocked.

| Phase | Status | Notes |
|---|---|---|
| 1 Bracket sums | done | commit bb739c2. Parser: `[]` token merged in `mergeEmptyBrackets` (expr.ts); flatten in `expandItems` (list.ts); empty reductions in `reduce`; empty family in object-lists `expand`. |
| 2 Tuple matrices | done | geom.ts lowerMat vec case; mat.ts matrixFromRows; defs.ts no bracket→matrix; det/trace/solve/exp take a tuple as one matrix. Examples rewritten. |
| 3 Vectors in 3D | done | e_x/e_y/e_z resolved in defs.ts `rx` via ResolveOpts.documentNames (doc names win); render3d batches point runs; og.ts preview draws plists. App already drew 3D plists. |
| 4 Order | done (uncommitted) | Axis.ordered (expr.ts); list.ts unionAxes/tupleOf/sortBy/tupleRow/needsOrder; object-lists polyline/polygon need order; geom non-square tuple of points passes; csv/defs `row`; defs state-family order; new `tuple` row kind. Spec tests §3 in multisets.test.ts. |
| 5 Display | done | commit 9803156 (cherry-pick of cb5ec73). plot.ts: bare x/y scalar → field, xyz → error; curveHint; uniformDraws for u/v; signed field shading; dotPlot for lists, barMode removed. |
| 6 Tensors | done | lib/tensor.ts {shape,data}; geom.ts lowerTensor; ⊗ ∧ outer wedge contract(T,i,j); defs.tensors; readouts via `tuple` row kind. |
| 7 Continuous intervals | done | cherry-picked 0600db5 onto phase 6 (additive conflicts in defs/expr/doc). lib/interval.ts; pregion; projected2d. |
| 8 Measures | done (cherry-picked f1b1792 after fix commit) | branch worktree-agent-a70343c84ab92a649 commit f1b1792 on 554c97e; lib/measure.ts reduceOverSet/measureSet; certify.ts intervalValue; `{y = x^2, 0<x<1: f}`. Agent: vitest 86/2393. Cherry-pick after fixers A/B are committed. Cuts: volumes/surface areas, unbounded 2D totals, stdev/median/hist continuous, min/max over regions/curves, non-certifiable 2D systems; unboundedness heuristic (not proof) when interval proof fails. |

## Decisions made while implementing (not in the agreed spec)

- Dev probe: scratchpad/probe.sh 'row1|row2' prints last row's analysis (needs --experimental-transform-types for const enum).

(See also "Assumptions" in multisets.md.)

## Verification log

- Phase 1: vitest 83 files / 2293 pass; typecheck, oxlint clean. Spec tests in lib/multisets.test.ts.

- Phase 2: vitest 83/2299 pass; typecheck/lint/fmt clean; probes M M P→2 pts, det(M)=[1,2].
- Phase 3 merged: vitest 83/2308 pass.
- Phase 4: vitest see report; typecheck/lint/fmt clean.
- Phase 4: vitest 83/2326; typecheck/lint clean; test:objects pass.
- Phases 4+5 combined: vitest 83/2332; typecheck/lint clean. Probe: shared scratchpad/probe.ts may be repointed by worktree agents; use scratchpad/main/probe.sh.
- Phase 6: vitest 84/2344; typecheck/lint clean; test:objects pass (agent).
- Phases 6+7 combined: vitest 85/2368; typecheck/lint/fmt clean.

## Review

- Review 1–4 (done): 6 bugs + 5 small (polyline family over multiset of tuples; moving tuple of points; e_x param shadow regression; sort of 100k column perf/readout; M Q named; sort(L)[2] multiplies; empty filter → []; polyline(M) with lists; sort key subset axes; count of computed points; P_x in §3). Fixer A done: all 11 fixed.
- Review 5–7 (done): projFrag Lipschitz widening overfills (high); expression lists don't stack; og projected slow; llms.txt d/dx family snippet; MCP kind for interval. Fixer B done: all 5 fixed (projFrag sign-change only + bounded refine; columnStacks for all number lists; og projectedMask; MCP kinds). Both committed together; vitest 85/2380.
- Fixes + phase 8 combined: vitest 86/2405; typecheck/lint/fmt clean; probes π, 2π, 1/3, ∞, arc 1.47894 OK.

- Final review (phase 8 + fixes + spec walk): phase 8 gives confident wrong numbers (bbox clipping, 0·∞ interval, negative measures, divergent integrals finite, endpoint-singular arc length, root undercount, quadtree budget degradation, freezes). Also polyline(M N) vs named differ; `sort(L) [2]` spaced indexes; named point T[2] not indexed; bracket of 4-tuples flattens; (1,1) T 2×3 fails. Fixer D done (6 fixed; juxtaposition always product; spacing rule; named points index; long-tuple multisets). Fixer C (measure) running. Rosette `e^(th J) hull(P)` [tensor] regression (phase 6) → fixer E done (object-lists visit recurses into tensor-item lists; hull.test checks vertices). Use scratchpad/orch/probe.ts (shared probe got modified).
- E2E: test:objects all PASS, test:editor 95/95, test:swipe 24/24 (at 48d5189). csp/embed/mcp-app need `vite build` + `wrangler dev --config dist-web/equation/wrangler.json --port 5198` (5196 failed to start alongside; mcp-app via MCP_TEST_ORIGIN=5198). Results at 48d5189: embed PASS, mcp-app PASS, csp FAIL only on loading external cloudflareinsights beacon (sandbox network; branch touches no CSP files).

## Final state (2026-09-26)

All 8 phases implemented; three review rounds' findings fixed (commits 580032e, 51ca1d3).
At 51ca1d3: vitest 86 files / 2419 pass (baseline 2283); typecheck, oxlint, oxfmt clean;
test:objects all PASS; test:editor 95/95; test:swipe 24/24; embed-test PASS; mcp-app-test PASS;
csp-test fails only loading the external cloudflareinsights beacon (sandbox network).
Screenshots checked by orchestrator: annulus, swept band (zoomed), parabola arc readout, rosette.

## After review: comparisons keep members (2026-09-26)

`[1,2,3] < 3` is `[1, 2]` (multisets.md §5, §9): a comparison as a value keeps the members of
the multiset it runs over; conditions (`L[…]`, `{…}`) stay per element. list.ts `lowerCond` /
`keptMembers` / `cutBy`; lone-filter `total`/`mean` sum members (measure.ts), so
`total(0<x<1)` = ½ and `total` of a region errors toward `count`. vitest 86/2426; typecheck,
oxlint, oxfmt clean; test:objects PASS.

## Blockers / open issues

Known limits (also in multisets.md §9), none blocking:
- Measures: 3D volumes/surface areas; totals over unbounded plane regions; stdev/median/hist over
  continuous sets; min/max over regions/curves; 2D root counts the Krawczyk prover can't certify
  (singular roots, non-interval functions like gamma) error; implicit curve length compares two
  refinement levels (not a proof); intricate sets beyond the work budget error.
- Swept regions: one interval beside x, y; fields over an interval are errors.
- Tuples/tensors: `(T, T)` for a named 2×3 tuple; `T[T > 1]` on a named point; a bracket of
  tensors; tensors cap at 729 entries; no transpose/Hodge star beyond ×.
- Number-line stacks keep unit spacing, so long lists stand very tall.
- `M T` for a k×k M and n≠k points still moves each point (M·T undefined there).


## Phase 5 plan (from planning agent, decisions by orchestrator)

Implicit graph lives only at lib/plot.ts:~829 (`curve/graph rhs`); compiler fallbacks
graphEquation at compiler.ts:159/406; special.ts isFn branch test-only. Decisions:
1. x-only scalar rows (`sin(x)`, `x!`, `d/dx x^3`, `erf(x)`) → scalar field + info hint "for the curve write y = …".
2. `sin(a x)` with list a → family of scalar fields: keep a clear error (families of scalar2d unsupported).
3. bare scalar in x,y,z → error pointing at `f = 0` (was implicit surface).
4. `int[a..b] f dx` value row keeps its area shading (a reduction's picture).
5. Scalar field colour map made signed/diverging so x-only fields read.
6. `a_n = …` sequences keep dots at index n (a sequence is ordered, i.e. a tuple).
7. List bars option (barMode) removed; lists draw as number-line dot plot, stacked by multiplicity (height = multiplicity).
u/v rows with no x,y,z: rename to anonymous Uniform(0,1) base RVs (dist.ts addAnonymous) → density curve.

## Phases 7–8 plan (planning agent; decisions by orchestrator)

Phase 7 (start after phase 5 lands — shares plot.ts/analysis.ts):
1. `interval` builtin; `r = interval(lo,hi)` → defs.intervals; `rx` var case replaces r with
   `lo+(hi-lo)·[iv:r]` (identical per name); literal → `[iv#N]` keyed by node identity (separate).
2. Hidden params join u,v in classify (PARAM_VARS plot.ts:51): 1 param pcurve; 2 params+3 comps psurface;
   2 params+2 comps → NEW region/parametric (filled; CPU `pregion`: 64×64 quads, CCW, one Path2D nonzero
   fill, no outline; og too). Makes `(u cos 2πv, u sin 2πv)` a disc. ≥3 params error.
3. Densities: extend phase-5 `uniformDraws` to [iv] params; multiply by mass Π(hi−lo) (length measure).
4. Projection: x/y + one hidden param → region/projected residual F(x,y,s); GPU `projFrag` K=48 sign-change
   + Lipschitz widening; inequalities fill if min_k G<0; og union over K. Scalar field w/ interval: error.
Phase 8:
5. Desugar reductions in `rx` beside `int` (defs.ts ~1810): total(f(u)) → int[0..1]; intervals affine;
   count = mass; mean = total/count; x → improper int; count(x)=inf; min/max numeric; stdev/median cut.
6. Measure module: region area quadtree with interval eval (certify.ts intervalAD, export value-only),
   boundedness check; curves: graph form symbolic arc length, implicit: marching squares (coarea |∇F|);
   points: findRoots / certifySystem in a fixed box; incomplete → error. Never view-dependent.
7. Syntax: `count(filter)`, `total({filter: f})` (allow `=` conditions in piecewise only as reduction arg).
   Slider-dependent 2D measures: whole-row plan only, else cut.
Decisions: interval density height via length measure; count(x^2=0)=1 (distinct); parametric sets use
pushforward measure (count((u,u^2))=1); unbounded count = inf, total/mean over infinite measure error
unless 1D improper integral converges. Cuts: 3D volume/surface area, >1 hidden param projection,
median/stdev/hist over continuous sets, unbounded 2D totals.

## Follow-up PR: solids (not in this branch)

`(interval(0,1), interval(0,1), interval(0,1))` — three separate continuous multisets, dimension
3 (§5) — is refused today ("at most two parameters"), as is `x^2+y^2+z^2 < 1` ("Inequalities are 2D
only"). Neither has an object kind or renderer. Plan agreed 2026-09-26 for a separate PR:
1. Classify 3 params + 3 components as `region/parametric` of dimension 3 (a solid).
2. Draw its boundary: the six faces of the parameter box (one param at lo/hi), each an existing
   `psurface` mesh; drop degenerate faces (sampled area ≈ 0, e.g. r = 0 of a spherical ball) and
   seam pairs (faces mapping to the same set, e.g. φ = 0/2π). Exact for maps without folds; fold
   boundaries (Jacobian = 0) are a documented limit.
3. MCP kind and og preview wherever 3D surfaces are drawn.
Later, same object: 3D inequalities as clipped boundary surfaces; volumes for `count` via an
octree extension of the certified quadtree (phase 8 cut). Identity note: `r = interval(0,1)`,
`(r, r, r)` is one parameter — the diagonal segment, already a curve.
