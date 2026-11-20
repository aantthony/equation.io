import Synchronization

/// Continuous intervals (lib/interval.ts): `interval(a, b)` is every real
/// number from a to b. Resolution turns each one into a hidden parameter: a
/// call to INTERVAL carrying its bounds and an identity. Every mention of a
/// name (`s = interval(0, 1)`) is the same node; each literal gets its own
/// identity, so two literals are separate.
///
/// Port: what reads an interval here is Fourier analysis, whose signal is
/// read over one (FourierRows.swift). Rows that sweep or draw from an
/// interval (lib/plot.ts, lib/measure.ts) are not ported: an interval
/// anywhere else is reported as not supported (`ResolveOpts.intervals`).

struct HiddenInterval {
  /// The node itself, as it appears in the row.
  var node: Expr
  var lo: Expr
  var hi: Expr
  /// Equal for identical intervals (every mention of one name).
  var key: String
}

private func isHidden(_ e: Expr) -> Bool {
  if case .call(INTERVAL, _) = e { return true }
  return false
}

private let identities = Mutex(0)

/// The hidden parameter for `interval(lo, hi)`, with resolved bounds
/// (`hiddenInterval`). The bounds may use constants, sliders and t; numbers
/// are checked here, the rest when the row draws.
///
/// Port: the TypeScript keys an identity by the source literal, so resolving
/// the same parsed row again keeps it. Here each resolve of a literal is a
/// new identity; a name's interval, and a function body's, resolve once.
func hiddenInterval(_ args: [Expr]) throws -> Expr {
  if args.count != 2 { throw LanguageError("interval takes two bounds: interval(1, 2).") }
  for b in args {
    switch b {
    case .vec, .eq, .ineq, .str, .text:
      throw LanguageError("The bounds of an interval are two numbers: interval(1, 2).")
    default: break
    }
    if hasInterval(b) { throw LanguageError("The bounds of an interval cannot be intervals themselves.") }
    if let moving = freeVars(b).first(where: { ["x", "y", "z", "u", "v", "w"].contains($0) }) {
      throw LanguageError("The bounds of an interval can only use constants, sliders and t (found \(moving)).")
    }
  }
  if case .num(let lo) = args[0], case .num(let hi) = args[1] {
    if !lo.isFinite || !hi.isFinite { throw LanguageError("The bounds of an interval must be finite.") }
    if !(lo < hi) {
      throw LanguageError("interval(a, b) needs a < b (got \(JS.string(lo)) and \(JS.string(hi))).")
    }
  }
  let id = identities.withLock {
    $0 += 1
    return $0
  }
  return .call(INTERVAL, [args[0], args[1], .num(Double(id))])
}

func hasInterval(_ e: Expr) -> Bool {
  isHidden(e) || childrenOf(e).contains(where: hasInterval)
}

/// The distinct hidden intervals of `e`, in order of first appearance (`intervalsIn`).
func intervalsIn(_ e: Expr) -> [HiddenInterval] {
  var found: [HiddenInterval] = []
  func walk(_ n: Expr) {
    if case .call(INTERVAL, let args) = n, args.count == 3 {
      let key = exprKey(n)
      if !found.contains(where: { $0.key == key }) {
        found.append(HiddenInterval(node: n, lo: args[0], hi: args[1], key: key))
      }
      return
    }
    childrenOf(n).forEach(walk)
  }
  walk(e)
  return found
}

/// `e` with each hidden interval replaced by what `by` gives for it (`replaceIntervals`).
func replaceIntervals(_ e: Expr, _ by: (HiddenInterval) -> Expr) -> Expr {
  let found = intervalsIn(e)
  if found.isEmpty { return e }
  var hidden: [String: Expr] = [:]
  for h in found { hidden[h.key] = by(h) }
  func walk(_ n: Expr) -> Expr { isHidden(n) ? hidden[exprKey(n)]! : mapChildren(n, walk) }
  return walk(e)
}

/// Whether a definition's value, as parsed, is an interval written whole:
/// `interval(a, b)`, or the name of one above.
func writesInterval(_ parsed: Expr, _ defs: BuiltDefs) -> Bool {
  switch parsed {
  case .call("interval", _): true
  case .var(let name): defs.intervals.has(name)
  default: false
  }
}
