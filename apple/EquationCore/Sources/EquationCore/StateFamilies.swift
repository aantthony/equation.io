/// State families (lib/defs.ts `buildDefs`, "State families"):
/// `p(0) = ([0..99]/10, 0, 0)` runs the system once per starting value. Each
/// run is its own set of hidden scalar states, so the integrator is
/// unchanged, and the state's names become lists over one shared axis — `p`
/// draws as a point per run, `p[1]` is the first run. A state coupled to a
/// family (`r' = vel` with a list of r(0)) runs per member too, seeded from
/// its own single starting value.

/// Runs one state family may start: the point-figure family budget (`FAMILY_MAX`).
private let STATE_FAMILY_MAX = 1024

/// A starting value that lists numbers or points, as the members of a
/// family: one row of components per run. Nil for a single starting value.
/// `listed` lowers the lists of a starting value already lowered for points.
func stateFamilyMembers(_ name: String, _ low: Expr, _ dim: Int?, _ listed: (Expr) throws -> Low) throws
  -> (members: [[Expr]], ordered: Bool)?
{
  let lowered = try listed(low)
  guard lowered.isSeq else { return nil }
  guard case .list(let items) = lowered.e else {
    throw LanguageError("\(name)(0) must list numbers\(dim != nil ? " or points" : "").")
  }
  let members = try items.map { it -> [Expr] in
    guard let dim else {
      if case .vec = it { throw LanguageError("\(name)(0) lists points, but \(name) is a single number.") }
      return [it]
    }
    guard case .vec(let comps) = it, comps.count == dim else {
      var got = "single numbers"
      if case .vec(let comps) = it { got = "\(comps.count)-component points" }
      throw LanguageError("\(name) is a \(dim)-component state, but \(name)(0) lists \(got).")
    }
    return comps
  }
  if members.isEmpty { throw LanguageError("\(name)(0) is an empty list.") }
  if members.count > STATE_FAMILY_MAX {
    throw LanguageError("\(name)(0) starts \(members.count) runs — the limit is \(STATE_FAMILY_MAX).")
  }
  return (members, isTuple(lowered))
}

/// Gives each run of each family its hidden states, and makes the states'
/// names (and the constants and points that read them) lists over the runs.
/// `prefix` is the document's hidden-name prefix (`sequencePrefix`);
/// `lowerNamed` lowers a definition's lists against the definitions so far.
func expandStateFamilies(
  _ defs: inout BuiltDefs, _ draft: inout StateDraft, prefix: String, compOwner: inout OrderedMap<String>,
  lowerNamed: (Expr, BuiltDefs, Set<String>) throws -> Low
) {
  if draft.familyInits.keys.isEmpty { return }
  let vecOwner = draft.vecOwnerKey
  func rowOf(_ c: String) -> String { vecOwner[c] ?? c }
  let vecStates = defs.vecStates
  func compsOfState(_ owner: String) -> [String] { vecStates[owner].map { vecStateComps(owner, $0) } ?? [owner] }
  // Constants that read a state are inlined into each run's derivative:
  // `f = (…th_1…)` means a different f per run.
  var stateDependent: [String: Expr] = [:]
  var changed = true
  while changed {
    changed = false
    for (n, e) in defs.consts.entries where stateDependent[n] == nil {
      if freeVars(e).contains(where: { draft.names.contains($0) || stateDependent[$0] != nil }) {
        stateDependent[n] = e
        changed = true
      }
    }
  }
  func inline(_ e: Expr) -> Expr {
    var e = e
    for _ in 0...stateDependent.count {
      let hit = freeVars(e).filter { stateDependent[$0] != nil }
      if hit.isEmpty { return e }
      var map: [String: Expr] = [:]
      for v in hit { map[v] = stateDependent[v] }
      e = substVars(e, map)
    }
    return e  // a cycle: validation reports it on the constant
  }
  // Coupled states run together, so they share one family.
  var parent: [String: String] = [:]
  func find(_ a: String) -> String {
    let p = parent[a] ?? a
    if p == a { return a }
    let root = find(p)
    parent[a] = root
    return root
  }
  var inlined = OrderedMap<Expr>()
  for (c, d) in draft.derivs.entries { inlined[c] = inline(d) }
  for (c, d) in inlined.entries {
    for fv in freeVars(d) where draft.names.contains(fv) { parent[find(rowOf(c))] = find(rowOf(fv)) }
  }
  var roots: [String] = []
  var sizes: [String: (n: Int, from: String)] = [:]
  for (owner, members) in draft.familyInits.entries {
    let root = find(owner)
    if let seen = sizes[root] {
      if seen.n != members.count {
        defs.errors["\(owner)(0)"] =
          "\(owner)(0) starts \(members.count) runs, but \(seen.from)(0), which it moves with, starts \(seen.n)."
        draft.familyInits[owner] = nil
      }
    } else {
      sizes[root] = (members.count, owner)
      roots.append(root)
    }
  }
  var owners: [String] = []
  for c in draft.derivs.keys where !owners.contains(rowOf(c)) { owners.append(rowOf(c)) }
  for root in roots {
    let n = sizes[root]!.n
    let group = owners.filter { find($0) == root }
    let comps = group.flatMap(compsOfState).filter(draft.derivs.has)
    func hidden(_ c: String, _ k: Int) -> String { "\(prefix)_run_\(c)_\(k)" }
    let inOrder = group.allSatisfy { !draft.familyInits.has($0) || draft.orderedInits.contains($0) }
    let axes = [Axis(id: "\(root)#runs", n: n, ordered: inOrder)]
    let runs: [[String: Expr]] = (0..<n).map { k in
      var run: [String: Expr] = [:]
      for c in comps { run[c] = .var(hidden(c, k)) }
      return run
    }
    for owner in group {
      let own = compsOfState(owner)
      let members = draft.familyInits[owner]
      for (i, c) in own.enumerated() {
        let deriv = inlined[c]
        let initial = draft.inits[c] ?? .num(0)
        for k in 0..<n {
          let h = hidden(c, k)
          if let deriv { draft.derivs[h] = substVars(deriv, runs[k]) }
          draft.inits[h] = members.map { $0[k][i] } ?? initial
          draft.names.insert(h)
          draft.familyOwner[h] = owner
        }
        draft.derivs[c] = nil
        draft.inits[c] = nil
        draft.names.remove(c)
        draft.vecOwnerKey[c] = nil
        if own.count > 1 { defs.lists[c] = Low(.list(runs.map { $0[c] ?? .num(0) }), axes) }
      }
      let list: Expr =
        own.count > 1
        ? .list(runs.map { r in .vec(own.map { r[$0] ?? .num(0) }) }) : .list(runs.map { $0[owner] ?? .num(0) })
      defs.lists[owner] = Low(list, axes)
      defs.vecStates[owner] = nil
    }
  }
  // A constant reading a family is a list of values, one per run.
  for (n, e) in defs.consts.entries {
    if !freeVars(e).contains(where: defs.lists.has) { continue }
    do {
      let listed = try lowerNamed(e, defs, draft.names)
      if !listed.isSeq { continue }
      defs.consts[n] = nil
      defs.lists[n] = listed
    } catch let error as Unsupported {
      defs.unsupported[compOwner[n] ?? n] = error.what
      defs.consts[n] = nil
    } catch {
      defs.errors[compOwner[n] ?? n] = errorMessage(error)
      defs.consts[n] = nil
    }
  }
  // A point with a component per run is a list of points.
  for owner in defs.points {
    let comps = pointComps(owner, defs.pointDims[owner] ?? 2)
    let lists = comps.map { defs.lists[$0] }
    guard let first = lists.compactMap({ $0 }).first else { continue }
    var count = 0
    if case .list(let items) = first.e { count = items.count }
    let items: [Expr] = (0..<count).map { k in
      .vec(
        comps.enumerated().map { i, c in
          if case .list(let members)? = lists[i]?.e { return members[k] }
          return lists[i] != nil ? .num(.nan) : defs.consts[c] ?? .num(0)
        })
    }
    for c in comps {
      defs.consts[c] = nil
      compOwner[c] = nil
    }
    defs.points.removeAll { $0 == owner }
    defs.pointDims[owner] = nil
    defs.lists[owner] = Low(.list(items), first.axes)
  }
}

/// The prefix of the names a document cannot spell, which hold a
/// recurrence's terms and a family's runs (lib/defs.ts `sequencePrefix`).
func sequencePrefix(_ rawNames: [String]) -> String {
  var prefix = "eqioSeq"
  while rawNames.contains(where: { $0.hasPrefix(prefix + "_") }) { prefix += "X" }
  return prefix
}
