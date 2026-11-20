#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

/// Which `~` rows fit a model to data (lib/regression.ts): observed-list ~
/// model-list, where unbound scalar names are the fit's coefficients.
///
/// Fits never change an equation's text or introduce hidden slider values.
///
/// Port: the reading of the row is here — whether a `~` row is a fit or a
/// random variable's declaration, which the two must agree on — and the fit
/// itself, over numbers (`fitRegression`, `formatFit`). What hands a fit its
/// numbers is list lowering (lib/defs.ts `buildDefs`, the 'regression'
/// case), and the definitions port does not read lists yet: a regression row
/// is reported as not supported, and so is every row that names one of its
/// coefficients.

/// How a row with a `~` reads (lib/regression.ts `tildeRow`).
struct TildeRow {
  var lhs: Units
  var rhs: Units
  /// The offset of the `~`.
  var tilde: Int
  /// False: the row is left to the distribution path.
  var regression: Bool
}

/// Names some row of the document defines (`name = …`, `name ∈ …`), by text
/// alone: a definition that fails to parse still makes `name ~ …` a fit, not
/// a law (`declaredNames`): `^\s*(NAME)\s*(?:=(?!=)|∈|\\in\b)`.
func declaredNames(_ texts: [Units]) -> Set<String> {
  var declared = Set<String>()
  for text in texts {
    var c = RowScanner(text)
    c.space()
    guard let name = c.nameRange() else { continue }
    c.space()
    var drawn = c
    var binder = drawn.eat(0x2208)
    if !binder, drawn.eat(word: "\\in") {
      // \b: not followed by a word character.
      binder = !(drawn.peek.map { isASCIILetter($0) || isDigit($0) || $0 == 0x5F } ?? false)
    }
    if c.assign() || binder { declared.insert(canonicalName(c.text(name))) }
  }
  return declared
}

/// How a row with a `~` reads — the one predicate, so the highlighter and
/// the analysis cannot disagree. Nil without exactly one `~` at depth 0
/// outside quotes (or in a comment).
///
/// A distribution name (DistFamilies.swift) at the head of the right side
/// keeps its meaning, and its collision diagnostics, whatever is on the
/// left. The exceptions are the spellings that are also a function or an
/// everyday coefficient name — exp, gamma, beta, t: over declared data they
/// are models in every form (`Y ~ gamma(a X)`, `Y ~ gamma`, mid-typing
/// `Y ~ gamma x`). The one carve-out: a bare `exp` is the Exponential alias.
func tildeRow(_ u: Units, _ declared: Set<String>) -> TildeRow? {
  if jsTrimStart(u[...]).first == 0x23 { return nil }
  var quote: UInt16 = 0
  var depth = 0
  var tilde = -1
  for (k, c) in u.enumerated() {
    if quote != 0 {
      if c == quote { quote = 0 }
      continue
    }
    switch c {
    case 0x22: quote = c
    case 0x27 where !(k > 0 && endsValue(u[k - 1])): quote = c
    case 0x28, 0x5B, 0x7B: depth += 1
    case 0x29, 0x5D, 0x7D: depth -= 1
    case 0x7E where depth == 0:
      if tilde >= 0 { return nil }
      tilde = k
    default: break
    }
  }
  guard tilde >= 0 else { return nil }
  let lhs = Array(jsTrim(u[..<tilde]))
  let rhs = Array(jsTrim(u[(tilde + 1)...]))
  // `^(NAME)\s*(?:\(|$)`: the first name of the right side, possibly a distribution's.
  var law = false
  var head = RowScanner(rhs)
  if let name = head.nameRange() {
    let spelled = head.text(name)
    head.space()
    if head.atEnd || head.peek == 0x28 { law = distFamily(spelled) != nil && !isModelName(spelled) }
  }
  let bareExp = String(decoding: rhs, as: UTF16.self).lowercased() == "exp"
  let data = declared.contains(canonicalName(String(decoding: lhs, as: UTF16.self)))
  // /[.[\](+*/-]/
  let expression = lhs.contains { [0x2E, 0x5B, 0x5D, 0x28, 0x2B, 0x2A, 0x2F, 0x2D].contains($0) }
  return TildeRow(lhs: lhs, rhs: rhs, tilde: tilde, regression: !law && !bareExp && (data || expression))
}

/// The rows that fit a model (`scanRegressions`). A declared data name on
/// the left disambiguates regression from a random variable declaration;
/// explicit lists or columns also unambiguously mean data.
func scanRegressions(_ texts: [String]) -> [Int: TildeRow] {
  let units = texts.map { Array($0.utf16) }
  let declared = declaredNames(units)
  var out: [Int: TildeRow] = [:]
  for (i, text) in units.enumerated() {
    if let row = tildeRow(text, declared), row.regression { out[i] = row }
  }
  return out
}

// MARK: - The fit

/// A model fitted to observations (lib/regression.ts `FitResult`).
public struct FitResult: Equatable, Sendable {
  /// The fitted coefficients, in the order the model names them.
  public var coefficients: [(name: String, value: Double)]
  /// Observations fitted, and the rows passed over for a missing value.
  public var count: Int
  public var skipped: Int
  public var rmse: Double
  /// Nil when the observations do not vary.
  public var r2: Double?
  public var nonlinear: Bool

  public static func == (a: FitResult, b: FitResult) -> Bool {
    a.coefficients.map(\.name) == b.coefficients.map(\.name)
      && a.coefficients.map(\.value) == b.coefficients.map(\.value)
      && a.count == b.count && a.skipped == b.skipped && a.rmse == b.rmse && a.r2 == b.r2
      && a.nonlinear == b.nonlinear
  }
}

/// `Math.hypot` as V8 computes it: scaled by the largest magnitude, summed
/// with Kahan compensation.
private func hypot(_ xs: [Double]) -> Double {
  var largest = 0.0
  for x in xs {
    if x.isNaN { return .nan }
    largest = Swift.max(largest, abs(x))
  }
  if largest == 0 { return 0 }
  if largest == .infinity { return .infinity }
  var sum = 0.0
  var compensation = 0.0
  for x in xs {
    let n = x / largest
    let summand = n * n - compensation
    let preliminary = sum + summand
    compensation = (preliminary - sum) - summand
    sum = preliminary
  }
  return sum.squareRoot() * largest
}

private let rankDeficient = "Regression coefficients are not identifiable: the model is rank deficient."

/// Modified Gram–Schmidt with reorthogonalization and column scaling
/// (`leastSquares`). Avoids normal equations and rejects rank-deficient
/// models explicitly.
private func leastSquares(_ columns: [[Double]], _ target: [Double]) throws -> [Double] {
  let n = columns.count
  var q: [[Double]] = []
  var r = [[Double]](repeating: [Double](repeating: 0, count: n), count: n)
  let scale = columns.map(hypot)
  func dot(_ a: [Double], _ b: [Double]) -> Double {
    var s = 0.0
    for i in a.indices { s += a[i] * b[i] }
    return s
  }
  for j in 0..<n {
    if !(scale[j] > 0) || !scale[j].isFinite { throw LanguageError(rankDeficient) }
    var v = columns[j].map { $0 / scale[j] }
    for _ in 0..<2 {
      for k in 0..<j {
        let a = dot(q[k], v)
        r[k][j] += a
        for i in v.indices { v[i] -= a * q[k][i] }
      }
    }
    r[j][j] = hypot(v)
    if r[j][j] < 1e-10 { throw LanguageError(rankDeficient) }
    q.append(v.map { $0 / r[j][j] })
  }
  var x = q.map { dot($0, target) }
  for j in stride(from: n - 1, through: 0, by: -1) {
    for k in (j + 1)..<max(n, j + 1) { x[j] -= r[j][k] * x[k] }
    x[j] /= r[j][j]
  }
  return x.indices.map { x[$0] / scale[$0] }
}

/// Fit `parameters` so the models come as near the observations as least
/// squares has it (`fitRegression`): model k is the row's model at
/// observation k. Linear in its coefficients, one solve; otherwise
/// Levenberg–Marquardt from four fixed starts, so a fit is the same on
/// every load. `fixed`: the constants the models read, which stay as they are.
public func fitRegression(_ observed: [Double], _ models: [Expr], _ parameters: [String], _ fixed: [String: Double])
  throws -> FitResult
{
  if observed.count != models.count { throw LanguageError("Regression lists must have the same length.") }
  if parameters.isEmpty {
    throw LanguageError("Regression needs an unbound coefficient, like Y ~ m X + b. Defined constants stay fixed.")
  }
  if parameters.count > 8 { throw LanguageError("Regression supports at most 8 fitted coefficients.") }
  if observed.count > 10_000 {
    throw LanguageError("Regression supports at most 10000 observations; filter the data first.")
  }
  // Missing input values are numeric NaN leaves after list lowering. A
  // domain error in the model is different: never silently drop that row.
  func hasMissing(_ e: Expr) -> Bool {
    switch e {
    case .num(let value): !value.isFinite
    case .bin, .neg, .call, .eq, .ineq, .piecewise: childrenOf(e).contains(where: hasMissing)
    default: false
    }
  }
  var ys: [Double] = []
  var fs: [Expr] = []
  for (y, f) in zip(observed, models) where y.isFinite && !hasMissing(f) {
    ys.append(y)
    fs.append(f)
  }
  if ys.count < parameters.count {
    throw LanguageError("Regression needs at least as many finite observations as coefficients.")
  }
  let derivatives: [[Expr]]
  do {
    derivatives = try parameters.map { p in try fs.map { try diff($0, p) } }
  } catch {
    throw LanguageError("Regression needs a differentiable model in its fitted coefficients.")
  }
  let nonlinear = derivatives.contains { $0.contains { freeVars($0).contains(where: parameters.contains) } }
  func env(_ values: [Double]) -> [String: Double] {
    var e = fixed
    for (p, v) in zip(parameters, values) { e[p] = v }
    return e
  }
  func predictions(_ values: [Double]) throws -> [Double] {
    let e = env(values)
    return try fs.map { try evaluate($0, e) }
  }
  func jacobian(_ values: [Double]) throws -> [[Double]] {
    let e = env(values)
    return try derivatives.map { try $0.map { try evaluate($0, e) } }
  }
  func cost(_ values: [Double]) throws -> Double {
    var s = 0.0
    for (v, y) in zip(try predictions(values), ys) { s += JS.pow(v - y, 2) }
    return s
  }
  var values: [Double]
  if !nonlinear {
    let zero = parameters.map { _ in 0.0 }
    let offset = try predictions(zero)
    let columns = try jacobian(zero)
    if !(offset + columns.flatMap { $0 }).allSatisfy(\.isFinite) {
      throw LanguageError("The regression model is undefined for some observations.")
    }
    values = try leastSquares(columns, zip(ys, offset).map { $0 - $1 })
  } else {
    if ys.count > 2000 {
      throw LanguageError("Nonlinear regression supports at most 2000 observations; filter the data first.")
    }
    var best: [Double]?
    var bestCost = Double.infinity
    // Deterministic starts, bounded iterations. No random fits on reload.
    for start in [1, 0, -1, 0.1] {
      var x = parameters.map { _ in start }
      var lambda = 1e-3
      var score = try cost(x)
      if !score.isFinite { continue }
      for _ in 0..<60 {
        let j = try jacobian(x)
        if !j.allSatisfy({ $0.allSatisfy(\.isFinite) }) { break }
        let predicted = try predictions(x)
        let residual = zip(ys, predicted).map { $0 - $1 }
        let norms = j.map { JS.max([1e-12, hypot($0)]) }
        let augmented = j.enumerated().map { k, col in
          col + parameters.indices.map { $0 == k ? lambda.squareRoot() * norms[k] : 0 }
        }
        guard let delta = try? leastSquares(augmented, residual + parameters.map { _ in 0 }) else { break }
        let next = zip(x, delta).map { $0 + $1 }
        let nextCost = try cost(next)
        if nextCost.isFinite && nextCost < score {
          let improvement = score - nextCost
          x = next
          score = nextCost
          lambda = JS.max([1e-12, lambda / 3])
          if improvement <= 1e-12 * JS.max([1, score]) { break }
        } else {
          lambda *= 10
          if lambda > 1e12 { break }
        }
      }
      if score < bestCost {
        best = x
        bestCost = score
      }
    }
    guard let best else {
      throw LanguageError(
        "Nonlinear regression could not find a finite fit; try another model or rescale the data.")
    }
    values = best
    // Identifiability is checked without damping; damping must not disguise
    // redundant coefficients such as a*b*X.
    _ = try leastSquares(try jacobian(values), ys)
    let residual = zip(try predictions(values), ys).map { $0 - $1 }
    let stationary = try jacobian(values).allSatisfy { col in
      var s = 0.0
      for (v, r) in zip(col, residual) { s += v * r }
      return abs(s) <= 1e-5 * JS.max([1, hypot(col) * hypot(residual)])
    }
    if !stationary {
      throw LanguageError("Nonlinear regression did not converge; try another model or rescale the data.")
    }
  }
  if !values.allSatisfy(\.isFinite) { throw LanguageError("Regression did not produce finite coefficients.") }
  let sse = try cost(values)
  if !sse.isFinite { throw LanguageError("Regression overflowed; rescale the data before fitting.") }
  let mean = ys.reduce(0, +) / Double(ys.count)
  var sst = 0.0
  for y in ys { sst += JS.pow(y - mean, 2) }
  return FitResult(
    coefficients: zip(parameters, values).map { ($0, $1) }, count: ys.count, skipped: observed.count - ys.count,
    rmse: (sse / Double(ys.count)).squareRoot(), r2: sst > 0 ? 1 - sse / sst : nil, nonlinear: nonlinear)
}

/// A fit's readout: `m ≈ 1.99 · b ≈ 1.04 · RMSE ≈ 0.146287 · R² ≈ 0.997305 · 5 observations` (`formatFit`).
public func formatFit(_ fit: FitResult) -> String {
  func number(_ v: Double) -> String { JS.string(JS.number(JS.toPrecision(v, 6))) }
  var parts = fit.coefficients.map { "\($0.name) ≈ \(number($0.value))" }
  parts.append("RMSE ≈ \(number(fit.rmse))")
  if let r2 = fit.r2 { parts.append("R² ≈ \(number(r2))") }
  parts.append("\(fit.count) observations")
  if fit.skipped != 0 { parts.append("\(fit.skipped) rows skipped") }
  if fit.nonlinear { parts.append("nonlinear local fit") }
  return parts.joined(separator: " · ")
}
