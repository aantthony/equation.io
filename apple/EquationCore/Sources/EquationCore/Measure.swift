/// Reductions over continuous multisets (lib/measure.ts; docs/multisets.md
/// §5, "Multiplicity becomes measure").
///
/// `x`, `y`, `z` (all reals) and `u`, `v` ([0, 1]) are infinite multisets
/// whose multiplicity is length. A reduction over them is an integral against
/// that measure: `count` is the measure, `total` the integral, `mean` their
/// ratio. A filter keeps a subset and measures it with the geometric measure
/// of its dimension.
///
/// The site takes one of two routes, by the shape of the set, and the port
/// has the first:
///
/// - **Integrals** (ported). A product of ranges (`total(u^2)`,
///   `{0 < x < 1: x^2}`), or a curve written as a graph over a bounded range
///   (`{y = x^2, 0 < x < 1}`, arc length ∫ √(1 + g'²)). An
///   everywhere-continuous integrand keeps its closed form, so sliders stay
///   symbolic; any other is integrated adaptively at the sliders' values,
///   finding its own singularities, so a divergent integral is ∞ or an error
///   rather than a finite number. `min` and `max` search the product.
/// - **Numeric** (not ported: `numericReduction` and all it stands on, the
///   quadtree over interval enclosures of lib/certify.ts, marching squares
///   and certified root counting). Any other filter in one or two
///   coordinates — a region (`x^2 + y^2 < 1`), an implicit curve, points —
///   says it is not supported yet. So does `interval(a, b)`, which the
///   resolver does not read.

private func num(_ value: Double) -> Expr { .num(value) }
private func vr(_ name: String) -> Expr { .var(name) }

/// The continuous multisets a row can name (§5).
private let CONTINUOUS = ["x", "y", "z", "u", "v"]
private let GEOMETRIC: Set<String> = ["x", "y", "z"]
private let INF: Expr = .var("inf")
private let NEG_INF: Expr = .neg(.var("inf"))

/// A coordinate of the space a reduction runs over, with its natural range.
private struct Coord: Equatable {
  var name: String
  var lo: Expr
  var hi: Expr
  var geometric: Bool
}

private func isInf(_ e: Expr, _ sign: Int) -> Bool {
  if sign == 1 {
    if case .var("inf") = e { return true }
    if case .num(let value) = e { return value == .infinity }
    return false
  }
  if case .neg(let a) = e { return isInf(a, 1) }
  if case .num(let value) = e { return value == -.infinity }
  return false
}

private enum ComparisonOp { case lt, gt, eq }

private struct Comparison {
  var l: Expr
  var op: ComparisonOp
  var r: Expr
  var strict: Bool
}

/// A filter's comparisons; a chain is several.
private func comparisons(_ c: Expr) throws -> [Comparison] {
  if case .eq(let l, let r) = c {
    if case .vec = l { throw LanguageError("A filter in a reduction compares numbers, not points.") }
    if case .vec = r { throw LanguageError("A filter in a reduction compares numbers, not points.") }
    return [Comparison(l: l, op: .eq, r: r, strict: false)]
  }
  guard case .ineq(let written, let l, let r, _) = c else {
    throw LanguageError("Each condition of {…} in a reduction is a comparison, like x < 1 or y = x^2.")
  }
  let op: ComparisonOp = written == .lt || written == .le ? .lt : .gt
  let strict = written == .lt || written == .gt
  if case .ineq(_, _, let middle, _) = l { return try comparisons(l) + [Comparison(l: middle, op: op, r: r, strict: strict)] }
  return [Comparison(l: l, op: op, r: r, strict: strict)]
}

/// The tightest of several bounds: folded when they are numbers, else
/// min/max calls (a slider bound stays symbolic).
private func tightest(_ bounds: [Expr], _ pick: String) -> Expr {
  let finite = bounds.filter { !isInf($0, 1) && !isInf($0, -1) }
  if finite.isEmpty { return bounds[0] }
  var nums: [Double] = []
  var rest: [Expr] = []
  for b in finite { if case .num(let value) = b { nums.append(value) } else { rest.append(b) } }
  let folded = nums.isEmpty ? [] : [num(pick == "min" ? JS.min(nums) : JS.max(nums))]
  let all = folded + rest
  return all.count == 1 ? all[0] : .call(pick, all)
}

// MARK: - Symbolic: products of ranges, and graphs over a bounded range

private struct Graph {
  /// The coordinate the equation solves for, and its value.
  var solved: String
  var g: Expr
  /// The coordinates left, over which the curve is integrated.
  var others: [Coord]
  /// Arc-length density √(1 + |∇g|²) over the other geometric coordinate.
  var weight: Expr
}

/// `y = g(x)` (or `x = g(y)`) over a bounded range of the other coordinate:
/// its arc length is ∫ √(1 + g'²). Nil for any other equation.
private func graphForm(_ c: Comparison, _ coords: [Coord]) throws -> Graph? {
  let geo = coords.filter(\.geometric)
  if geo.count != 2 || geo.contains(where: { $0.name == "z" }) { return nil }
  for (lhs, rhs) in [(c.l, c.r), (c.r, c.l)] {
    guard case .var(let name) = lhs, let solved = geo.first(where: { $0.name == name }),
      !freeVars(rhs).contains(solved.name)
    else { continue }
    // The solved coordinate is the curve's own: a range on it is not a graph
    // this way round (x = y with 0 < x < 1 is still y = x over that range).
    if !isInf(solved.lo, -1) || !isInf(solved.hi, 1) { continue }
    let along = geo.first { $0 != solved }!
    // Over all of ℝ the graph may leave its domain; the quadtree handles that.
    if isInf(along.lo, -1) || isInf(along.hi, 1) { return nil }
    let slope: Expr
    do {
      slope = try diff(rhs, along.name)
    } catch {
      if error.nonSmooth { return nil }
      throw LanguageError(error.message)
    }
    let weight = Expr.call("sqrt", [add(num(1), pow(slope, num(2)))])
    return Graph(solved: solved.name, g: rhs, others: coords.filter { $0 != solved }, weight: weight)
  }
  return nil
}

/// A range's upper end, clamped so an empty range integrates to 0: nil when
/// it is empty now, `max(lo, hi)` when a slider decides.
private func clampedHi(_ c: Coord) -> Expr? {
  if case .num(let lo) = c.lo, case .num(let hi) = c.hi { return hi > lo ? c.hi : nil }
  return .call("max", [c.lo, c.hi])
}

private func product(_ es: [Expr]) -> Expr {
  var nums = 1.0
  var out: Expr?
  for e in es { if case .num(let value) = e { nums *= value } }
  out = num(nums)
  for e in es {
    if case .num = e { continue }
    if case .num(1)? = out { out = e } else { out = .bin(.mul, out!, e) }
  }
  return out!
}

/// The product of the ranges' lengths, each max(0, hi − lo): an empty range
/// (2 < x < 1, or two ranges that miss) has measure 0, never negative.
private func lengthProduct(_ coords: [Coord]) -> Expr {
  var infinite = false
  var lengths: [Expr] = []
  for c in coords {
    if case .num(let lo) = c.lo, case .num(let hi) = c.hi {
      if !(hi > lo) { return num(0) }
      lengths.append(num(hi - lo))
    } else if isInf(c.lo, -1) || isInf(c.hi, 1) {
      infinite = true
    } else {
      lengths.append(.call("max", [num(0), .bin(.sub, c.hi, c.lo)]))
    }
  }
  // A slider range may be empty (0), and 0 · ∞ is 0: read it before saying ∞.
  if infinite { return lengths.isEmpty ? num(.infinity) : .bin(.mul, product(lengths), INF) }
  return product(lengths)
}

/// Functions finite and continuous on all of ℝ: bounded on a bounded range.
private let ENTIRE_CALLS: Set<String> = ["sin", "cos", "exp", "atan", "tanh", "sinh", "cosh", "abs"]

/// Whether `e` is finite and continuous everywhere, whatever its constants'
/// values: sums, products and whole powers of those functions. Such an
/// integrand has no singularity to diverge at and no domain to leave, so its
/// integral over a bounded range can stay symbolic.
private func entire(_ e: Expr) -> Bool {
  switch e {
  case .num(let value): return value.isFinite
  case .var(let name): return name != "inf"
  case .neg(let a): return entire(a)
  case .bin(let op, let a, let b, _):
    if op == .pow {
      if case .num(let n) = b { return JS.isInteger(n) && n >= 0 && entire(a) }
      return false
    }
    if op == .div {
      if case .num(let d) = b { return d != 0 && entire(a) }
      return false
    }
    return entire(a) && entire(b)
  case .call(let name, let args):
    // √(1 + g'²), the arc-length density, is ≥ 1 wherever g' is finite.
    if name == "sqrt" && args.count == 1 {
      if case .bin(.add, .num(let one), .bin(.pow, let inner, .num(2), _), _) = args[0] {
        return one > 0 && entire(inner)
      }
      return false
    }
    return ENTIRE_CALLS.contains(name) && args.allSatisfy(entire)
  default:
    return false
  }
}

/// ∫ f diverges (∫|f| is infinite near `at`).
private struct Diverges: Error {
  var at: Double
}
/// The integral did not settle, and no divergence was found to blame.
private struct Unreliable: Error {
  var message: String
}

/// Function evaluations one integral may spend (a readout must stay fast).
private let EVAL_BUDGET = 1_500_000
/// Evaluations one 1D integral may spend before its trouble spot is examined.
private let LOCAL_EVALS = 400_000

/// How many evaluations a measurement has spent.
private final class Work {
  var evals = 0
}

/// ∫ over a box, innermost coordinate first.
private func nestedIntegral(_ f: ([Double]) -> Double, _ ranges: [(Double, Double)], _ work: Work) throws -> Double {
  var p = [Double](repeating: 0, count: ranges.count)
  func level(_ k: Int) throws -> Double {
    try integrate1D(
      { x in
        p[k] = x
        return k == 0 ? f(p) : try level(k - 1)
      }, ranges[k].0, ranges[k].1, work)
  }
  return try level(ranges.count - 1)
}

/// Gauss–Kronrod 7–15 nodes and weights on [-1, 1] (non-negative half).
private let K15_X = [
  0, 0.2077849550078985, 0.4058451513773972, 0.5860872354676911, 0.7415311855993945, 0.8648644233597691,
  0.9491079123427585, 0.9914553711208126,
]
private let K15_W = [
  0.2094821410847278, 0.2044329400752989, 0.1903505780647854, 0.1690047266392679, 0.1406532597155259,
  0.1047900103222502, 0.0630920926299786, 0.0229353220105292,
]
private let G7_W = [0.4179591836734694, 0.3818300505051189, 0.2797053914892767, 0.1294849661688697]

/// K15 on [x0, x1] of f and of |f|, with the G7 difference as error.
private func panel(_ f: (Double) throws -> Double, _ x0: Double, _ x1: Double) throws
  -> (k: Double, abs: Double, err: Double)
{
  let c = (x0 + x1) / 2
  let h = (x1 - x0) / 2
  var k15 = 0.0
  var g7 = 0.0
  var a15 = 0.0
  var ag7 = 0.0
  for i in 0..<8 {
    let fp = try f(c + h * K15_X[i])
    let fm = i == 0 ? 0 : try f(c - h * K15_X[i])
    let s = fp + fm
    let t = abs(fp) + abs(fm)
    k15 += K15_W[i] * s
    a15 += K15_W[i] * t
    if i % 2 == 0 {
      g7 += G7_W[i / 2] * s
      ag7 += G7_W[i / 2] * t
    }
  }
  // |f| has kinks where f changes sign, so its rule converges slowly; it is
  // only needed roughly (is ∫|f| finite?), so its error counts at 1e-4.
  return (k15 * h, a15 * h, JS.max([abs((k15 - g7) * h), 1e-4 * abs((a15 - ag7) * h)]))
}

private let MAX_DEPTH = 200

/// Adaptive ∫ f over [a, b] (±∞ by the rational change of variables). Where
/// the panels will not settle, the shells around that point decide: ∫|f| over
/// [s + δ/2^(k+1), s + δ/2^k] not shrinking is a divergence (Diverges);
/// anything else unsettled is Unreliable.
private func integrate1D(_ f: (Double) throws -> Double, _ a: Double, _ b: Double, _ work: Work) throws -> Double {
  if a == b { return 0 }
  if !a.isFinite || !b.isFinite {
    if a == -.infinity && b == .infinity {
      return try integrate1D(
        { u in
          let d = 1 - u * u
          return (try f(u / d) * (1 + u * u)) / (d * d)
        }, -1, 1, work)
    }
    let end = a.isFinite ? a : b
    let dir: Double = a.isFinite ? 1 : -1
    return try integrate1D(
      { u in
        let d = 1 - u
        return try f(end + (dir * u) / d) / (d * d)
      }, 0, 1, work)
  }
  func g(_ x: Double) throws -> Double {
    work.evals += 1
    if work.evals > EVAL_BUDGET { throw Unreliable(message: "it takes too many evaluations.") }
    return try f(x)
  }
  let start = work.evals
  let whole = try panel(g, a, b)
  var scale = whole.abs.isFinite ? whole.abs : 0
  var total = 0.0
  var totalAbs = 0.0
  var stuck: [(w: (Double, Double), weight: Double)] = []
  // The narrowest panel so far: where the work piles up, if it does.
  var deepest = (a, b)
  var deepestLevel = 0
  var stack: [(Double, Double, Int)] = [(a, b, 0)]
  while let top = stack.popLast() {
    let (x0, x1, depth) = top
    if work.evals - start > LOCAL_EVALS {
      if try shellsAt(g, deepest, a, b).diverges { throw Diverges(at: (deepest.0 + deepest.1) / 2) }
      throw Unreliable(message: "it does not settle (the integrand oscillates too fast, or is singular).")
    }
    let p = x0 == a && x1 == b ? whole : try panel(g, x0, x1)
    let settled = p.k.isFinite && p.abs.isFinite
    // Never ask a panel for more than rounding allows (near a singularity
    // x − s cancels, so the values themselves are noisy).
    // A panel that dominates the running total cannot set its own
    // tolerance by it (a pole would pass on its own size).
    let size = JS.max([scale, totalAbs])
    let tol =
      p.abs <= 0.5 * size
      ? JS.max([1e-9 * size * ((x1 - x0) / (b - a)), 1e-11 * size, 1e-9 * p.abs]) : 1e-9 * p.abs
    let m = (x0 + x1) / 2
    // A panel ~1000 ulps wide samples nearly the same floats at every node, so its
    // error estimate says nothing: only a singularity drives one this far.
    let floorWide = x1 - x0 <= 1e-13 * abs(m)
    if settled && p.err <= tol && !floorWide {
      total += p.k
      totalAbs += p.abs
      continue
    }
    if depth >= MAX_DEPTH || floorWide || m <= x0 || m >= x1 {
      // A panel this narrow that has not settled sits on a singularity; the
      // shells around it decide (below). Its own share counts when finite
      // (a divergence inflates the running total, so no size test here).
      if settled {
        total += p.k
        totalAbs += p.abs
      }
      stuck.append(((x0, x1), settled ? p.abs : .infinity))
      continue
    }
    if settled && scale == 0 { scale = p.abs }
    if depth + 1 > deepestLevel {
      deepestLevel = depth + 1
      deepest = (x0, x1)
    }
    stack.append((x0, m, depth + 1))
    stack.append((m, x1, depth + 1))
  }
  // A singular panel at the limit of resolution: what it holds is bounded by
  // the shells around it when they shrink geometrically, and is negligible.
  // (Many stuck panels are oscillation or noise: judge the 8 heaviest,
  // where a pole would be.)
  let heaviest = stableSorted(stuck) { $0.weight > $1.weight }.prefix(8)
  var judged: [(w: (Double, Double), diverges: Bool, tail: Double?)] = []
  for s in heaviest {
    let shells = try shellsAt(g, s.w, a, b)
    judged.append((s.w, shells.diverges, shells.tail))
  }
  let pole = judged.first { $0.diverges }
  if stuck.count > 8 && pole == nil {
    throw Unreliable(message: "it does not settle (the integrand oscillates too fast, or is singular).")
  }
  if let pole { throw Diverges(at: (pole.w.0 + pole.w.1) / 2) }
  let limit = 1e-6 * JS.max([scale, totalAbs])
  if judged.contains(where: { $0.tail == nil || $0.tail! > limit }) {
    throw Unreliable(message: "the integrand is singular near a point where the integral may diverge.")
  }
  // What cancels to rounding noise (an odd integrand) is 0.
  return abs(total) < 1e-12 * totalAbs ? 0 : total
}

/// ∫|f| near the narrow panel `w`, read from the dyadic shells around it down
/// to its width: `diverges` when they stop shrinking (a fixed size is a log
/// divergence, growth a pole); else `tail`, a bound on what the panel itself
/// holds when they shrink geometrically, or nil when they do neither.
private func shellsAt(_ f: (Double) throws -> Double, _ w: (Double, Double), _ a: Double, _ b: Double) throws
  -> (diverges: Bool, tail: Double?)
{
  let s = (w.0 + w.1) / 2
  let floor = JS.max([w.1 - w.0, abs(s) * 1e-14, 1e-300])
  var tail = 0.0
  for side in [1.0, -1.0] {
    let room = side > 0 ? b - s : s - a
    if !(room > 64 * floor) { continue }
    var delta = JS.min([room, (b - a) / 16])
    var shells: [Double] = []
    while delta / 2 > 16 * floor && shells.count < 200 {
      let lo = s + (side * delta) / 2
      let hi = s + side * delta
      let p = try panel(f, JS.min([lo, hi]), JS.max([lo, hi]))
      if !p.abs.isFinite { return (true, nil) }
      shells.append(p.abs)
      delta /= 2
    }
    let last = Array(shells.suffix(10))
    let ratios = last.dropFirst().enumerated().map { k, j in last[k] > 0 ? j / last[k] : 0 }
    if last.count >= 10 && last[0] > 0 && ratios.allSatisfy({ $0 >= 0.97 }) { return (true, nil) }
    if last.count < 7 {
      tail = .nan
      continue
    }
    let r = JS.max(Array(ratios.suffix(6)))
    tail += r <= 0.9 ? (last[last.count - 1] * r) / (1 - r) : .nan
  }
  return (false, tail.isNaN ? nil : tail)
}

/// An evaluator of `e` at points of `names`, the constants bound; NaN where
/// it has no value (lib/measure.ts `pointFn`, by its tree-walking branch: the
/// site compiles the tree for its stack machine first, which computes the
/// same numbers faster).
private func pointFn(_ e: Expr, _ names: [String], _ env: [String: Double]) -> ([Double]) -> Double {
  let bound = substVars(e, env.mapValues { num($0) })
  var scope: [String: Double] = [:]
  return { p in
    for (k, n) in names.enumerated() { scope[n] = p[k] }
    return (try? evaluate(bound, &scope)) ?? .nan
  }
}

extension Resolver {
  /// A name bound here (a function's parameter, a Σ index), so not the
  /// multiset x, u, … (`MeasureHost.bound`).
  private func boundHere(_ n: String) -> Bool { opts.params?.contains(n) == true || opts.openVars.contains(n) }

  /// The continuous multisets `whole` ranges over, in the order met.
  func continuousNames(_ whole: [Expr]) -> [String] {
    var names = NameSet()
    for e in whole {
      for n in freeVars(e) where CONTINUOUS.contains(n) && !boundHere(n) { names.insert(n) }
    }
    return names.list
  }

  /// `name` over the continuous set `conds` keep of `value` (lib/measure.ts
  /// `reduceOverSet`, from where the set is known to be continuous). `lone`:
  /// the argument was one comparison, whose kept members are the values.
  func reduceContinuous(_ name: String, conds: [Expr], value written: Expr, lone: Bool, names: [String]) throws
    -> Expr
  {
    var value = written
    if lone {
      // One coordinate: its kept members are numbers.
      if names.count != 1 {
        throw LanguageError(
          "The members of this filter are points, and \(name)(…) needs numbers — for its size, use count(…).")
      }
      value = vr(names[0])
    }
    if name == "stdev" || name == "median" || name == "hist" {
      throw LanguageError(
        "\(name) over a continuous set is not supported yet; count, total, mean, min and max are "
          + "(docs/multisets.md §5).")
    }
    var coords: [Coord] = []
    for n in CONTINUOUS where names.contains(n) {
      let geometric = GEOMETRIC.contains(n)
      coords.append(Coord(name: n, lo: geometric ? NEG_INF : num(0), hi: geometric ? INF : num(1), geometric: geometric))
    }
    let cs = try conds.flatMap(comparisons)
    return try reduceMeasure(name, cs, value, coords)
  }

  private func reduceMeasure(_ name: String, _ cs: [Comparison], _ value: Expr, _ coords: [Coord]) throws -> Expr {
    let names = coords.map(\.name)
    func mentions(_ e: Expr) -> Bool { freeVars(e).contains(where: names.contains) }
    // Comparisons of one coordinate against a constant narrow its range; they
    // are not part of the set's shape.
    var ranges: [String: (lo: [Expr], hi: [Expr])] = [:]
    for c in coords { ranges[c.name] = ([c.lo], [c.hi]) }
    var rest: [Comparison] = []
    // Points sit on a range's ends, where `<` and `≤` differ: keep those whole.
    let points = cs.filter { $0.op == .eq }.count >= coords.count
    for c in cs {
      var side: String?
      var other: String?
      if c.op != .eq, case .var(let n) = c.l, names.contains(n), !mentions(c.r) { side = n }
      if c.op != .eq, case .var(let n) = c.r, names.contains(n), !mentions(c.l) { other = n }
      if let side {
        if c.op == .lt { ranges[side]!.hi.append(c.r) } else { ranges[side]!.lo.append(c.r) }
      } else if let other {
        if c.op == .lt { ranges[other]!.lo.append(c.l) } else { ranges[other]!.hi.append(c.l) }
      }
      // Points keep their range as a condition too: its end decides one.
      if points || (side == nil && other == nil) { rest.append(c) }
    }
    let bounded = coords.map { c -> Coord in
      let r = ranges[c.name]!
      return Coord(name: c.name, lo: tightest(r.lo, "max"), hi: tightest(r.hi, "min"), geometric: c.geometric)
    }
    if rest.isEmpty { return try productReduction(name, value, bounded, nil) }
    if rest.count == 1, rest[0].op == .eq, let graph = try graphForm(rest[0], bounded) {
      return try productReduction(name, value, graph.others, graph)
    }
    // Port: lib/measure.ts `numericReduction` (the quadtree over interval
    // enclosures, marching squares, certified root counting).
    throw Unsupported("\(name)(…) over a region, an implicit curve or a set of points")
  }

  /// Numbers every free name of `es` needs beyond `coords`: sliders and
  /// constants, read now, so the value follows them by re-resolving.
  private func constantsFor(_ es: [Expr], _ coords: [String], _ what: String) throws -> [String: Double] {
    var env: [String: Double] = [:]
    for e in es {
      for n in freeVars(e) {
        if coords.contains(n) || n == "inf" || env[n] != nil { continue }
        // A function's parameter (or a Σ index, an ∫ variable) has no value
        // here, only a name — whatever a slider of that name holds.
        if boundHere(n) {
          throw LanguageError(
            "\(what) cannot follow \(n): it is measured once, where it is written, not for each value of \(n).")
        }
        guard let v = opts.consts(n), v.isFinite else {
          throw LanguageError(
            n == "t"
              ? "\(what) cannot follow t: it is measured once, not every frame."
              : "\(what) needs \(n) to be a number defined above this row.")
        }
        env[n] = v
      }
    }
    return env
  }

  /// count/total/mean/min/max over a product of ranges — with, for a graph,
  /// the solved coordinate substituted and arc length as the density.
  private func productReduction(_ name: String, _ value: Expr, _ coords: [Coord], _ graph: Graph?) throws -> Expr {
    let infinite = coords.filter { isInf($0.lo, -1) || isInf($0.hi, 1) }
    func at(_ e: Expr) -> Expr { graph.map { substVars(e, [$0.solved: $0.g]) } ?? e }
    if name == "min" || name == "max" { return try extremum(name, at(value), coords) }
    let weight = graph?.weight
    // Finite ranges first; at most one infinite range, integrated last.
    let order = coords.filter { !infinite.contains($0) } + infinite
    /// ∫ body over the set; `positive` bodies (a measure) diverge to ∞.
    func integrate(_ body: Expr, _ what: String, _ positive: Bool) throws -> Expr {
      if infinite.count > 1 {
        if positive { return num(.infinity) }
        throw LanguageError(
          "\(what) over an unbounded plane is not supported: restrict it, like total({x^2 + y^2 < 1: …}).")
      }
      let f = weight.map { mul(body, $0) } ?? body
      // An integrand bounded on every bounded range, over bounded ranges: its
      // closed form holds for every slider value, so the row stays symbolic
      // (an empty range clamps to 0 rather than reversing the sign).
      if infinite.isEmpty && entire(f) && (graph == nil || entire(graph!.g)) {
        var out: Expr? = f
        for c in order {
          guard let hi = clampedHi(c) else { return num(0) }
          out = try integral(out!, c.name, c.lo, hi, exactOnly: true)
          if out == nil { break }
        }
        if let out { return out }
      }
      return try numericIntegral(f, order, graph, what, positive)
    }
    func componentwise(_ f: (Expr) throws -> Expr) throws -> Expr {
      if case .vec(let items) = value { return .vec(try items.map(f)) }
      return try f(value)
    }
    func measure() throws -> Expr { weight != nil ? try integrate(num(1), "count", true) : lengthProduct(coords) }
    if name == "count" { return try measure() }
    if name == "total" { return try componentwise { try integrate(at($0), "total", false) } }
    // mean
    let m = try measure()
    if case .num(let size) = m {
      if size == .infinity {
        throw LanguageError(
          "mean over a set of infinite measure has no value: restrict it, like mean({0 < x < 1: …}).")
      }
      if size == 0 { throw LanguageError("mean over an empty set has no value.") }
    }
    return try componentwise { .bin(.div, try integrate(at($0), "mean", false), m) }
  }

  /// ∫ f over a product of ranges at the constants' current values, by
  /// adaptive quadrature that finds its own singularities: a divergent
  /// integral (∫₀¹ dx/x, or an arc of infinite length) is ∞ for a measure and
  /// an error for a total, never the finite number a fixed rule would print.
  /// A closed form that agrees is kept, so exact values still read exactly.
  /// On a graph, where g is undefined the curve is not there.
  private func numericIntegral(_ f: Expr, _ order: [Coord], _ graph: Graph?, _ what: String, _ positive: Bool) throws
    -> Expr
  {
    let names = order.map(\.name)
    let bounds = order.flatMap { [$0.lo, $0.hi] }
    let env = try constantsFor([f] + (graph.map { [$0.g] } ?? []) + bounds, names, what)
    func range(_ e: Expr) throws -> Double { isInf(e, 1) ? .infinity : isInf(e, -1) ? -.infinity : try evaluate(e, env) }
    let ranges = try order.map { (try range($0.lo), try range($0.hi)) }
    if ranges.contains(where: { !($0.1 > $0.0) }) { return num(0) }
    let fn = pointFn(f, names, env)
    let domain = graph.flatMap { entire($0.g) ? nil : pointFn($0.g, names, env) }
    let integrand: ([Double]) -> Double = domain.map { d in { p in d(p).isFinite ? fn(p) : 0 } } ?? fn
    let value: Double
    do {
      value = try nestedIntegral(integrand, ranges, Work())
    } catch is Diverges {
      if positive { return num(.infinity) }
      throw LanguageError("\(what) diverges: the integral of |f| over that set is infinite.")
    } catch let error as Unreliable {
      throw LanguageError("\(what) could not be computed reliably: \(error.message)")
    }
    if !value.isFinite { throw LanguageError("\(what) has no value: the expression is undefined over the set.") }
    // A closed form reads exactly; keep it when it agrees.
    var exact: Expr? = f
    for c in order {
      if let current = exact { exact = try integral(current, c.name, c.lo, c.hi, exactOnly: true) }
    }
    if let exact, let got = try? evaluate(exact, env), abs(got - value) <= 1e-8 * (1 + abs(value)) { return exact }
    return num(value)
  }

  /// min or max over a bounded product of ranges: a dense grid, then a local
  /// refinement around the best point.
  private func extremum(_ name: String, _ value: Expr, _ coords: [Coord]) throws -> Expr {
    let what = "\(name) over a continuous set"
    if case .vec = value { throw LanguageError("\(name) compares numbers; that set holds points.") }
    if coords.count > 2 { throw LanguageError("\(what) takes at most two continuous variables.") }
    if coords.contains(where: { isInf($0.lo, -1) || isInf($0.hi, 1) }) {
      throw LanguageError("\(what) needs a bounded set: restrict it, like \(name)({0 < x < 1: …}).")
    }
    let names = coords.map(\.name)
    let env = try constantsFor([value] + coords.flatMap { [$0.lo, $0.hi] }, names, what)
    let lo = try coords.map { try evaluate($0.lo, env) }
    let hi = try coords.map { try evaluate($0.hi, env) }
    if zip(lo, hi).contains(where: { !($1 >= $0) }) { throw LanguageError("\(name) over an empty set has no value.") }
    let f = pointFn(value, names, env)
    let sign: Double = name == "min" ? 1 : -1
    let n = coords.count == 1 ? 4096 : 256
    var best = Double.infinity
    var at: [Double] = []
    func visit(_ p: [Double]) {
      let y = sign * f(p)
      if y < best {
        best = y
        at = p
      }
    }
    func grid(_ k: Int, _ i: Int) -> Double { lo[k] + ((hi[k] - lo[k]) * Double(i)) / Double(n) }
    if coords.count == 1 {
      for i in 0...n { visit([grid(0, i)]) }
    } else if coords.count == 2 {
      for i in 0...n {
        for j in 0...n { visit([grid(0, i), grid(1, j)]) }
      }
    } else {
      // (No coordinate: the value itself.)
      visit([])
    }
    if !best.isFinite { throw LanguageError("\(name) has no value: the expression is undefined over the set.") }
    // Pattern search: shrink a step around the best grid point.
    var step = coords.indices.map { (hi[$0] - lo[$0]) / Double(n) }
    var it = 0
    while it < 200 && step.contains(where: { $0 > 1e-13 }) {
      var moved = false
      for k in coords.indices {
        for dir in [-1.0, 1.0] {
          var p = at
          p[k] = JS.min([hi[k], JS.max([lo[k], p[k] + dir * step[k]])])
          let before = best
          visit(p)
          if best < before { moved = true }
        }
      }
      if !moved { step = step.map { $0 / 2 } }
      it += 1
    }
    return num(sign * best)
  }
}
