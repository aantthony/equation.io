---
kind: hsl2d
title: HSL colour field
form: hsl(atan2(y, x), 1, 0.5)
short: colour field (HSL) filling the plane
---

A colour field filling the plane from hue (radians), saturation and
lightness (0 to 1).

## Examples

- Hue wheel: `hsl(atan2(y, x), 1, 0.5)`
- Turning wheel: `hsl(arg(w)+t/3, 1, 0.5)`

## Details

- HSL color field: `hsl(hue, saturation, lightness)` uses hue in radians and
  saturation/lightness on a 0–1 scale (not CSS's percentages). Hue wraps
  around 2pi; saturation/lightness are clamped. `hsl(2pi/3, 1, 0.5)` is
  green. An animated wheel is `hsl(arg(w)+t/3, 1, 0.5)`.
