# Task: measurable assistant knowledge for Equation.io's Apple app (evals first)

## Context

You're working in the equation.io repo (a graphing calculator: TypeScript language
core in `lib/`, web renderer in `web/`, Cloudflare Worker in `worker/`). On the local
branch `swift-core` there is a native Apple app in `apple/` (SwiftUI, iOS/macOS 27):
- `apple/Equation`: the app. The graph is drawn in Metal (`apple/EquationCore`'s `EquationRender`),
  from rows the Swift port of the language analyzes; no web view.
- `apple/EquationCore`: a Swift port of the parser, held to the TypeScript by a
  recorded corpus (`pnpm swift:test`).

**Do not push this branch or open a PR, and don't merge anything. Commit locally only.**
End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
Pushing to main deploys the site, which is not wanted yet.

The app has an AI feature, "Ask" (`apple/Equation/Sources/Chat.swift`):
- **Model:** Apple's Foundation Models framework. Today that's the on-device model,
  "AFM 3 Core Advanced", with an **8,192-token context**. Later it will be Apple's
  Private Cloud Compute model (32K context, with reasoning). Switching is
  `ChatModel.usePrivateCloudCompute`; the PCC entitlement isn't granted yet, so PCC
  calls fail with ModelManagerError 1046. Don't use PCC.
- **Instructions:** adapted from the web voice prototype's prompt
  (`lib/voice-agent.ts` `INSTRUCTIONS`).
- **Tools:** the voice prototype's. `get_graph` and `set_graph` return each row's
  status and meaning, from `voiceGraph()` in `web/main.ts`; plus `move_view`,
  `animate_slider`, `read_syntax`. In the app they act on the open graph
  (`GraphAccess` in `apple/Equation/Sources/Chat.swift`).
- **Syntax lookup:** `read_syntax` is a keyword search (`lib/syntax-search.ts`) over
  `web/public/llms.txt`, a 113 KB, about 28K-token single file. It's capped at 4
  entries / 2,500 characters for the 8K model.
- **Each turn's prompt:** the graph's current rows (with errors and readouts),
  followed by the user's request.

## The problem

The on-device model makes confident mistakes because it gets the wrong knowledge,
in the wrong shape. Observed:
- **"Draw a unit cube":** it wrote one row,
  `(interval(0,1), 0, 0), (2cos(6pi u), 2sin(6pi u), 2u - 2)`, a mash-up of the
  reference's helix example (llms.txt line 873) and its unit-cube example (line 891,
  18 lines away). That drew a helix. It then replied "a unit cube as a solid",
  ignoring `set_graph`'s meaning, which said otherwise.
- **"Add a slider for the amplitude":** adds `A = 1` but doesn't use it in the curve.
- **"Animate it":** adds an animated copy instead of changing the existing row.
- **Ordering:** animates a slider before creating it.
- **Two shapes in one row.**

The correct cube forms are `hull(([0,1],[0,1],[0,1]))` and
`(interval(0,1), interval(0,1), interval(0,1))`.

## Goal

Redesign the assistant's knowledge and tools so they work well in 8K, and prove it
with numbers. **Measure first.**

### Step 1: eval harness and baseline (do this first, and report the baseline)

Build an eval suite and runner, e.g. in `apple/evals/`:
- **Tasks** (about 30, JSON or TS): a starting graph (rows), a request, and
  machine-checkable success criteria. Cover common requests and every failure
  above. Examples:
  - "draw a unit cube": some row's kind is `solid` or a hull polygon, no row has
    an error, and the starting rows are unchanged;
  - "add a slider for the amplitude": a slider exists and the curve's row uses it;
  - "make it move": the original row now uses `t`, and the rows weren't duplicated;
  - "shade the area under sin from 0 to π": a definite integral row with value ≈ 2;
  - "zoom in on where it crosses zero": `move_view` was called with a window
    around 0;
  - the reply's claims match what was drawn (start with a simple check: a reply
    that names a shape while no row has that kind fails).

  Include 3D, polar, parametric, vector field, points, labels and colors.
- **Runner:** a Swift command-line tool (`swiftc`, `import FoundationModels`;
  `SystemLanguageModel.default` works from a CLI on this Mac) that uses the app's
  exact instructions and tool definitions. Share the code with `Chat.swift`
  (extract it) rather than copying it. Its tools call a small **Node service**
  (JSON over stdin/stdout) that runs the real analyzer from `lib/`
  (`prepareDocument` / `analyzePrepared` in `lib/analysis.ts`, kinds and meanings
  from `lib/row-kind.ts`, as `worker/mcp.ts` validates rows). So the grading, and
  what the tools report, match what the app would draw. Camera and slider tools
  can be simulated in the service (record their arguments and validate them).
- **Report:** pass rate per task and overall, tool calls per task, and approximate
  tokens. Run each task several times (the model is nondeterministic); report pass
  rate and variance. Save results so runs can be compared.
- **Structure:** a Claude baseline will be added tomorrow (an API key will be in
  the environment), so make the model pluggable. On-device only for now.

### Step 2: small, precise tools (re-measure after each)

Replace the single keyword search with:
- **`check(rows)`:** analyze proposed rows without changing the graph. Return each
  row's kind, meaning, value, error and warning. Built on the same analyzer;
  the app answers it from the Swift port of the analyzer (`GraphAccess.check`).
- **`search_functions(query)` and `function_doc(name)`:** from the function
  signatures in `lib/syntax-help.ts` (about 90; extend them to cover the language's
  builtins, `FUNCTIONS` in `lib/expr.ts`).
- **`list_kinds()`:** the "first page". Every render kind (`KIND_MEANINGS` in
  `lib/row-kind.ts`, about 40) with a one-line meaning and its minimal syntax.
- **`kind_examples(kind)`:** 2–4 worked examples for a kind. Build the index by
  running the analyzer over `web/examples.ts` (269 tagged examples, all compiled in
  CI) and labelling each row with its kind.

Revise the instructions to match: a short primer, then "use list_kinds /
kind_examples / function_doc / check". Keep the voice prototype's hard-won rules
(polar via u, function definitions draw nothing, reserved names), and add
"one shape per row" and "check before claiming". Keep each tool result small.

### Step 3: one structured reference, three outputs

Create a human-written source, e.g. `docs/reference/`:
- an index of render kinds;
- a page per kind (what it draws, forms, pitfalls, examples);
- function docs (generated from code signatures, plus written notes).

Generate from it:
1. **Public human docs** on the site (`equation.io/docs/…`, built with the site's
   existing Vite setup; look at `web/about`, `web/landing` and `vite.config.ts`).
   Readable, linkable, light and dark themes like the rest of the site. Don't
   deploy; it's fine that they'll go live on a later merge.
2. **`web/public/llms.txt`**, still a single file for MCP clients and other
   assistants. Preserve its existing sections on links and the MCP server.
3. **The assistant's tool data**, bundled into the app by `pnpm app:web` (see
   `apple/vite.config.ts`, which already emits `examples.json` and `llms.txt`).

Also make `lib/voice-agent.ts` and the app share one source for the assistant's
core instructions (variants for voice and text), so a fix is made once.

## Conventions and checks

- **Before committing:** `pnpm fmt:check` (oxfmt), `pnpm lint`, `pnpm typecheck`,
  `npx vitest run`, and `pnpm test:editor` for web changes.
- **Known pre-existing failure:** `pnpm test:objects` times out at its
  "3D point lists" step on main. Ignore that one step.
- **The app:** `pnpm app:web`, then `xcodegen -s apple/Equation/project.yml`, then
  build (`xcodebuild … -destination 'platform=macOS'`). macOS is the current focus.
- **Read every example you add or change**, ideally rendered: formulas that are
  valid but wrong pass every test.
- **Match the surrounding code's style:** comment density, naming, no
  over-engineering.
- **Write up results** after each step in `apple/evals/RESULTS.md`: baseline, then
  the delta from each change. Stop after step 1 and report the baseline before
  starting step 2.
