---
title: Regression
summary: Fit a model to data with ~.
---

Write `P = [(0,1),(1,3),(2,5),(3,7)]; P.y ~ m P.x + b` to fit a line through
the points: `P.x` and `P.y` are their coordinates, paired point by point.
(Write the data as points, or as columns of one CSV file: two separately
defined lists `X = […]`, `Y = […]` are independent, so `(X, Y)` would plot
their grid.) The left side is a numeric list (defined above the fit), an
explicit list, or a CSV column. The right side is a model over equally long lists, or a
scalar broadcast to the observations. Unbound scalar names are fitted
coefficients; already defined constants stay fixed. Data and fixed constants
must be static and defined above the fit. Coefficients are reusable values:
`y = m x + b` draws the model, `f(x) = m x + b` names it, and
`(P.x, P.y - f(P.x))` draws residuals. No fit settings exist outside the equations.

Examples: `P.y ~ a P.x^2 + b P.x + c` (polynomial), `P.y ~ a exp(b P.x)` (nonlinear),
`data.height ~ m data.age + b` (CSV). A fit row reports coefficients, RMSE,
R² when the observations have nonzero variance, and observation count.
Changing fixed constants or data refits the model. Missing/nonfinite pairs
are skipped with a visible count. Unequal lengths, rank-deficient models,
and too few finite observations are errors. At most 8 coefficients and
10,000 observations, or 2,000 observations for nonlinear models.
Nonlinear models must be differentiable in fitted coefficients; bounded,
deterministic multistart fitting reports a local fit or an error, not a
guaranteed global optimum. Fitting does not depend on t or simulation states.

`X ~ Normal(...)`, `X ~ Uniform(...)`, `X ~ Exponential(...)`, and the
unambiguous family names (`ChiSquared`, `StudentT`, `LogNormal`, `Cauchy`,
`Weibull`) retain their random-variable meanings. `Gamma`, `Beta` and `T`
follow the `exp` rule below — over a declared data list they are a model
(`Y ~ gamma(a X)`, `Y ~ beta (X - 1)`); with an undeclared left-hand name
they declare a random variable. Bare distribution aliases are case-insensitive,
including `exp`/`EXP`. For a declared data list, `Y ~ exp(a X)` is an
exponential regression model in any capitalization; with an undeclared
left-hand name, `Z ~ exp(2)` declares an exponential random variable.
Missing CSV data stays device-local in MCP and
previews, including curves that depend on its fitted coefficients. Fits over
literal data and their model curves work in shared links and static previews.
