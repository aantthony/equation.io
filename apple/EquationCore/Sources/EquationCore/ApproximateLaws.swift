#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif
import Synchronization

/// The approximate tiers of a random variable (lib/dist-system.ts
/// `RVSystem`): what has no closed law is integrated against its base's pdf
/// (`quadMoments`), drawn from a conditional-CDF grid over one or two bases
/// (`condBase`), or estimated from the joint sample (`columns`,
/// `estimateCurve`, `sampleFraction`).
///
/// Port: the site keeps what it computed in the system it reuses across
/// recompiles. A system here is a value made per analysis; its `cache` is
/// shared by its copies and holds the same things, by the same signature
/// (definition and the values of the constants read), for as long as the
/// analysis lives.

/// What the approximate tiers computed for each variable (lib/dist-sample.ts `CacheEntry`).
final class RVCache: Equatable, Sendable {
  struct Entry: Sendable {
    /// Serialized definition + parameter values the fields were computed under.
    var sig: String
    /// Joint sample column.
    var col: [Double]?
    /// A discrete base's exact quantile at every stratum.
    var strata: [Double]?
    /// Quadrature-tier base: sorted tensor columns + window.
    var qcb: QCBase??
    /// Deterministic conditional-CDF curve over the full window.
    var qc: DensityCurve?
    /// Zoomed rasterization spliced into the full curve, keyed by its range.
    var qcz: Zoomed?
    /// Sampled KDE estimate — the last-resort tier.
    var est: DensityCurve??
    /// Quadrature moments.
    var qm: QuadMoments??
    /// A derived discrete variable past the enumeration's cap: its sampled pmf.
    var spmf: DiscretePmf??
  }

  struct Zoomed: Sendable {
    var lo: Double
    var hi: Double
    var curve: DensityCurve
  }

  struct QuadMoments: Sendable {
    var mean: Double
    var sd: Double
    var mass: Double
  }

  private let entries = Mutex<[String: Entry]>([:])

  /// A cache is no part of what a system is.
  static func == (_: RVCache, _: RVCache) -> Bool { true }

  /// A field of the variable's slot at this signature, computed once. (Not
  /// under the lock: one tier asks another.)
  func memo<T: Sendable>(
    _ name: String, _ sig: String, _ field: WritableKeyPath<Entry, T?> & Sendable, _ make: () throws -> T
  ) rethrows -> T {
    if let hit = entries.withLock({ $0[name].flatMap { $0.sig == sig ? $0[keyPath: field] : nil } }) { return hit }
    let made = try make()
    store(name, sig, field, made)
    return made
  }

  func store<T: Sendable>(_ name: String, _ sig: String, _ field: WritableKeyPath<Entry, T?> & Sendable, _ value: T) {
    entries.withLock { all in
      // A stale signature drops every derived field at once.
      var entry = all[name].flatMap { $0.sig == sig ? $0 : nil } ?? Entry(sig: sig)
      entry[keyPath: field] = value
      all[name] = entry
    }
  }

  func read<T: Sendable>(_ name: String, _ sig: String, _ field: KeyPath<Entry, T?> & Sendable) -> T? {
    entries.withLock { $0[name].flatMap { $0.sig == sig ? $0[keyPath: field] : nil } }
  }
}

/// Names in the order JavaScript sorts strings: by UTF-16 code unit.
private func sortedNames(_ names: [String]) -> [String] {
  names.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
}

extension RVSystem {
  // MARK: Signatures

  /// Serialized definition of a variable and its dependencies, so editing
  /// `X ~ …` invalidates what was computed of `Y = X + 1` too (`defSig`).
  private func defSig(_ name: String, _ seen: inout Set<String>) -> String {
    if !seen.insert(name).inserted { return "@cycle" }
    switch get(name) {
    case nil: return "@missing"
    case .base(_, let dist): return "\(dist.kind)" + dist.args.map(exprKey).joined(separator: ",")
    case .derived(_, let expr):
      var s = exprKey(expr)
      for dep in sortedNames(freeVars(expr).list) where has(dep) { s += "|\(dep):\(defSig(dep, &seen))" }
      return s
    }
  }

  /// The definition, and the values of the constants it reads (`sig`).
  func sig(_ name: String, _ env: [String: Double]) throws -> String {
    var seen: Set<String> = []
    var s = defSig(name, &seen)
    for p in sortedNames(paramsOf(name).list) {
      guard let value = env[p] else { throw LanguageError("Unbound variable: \(p)") }
      s += ";\(p)=\(value.bitPattern)"
    }
    return s
  }

  // MARK: The joint sample

  /// The sample column for a variable under the given constants (`columns`).
  func columns(_ name: String, _ env: [String: Double]) throws -> [Double] {
    guard let rv = get(name) else { throw LanguageError("\(name) has an error in its definition.") }
    let sig = try sig(name, env)
    return try cache.memo(name, sig, \.col) {
      switch rv {
      case .base(_, let dist):
        let u = uniformStream(name)
        if isDiscrete(dist) {
          // The exact step-function quantile of each stratum, tabulated once
          // per parameter values (sortedQuantiles) and read in the stream's order.
          guard let law = try discreteLaw(dist, env) else { return [Double](repeating: .nan, count: SAMPLE_COUNT) }
          let strata = cache.memo(name, sig, \.strata) { sortedQuantiles(law) }
          return u.map { strata[Int(($0 * Double(SAMPLE_COUNT)).rounded(.down))] }
        }
        let a = try dist.args.map { try evaluate($0, env) }
        let none = [Double](repeating: .nan, count: SAMPLE_COUNT)
        switch dist.kind {
        case .normal: return a[1] > 0 ? u.map { a[0] + a[1] * normalQuantile($0) } : none
        case .uniform: return a[1] > a[0] ? u.map { a[0] + (a[1] - a[0]) * $0 } : none
        case .exponential: return a[0] > 0 ? u.map { -log(1 - $0) / a[0] } : none
        default:
          guard a.allSatisfy(\.isFinite), let q = zooQuantile(dist.kind, a) else { return none }
          return u.map(q)
        }
      case .derived(_, let expr):
        var cols: [String: [Double]] = [:]
        for dep in freeVars(expr) where has(dep) { cols[dep] = try columns(dep, env) }
        return try evalCols(expr, cols, env, SAMPLE_COUNT)
      }
    }
  }

  /// An expression over the joint sample, as canonical values (the sampled
  /// tier's twin of an enumerated column) (`sampledColumn`).
  func sampledColumn(_ e: Expr, _ env: [String: Double]) throws -> [Double] {
    var cols: [String: [Double]] = [:]
    for f in freeVars(e) where has(f) { cols[f] = try columns(f, env) }
    return try canonicalColumn(e, cols, env, SAMPLE_COUNT)
  }

  /// Monte Carlo estimate of P(body): the fraction of joint samples where
  /// the inequality holds. Samples where it is undefined count as "not the
  /// event"; NaN when it is undefined everywhere (broken parameters)
  /// (`sampleFraction`).
  func sampleFraction(_ body: Expr, _ env: [String: Double]) throws -> Double {
    var cols: [String: [Double]] = [:]
    for f in freeVars(body) where has(f) { cols[f] = try columns(f, env) }
    let mask = try evalCols(body, cols, env, SAMPLE_COUNT)
    var count = 0.0
    var defined = false
    for m in mask where !m.isNaN {
      defined = true
      if m == 1 { count += 1 }
    }
    return defined ? count / Double(SAMPLE_COUNT) : .nan
  }

  /// The pmf the joint sample shows of a derived discrete variable past the
  /// enumeration's cap (the sampled half of `pmfOf`).
  func sampledPmfOf(_ name: String, _ grounded: Expr, _ env: [String: Double]) throws -> DiscretePmf? {
    let sig = try sig(name, env)
    return try cache.memo(name, sig, \.spmf) {
      sampledPmf(try sampledColumn(grounded, env), try sampledTails(name, env))
    }
  }

  // MARK: Curves

  /// What the base laws a variable is built from say about its tails, known
  /// before any sample is looked at. The law's analytic tail, never a
  /// computed moment: Weibull(0.004, 1) has every moment, yet its σ overflows
  /// a double (`heavyBase`).
  func heavyBase(_ name: String, _ env: [String: Double]) -> HeavyBase {
    var level = 0
    for b in basesOf(name) {
      guard let dist = baseDist(b) else { continue }
      var df = Double.infinity
      if dist.kind == .cauchy {
        df = 1
      } else if dist.kind == .studentt {
        // (An unbound parameter: the caller reports it.)
        df = (try? evaluate(dist.args[0], env)) ?? .infinity
      }
      level = max(level, df <= 1 ? 2 : df <= 2 ? 1 : 0)
    }
    return level
  }

  /// The conditional-CDF quadrature base for a derived variable over one or
  /// two independent bases, or nil when that tier does not apply (`condBase`).
  private func condBase(_ name: String, _ env: [String: Double]) throws -> QCBase? {
    guard case .derived = get(name), let g = grounded(name) else { return nil }
    let bases = sortedNames(freeVars(g).list.filter(has))
    if bases.isEmpty || bases.count > 2 { return nil }
    var vars: [(name: String, quantile: Quantile)] = []
    for n in bases {
      // The tier integrates over a quantile grid as over a density: a
      // discrete base (the mixture N + Z) has steps there, and takes the
      // sampled tier.
      guard let dist = baseDist(n), !isDiscrete(dist), let quantile = try quantileClosure(dist, env) else {
        return nil
      }
      vars.append((n, quantile))
    }
    // (An unbound parameter or broken expression: the sampled tier reports it.)
    return try? conditionalBase(g, vars, env, heavyBase(name, env))
  }

  /// The curve of a variable with no exact law: the conditional-CDF curve
  /// where that tier applies, else the sample's estimate (the lower tiers of
  /// `rawCurve`).
  ///
  /// A quadrature-tier curve is view-aware: when the viewport zooms deep into
  /// the drawn window, the visible stretch re-rasterizes at full grid
  /// resolution from the cached base and splices into the global polyline,
  /// so zooming reveals the density's true shape rather than the grid's
  /// cells. The zoomed range carries ×3 pan headroom and recomputes only
  /// when the view leaves it or outgrows its resolution.
  func approximateCurve(_ name: String, _ env: [String: Double], view: (lo: Double, hi: Double)?) throws
    -> DensityCurve?
  {
    let sig = try sig(name, env)
    if let base = try cache.memo(name, sig, \.qcb, { try condBase(name, env) }) {
      let full = cache.memo(name, sig, \.qc) { condAssemble(base) }
      guard let view, let win = base.window else { return full }
      let visLo = JS.max([view.lo, win.lo])
      let visHi = JS.min([view.hi, win.hi])
      let visSpan = visHi - visLo
      let fullSpan = win.hi - win.lo
      if !(visSpan > 0) || visSpan >= 0.35 * fullSpan { return full }
      if let z = cache.read(name, sig, \.qcz), visLo >= z.lo, visHi <= z.hi, visSpan >= 0.15 * (z.hi - z.lo) {
        return z.curve
      }
      // Densify around the view, floored so differencing never outruns the
      // base grid's own sample resolution.
      let span = JS.max([3 * visSpan, fullSpan / QC_ZOOM_MAX])
      let mid = (visLo + visHi) / 2
      let zLo = JS.max([win.lo, mid - span / 2])
      let zHi = JS.min([win.hi, mid + span / 2])
      let zoomPts = condDensity(base, zLo, zHi)
      let fp = full.pts
      var pts: [Double] = []
      var i = 0
      while i + 1 < fp.count {
        if fp[i] < zLo { pts += [fp[i], fp[i + 1]] }
        i += 2
      }
      if pts.isEmpty && win.hardLo && zLo <= win.lo { pts += [win.lo, 0] }
      pts += zoomPts
      var tail: [Double] = []
      i = 0
      while i + 1 < fp.count {
        if fp[i] > zHi { tail += [fp[i], fp[i + 1]] }
        i += 2
      }
      if tail.isEmpty && win.hardHi && zHi >= win.hi { tail += [win.hi, 0] }
      pts += tail
      var curve = full
      curve.pts = pts
      cache.store(name, sig, \.qcz, RVCache.Zoomed(lo: zLo, hi: zHi, curve: curve))
      return curve
    }
    let col = try columns(name, env)
    return cache.memo(name, sig, \.est) { estimateCurve(col, heavyBase(name, env)) }
  }

  // MARK: Moments

  /// Moments by numeric integration against the base law: for Y = g(X) with a
  /// single base dependency, E[g(X)] = ∫ g(x)·pdf(x) dx by adaptive
  /// quadrature (Integrate.swift) — ~9 significant digits where the sample
  /// mean gives ~3. Undefined regions of g drop out of both the numerator and
  /// the mass, matching the sampler's "average where defined" convention. sd
  /// is infinite when the mean settles but the second moment does not. Nil
  /// for joint dependence (E[X·Y] still samples), broken parameters, or
  /// integrals that fail to settle (heavy tails) (the continuous half of
  /// `quadMoments`).
  func integratedMoments(_ name: String, _ env: [String: Double]) throws -> (mean: Double, sd: Double, mass: Double)? {
    let sig = try sig(name, env)
    let found = cache.memo(name, sig, \.qm) { () -> RVCache.QuadMoments? in
      guard let g = grounded(name) else { return nil }
      let bases = freeVars(g).list.filter(has)
      guard bases.count == 1, let dist = baseDist(bases[0]) else { return nil }
      guard let pc = try? pdfClosure(dist, env) else { return nil }
      var at = env
      func gAt(_ x: Double) -> Double {
        at[bases[0]] = x
        return (try? evaluate(g, at)) ?? .nan
      }
      enum Power { case mass, first, second, abs }
      // `abs` is E|g|: the test that a mean exists at all.
      func moment(_ k: Power) -> Double {
        func f(_ x: Double) -> Double {
          let v = gAt(x)
          if !v.isFinite { return 0 }
          let w: Double =
            switch k {
            case .mass: 1
            case .first: v
            case .second: v * v
            case .abs: abs(v)
            }
          return w * pc.pdf(x)
        }
        if let mid = pc.mid, mid > pc.lo, mid < pc.hi, mid.isFinite {
          return quadrature(f, pc.lo, mid) + quadrature(f, mid, pc.hi)
        }
        return quadrature(f, pc.lo, pc.hi)
      }
      let mass = moment(.mass)
      if !(mass > 1e-9) { return nil }
      let m1 = moment(.first)
      let m2 = moment(.second)
      if !m1.isFinite { return nil }
      let mean = m1 / mass
      if m2.isFinite {
        return RVCache.QuadMoments(mean: mean, sd: JS.max([m2 / mass - mean * mean, 0]).squareRoot(), mass: mass)
      }
      // The second moment did not settle. That is σ = ∞ (X² over StudentT(3):
      // E = 3) only if it diverges — quadrature says NaN just the same for a
      // finite integral it ran out of budget on, and those keep the old
      // answer: no quadrature moments, the curve's estimate instead. And the
      // mean stands only if it converged absolutely: X³ over a Cauchy
      // integrates to a clean 0 by symmetry and has no mean at all.
      guard let q = try? quantileClosure(dist, env), diverges({ JS.pow(gAt($0), 2) }, q) else { return nil }
      return moment(.abs).isFinite ? RVCache.QuadMoments(mean: mean, sd: .infinity, mass: mass) : nil
    }
    return found.map { ($0.mean, $0.sd, $0.mass) }
  }

  // MARK: Sampled discrete variables

  /// Whether the first two moments of a sampled-tier variable exist — a
  /// sample mean is finite either way, and 1.00001^G over Geometric(1e-6)
  /// prints as a confident 1e49. The discrete families' own tails are
  /// exponentially light, so only g can make a sum diverge, and only along a
  /// base with no upper end. Each such base is walked out its tail with the
  /// others held at their median and at both their 1e-6 quantiles (so a g
  /// that grows through a product is seen): exactly, by the base's own sliver
  /// masses, where its support enumerates; by quadrature over its exact
  /// quantile where it does not. Conservative: what cannot be certified is
  /// `unknown` (`sampledTails`).
  func sampledTails(_ name: String, _ env: [String: Double]) throws -> (mean: Tail, second: Tail) {
    var out: (mean: Tail, second: Tail) = (.ok, .ok)
    guard let g = grounded(name) else { return (.unknown, .unknown) }
    var laws: [(name: String, law: DiscreteLaw)] = []
    for b in basesOf(name) {
      // (No distribution: nothing is sampled either.)
      guard let law = try discreteLaw(baseDist(b)!, env) else { return out }
      laws.append((b, law))
    }
    for (b, law) in laws where law.hi == .infinity {
      let atoms: AtomSet?
      do {
        atoms = try baseAtomsOf(b, env)
      } catch is PastCap {
        atoms = nil
      }
      var memo: [Double: Double] = [:]
      func upper(_ u: Double) -> Double {
        if let k = memo[u] { return k }
        let k = law.quantile(u, true)
        memo[u] = k
        return k
      }
      let others: [(DiscreteLaw) -> Double] = [
        { $0.quantile(0.5, false) }, { $0.quantile(1e-6, true) }, { $0.quantile(1e-6, false) },
      ]
      for held in others {
        var at = env
        for (n, l) in laws { at[n] = held(l) }
        func gAt(_ x: Double) -> Double {
          at[b] = x
          return (try? evaluate(g, at)).map { abs($0) } ?? .nan
        }
        func tail(_ h: (Double) -> Double) -> Tail {
          guard let atoms else { return quantileTail(h, upper) }
          var deep = 0.0
          var shallow = 0.0
          for i in atoms.xs.indices where atoms.p[i] != atoms.c[i] {  // (else: not in a sliver)
            let w = h(atoms.xs[i])
            deep += w * (atoms.p[i] - atoms.n[i])
            shallow += w * (atoms.n[i] - atoms.c[i])
          }
          return tailOf(deep, shallow)
        }
        out.mean = worseTail(out.mean, tail(gAt))
        out.second = worseTail(out.second, tail { JS.pow(gAt($0), 2) })
      }
    }
    return out
  }
}
