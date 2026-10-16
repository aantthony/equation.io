# Equation.io in MCP Apps hosts

`show_graph` returns validated equations and share links with an MCP Apps UI
resource (`ui://equation/graph-v2.html`). The UI reuses the website's editor and
WebGL renderer. `encode_graph_url` and `decode_graph_url` remain data-only tools.
No API key, account, or OpenAI API calls are needed by the server.

The UI uses `@modelcontextprotocol/ext-apps` for initialization, tool results,
theme changes, fullscreen, external links, and model-context updates. Changes
to equations and sliders are sent through `ui/update-model-context`, throttled
by the editor's existing URL-save interval. This does not send a chat message
or trigger a model response. Hosts that list `image` under
`updateModelContext` also get a JPEG of the graph (longest edge 1280px,
drawn fresh, as voice mode's look_at_graph does), so the model sees the
picture and not only the equations. It follows the equations once edits pause
for 600ms and background curve traces have landed, so a slider drag doesn't
encode a frame on every save tick. ChatGPT shows it as a removable attachment
titled by `_meta["openai/title"]`: "Edited graph", or "Graph" for a deep-linked
graph the model has never seen. A graph the model already knows (untouched, or
reset) gets no picture. An off-screen graph skips the picture rather than
break its render pause; teardown takes one before the renderer is released.
ChatGPT's optional widget state stores edited rows
for the matching original result. Graphs still have shareable URLs.

Embedded graphs start with the equation editor collapsed. Host theme, color and
font variables style the controls, and host safe-area insets keep controls clear
of overlays. Reset appears when the equations differ from the confirmed tool
result and restores those original rows, the viewport, and the simulation
clock. Expand/Collapse is
available only when the host supports the destination mode, and follows the
mode the host actually grants. Escape requests a return to inline mode when
fullscreen, using the same capability checks.

Tool arguments render immediately on `ontoolinput`, before server validation
returns. `ontoolinputpartial` previews streamed equations, coalescing bursts
every 32 ms; unfinished expressions use the editor's normal error handling.
Matching tool results confirm the existing graph without resetting animations
or slider edits. Preview rows are not persisted or published to model context
until a successful tool result confirms them. Hosts that send only results
continue to work.

Following the official [Shadertoy example](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/shadertoy-server),
graphs pause rendering when off-screen or when the document is hidden. The
simulation clock also pauses, so animations resume without jumping ahead.
Teardown saves pending edits and stops render timers, tracing work, the worker,
and GPU resources.

The Worker reads the built `/mcp-app/` HTML through `ASSETS` and resolves its
asset URLs against the server origin. The page names no hashed bundle: hosts
keep the copy they were served (ChatGPT stores one with each conversation), so
it loads `/mcp-app/app.js` and `/mcp-app/app.css`, stable files that import
the current build's hashed entries and are revalidated on every load
(`mcpAppLoader` in vite.config.ts). A kept copy therefore runs the current
build rather than the one it was served with, or nothing once that build's
bundles are gone. Hashed assets allow cross-origin reads;
the website retains its existing CSP. The UI runs directly in the host's frame
and does not embed another website. Its resource CSP allows only our assets
and blob scripts for the background curve-tracing worker. It makes no API
requests. CSV files stored on the author's device are not transferred to chat.

Sandbox domain formats differ between hosts. We omit `ui.domain` so Claude
uses its default sandbox, and provide `openai/widgetDomain` for ChatGPT's
unique widget origin requirement using its supported compatibility alias.

## ChatGPT sidebar and conversation panels

`graphing_calculator` is the app's own entry point, per OpenAI's
[MCP extensions](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md):
its `_meta["openai/ui"].entrypoints` list `global` (the ChatGPT sidebar) and
`thread` (a panel beside a conversation). The host calls it with `{}` and it
returns an empty graph, which the UI treats as a launch: the editor comes out
on one empty line, and there is no Reset. Its `_meta.ui.visibility` is `["app"]`,
so the model is never offered it; `show_graph` stays the model's way to draw.
The sidebar title is the tool's `title` and its icon is `/mcp-icon.svg` (20×20,
monochrome, `currentColor`), both from `tools/list`.

A deep link opens a graph: the host passes the app-relative URL in
`hostContext["openai/deepLink"].url`, at launch or later, and the site's own
`/g/…` or `/#…` path loads those rows (`linkRows` in `lib/link.ts`). That
graph becomes the original Reset returns to, and is published to model context
at once, since the model has not seen it. A link arriving while the app is
open replaces the graph as one undoable step. Any other path is a blank graph;
a link that fails to decode leaves the graph alone and says so. The public link form is
`https://chatgpt.com/plugins/<plugin-id>/app/graphing_calculator?path=<encoded /g/… path>`.

Edits made in a sidebar or panel go to that thread's model context, picture
included, as they do inline.

## Known gaps

A central `app.onerror` handler is not implemented yet. Individual bridge calls
handle failures, but general SDK/transport error reporting remains a future
improvement.

## Local verification

```sh
pnpm web:build
pnpm exec wrangler dev --config dist-web/equation/wrangler.json --port 5196
# In another terminal:
node scripts/mcp-app-test.ts
node scripts/mcp-sidebar-test.ts
pnpm exec vitest run worker/mcp.test.ts
pnpm typecheck
```

The browser test loads the production MCP resource in a separate-origin,
sandboxed iframe with CSP restrictions and exercises the bridge and graph UI.
It is a host simulation; verify integration with supported hosts separately.

Hosts can cache resources. Bump the UI resource URI for breaking UI contract
changes.

Reference: [MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview).
