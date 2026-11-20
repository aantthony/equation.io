/// The one table of distribution families (lib/dist-families.ts): every name
/// a `~` row accepts, its parameters, and how it reads in a message. The
/// parser of `X ~ …` validates from it, and a `~` row is a declaration or a
/// regression model by it (Regression.swift `tildeRow`).

public enum BaseKind: String, Sendable {
  case normal, uniform, exponential, gamma, beta, chisquared, studentt, lognormal, cauchy, weibull
  // Laws on the whole numbers (`discrete` in the table): a pmf drawn as stems.
  case binomial, poisson, geometric, negbinomial, bernoulli, discreteuniform
}

/// What a parameter's value must satisfy, beyond being a finite number.
struct DistParam {
  enum Whole { case no, yes, count }
  enum Unit { case closed, halfOpen }

  var name: String
  /// Must be > 0.
  var positive = false
  /// Must be a whole number (`count`: and ≥ 0). A value within rounding of a
  /// whole number is one (`wholeNumber`).
  var whole = Whole.no
  /// A probability: `closed` [0, 1] may be degenerate (an atom), `halfOpen` (0, 1] may not be 0.
  var unit: Unit?
}

struct DistFamily {
  var kind: BaseKind
  /// The canonical spelling; matching is case-insensitive.
  var name: String
  var aliases: [String] = []
  /// True for a law on the integers (a pmf, drawn as stems).
  var discrete = false
  /// Parameters in order, each with what its value must satisfy.
  var params: [DistParam]
  /// Standard parameters a bare name takes (`X ~ N`); nil where the family
  /// has no standard member (`X ~ Gamma` must say which).
  var defaults: [Double]?
  /// Spellings that are also a function or an everyday coefficient name: over
  /// a declared data list `Y ~ exp(a X)` is a regression model.
  var modelNames: [String] = []
}

let DIST_FAMILIES: [DistFamily] = [
  DistFamily(
    kind: .normal, name: "Normal", aliases: ["N"],
    params: [DistParam(name: "mean"), DistParam(name: "sd", positive: true)], defaults: [0, 1]),
  DistFamily(
    kind: .uniform, name: "Uniform", aliases: ["U"], params: [DistParam(name: "lo"), DistParam(name: "hi")],
    defaults: [0, 1]),
  DistFamily(
    kind: .exponential, name: "Exponential", aliases: ["Exp"], params: [DistParam(name: "rate", positive: true)],
    defaults: [1], modelNames: ["exp"]),
  DistFamily(
    kind: .gamma, name: "Gamma",
    params: [DistParam(name: "shape", positive: true), DistParam(name: "rate", positive: true)],
    modelNames: ["gamma"]),
  DistFamily(
    kind: .beta, name: "Beta", params: [DistParam(name: "a", positive: true), DistParam(name: "b", positive: true)],
    modelNames: ["beta"]),
  DistFamily(
    kind: .chisquared, name: "ChiSquared", aliases: ["ChiSq", "Chi2"],
    params: [DistParam(name: "df", positive: true)]),
  DistFamily(
    kind: .studentt, name: "StudentT", aliases: ["T"], params: [DistParam(name: "df", positive: true)],
    modelNames: ["t"]),
  DistFamily(
    kind: .lognormal, name: "LogNormal", params: [DistParam(name: "mu"), DistParam(name: "sigma", positive: true)],
    defaults: [0, 1]),
  DistFamily(
    kind: .cauchy, name: "Cauchy", params: [DistParam(name: "location"), DistParam(name: "scale", positive: true)],
    defaults: [0, 1]),
  DistFamily(
    kind: .weibull, name: "Weibull",
    params: [DistParam(name: "shape", positive: true), DistParam(name: "scale", positive: true)]),
  // Discrete: laws on the integers, by scipy's conventions (Geometric counts
  // trials, from 1; NegativeBinomial counts failures, from 0).
  DistFamily(
    kind: .binomial, name: "Binomial", aliases: ["Binom"], discrete: true,
    params: [DistParam(name: "n", whole: .count), DistParam(name: "p", unit: .closed)]),
  DistFamily(
    kind: .poisson, name: "Poisson", aliases: ["Pois"], discrete: true,
    params: [DistParam(name: "mean", positive: true)]),
  DistFamily(
    kind: .geometric, name: "Geometric", aliases: ["Geom"], discrete: true,
    params: [DistParam(name: "p", unit: .halfOpen)]),
  DistFamily(
    kind: .negbinomial, name: "NegativeBinomial", aliases: ["NegBin"], discrete: true,
    params: [DistParam(name: "r", positive: true), DistParam(name: "p", unit: .halfOpen)]),
  DistFamily(kind: .bernoulli, name: "Bernoulli", discrete: true, params: [DistParam(name: "p", unit: .closed)]),
  DistFamily(
    kind: .discreteuniform, name: "DiscreteUniform", discrete: true,
    params: [DistParam(name: "a", whole: .yes), DistParam(name: "b", whole: .yes)]),
]

private let familiesByName: [String: DistFamily] = {
  var out: [String: DistFamily] = [:]
  for f in DIST_FAMILIES {
    for n in [f.name] + f.aliases { out[n.lowercased()] = f }
  }
  return out
}()

private let familiesByKind: [BaseKind: DistFamily] = {
  var out: [BaseKind: DistFamily] = [:]
  for f in DIST_FAMILIES { out[f.kind] = f }
  return out
}()

/// The family a name or alias spells, in any capitalization.
func distFamily(_ name: String) -> DistFamily? { familiesByName[name.lowercased()] }

func familyOf(_ kind: BaseKind) -> DistFamily { familiesByKind[kind]! }

/// `Gamma(shape, rate)`.
func distUsage(_ f: DistFamily) -> String { "\(f.name)(\(f.params.map(\.name).joined(separator: ", ")))" }

/// True when this spelling doubles as a regression model over declared data.
func isModelName(_ name: String) -> Bool { distFamily(name)?.modelNames.contains(name.lowercased()) ?? false }
