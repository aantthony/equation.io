---
kind: oklch2d
title: OKLCH colour field
form: oklch(0.7, 0.15, atan2(y, x))
short: colour field (OKLCH) filling the plane
---

A colour field filling the plane from lightness, chroma and hue (radians),
with more even perceived lightness than HSL.

## Examples

- Hue wheel: `oklch(0.7, 0.15, atan2(y, x))`
- Turning wheel: `oklch(0.72, 0.16, arg(w)+t/3)`

## Details

- OKLCH color field: `oklch(lightness, chroma, hue)` uses lightness 0–1,
  nonnegative chroma (typically 0–0.4), and hue in radians. Lightness is
  clamped, negative chroma becomes zero and hue wraps around 2pi. Zero chroma
  is neutral gray; lightness 0 and 1 give black and white. Colors outside
  sRGB are mapped by reducing chroma at fixed lightness and hue, then encoded
  as sRGB. This is strict chroma reduction, not CSS's local-MINDE algorithm
  or wide-gamut output. Try `oklch(0.72, 0.16, arg(w)+t/3)` for a wheel
  with more even perceived lightness than HSL. HSL and OKLCH have the same
  real-channel, whole-row and transparency rules as RGB; all three accept
  equations, sliders and time. Every channel is 0–1 except hue (radians,
  like trig functions and `arg`, so `arg(w)` is a hue directly) and chroma.
  To port a CSS color, divide 0–255 channels by 255, percentages by 100, and
  write a degree hue as `h pi/180`.
