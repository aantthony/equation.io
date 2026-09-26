# Multisets implementation — progress notes

Working notes for implementing [multisets.md](multisets.md). Branch `multisets`.
Baseline 2026-09-26: 82 files / 2283 tests pass, typecheck clean.

Each phase lands as its own commit. Status: todo / doing / done / blocked.

| Phase | Status | Notes |
|---|---|---|
| 1 Bracket sums | done | commit bb739c2. Parser: `[]` token merged in `mergeEmptyBrackets` (expr.ts); flatten in `expandItems` (list.ts); empty reductions in `reduce`; empty family in object-lists `expand`. |
| 2 Tuple matrices | done | geom.ts lowerMat vec case; mat.ts matrixFromRows; defs.ts no bracket→matrix; det/trace/solve/exp take a tuple as one matrix. Examples rewritten. |
| 3 Vectors in 3D | doing | subagent, worktree; merge after phase 2 |
| 4 Order | todo | |
| 5 Display | doing | subagent, worktree (from phase-1 commit) |
| 6 Tensors | todo | |
| 7 Continuous intervals | todo | |
| 8 Measures | todo | |

## Decisions made while implementing (not in the agreed spec)

- Dev probe: scratchpad/probe.sh 'row1|row2' prints last row's analysis (needs --experimental-transform-types for const enum).

(See also "Assumptions" in multisets.md.)

## Verification log

- Phase 1: vitest 83 files / 2293 pass; typecheck, oxlint clean. Spec tests in lib/multisets.test.ts.

- Phase 2: vitest 83/2299 pass; typecheck/lint/fmt clean; probes M M P→2 pts, det(M)=[1,2].

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
