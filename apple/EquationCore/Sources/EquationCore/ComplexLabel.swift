import Synchronization

/// The exact name of a complex equation's root (lib/complex-label.ts): the
/// label the site draws beside each root of `w^3 = 1`, `-1/2 + √3/2 i`.

private typealias Labels = (roots: [ComplexRootLabel], rootOf: String?)

private struct LabelCache: Sendable {
  var labels: [String: Labels?] = [:]
  /// The keys in the order they were first asked for: the oldest goes first.
  var order: [String] = []
}

private let cache = Mutex(LabelCache())

/// The label of the root at `p` (its real and imaginary parts) of the complex
/// equation `expr`, a `.complexSystem` plan's `equation`, with the constants
/// it reads at their values in `env`: the root's exact form when the
/// polynomial factors into rational linear and quadratic parts, the
/// polynomial it is a root of when it does not, and nil for an equation that
/// is no polynomial in w (`complexRootLabel`).
public func complexRootLabel(_ expr: Expr?, _ p: [Double], _ env: [String: Double]) -> String? {
  guard let expr, p.count >= 2 else { return nil }
  var values: [String: Expr] = [:]
  for n in freeVars(expr) where n != "w" {
    if let v = env[n], v.isFinite { values[n] = .num(v) }
  }
  let resolved = substVars(expr, values)
  let key = exprKey(resolved)
  var labels: Labels?
  if let hit = cache.withLock({ $0.labels[key] }) {
    labels = hit
  } else {
    labels = complexRootLabels(resolved)
    cache.withLock {
      if $0.labels[key] != nil { return }
      if $0.order.count >= 32 { $0.labels[$0.order.removeFirst()] = nil }
      $0.order.append(key)
      $0.labels[key] = .some(labels)
    }
  }
  guard let labels else { return nil }
  func hypot(_ a: Double, _ b: Double) -> Double { (a * a + b * b).squareRoot() }
  if let found = labels.roots.first(where: { hypot($0.re - p[0], $0.im - p[1]) < 1e-6 * (1 + hypot(p[0], p[1])) }) {
    return found.label
  }
  guard let rootOf = labels.rootOf else { return nil }
  func digits(_ v: Double) -> String { JS.string(JS.number(JS.toPrecision(v, 4))) }
  return "root of \(rootOf) (≈ \(digits(p[0])) \(p[1] < 0 ? "−" : "+") \(digits(abs(p[1])))i)"
}
