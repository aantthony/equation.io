/// Orbits: `p(50..400)` draws where the state p goes between t = 50 and
/// t = 400, integrated ahead of time from p(0) with the same fixed RK4 step
/// the live simulation takes (States.swift), so a moving p runs along its own
/// orbit. A scalar state draws against time instead: `th(0..20)` is the curve
/// (t, th(t)) (lib/orbit.ts, and lib/analysis.ts `classifyOrbit`).
///
/// Only the states the drawn value reaches are integrated, through their
/// derivatives.
///
/// The site compiles the derivatives for its VM (lib/vm.ts) and integrates in
/// a worker; here they run through the tree-walking evaluator, which is the
/// same arithmetic and slower. A caller draws an orbit once per analysis, not
/// per frame: nothing it reads moves.

/// State-steps one orbit may integrate (a step of every needed state).
let orbitWorkMax = 24_000_000.0
/// Vertices one orbit row may draw, over all its paths.
let orbitVertices = 200_000.0

/// `value(from..to)`: the orbit of a state (or anything drawn from states) (`classifyOrbit`).
func classifyOrbit(
  _ value: Expr, from: Expr, to: Expr, _ defs: BuiltDefs, constNames: Set<String>
) throws -> Classified {
  var moving = animatedConstNames(defs).union(defs.states.keys)
  moving.insert("t")
  for bound in [from, to] {
    switch bound {
    case .vec, .list: throw LanguageError("An orbit runs between two times, like p(0..50).")
    default: break
    }
    if let v = freeVars(bound).list.first(where: { moving.contains($0) || !constNames.contains($0) }) {
      throw LanguageError("An orbit's time range must hold still (found \(v)).")
    }
  }
  // One path per run when the value is a family's list.
  let items: [Expr] = if case .list(let members) = value { members } else { [value] }
  let series = items.allSatisfy { if case .vec = $0 { false } else { true } }
  var paths: [[Expr]] = []
  for item in items {
    switch item {
    case .vec(let coordinates):
      if series || (coordinates.count != 2 && coordinates.count != 3) {
        throw LanguageError("An orbit draws a 2D or 3D point, or one number against t.")
      }
      paths.append(coordinates)
    case .eq, .ineq, .data, .list:
      throw LanguageError("An orbit draws a state, like p(0..50).")
    default:
      // (A number among points is a path of one coordinate, which the count below refuses.)
      paths.append([item])
    }
  }
  if !series, Set(paths.map(\.count)).count > 1 {
    throw LanguageError("All points in an orbit need the same number of coordinates.")
  }
  var params: Set<String> = []
  for e in paths.flatMap({ $0 }) + [from, to] {
    for n in freeVars(e) where n != "t" {
      if !constNames.contains(n) { throw LanguageError("An orbit draws states, constants and t (found \(n)).") }
      params.insert(n)
    }
  }
  return Classified(
    object: .orbit(paths: paths, series: series, from: from, to: to), animated: false,
    needs3D: !series && paths.first?.count == 3,
    params: jsSorted(Array(params)))
}

/// What an orbit integrates (`OrbitInput`).
struct OrbitInput {
  /// The scalar states integrated, their derivatives and starting values.
  var names: [String]
  var derivs: [Expr]
  var initial: [Double]
  /// Drawn per path: coordinates in states, constants and t — or, for a
  /// time series, the single value plotted against t.
  var paths: [[Expr]]
  var series: Bool
  var from: Double
  var to: Double
  /// Values of the constants that hold still over the orbit.
  var env: [String: Double]
}

private func six(_ v: Double) -> String { JS.string(JS.number(JS.toPrecision(v, 6))) }

/// The system behind drawing `paths`: every state they reach, with constants
/// that move (read a state or t) inlined, since the orbit evaluates them at
/// its own time rather than the frame's (`orbitInput`).
func orbitInput(
  _ defs: BuiltDefs, paths: [[Expr]], series: Bool, from: Double, to: Double, env: [String: Double]
) throws -> OrbitInput {
  if !(from.isFinite && to.isFinite) { throw LanguageError("An orbit needs a finite time range.") }
  if from < 0 {
    throw LanguageError("An orbit starts at t = 0 or later: the states begin at their (0) values.")
  }
  if !(to > from) {
    throw LanguageError("An orbit runs forward in time: write the earlier time first, like p(0..50).")
  }
  var moving: [String: Expr] = [:]
  var changed = true
  while changed {
    changed = false
    for (n, e) in defs.consts.entries where moving[n] == nil {
      if freeVars(e).contains(where: { $0 == "t" || defs.states.has($0) || moving[$0] != nil }) {
        moving[n] = e
        changed = true
      }
    }
  }
  func inline(_ e: Expr) throws -> Expr {
    var e = e
    for _ in 0...moving.count {
      var hit: [String: Expr] = [:]
      for v in freeVars(e) {
        if let m = moving[v] { hit[v] = m }
      }
      if hit.isEmpty { return e }
      e = substVars(e, hit)
    }
    throw LanguageError("An orbit cannot read a constant defined in terms of itself.")
  }
  let drawn = try paths.map { try $0.map(inline) }
  var names: [String] = []
  var derivs: [Expr] = []
  var seen: Set<String> = []
  func visit(_ e: Expr) throws {
    for v in freeVars(e) {
      guard let state = defs.states[v], !seen.contains(v) else { continue }
      seen.insert(v)
      let deriv = try inline(state.deriv)
      names.append(v)
      derivs.append(deriv)
      try visit(deriv)
    }
  }
  for p in drawn {
    for c in p { try visit(c) }
  }
  let initial = names.map { n -> Double in
    guard let v = try? evaluate(defs.states[n]!.initial, env), v.isFinite else { return 0 }
    return v
  }
  let steps = (to / StateSystem.step).rounded(.up)
  if steps * Double(max(1, names.count)) > orbitWorkMax {
    throw LanguageError(
      paths.count > 1
        ? "That is too much to integrate for \(paths.count) runs — draw one run's orbit, like "
          + "p[1](\(six(from))..\(six(to))) with the runs started from a tuple, or a shorter time range."
        : "That orbit is too long to integrate — try a shorter time range.")
  }
  var fixed: [String: Double] = [:]
  for e in drawn.flatMap({ $0 }) + derivs {
    for v in freeVars(e) where v != "t" && !seen.contains(v) {
      if let value = env[v] { fixed[v] = value }
    }
  }
  return OrbitInput(
    names: names, derivs: derivs, initial: initial, paths: drawn, series: series, from: from, to: to, env: fixed)
}

/// Integrate an orbit and sample it: the points of every path in turn, flat
/// (x0, y0, x1, y1, …), each path ended by a NaN point. Integration stops
/// early, as the live simulation does, at the first step that leaves the
/// finite numbers (`traceOrbit`).
func traceOrbit(_ input: OrbitInput) throws -> [Double] {
  let n = input.names.count
  var env = input.env
  for e in input.derivs + input.paths.flatMap({ $0 }) {
    if let v = freeVars(e).list.first(where: { $0 != "t" && env[$0] == nil && !input.names.contains($0) }) {
      throw LanguageError("\(v) has no value an orbit can use.")
    }
  }
  var y = input.initial
  var tmp = [Double](repeating: 0, count: n)
  var k = [[Double]](repeating: tmp, count: 4)
  func deriv(_ time: Double, _ at: [Double], _ out: inout [Double]) -> Bool {
    for i in 0..<n { env[input.names[i]] = at[i] }
    env["t"] = time
    for i in 0..<n {
      guard let v = try? evaluate(input.derivs[i], env), v.isFinite else { return false }
      out[i] = v
    }
    return true
  }
  func stage(_ time: Double, _ scale: Double, _ from: [Double], _ out: inout [Double]) -> Bool {
    for i in 0..<n { tmp[i] = y[i] + scale * from[i] }
    return deriv(time, tmp, &out)
  }

  let h = StateSystem.step
  let steps = Int((input.to / h - 1e-9).rounded(.up))
  let first = max(0, Int((input.from / h + 1e-9).rounded(.down)))
  let stride = max(1, Int((Double(steps - first + 1) * Double(input.paths.count) / orbitVertices).rounded(.up)))
  var out = [[Double]](repeating: [], count: input.paths.count)
  func sample(_ time: Double) {
    for i in 0..<n { env[input.names[i]] = y[i] }
    env["t"] = time
    for (j, p) in input.paths.enumerated() {
      let coords = p.map { (try? evaluate($0, env)) ?? .nan }
      out[j] += input.series ? [time, coords[0]] : coords
    }
  }
  var s = 0
  while true {
    let time = Double(s) * h
    if s >= first && ((s - first) % stride == 0 || s == steps) { sample(time) }
    if s >= steps { break }
    if !deriv(time, y, &k[0]) { break }
    if !stage(time + h / 2, h / 2, k[0], &k[1]) { break }
    if !stage(time + h / 2, h / 2, k[1], &k[2]) { break }
    if !stage(time + h, h, k[2], &k[3]) { break }
    var ok = true
    for i in 0..<n {
      tmp[i] = y[i] + (h / 6) * (k[0][i] + 2 * k[1][i] + 2 * k[2][i] + k[3][i])
      if !tmp[i].isFinite { ok = false }
    }
    if !ok { break }
    y = tmp
    s += 1
  }
  let dim = input.series ? 2 : input.paths.first?.count ?? 2
  return out.flatMap { $0 + [Double](repeating: .nan, count: dim) }
}

extension DocumentAnalysis {
  /// The polyline of an orbit row (`p(0..50)`), in x and y: flat, each path
  /// ended by a NaN pair. Throws what the site reports on the row when the
  /// orbit cannot be integrated (a time range that runs backwards, or is too
  /// long). Nil when the row is not an orbit in the plane.
  public func orbit(row index: Int) throws -> [Double]? {
    guard rows.indices.contains(index), case .orbit(_, let paths, let series, let from, let to)? = rows[index].cpu
    else { return nil }
    let input = try orbitInput(
      defs, paths: paths, series: series, from: try evaluate(from, env), to: try evaluate(to, env), env: env)
    return try traceOrbit(input)
  }
}
