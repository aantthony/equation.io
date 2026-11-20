/// Cellular automata and tables: the rows that draw on the integer lattice
/// (lib/automaton.ts, docs/discrete.md).
///
/// - `c_{n+1}[i] = …` is a 1D rule. It reads the previous row at fixed
///   offsets from the cell it computes (`c_n[i-1]`, `c_n[i]`, `c_n[i+1]`)
///   and may use n, t and constants. It draws the space-time diagram: i
///   across, n down.
/// - `L_{n+1}[i, j] = …` is a 2D rule, reading `L_n[i+1, j-1]` and the like;
///   it draws one generation of its board at a time, stepping with t. Two
///   indices read as a matrix's do: row i (down), column j (across).
/// - A Σ/Π with constant bounds unrolls, so a neighbourhood is written once:
///   `sum(a=-1..1, sum(b=-1..1, L_n[i+a, j+b]))`. A piecewise case may test
///   equality (`{s = 3: 1, 0}`), which on whole-number cells is exact.
/// - `c_0[i] = …` / `L_0[i, j] = …` is the generation it starts from;
///   `L_0 = [(0, 0), (1, 0)]` lists live cells as (row, column). Without one
///   the start is a single 1 at the origin.
/// - `T[i, j] = …` is a table, a function on the lattice.
///
/// Internally a cell is (across, down): CELL_VAR and CELL_VAR2, and cell
/// (a, d) is the unit square centred on (a, -d) in its panel's plane.
///
/// The lattice is unbounded. Beyond a window around the seed every cell is
/// its side's background, which steps by the rule applied to itself.
///
/// Not ported: a table of rows computed already (a tuple-valued recurrence's
/// terms, lib/seq.ts `classifyTupleRun`), which needs lists.

/// The last row computed, as for scalar sequences (`AUTOMATON_STEPS`).
let AUTOMATON_STEPS = 1000
/// The seed is read on [-SEED_HALF, SEED_HALF]; past that each side repeats
/// its outermost value.
private let SEED_HALF = 256
/// The widest row: a texture every device of note accepts.
private let MAX_WIDTH = 4096
/// Entries in the table that remembers the rule per neighbourhood.
private let MEMO_SIZE = 1 << 16
/// A 2D board is cells -BOARD_HALF..BOARD_HALF each way, inside a ring of background.
public let BOARD_HALF = 256
/// Generations a 2D rule steps through before it starts over.
public let BOARD_STEPS = 2000
/// Terms one unrolled Σ may have.
private let UNROLL_MAX = 25.0

/// The rule's previous-generation cell at offset k (1D) or (k, l) (2D).
func neighbour(_ k: Int, _ l: Int? = nil) -> String { l.map { "@c\(k),\($0)" } ?? "@c\(k)" }
/// The rule's step n and the seed's cell indices, renamed off the user's names.
let STEP_VAR = "@n"
let CELL_VAR = "@i"
let CELL_VAR2 = "@j"

// MARK: - Classification

/// Classify row `ri`: an automaton's rule or seed, or a table
/// (`classifyAutomatonRow`). A seed row draws nothing of its own (nil); the
/// rule row carries it.
func classifyAutomatonRow(
  _ scans: [SeqScan?], _ ri: Int, fnNames: Set<String>, getFn: @escaping GetFn, constNames: Set<String>,
  ropts: ResolveOpts
) throws -> Classified? {
  let scan = scans[ri]!
  let same = scans.enumerated().compactMap { k, s in s.flatMap { $0.name == scan.name ? (s: $0, k: k) : nil } }
  if same.contains(where: { !$0.s.lattice }) {
    throw LanguageError("\(scan.name) is already a sequence; name the automaton another letter.")
  }
  if scan.table {
    if same[0].k < ri { throw LanguageError("\(scan.name) is already defined.") }
    return try classifyTable(scan, fnNames, getFn, constNames, ropts)
  }
  if same.contains(where: \.s.table) {
    throw LanguageError("\(scan.name) is already a table; name the automaton another letter.")
  }
  let first = same.first { $0.s.seed == scan.seed }!.k
  if first < ri {
    throw LanguageError(
      scan.seed ? "\(scan.name)_0 is already defined." : "Automaton \(scan.name) is already defined.")
  }
  let rule = same.first { !$0.s.seed }?.s
  if scan.seed {
    guard let rule else {
      let cell = scan.cell ?? ""
      throw LanguageError(
        "\(scan.name)_0[\(cell)] starts an automaton: add its rule, like "
          + "\(scan.name)_{n+1}[\(cell)] = \(scan.name)_n[\(cell)-1].")
    }
    // Its errors belong on this row, not the rule's.
    _ = try classifySeed(scan, rule, fnNames, getFn, constNames, ropts)
    return nil
  }
  var seed: (expr: Expr, params: [String], animated: Bool)?
  // A broken seed is reported on its own row; the rule still draws from the
  // default. (One the port cannot read is not broken: the rule waits for it.)
  if let seedScan = same.first(where: \.s.seed)?.s {
    do {
      seed = try classifySeed(seedScan, scan, fnNames, getFn, constNames, ropts)
    } catch let error as Unsupported {
      throw error
    } catch {
      // See the seed row.
    }
  }
  let ruleExpr = try classifyRule(scan, fnNames, getFn, constNames, ropts)
  let params = NameSet(ruleExpr.params + (seed?.params ?? []))
  let dims = scan.cell2 != nil ? 2 : 1
  return Classified(
    object: .automaton(
      rule: ruleExpr.rule, radius: ruleExpr.radius, seed: seed?.expr, dims: dims,
      axes: dims == 2 ? [scan.cell2!, scan.cell!] : [scan.cell!, scan.index]),
    // A board shows one generation at a time, stepping with t.
    animated: dims == 2 || ruleExpr.animated || (seed?.animated ?? false), needs3D: false,
    params: jsSorted(params.list))
}

/// A constant integer offset: `i + 2`, `i - 1`, `i`. Nil for anything else.
private func offsetOf(_ at: Expr, _ cell: String) -> Int? {
  let vars = freeVars(at)
  guard vars.count == 1, vars.contains(cell), let k = try? evaluate(at, [cell: 0]), JS.isInteger(k),
    let next = try? evaluate(at, [cell: 1]), next - k == 1
  else { return nil }
  return Int(k)
}

/// Params, t, and nothing else free once `own` (the row's own names) are out.
private func checkFree(_ e: Expr, _ own: Set<String>, _ constNames: Set<String>, _ what: String) throws -> (
  params: [String], animated: Bool
) {
  var params: [String] = []
  var animated = false
  for v in freeVars(e) where !own.contains(v) {
    if v == "t" {
      animated = true
    } else if constNames.contains(v) {
      params.append(v)
    } else {
      throw LanguageError("Unknown variable in the \(what): \(v). Define \"\(v) = 1\" to make a slider.")
    }
  }
  return (params, animated)
}

/// A Σ/Π whose bounds are plain numbers, as its terms: a neighbourhood
/// written once, `sum(a=-1..1, c_n[i+a])`, becomes the fixed offsets the
/// rule reads. Nil for anything else (it resolves as an ordinary Σ).
private func unrollSum(_ e: Expr) -> Expr? {
  let header: [Expr]
  let name: String
  let body: Expr
  if case .call(let fn, let args) = e, fn == "sum" || fn == "prod", args.count == 4 {
    (name, header, body) = (fn, args, args[3])
  } else if case .bin(.mul, .call(let fn, let args), let b, _) = e, fn == "sum" || fn == "prod", args.count == 3 {
    // The bracket form, sum[a=-1..1] body: the header multiplies its body.
    (name, header, body) = (fn, args, b)
  } else {
    return nil
  }
  guard case .var(let idx) = header[0], let lo = try? evaluate(header[1], [:]),
    let hi = try? evaluate(header[2], [:]), JS.isInteger(lo), JS.isInteger(hi), hi - lo + 1 <= UNROLL_MAX
  else { return nil }
  var acc: Expr?
  var k = lo
  while k <= hi {
    let term = substVars(body, [idx: .num(k)])
    acc = acc.map { .bin(name == "sum" ? .add : .mul, $0, term) } ?? term
    k += 1
  }
  return acc ?? .num(name == "sum" ? 0 : 1)
}

/// Resolve a lattice row's expression with `own` left open (`resolveCells`).
private func resolveCells(_ e: Expr, _ own: Set<String>, _ getFn: @escaping GetFn, _ ropts: ResolveOpts) throws -> Expr {
  var opts = ropts
  opts.openVars.formUnion(own)
  // Cells are whole numbers, so a case may test equality: {s = 3: 1, 0},
  // written in the row or in a function it calls (inlined already resolved).
  opts.exactConditions = true
  let resolved = exactCases(try Resolver(getFn: getFn, opts: opts).resolve(e))
  // (lib/complex.ts `usesComplex`; complex numbers are not ported.)
  let vars = freeVars(resolved)
  if vars.contains("i") || vars.contains("w") { throw Unsupported("complex numbers") }
  return resolved
}

private func classifyRule(
  _ scan: SeqScan, _ fnNames: Set<String>, _ getFn: @escaping GetFn, _ constNames: Set<String>, _ ropts: ResolveOpts
) throws -> (rule: Expr, radius: Int, params: [String], animated: Bool) {
  let (name, index, cell, cell2) = (scan.name, scan.index, scan.cell!, scan.cell2)
  if index == cell || index == cell2 {
    throw LanguageError("Name the step and the cells differently, like \(name)_{n+1}[i].")
  }
  if cell == cell2 { throw LanguageError("Name the two cell indices differently, like \(name)_{n+1}[i, j].") }
  let row = "\(name)_\(index)"
  let at = cell2.map { "\(cell), \($0)" } ?? cell
  let example = cell2.map { "\(row)[\(cell)+1, \($0)]" } ?? "\(row)[\(cell)-1] or \(row)[\(cell)+2]"
  let parsed = try parseExpr(scan.rhs, userFns: fnNames, listNames: [row])
  var radius = 0
  func reads(_ e: Expr) throws -> Expr {
    if let unrolled = unrollSum(e) { return try reads(unrolled) }
    if case .index(.var(row), let pos) = e {
      if let cell2 {
        // Row first, as in a matrix: L_n[i+1, j] is the cell below.
        guard case .list(let items) = pos, items.count == 2, let l = offsetOf(items[0], cell),
          let k = offsetOf(items[1], cell2)
        else {
          throw LanguageError("Read the previous generation at fixed offsets from \(at), like \(example).")
        }
        radius = max(radius, abs(k), abs(l))
        return .var(neighbour(k, l))
      }
      guard let k = offsetOf(pos, cell) else {
        throw LanguageError("Read the previous row at a fixed offset from \(cell), like \(example).")
      }
      radius = max(radius, abs(k))
      return .var(neighbour(k))
    }
    if case .var(let v) = e {
      if v == row {
        throw LanguageError(
          "\(row) is a whole \(cell2 != nil ? "generation" : "row"); read one cell of it, like \(row)[\(at)].")
      }
      if v == cell || v == cell2 {
        throw LanguageError("A rule is the same at every cell: read neighbours like \(example), not \(v) itself.")
      }
    }
    return try mapChildren(e, reads)
  }
  let stepped = substVars(try reads(parsed), [index: .var(STEP_VAR)])
  var own: Set<String> = [STEP_VAR]
  for k in -radius...radius {
    if cell2 == nil {
      own.insert(neighbour(k))
    } else {
      for l in -radius...radius { own.insert(neighbour(k, l)) }
    }
  }
  let rule = try resolveCells(stepped, own, getFn, ropts)
  let free = try checkFree(rule, own, constNames, "rule")
  return (rule, radius, free.params, free.animated)
}

/// `L_0 = [(0, 0), (1, 0)]` as an expression in the cells: each listed cell
/// adds 1 where it is, so a cell listed twice is worth 2.
private func seedFromCells(_ rhs: String, _ dims: Int, _ fnNames: Set<String>) throws -> Expr {
  let usage =
    dims == 2 ? "List live cells as points: [(0, 0), (1, 0), (2, 1)]." : "List live cells by index: [0, 3, 4]."
  let list = try parseExpr(rhs, userFns: fnNames)
  // A bracket around one item is that item: [(0, 0)] parses as the point.
  let items: [Expr] = if case .list(let items) = list { items } else { [list] }
  let terms = try items.map { item -> Expr in
    var coords: [Expr]?
    if dims == 1 { coords = [item] } else if case .vec(let pair) = item, pair.count == 2 { coords = pair }
    guard let coords else { throw LanguageError(usage) }
    let place = coords.map { try? evaluate($0, [:]) }
    guard let place = place as? [Double], place.allSatisfy(JS.isInteger) else {
      throw LanguageError("Live cells are whole numbers. \(usage)")
    }
    // 1 at the cell, and at most 0 at every other whole-number cell. A
    // point is (row, column): down, then across.
    let names = dims == 1 ? [CELL_VAR] : [CELL_VAR2, CELL_VAR]
    let dists = place.enumerated().map { k, v in Expr.call("abs", [.bin(.sub, .var(names[k]), .num(v))]) }
    let dist = dists.dropFirst().reduce(dists[0]) { .bin(.add, $0, $1) }
    return .call("max", [.num(0), .bin(.sub, .num(1), dist)])
  }
  guard let head = terms.first else { return .num(0) }
  return terms.dropFirst().reduce(head) { .bin(.add, $0, $1) }
}

private func classifySeed(
  _ scan: SeqScan, _ rule: SeqScan, _ fnNames: Set<String>, _ getFn: @escaping GetFn, _ constNames: Set<String>,
  _ ropts: ResolveOpts
) throws -> (expr: Expr, params: [String], animated: Bool) {
  let dims = rule.cell2 != nil ? 2 : 1
  let parsed: Expr
  if scan.seedList {
    parsed = try seedFromCells(scan.rhs, dims, fnNames)
  } else {
    if (scan.cell2 != nil) != (rule.cell2 != nil) {
      throw LanguageError(
        dims == 2
          ? "\(scan.name) is a 2D automaton: write its seed over two cells, "
            + "\(scan.name)_0[\(rule.cell ?? ""), \(rule.cell2 ?? "")] = …."
          : "\(scan.name) is a 1D automaton: write its seed over one cell, \(scan.name)_0[\(rule.cell ?? "")] = …."
      )
    }
    // A 2D seed's first index is its row: down, CELL_VAR2.
    let source = try parseExpr(scan.rhs, userFns: fnNames)
    parsed = substVars(
      source,
      scan.cell2.map { [scan.cell!: .var(CELL_VAR2), $0: .var(CELL_VAR)] } ?? [scan.cell!: .var(CELL_VAR)])
  }
  let own: Set<String> = [CELL_VAR, CELL_VAR2]
  let expr = try resolveCells(parsed, own, getFn, ropts)
  let free = try checkFree(expr, own, constNames, "seed")
  return (expr, free.params, free.animated)
}

private func classifyTable(
  _ scan: SeqScan, _ fnNames: Set<String>, _ getFn: @escaping GetFn, _ constNames: Set<String>, _ ropts: ResolveOpts
) throws -> Classified {
  let (name, cell, cell2) = (scan.name, scan.cell!, scan.cell2!)
  if cell == cell2 { throw LanguageError("Name the two indices differently, like \(name)[i, j].") }
  let parsed = substVars(
    try parseExpr(scan.rhs, userFns: fnNames), [cell: .var(CELL_VAR2), cell2: .var(CELL_VAR)])
  let own: Set<String> = [CELL_VAR, CELL_VAR2]
  let expr = try resolveCells(parsed, own, getFn, ropts)
  let free = try checkFree(expr, own, constNames, "table")
  return Classified(
    object: .lattice(expr: expr, axes: [cell2, cell]), animated: free.animated, needs3D: false,
    params: jsSorted(free.params))
}

// MARK: - Running

/// Cells on the lattice: `rows` rows of `width` cells, row-major. Cell (i, k)
/// sits in column i - x0 of row k - y0, where k is the down index (a 1D
/// rule's step, a board's or table's second index). For an automaton, the
/// outermost columns (and a board's outermost rows) are the background,
/// which runs on without end.
public struct CellGrid: Equatable, Sendable {
  public var values: [Float]
  public var width: Int
  public var rows: Int
  public var x0: Int
  public var y0: Int
}

/// A cell expression over numbered slots, as closures: what lib/vm.ts's
/// `compileProg` and `run` are to the site. A value it cannot compute (a
/// name with no value, a function called wrongly) is NaN.
private struct CellProgram {
  typealias Slots = UnsafeMutablePointer<Double>
  let run: (Slots) -> Double

  init(_ e: Expr, _ slots: [String: Int]) {
    run = CellProgram.compile(e, slots)
  }

  private static func compile(_ e: Expr, _ slots: [String: Int]) -> (Slots) -> Double {
    /// Anything else: the tree-walking evaluator over the same values.
    func walked() -> (Slots) -> Double {
      let names = freeVars(e).list.compactMap { name in slots[name].map { (name, $0) } }
      return { vars in
        var env: [String: Double] = [:]
        for (name, k) in names { env[name] = vars[k] }
        return (try? evaluate(e, env)) ?? .nan
      }
    }
    switch e {
    case .num(let value):
      return { _ in value }
    case .var(let name):
      guard let k = slots[name] else { return { _ in .nan } }
      return { $0[k] }
    case .neg(let a):
      let f = compile(a, slots)
      return { -f($0) }
    case .bin(let op, let l, let r, _):
      let (a, b) = (compile(l, slots), compile(r, slots))
      switch op {
      case .add: return { a($0) + b($0) }
      case .sub: return { a($0) - b($0) }
      case .mul: return { a($0) * b($0) }
      case .div: return { a($0) / b($0) }
      case .pow: return { realPow(a($0), b($0)) }
      }
    case .call(let name, let args):
      // (A Σ left for evaluate, a recurrence's term: walked.)
      guard boundSumIndex(e) == nil, name != TERM_AT_FN, let fn = evalFunctions[name] else { return walked() }
      let compiled = args.map { compile($0, slots) }
      switch compiled.count {
      case 1:
        let a = compiled[0]
        return { fn([a($0)]) }
      case 2:
        let (a, b) = (compiled[0], compiled[1])
        return { fn([a($0), b($0)]) }
      default:
        return { vars in fn(compiled.map { $0(vars) }) }
      }
    case .eq(let l, let r):
      let (a, b) = (compile(l, slots), compile(r, slots))
      return { a($0) - b($0) }
    case .piecewise(let cases, let otherwise):
      var conds: [(Slots) -> Bool] = []
      for c in cases {
        guard case .ineq = c.cond else { return walked() }
        let chain = ineqComparisons(c.cond).map { (op: $0.op, l: compile($0.l, slots), r: compile($0.r, slots)) }
        conds.append { vars in
          for c in chain {
            let (a, b) = (c.l(vars), c.r(vars))
            let holds =
              switch c.op {
              case .lt: a < b
              case .le: a <= b
              case .gt: a > b
              case .ge: a >= b
              }
            if !holds { return false }
          }
          return true
        }
      }
      let values = cases.map { compile($0.value, slots) }
      let last = otherwise.map { compile($0, slots) }
      return { vars in
        for k in conds.indices where conds[k](vars) { return values[k](vars) }
        return last?(vars) ?? .nan
      }
    default:
      return walked()
    }
  }
}

/// One slot layout for the names the programs read: neighbours, n, the cell
/// indices, then params, with params filled from `env` (`slotsFor`).
private func slotsFor(_ exprs: [Expr], _ env: [String: Double]) -> (slots: [String: Int], vars: [Double]) {
  var names = NameSet()
  for e in exprs {
    for v in freeVars(e) { names.insert(v) }
  }
  for n in [STEP_VAR, CELL_VAR, CELL_VAR2] { names.insert(n) }
  var slots: [String: Int] = [:]
  var vars = [Double](repeating: 0, count: names.count)
  for (k, n) in names.list.enumerated() {
    slots[n] = k
    if let v = env[n] { vars[k] = v }
  }
  return (slots, vars)
}

/// The rule, remembered per neighbourhood (`memoRule`). Cells usually take a
/// few whole-number states, so their states in [0, base) spell a key.
/// `retire` forgets everything, for a rule that reads n.
private final class MemoRule {
  private let prog: CellProgram
  private let vars: UnsafeMutablePointer<Double>
  private let nbr: [Int]
  private let base: Double
  private var memo: [Double]
  private var stamps: [UInt32]
  private var stamp: UInt32 = 1

  init(_ rule: Expr, _ slots: [String: Int], _ vars: UnsafeMutablePointer<Double>, _ nbr: [Int]) {
    prog = CellProgram(rule, slots)
    self.vars = vars
    self.nbr = nbr
    let read = nbr.filter { $0 >= 0 }.count
    // Two states a cell already spell 2^cells keys: past MEMO_SIZE (a 5×5
    // neighbourhood is 2^25) there is no table, and the rule just runs.
    let size = Double(MEMO_SIZE)
    base = JS.pow(2, Double(read)) > size ? 0 : JS.pow(size, 1 / Double(max(1, read))).rounded(.down)
    let count = base > 0 ? Int(JS.pow(base, Double(read))) : 0
    memo = [Double](repeating: 0, count: count)
    stamps = [UInt32](repeating: 0, count: count)
  }

  func retire() { stamp += 1 }

  /// The rule at the neighbourhood `at(k)` gives, k indexing nbr.
  func apply(_ at: (Int) -> Float) -> Double {
    var key = 0.0
    for k in nbr.indices where nbr[k] >= 0 {
      let v = Double(at(k))
      vars[nbr[k]] = v
      key = key >= 0 && v >= 0 && v < base && v == v.rounded(.down) ? key * base + v : -1
    }
    if key < 0 { return prog.run(vars) }
    let slot = Int(key)
    if stamps[slot] != stamp {
      memo[slot] = prog.run(vars)
      stamps[slot] = stamp
    }
    return memo[slot]
  }

  /// The rule applied to a background alone.
  func background(_ b: Float) -> Double {
    for slot in nbr where slot >= 0 { vars[slot] = Double(b) }
    return prog.run(vars)
  }
}

private func same(_ p: Float, _ q: Float) -> Bool { p == q || (p.isNaN && q.isNaN) }

/// Steps a 1D rule `rows - 1` times from its seed (`runAutomaton`). Values
/// are the rule's own numbers; one that is not finite stays so (and draws as
/// empty).
public func runAutomaton(rule: Expr, radius r: Int, seed: Expr?, _ env: [String: Double]) -> CellGrid {
  let steps = r == 0 ? AUTOMATON_STEPS : min(AUTOMATON_STEPS, (MAX_WIDTH - 2 - (2 * SEED_HALF + 1)) / (2 * r))
  let reach = SEED_HALF + r * steps
  let width = 2 * reach + 3
  let rows = steps + 1
  let x0 = -reach - 1
  var values = [Float](repeating: 0, count: width * rows)

  var (slots, vars) = slotsFor(seed.map { [rule, $0] } ?? [rule], env)
  let nbr = (0...(2 * r)).map { slots[neighbour($0 - r)] ?? -1 }
  let stepSlot = slots[STEP_VAR]!
  let perRow = freeVars(rule).contains(STEP_VAR)
  vars.withUnsafeMutableBufferPointer { buffer in
    let vars = buffer.baseAddress!
    let memo = MemoRule(rule, slots, vars, nbr)
    // Row 0 over the whole lattice, so a patterned seed reaches its edges too.
    if let seed {
      let prog = CellProgram(seed, slots)
      let cellSlot = slots[CELL_VAR]!
      for j in 1..<(width - 1) {
        vars[cellSlot] = Double(max(-SEED_HALF, min(SEED_HALF, j + x0)))
        values[j] = Float(prog.run(vars))
      }
    } else {
      values[-x0] = 1
    }
    values[0] = values[1]
    values[width - 1] = values[width - 2]

    // Cells [lo, hi] may differ from their side's background; outside it the
    // row is that background. The span grows by the rule's reach each step.
    var lo = 1
    var hi = width - 2
    while lo <= hi && same(values[lo], values[0]) { lo += 1 }
    while hi >= lo && same(values[hi], values[width - 1]) { hi -= 1 }
    values.withUnsafeMutableBufferPointer { cells in
      for n in 1..<rows {
        let prev = (n - 1) * width
        let row = n * width
        vars[stepSlot] = Double(n - 1)
        if perRow { memo.retire() }
        // Each background steps as the rule applied to itself alone.
        let left = Float(memo.background(cells[prev]))
        let right = Float(memo.background(cells[prev + width - 1]))
        // A changing span reaches r cells further each step. An empty one
        // (lo = hi + 1) still marks where the two backgrounds meet.
        lo = max(1, lo - r)
        hi = min(width - 2, hi + r)
        for j in 0..<width {
          cells[row + j] =
            j < lo
            ? left : j > hi ? right : Float(memo.apply { k in cells[prev + max(0, min(width - 1, j + k - r))] })
        }
        // Keep the span tight where a pattern dies back into its background.
        while lo <= hi && same(cells[row + lo], left) { lo += 1 }
        while hi >= lo && same(cells[row + hi], right) { hi -= 1 }
      }
    }
  }
  return CellGrid(values: values, width: width, rows: rows, x0: x0, y0: 0)
}

/// A 2D rule's board, stepped one generation at a time (`runBoard`): `grid`
/// is generation `generation`, cells -BOARD_HALF..BOARD_HALF each way inside
/// a one-cell ring of background. Past the ring every cell is the
/// background, which steps by the rule applied to itself. Unlike a 1D rule's
/// row, the board does not grow: a pattern that reaches its edge is cut off
/// there, so it is exact until then.
public final class Board {
  public private(set) var generation = 0
  public var grid: CellGrid { CellGrid(values: cur, width: side, rows: side, x0: x0, y0: x0) }

  private let seed: Expr?
  private let r: Int
  private let side = 2 * BOARD_HALF + 3
  private let x0 = -BOARD_HALF - 1
  private let slots: [String: Int]
  private let vars: UnsafeMutablePointer<Double>
  private let offsets: [(Int, Int)]
  private let deltas: [Int]
  private let rule: MemoRule
  private let stepSlot: Int
  private let perGen: Bool
  private var cur: [Float]
  private var next: [Float]
  /// The box that may differ from the background: [x lo, x hi, y lo, y hi] in columns and rows.
  private var box: (xl: Int, xh: Int, yl: Int, yh: Int)

  public init(rule: Expr, radius r: Int, seed: Expr?, _ env: [String: Double]) {
    self.seed = seed
    self.r = r
    let side = 2 * BOARD_HALF + 3
    let (slots, values) = slotsFor(seed.map { [rule, $0] } ?? [rule], env)
    self.slots = slots
    let vars = UnsafeMutablePointer<Double>.allocate(capacity: values.count)
    vars.initialize(from: values, count: values.count)
    self.vars = vars
    var offsets: [(Int, Int)] = []
    for k in -r...r {
      for l in -r...r { offsets.append((k, l)) }
    }
    self.offsets = offsets
    self.rule = MemoRule(rule, slots, vars, offsets.map { slots[neighbour($0.0, $0.1)] ?? -1 })
    stepSlot = slots[STEP_VAR]!
    perGen = freeVars(rule).contains(STEP_VAR)
    // Each offset as a step through the row-major board (k across, l down).
    deltas = offsets.map { $0.1 * side + $0.0 }
    cur = [Float](repeating: 0, count: side * side)
    next = cur
    box = (1, side - 2, 1, side - 2)
    reset()
  }

  deinit { vars.deallocate() }

  private func fillRing(_ grid: inout [Float], _ b: Float) {
    for k in 0..<side {
      grid[k] = b
      grid[(side - 1) * side + k] = b
      grid[k * side] = b
      grid[k * side + side - 1] = b
    }
  }

  /// Shrink the box to the cells that differ from the background.
  private func tighten(_ grid: [Float], _ b: Float) {
    var (xl, xh, yl, yh) = box
    func rowClear(_ y: Int) -> Bool {
      for x in stride(from: xl, through: xh, by: 1) where !same(grid[y * side + x], b) { return false }
      return true
    }
    func colClear(_ x: Int) -> Bool {
      for y in stride(from: yl, through: yh, by: 1) where !same(grid[y * side + x], b) { return false }
      return true
    }
    while yl <= yh && rowClear(yl) { yl += 1 }
    while yh >= yl && rowClear(yh) { yh -= 1 }
    while xl <= xh && colClear(xl) { xl += 1 }
    while xh >= xl && colClear(xh) { xh -= 1 }
    box = (xl, xh, yl, yh)
  }

  private func reset() {
    generation = 0
    for k in cur.indices { cur[k] = 0 }
    if let seed {
      let prog = CellProgram(seed, slots)
      let (si, sj) = (slots[CELL_VAR]!, slots[CELL_VAR2]!)
      for y in 1..<(side - 1) {
        for x in 1..<(side - 1) {
          vars[si] = Double(x + x0)
          vars[sj] = Double(y + x0)
          cur[y * side + x] = Float(prog.run(vars))
        }
      }
    } else {
      cur[-x0 * side - x0] = 1
    }
    // The seed's background is its corner cell's.
    let b = cur[side + 1]
    fillRing(&cur, b)
    box = (1, side - 2, 1, side - 2)
    tighten(cur, b)
  }

  private func step() {
    vars[stepSlot] = Double(generation)
    if perGen { rule.retire() }
    let b = Float(rule.background(cur[0]))
    for k in next.indices { next[k] = b }
    let (xl, xh, yl, yh) = box
    // An empty box (a background alone) has nothing to grow.
    if xl <= xh && yl <= yh {
      let grown = (max(1, xl - r), min(side - 2, xh + r), max(1, yl - r), min(side - 2, yh + r))
      let (side, r, deltas, offsets) = (side, r, deltas, offsets)
      cur.withUnsafeBufferPointer { cur in
        for y in grown.2...grown.3 {
          for x in grown.0...grown.1 {
            // Reads past the ring clamp to it: the background.
            let inner = x > r && x + r < side && y > r && y + r < side
            next[y * side + x] = Float(
              rule.apply { k in
                if inner { return cur[y * side + x + deltas[k]] }
                let (dx, dy) = offsets[k]
                return cur[max(0, min(side - 1, y + dy)) * side + max(0, min(side - 1, x + dx))]
              })
          }
        }
      }
      box = grown
    }
    fillRing(&next, b)
    swap(&cur, &next)
    generation += 1
    tighten(cur, b)
  }

  /// Step to generation `n` (from the seed again when n is behind).
  public func advance(_ n: Double) {
    let target = Int(max(0, min(Double(BOARD_STEPS), n.rounded(.down))))
    if target < generation { reset() }
    while generation < target { step() }
  }

  /// Read the values the rule names from `env` again (t, as it moves):
  /// generations from here on use them.
  public func update(_ env: [String: Double]) {
    var changed = false
    for (name, k) in slots {
      guard name != STEP_VAR, name != CELL_VAR, name != CELL_VAR2, let value = env[name] else { continue }
      if vars[k] != value {
        vars[k] = value
        changed = true
      }
    }
    if changed { rule.retire() }
  }
}

/// The widest table window evaluated, in cells each way.
public let TABLE_MAX = 512

/// A table's values over the cells [i0, i0 + width) × [j0, j0 + rows)
/// (`evalTable`); undefined values (a piecewise with no case) are NaN.
public func evalTable(_ expr: Expr, _ env: [String: Double], i0: Int, j0: Int, width: Int, rows: Int) -> CellGrid {
  var (slots, vars) = slotsFor([expr], env)
  let prog = CellProgram(expr, slots)
  let (si, sj) = (slots[CELL_VAR]!, slots[CELL_VAR2]!)
  var values = [Float](repeating: 0, count: max(0, width * rows))
  vars.withUnsafeMutableBufferPointer { buffer in
    let vars = buffer.baseAddress!
    for y in 0..<max(0, rows) {
      vars[sj] = Double(j0 + y)
      for x in 0..<max(0, width) {
        vars[si] = Double(i0 + x)
        values[y * width + x] = Float(prog.run(vars))
      }
    }
  }
  return CellGrid(values: values, width: width, rows: rows, x0: i0, y0: j0)
}

/// Cell values as 0–255 shades of the row's colour (`cellShades`): 0 (and
/// below, and anything not finite) is empty, the largest value is solid.
public func cellShades(_ grid: CellGrid) -> [UInt8] {
  var top: Float = 0
  for v in grid.values where v > top && v < .infinity { top = v }
  var out = [UInt8](repeating: 0, count: grid.values.count)
  if top <= 0 { return out }
  let scale = 255 / Double(top)
  for (k, v) in grid.values.enumerated() where v > 0 && v < .infinity {
    out[k] = UInt8(max(1, min(255, Int(Double(v) * scale + 0.5))))
  }
  return out
}

/// A cell's value as a lattice panel prints it (web/main.ts `latticeValues`):
/// a whole number as it is, anything else to three significant figures.
public func cellText(_ v: Double) -> String {
  JS.isInteger(v) ? JS.string(v) : JS.string(JS.number(JS.toPrecision(v, 3)))
}

/// A table's values as shades (`tableShades`): every finite value shows, the
/// smallest faint and the largest solid (a Cayley table's identity 0 is
/// still a cell), and undefined cells are empty.
public func tableShades(_ grid: CellGrid) -> [UInt8] {
  var lo = Float.infinity
  var hi = -Float.infinity
  for v in grid.values where v.isFinite {
    if v < lo { lo = v }
    if v > hi { hi = v }
  }
  var out = [UInt8](repeating: 0, count: grid.values.count)
  let span = Double(hi) - Double(lo)
  for (k, v) in grid.values.enumerated() where v.isFinite {
    out[k] = span > 0 ? UInt8(40 + JS.round(((Double(v) - Double(lo)) / span) * 215)) : 160
  }
  return out
}

/// The opening window of a lattice panel with no view row, w × h pixels
/// (`latticeFrame`): a 1D diagram from its first row down, centred; a board
/// around its origin; a table from cell (0, 0) in the top-left corner, big
/// enough to print its values (cells at least `cellPx`).
public func latticeFrame(
  _ plan: CpuPlan?, _ env: [String: Double], width w: Double, height h: Double, cellPx: Double
) -> (cx: Double, cy: Double, upp: Double) {
  if case .automaton(_, _, _, let dims, _)? = plan {
    if dims == 1 {
      let upp = 121 / w
      return (0, 1.5 - (h / 2) * upp, upp)
    }
    return (0, 0, 80 / min(w, h))
  }
  // A table fits the cells it defines near the origin (a Cayley table's
  // n × n), with a cell of margin; one defined everywhere opens on (0, 0)
  // with cells big enough to print values in.
  var box = (0, 11, 0, 11)
  if case .lattice(let expr, _)? = plan {
    let R = 32
    let g = evalTable(expr, env, i0: -R, j0: -R, width: 2 * R + 1, rows: 2 * R + 1)
    var b = (Int.max, Int.min, Int.max, Int.min)
    for y in 0..<g.rows {
      for x in 0..<g.width where g.values[y * g.width + x].isFinite {
        b = (min(b.0, x), max(b.1, x), min(b.2, y), max(b.3, y))
      }
    }
    let edge = b.0 == 0 || b.1 == 2 * R || b.2 == 0 || b.3 == 2 * R
    if !edge && b.0 <= b.1 { box = (b.0 - R, b.1 - R, b.2 - R, b.3 - R) }
  }
  let (i0, i1, k0, k1) = box
  return (
    Double(i0 + i1) / 2, -Double(k0 + k1) / 2,
    JS.max([Double(i1 - i0 + 3) / w, Double(k1 - k0 + 3) / h, 1 / cellPx])
  )
}
