/// Complex constants and recursive functions among a document's definitions:
/// the parts of lib/defs.ts `buildDefs` that settle them.

// MARK: - Complex constants

private let positionOrParam: Set<String> = ["x", "y", "z", "w", "u", "v"]

/// A complex constant (`a = e^(iπ/3)`, `c = 2a`) has no one number to hold:
/// it is written in wherever its name is read (ResolveOpts.complex), as an
/// interval is. Written into one another they close; a chain that squares as
/// it goes grows geometrically, so its size is checked before anything walks
/// it. Then what reads one is written through — the constants, the named
/// conditions and the functions (lib/defs.ts `buildDefs`, between the points
/// and the coordinate fields).
func writeComplexConstants(_ defs: inout BuiltDefs) {
  func writeComplex(_ e: Expr) -> Expr? {
    var sub: [String: Expr] = [:]
    for v in freeVars(e) {
      if let value = defs.complexes[v] { sub[v] = value }
    }
    return sub.isEmpty ? nil : substVars(e, sub)
  }
  let large = { (name: String) in
    "\(name) is too large with its complex constants written in — reduce the nesting or the powers."
  }
  /// (`written` is nil where nothing was written in: `e` as it was.)
  func tooLarge(_ name: String, _ written: Expr?) -> Bool {
    guard let written, exceedsNodes(written, SPLIT_NODE_BUDGET) else { return false }
    defs.errors[name] = large(name)
    defs.consts[name] = nil
    return true
  }
  func overNothing(_ e: Expr) -> Bool { !freeVars(e).contains(where: positionOrParam.contains) }
  var changed = true
  while changed {
    changed = false
    for name in defs.consts.keys {
      guard let e = defs.consts[name] else { continue }
      let written = writeComplex(e)
      if tooLarge(name, written) { continue }
      let value = written ?? e
      if isComplexValued(value) && overNothing(value) {
        defs.complexes[name] = value
        defs.consts[name] = nil
        changed = true
      }
    }
  }
  // What reads one is written through: a complex field (`q = w - a`) stays
  // complex, and a real value (`b = |a|`, `re(e^(iπ/3))`) holds its real part
  // and stays a constant — a slider bound, a range.
  for name in defs.consts.keys {
    guard let e = defs.consts[name] else { continue }
    let written = writeComplex(e)
    if written == nil && !freeVars(e).contains("i") { continue }
    if tooLarge(name, written) { continue }
    let value = written ?? e
    do {
      defs.consts[name] = isComplexValued(value) ? value : try realValue(value, name)
    } catch {
      defs.errors[name] = errorMessage(error)
      defs.consts[name] = nil
    }
  }
  // A condition compares real values: `ok = |a| < 2` reads |a| through its
  // real part, and `ok = a < 2` has no order to compare.
  func realSides(_ c: Expr, _ name: String) throws -> Expr {
    if case .ineq(let op, let l, let r, let grouped) = c {
      return .ineq(op, try realSides(l, name), try realSides(r, name), grouped: grouped)
    }
    return try realValue(c, "\(name)'s comparison")
  }
  for (name, c) in defs.conditions.entries {
    guard let written = writeComplex(c) else { continue }
    do {
      if exceedsNodes(written, SPLIT_NODE_BUDGET) { throw LanguageError(large(name)) }
      defs.conditions[name] = try realSides(written, name)
    } catch {
      defs.errors[name] = errorMessage(error)
      defs.conditions[name] = nil
    }
  }
  // A function's parameter shadows one, as it does an interval.
  for (name, fn) in defs.fns.entries {
    var sub: [String: Expr] = [:]
    for v in freeVars(fn.body) where !fn.params.contains(v) {
      if let value = defs.complexes[v] { sub[v] = value }
    }
    if !sub.isEmpty { defs.fns[name] = FnDef(params: fn.params, body: substVars(fn.body, sub)) }
  }
}

// MARK: - Recursive functions

/// What a function is while its own body resolves (lib/defs.ts `getFn`): a
/// call to it becomes a RECUR marker, and the finished body wraps into a loop.
func recursiveMarker(_ params: [String]) -> FnDef {
  FnDef(params: params, body: .call(RECUR, []), recursive: true)
}

/// A body that calls its own function runs as a bounded loop, provided every
/// self-call is a whole case of the body's {…} (tail position): the call's
/// arguments are then simply the next pass's parameters. Anything else —
/// `n f(n - 1)`, a call inside a condition — would need a stack per pixel
/// (lib/defs.ts `wrapRecursion`).
func wrapRecursion(_ name: String, _ params: [String], _ body: Expr) throws -> Expr {
  let p = params.first ?? "n"
  func check(_ e: Expr, _ tail: Bool) throws {
    if recurArgs(e) != nil {
      if !tail {
        throw LanguageError(
          "\(name) can only call itself as a whole case of {…}, like "
            + "\(name)(\(p)) = {\(p) <= 1: 1, \(name)(\(p) - 1)}.")
      }
      return
    }
    if case .piecewise(let cases, let otherwise) = e, tail {
      for c in cases {
        try check(c.cond, false)
        try check(c.value, true)
      }
      if let otherwise { try check(otherwise, true) }
      return
    }
    // A loop already inlined here (a call to another recursive function)
    // owns the markers in its body; only its seeds are this function's.
    if case .loop(_, let seeds, _, _) = e {
      for seed in seeds { try check(seed, false) }
      return
    }
    for child in childrenOf(e) { try check(child, false) }
  }
  try check(body, true)
  let limit = max(LOOP_LIMIT, counterCap(params, body) ?? 0)
  return .loop(params: params, seeds: params.map { .var($0) }, body: body, limit: limit)
}

/// The passes a counted loop asks for: a param that every self-call advances
/// by one (`k + 1`) and that a case caps with a plain number (`k >= 600: …`)
/// ends by itself within that many passes from 0, so the default limit need
/// not cut it short. Capped at LOOP_LIMIT_MAX, like any pixel's work.
private func counterCap(_ params: [String], _ body: Expr) -> Int? {
  let recurs = loopLeaves(body).compactMap(recurArgs)
  var conds: [Expr] = []
  var e = body
  while case .piecewise(let cases, let otherwise) = e {
    conds += cases.map(\.cond)
    e = otherwise ?? .num(0)
  }
  var cap: Int?
  for (j, p) in params.enumerated() {
    func isP(_ e: Expr) -> Bool { e == .var(p) }
    func isOne(_ e: Expr) -> Bool { e == .num(1) }
    let advances = recurs.allSatisfy { args in
      guard j < args.count, case .bin(.add, let a, let b, _) = args[j] else { return false }
      return (isP(a) && isOne(b)) || (isOne(a) && isP(b))
    }
    if !advances || recurs.isEmpty { continue }
    for c in conds {
      guard case .ineq(let op, let l, let r, _) = c else { continue }
      var n: Double?
      if op == .ge || op == .gt, isP(l), case .num(let value) = r {
        n = value
      } else if op == .le || op == .lt, isP(r), case .num(let value) = l {
        n = value
      }
      // A counter from 0 reaches n on pass n + 1, and one pass more exits.
      if let n, n.isFinite { cap = max(cap ?? 0, Int(min(Double(LOOP_LIMIT_MAX), n.rounded(.up))) + 2) }
    }
  }
  return cap
}

/// Whether `e` calls the function being defined. Markers inside an inlined
/// loop's body belong to that loop, so only its seeds count.
func containsRecur(_ e: Expr) -> Bool {
  if recurArgs(e) != nil { return true }
  if case .loop(_, let seeds, _, _) = e { return seeds.contains(where: containsRecur) }
  return childrenOf(e).contains(where: containsRecur)
}

/// Whether an argument may turn out to be a point once it lowers (lib/defs.ts
/// `mightBePoint`), and so fill more than one parameter. (The multivector
/// calls that are points too are not ported: the resolver refuses them.)
func mightBePoint(_ e: Expr, _ comps: (String) -> [String]?) -> Bool {
  switch e {
  case .vec: return true
  case .var(let name):
    if comps(name) != nil { return true }
    // /^e_[xyz]+$/
    let u = Array(name.utf16)
    return u.count > 2 && u[0] == unit("e") && u[1] == unit("_")
      && u[2...].allSatisfy { $0 >= unit("x") && $0 <= unit("z") }
  case .bin(_, _, _, .geometric?): return true
  case .call(let name, _) where ["quat", "gp", "rev", "dual", "slerp", "grade", "vec"].contains(name): return true
  default: return childrenOf(e).contains { mightBePoint($0, comps) }
  }
}
