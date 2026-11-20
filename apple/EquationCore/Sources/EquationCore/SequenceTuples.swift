/// Tuple-valued recurrences, and the tuples a step reads (lib/seq.ts
/// `runTuple`, `tupleTerm`, `tupleRun`; lib/defs.ts `stackCall`).
///
/// - `s_{n+1} = push(s_n, n)` with `s_0 = ()`, a step that pops, or one whose
///   value is a tuple (`p_{n+1} = (…, …)`) is tuple-valued: its terms are
///   computed as numbers from its seed on, once, and drawn as the rows of a
///   lattice (a stack over time) or, from a point, as the points of its orbit.
/// - `push(s, a, …)`, `pop(s)` and `top(s)` read a tuple as a stack.

/// A tuple read as a stack (`STACK_FNS`).
let stackFns: Set<String> = ["push", "pop", "top"]

/// The longest tuple a tuple-valued recurrence's term may be (`TUPLE_MAX`).
private let TUPLE_MAX = 10000

/// A tuple-valued recurrence's terms, computed as numbers from its seed on
/// (`TupleRun`). `point` is its seed's dimension when the seed is a point,
/// (0.5, 0) or (1, 2, 3).
struct TupleRun {
  var terms: [[Double]]
  /// Every name its steps and seed read: the constants it depends on.
  var reads: NameSet
  var point: Int?
}

/// A value inside a tuple-valued recurrence's step: one number, or a tuple.
enum TupleValue {
  case one(Double)
  case tuple([Double])

  var values: [Double] {
    switch self {
    case .one(let v): [v]
    case .tuple(let vs): vs
    }
  }
}

/// A run stopped by its own rules rather than broken: off the end of its
/// input or its stack, or at a step with no case that holds (`HALTS`).
func haltsRun(_ error: Error) -> Bool {
  guard let error = error as? LanguageError else { return false }
  let message = error.message.lowercased()
  return message.contains("out of range") || message.contains("no case")
}

/// A lowered list with one tuple axis written into a tree, `[seq]`: the items
/// of a tuple the TypeScript holds as a list with its axes.
private func tupleItems(_ e: Expr) -> [Expr]? {
  guard let low = settledList(e), isTuple(low), case .list(let items) = low.e else { return nil }
  return items
}

/// The numbers of a tuple written out: a tuple of numbers, the empty tuple,
/// or one number (a 1-tuple is its element). Nil for anything else
/// (`literalTuple`).
func literalTuple(_ e: Expr) -> [Double]? {
  if case .num(let v) = e { return [v] }
  var items: [Expr]
  if case .vec(let written) = e {
    items = written
  } else if let held = tupleItems(e) {
    items = held
  } else {
    return nil
  }
  var out: [Double] = []
  for item in items {
    guard case .num(let v) = item else { return nil }
    out.append(v)
  }
  return out
}

/// A tuple as an expression, as the document writes one: one number is a
/// number, two or three a point, any other length a tuple (`tupleExpr`).
func tupleExpr(_ values: [Double]) -> Expr {
  if values.count == 1 { return .num(values[0]) }
  let items = values.map { Expr.num($0) }
  return values.count == 2 || values.count == 3
    ? .vec(items) : settledNode(Low(.list(items), [tupleAxis(values.count)]))
}

/// push(s, a, …), pop(s), top(s) on a tuple of numbers, computed now; nil
/// while s is not one yet (a parameter, or a step of a tuple-valued
/// recurrence). Off the end of a stack is out of range, the way a run off the
/// end of its input is (`stackCall`).
func stackCall(_ name: String, _ args: [Expr]) throws -> Expr? {
  if args.isEmpty {
    throw LanguageError("\(name) takes a tuple: \(name == "push" ? "push(s, a)" : "\(name)(s)").")
  }
  let s = literalTuple(args[0])
  if name != "push", args.count != 1 { throw LanguageError("\(name) takes one tuple: \(name)(s).") }
  if name == "push" {
    let rest = args.dropFirst().map(literalTuple)
    guard let s, !rest.contains(where: { $0 == nil }) else { return nil }
    return tupleExpr(s + rest.flatMap { $0! })
  }
  // The empty tuple's top is not an error yet: the case that reads it may
  // not be the one that holds.
  guard let s, !s.isEmpty else { return nil }
  return name == "top" ? .num(s[s.count - 1]) : tupleExpr(Array(s.dropLast()))
}

/// Whether `e` is built from tuples: a tuple, push or pop (`tupleish`).
private func tupleish(_ e: Expr) -> Bool {
  if case .vec = e { return true }
  if tupleItems(e) != nil { return true }
  if case .call(let name, _) = e, stackFns.contains(name) { return true }
  return childrenOf(e).contains(where: tupleish)
}

/// Whether `e` still holds a stack call: one on a tuple not known yet when
/// it resolved, or on the empty tuple in a case that may not hold (`stackCalls`).
func stackCalls(_ e: Expr) -> Bool {
  if case .call(let name, _) = e, stackFns.contains(name) { return true }
  return childrenOf(e).contains(where: stackCalls)
}

/// Rounding one equation allows (lib/expr.ts `sameNumber`).
private func sameNumber(_ a: Double, _ b: Double) -> Bool {
  a == b || (a.isFinite && b.isFinite && abs(a - b) <= 8 * Double.ulpOfOne * JS.max([1, abs(a), abs(b)]))
}

/// A tuple-valued recurrence's step, resolved at one n, run to its value
/// (`runTuple`). Tuples are numbers here, so a case may hold tuples of
/// different lengths and only the case that holds is run (a stack that
/// grows on one symbol and shrinks on another). What no tuple touches goes
/// to `leaf`, one number.
func runTuple(_ e: Expr, _ leaf: (Expr) throws -> TupleValue) throws -> TupleValue {
  // Terms already computed arrive as numbers: read them as they are.
  if case .num(let v) = e { return .one(v) }
  if !tupleish(e) { return try leaf(e) }
  func one(_ x: Expr) throws -> Double {
    guard case .one(let v) = try runTuple(x, leaf) else {
      throw LanguageError("A tuple is not one number: read one element of it, like top(s) or s[1].")
    }
    return v
  }
  func tuple(_ x: Expr) throws -> [Double] { try runTuple(x, leaf).values }
  func holds(_ cond: Expr) throws -> Bool {
    if case .eq(let l, let r) = cond { return sameNumber(try one(l), try one(r)) }
    if case .ineq = cond {
      return try ineqComparisons(cond).allSatisfy { c in
        let (a, b) = (try one(c.l), try one(c.r))
        switch c.op {
        case .lt: return a < b
        case .le: return a <= b
        case .gt: return a > b
        case .ge: return a >= b
        }
      }
    }
    if case .one(1) = try leaf(.piecewise([.init(cond: cond, value: .num(1))], otherwise: .num(0))) { return true }
    return false
  }
  func number(_ op: BinOp, _ x: Double, _ y: Double) throws -> Double {
    try evaluate(.bin(op, .num(x), .num(y)), [:])
  }
  if let items = tupleItems(e) { return .tuple(try items.map(one)) }
  switch e {
  case .vec(let items), .list(let items):
    return .tuple(try items.map(one))
  case .piecewise(let cases, let otherwise):
    for c in cases where try holds(c.cond) { return try runTuple(c.value, leaf) }
    if let otherwise { return try runTuple(otherwise, leaf) }
    throw LanguageError("No case of the step holds.")
  case .call(let name, let args):
    if name == "push" {
      if args.isEmpty { throw LanguageError("push takes a tuple and what to push onto it: push(s, a).") }
      return .tuple(try tuple(args[0]) + args.dropFirst().flatMap(tuple))
    }
    if name == "pop" || name == "top" || name == "count" {
      if args.count != 1 { throw LanguageError("\(name) takes one tuple: \(name)(s).") }
      let s = try tuple(args[0])
      if name == "count" { return .one(Double(s.count)) }
      if s.isEmpty { throw LanguageError("\(name)(…) of the empty tuple is out of range.") }
      return name == "top" ? .one(s[s.count - 1]) : .tuple(Array(s.dropLast()))
    }
    return .one(try evaluate(.call(name, try args.map { .num(try one($0)) }), [:]))
  case .index(let target, let at):
    let s = try tuple(target)
    let k = try one(at)
    if !JS.isInteger(k) || k < 1 || k > Double(s.count) {
      throw LanguageError(
        "Position \(JS.string(k)) is out of range: the tuple has \(s.count) element\(s.count == 1 ? "" : "s").")
    }
    return .one(s[Int(k) - 1])
  case .neg(let a):
    switch try runTuple(a, leaf) {
    case .one(let v): return .one(-v)
    case .tuple(let vs): return .tuple(vs.map { -$0 })
    }
  case .bin(let op, let lhs, let rhs, _):
    let a = try runTuple(lhs, leaf)
    let b = try runTuple(rhs, leaf)
    switch (a, b) {
    case (.one(let x), .one(let y)):
      return .one(try number(op, x, y))
    case (.tuple(let xs), .tuple(let ys)):
      if (op != .add && op != .sub) || xs.count != ys.count {
        throw LanguageError(
          "Tuples add and subtract position by position, and only when they are the same length.")
      }
      return .tuple(try zip(xs, ys).map { try number(op, $0, $1) })
    // A number with a tuple applies to each element: 2 s, s/2, 1 + p.
    case (.one(let x), .tuple(let ys)):
      return .tuple(try ys.map { try number(op, x, $0) })
    case (.tuple(let xs), .one(let y)):
      return .tuple(try xs.map { try number(op, $0, y) })
    }
  default:
    throw LanguageError("A tuple cannot be read here: \(e.kind).")
  }
}

extension Resolver {
  /// `s_3[2]`: position 2 of a tuple-valued recurrence's term, or nil for any
  /// other index (lib/defs.ts `rx`, case 'index'). Only a subscripted name
  /// can be a term: D[n + 1] asks no more.
  func tupleTermElement(_ name: String, _ index: Expr) throws -> Expr? {
    // `^[^_]+_[^_]`: a name with a subscript.
    let u = Array(name.utf16)
    guard let bar = u.firstIndex(of: unit("_")), bar > 0, bar + 1 < u.count, u[bar + 1] != unit("_"),
      let whole = try opts.sequenceTerm?(name, nil, opts.openVars), let tuple = literalTuple(whole)
    else { return nil }
    let at = try resolve(index)
    if case .range = at { return nil }
    if listLiteral(at) != nil { return nil }
    var env: [String: Double] = [:]
    for v in freeVars(at) {
      guard let x = opts.consts(v) else { return nil }
      env[v] = x
    }
    for v in freeVars(at) { opts.boundConsts?.names.insert(v) }
    let k = try evaluate(at, env)
    if !JS.isInteger(k) || k < 1 || k > Double(tuple.count) {
      throw LanguageError(
        "\(name)[\(JS.string(k))] is out of range: \(name) has \(tuple.count) element\(tuple.count == 1 ? "" : "s").")
    }
    return .num(tuple[Int(k) - 1])
  }

  /// A tuple-valued recurrence's term counts its elements, the empty tuple
  /// among them, which no list or point can be (lib/defs.ts `rx`, count).
  func tupleTermCount(_ arg: Expr) throws -> Expr? {
    var term: Expr?
    if case .var(let name) = arg {
      term = try opts.sequenceTerm?(name, nil, opts.openVars)
    } else if case .index(.var(let name), let at) = arg {
      term = try opts.sequenceTerm?(name, at, opts.openVars)
    }
    return term.flatMap(literalTuple).map { .num(Double($0.count)) }
  }
}

extension SequenceResolver {
  /// One number a tuple-valued step reads, with every name a constant
  /// (`tupleLeaf`). `reads` notes every name it reads.
  func tupleLeaf(_ name: String, noting reads: Bool) -> (Expr) throws -> TupleValue {
    { [unowned self] e in
      guard let getList = opts.getList else { throw Unsupported("lists") }
      let value = try lowerLists(exactCases(e), getList, opts)
      var env: [String: Double] = [:]
      for v in freeVars(value.e) {
        if reads { runs[name]?.reads.insert(v) }
        if v == "t" {
          throw LanguageError("\(name)'s step reads a tuple, so it runs once, not over time: it cannot read t.")
        }
        guard let x = opts.consts(v) else {
          throw LanguageError("Sequence \(name) terms need constant parameters (found \(v)).")
        }
        env[v] = x
      }
      // A tuple the document names (D, sort(L)) is a tuple here too.
      if value.isList || value.isData {
        if !isTuple(value) { throw LanguageError("Each element of \(name)'s terms must be one number, not a list.") }
        if case .data(let values) = value.e { return .tuple(values) }
        guard case .list(let items) = value.e else { return .tuple([]) }
        return .tuple(try items.map { try evaluate($0, env) })
      }
      return .one(try evaluate(value.e, env))
    }
  }

  /// The tuple a tuple-valued recurrence starts from: its seed `s_0`, or the
  /// empty tuple (`tupleSeed`).
  private func tupleSeed(_ name: String) throws -> [Double] {
    let seed = "\(name)_0"
    let scan = sequences[name]!
    if scan.emptySeed { return [] }
    let leaf = tupleLeaf(name, noting: true)
    if let dim = pointDim(seed) { return try pointComps(seed, dim).flatMap { try leaf(.var($0)).values } }
    if hasList(seed) || hasConst(seed) { return try leaf(.var(seed)).values }
    if protectedNames.contains(seed) { throw LanguageError("\(seed) has an error in its definition.") }
    return []
  }

  /// Term k of tuple-valued recurrence `name`, as numbers: nil past where its
  /// run stops when `partial`, else that stop's error (`tupleTerm`).
  func tupleTerm(_ name: String, _ k: Int, partial: Bool = false) throws -> [Double]? {
    if runs[name] == nil { runs[name] = Run() }
    if k < runs[name]!.terms.count { return runs[name]!.terms[k] }
    if let end = runs[name]!.end {
      if partial { return nil }
      throw end
    }
    if computing.contains(name) {
      throw LanguageError("Sequence \(name) depends on itself outside its recurrence.")
    }
    computing.insert(name)
    defer { computing.remove(name) }
    let scan = sequences[name]!
    let leaf = tupleLeaf(name, noting: true)
    // Parsed once: only n changes from step to step.
    let step = try parse(scan)
    while runs[name]!.terms.count <= k {
      let i = runs[name]!.terms.count
      let next: [Double]
      do {
        if i == 0 {
          next = try tupleSeed(name)
        } else {
          // The step at n = i − 1: its own s_n is the term just computed,
          // read (like any term at a number) through term().
          let at = substIdx(step, scan.index, .num(Double(i - 1)))
          next = try runTuple(try resolveSeq(at), leaf).values
        }
        if next.count > TUPLE_MAX { throw LanguageError("\(name)_\(i) is longer than \(TUPLE_MAX) elements.") }
      } catch let error as LanguageError where haltsRun(error) {
        let why =
          error.message.hasPrefix("No case")
          ? LanguageError(
            "No case of \(name)'s step holds at \(scan.index) = \(i - 1), so its run stops at \(name)_\(i - 1).")
          : error
        runs[name]!.end = why
        if partial { return nil }
        throw why
      }
      runs[name]!.terms.append(next)
    }
    return runs[name]!.terms[k]
  }

  /// A tuple-valued recurrence's terms, as far as its run goes (`tupleRun`).
  func tupleRun(_ name: String) throws -> TupleRun? {
    if !isTupleSeq(name) { return nil }
    _ = try tupleTerm(name, seqMax, partial: true)
    let dim = pointDim("\(name)_0")
    let run = runs[name]!
    return TupleRun(terms: run.terms, reads: run.reads, point: dim == 2 || dim == 3 ? dim : nil)
  }
}

/// A tuple-valued recurrence's row (`classifyTupleRun`): its terms, one per
/// row of a lattice (row n, position h across, from 1), as a stack is drawn
/// over time — or, when it starts from a point and every term is one, the
/// points of its orbit.
func classifyTupleRun(_ scan: SeqScan, _ run: TupleRun, constNames: Set<String>) -> Classified {
  // The run is computed once, at these values: a slider recomputes it. They
  // are what its steps read, through functions and tuples too.
  let params = jsSorted(run.reads.list.filter(constNames.contains))
  if let point = run.point, !run.terms.isEmpty, run.terms.allSatisfy({ $0.count == point }) {
    let coordinates = (0..<point).map { c in run.terms.map { $0[c] } }
    return Classified(
      object: .list(.scatter(dimension: point, coordinates: coordinates)), animated: false, needs3D: point == 3,
      params: params)
  }
  let across = scan.index == "h" ? "k" : "h"
  return Classified(
    object: .lattice(expr: .num(.nan), axes: [across, scan.index], rows: run.terms), animated: false,
    needs3D: false, params: params)
}
