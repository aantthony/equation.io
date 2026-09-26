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
| 8 Measures | doing | subagent, worktree based on 0600db5 |

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

## Blockers / open issues

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
