# Geometry follow-ups: a plan for the next session

Written 2026-09-27, after #160 (tensors, quaternions, geometric algebra) and
#161 (follow-ups, PGA plan) merged. Read this first, then the design docs
it points to. Everything here is on `main`; nothing is in flight.

Background reading, in order:

1. docs/multisets.md — the value model every feature must fit (identity of
   names, broadcasting, "drawn as its values"). Non-negotiable.
2. docs/clifford.md — how multivectors, tensor glyphs and quaternions were
   built; the patterns below come from there.
3. docs/pga.md — the agreed design for projective geometric algebra
   (workstream A). Its decisions are settled; do not reopen them.

## Workstreams, in order

### A. Projective geometric algebra (docs/pga.md) — do first

The user agreed the plan and its three decisions (algebra hidden behind
meet/join; `line(A, B)` becomes a value; conformal GA out of scope).

- **PR 1 = phases 1–3** (algebra, values, operations). Phase 1 alone is
  lib/pga.ts plus lib/pga.test.ts, mirroring lib/clifford.ts: blade
  bitmasks with e0 as an extra bit, a metric table where e0² = 0, the
  complement J for the regressive product (join), normalisation of points,
  motors and their exp. Pin the identities listed in pga.md's phase 1
  before writing any lowering.
- Phase 2 reuses the multivector plumbing: an internal `[pga]` node (see
  `MV_CALL`, `mvNode`, `mvOfNode` in lib/clifford.ts), lowering beside
  `lowerMv` in lib/geom.ts, and named values written into rows through a
  `ResolveOpts` hook like `multivector` (lib/defs.ts). The hard constraint
  is that every existing `line(A, B)` row draws the same GLSL: add a test
  that compiles each example and saved-link row using `line(` before and
  after, and diff the shader source.
- Phase 3 must pin the multiset section of pga.md with tests (identity of
  a named line, broadcasting over a family of planes, ideal points counted).
- **PR 2 = phases 4–5** (motors, examples). Examples: the orthocentre,
  Desargues with draggable points, two planes' line, a screw motion, a
  polyhedron's shadow.

### B. Smaller follow-ups — independent, any order after A (or between PRs)

1. **Draw a multiset of multivectors.** Today `[1, 2] e_xy` reads out but
   draws nothing: lib/plot.ts returns the readout early for a list of
   `[mv]` nodes (`if (expr.kind === 'list') return readout;`). Draw one
   glyph family per element (lib/glyphs.ts `multivectorGlyphs`), flattened
   into one figure family, within `FIGURE_FAMILY_NODES`. Quick.
2. **`action` over a multiset of matrices.** Same shape of change in the
   `acting` block of lib/plot.ts (currently an error "one matrix at a
   time"). Quick.
3. **Tensor streamlines for 2×2 fields.** Integral curves of the major
   eigenvector, as an option on the row like `showStreamlines`. An
   eigenvector field is a line field (no sign), so the integrator must
   keep orientation continuous between steps (flip when the dot product
   with the previous direction is negative). The LIC shader in
   web/render2d.ts `vfieldFrag` is the template. Medium.
4. **3×3 matrix fields as ellipsoid glyphs.** A new kind (`tfield3d`),
   drawn on the CPU as a lattice of small meshes (image of a sphere under
   M), like the 3D arrow lattice for `vfield3d`. Every kind needs the
   exhaustive switches listed under "Adding a kind". Medium.
5. **Multivector fields** (a multivector in x, y, z, u or v). Needs a
   design conversation with the user before code: which picture (a glyph
   lattice? a rotor field as a frame field?) is not obvious. Lowest
   priority; raise it, don't build it.

Remove each item from docs/clifford.md's "Not done" as it lands.

## How this codebase works (learned the hard way)

- **Pipeline.** Rows parse (lib/expr.ts), resolve (lib/defs.ts: functions
  inlined, named values written in), lower (lib/geom.ts: points, matrices,
  tensors, multivectors become scalar expressions), classify (lib/plot.ts:
  a `MathObject`), compile (lib/compiler.ts: CPU plan + GPU plan), render
  (web/main.ts, web/render2d.ts, web/render3d.ts) and preview
  (worker/og.ts, the static link image).
- **Internal value nodes.** A value with no scalar form travels to
  classify as a call with a bracketed name: `[tensor]`, `[mv]`, `[action]`.
  Classify turns it into figures plus a readout (a `family` with
  `readout`). Follow the same pattern for `[pga]`.
- **Kind never depends on slider values.** A multivector reduces to a
  number or point only when its other coefficients are the literal 0
  (structural zeros); constants stay names, so dragging never reclassifies.
- **Expression size.** Symbolic coefficients grow fast. A figure whose
  vertices repeat a large expression should be one vertex template over
  numeric columns (`over`; see `arc` and `sweep` in lib/glyphs.ts).
- **Adding a builtin function:** `FUNCTIONS` and `SHADOWABLE_FNS` in
  lib/expr.ts (so a document defining that name keeps it),
  `legacyCallArgs`' grouped set if it takes tuples whole, a signature in
  lib/syntax-help.ts, and llms.txt — lib/llms-txt.test.ts fails for any
  undocumented builtin.
- **Adding a kind:** `MathObject` and `publicKind` (lib/math-object.ts),
  CPU and GPU plans plus `shaderKey` and `cpuStructureKey`
  (lib/compiler.ts), `KIND_MEANINGS` (lib/row-kind.ts), a renderer layer,
  worker/og.ts drawing and its readiness table, and a fixture row in
  worker/typed-values.fixtures.ts (a test counts the kinds). Typecheck
  finds the switches you missed.
- **Syntax traps.** `a/2 e_xy` parses as `a/(2 e_xy)`: division by a
  multivector is refused for that reason — write `(a/2) e_xy`. `u`, `v`,
  `x`, `y`, `z`, `t` are reserved names; an example cannot name a point `v`.
- **Glyphs the system fonts lack** (`⟑`) are mapped by a `unicode-range`
  face in web/style.css and web/about/about.css; a new operator glyph
  needs the same.

## Verifying work

- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check` every commit;
  `pnpm test:editor` and `pnpm test:objects` (browser) before a PR.
- **Look at everything you add.** Valid-but-wrong formulas pass every test.
  Run `npx vite --port 5199`, open each new example and card in a browser,
  in light and dark. Check numbers numerically too (a sampled vertex, a
  readout) — a picture that looks plausible can still be wrong.
- Quick probing without vitest: a scratch script run with
  `node --experimental-transform-types` that calls `analyzeRows(rows,
  { readouts: true })` from lib/analysis.ts and prints the last row's
  `error`, `cls.object.kind` and `plotReadout(cpu, env)`.
- **Examples** (web/examples.ts) need tags from `TAGS` and a thumbnail:
  `pnpm shots:examples` shoots only new or edited ones, and a test fails
  when one is missing or stale. **About-page cards** are
  web/about/showcase.ts plus `pnpm shots <slug>`. Both screenshot scripts
  refuse to run while something else holds port 5199 — stop the dev
  server first.

## Git

- Branch from `main`, one commit per phase with its tests, and a PR per
  workstream (or per PGA PR above). PRs are squash-merged.
- Another session may be working in the same checkout: check
  `git status` and `git log` before committing, and never commit files you
  did not change.
- For stacked PRs, retarget the child to `main` before merging the parent
  with branch deletion, or GitHub closes the child.
