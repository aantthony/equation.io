# Typed bindings, statement analysis, and mathematical objects

Status: stages 1–13 implemented, 2026-09-22. Baseline reviewed against `c58d2dd`.

This replaces the architecture and rollout in the 2026-09-21 “Typed values and
statement IR for equation.io” draft. The design and staged delivery gates below
are retained as the implementation contract. The original draft remains unchanged.

Implementation spans `lib/analysis.ts` (shared preparation and analysis),
`lib/env.ts` (canonical ownership and runtime projections), `lib/expr.ts`
(structural expressions), `lib/math-object.ts` (immutable semantic objects), and
`lib/compiler.ts` (independent CPU/GPU plans and cache identities). Browser,
worker, OG, MCP, and performance consumers use these boundaries. The temporary
Defs/Plot adapters and parallel row render expressions have been removed.
Section 10 remains separate follow-up work.

Validation: 64 Vitest files pass (1,757 tests; 3 skipped), including exhaustive
public-kind fixtures, CPU-only analysis, OG pixel equivalence, canonical binding
failure propagation, immutable semantic snapshots, and performance budgets.
`pnpm typecheck` and `pnpm web:build` pass. Browser object checks cover 10 scenarios;
editor checks cover 78 interactions, including live state preservation and
restart behavior. Representative 2D family and 3D geometry screenshots were
visually inspected. No resource thresholds were increased.
`pnpm perf` also passes all 10 browser scenarios against the existing baseline;
ordinary slider, pan, zoom, camera, and animation actions compile no new shaders.

## 1. Outcome and scope

Make mathematical structure explicit without changing the meaning of existing
successful graphs. A named vector owns its components, an alias refers to its
owner, a state owns both its derivative and initial condition, and classification
produces a mathematical object before any backend generates code.

The final pipeline is:

```text
row sources → statement scans → prepared document and typed environment
                                  ↓
                 resolve → object/list lowering → classify
                                                   ↓
                                             MathObject
                                              /       \
                                  CPU projection     GLSL compilation
                                  /          \              ↓
                             OG preview   web overlays    WebGL
```

Statements and binding order remain document-level concerns. Runtime state,
probability sample caches, drag writers, and DOM updates remain caller-owned.

Keep existing notation, public MCP kind strings, URL encoding, matrix/list
distinctions, scalar GPU uniforms, and resource limits. No deployment, new object
kinds, point-valued function parameter syntax, new complex state support, or
general coercion of named vectors into scalar argument lists is included.

Two product changes from the original draft remain explicit follow-ups: rejecting
previously accepted unary calls such as `sin((x,y))`, and plotting complex lists
as Argand scatters. They do not gate the architectural refactor.

## 2. Findings that change the design

| Finding | Consequence for this plan |
|---|---|
| `StateDef` has both `deriv` and `init`; the state-system key includes both | State bindings retain both, including vector initial values and default zero seeds |
| Geometry accepts direct scalar spellings such as `segment(0,0,1,1)` | Preserve those forms in lowering; deleting parser flattening does not justify deleting scalar-pair compatibility |
| `f(J A)`, `f(A+A)`, and `f(midpoint(A,B))` resolve before their vector shape is available | Deferred component IR remains valid for any unresolved point-valued expression |
| The web app preserves running state and RV caches across recompiles | Shared analysis has a preparation boundary; it must not seed a new simulation or sampler on every edit |
| `substVars` handles bound sum/product indices specially | Generic child traversal does not replace scope-aware substitution or free-variable analysis |
| `usesComplex(re(w))` is true, while its result type is real | Separate complex involvement, result type, and spatial dependence |
| `Presentation` containing only GLSL cannot hold compiled complex CPU coordinates | Introduce an explicit CPU projection as well as shader compilation |
| `GridField` already contains generated shader data | Semantic level-set metadata must be separated too; keeping `GridField` on `MathObject` would preserve the coupling |
| Worker duplicate-function handling differs from the web app | Record and reconcile that discrepancy explicitly when sharing analysis |

Confirmed with the current worker analyzer: `segment(0,0,1,1)`,
`dot(1,2,3,4)`, `circle(0,0,2)`, `perp(1,2)`, and `rotate(1,2,0)` all succeed.
`re(w)` is `scalar2d`; `re(w)=0` is `implicit2d`; `w^2=1` is `system`.
These are compatibility cases, not proposed new syntax.

## 3. Binding ownership and runtime projection

Use one canonical binding per independently defined name. Component aliases
are references, not duplicate scalar expressions. Keep sequence letters in a
separate namespace because `a=2` and `a_n=a/n^2` coexist today.

The following sketches define ownership; implementation may reuse current
payload types such as `FnDef`, `Mat`, `TableDef`, and `RV`.

```ts
type Components = readonly [Expr, Expr] | readonly [Expr, Expr, Expr];

type NumericBinding =
  | { tag: 'scalar'; role: 'const' | 'field'; expr: Expr }
  | { tag: 'vector'; role: 'const' | 'field'; components: Components }
  | { tag: 'scalar'; role: 'state'; deriv: Expr; init: Expr }
  | { tag: 'vector'; role: 'state'; deriv: Components; init: Components };

type Binding = NumericBinding
  | { tag: 'fn'; fn: FnDef }
  | { tag: 'matrix'; matrix: Mat }
  | { tag: 'seq'; value: SeqValue }
  | { tag: 'table'; table: TableDef }
  | { tag: 'rv'; declaration: RV }
  | { tag: 'missing'; message: string; list: boolean };

type NameEntry =
  | { kind: 'binding'; binding: Binding }
  | { kind: 'component'; owner: string; index: 0 | 1 | 2 };

interface Env {
  names: ReadonlyMap<string, NameEntry>;
  sequences: ReadonlyMap<string, SeqScan>;
  sequencePrefix: string;
}
```

Validate vector lengths and projection indices at construction. A vector state
has equal derivative/initial dimensions; zero initialization and dimension
discovery retain current behavior. A state reference means its integrated value,
never its derivative expression.

### Lookup contracts

- `lookupValue(env, name)` returns the mathematical binding or a scalar view of
  a component. An alias never resolves as the whole vector.
- `lowerValueRef(env, 'A')` produces `(A_x,A_y)`, retaining alias variables for
  uniforms and CPU evaluation. It does not inline the literal components of A.
- `lowerValueRef(env, 'om')` produces `(om_1,om_2)` for a vector state.
- `scalarDefinitions(env)` projects const/field formulas and state
  `{deriv,init}` payloads from canonical owners. This is a derived view.
- `evaluateFrame(env,t,stateValues)` produces `Record<string,number>` with the
  existing scalar/alias keys. Sliders, RK4, evaluators, and shader uploads use it.
- `nameTaken` includes canonical bindings and component aliases, not sequence
  letters. Binding a vector reserves its aliases atomically. Failed binding
  cannot leave orphan aliases or a partially usable vector.

Example: A owns `[1,2]`; `A_x` refers to `{owner:'A',index:0}`. Lowering A returns
variables `A_x,A_y`; evaluating its frame produces `{A_x:1,A_y:2}`. A dependent
point B stores expressions in those variables. For a state, its owner supplies
the derivative and seed while the frame supplies its current integrated value.

Keep `pointComps` and `vecStateComps` naming. Preserve both-order collisions,
standalone `A_x=5`, dependencies, cycles, existing forward-reference restrictions,
and the featured pendulum. Do not add topological forward-reference support as
a side effect of introducing a map.

`buildStateSystem` flattens canonical states into the existing scalar RK4 layout.
Its key includes ordered scalar names, derivatives, and initial expressions;
it excludes current integrated values. Preserve current restart behavior for
unrelated edits, derivative edits, initial-value edits, and constant changes.

Source ownership is separate from value storage. Row metadata retains the
original `Definition`, RHS, source row identity, errors, and missing-file status.
Named-point drawing and drag/MCP writers use that metadata plus Env; aliases
never become additional editable rows. Vector-field aliases never create grids.

### Distributions

Env owns named RV declarations; `RVSystem` owns sampling and numerical caches.
Provide a read-only declaration provider to the engine, with its existing
definition-signature invalidation. During migration a derived declaration index
is acceptable; two independently writable declaration stores are not.
Anonymous derived RVs used by expression/expectation rows remain engine-owned
and must not accidentally claim user names.

Build ordinary bindings first, then claim valid RV names using the current
collision precedence. Test conflicts in both row orders. Do not preinsert an RV
and then reject its own name via `nameTaken`. Retain sequence-letter coexistence.

## 4. Statements and shared analysis

Separate source splitting, lexical tagging, document binding, and evaluation.
Do not pretend that one pure per-row parser can decide derived RVs, regressions,
or duplicate bindings without document context.

The lexical scan recognizes blank/comment rows, viewport heads, sequence forms,
distribution candidates, definition candidates, and expression candidates.
Document preparation runs regression/RV scans with current precedence and then
settles those candidates. `open(...)` retains shape-based recognition and builtin
shadowing. Malformed table declarations retain their specific diagnostic.

Use two shared boundaries, initially with the existing Defs representation:

```ts
prepareDocument(rows: readonly RowSource[], options: PrepareOptions): PreparedDocument;
analyzePrepared(document: PreparedDocument, context: AnalysisContext): Analysis;
```

`PreparedDocument` contains statements, bindings, definition diagnostics,
regression fits, static-bound dependencies, and the state-system description.
`Analysis` contains row results, grid specifications, viewport results, and
resolved/classified objects. Preserve partial success when one row fails.

`AnalysisContext` explicitly supplies state values, the reusable RV engine, and
readout policy. Runtime-dependent readouts must not become part of compilation
or cache identity. A convenience `analyzeRows` creates a static context at t=0
and initial state for worker/OG callers. The browser uses preparation, reconciles
its existing state-system key, and then analyzes using its retained runtime.

Tables are supplied by a synchronous provider. Local file loading, `ensureTables`,
DOM work, pointer state, animation scheduling, and persistence stay outside lib.
The worker supplies no local bytes and retains device-parity missing-data results.

Viewport bounds evaluate only after the constant environment exists. Keep
compile-time bounds separate from frame values: animated/state-dependent values
must not become static sum, product, range, or integral bounds.

Preserve input-row identity. Splitting a row into statements must carry a mapping
back to its UI row; do not silently change the existing text-array API's row count.

Second coordinate-field rows remain plots. For function level sets, adopt the
web rule explicitly: a different second `f(x,y)=...` row is a plot; an identical
definition is an error. Add worker parity coverage for this existing discrepancy.
All other duplicate rules retain their current behavior.

`web/main.ts`, `worker/graph.ts`, and `lib/perfcase.ts` eventually use these same
boundaries. Perf wrappers may adapt error reporting and disable readouts, but may
not maintain another scanner/resolver pipeline.

## 5. Expression IR and list identity

Add dedicated `index`, `range`, `eqtest`, `comp`, `figure`, `trail`, `hist`, and
`family` variants. Parser-produced `index/range/eqtest` are syntax nodes;
lowering-produced figures and families are internal nodes. Do not claim that
the parser never emits these variants.

Keep `[angle]`, its derivative, and distribution helper calls as internal numeric
functions while they have CPU/GLSL implementations. `[dx]` remains the private
integral variable. No need to redesign these in the structural migration.

Figure vertices remain flat scalar arrays. Keep figure form and dimension;
derive closed/arrow/hull flags once at the render boundary. Preserve current
histogram payloads and typed arrays without copying their contents.

Introduce `childrenOf`/`mapChildren` with explicit behavior: one child level,
unchanged-node reuse, metadata preservation, and packed arrays treated as leaves.
Add recursive traversal only where the pass's semantics allow it.

`freeVars` and `substVars` remain scope-aware. In a surviving sum/product, its
index is bound in the body but outer bounds retain their current scope. Tests
cover nested/reused indices, a bound name also present in the substitution map,
sequence-dependent sums, and integration placeholders. A generic fold alone
does not supply lexical scope.

Convert producers and every consumer of one node group in the same PR.
`evaluate`, `diff`, `toGLSL`, typed compilation, list/geometry lowering, resolver,
key generation, and object classification need explicit handling or rejection.
Adding `assertNever` alone is not a migration. Invalid user syntax gets a source
diagnostic before an internal-node escape becomes an evaluator error.

### Deferred components

For an n-parameter user function applied to one n-vector, substitute components
when known. Otherwise emit `comp(value,index,arity,functionName)` and settle it
after geometry/list lowering. This includes matrix transforms, arithmetic,
geometry calls, nested user functions, indexing, and point lists.
All component projections share the argument's list origin/axes so they zip.
Keep `f(J A)`, `f(A+A)`, `f(midpoint(A,B))`, `f(f(A))`, and point-list compositions.
Named-point spreading among other arguments such as `F(A,3)` remains unsupported.

### Lists and matrices

Move list metadata to nodes while retaining the `axesOf`, `withAxes`, `sameList`,
and origin APIs as migration seams. Use `axes?: readonly Axis[]`, with absence
meaning “not assigned yet”; do not replace absence with an empty array, which
could suppress current identity inference. Metadata is excluded from mathematical
keys and shader keys. Audit `countNodes`/`exceedsNodes` when metadata becomes
enumerable so axes are not charged as expression subtrees.

Origins survive cloning before axes are assigned. Distinct literals stay
independent; repeated use of one named list zips. Do not serialize origin counters
into deterministic state/cache keys.

Keep unpacked lists, numeric packed columns, and text columns as distinct storage
variants of Seq. A data scatter remains a vector of columns/scalars, represented
explicitly within `SeqValue`; it is not falsely typed as a scalar Seq.

Named square 2x2/3x3 tuple lists remain matrices; bare tuple lists remain scatters.
Introduce one context-aware `rowsAsPoints` conversion for calls that consume a
point set (`hull(M)`, `polyline(M)`, `distance(M,A)`, `f(M)`). Matvec, determinant,
trace, and solve retain matrix interpretation. Shared matrix-derived point sets
retain stable axes; independent reconstruction must not create accidental crosses.

## 6. Tuple parsing and compatibility

The parser preserves argument grouping. Compatibility runs at call resolution
and geometry lowering, while the original syntactic argument shapes are still
available. Never decide “literal tuple” after expanding a named vector: that
would make `atan2(A)` succeed, contrary to current behavior.

Before changing the parser, inventory successful call shapes across builtin
names, user functions, shadowed builtins, geometry, distribution calls, and
special forms. The old parser flattens tuple arguments in more positions than
the draft's single-argument allowlist covers: `max((1,2),3)` is one example.
Keep this inventory as compatibility fixtures.

| Call class | Contract |
|---|---|
| Geometry/measurement | Preserve grouped 2D/3D points and existing adjacent-scalar 2D spellings |
| `rotate` | Prefer grouped point/angle/center-or-axis; retain successful legacy flat scalar signatures |
| `tube` | Preserve vector with optional radius and three scalar coordinates with optional radius |
| `solve` | Preserve matrix plus vector or matching scalar RHS components |
| `abs` | Preserve current scalar, vector-length, and scalar-pair behavior; characterize other legacy arities before changing them |
| User functions | Preserve n scalar args, one n-vector, computed points, and successful literal-tuple argument spellings |
| Scalar builtins | Normalize only syntactic tuple spellings accepted previously; named points still produce point-context errors |
| Shadowed functions/values | Resolve the callee before choosing builtin behavior |

A small legacy syntax adapter can mirror the previous parse-time argument
flattening policy at resolution. It must operate only on original tuple syntax,
not arbitrary point-valued expressions, and must not leak into general value
semantics. Give geometry's scalar pairing an honest name such as
`legacyPointArgs`; it remains supported compatibility code.

Preserve existing successful behavior in this stage, including accidental
unary flatten-and-ignore cases. A later, separately documented change may reject
those cases. New tuple-call successes or changed errors also need explicit tests;
they are not assumed to follow safely from an AST change.

## 7. Classification, types, and backend compilation

First extract compilation while keeping today's object distinctions. Only then
regroup the mathematical taxonomy. Do not combine this with rewriting every
renderer switch or deleting every adapter in one PR.

### Result type and spatial dependence

Extract `inferScalarType(expr, context): 'real' | 'complex'` from `compileTyped`
without emitting shader strings. Share builtin return rules with compilation,
including real projections and the locally complex iterate variable in `iter`.
Keep `usesComplex` as a structural involvement predicate for existing validation
rules; it is not a result-type inference function.

Track raw free symbols separately from spatial dependence. `w` contributes the
2D spatial coordinates x/y for classification without rewriting its source AST.
This is required before compilation: `re(w)` is spatial and real; `w^2=1` is
a complex root system. Keep existing u/v/space mixing and 3D restrictions.
Neither numerical slider values nor t may change the inferred object kind.

### Semantic object contracts

Use nested discriminated unions with required payloads per form. Avoid a broad
object with optional `expr`, `comps`, `pts`, and `packed` fields that admits empty
or contradictory objects.

Examples of the important source representations:

```ts
type PointSource =
  | { representation: 'real'; coordinates: Components }
  | { representation: 'complex'; expr: Expr }; // semantic dimension is 2

type SystemSource =
  | { representation: 'real'; residuals: readonly Expr[] }
  | { representation: 'complex'; equation: Expr }; // two real constraints

type ListStorage =
  | { storage: 'expressions'; values: readonly Expr[] }
  | { storage: 'packed'; values: Float64Array };
```

Complex parametric paths similarly retain their single complex expression until
CPU projection. Real and complex sources are representations of existing point,
curve, and system kinds, not new user-visible modes. Dimension is inferred and
validated from the representation, not independently writable contradictory data.

Graphs store the RHS with `form:'graph'`; implicit objects store an explicitly
normalized residual. Preserve any source equation needed for labels separately.
`revolve` desugars into an implicit surface. Level-set specifications contain
symbolic expressions and parameter identity; their GLSL is compiled later.

| Current public kind(s) | Semantic object |
|---|---|
| `implicit2d` | curve: graph or implicit, dimension 2 |
| `pcurve` | parametric curve, dimension 2 or 3, optional tube |
| `implicit3d`, `psurface` | surface: implicit or parametric |
| `spacecurve` | intersection: two constraints in three unknowns |
| `ineq2d` | region, with normalized constraints and boundary strictness |
| `scalar2d` | scalar field |
| `vfield2d`, `vfield3d` | vector field with required components |
| `complex2d`, `domain2d`, `conformal2d`, `fractal2d` | complex field with distinct forms; fractal retains seed/count |
| `point`, `trail`, `polygon` | point, trail, figure |
| `system` | square system, retaining angular, positional, parametric, and label metadata |
| `sequence`, `cobweb`, `bifurcation` | sequence with separate form-specific payloads |
| `vlist`, `dlist`, `plist`, `dscatter` | list with scalar/point element shape and expression/packed storage |
| `histogram` | histogram |
| `density`, `pmf`, `prob`, `expect` | distribution presentation with separate payloads; a joint probability need not name one RV |
| `value`, `note` | value/readout and decided comparison |
| `family` | members of classified mathematical objects |

`publicKind` is an explicit exhaustive mapping retaining all 32 existing strings.
Storage still distinguishes the four historical list kinds for that public API.
Keep widget behavior: scalar-list bars/dots and packed-size cutoff, scatter with
no bar toggle, explicit-sequence partial sums, no kind-changing controls.

### Compilation products

```ts
classify(term, context): ClassifiedObject;
compileCpu(classified, context): CpuPlan;
compileGpu(classified, context): GpuPlan;
```

CpuPlan and GpuPlan are discriminated unions of executable payloads, not bags of
optional fields. CPU plans hold projected real coordinates/residuals, expressions,
or packed arrays; GPU plans hold the appropriate GLSL strings and uniform layout.
The returned semantic object is immutable. Compilation does not change its kind.

`compileCpu` performs bounded complex splitting for points, paths, and systems.
It also projects real outputs involving complex subexpressions where the CPU
evaluator needs that conversion. Web and OG use the same CPU projection. OG can
operate without invoking GPU compilation. Keep source complex equations for root
labels and solver metadata alongside projected residuals.

During migration `toLegacyPlot(classified, cpu, gpu)` feeds existing renderers.
This adapter is computed output, never a second source of truth. CPU/GLSL
expressions are no longer recovered from a parallel generic `row.expr` once a
consumer has migrated. Row source metadata remains for editing and labels.

Shader compilation substitutes `u_<scalar-or-alias>` only at the GPU boundary.
CPU expressions keep scalar/alias names. Optional symbolic derivatives retain
the existing finite-difference fallback when differentiation is unsupported.

### Families, animation, and keys

Family members are post-field-substitution and post-desugaring mathematical
objects. Shader sharing runs before compiling individual member programs.
Retain the sharing set (including parametric surfaces) and existing 32/8/1024
caps. Compile a merged shader template once and bind member uniforms per draw.
CPU families use their projected members. Do not use compilation to reclassify.

`needs3D` is semantic and exhaustive; families aggregate member requirements.
`animated` retains t dependence and always-running 2D vector-field LIC; families
aggregate member animation too. Runtime invalidation also retains the browser's
animated-constant/state dependency behavior—it is not only a free-t test.

Specify separate keys for shader source/layout, CPU/system structure, and runtime
samples. Do not serialize whole classified objects. List identities, source row
IDs, current slider/state values, and CPU presentation metadata must not enter
shader keys. Preserve existing deliberate compile-time expansion exceptions.

## 8. Delivery sequence

Each stage is a mergeable PR. Split a stage further if it needs unrelated
consumer rewrites. Temporary adapters may span PRs, with explicit deletion gates;
there are no runtime feature flags or indefinite dual implementations.

| PR | Change | Merge gate |
|---|---|---|
| 1 | Add compatibility fixtures and `publicKind` over current Plot; switch MCP to it | Public strings unchanged; fixtures cover all kinds and identified edge cases |
| 2 | Extract document preparation/scanning and binding using current Defs | Same diagnostics/ownership; explicit worker function-level-set parity change tested |
| 3 | Share prepared analysis across web, worker, perf | Live state and RV caches preserved; missing files, grids, readouts, and viewport behavior covered |
| 4 | Add child traversal; move axes/origin onto nodes | Bound-variable tests, zip/cross behavior, packed storage, and node budgets pass |
| 5 | Migrate index/range/equality/component nodes and consumers | Sums, integrals, filters, sequences, computed-point arguments, and invalid-node diagnostics pass |
| 6 | Migrate figure/trail/hist/family nodes and consumers | Geometry, family sharing, CPU previews, and flat vertex layout unchanged |
| 7 | Preserve tuple syntax; add call compatibility normalization | Existing successful call corpus remains successful with matching output; no runtime named-vector splat |
| 8 | Introduce canonical Env ownership, component references, full state payloads | Alias uniforms stable; state seeds/restart behavior and atomic collision handling pass |
| 9 | Move remaining binding consumers and RV declaration lookup to Env | No independently maintained Defs storage; no RV cache regression; delete Defs adapter |
| 10 | Extract result-type inference and classify/CPU/GPU boundaries, retaining existing kind distinctions | Same CPU results and GLSL; OG works without GPU compilation; complex source retained |
| 11 | Introduce grouped MathObject taxonomy behind legacy-render adapter | Exhaustive kind mapping, required form payloads, animation/3D and family tests pass |
| 12 | Migrate OG and browser CPU consumers | CPU plans provide all expressions, complex labels, drag/solver metadata; previews match |
| 13 | Migrate GPU/UI dispatch and perf consumers; remove legacy Plot adapter | All consumers use semantic objects or compiled plans; adapter/parallel-expression cleanup complete |

PRs 1–3 establish the shared path before changing representations. PRs 4–9
recover value structure. PRs 10–13 separate semantics from rendering. The initial
statement scan can reuse existing regex scanners; replacing them with new grammar
machinery is not required to finish this work.

The initial implementation slice covered PR 1 only. This implementation completes
all 13 stages, including the parser, environment, and renderer migrations.

## 9. Verification and completion

Use existing tests and add focused regression cases for behavior the migration
could actually lose. Do not replace numerical/semantic assertions with kind-only
snapshots, or weaken CPU parameterization checks to compare only GLSL.

| Area | Required cases/evidence |
|---|---|
| Ownership | Point/field/state alias reads, both-order collisions, standalone alias names, failed vector binding, dependency cycles |
| States | `a'=-a; a(0)=2`; vector seeds; default seeds; pendulum; unrelated edit retains integration; derivative/init edits follow existing reset behavior |
| Calls | Grouped and scalar geometry; tube/solve/rotate; literal tuples in multiple arg positions; `atan2(A)` error; computed-point and point-list function compositions |
| Lists | Same-list zip versus independent cross; origin preservation through inlining/sums; packed CSV paths; matrix versus scatter and `hull(M)`/`f(M)` |
| Statements | View after constants; duplicate view/camera; exact duplicate versus function level set; regression precedence; sequence/slider/RV namespace coexistence; shadowed builtin and malformed `open` |
| Complex | `1+2i`, complex path in u, `w^2=1`, `re(w)`, `re(w)=0`, domain/conformal/iter, existing unsupported vector/system/list errors |
| Render/public API | Every current kind; 3D curves/surfaces/intersections; graph versus residual; integral shading; root labels; draggable metadata; list/sequence widgets; existing preview omissions |
| Performance | Shader identity across sliders; CPU expressions retain alias parameters; family program count; packed arrays not expanded; bounded splitting and derivatives; RV numerical cache reuse |

Run targeted suites for each stage, the full `vitest run` suite before merge, and
the relevant TypeScript checks. Use the repository `typecheck` and `web:build`
commands as final integration gates, inspecting any generated changes; do not
deploy. Run browser object/editor tests for the dispatch, drag, and pipeline
stages, and inspect representative 2D/3D screenshots where rendering changes.

Budget checks cover the new structural overhead as well as generated output.
Keep `ITEMS_MAX`, `DATA_MAX`, table/range bounds, path split limits, solver budgets,
and family caps. Fix accidental growth before changing a threshold.

Completion means all callers use shared analysis; names have canonical owners;
no structural bracket-call producers remain; classification emits no GLSL;
CPU/GPU compilation cannot change kind; all 32 public kinds remain mapped; and
temporary representation adapters, writable duplicate stores, and redundant
render expressions are removed. Supported legacy syntax adapters remain.
Passing kind snapshots alone is not sufficient.

Revert the latest stage to roll back. Reverting an earlier stage after dependent
stages land requires reverting its dependents in reverse order. URL text needs
no schema migration. CSP, CSV hash pinning, and equation-text privacy are unchanged.

## 10. Separate behavior changes

After the architecture is complete, retain these as individually reviewable
follow-ups from the original proposal:

1. Reject accidental unary tuple flattening (`sin((x,y))`, `ln((2,3))`, and the
   characterized equivalents). Publish the exact changed forms and diagnostics;
   preserve intentional geometry/scalar compatibility. This is a breaking
   notation change, not part of the compatibility-only parser migration.
2. Enable lists of complex expressions as Argand scatters. Retain the original
   proposed rule that `[1+i,2+i]` succeeds and `[1+i,2]` is a mixed-shape error.
   Use inferred element result types, not `usesComplex`, so real projections stay
   real. Compile moving points through CpuPlan and apply both input and aggregate
   output budgets before unbounded expansion. Add worker, OG, browser, public-kind,
   and documentation coverage. Complex vectors, real-system complex components,
   and complex sequence terms remain unsupported.

These changes do not introduce new mathematical object kinds. Their distinct
rollout makes it possible to assess compatibility changes independently of the
architecture that enables them.

## References

- [Mathematical objects and invariants](math-objects.md)
- [Point arguments](point-arguments-plan.md)
- [Lists and tables](lists-tables-plan.md)
- [Object completion criteria](objects-finish-plan.md)
- [Definitions and binding](../lib/defs.ts), [state integration](../lib/state.ts)
- [Expression syntax](../lib/expr.ts), [geometry lowering](../lib/geom.ts)
- [Classification](../lib/plot.ts), [complex typing](../lib/complex.ts)
- [Worker analysis](../worker/graph.ts), [browser pipeline](../web/main.ts)
- [Performance corpus](../lib/perfcase.ts), [performance guards](../lib/perf-guards.test.ts)
