---
title: Guidance for assistants
summary: How an AI assistant should build, edit and share graphs.
---

- To show a user a graph, emit a single https://equation.io/g/... link built
  as Deep links below describes; the graph renders immediately on load, no
  interaction needed.
- To edit a graph the user already has, decode their link (or call the MCP
  `decode_graph_url` tool), transform the rows, and emit a new link. Prefer
  restructuring into named definitions: e.g. given `y = x^2 - 2x`, "add a
  tangent line at x = 3" becomes
  `f(x) = x^2 - 2x; g(x) = d/dx f(x); a = 3; y = f(x); y = f(a) + g(a)(x - a)`
  — with `a` as a draggable slider so the point of tangency stays explorable.
- Prefer a slider constant (`a = 1; ...`) when the user may want to explore a
  parameter, and `t` when they ask for animation.
- Don't name a slider, list or index `i`, `e`, `pi` or `d`: they are
  taken (`i` is the imaginary unit), so `i = [0..9]` is a claim about i, not
  a definition, and every later `i` stays complex. Use `k = [0..9]`.
- The graph state lives entirely in the link, and the link is the interface.
  The only server endpoints are /mcp (an MCP server that validates equations
  and emits links) and /api/og (link-preview images).
- If you are unsure whether a form is supported, emit the link anyway.
  Unsupported input fails loudly and visibly (an inline error on the offending
  row), never silently — so a graph either renders correctly or tells the user
  what to fix. There is no wrong-but-silent output to worry about.
- Write one shape per row: a circle and a line are two rows, not one row
  holding both. Each kind of row has its own section under Row types below,
  its name first, then its forms, worked examples and pitfalls; read the one
  for the shape you are drawing, and adapt an example rather than copying it.
- Polar curves r = f(θ) are traced parametrically with θ = 2πu:
  `(f(2pi u) cos(2pi u), f(2pi u) sin(2pi u))` (see
  [Parametric curve](#pcurve)). Parametric curves and surfaces run over u
  and v from 0 to 1, not t: t is time, and makes a row move.
- `f(x) = …` only defines f and draws nothing: add `y = f(x)` to draw it.
