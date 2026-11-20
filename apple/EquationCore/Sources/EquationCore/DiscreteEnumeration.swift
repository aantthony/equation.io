#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

/// Derived discrete variables: exact atoms by enumeration (lib/dist.ts
/// "derived discrete variables").
///
/// A variable built only on discrete bases (`S = X1 + X2`, `X^2`, `X/2`) is
/// itself discrete: finitely many atoms carry all but a negligible part of
/// its mass. They sit wherever g puts them, so nothing here assumes whole
/// numbers: atoms are (value, mass) pairs, drawn at their true locations. Two
/// joint points that differ only by rounding are one atom (0.1 + 0.2 and
/// 0.3), so every finished value is made `canonical` — whole numbers trusted,
/// a sum that cancelled to within the rounding of its operands read as 0, the
/// rest rounded to 12 significant digits — and a P(…) bound is compared the
/// same way. Only finished values: intermediate ones stay the floats they are.
///
/// Each base is cut to the whole numbers holding all but ENUM_TAIL of each
/// tail, and the expression is evaluated over the joint of the bases — never
/// over derived marginals, so `X - X` is the atom 0. Subexpressions over
/// disjoint bases are independent, so they are enumerated on their own and
/// combined: ten dice cost 10 × 51 × 6 evaluations, not 6^10. Operands that
/// share bases are conditioned on the shared ones. Any one product may hold
/// at most JOINT_MAX points, and one enumeration 2·JOINT_MAX in all.
///
/// Port: past that cap the site's joint sample stands in (a sampled pmf). The
/// sample is not ported: such a variable is reported as not supported.

/// Size of the site's joint sample, which caps one enumeration step (lib/dist.ts `SAMPLE_COUNT`).
let JOINT_MAX = Double(1 << 17)
/// Mass each truncated tail of a base may hide from the enumeration.
private let ENUM_TAIL = STEM_TAIL
/// A bounded support this small is enumerated whole: nothing is truncated,
/// so no moment of it can be in doubt.
private let FULL_SUPPORT = 1024.0
/// Most joint values of shared bases an enumeration conditions on (jointBlock).
private let CONDITION_MAX = 4096
/// The inner edges of the two tail slivers the moment test compares.
private let SLIVER_A = 1e-9
private let SLIVER_B = 1e-6
/// An atom is a value to this many significant digits (`canonical`), and one
/// tolerance follows from it: canonical values a grid step apart are the same
/// atom, and a sum this small against the magnitude of its operands cancelled to 0.
private let ATOM_DIGITS = 12
private let ATOM_REL = 1.5 * JS.pow(10, Double(1 - ATOM_DIGITS))
/// Intermediate values are never rounded. They merge only when they are the
/// same float, or differ by less than this against their magnitude.
private let FLOAT_REL = JS.pow(2, -50)

/// The enumeration ran past its cap: the site samples from here on.
private struct PastCap: Error {}

/// Whether two canonical values are one atom. Whole numbers are exact, and
/// never merge with each other.
private func sameAtom(_ a: Double, _ b: Double) -> Bool {
  a == b || (a.isNaN && b.isNaN)
    || (a.isFinite && b.isFinite && !(JS.isInteger(a) && JS.isInteger(b))
      && abs(a - b) <= ATOM_REL * JS.max([abs(a), abs(b)]))
}

/// Whether a sum of magnitude `mag` that came to x cancelled: its operands'
/// rounding is all that is left. (Whole operands add exactly: 0 is then 0.)
private func cancelled(_ x: Double, _ mag: Double) -> Bool { x != 0 && abs(x) <= ATOM_REL * mag }

/// A computed value as the atom it names: rounded to ATOM_DIGITS of `mag`,
/// the magnitude of what was added up to make it. A whole number is trusted
/// as it stands. Applied once, to a finished value.
private func canonical(_ x: Double, _ mag: Double) -> Double {
  if !x.isFinite || JS.isInteger(x) { return x }
  let m = JS.max([abs(x), mag.isFinite ? mag : 0])
  if cancelled(x, m) { return 0 }
  let e = Double(ATOM_DIGITS - 1) - log10(m).rounded(.down)
  if e < 0 || e > 22 { return m > abs(x) ? x : JS.number(JS.toPrecision(x, ATOM_DIGITS)) }
  let s = JS.pow(10, e)  // exact up to 1e22, so the quotient is the correctly rounded decimal
  return JS.round(x * s) / s
}

/// An expression bounding the magnitude of what `e` adds up: |a| + |b| for
/// a ± b, through products; nil when nothing in it can cancel.
private func magnitude(_ e: Expr) -> Expr? {
  func cancels(_ x: Expr) -> Bool {
    switch x {
    case .bin(let op, let a, let b, _): op == .add || op == .sub || cancels(a) || cancels(b)
    case .neg(let a): cancels(a)
    case .call(_, let args): args.contains(where: cancels)
    case .piecewise: true
    default: false
    }
  }
  func mag(_ x: Expr) -> Expr {
    switch x {
    case .neg(let a): mag(a)
    case .bin(.add, let a, let b, _), .bin(.sub, let a, let b, _): .bin(.add, mag(a), mag(b))
    case .bin(.mul, let a, let b, _): .bin(.mul, mag(a), mag(b))
    default: .call("abs", [x])
    }
  }
  return cancels(e) ? mag(e) : nil
}

/// Evaluate an expression column-wise over joint points. Inequalities yield
/// 1/0 masks (NaN where an operand is NaN), matching evaluate() (lib/dist.ts
/// `evalCols`).
private func evalCols(_ e: Expr, _ cols: [String: [Double]], _ env: [String: Double], _ n: Int) throws -> [Double] {
  switch e {
  case .index, .range, .eqtest, .comp, .figure, .lazy, .trail, .label, .hist, .family:
    throw LanguageError(structuralDiagnostic(e))
  case .num(let value):
    return [Double](repeating: value, count: n)
  case .var(let name):
    if let col = cols[name] { return col }
    guard let value = env[name] else { throw LanguageError("Unbound variable: \(name)") }
    return [Double](repeating: value, count: n)
  case .neg(let inner):
    return try evalCols(inner, cols, env, n).map { -$0 }
  case .bin(let op, let lhs, let rhs, _):
    let a = try evalCols(lhs, cols, env, n)
    let b = try evalCols(rhs, cols, env, n)
    var out = [Double](repeating: 0, count: n)
    switch op {
    case .add: for i in 0..<n { out[i] = a[i] + b[i] }
    case .sub: for i in 0..<n { out[i] = a[i] - b[i] }
    case .mul: for i in 0..<n { out[i] = a[i] * b[i] }
    case .div: for i in 0..<n { out[i] = a[i] / b[i] }
    // (Math.pow, not the real odd roots evaluate() takes: as the site's columns do.)
    case .pow: for i in 0..<n { out[i] = JS.pow(a[i], b[i]) }
    }
    return out
  case .call(let name, let argExprs):
    guard let fn = evalFunctions[name] else { throw LanguageError("Unknown function: \(name)") }
    let args = try argExprs.map { try evalCols($0, cols, env, n) }
    return (0..<n).map { i in fn(args.map { $0[i] }) }
  case .eq(let l, let r):
    let a = try evalCols(l, cols, env, n)
    let b = try evalCols(r, cols, env, n)
    return (0..<n).map { a[$0] - b[$0] }
  case .ineq:
    var out = [Double](repeating: 1, count: n)
    for (op, l, r) in ineqComparisons(e) {
      let a = try evalCols(l, cols, env, n)
      let b = try evalCols(r, cols, env, n)
      for i in 0..<n where !out[i].isNaN {
        if a[i].isNaN || b[i].isNaN {
          out[i] = .nan
          continue
        }
        let holds =
          switch op {
          case .lt: a[i] < b[i]
          case .le: a[i] <= b[i]
          case .gt: a[i] > b[i]
          case .ge: a[i] >= b[i]
          }
        if !holds { out[i] = 0 }
      }
    }
    return out
  case .loop:
    throw LanguageError("A recursive function cannot be applied to a data column or random variable yet.")
  case .piecewise(let cases, let otherwise):
    var out = [Double](repeating: .nan, count: n)
    var taken = [Bool](repeating: false, count: n)
    for c in cases {
      let mask = try evalCols(c.cond, cols, env, n)
      let val = try evalCols(c.value, cols, env, n)
      for i in 0..<n where !taken[i] && mask[i] == 1 {
        out[i] = val[i]
        taken[i] = true
      }
    }
    if let otherwise {
      let val = try evalCols(otherwise, cols, env, n)
      for i in 0..<n where !taken[i] { out[i] = val[i] }
    }
    return out
  case .vec:
    throw LanguageError("Vector in scalar context.")
  case .list, .data:
    throw LanguageError("List in scalar context.")
  case .str, .text:
    throw LanguageError("Text has no numeric value.")
  }
}

/// `e` over columns, unrounded, with the magnitude of each value (see
/// `canonical`); a sum that cancelled is already 0.
private func columnOf(_ e: Expr, _ cols: [String: [Double]], _ env: [String: Double], _ count: Int) throws
  -> (vals: [Double], mags: [Double])
{
  var vals = try evalCols(e, cols, env, count)
  guard let mag = magnitude(e) else { return (vals, vals.map { abs($0) }) }
  let mags = try evalCols(mag, cols, env, count)
  for i in 0..<count where cancelled(vals[i], mags[i]) { vals[i] = 0 }
  return (vals, mags)
}

/// Atoms of an intermediate value: ascending, then ±∞ and NaN kept as atoms
/// of their own (lib/dist.ts `AtomSet`).
private struct AtomSet {
  var xs: [Double]
  /// The magnitude of what was added up to make each value (see `canonical`).
  var mag: [Double]
  /// Mass of each atom…
  var p: [Double]
  /// …the part of it not from the outermost sliver of any truncated tail…
  var n: [Double]
  /// …and the part from neither sliver.
  var c: [Double]
  /// Mass the truncation ignored, at most.
  var lost: Double
}

/// Merge joint points into atoms; `vals` in any order. With `finished` the
/// values are made canonical first and merge as atoms do; without, they stay
/// the floats they are and only float variants of one value merge.
private func mergeAtoms(
  _ values: [Double], _ mags: [Double], _ wp: [Double], _ wn: [Double], _ wc: [Double], _ lost: Double,
  finished: Bool
) -> AtomSet {
  var vals = values
  if finished {
    for i in vals.indices { vals[i] = canonical(vals[i], mags[i]) }
  }
  let count = vals.count
  var idx = Array(0..<count)
  var sorted = true
  for i in 1..<max(count, 1) where !(vals[i - 1] <= vals[i]) { sorted = false }
  // NaN last; a − b would be NaN between two infinities.
  if !sorted {
    idx = stableSorted(idx) { i, j in
      let (a, b) = (vals[i], vals[j])
      if a.isNaN || b.isNaN { return !a.isNaN }
      return a < b
    }
  }
  func same(_ a: Double, _ ma: Double, _ b: Double, _ mb: Double) -> Bool {
    if a == b || (a.isNaN && b.isNaN) { return true }
    if !a.isFinite || !b.isFinite || (JS.isInteger(a) && JS.isInteger(b)) { return false }
    return abs(a - b) <= (finished ? ATOM_REL : FLOAT_REL) * JS.max([ma, mb])
  }
  var out = AtomSet(xs: [], mag: [], p: [], n: [], c: [], lost: lost)
  var first = Double.nan  // the value that opened the current atom: merging never chains
  var firstMag = 0.0
  for i in idx {
    if !(wp[i] > 0) { continue }  // the pmf underflowed: no atom
    let x = vals[i]
    let last = out.xs.count - 1
    if last >= 0 && same(first, firstMag, x, mags[i]) {
      out.p[last] += wp[i]
      out.n[last] += wn[i]
      out.c[last] += wc[i]
      if mags[i] > out.mag[last] { out.mag[last] = mags[i] }
    } else {
      out.xs.append(x)
      out.mag.append(mags[i])
      out.p.append(wp[i])
      out.n.append(wn[i])
      out.c.append(wc[i])
      first = x
      firstMag = mags[i]
    }
  }
  return out
}

/// The atoms of a base law: its mass range. Past the cap when that is too
/// wide to enumerate (Poisson(1e9), Geometric(1e-6)).
private func baseAtoms(_ law: DiscreteLaw) throws(PastCap) -> AtomSet {
  let full = law.hi - law.lo < FULL_SUPPORT
  let kLo = full ? law.lo : law.quantile(ENUM_TAIL, false)
  let kHi = full ? law.hi : law.quantile(ENUM_TAIL, true)
  if !kLo.isFinite || !kHi.isFinite || !(kHi - kLo < JOINT_MAX) { throw PastCap() }
  // Slivers only on a side the truncation actually cut.
  let cutLo = kLo > law.lo
  let cutHi = kHi < law.hi
  let aLo = cutLo ? law.quantile(SLIVER_A, false) : -.infinity
  let bLo = cutLo ? law.quantile(SLIVER_B, false) : -.infinity
  let aHi = cutHi ? law.quantile(SLIVER_A, true) : .infinity
  let bHi = cutHi ? law.quantile(SLIVER_B, true) : .infinity
  let size = Int(kHi - kLo + 1)
  var set = AtomSet(xs: [], mag: [], p: [], n: [], c: [], lost: 0)
  for j in 0..<size {
    let k = kLo + Double(j)
    let p = law.pmf(k)
    set.xs.append(k)
    set.mag.append(abs(k))
    set.p.append(p)
    set.n.append(k < aLo || k > aHi ? 0 : p)
    set.c.append(k < bLo || k > bHi ? 0 : p)
  }
  set.lost = (cutLo ? law.pq(kLo - 1).0 : 0) + (cutHi ? law.pq(kHi).1 : 0)
  return set
}

/// Jointly enumerated values of some terms: one row per joint point, with
/// its weights (as AtomSet's p, n, c). `terms` says whose columns these are.
private struct Block {
  var terms: [Int]
  var cols: [[Double]]
  var mags: [[Double]]
  var p: [Double]
  var n: [Double]
  var c: [Double]
  var lost: Double

  init(terms: [Int], cols: [[Double]], mags: [[Double]], p: [Double], n: [Double], c: [Double], lost: Double) {
    (self.terms, self.cols, self.mags, self.p, self.n, self.c, self.lost) = (terms, cols, mags, p, n, c, lost)
  }

  init(_ term: Int, _ atoms: AtomSet) {
    self.init(terms: [term], cols: [atoms.xs], mags: [atoms.mag], p: atoms.p, n: atoms.n, c: atoms.c, lost: atoms.lost)
  }
}

/// Columns for every term over one product of joint points.
private struct Joint {
  var cols: [[Double]]
  var mags: [[Double]]
  var wp: [Double]
  var wn: [Double]
  var wc: [Double]
  var lost: Double
}

private func product(_ blocks: [Block]) -> Double { blocks.reduce(1) { $0 * Double($1.p.count) } }

/// Independent blocks laid out over their product: every combination once,
/// with the product of the weights. Nil past JOINT_MAX. Columns of terms no
/// block holds (constants) are left for the caller.
private func tensor(_ blocks: [Block], _ termCount: Int) -> Joint? {
  var total = 1.0
  for block in blocks {
    total *= Double(block.p.count)
    if total > JOINT_MAX { return nil }
  }
  let size = Int(total)
  var joint = Joint(
    cols: Array(repeating: [], count: termCount), mags: Array(repeating: [], count: termCount),
    wp: [Double](repeating: 1, count: size), wn: [Double](repeating: 1, count: size),
    wc: [Double](repeating: 1, count: size), lost: 0)
  var period = 1
  var kept = 1.0
  for block in blocks {
    let m = block.p.count
    var at = [Int](repeating: 0, count: size)
    for i in 0..<size {
      let j = (i / period) % m
      at[i] = j
      joint.wp[i] *= block.p[j]
      joint.wn[i] *= block.n[j]
      joint.wc[i] *= block.c[j]
    }
    for (k, term) in block.terms.enumerated() {
      joint.cols[term] = at.map { block.cols[k][$0] }
      joint.mags[term] = at.map { block.mags[k][$0] }
    }
    period *= m
    kept *= 1 - block.lost
  }
  joint.lost = 1 - kept
  return joint
}

/// The comparisons of a P(…) body as terms and the operators between them:
/// `a < X <= b` is [a, X, b] with ['<', '<=']; a point event is two terms.
private func eventShape(_ body: Expr) -> (terms: [Expr], ops: [String])? {
  switch body {
  case .eq(let l, let r): return ([l, r], ["="])
  case .eqtest(let op, let l, let r): return ([l, r], [op == .eq ? "=" : "!="])
  case .ineq:
    let comps = ineqComparisons(body)
    return ([comps[0].l] + comps.map(\.r), comps.map(\.op.rawValue))
  default: return nil
  }
}

/// The event's mask over term columns: 1 where every comparison holds, 0
/// where one fails, NaN where a side is undefined. Discrete values tie with
/// positive probability, so strictness is the whole difference between
/// P(X > Y) and P(X >= Y) — and a tie is judged as atoms are told apart.
private func eventMask(_ cols: [[Double]], _ ops: [String], _ count: Int) -> [Double] {
  var out = [Double](repeating: 1, count: count)
  for (k, op) in ops.enumerated() {
    let (a, b) = (cols[k], cols[k + 1])
    for i in 0..<count where !out[i].isNaN {
      if a[i].isNaN || b[i].isNaN {
        out[i] = .nan
        continue
      }
      let tie = sameAtom(a[i], b[i])
      let holds =
        switch op {
        case "=": tie
        case "!=": !tie
        case "<": !tie && a[i] < b[i]
        case ">": !tie && a[i] > b[i]
        case "<=": tie || a[i] < b[i]
        default: tie || a[i] > b[i]
        }
      if !holds { out[i] = 0 }
    }
  }
  return out
}

private enum Verdict { case exact, estimate, diverges }

/// How a truncated sum of h over the atoms stands to the true E[h]. The
/// slivers A (tail probability ENUM_TAIL..1e-9) and B (1e-9..1e-6): a
/// convergent sum gains less from the deeper one, and then the unseen tail
/// beyond A is about A·r/(1 − r) with r = A/B. `exact` when that is
/// invisible (1e-7 of the total), `estimate` up to 1e-3, and `diverges`
/// beyond — or when A does not fall short of B at all.
private func momentVerdict(_ set: AtomSet, _ h: (Double) -> Double) -> Verdict {
  var total = 0.0
  var a = 0.0
  var b = 0.0
  for i in set.xs.indices {
    let w = h(set.xs[i])
    if !w.isFinite { continue }
    total += w * set.p[i]
    a += w * (set.p[i] - set.n[i])
    b += w * (set.n[i] - set.c[i])
  }
  if !(a > 0) { return .exact }  // nothing truncated, or h vanishes out there
  let r = a / b
  if b > 0 && r >= 0.97 { return .diverges }
  // (A lumpy law may leave sliver B empty; then A itself bounds the unseen.)
  let unseen = (b > 0 ? (a * r) / (1 - r) : a) / total
  return unseen <= 1e-7 ? .exact : unseen <= 1e-3 ? .estimate : .diverges
}

/// The pmf of a derived discrete variable (lib/dist.ts `DiscretePmf`), as
/// enumerated.
public struct DiscretePmf: Equatable, Sendable {
  /// Atoms with a finite value, ascending, and the mass of each.
  public var xs: [Double]
  public var ps: [Double]
  /// P(defined): 1/X at X = 0, sqrt(X − 2) below 2 and an overflow are no value.
  var mass: Double
  /// Mean and sd where defined. The mean is NaN unless `meanOk`; sd is
  /// infinite where the second moment diverges.
  var mean: Double
  var sd: Double
  /// False when the mean's sum diverges, or truncation hides a visible part.
  var meanOk: Bool
  /// Nothing the truncation hid could show in μ (`meanExact`) or in μ and σ both (`certified`).
  var meanExact: Bool
  var certified: Bool
}

/// The smallest gap between neighbouring stems (infinite for a lone one):
/// the spacing that decides whether these stems have room for dots.
private func minGap(_ ks: ArraySlice<Double>) -> Double {
  var step = Double.infinity
  for (a, b) in zip(ks, ks.dropFirst()) { step = JS.min([step, b - a]) }
  return step
}

private func exactPmf(_ set: AtomSet) -> DiscretePmf? {
  var total = 0.0
  var from = 0
  var to = 0
  for i in set.xs.indices {
    total += set.p[i]
    if set.xs[i] == -.infinity { from = i + 1 }
    if set.xs[i].isFinite { to = i + 1 }
  }
  if !(total > 0) { return nil }
  let xs = Array(set.xs[from..<max(from, to)])
  // Of the mass enumerated (all but `lost`): P(D = 0) of D = X − X is 1.
  let ps = set.p[from..<max(from, to)].map { $0 / total }
  // Mean and sd of the atoms, averaged where defined (`atomMoments`).
  var sum = 0.0
  var m1 = 0.0
  for (x, p) in zip(xs, ps) {
    sum += p
    m1 += x * p
  }
  let mean = m1 / sum
  var m2 = 0.0
  for (x, p) in zip(xs, ps) { m2 += JS.pow(x - mean, 2) * p }
  let sd = (m2 / sum).squareRoot()
  let v1 = momentVerdict(set) { abs($0) }
  let v2 = momentVerdict(set) { $0 * $0 }
  let meanOk = v1 != .diverges && mean.isFinite
  return DiscretePmf(
    xs: xs, ps: ps, mass: from == 0 && to == set.xs.count ? 1 : sum, mean: meanOk ? mean : .nan,
    sd: !meanOk ? .nan : v2 == .diverges ? .infinity : sd, meanOk: meanOk, meanExact: meanOk && v1 == .exact,
    certified: meanOk && v1 == .exact && v2 == .exact)
}

/// The first index of ascending `xs` whose value is above x (or, at least x).
private func firstAbove(_ xs: [Double], _ x: Double, orEqual: Bool) -> Int {
  var (a, z) = (0, xs.count)
  while a < z {
    let mid = (a + z) >> 1
    if orEqual ? xs[mid] >= x : xs[mid] > x { z = mid } else { a = mid + 1 }
  }
  return a
}

extension DiscretePmf {
  /// The atoms [i0, i1] of a drawn window: all of them while they are few,
  /// else the tallest in each cell of a fixed lattice (multiples of a
  /// power-of-two stride, so a pan slides over the same choice)
  /// (`windowAtoms`).
  fileprivate func window(_ from: Int, _ to: Int, view: (lo: Double, hi: Double)?) -> PmfStems {
    let v0 = view.map { firstAbove(xs, $0.lo, orEqual: true) } ?? 0
    let v1 = view.map { firstAbove(xs, $0.hi, orEqual: false) - 1 } ?? xs.count - 1
    let i0 = max(from, v0)
    let i1 = min(to, v1)
    var out = PmfStems(ks: [], ps: [], envelope: false)
    if Double(i1 - i0) < STEM_MAX {
      if i0 <= i1 {
        out.ks = Array(xs[i0...i1])
        out.ps = Array(ps[i0...i1])
      }
      // Room for dots is a matter of the atoms on screen — all of them, so a
      // selected stem is drawn to its neighbours' measure — not of the
      // closest pair anywhere: 1/N crowds toward 0 and stands well apart at 1.
      out.step = Double(v1 - v0) < STEM_MAX ? minGap(v0 <= v1 ? xs[v0...v1] : []) : 0
      return out
    }
    let stride = JS.pow(2, log2((xs[i1] - xs[i0]) / STEM_MAX).rounded(.up))
    var cell = Double.nan
    for i in i0...i1 {
      let at = (xs[i] / stride).rounded(.down)
      if at != cell {
        cell = at
        out.ks.append(xs[i])
        out.ps.append(ps[i])
      } else if ps[i] > out.ps[out.ps.count - 1] {
        out.ks[out.ks.count - 1] = xs[i]
        out.ps[out.ps.count - 1] = ps[i]
      }
    }
    out.step = stride
    return out
  }

  /// The smallest atom with at least u of the defined mass at or below it (`atomQuantile`).
  fileprivate func quantile(_ u: Double) -> Double {
    let total = ps.reduce(0, +)
    var cum = 0.0
    for (x, p) in zip(xs, ps) {
      cum += p
      if cum >= u * total { return x }
    }
    return xs.last ?? .nan
  }

  /// The atoms a P(…) selects, as an index range of `xs` (with `not`: all
  /// the rest); nil while a bound is NaN. A bound within rounding of an atom
  /// is that atom, so strictness decides it: `S <= 0.3` takes the atom
  /// 0.1 + 0.2 (`atomRange`).
  fileprivate func range(_ b: ProbBounds, _ env: [String: Double]) throws -> (i0: Int, i1: Int)? {
    func at(_ e: Expr) throws -> Double {
      canonical(try evaluate(e, env), try magnitude(e).map { try evaluate($0, env) } ?? 0)
    }
    let lo = try b.lo.map(at) ?? -.infinity
    let hi = try b.hi.map(at) ?? .infinity
    if lo.isNaN || hi.isNaN { return nil }
    var i0 = firstAbove(xs, lo, orEqual: true)
    if i0 > 0 && sameAtom(xs[i0 - 1], lo) { i0 -= 1 }
    if b.loStrict == true && i0 < xs.count && sameAtom(xs[i0], lo) { i0 += 1 }
    var i1 = firstAbove(xs, hi, orEqual: false) - 1
    if i1 + 1 < xs.count && sameAtom(xs[i1 + 1], hi) { i1 += 1 }
    if b.hiStrict == true && i1 >= 0 && sameAtom(xs[i1], hi) { i1 -= 1 }
    return (i0, i1)
  }
}

/// Work left to the enumeration in progress: no chain of steps, each under
/// the cap, may add up to a stall (conditioning nests).
private final class Budget {
  var left = 2 * JOINT_MAX

  func charge(_ points: Double) -> Bool {
    left -= points + 64  // a step costs something however small it is
    return left >= 0
  }
}

extension RVSystem {
  /// A discrete base's atoms at these parameter values; nil while it declares no distribution.
  private func baseAtomsOf(_ name: String, _ env: [String: Double]) throws -> AtomSet? {
    guard let dist = baseDist(name), let law = try discreteLaw(dist, env) else { return nil }
    return try baseAtoms(law)
  }

  /// The random names of a grounded expression (bases, all of them).
  private func randomIn(_ e: Expr) -> [String] { freeVars(e).list.filter(has) }

  /// The joint of several grounded terms, as columns over one product
  /// (`enumerateTerms`). Terms are grouped by the bases they share
  /// (transitively). A term that shares none is independent of the rest: it
  /// is enumerated on its own, and its atoms — far fewer than its joint
  /// points — enter the product. Terms that do share are enumerated together
  /// (jointBlock), group by group. `whole`: all of them as one group, over
  /// the joint of their bases. Nil while a base declares no distribution.
  private func enumerateTerms(_ terms: [Expr], _ env: [String: Double], _ budget: Budget, whole: Bool = false) throws
    -> Joint?
  {
    let random = terms.map(randomIn)
    var group = Array(terms.indices)
    func find(_ k: Int) -> Int {
      if group[k] == k { return k }
      group[k] = find(group[k])
      return group[k]
    }
    // (A JavaScript Map: a name keeps the place it was first set at.)
    var ownerOrder: [String] = []
    var owner: [String: Int] = [:]
    for (k, names) in random.enumerated() {
      for n in names {
        if let other = whole ? ownerOrder.first.map({ owner[$0]! }) : owner[n] { group[find(k)] = find(other) }
        if owner.updateValue(k, forKey: n) == nil { ownerOrder.append(n) }
      }
    }
    var blocks: [Block] = []
    for root in terms.indices {
      if find(root) != root || random[root].isEmpty { continue }
      let members = terms.indices.filter { !random[$0].isEmpty && find($0) == root }
      let block: Block?
      if members.count == 1 && !whole {
        block = try enumerate(terms[root], env, budget).map { Block(root, $0) }
      } else {
        block = try jointBlock(members.map { terms[$0] }, members, env, budget, whole: whole)
      }
      guard let block else { return nil }
      blocks.append(block)
    }
    if !budget.charge(product(blocks)) { throw PastCap() }
    guard var joint = tensor(blocks, terms.count) else { throw PastCap() }
    for (k, t) in terms.enumerated() where random[k].isEmpty {
      (joint.cols[k], joint.mags[k]) = try columnOf(t, [:], env, joint.wp.count)
    }
    return joint
  }

  /// Terms that share bases, enumerated together (`jointBlock`). Conditioned
  /// on the shared bases where that leaves something independent: given D0,
  /// `T = D0 + … + D9` and `D0` share nothing, so each value of D0 costs one
  /// cheap enumeration of T. Otherwise (nothing left over, too many shared
  /// values, or `whole`) the joint of the bases, each term evaluated over it.
  private func jointBlock(_ terms: [Expr], _ ids: [Int], _ env: [String: Double], _ budget: Budget, whole: Bool)
    throws -> Block?
  {
    var all: [String] = []
    var counts: [String: Int] = [:]
    for t in terms {
      for n in randomIn(t) {
        if counts[n] == nil { all.append(n) }
        counts[n, default: 0] += 1
      }
    }
    func atomsOf(_ names: [String]) throws -> [Block]? {
      var out: [Block] = []
      for (k, n) in names.enumerated() {
        guard let atoms = try baseAtomsOf(n, env) else { return nil }
        out.append(Block(k, atoms))
      }
      return out
    }
    let shared = all.filter { counts[$0]! > 1 }
    let given = whole || shared.count == all.count ? nil : try atomsOf(shared)
    if let given, product(given) <= Double(CONDITION_MAX) {
      let over = tensor(given, shared.count)!
      let rows = over.wp.count
      if !budget.charge(Double(rows)) { throw PastCap() }
      var parts: [Joint] = []
      var size = 0
      for i in 0..<rows {
        var at: [String: Expr] = [:]
        for (k, n) in shared.enumerated() { at[n] = .num(over.cols[k][i]) }
        guard let part = try enumerateTerms(terms.map { substVars($0, at) }, env, budget) else { return nil }
        size += part.wp.count
        if Double(size) > JOINT_MAX { throw PastCap() }
        parts.append(part)
      }
      var block = Block(
        terms: ids, cols: ids.map { _ in [] }, mags: ids.map { _ in [] }, p: [], n: [], c: [],
        lost: 1 - (1 - over.lost) * (1 - JS.max([0] + parts.map(\.lost))))
      for (i, part) in parts.enumerated() {
        for k in ids.indices {
          block.cols[k] += part.cols[k]
          block.mags[k] += part.mags[k]
        }
        block.p += part.wp.map { over.wp[i] * $0 }
        block.n += part.wn.map { over.wn[i] * $0 }
        block.c += part.wc.map { over.wc[i] * $0 }
      }
      return block
    }
    guard let bases = try atomsOf(all) else { return nil }
    if !budget.charge(product(bases)) { throw PastCap() }
    guard let joint = tensor(bases, all.count) else { throw PastCap() }
    var byName: [String: [Double]] = [:]
    for (k, n) in all.enumerated() { byName[n] = joint.cols[k] }
    let columns = try terms.map { try columnOf($0, byName, env, joint.wp.count) }
    return Block(
      terms: ids, cols: columns.map(\.vals), mags: columns.map(\.mags), p: joint.wp, n: joint.wn, c: joint.wc,
      lost: joint.lost)
  }

  /// The atoms of a grounded expression over discrete bases: unrounded,
  /// unless `finished` (the root: see mergeAtoms) (`enumerate`).
  private func enumerate(_ e: Expr, _ env: [String: Double], _ budget: Budget, finished: Bool = false) throws
    -> AtomSet?
  {
    if case .var(let name) = e, has(name) { return try baseAtomsOf(name, env) }
    // An operator or call over independent operands combines their atoms.
    // (Anything else — a piecewise, a comparison — reads the joint of its bases.)
    let kids: [Expr]? =
      switch e {
      case .neg(let a): [a]
      case .bin(_, let a, let b, _): [a, b]
      case .call(_, let args): args
      default: nil
      }
    guard let joint = try kids.map({ try enumerateTerms($0, env, budget) }) ?? enumerateTerms([e], env, budget, whole: true)
    else { return nil }
    let size = joint.wp.count
    var vals = joint.cols.first ?? []
    var mags = joint.mags.first ?? []
    if let kids {
      // No identifier: cannot collide with a user's name.
      let names = kids.indices.map { "\u{0}\($0)" }
      let at = names.map { Expr.var($0) }
      let node: Expr =
        switch e {
        case .neg: .neg(at[0])
        case .bin(let op, _, _, _): .bin(op, at[0], at[1])
        case .call(let name, _): .call(name, at)
        default: e
        }
      var cols: [String: [Double]] = [:]
      for (n, col) in zip(names, joint.cols) { cols[n] = col }
      vals = try evalCols(node, cols, env, size)
      // What this node added up: |a| + |b| for a sum (which may have
      // cancelled to 0), carried through a product or quotient, else the
      // value's own.
      switch e {
      case .neg:
        mags = joint.mags[0]
      case .bin(.add, _, _, _), .bin(.sub, _, _, _):
        mags = zip(joint.mags[0], joint.mags[1]).map { $0 + $1 }
        for i in 0..<size where cancelled(vals[i], mags[i]) { vals[i] = 0 }
      case .bin(.mul, _, _, _):
        mags = zip(joint.mags[0], joint.mags[1]).map { $0 * $1 }
      case .bin(.div, _, _, _):
        let (ma, b) = (joint.mags[0], joint.cols[1])
        mags = (0..<size).map { JS.max([abs(vals[$0]), ma[$0] / abs(b[$0])]) }
      default:
        mags = vals.map { abs($0) }
      }
    }
    return mergeAtoms(vals, mags, joint.wp, joint.wn, joint.wc, joint.lost, finished: finished)
  }

  /// The pmf of a derived discrete variable at these parameter values,
  /// enumerated (`pmfOf`) — or nil: not such a variable (a law of its own
  /// answers through discreteDist), or a base declares no distribution.
  ///
  /// Port: past the enumeration's cap the site samples the pmf; here such a
  /// variable throws `Unsupported`.
  public func pmfOf(_ name: String, _ env: [String: Double]) throws -> DiscretePmf? {
    guard case .derived(_, let expr)? = get(name), isDiscreteVar(name), discreteDist(name) == nil else { return nil }
    do {
      guard let g = ground(expr) else { throw PastCap() }
      return try enumerate(g, env, Budget(), finished: true).flatMap(exactPmf)
    } catch is PastCap {
      throw Unsupported("a discrete random variable with too many values to enumerate")
    }
  }

  /// What a derived discrete variable draws over the visible x-range: its
  /// atoms at their true locations (the derived half of `pmfRuns`). With
  /// `select` only the part a P(…) row's bounds select, strictness and all.
  func atomRuns(
    _ pmf: DiscretePmf, _ env: [String: Double], view: (lo: Double, hi: Double)?, select: ProbBounds?
  ) throws -> [PmfStems] {
    let all = (i0: 0, i1: pmf.xs.count - 1)
    guard let range = try select.map({ try pmf.range($0, env) }) ?? all else { return [] }
    let ranges = select?.not == true ? [(0, range.i0 - 1), (range.i1 + 1, pmf.xs.count - 1)] : [(range.i0, range.i1)]
    return ranges.map { pmf.window($0.0, $0.1, view: view) }.filter { !$0.ks.isEmpty }
  }

  /// The stem an E(…) marker stands on, of a derived variable: the atom at
  /// x, within rounding, and its mass — else x itself, on the axis.
  func atomNear(_ pmf: DiscretePmf, _ x: Double) -> (x: Double, h: Double) {
    let i = firstAbove(pmf.xs, x, orEqual: true)
    for j in [i - 1, i] where j >= 0 && j < pmf.xs.count && sameAtom(pmf.xs[j], x) { return (pmf.xs[j], pmf.ps[j]) }
    return (x, 0)
  }

  /// The mass of the atoms constant bounds select, of the defined mass.
  func atomProbability(_ pmf: DiscretePmf, _ bounds: ProbBounds, _ env: [String: Double]) throws -> Double {
    guard let range = try pmf.range(bounds, env) else { return .nan }
    var inside = 0.0
    for i in max(range.i0, 0)..<max(range.i1 + 1, max(range.i0, 0)) { inside += pmf.ps[i] }
    // Where the variable is undefined the event did not happen — nor did
    // its complement: `not` is the rest of the defined mass.
    let defined = pmf.ps.reduce(0, +)
    return bounds.not ? JS.max([0, defined - inside]) : inside
  }

  /// The probability of an event over discrete variables alone, enumerated
  /// over the joint of their bases (so `P(X > X)` is 0, and `A = X + Y;
  /// B = X - Y; P(A > B)` sees the X they share); nil when the body has no
  /// such shape (the enumerated half of `eventProbability`).
  func enumeratedProbability(_ body: Expr, _ env: [String: Double]) throws -> Double? {
    guard let shape = eventShape(body) else { return nil }
    do {
      let terms = try shape.terms.map { t -> Expr in
        guard let g = ground(t) else { throw PastCap() }
        return g
      }
      guard let joint = try enumerateTerms(terms, env, Budget()) else { return .nan }
      // The terms are finished values: canonical, as atoms are (mergeAtoms).
      let cols = joint.cols.enumerated().map { k, col in
        zip(col, joint.mags[k]).map { canonical($0, $1) }
      }
      let mask = eventMask(cols, shape.ops, joint.wp.count)
      // Of the mass enumerated (all but `lost`), so a certain event is 1.
      var value = 0.0
      var total = 0.0
      for i in mask.indices {
        total += joint.wp[i]
        if mask[i] == 1 { value += joint.wp[i] }
      }
      return JS.min([1, value / total])
    } catch is PastCap {
      throw Unsupported("an event over discrete random variables with too many values to enumerate")
    }
  }

  /// What a derived discrete row's readout says, read off the enumeration
  /// (the discrete half of `moments`).
  func atomMoments(_ pmf: DiscretePmf) -> Moments {
    if !pmf.meanOk {
      return .robust(
        median: pmf.quantile(0.5), iqr: pmf.quantile(0.75) - pmf.quantile(0.25), meanOk: false, mass: pmf.mass,
        note: nil)
    }
    return pmf.certified
      ? .exact(mean: pmf.mean, sd: pmf.sd, mass: pmf.mass, note: nil)
      : .estimate(mean: pmf.mean, sd: pmf.sd, mass: pmf.mass, note: nil)
  }
}
