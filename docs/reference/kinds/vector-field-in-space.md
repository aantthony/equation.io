---
kind: vfield3d
title: Vector field in space
form: (-y, x, 0.5)
short: 3D vector field
---

A 3D vector field, drawn as trajectories through space: a triple of
expressions in x, y and z, or a system `(x', y', z') = (…)`.

## Examples

- Swirl: `(-y, x, 0.5)`
- Lorenz system: `(x',y',z') = (10(y-x), x(28-z)-y, x y-8z/3)`
- Curl of a field: `curl((y z, -x z, 0))`

## Details

A 3-tuple in x/y/z, or `(x',y',z') = (10(y-x), x(28-z)-y, x y-8z/3)`, draws
32 deterministic auto-seeded trajectories in space. Traces run in a worker
with bounded RK4 steps and a directional fade. Moving fields are retraced at
most four times per second. The arrows control switches to a 5×5×5 lattice
of direction glyphs; there is no ambiguous 3D click-to-seed.
