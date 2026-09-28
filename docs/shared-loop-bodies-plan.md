# Shared loop bodies: a plan

Written 2026-09-28, while making graph rows fast (discrete-lattice branch).
Nothing here is in flight; the branches it mentions are listed at the end.

## The problem

A recursive function `f(m, j) = {…, f(c(m), j - 1)}` resolves once, to a
`loop` node (lib/defs.ts `wrapRecursion`), and every call inlines it with
`substVars`, which keeps the loop's `body` as the same object: only the
seeds differ. Resolution shares the body. The lowering passes after it do
not: each rebuilds every node it walks, so each call site ends up with its
own copy of the body, and a list multiplies the copies per member.

Measured on the Collatz orbits of 1..50 (docs/discrete.md, graphs):

```
c(m) = {mod(m, 2) = 0: m/2, 3m + 1}
f(m, j) = {m <= 1: 1, j <= 0: m, f(c(m), j - 1)}
k = [1..50]
j = [0..111]
graph({f(k, j) > 1: f(k, j)}, c(f(k, j)))
```

- 28 000 loop nodes reach the compiler, with 28 000 distinct bodies, from
  one function. Even `f(1, 2) + f(3, 4)` ends with two bodies.
- lib/vm.ts compiles each body again: ~110 ms of the graph's compile.
- Finding the 5 600 distinct calls (to run each once) has to key them
  structurally: `exprKey` over 28 000 loops is ~140 ms, which cancels the
  win (see "What this unblocks").

## Where the copies are made

Verified by counting distinct bodies after each stage (`lowerObjects` is
the first that splits them):

| Pass | Where | What it does to a loop body |
|---|---|---|
| list expansion, `visit` | lib/object-lists.ts `expand` | rebuilds every node, `{ ...node, … }` |
| list expansion, `instantiate` | lib/object-lists.ts `expand` | rebuilds the whole tree per member |
| geometry lowering, `lo` | lib/geom.ts, `case 'loop'` | rebuilds the body per loop |
| list lowering, `lowerNode` | lib/list.ts, `case 'loop'` | lowers the body per loop; its piecewise case always makes a new node |
| Σ/Π unrolling, `substIdx` | lib/defs.ts | substitutes into the body per term unless the index is a param |
| constant folding, `foldNums` | lib/defs.ts | piecewise case always makes a new node |
| equality cases, `exactCases` | lib/automaton.ts (discrete-lattice) | rewrites a body holding `=` per occurrence |

Not copying: `resolveExpr`/`rx` and `substVars` (shared, measured), and
`indices` in `lowerObjects` (memoised per node already — the model to copy).
Unchecked: the compiler's `real()` (identity unless the row is complex) and
anything in lib/complex.ts, lib/seq.ts and lib/analysis.ts that walks rows.

## Approach

Two rules, applied pass by pass:

1. **Rebuild only what changed.** A pass returns the node it was given when
   every child came back unchanged. `mapChildren` does this already; the
   hand-written cases (`{ ...node, a: … }`, and above all piecewise) do not.
   A helper beside `mapChildren` — `unchanged(node, next)`, comparing
   `childrenOf` — covers the switch-style passes without rewriting them.
2. **A loop body is lowered once per pass.** In each pass's `loop` case,
   memoise the body's result by the body object (a `WeakMap` per pass run,
   as `indices` does). This is sound because one body object is one
   function definition: its free names are its params and document names,
   and the pass does the same thing to it wherever the call sits. The
   exceptions are context a pass carries into bodies, each of which needs
   its own check rather than the memo:
   - `substIdx`: substitute into the body only when it mentions the index
     (it can, if the index shadows a document name the body reads); else
     return it as it is.
   - `visit`'s `bound` set and `lowerNode`'s `getList` override: both are
     derived from the loop's own params, so they are the same for the same
     body; memoise inside the override, not across it.
   - A pass run more than once per row (per member, per stage) needs its
     memo at the level that spans those runs, or rule 1 alone.

Why sharing is safe for loop bodies in particular: several passes write
onto nodes — `withAxes` sets `axes`, `markOrigins` and `sameList` set
`origin` — and a node shared between list members would carry one member's
metadata into another. Loop bodies cannot hold lists (lib/list.ts: "Lists
are not supported in a recursive function yet"), so none of those writes
reach them. **When lists become allowed inside recursive functions, this
has to be revisited**: rule 1 stays safe, rule 2 does not without copying
list nodes on write.

## Steps

1. **A test that pins sharing.** In lib/recursion.test.ts: for
   `f(1, 2) + f(3, 4)`, `(k, f(k, 2))` with `k = [1..3]`, a Σ over a call,
   a point row and (on discrete-lattice) a graph row, count loop nodes and
   distinct bodies in the compiled plan: one body each. It fails today.
2. **lib/object-lists.ts.** `visit` through `unchanged`, and `instantiate`
   skipping subtrees that hold no marker (`holdsMarker`, memoised per
   node). A first version is on the local `share-loop-bodies` branch (tests
   pass; bodies are still split by the later passes, so it changes nothing
   measurable on its own).
3. **lib/geom.ts and lib/list.ts** loop cases: memoise the body; make the
   piecewise cases identity-preserving.
4. **lib/defs.ts** `substIdx` and `foldNums`, as above.
5. **lib/automaton.ts** `exactCases` (after discrete-lattice merges):
   memoise by node, so a shared body is rewritten once.
6. Step 1's test passes; then a perf guard (lib/perf-guards.test.ts) on the
   Collatz graph's analysis: loop nodes compiled vs distinct bodies.

Each step keeps the full suite green on its own; 2–4 can be one PR.

## What this unblocks

- **Loops compiled once per body.** lib/vm.ts can cache a `LoopProg` per
  body object (with the slot layout), turning 28 000 loop compiles into
  one. Loop layouts must be views over the outer slots, not copies — the
  `graph-hoist-loops` branch has that change.
- **Each distinct call run once.** The `graph-hoist-loops` branch hoists
  every top-level loop in a graph's edges into a slot, so the 28 000 calls
  above run as 5 600: slider drags go from ~75 ms to ~20 ms. It is parked
  because it keys calls with `exprKey` (~140 ms per edit). With shared
  bodies the key is the body's identity plus the seeds' key, which is
  cheap; rebase it onto this work and swap the key.
- Less memory and faster analysis for any row calling a recursive function
  over a list, not only graphs.

## Branches

- `discrete-lattice`: this plan; graph rows cache their edges and compile
  them to the VM (`edgeEvaluator` in lib/graph.ts).
- `graph-hoist-loops` (local, WIP commit on top of discrete-lattice): the
  hoisting and the lib/vm.ts slot-view change described above.
- `share-loop-bodies` (local, off main): step 2's first version.
