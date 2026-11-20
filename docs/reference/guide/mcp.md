---
title: MCP server
summary: The MCP endpoint and its tools, for AI assistants.
---

An MCP endpoint (Streamable HTTP) lives at:

    https://equation.io/mcp

Tools: `encode_graph_url` (validates each equation through the app's own parser,
returns url/share_url plus per-row classification or errors, with text-only MCP responses) and
`decode_graph_url` (decodes an existing link back into its equation rows so you can
edit a user's graph and build a new link). This document is also served as
the server's `syntax` MCP resource, so the full reference can be pulled on
demand instead of living in a tool description. No authentication required.

Use `show_graph` to display the interactive graph directly in an MCP Apps host
such as ChatGPT web. It accepts the same `equations` array and returns per-row
validation and share links plus an associated UI resource.
The widget supports editing, sliders, zoom, and 3D rotation; edits update the
model's context with the complete current equations and share_url. Preserve
those edited rows on follow-up requests. Use `encode_graph_url` for validation
or link-only requests. Clients without MCP Apps support can open share_url.
