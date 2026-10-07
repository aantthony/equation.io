---
title: Share links with preview images (/g/)
summary: The /g/ form, which unfurls with a rendered preview image.
---

The same payload also works as a path, and this form unfurls with a rendered
preview image (og:image) in chat apps and social cards:

    https://equation.io/g/<equation>;<equation>;...

Prefer the `/g/` form when the link will be posted somewhere that shows link
previews; prefer the `#` form otherwise (it keeps the equations out of server
logs). Both open the same app with the same graph. The preview image itself is
served at `https://equation.io/api/og/<same payload>`.
