# @equation/og-renderer

Draws an Equation.io graph to a PNG on the CPU. Used by the Cloudflare Worker for
`/api/og/…` link previews, where there is no WebGL.

```ts
import { canRenderOg, renderOgPng } from '@equation/og-renderer';

if (canRenderOg(['y = sin(x)'])) {
  const png: Uint8Array = await renderOgPng(['y = sin(x)'], { width: 600, height: 315 });
}
```

It has no Worker, request or caching code: the graph's rows go in and PNG bytes come
out. Parsing and analysis come from the shared core in `lib/`, not a copy.

Tests: `pnpm vitest run packages/og-renderer`.
