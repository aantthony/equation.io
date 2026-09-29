# Examples from Wildberger's multiset lectures

Candidate example graphs that show the ideas in N J Wildberger's Math
Foundations lectures (box arithmetic, polynumbers, maxels, vexels, posets)
in equation.io's multiset syntax (docs/multisets.md, §0 especially).
Lecture numbers are MF (Math Foundations) unless noted.

Status marks: **checked**, run earlier while building the multiset stack
(#187–#193); everything else follows from features that exist but has not
been run. Open each one and look at it before shipping (valid-but-wrong
formulas pass every test).

## Works with the stack as it is

### 1. A family is a polynumber (MF227–228)

```
A = [2, 3]
y = x^A              # a family: x², x³
y = total(x^A)       # the box read as a polynomial: x² + x³
```

The same object read both ways, two curves or one curve that is their sum:
§0 in a picture.

### 2. Polynomial multiplication is "every pair, added" (MF227, MF232) — checked

```
P = [0, 0, 1, 3]     # 2 + α + α³
Q = [0, 1]           # 1 + α
y = total(x^P)
y = total(x^Q)
y = total(x^(P + Q)) # the product, from exponent addition alone
```

### 3. Pascal's triangle from three draws (MF232)

```
B = [0, 1]
a ∈ B
b ∈ B
c ∈ B
hist(a + b + c)      # bars 1, 3, 3, 1
```

Binomial coefficients as multiplicities, no factorials. With one name,
`hist(a + a + a)` has only 0 and 3: the clearest demo of why binders exist.

### 4. Unique factorisation, the "fundamental identity" (MF240)

```
P2 = 2^[0..6]
P3 = 3^[0..4]
P5 = 5^[0..2]
P7 = 7^[0..2]
N = P2 P3 P5 P7
hist(N[N <= 100])    # every n ≤ 100 exactly once: a flat histogram
```

Wildberger's caret over prime boxes; a gap or a double bar would be a
counterexample to unique factorisation.

### 5. The divisor count is the caret of [1..n] with itself (MF242–243)

```
D = [1..30]
a ∈ D
b ∈ D
hist({a b <= 30: a b})   # the bar at n is d(n)
```

Dirichlet convolution as "every pair, multiplied"; primes are the bars of
height 2.

### 6. Euler: distinct parts vs odd parts (MF239)

```
# distinct parts, up to 8
hist([0,1] + [0,2] + [0,3] + [0,4] + [0,5] + [0,6] + [0,7] + [0,8])
--- right
# odd parts, up to 8
hist({[0..8] + 3[0..2] + 5[0, 1] + 7[0, 1] <= 8: [0..8] + 3[0..2] + 5[0, 1] + 7[0, 1]})
```

Up to 8 the two histograms agree: Euler's theorem as two bar charts. Each
literal is its own multiset, so the sums cross. Check the truncation: only
values up to 8 are complete on the left.

### 7. Maxels: composition, powers, non-commutativity (MF166–171, MF208) — A, AB, A² checked

- The matrix example (A, B, AB, and A² from binders), plus a `c(B, A)`
  panel showing AB ≠ BA as graphs.
- Identity and restriction (MF169): `J = [1, 3]`; `E = {J: (J, J)}`;
  `c(E, A)` keeps A's rows 1 and 3.
- Transpose `(A.y, A.x)`; trace `count(A[A.x == A.y])`.
- The smallest non-commutativity: E₁₃E₃₄ = E₁₄ while E₃₄E₁₃ is empty, as
  `[(1, 3)]` and `[(3, 4)]` composed both ways.

### 8. A vector is a picture of a vexel (MF171, MF207)

```
v = [1, 1, 1, 3, 3]       # 3e₁ + 2e₃
hist(v)                   # its "frieze": 3, 0, 2
w = {A.y = v: A.x}        # the maxel acting on the vexel
hist(w)                   # A v, as bars
```

Verify against a hand-computed A·v.

### 9. Walks in a graph are matrix powers

A small directed graph as a multiset of arrows `G`; then `g ∈ G`,
`h ∈ G`, `graph(c(g, h))` is the paths of length 2, with the counts on the
arrows: Wildberger's product rule and "paths" in one picture.

### 10. A poset's zeta maxel and its chains (MF272) — 18 and 40 checked

The divisors of 12 as `{mod(b, a) = 0: (a, b)}` over two draws `a ∈ D`,
`b ∈ D`, drawn with `graph` (the Hasse diagram plus every transitive
arrow); two draws from Z count its 40 chains.

### 11. The meson nonet (Dynamics on Graphs 20)

```
Q = [(2/3, 1/3), (-1/3, 1/3), (-1/3, -2/3)]   # u, d, s in (charge, hypercharge)
q ∈ Q
r ∈ Q
q - r                                          # 9 points: the hexagon, 3 at the centre
```

The antiquark is the negation, and the centre multiplicity of 3 falls out.
Points do not show multiplicity yet, so pair it with a count of the centre
(check whether an equality on points needs its coordinates).

### 12. Interval arithmetic vs the image multiset (MF82)

```
A = [1..3]
B = [2..5]
hist(A B)        # 11 never appears; the interval [2, 15] says it might
```

Why his interval arithmetic is a hull and not a comprehension.

## Needs a feature still to build

| Idea | Lecture | Needs |
|---|---|---|
| Pentagonal cancellation ∏(1 − αⁿ) | MF239 | signed multiplicities (anti) |
| Möbius maxel μ = ζ⁻¹, Philip Hall's chain formula | MF272 | signed multiplicities |
| Dihedron algebra (ij = k, ji = −k) | Famous Math Problems 21b | signed multiplicities |
| Truth table to Boole polynumber | MF267, MF269 | `parity(L)` |
| ∏ over all primes ≤ N without writing each box | MF240 | an indexed product |
| A maxel shown as its matrix grid | MF165 | a `matrix(M)` readout |

## For the examples menu first

- **#3, Pascal from three draws**: binders and polynomial multiplication
  in one picture.
- **#4, the flat histogram of unique factorisation**: striking, and
  Wildberger's own identity.
- **#6, Euler's two histograms**: a classic theorem with no algebra.
