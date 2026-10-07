---
kind: orbit
title: Orbit
form: th' = om; om' = -sin(th); th(0) = 1; th(0..20)
short: a simulated state over a time range
---

The path a simulated state takes over a range of time, integrated ahead with
the live simulation's own steps.

## Forms

- `p(start..end)` for a state p defined by `p' = …` (see State, under
  Definitions); a scalar state plots against time.

## Examples

- Pendulum angle over time: `th' = om; om' = -sin(th); th(0) = 1; th(0..20)`
- Planet's path: `r' = vel; vel' = -r/|r|^3; r(0) = (1, 0); vel(0) = (0, 1.2); r(0..20)`

## Details

- Orbit: `p(50..400)` draws the path the state takes from t = 50 to t = 400,
  integrated ahead of time from p(0) with the live simulation's own steps —
  the moving point rides exactly along it. Start after 0 to skip the
  transient onto an attractor. A family draws one path per run (keep it to
  a few, or pick one of runs in order: `p[1](50..400)`); a scalar state plots against time,
  `th(0..20)` being the curve (t, th). The range must be constant (sliders
  are fine; the orbit re-integrates when they move), 0 <= start < end; anything
  drawn from states works too, like `b2(0..30)` for a pendulum bob. Orbit
  plus family is how to draw a strange attractor with particles on it.
