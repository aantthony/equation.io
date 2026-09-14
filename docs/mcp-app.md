# Equation.io in ChatGPT web

`show_graph` returns validated equations and share links with an MCP Apps UI
resource (`ui://equation/graph-v1.html`). The UI reuses the website's editor and
WebGL renderer. `encode_graph_url` and `decode_graph_url` remain data-only tools.
No API key, account, or OpenAI API calls are needed by the server.

The UI uses `@modelcontextprotocol/ext-apps` for initialization, tool results,
theme changes, fullscreen, external links, and model-context updates. Changes
to equations and sliders are sent through `ui/update-model-context`, throttled
by the editor's existing URL-save interval. This does not send a chat message
or trigger a model response. ChatGPT's optional widget state stores edited rows
for the matching original result. Graphs still have shareable URLs.

Embedded graphs start with the equation editor collapsed. Host theme, color and
font variables style the controls, and host safe-area insets keep controls clear
of overlays. Expand/Collapse is available only when the host supports the
destination mode, and follows the mode the host actually grants. Escape requests
a return to inline mode when fullscreen, using the same capability checks.

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
asset URLs against the server origin. Hashed assets allow cross-origin reads;
the website retains its existing CSP. The UI runs directly in the host's frame
and does not embed another website. Its resource CSP allows only our assets
and blob scripts for the background curve-tracing worker. It makes no API
requests. CSV files stored on the author's device are not transferred to chat.

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
pnpm exec vitest run worker/mcp.test.ts
pnpm typecheck
```

The browser test loads the production MCP resource in a separate-origin,
sandboxed iframe with CSP restrictions and exercises the bridge and graph UI.
It is a host simulation; verify the actual ChatGPT integration separately.

## Connect in ChatGPT

Deploy the Worker and assets together with `pnpm deploy`, or expose the local
server through a development HTTPS tunnel. A local loopback URL alone is not
reachable by ChatGPT's remote MCP client. For a tunnel, ensure UI asset URLs
are also reachable through its public origin.

Following the [official connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt):

1. Enable Developer mode in ChatGPT settings under Security and login (subject
   to account and workspace policy).
2. Add an MCP connection from ChatGPT Plugins using the deployed HTTPS `/mcp`
   URL, e.g. `https://equation.io/mcp`, with no authentication.
3. Refresh the connection if it already exists, and check that `show_graph`
   appears. Start a new conversation with the connection enabled.
4. Ask: “Show y = a sin(x), with a = 2 and an adjustable slider.”
5. Move the slider, then ask to add a cosine curve while preserving your edits.
   Check dark/light theme, Expand/Collapse, and Open in equation.io.
6. Try “Show x² + y² + z² = 9”, and an invalid equation to check error display.

Refresh metadata after deployment. Bump the UI resource URI for breaking UI
contract changes because hosts can cache resources. Public directory submission
is separate from testing an MCP connection in developer mode.

References: [MCP Apps UI integration](https://developers.openai.com/plugins/build/chatgpt-ui),
[MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview).
