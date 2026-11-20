/// Sequences and recurrences (lib/seq.ts).
///
/// - `a_n = 1/n^2` is an explicit sequence: dots at whole n.
/// - `a_{n+1} = r a_n (1 - a_n)` (also `a_(n+1)`) is a recurrence. With no
///   other free variable it draws a cobweb diagram; with `x` free in the
///   right side, x is the parameter axis and the plot is the orbit diagram.
/// - A recurrence whose step also reads n, or another sequence at n, is no
///   single map: it draws its terms as dots, computed term by term.
/// - The seed is the constant `a_0` when defined, else 1/2.
///
/// The whole subscripted symbol (`a_n`) is one token, so these rows are
/// recognized by their text before definition scanning.
///
/// Not ported: tuple-valued recurrences (a step that pushes, pops or is a
/// tuple; `s_0 = ()`), and steps that read a list or a tuple by position
/// (`D[n + 1]`). Both need lists; their rows say they are not supported.

/// How a sequence row reads (lib/seq.ts `SeqScan`).
struct SeqScan: Equatable {
  /// True for a_{n+1} = … (recurrence); false for a_n = … (explicit term).
  var rec: Bool
  var name: String
  var index: String
  var rhs: String
  /// Set for the rows that draw on the integer lattice (Automaton.swift): an
  /// automaton's rule and seed, and a table `T[i, j] = …`. Their letter
  /// names cells, not scalar terms.
  var lattice = false
  /// A cellular automaton's rows, `c_{n+1}[i] = …` and its seed `c_0[i] = …`,
  /// and a table's: the cell index they are written in.
  var cell: String?
  /// The second cell index of a 2D automaton (`L_{n+1}[i, j]`) or a table.
  var cell2: String?
  /// The seed row `c_0[i] = …` (with `cell`; its `index` is empty).
  var seed = false
  /// A seed written as a multiset of live cells, `L_0 = [(0, 0), (1, 0)]`.
  var seedList = false
  /// A table `T[i, j] = …`: a function on the integer lattice.
  var table = false
  /// On a recurrence: its seed row is `s_0 = ()`, the empty tuple.
  var emptySeed = false
  /// The row `s_0 = ()` itself, which only a tuple-valued recurrence reads.
  var emptyTuple = false
}

/// The last term a sequence computes (`SEQ_MAX`).
let seqMax = 1000

/// A sequence letter, between optional spaces: `\s*(L)\s*`.
private func spacedLetter(_ s: inout RowScanner) -> String? {
  s.space()
  guard let c = s.peek, isNameLetter(c) else { return nil }
  s.i += 1
  s.space()
  return String(decoding: [c], as: UTF16.self)
}

/// `[i]` or `[i, j]`: the cells an automaton row is written over (`CELLS`).
private func scanCells(_ s: inout RowScanner) -> (String, String?)? {
  var k = s
  guard k.eat("["), let first = spacedLetter(&k) else { return nil }
  var second: String?
  if k.eat(",") {
    guard let next = spacedLetter(&k) else { return nil }
    second = next
  }
  guard k.eat("]") else { return nil }
  s = k
  return (first, second)
}

/// `\s*=(?!=)([\s\S]+)$`
private func scanRhs(_ at: RowScanner) -> String? {
  var s = at
  s.space()
  return s.assignment()
}

/// After a letter and `_`: the zero subscript, `0`, `{0}` or `(0)`.
private func scanZero(_ s: inout RowScanner) -> Bool {
  var k = s
  if k.eat("0") {
    s = k
    return true
  }
  let close: Unicode.Scalar
  if k.eat("{") { close = "}" } else if k.eat("(") { close = ")" } else { return false }
  k.space()
  guard k.eat("0") else { return false }
  k.space()
  guard k.eat(close) else { return false }
  s = k
  return true
}

/// Detect a sequence/recurrence row before definition scanning (lib/seq.ts
/// `scanSeqRec`: CELL_REC_RE, CELL_SEED_RE, TABLE_RE, REC_RE, SEQ_RE).
func scanSeqRec(_ text: Units) -> SeqScan? {
  var s = RowScanner(text)
  s.space()
  guard let letter = s.peek, isNameLetter(letter) else { return nil }
  s.i += 1
  let name = String(decoding: [letter], as: UTF16.self)
  // T[i, j] = …: a function on the integer lattice.
  var table = s
  table.space()
  if let (i, j) = scanCells(&table), let j, let rhs = scanRhs(table) {
    return SeqScan(rec: false, name: name, index: "", rhs: rhs, lattice: true, cell: i, cell2: j, table: true)
  }
  guard s.eat("_") else { return nil }
  // c_0[i] = …: the generation an automaton starts from.
  var zero = s
  if scanZero(&zero) {
    zero.space()
    if let (i, j) = scanCells(&zero), let rhs = scanRhs(zero) {
      return SeqScan(rec: false, name: name, index: "", rhs: rhs, lattice: true, cell: i, cell2: j, seed: true)
    }
    return nil
  }
  // a_{n+1} and a_(n+1); a_n, a_{n} and a_(n).
  var index: String
  var step = false
  var braced = s
  if braced.eat("{") || braced.eat("(") {
    let close: Unicode.Scalar = text[braced.i - 1] == unit("{") ? "}" : ")"
    guard let inner = spacedLetter(&braced) else { return nil }
    index = inner
    if braced.eat("+") {
      braced.space()
      guard braced.eat("1") else { return nil }
      braced.space()
      step = true
    }
    guard braced.eat(close) else { return nil }
    s = braced
  } else {
    guard let c = s.peek, isNameLetter(c) else { return nil }
    s.i += 1
    index = String(decoding: [c], as: UTF16.self)
  }
  if step {
    // c_{n+1}[i] = … (or L_{n+1}[i, j] = …): cells stepping from the generation before.
    var celled = s
    celled.space()
    if let (i, j) = scanCells(&celled), let rhs = scanRhs(celled) {
      return SeqScan(rec: true, name: name, index: index, rhs: rhs, lattice: true, cell: i, cell2: j)
    }
    return scanRhs(s).map { SeqScan(rec: true, name: name, index: index, rhs: $0) }
  }
  guard let rhs = scanRhs(s) else { return nil }
  // Every letter_letter row used to be a sequence, which stole the
  // subscripted constants physics and chemistry are written with (T_c, k_B,
  // v_x). Require a conventional index or one the term actually uses.
  let conventional = index == "n" || index == "k" || index == "m"
  guard conventional || (!reservedNames.contains(index) && usesIndex(Array(rhs.utf16), index)) else { return nil }
  return SeqScan(rec: false, name: name, index: index, rhs: rhs)
}

/// The letter and right side of `L_0 = …` (`L_{0}`, `L_(0)`): a seed row, if
/// its letter turns out to be an automaton's or a recurrence's.
private func scanSeedRow(_ text: Units) -> (name: String, rhs: Units)? {
  var s = RowScanner(text)
  s.space()
  guard let letter = s.peek, isNameLetter(letter) else { return nil }
  s.i += 1
  guard s.eat("_"), scanZero(&s) else { return nil }
  s.space()
  guard s.assign() else { return nil }
  s.space()
  return (String(decoding: [letter], as: UTF16.self), Array(text[s.i...]))
}

/// `s_0 = ()`: a tuple-valued recurrence starting from the empty tuple
/// (`EMPTY_SEED_RE`): the letter.
private func emptySeedLetter(_ text: Units) -> String? {
  guard let (name, rhs) = scanSeedRow(text) else { return nil }
  var s = RowScanner(rhs)
  guard s.eat("(") else { return nil }
  s.space()
  guard s.eat(")") else { return nil }
  s.space()
  return s.atEnd ? name : nil
}

/// `scanSeqRec` over a whole document (lib/seq.ts `scanSequences`). A letter
/// can be a sequence once: beside `a_n = 1/n`, a row like `a_k = 7` that
/// never uses its k is the constant a_k (as `T_c = 300` is), not a second
/// definition of a.
func scanSequences(_ texts: [String]) -> [SeqScan?] {
  let units = texts.map { Array($0.utf16) }
  let scans = units.map(scanSeqRec)
  func uses(_ s: SeqScan) -> Bool { usesIndex(Array(s.rhs.utf16), s.index) }
  let owners = Set(scans.compactMap { $0 }.filter { $0.rec || uses($0) }.map(\.name))
  // `L_0 = [(0, 0), …]` is the constant L_0 unless L is an automaton.
  let automata = Set(scans.compactMap { $0 }.filter { $0.cell != nil && $0.rec }.map(\.name))
  // `s_0 = ()` is no constant (there is no empty value to name) but the
  // empty tuple a recurrence s starts from.
  let recurrences = Set(scans.compactMap { $0 }.filter { $0.rec && !$0.lattice }.map(\.name))
  let empty = Set(units.compactMap(emptySeedLetter).filter(recurrences.contains))
  return scans.enumerated().map { k, scan in
    guard var s = scan else {
      // (`CELL_SET_RE`: the right side starts a list.)
      if let (name, rhs) = scanSeedRow(units[k]), rhs.first == unit("["), automata.contains(name) {
        return SeqScan(
          rec: false, name: name, index: "", rhs: String(decoding: rhs, as: UTF16.self), lattice: true, seed: true,
          seedList: true)
      }
      if let name = emptySeedLetter(units[k]), empty.contains(name) {
        return SeqScan(rec: false, name: name, index: "", rhs: "()", emptyTuple: true)
      }
      return nil
    }
    if s.rec && !s.lattice && empty.contains(s.name) {
      s.emptySeed = true
      return s
    }
    return !s.rec && !s.lattice && owners.contains(s.name) && !uses(s) ? nil : s
  }
}

/// The names a term reads by position (`w` in `w[n+1]`): tuples and lists,
/// which a step that reads n indexes term by term (`indexedNames`).
private func indexedNames(_ e: Expr) -> Set<String> {
  var out: Set<String> = []
  func walk(_ e: Expr) {
    if case .index(.var(let name), _) = e { out.insert(name) }
    for c in childrenOf(e) { walk(c) }
  }
  walk(e)
  return out
}

/// `[term]("…_a_", k)` at a whole k, once a step's n is a number: the chain
/// constant itself, which a constant (unlike a plotted term) can depend on.
/// `at` gives it, computing it first if the chain does not hold it yet
/// (`pinTerms`).
private func pinTerms(_ e: Expr, _ at: (String, Double) throws -> Expr) throws -> Expr {
  if case .call(TERM_AT_FN, let args) = e, args.count >= 2, case .str(let chain) = args[0], freeVars(args[1]).isEmpty {
    let k = try evaluate(args[1], [:])
    return JS.isInteger(k) && k >= 0 && k <= Double(seqMax) ? try at(chain, k) : .num(.nan)
  }
  return try mapChildren(e) { try pinTerms($0, at) }
}

/// `^(L)_(\d+)$`: a term by literal index, a_3 (`TERM_RE`).
private func termName(_ symbol: String) -> (name: String, k: Double)? {
  let u = Array(symbol.utf16)
  guard u.count >= 3, isNameLetter(u[0]), u[1] == unit("_"), u[2...].allSatisfy(isDigit) else { return nil }
  return (String(decoding: u[..<1], as: UTF16.self), JS.number(String(decoding: u[2...], as: UTF16.self)))
}

/// `^(L)_([A-Za-zGreek]\w*)$`: a term by a named index, a_k (`NAMED_RE`).
private func namedTerm(_ symbol: String) -> (name: String, index: String)? {
  let u = Array(symbol.utf16)
  guard u.count >= 3, isNameLetter(u[0]), u[1] == unit("_"), isNameLetter(u[2]),
    u[3...].allSatisfy({ isASCIILetter($0) || isDigit($0) || $0 == unit("_") })
  else { return nil }
  return (String(decoding: u[..<1], as: UTF16.self), String(decoding: u[2...], as: UTF16.self))
}

/// Sequence values (lib/seq.ts `sequenceResolver`): a term at a number, at a
/// slider, or at another row's open index. A recurrence's terms are a linear
/// chain of computed constants rather than an exponentially duplicated
/// expression; those constants become uniforms.
final class SequenceResolver {
  /// The first row defining each letter.
  let sequences: [String: SeqScan]
  let prefix: String
  var getFn: GetFn = { _ in nil }
  /// What every term resolves with. Its `consts` are read live.
  var opts = ResolveOpts()
  /// The document's functions and what parses as an index, as its rows parse.
  var fnNames: () -> Set<String> = { [] }
  var indexNames: () -> Set<String> = { [] }
  /// The constants: the names with a value each frame, the document's own
  /// names (which a term never shadows), and the definitions a chain is
  /// written into.
  var isKnown: (String) -> Bool = { _ in false }
  var addKnown: (String) -> Void = { _ in }
  var protectedNames: Set<String> = []
  var hasConst: (String) -> Bool = { _ in false }
  var defineConstant: (String, Expr) -> Void = { _, _ in }
  /// Notes a chain constant's value now, when everything it reads has one.
  var setValue: (String, Double) -> Void = { _, _ in }

  private var resolving: [String] = []
  private var tupleValued: [String: Bool] = [:]

  init(_ scans: [SeqScan], rawNames: [String]) {
    var first: [String: SeqScan] = [:]
    for scan in scans where first[scan.name] == nil { first[scan.name] = scan }
    sequences = first
    var prefix = "eqioSeq"
    while rawNames.contains(where: { $0.hasPrefix(prefix + "_") }) { prefix += "X" }
    self.prefix = prefix
  }

  /// Lets go of the document: its closures and the resolver hold each other.
  func release() {
    getFn = { _ in nil }
    opts = ResolveOpts()
    fnNames = { [] }
    indexNames = { [] }
    isKnown = { _ in false }
    addKnown = { _ in }
    hasConst = { _ in false }
    defineConstant = { _, _ in }
    setValue = { _, _ in }
  }

  private func chained(_ name: String, _ i: Int) -> String { "\(prefix)_\(name)_\(i)" }

  private func parse(_ scan: SeqScan) throws -> Expr {
    try parseExpr(scan.rhs, userFns: fnNames(), listNames: allIndexNames())
  }

  /// What parses as an index in a sequence's row: its tuples and lists
  /// (T[n+1]) and the sequences themselves (b_[n+1]).
  private func allIndexNames() -> Set<String> { indexNames().union(sequences.keys.map { $0 + "_" }) }

  /// A sequence's source resolved: at whole n, a case may test equality.
  private func resolveSeq(_ e: Expr, _ extra: (inout ResolveOpts) -> Void = { _ in }) throws -> Expr {
    var o = opts
    extra(&o)
    o.exactConditions = true
    return exactCases(try Resolver(getFn: getFn, opts: o).resolve(e))
  }

  /// A user function's body, or nil (a broken one says so where called).
  private func bodyOf(_ name: String) -> Expr? { (try? getFn(name))?.body }

  /// Whether recurrence `name` is tuple-valued: it starts from the empty
  /// tuple (`s_0 = ()`), its step pushes or pops, or its step's value is a
  /// tuple (`p_{n+1} = (…, …)`).
  func isTupleSeq(_ name: String) -> Bool {
    if let known = tupleValued[name] { return known }
    func usesStack(_ e: Expr, _ seen: inout Set<String>) -> Bool {
      if case .call(let fn, _) = e {
        if fn == "push" || fn == "pop" { return true }
        if seen.insert(fn).inserted, let body = bodyOf(fn), usesStack(body, &seen) { return true }
      }
      return childrenOf(e).contains { usesStack($0, &seen) }
    }
    /// Whether a step's value is a tuple: one written out, or arithmetic on
    /// one, in any case of a piecewise, or returned by the function it calls.
    func makesTuple(_ e: Expr, _ seen: inout Set<String>) -> Bool {
      switch e {
      case .vec: return true
      case .bin(_, let a, let b, _): return makesTuple(a, &seen) || makesTuple(b, &seen)
      case .neg(let a): return makesTuple(a, &seen)
      case .piecewise(let cases, let otherwise):
        return cases.contains { makesTuple($0.value, &seen) } || (otherwise.map { makesTuple($0, &seen) } ?? false)
      case .call(let fn, _):
        guard seen.insert(fn).inserted, let body = bodyOf(fn) else { return false }
        return makesTuple(body, &seen)
      default: return false
      }
    }
    var tuple = false
    if let scan = sequences[name], scan.rec, !scan.lattice {
      tuple = scan.emptySeed
      // (Its row reports a parse error.)
      if !tuple, let step = try? parse(scan) {
        var seen: Set<String> = []
        tuple = usesStack(step, &seen)
        seen = []
        tuple = tuple || makesTuple(step, &seen)
      }
    }
    tupleValued[name] = tuple
    return tuple
  }

  /// Another sequence's term at the recurrence's own index, left as a name
  /// (b_n) when the step is resolved with n not yet open.
  private func otherTerm(_ name: String, _ v: String) -> Bool {
    guard let scan = sequences[name], let m = namedTerm(v) else { return false }
    return m.name != name && m.index == scan.index && sequences[m.name] != nil
  }

  /// A step that reads n, another sequence at n, or a tuple: computed term
  /// by term rather than as one map applied over and over.
  private func steps(_ name: String, _ body: Expr) -> Bool {
    let index = sequences[name]!.index
    let indexed = indexedNames(body)
    return freeVars(body).contains { $0 == index || indexed.contains($0) || otherTerm(name, $0) }
  }

  private func isConstant(_ v: String) -> Bool { v == "t" || isKnown(v) || hasConst(v) }

  /// Term k of sequence `name`.
  func term(_ name: String, _ k: Double) throws -> Expr {
    guard JS.isInteger(k), k >= 0, k <= Double(seqMax) else {
      throw LanguageError("Sequence indices must be whole numbers from 0 to \(seqMax).")
    }
    let k = Int(k)
    let scan = sequences[name]!
    if isTupleSeq(name) { throw Unsupported("tuple-valued recurrences") }
    let key = "\(name)_\(k)"
    if protectedNames.contains(key) || hasConst(key) { return .var(key) }
    // A term the chain already holds: how a step that reads n, resolved term
    // by term, reaches its previous term while its sequence is resolving.
    if scan.rec && hasConst(chained(name, k)) { return .var(chained(name, k)) }
    if resolving.contains(name) {
      throw LanguageError("Sequence \(name) depends on itself outside its recurrence.")
    }
    resolving.append(name)
    defer { resolving.removeAll { $0 == name } }
    let parsed = try parse(scan)
    if !scan.rec {
      // Pin the index in the source (a Σ/∫ that rebinds it keeps its own),
      // then resolve once: a_5 of a_n = Σ(s=1..n, s) is the number 15, not a
      // sum node, and the term sees exactly what the plot row sees.
      return try resolveSeq(substIdx(parsed, scan.index, .num(Double(k))))
    }
    let recVar = "\(name)_\(scan.index)"
    let body = try resolveSeq(parsed)
    let stepped = steps(name, body)
    if !stepped {
      for v in freeVars(body) where v != recVar && !isConstant(v) {
        throw LanguageError("Sequence \(name) terms need constant parameters (found \(v)).")
      }
    }
    // A step that reads n is resolved once with n open, as its row is (its
    // own a_n the previous term, another sequence's b_n that term in n), and
    // is that expression at each n.
    var open: Expr?
    if stepped {
      let lookup = opts.sequenceTerm
      let own = "\(name)_"
      open = try resolveSeq(parsed) { o in
        o.openVars.insert(scan.index)
        o.sequenceTerm = { symbol, at, vars in
          if symbol == recVar { return .var(recVar) }
          if symbol == own, case .var(scan.index)? = at { return .var(recVar) }
          return try lookup?(symbol, at, vars)
        }
      }
      // (A step that reads a tuple by position resolves its source per term,
      // through list lowering: not ported.)
      if !indexedNames(open!).isEmpty { throw Unsupported("a recurrence that reads a list") }
      for v in freeVars(open!)
      where v != recVar && v != scan.index && !isConstant(v) && !v.hasPrefix("\(prefix)_") {
        throw LanguageError("Sequence \(name) terms need constant parameters (found \(v)).")
      }
    }
    /// Another recurrence's term k, read from its chain: built now if it is
    /// not there yet.
    func chainTerm(_ chain: String, _ k: Double) throws -> Expr {
      let u = Array(chain.utf16)
      let other = String(decoding: u[(prefix.utf16.count + 1)..<(u.count - 1)], as: UTF16.self)
      let constant = "\(chain)\(JS.string(k))"
      return hasConst(constant) || sequences[other] == nil ? .var(constant) : try term(other, k)
    }
    // A chain is built from 0 without gaps, so past the first missing term
    // every later one is missing too.
    var fresh = false
    for i in 0...k {
      let link = chained(name, i)
      if !fresh && hasConst(link) { continue }
      fresh = true
      let value: Expr
      if i == 0 {
        let seed = "\(name)_0"
        value = protectedNames.contains(seed) || hasConst(seed) ? .var(seed) : .num(0.5)
      } else if let open {
        value = try pinTerms(
          substVars(open, [recVar: .var(chained(name, i - 1)), scan.index: .num(Double(i - 1))]), chainTerm)
      } else {
        value = substVars(body, [recVar: .var(chained(name, i - 1))])
      }
      defineConstant(link, value)
      addKnown(link)
      // (Otherwise resolved at frame time.)
      var env: [String: Double] = [:]
      for v in freeVars(value) {
        if let x = opts.consts(v) { env[v] = x }
      }
      if let x = try? evaluate(value, env) { setValue(link, x) }
    }
    return .var(chained(name, k))
  }

  /// Sequence `name`'s term at an index that is still open (another sequence
  /// row's own n) as an expression in it: b_n in a_n = b_n + 1 is b's term,
  /// written in n. Only an explicit term has one; a recurrence's terms exist
  /// only as a chain from its seed.
  private func inline(_ name: String, _ at: Expr, _ open: Set<String>) throws -> Expr {
    let scan = sequences[name]!
    if isTupleSeq(name) { throw Unsupported("tuple-valued recurrences") }
    if scan.rec {
      // No closed form: read the chain that computes its terms, all of them.
      // Read from another recurrence's step, it is read term by term
      // instead, as that chain grows: so two recurrences may read each other.
      if resolving.isEmpty { _ = try term(name, Double(seqMax)) }
      let body = try resolveSeq(try parse(scan))
      // The trailing inputs are names the row depends on: the step's
      // constants, not its index, its own term or other sequences'.
      let stepped = steps(name, body)
      let indexed = indexedNames(body)
      var inputs = freeVars(body).list.filter { v in
        v != "\(name)_\(scan.index)"
          && (!stepped || (v != scan.index && !indexed.contains(v) && !otherTerm(name, v)))
      }
      let seed = "\(name)_0"
      if protectedNames.contains(seed) || hasConst(seed) { inputs.append(seed) }
      return .call(TERM_AT_FN, [.str("\(prefix)_\(name)_"), at] + inputs.map { .var($0) })
    }
    if let from = resolving.firstIndex(of: name) {
      let cycle = resolving[from...]
      throw LanguageError(
        cycle.count > 1
          ? "Sequences \(cycle.joined(separator: " and ")) are defined in terms of each other."
          : "Sequence \(name) depends on itself.")
    }
    resolving.append(name)
    defer { resolving.removeAll { $0 == name } }
    let parsed = try parse(scan)
    return try resolveSeq(substIdx(parsed, scan.index, at)) { $0.openVars = open }
  }

  /// `ResolveOpts.sequenceTerm`: a term by name (a_3, a_k), or by index
  /// (`a_` and what is in its brackets).
  func resolve(_ symbol: String, _ index: Expr?, _ open: Set<String>) throws -> Expr? {
    guard let index else {
      if let hit = termName(symbol) { return sequences[hit.name] != nil ? try term(hit.name, hit.k) : nil }
      // a_k: the term at a slider, unless a_k is a name of its own.
      guard let named = namedTerm(symbol), let scan = sequences[named.name], !protectedNames.contains(symbol),
        !isKnown(symbol)
      else { return nil }
      let k = named.index
      // At an open index: the term there (a recurrence's own row keeps its
      // previous term a_n for itself: see classifySeqRec).
      if open.contains(k) { return try inline(named.name, .var(k), open) }
      if k == scan.index { return nil }
      if opts.consts(k) == nil { return nil }
      return try resolve("\(named.name)_", .var(k), open)
    }
    guard symbol.hasSuffix("_") else { return nil }
    let name = String(symbol.dropLast())
    guard let scan = sequences[name] else { return nil }
    // A recurrence's own previous term, written a_{n} or a_(n): its variable
    // a_n, as when written plainly.
    if scan.rec, case .var(scan.index) = index, !open.contains(scan.index) { return .var("\(name)_\(scan.index)") }
    if freeVars(index).contains(where: open.contains) { return try inline(name, index, open) }
    // One term per index of a list or a range, which needs lists.
    func listed(_ e: Expr) -> Bool {
      switch e {
      case .range, .list, .data, .index, .lazy: true
      default: childrenOf(e).contains(where: listed)
      }
    }
    if listed(index) { throw Unsupported("lists") }
    var env: [String: Double] = [:]
    for n in freeVars(index) {
      opts.boundConsts?.names.insert(n)
      if let v = opts.consts(n) { env[n] = v }
    }
    return try term(name, try evaluate(index, env))
  }
}

/// A sequence row's reading (lib/seq.ts `classifySeqRec`). `sequences` is
/// every sequence in the document, so b_n and b_[n+1] read as its terms.
func classifySeqRec(
  _ scan: SeqScan, fnNames: Set<String>, getFn: @escaping GetFn, constNames: () -> Set<String>, ropts: ResolveOpts,
  resolver: SequenceResolver, indexNames: Set<String>
) throws -> Classified {
  let (name, index) = (scan.name, scan.index)
  if reservedNames.contains(index) {
    throw LanguageError("\"\(index)\" is reserved; index sequences with n, k, or m.")
  }
  if scan.rec, resolver.isTupleSeq(name) { throw Unsupported("tuple-valued recurrences") }
  // Σ/Π with constant bounds expand here, as anywhere else. A bound that
  // uses the index (a_n = Σ(s=1..n, s)) stays a sum; evaluate() runs it at each n.
  var opts = ropts
  opts.openVars.insert(index)
  let openVars = opts.openVars
  let source = try parseExpr(
    scan.rhs, userFns: fnNames, listNames: indexNames.union(resolver.sequences.keys.map { $0 + "_" }))
  // A recurrence's own a_n (a_{n}, a_(n)) is its previous term, the variable
  // the map steps: not a lookup into the terms it is defining.
  let recVar = "\(name)_\(index)"
  let lookup = ropts.sequenceTerm
  if scan.rec, let lookup {
    let own = "\(name)_"
    opts.sequenceTerm = { symbol, at, open in
      if symbol == recVar { return .var(recVar) }
      if symbol == own, case .var(index)? = at { return .var(recVar) }
      return try lookup(symbol, at, open)
    }
  }
  // Terms are at whole n, so a case may test equality: {mod(n, 2) = 0: …}.
  opts.exactConditions = true
  let parsed = exactCases(try Resolver(getFn: getFn, opts: opts).resolve(source))
  var vars = freeVars(parsed)
  // (lib/complex.ts `usesComplex`; complex numbers are not ported.)
  if vars.contains("i") || vars.contains("w") { throw Unsupported("complex numbers") }

  // (The names with a value now: resolving may have written a chain.)
  let defined = constNames()
  var params: [String] = []
  for v in vars.list where defined.contains(v) {
    params.append(v)
    vars.remove(v)
  }
  let animated = vars.remove("t")
  func done(_ object: MathObject) -> Classified {
    Classified(object: object, animated: animated, needs3D: false, params: jsSorted(params))
  }

  // The seed constant (a_0), when the user defined one. Listed in params so
  // slider drags and animated definitions re-render, though it reaches the
  // renderers as a dedicated seed value rather than through the field.
  let a0Name: String? = defined.contains("\(name)_0") ? "\(name)_0" : nil

  if !scan.rec {
    vars.remove(index)
    for v in vars {
      if v.hasSuffix("_"), resolver.sequences[String(v.dropLast())] != nil {
        let tuple = String(v.dropLast())
        throw LanguageError(
          "\(tuple)'s terms are tuples, with no formula in \(index) to draw: read one at a number "
            + "(count(\(tuple)_3), top(\(tuple)_k)), or in a recurrence's step "
            + "(q_{\(index)+1} = f(q_\(index), top(\(tuple)_\(index)))).")
      }
      throw LanguageError("A sequence term may only use \(index), t, and constants (found \(v)).")
    }
    return done(.sequence(term: parsed, index: index))
  }

  let bifurcation = vars.remove("x")
  vars.remove(recVar)
  if vars.contains("y") { throw LanguageError("Put the recurrence parameter on the x-axis (use x, not y).") }
  // A step that reads n (directly, or through another sequence's term at n)
  // is no single map to draw as a cobweb: the row draws its terms instead,
  // read from the chain that computes them.
  let stepped = vars.remove(index)
  if stepped {
    if bifurcation {
      throw LanguageError("A recurrence that reads \(index) or a tuple draws its terms; it cannot also take x.")
    }
    for v in vars { throw LanguageError("Unknown variable: \(v). Define \"\(v) = 1\" to make a slider.") }
    guard let term = try lookup?("\(name)_", .var(index), openVars) else {
      throw LanguageError("Recurrence \(name) needs the rest of the document to compute its terms.")
    }
    if let a0Name { params.append(a0Name) }
    return done(.sequence(term: term, index: index))
  }
  for v in vars { throw LanguageError("Unknown variable: \(v). Define \"\(v) = 1\" to make a slider.") }
  if let a0Name { params.append(a0Name) }
  return done(
    bifurcation
      ? .bifurcation(expr: parsed, variable: recVar, seedName: a0Name)
      : .cobweb(expr: parsed, variable: recVar, seedName: a0Name))
}
