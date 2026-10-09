---
title: Named shapes
summary: Well-known curves and surfaces, each as rows to adapt.
---

Well-known curves and surfaces, each written as rows of this language. A
form uses named parameters: give them numbers, or define each one above it
(`a = 2`) to get a slider. Below each form is one instance with numbers
filled in. In parametric forms u and v run from 0 to 1, so an angle is
`2pi u`; a polar curve r = f(θ) is traced with θ = 2πu, never written as a
bare `r = …` row.

## Circle

The points at one distance, the radius, from a centre.

- implicit2d: `x^2 + y^2 = R^2` — centred at the origin
  - `R`: the radius
  - e.g. R = 1.5: `x^2 + y^2 = 2.25`
- pcurve: `(R cos(2pi u), R sin(2pi u))`
  - `R`: the radius
  - e.g. R = 1.5: `(1.5cos(2pi u), 1.5sin(2pi u))`

Pitfall: centred elsewhere, `(x - h)^2 + (y - k)^2 = R^2`, or
`circle((h, k), R)`.

## Disc

Also: disk, filled circle.

The inside of a circle, shaded.

- ineq2d: `x^2 + y^2 <= R^2`
  - `R`: the radius
  - e.g. R = 2.5: `x^2 + y^2 <= 6.25`

Pitfall: only in 2D. A solid in 3D is a ball.

## Ellipse

A circle stretched along its axes.

- implicit2d: `x^2/a^2 + y^2/b^2 = 1`
  - `a`: the half-width, along x
  - `b`: the half-height, along y
  - e.g. a = 4, b = 2: `x^2/16 + y^2/4 = 1` — 8 wide, 4 tall
- pcurve: `(a cos(2pi u), b sin(2pi u))`
  - `a`: the half-width, along x
  - `b`: the half-height, along y
  - e.g. a = 4, b = 2: `(4cos(2pi u), 2sin(2pi u))` — 8 wide, 4 tall

## Parabola

The graph of a quadratic: one bend, both arms rising (or falling) without
bound.

- implicit2d: `y = a(x - h)^2 + k` — opens up for a > 0, down for a < 0
  - `a`: how steep; the vertex is the point (h, k)
  - `h`: the vertex's x
  - `k`: the vertex's y
  - e.g. a = 0.5, h = 1, k = -2: `y = 0.5(x - 1)^2 - 2` — vertex (1, −2)
- implicit2d: `x = a y^2` — opening sideways
  - `a`: how steep
  - e.g. a = 0.25: `x = 0.25y^2`

## Hyperbola

Two mirror-image branches that approach a pair of crossing lines, the
asymptotes.

- implicit2d: `x^2/a^2 - y^2/b^2 = 1` — branches left and right
  - `a`: the distance from the centre to each vertex, along x
  - `b`: sets the asymptotes, y = ±(b/a)x
  - e.g. a = 2, b = 3: `x^2/4 - y^2/9 = 1` — vertices (±2, 0)
- implicit2d: `x y = c` — the rectangular hyperbola, its asymptotes the axes
  - `c`: how far out the branches sit (positive: first and third quadrants)
  - e.g. c = 3: `x y = 3`

Pitfall: swap the signs (`y^2/b^2 - x^2/a^2 = 1`) for branches above and
below.

## Cardioid

Also: heart curve.

A heart shape with a cusp: the path of a point on a circle rolling round
another circle of the same size.

- pcurve: `(a(1 + cos(2pi u)) cos(2pi u), a(1 + cos(2pi u)) sin(2pi u))` — polar r = a(1 + cos θ), with θ = 2πu
  - `a`: the size; the curve reaches 2a along the positive x-axis, its cusp at the origin
  - e.g. a = 2: `(2(1 + cos(2pi u)) cos(2pi u), 2(1 + cos(2pi u)) sin(2pi u))` — r = 2(1 + cos θ)
- implicit2d: `(x^2 + y^2 - a x)^2 = a^2(x^2 + y^2)` — the same curve as an equation
  - `a`: the size, as above
  - e.g. a = 2: `(x^2 + y^2 - 2x)^2 = 4(x^2 + y^2)` — r = 2(1 + cos θ)

Pitfall: polar r = f(θ) is never a bare `r = …` row. With sin in place of
cos the heart points up: r = a(1 + sin θ).

## Limaçon

Also: limacon, limaçon of Pascal.

The polar curve r = b + a cos θ: a dimpled oval, or a loop inside a loop when
a > b. With a = b it is the cardioid.

- pcurve: `((b + a cos(2pi u)) cos(2pi u), (b + a cos(2pi u)) sin(2pi u))` — polar r = b + a cos θ, with θ = 2πu
  - `b`: the constant part of r
  - `a`: how much r swings; a > b makes the inner loop
  - e.g. b = 1.5, a = 2.5: `((1.5 + 2.5cos(2pi u)) cos(2pi u), (1.5 + 2.5cos(2pi u)) sin(2pi u))` — r = 1.5 + 2.5cos θ, with its inner loop

## Rose

Also: rose curve, polar rose, rhodonea.

Petals round the origin: the polar curve r = a sin(kθ) or r = a cos(kθ). An
odd k gives k petals, an even k gives 2k.

- pcurve: `(a sin(2pi k u) cos(2pi u), a sin(2pi k u) sin(2pi u))` — polar r = a sin(kθ), with θ = 2πu
  - `a`: the petal length
  - `k`: a whole number setting the petals
  - e.g. a = 2, k = 3: `(2sin(6pi u) cos(2pi u), 2sin(6pi u) sin(2pi u))` — r = 2sin(3θ), 3 petals
- pcurve: `(a cos(2pi k u) cos(2pi u), a cos(2pi k u) sin(2pi u))` — polar r = a cos(kθ), the same rose turned
  - `a`: the petal length
  - `k`: a whole number setting the petals
  - e.g. a = 2, k = 3: `(2cos(6pi u) cos(2pi u), 2cos(6pi u) sin(2pi u))` — r = 2cos(3θ), 3 petals

Pitfall: θ is 2πu, so kθ is `2pi k u`, and k goes only in the petal factor
at the front of each component, never in the `cos(2pi u)` and `sin(2pi u)`
that turn it. For r = a cos(kθ), the petal factor is a cos. Polar is never a
bare `r = …` row.

## Lemniscate

Also: lemniscate of Bernoulli, figure eight, infinity curve.

A figure eight lying on its side, crossing itself at the origin.

- implicit2d: `(x^2 + y^2)^2 = a^2(x^2 - y^2)`
  - `a`: the half-width, where it meets the x-axis
  - e.g. a = 2: `(x^2 + y^2)^2 = 4(x^2 - y^2)`
- pcurve: `(a cos(2pi u)/(1 + sin(2pi u)^2), a sin(2pi u) cos(2pi u)/(1 + sin(2pi u)^2))`
  - `a`: the half-width, as above
  - e.g. a = 2: `(2cos(2pi u)/(1 + sin(2pi u)^2), 2sin(2pi u) cos(2pi u)/(1 + sin(2pi u)^2))`

## Archimedean spiral

Also: spiral, arithmetic spiral.

A spiral whose turns are evenly spaced: r grows in step with θ.

- pcurve: `(a u cos(2pi n u), a u sin(2pi n u))` — polar r ∝ θ over n turns
  - `a`: the radius at the outer end
  - `n`: the number of turns
  - e.g. a = 3, n = 4: `(3u cos(8pi u), 3u sin(8pi u))`

## Logarithmic spiral

Also: equiangular spiral, growth spiral.

A spiral whose turns widen by the same factor each time round: r = a e^(bθ).

- pcurve: `(a exp(2pi b n u) cos(2pi n u), a exp(2pi b n u) sin(2pi n u))` — polar r = a e^(bθ) over n turns
  - `a`: the radius at the start
  - `b`: the growth rate; each turn multiplies r by e^(2πb)
  - `n`: the number of turns
  - e.g. a = 0.2, b = 0.15, n = 3: `(0.2exp(0.9pi u) cos(6pi u), 0.2exp(0.9pi u) sin(6pi u))`

## Astroid

Also: star curve, hypocycloid with four cusps.

A four-pointed star with curved sides, traced by a point on a circle rolling
inside one four times its size.

- implicit2d: `abs(x)^(2/3) + abs(y)^(2/3) = a^(2/3)`
  - `a`: the distance from the centre to each point
  - e.g. a = 3: `abs(x)^(2/3) + abs(y)^(2/3) = 3^(2/3)`
- pcurve: `(a cos(2pi u)^3, a sin(2pi u)^3)`
  - `a`: the distance from the centre to each point
  - e.g. a = 2.5: `(2.5cos(2pi u)^3, 2.5sin(2pi u)^3)`

Pitfall: a fractional power of a negative number is undefined, so the
equation needs `abs`.

## Cycloid

The arches traced by a point on the rim of a wheel rolling along the x-axis.

- pcurve: `(a(2pi n u - sin(2pi n u)), a(1 - cos(2pi n u)))`
  - `a`: the wheel's radius; each arch is 2a high and 2πa long
  - `n`: the number of arches
  - e.g. a = 0.5, n = 3: `(0.5(6pi u - sin(6pi u)), 0.5(1 - cos(6pi u)))`

## Lissajous curve

Also: Lissajous figure, Bowditch curve.

The path of a point swinging along x and y at two different frequencies.

- pcurve: `(sin(2pi a u + p), sin(2pi b u))`
  - `a`: a whole number, the swings along x
  - `b`: a whole number, the swings along y; equal to a, it is only an ellipse
  - `p`: a phase shift
  - e.g. a = 3, b = 5, p = 0.5: `(sin(6pi u + 0.5), sin(10pi u))`

Pitfall: multiply a component to stretch it: `(2sin(6pi u + 0.5), sin(10pi u))`
is twice as wide.

## Catenary

The curve a hanging chain makes between two supports.

- implicit2d: `y = a cosh(x/a)`
  - `a`: the height of the lowest point; larger a is flatter
  - e.g. a = 2: `y = 2cosh(x/2)`

## Folium of Descartes

A leaf-shaped loop in the first quadrant, its two tails running off along
the line x + y = −a.

- implicit2d: `x^3 + y^3 = 3a x y`
  - `a`: the size of the loop
  - e.g. a = 2: `x^3 + y^3 = 6x y`

## Helix

Also: spiral in 3D, coil, corkscrew.

A curve winding round a cylinder as it climbs.

- pcurve: `(R cos(2pi n u), R sin(2pi n u), h u)` — about the z-axis
  - `R`: the radius of the coil
  - `n`: the number of turns
  - `h`: the height it climbs
  - e.g. R = 1.5, n = 5, h = 5: `(1.5cos(10pi u), 1.5sin(10pi u), 5u)`

Pitfall: the third component must climb with u; `(cos(2pi u), sin(2pi u), 0)`
is a flat circle.

## Trefoil knot

The simplest true knot: a closed curve in space that can't be untangled
into a circle.

- pcurve: `(a(sin(2pi u) + 2sin(4pi u)), a(cos(2pi u) - 2cos(4pi u)), -a sin(6pi u))`
  - `a`: the size
  - e.g. a = 0.5: `(0.5(sin(2pi u) + 2sin(4pi u)), 0.5(cos(2pi u) - 2cos(4pi u)), -0.5sin(6pi u))`

Pitfall: a 3D curve draws as a thin line; wrap it in `tube(…)` for a solid
tube.

## Plane

A flat surface in 3D.

- implicit3d: `a x + b y + c z = k`
  - `a`: the x part of the normal (a, b, c)
  - `b`: the y part of the normal
  - `c`: the z part of the normal
  - `k`: where it sits: 0 passes through the origin
  - e.g. a = 2, b = -1, c = 1, k = 3: `2x - y + z = 3`

Pitfall: a horizontal plane is `z = k`. In a 2D graph `x = 1` is a line,
not a plane: some row must use z.

## Sphere

The points at one distance, the radius, from a centre in space.

- implicit3d: `x^2 + y^2 + z^2 = R^2` — centred at the origin
  - `R`: the radius
  - e.g. R = 3: `x^2 + y^2 + z^2 = 9`
- psurface: `(R sin(pi v) cos(2pi u), R sin(pi v) sin(2pi u), R cos(pi v))`
  - `R`: the radius
  - e.g. R = 1.5: `(1.5sin(pi v) cos(2pi u), 1.5sin(pi v) sin(2pi u), 1.5cos(pi v))`

Pitfall: centred elsewhere, `(x - h)^2 + (y - k)^2 + (z - m)^2 = R^2`.
`x^2 + y^2 = R^2` alone is a 2D circle.

## Ball

Also: solid sphere, filled sphere.

The solid inside a sphere.

- solid: `s = interval(0, R); (s sin(pi v) cos(2pi u), s sin(pi v) sin(2pi u), s cos(pi v))`
  - `R`: the radius
  - e.g. R = 1.5: `s = interval(0, 1.5); (s sin(pi v) cos(2pi u), s sin(pi v) sin(2pi u), s cos(pi v))`

Pitfall: `x^2 + y^2 + z^2 <= R^2` is an error: inequalities are 2D only.
For the surface alone, see sphere.

## Ellipsoid

A sphere stretched along its three axes.

- implicit3d: `x^2/a^2 + y^2/b^2 + z^2/c^2 = 1`
  - `a`: the half-length along x
  - `b`: the half-length along y
  - `c`: the half-length along z
  - e.g. a = 3, b = 2, c = 1.5: `x^2/9 + y^2/4 + z^2/2.25 = 1`
- psurface: `(a sin(pi v) cos(2pi u), b sin(pi v) sin(2pi u), c cos(pi v))`
  - `a`: the half-length along x
  - `b`: the half-length along y
  - `c`: the half-length along z
  - e.g. a = 3, b = 2, c = 1.5: `(3sin(pi v) cos(2pi u), 2sin(pi v) sin(2pi u), 1.5cos(pi v))`

## Cylinder

A tube of one radius around the z-axis.

- psurface: `(R cos(2pi u), R sin(2pi u), h v)` — from z = 0 to z = h
  - `R`: the radius
  - `h`: the height
  - e.g. R = 1.5, h = 4: `(1.5cos(2pi u), 1.5sin(2pi u), 4v)`
- implicit3d: `x^2 + y^2 + 0z = R^2` — endless along z
  - `R`: the radius
  - e.g. R = 1.5: `x^2 + y^2 + 0z = 2.25`

Pitfall: without a z term, `x^2 + y^2 = R^2` is a 2D circle; `0z` makes it
a surface.

## Cone

Also: circular cone, double cone.

A surface whose radius grows in step with height, from a point, the apex.

- implicit3d: `x^2 + y^2 = (k z)^2` — both nappes, the apex at the origin
  - `k`: the radius gained per unit of height
  - e.g. k = 0.5: `x^2 + y^2 = (0.5z)^2` — radius 1 at height 2
- implicit3d: `z = sqrt(x^2 + y^2)/k` — the upper nappe only
  - `k`: the radius gained per unit of height
  - e.g. k = 0.5: `z = sqrt(x^2 + y^2)/0.5` — a narrow cone
- psurface: `(R v cos(2pi u), R v sin(2pi u), h v)` — one nappe, apex at the origin
  - `R`: the radius at the top
  - `h`: the height
  - e.g. R = 1.5, h = 2: `(1.5v cos(2pi u), 1.5v sin(2pi u), 2v)`

Pitfall: the equation in z^2 draws two cones tip to tip. For one, solve for
z or use the parametric form.

## Paraboloid

Also: elliptic paraboloid, bowl.

A bowl: every horizontal slice is a circle, every vertical one a parabola.

- implicit3d: `z = a(x^2 + y^2)`
  - `a`: how quickly it steepens; negative opens downward
  - e.g. a = 0.5: `z = 0.5(x^2 + y^2)`

Pitfall: different coefficients on x^2 and y^2 make it elliptic, still a
bowl. Opposite signs make a saddle.

## Hyperbolic paraboloid

Also: saddle, saddle surface.

A saddle: up along one axis, down along the other.

- implicit3d: `z = x^2/a^2 - y^2/b^2`
  - `a`: how slowly it rises along x
  - `b`: how slowly it falls along y
  - e.g. a = 2, b = 3: `z = x^2/4 - y^2/9`

Pitfall: `z = c x y` is the same saddle turned 45°.

## Hyperboloid of one sheet

Also: hyperboloid, one-sheeted hyperboloid, cooling tower.

A connected surface with a narrow circular waist that flares out above and
below.

- implicit3d: `x^2/a^2 + y^2/a^2 - z^2/c^2 = 1` — about the z-axis
  - `a`: the radius of the waist, the circle at z = 0
  - `c`: the height scale: larger c flares more slowly
  - e.g. a = 3, c = 2: `x^2/9 + y^2/9 - z^2/4 = 1`
- psurface: `(a cosh(2v - 1) cos(2pi u), a cosh(2v - 1) sin(2pi u), c sinh(2v - 1))`
  - `a`: the radius of the waist
  - `c`: the height scale
  - e.g. a = 3, c = 2: `(3cosh(2v - 1) cos(2pi u), 3cosh(2v - 1) sin(2pi u), 2sinh(2v - 1))`

Pitfall: one minus sign gives one sheet; two minus signs give two sheets.
With no z term it is a cylinder.

## Hyperboloid of two sheets

Also: two-sheeted hyperboloid.

Two separate bowls facing away from each other along the z-axis.

- implicit3d: `z^2/c^2 - x^2 - y^2 = 1`
  - `c`: the height of each bowl's tip above or below the origin
  - e.g. c = 2: `z^2/4 - x^2 - y^2 = 1` — tips at z = ±2

## Torus

Also: ring, doughnut, donut.

A ring-shaped surface: a circle swept round an axis it doesn't meet.

- psurface: `(cos(2pi u)(R + a cos(2pi v)), sin(2pi u)(R + a cos(2pi v)), a sin(2pi v))`
  - `R`: from the centre of the hole to the middle of the tube
  - `a`: the tube's radius, smaller than R
  - e.g. R = 3, a = 1: `(cos(2pi u)(3 + cos(2pi v)), sin(2pi u)(3 + cos(2pi v)), sin(2pi v))`
- implicit3d: `(sqrt(x^2 + y^2) - R)^2 + z^2 = a^2`
  - `R`: from the centre of the hole to the middle of the tube
  - `a`: the tube's radius
  - e.g. R = 3, a = 1: `(sqrt(x^2 + y^2) - 3)^2 + z^2 = 1`

## Möbius strip

Also: Mobius strip, Moebius band, Möbius band.

A band with a half twist: one side and one edge.

- psurface: `(cos(2pi u)(R + h(v - 0.5) cos(pi u)), sin(2pi u)(R + h(v - 0.5) cos(pi u)), h(v - 0.5) sin(pi u))`
  - `R`: the radius of the band's centre line
  - `h`: the band's width
  - e.g. R = 2, h = 1: `(cos(2pi u)(2 + (v - 0.5) cos(pi u)), sin(2pi u)(2 + (v - 0.5) cos(pi u)), (v - 0.5) sin(pi u))`

Pitfall: the twist is `pi u`, half the turn `2pi u`.

## Catenoid

The surface of a catenary spun round the z-axis: the shape a soap film takes
between two rings.

- psurface: `(a cosh(h(2v - 1)/a) cos(2pi u), a cosh(h(2v - 1)/a) sin(2pi u), h(2v - 1))`
  - `a`: the radius of the waist
  - `h`: how far it runs above and below the waist
  - e.g. a = 1, h = 2: `(cosh(4v - 2) cos(2pi u), cosh(4v - 2) sin(2pi u), 4v - 2)`

## Helicoid

Also: spiral ramp, screw surface.

A spiral ramp: a line through the z-axis swept round as it climbs.

- psurface: `(R(2v - 1) cos(2pi n u), R(2v - 1) sin(2pi n u), h u)`
  - `R`: how far it reaches from the axis
  - `n`: the number of turns
  - `h`: the height it climbs
  - e.g. R = 1, n = 3, h = 3: `((2v - 1) cos(6pi u), (2v - 1) sin(6pi u), 3u)`

Pitfall: its edge is a helix; the helicoid is the surface.

## Cube

Also: box, cuboid, rectangular box.

A solid box, or with equal sides, a cube.

- solid: `(interval(0, a), interval(0, a), interval(0, a))` — a corner at the origin
  - `a`: the side
  - e.g. a = 2: `(interval(0, 2), interval(0, 2), interval(0, 2))`
- polygon: `hull(([0,a],[0,a],[0,a]))` — the convex hull of its 8 corners
  - `a`: the side
  - e.g. a = 2: `hull(([0,2],[0,2],[0,2]))`

Pitfall: a box has its own interval per axis, e.g. `(interval(0, 1),
interval(0, 2), interval(0, 3))`. `polygon` in 3D fills only triangles.

## Tetrahedron

Also: triangular pyramid, regular tetrahedron.

The solid with four triangular faces.

- polygon: `hull((1, 1, 1), (1, -1, -1), (-1, 1, -1), (-1, -1, 1))` — every other corner of a cube
  - e.g. `hull((0, 0, 0), (2, 0, 0), (0, 2, 0), (0, 0, 2))` — the corner of a box, not regular

## Octahedron

Also: regular octahedron.

The solid with eight triangular faces: two square pyramids base to base.

- polygon: `hull((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))`
  - e.g. `hull((2, 0, 0), (-2, 0, 0), (0, 2, 0), (0, -2, 0), (0, 0, 3), (0, 0, -3))` — stretched along z
