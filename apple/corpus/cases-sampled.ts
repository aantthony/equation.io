/**
 * Targeted documents for the approximate tiers of random variables
 * (apple/corpus/analysis.ts runs them with its own): what lib/dist-system.ts
 * answers by quadrature against a base law (the density and mean of a
 * transformed continuous variable), by the conditional-CDF grid over one or
 * two bases, and from the joint sample (mixtures, three bases, events over
 * continuous variables, discrete enumerations past their cap). One concern
 * each, rows separated as the examples' are.
 */
export const SAMPLED_CASES: string[] = [
  // One continuous base: the conditional-CDF curve, moments by quadrature.
  'X ~ Uniform(0, 1); Y = X^2; E(Y); P(Y < 0.25); P(0.2 < Y < 0.5); E(X^2); Y; E(X + Y); P(Y > X)',
  'X ~ Normal(0, 1); Y = sin(X); E(Y); E(X^3); P(Y > 0.5); X^2 + 1; exp(X); abs(X); E(abs(X)); P(abs(X) < 1)',
  'X ~ Normal(1, 2); 1/X; E(1/X); 1/(1 + X^2); E(1/(1 + X^2)); X^3; P(X^3 > 8); tanh(X); cos(X)^2',
  'X ~ Exponential(2); sqrt(X); E(sqrt(X)); ln(X); E(ln(X)); X^2; E(X^2); exp(-X); P(exp(-X) < 0.5); X - 1',
  'X ~ Normal(0, 1); sqrt(X); E(sqrt(X)); ln(X); P(sqrt(X) > 1); asin(X); E(asin(X)); 0 X + 2; E(0 X + 2)',
  // u and v: uniform draws under their own names.
  'u^2; u v; u + v^2; sqrt(u); sin(2 pi u); u/v; u - v; max(u, v); u^v; ln(u); 1/u; u + u; 2u + 1; u + v',
  'floor(3 u); {u > 0.5: 1, u}; {u > 0.25: u^2}; round(u); floor(4 u) + v; a = 2; a u^2; u^a; {u < v: u, v}',
  // The families whose quantiles are tabulated.
  'G ~ Gamma(2, 3); sqrt(G); E(sqrt(G)); B ~ Beta(2, 5); B^2; E(B^2); P(B^2 < 0.1); W ~ Weibull(1.5, 2); ln(W)',
  'L ~ LogNormal(0, 0.5); 1/L; E(1/L); K ~ ChiSquared(4); sqrt(K); E(sqrt(K)); T ~ StudentT(5); T^2; E(T^2)',
  'G ~ Gamma(0.5, 1); G^2; E(G^2); B ~ Beta(0.5, 0.5); sin(pi B); H ~ Gamma(2000000, 1); ln(H); E(ln(H))',
  'B ~ Beta(30000000000, 2); B^2; E(B^2); F ~ Beta(30000000000, 20000000000); F^2; T ~ StudentT(1); atan(T)',
  // Heavy tails: what a mean and a spread may claim.
  'C ~ Cauchy(0, 1); C^2; E(C^2); atan(C); E(atan(C)); C^3; E(C^3); abs(C)^0.25; E(abs(C)^0.25); 1/C; E(1/C)',
  'T ~ StudentT(2); T^2; E(T^2); sin(T); E(sin(T)); S ~ StudentT(3); S^2; E(S^2); S^3; E(S^3); R ~ StudentT(1.5)',
  'T ~ StudentT(2); Z ~ Normal(0, 1); T + Z; E(T + Z); T Z; E(T Z); C ~ Cauchy(1, 2); C + Z; E(C + Z); C Z + Z',
  'X ~ Normal(0, 1); Y ~ Normal(0, 1); X/Y; E(X/Y); 1/X; E(1/X); 1/X^2; E(1/X^2); exp(X^2); E(exp(X^2))',
  // Two continuous bases: the tensor grid.
  'X ~ Normal(0, 1); Y ~ Normal(0, 1); X Y; X^2 + Y^2; max(X, Y); P(X Y > 0.5); E(X Y); E(X^2 + Y^2); P(X > Y)',
  'X ~ Uniform(0, 1); Y ~ Exponential(1); Y/(X + 1); X Y; X^Y; E(X^Y); P(Y/(X + 1) > 1); max(Y^2, X); Y^2 + 0 X',
  'X ~ Uniform(0, 2); Y ~ Uniform(0, 1); X Y; S = X^2 + Y; E(S); P(S < 1); P(1 < S < 3); {X > Y: X - Y, 0}',
  // Point masses: piecewise branches, floors, constants.
  'X ~ Normal(0, 1); Y = {X > 0: X^2, 1}; E(Y); P(Y > 0.5); P(Y > X); {X > 1: X, 0}; floor(X); round(2 X)/2',
  'X ~ Uniform(0, 1); Y ~ Uniform(0, 1); {X > 0.5: 100, X}; {X > Y: 1, 0}; floor(3 X) + Y; floor(2 X) floor(2 Y)',
  // Constants as parameters, sliders that leave the family, time.
  'a = 2; X ~ Normal(0, a); Y = X^2 + a; E(Y); P(Y > 5); b = 0; b X^2; E(b X^2); s = -1; Z ~ Normal(0, s); Z^2',
  'X ~ Normal(0, 1); sin(X + t); E(sin(X + t)); P(X^2 > t); a = t; a X^2; U ~ Uniform(0, 1 + t); U^2',
  // The joint sample: mixtures, three bases, events over continuous variables.
  'N ~ Poisson(3); Z ~ Normal(0, 1); N + Z; E(N + Z); P(N + Z > 4); M = N Z; P(M < 0); E(M); P(N > Z); Y = N + Z',
  's = 0.25; N ~ Poisson(3); Z ~ Normal(0, s); Y = N + Z; P(Y < 2.5); E(Y); P(2 < Y < 4); E(Y^2); N Z^2',
  'X ~ Normal(0, 1); Y ~ Uniform(0, 2); W ~ Exponential(1); X + Y W; E(X + Y W); P(X + Y W > 1); P(X < Y < W)',
  'X ~ Normal(0, 1); Y ~ Uniform(0, 2); P(X > Y); P(Y > X); P(X^2 < Y); P(X + Y > 1); P(X Y > 0); P(X > X)',
  'X ~ Normal(0, 1); Y = X^2; Z = X + Y; P(Y > X); P(Z < 1); P(Z > Y); E(Z); E(X Y); E(Y Z); X + Y + Z',
  'A ~ Uniform(0, 1); B ~ Uniform(0, 1); C ~ Uniform(0, 1); A B C; E(A B C); max(A, B, C); P(A + B > C); A B + C',
  'B ~ Bernoulli(0.3); Z ~ Normal(0, 1); B Z; {B > 0: Z, 2}; E(B Z); G ~ Gamma(2, 1); P ~ Poisson(2); G + P',
  'C ~ Cauchy(0, 1); N ~ Poisson(2); C + N; E(C + N); T ~ StudentT(2); T + N; E(T + N); P(C + N > 3)',
  // Discrete variables past the enumeration's cap: the sampled pmf.
  'D ~ Geometric(0.000001); D^2; E(D^2); P(D^2 > 1000000); P(D > 500000); 2 D; E(2 D); D + 0.5; mod(D, 7)',
  'G ~ Poisson(1000000); H ~ Poisson(1000000); G H; E(G H); P(G > H); P(G = H); P(G - H > 1000); G - H; G/H',
  'D ~ Geometric(0.000001); K = 1.00001^D; E(K); J = 1.0000005^D; E(J); sqrt(D); E(sqrt(D)); 1/D; E(1/D)',
  'G ~ Poisson(1000000); B ~ Bernoulli(0.3); G B; E(G B); P(G B > 0); P(G B = 0); G + B/2; G^2; sqrt(G)',
  'A ~ Poisson(100000000000); A^2; E(A^2); A/2; P(A/2 > 50000000000); B ~ Binomial(1000000, 0.5); A B',
  'D ~ Geometric(0.000001); E ~ Geometric(0.000002); D E; E(D E); P(D > E); P(D = E); D - E; min(D, E)',
  // Point events: == and != beside =.
  'N ~ Binomial(10, 0.3); P(N == 3); P(N != 3); P(N = 3); S = N + N; P(S == 6); P(S != 6); P(N == 3.5)',
  'X ~ Normal(0, 1); P(X == 0); P(X != 0); N ~ Poisson(2); P(N + X == 1); P(N == X); P(N != N); P(N == N)',
  'D ~ DiscreteUniform(1, 6); F ~ DiscreteUniform(1, 6); P(D == F); P(D != F); P(D + F == 7); P(D F != 6)',
  // Continuous intervals in a random row: uniform draws, drawn against their length.
  'interval(0, 10); interval(0, 2)^2; a = 3; interval(0, a) + u; s = interval(1, 3); s^2; sin(s); s + s',
  'X ~ Normal(0, 1); X + interval(0, 2); interval(0, 1) interval(0, 2); interval(0, 1); 2 interval(0, 1) + 1',
];
