import Synchronization

/// List lowering — lists as values, by symbolic expansion (lib/list.ts).
///
/// Like d/dx and points, lists vanish before anything downstream looks:
/// broadcasting rewrites operations over lists into a top-level `list`
/// literal (the shape classify plots as dots or a scatter), reductions
/// collapse to scalar expressions, and indexing picks its element at lowering
/// time. GLSL, evaluate and diff never see a list.
///
/// - scalar ⊕ list maps elementwise; list ⊕ list zips when both run over the
///   same instances and crosses when they are independent (see `Axis`).
/// - `(A, B)` with list components becomes a list of points the same way.
/// - ranges `[1..20]`, `[0, 0.5..10]`, `[10..1]` expand here, where constant
///   values are known.
/// - a list `[ … ]` is a multiset, with no order; order lives in tuples:
///   `sort` makes one, and indexing (1-based) takes one. A tuple is a list
///   whose positions are an `ordered` axis.
/// - mean/total/count and min/max over a list lower symbolically, so their
///   elements may animate with t; stdev/median/sort need a constant list.
///
/// A list of plain numbers is a `data` node (one array); anything else takes
/// the symbolic path, one expression per element. Between the two sits
/// `lazy`: one template over packed columns, for an operation over numbers
/// that a slider or t keeps from folding.
///
/// Where the TypeScript hangs `axes` on the nodes it lowers, the port carries
/// them beside the expression, in a `Low` (see Expr.swift, "List identity").
/// Fourier analysis of a list is not ported.

/// Which instances a list runs over (lib/expr.ts `Axis`). A list is a
/// variable ranging over its values: every use of the same list moves
/// together, so they zip; lists with different origins are independent, so
/// they cross. A value over several axes is stored flat, row-major, first
/// axis slowest.
struct Axis: Equatable, Sendable {
  var id: String
  var n: Int
  /// A tuple's axis: its values sit at positions 1…n, so it indexes, draws
  /// as a path, and meets another tuple by position rather than crossing.
  var ordered = false
}

/// A value under list lowering: the expression and, when it is a list (or a
/// scatter of columns), the axes it runs over. What the TypeScript writes as
/// an `Expr` whose list nodes carry `axes`.
struct Low: Equatable, Sendable {
  var e: Expr
  var axes: [Axis]?
  /// A named list holding a member with no value (lib/list.ts `holdsNone`).
  var none = false

  /// Anything that is not a list.
  init(_ e: Expr) { self.e = e }

  /// A list over `axes` — or, when they are missing or do not span it, over
  /// an axis of its own (lib/list.ts `axesOf`).
  init(_ e: Expr, _ axes: [Axis]?, none: Bool = false) {
    self.e = e
    self.none = none
    let n = isDataScatter(e) ? scatterLength(e) : seqLength(e)
    if let axes, axes.reduce(1, { $0 * $1.n }) == n {
      self.axes = axes
    } else {
      self.axes = [Axis(id: freshAxisID(), n: n)]
    }
  }

  /// Whether this is a list of values in any representation (`isSeq`).
  var isSeq: Bool { EquationCore.isSeq(e) }
  var isList: Bool { if case .list = e { true } else { false } }
  var isData: Bool { if case .data = e { true } else { false } }
  var isText: Bool { if case .text = e { true } else { false } }
  var isLazy: Bool { if case .lazy = e { true } else { false } }

  /// A symbolic list's elements.
  var items: [Expr] { if case .list(let items) = e { items } else { [] } }
  var values: [Double] { if case .data(let values) = e { values } else { [] } }
  var count: Int { seqLength(e) }
  /// The axes of a list (always set for one).
  var own: [Axis] { axes ?? [] }
}

private let axisCounter = Mutex(0)

/// An id no other axis has (the TypeScript's `#${++anonymous}`).
func freshAxisID(_ prefix: String = "#") -> String {
  axisCounter.withLock {
    $0 += 1
    return "\(prefix)\($0)"
  }
}

/// A fresh tuple axis of n positions (`tupleAxis`).
func tupleAxis(_ n: Int) -> Axis { Axis(id: freshAxisID("#t"), n: n, ordered: true) }

/// Elements one [a..b] range may expand to.
private let RANGE_MAX = 10_000
/// Total list elements one lowering may materialize as expressions.
private let ITEMS_MAX = 100_000
/// Numbers one row's packed arrays may hold, in total.
private let DATA_MAX = 4_000_000
/// Steps of list work one function map may take in all, across its members.
private let MAP_WORK = 10 * ITEMS_MAX

/// Reductions that answer with one number however long the list is.
let SCALAR_REDUCTIONS: Set<String> = ["mean", "total", "count", "stdev", "median"]
/// Reductions that lower symbolically — their elements may depend on t.
private let SYMBOLIC_REDUCTIONS: Set<String> = ["mean", "total", "count"]
/// Reductions that need numeric elements (ordering), so a constant list.
private let NUMERIC_REDUCTIONS: Set<String> = ["stdev", "median", "sort"]

/// Whether a call reduces its argument's members to one value
/// (`reducesMembers`): count, total, mean, stdev, median, and min or max of
/// one argument.
func reducesMembers(_ name: String, _ argc: Int) -> Bool {
  SYMBOLIC_REDUCTIONS.contains(name) || name == "stdev" || name == "median"
    || ((name == "min" || name == "max") && argc == 1)
}

/// Whole-plot forms a list can never appear inside (`NO_LIST_INSIDE`).
let NO_LIST_INSIDE: Set<String> = [
  "domain", "conformal", "iter", "rgb", "hsl", "oklch", "tube", "[polygon]", "[segment]", "[polyline]", "[vector]",
  "[square]", "[hull]", "[polygon3]", "[segment3]", "[polyline3]", "[vector3]", "[hull3]",
]

func isSeq(_ e: Expr) -> Bool {
  switch e {
  case .list, .data, .text, .lazy: true
  default: false
  }
}

/// A scatter of whole columns — `(person.age, person.height)` — kept as one
/// `vec` of packed arrays rather than one point per row (`isDataScatter`).
func isDataScatter(_ e: Expr) -> Bool {
  guard case .vec(let items) = e else { return false }
  var some = false
  for it in items {
    switch it {
    case .data: some = true
    case .num: break
    default: return false
    }
  }
  return some
}

private func scatterLength(_ e: Expr) -> Int {
  guard case .vec(let items) = e else { return 0 }
  for it in items {
    if case .data(let values) = it { return values.count }
  }
  return 0
}

func seqLength(_ e: Expr) -> Int {
  switch e {
  case .list(let items): items.count
  case .lazy(let cols, _): cols.first?.values.count ?? 0
  case .data(let values): values.count
  case .text(let values): values.count
  default: 0
  }
}

/// The axes of a list reached through `name` (`namedAxes`): an origin nobody
/// has named yet (a literal, a range) takes the name, so every later use of
/// it agrees.
func namedAxes(_ name: String, _ axes: [Axis]) -> [Axis] {
  axes.enumerated().map { i, a in
    a.id.hasPrefix("#") ? Axis(id: "\(name)#\(i)", n: a.n, ordered: a.ordered) : a
  }
}

/// A tuple: a value with an order (`isTuple`).
func isTuple(_ p: Low) -> Bool { p.own.contains(where: \.ordered) }

private func size(_ axes: [Axis]) -> Int { axes.reduce(1) { $0 * $1.n } }

/// The axes a combination of values runs over, and the one each operand's own
/// axis stands for there (`unionAxes`). Multisets with different origins
/// cross; tuples never do: every tuple axis in a combination is the one axis
/// of positions.
func unionAxes(_ all: [[Axis]]) throws -> (union: [Axis], canon: (Axis) -> String) {
  var union: [Axis] = []
  var renamed: [String: String] = [:]
  for axes in all {
    for a in axes {
      var seen = union.first { $0.id == a.id }
      if seen == nil, a.ordered {
        seen = union.first(where: \.ordered)
        if let seen {
          if seen.n != a.n {
            throw LanguageError("Tuples of different lengths do not combine (\(seen.n) vs \(a.n)).")
          }
          renamed[a.id] = seen.id
          continue
        }
      }
      if let seen {
        if seen.n != a.n { throw LanguageError("Lists have different lengths (\(seen.n) vs \(a.n)).") }
      } else {
        union.append(a)
      }
    }
  }
  // The positions innermost: a multiset of tuples is stored tuple by tuple.
  if let positions = union.firstIndex(where: \.ordered) { union.append(union.remove(at: positions)) }
  let names = renamed
  return (union, { names[$0.id] ?? $0.id })
}

/// Bring operands onto one shared set of axes, so that combining them
/// elementwise is a plain zip again (`align`).
private func align(_ parts: [Low]) throws -> (parts: [Low], axes: [Axis]?) {
  let (union, canon) = try unionAxes(parts.filter(\.isSeq).map(\.own))
  if union.isEmpty { return (parts, nil) }
  let total = size(union)
  let out = try parts.map { p -> Low in
    guard p.isSeq else { return p }
    let own = p.own
    if own.count == union.count, zip(own, union).allSatisfy({ canon($0) == $1.id }) {
      // (A tuple met under another tuple's name is the same positions.)
      return Low(p.e, union, none: p.none)
    }
    let limit = p.isData ? DATA_MAX : ITEMS_MAX
    if total > limit {
      throw LanguageError(
        "Independent lists combine every value with every other — that is \(total) combinations "
          + "(limit \(limit)). Name one list and reuse it to pair values up instead.")
    }
    // Where each shared axis steps inside this operand (0: it does not vary).
    let strides = union.map { u -> Int in
      guard let at = own.firstIndex(where: { canon($0) == u.id }) else { return 0 }
      return size(Array(own[(at + 1)...]))
    }
    var index = [Int](repeating: 0, count: total)
    var counter = [Int](repeating: 0, count: union.count)
    var from = 0
    for k in 0..<total {
      index[k] = from
      var d = union.count - 1
      while d >= 0 {
        from += strides[d]
        counter[d] += 1
        if counter[d] < union[d].n { break }
        from -= strides[d] * counter[d]
        counter[d] = 0
        d -= 1
      }
    }
    let spread: Expr
    switch p.e {
    case .data(let values): spread = .data(values: index.map { values[$0] })
    case .text(let values): spread = .text(values: index.map { values[$0] })
    case .lazy(let cols, let body):
      spread = .lazy(
        cols: cols.map { c in Column(name: c.name, values: index.map { c.values[$0] }) }, body: body)
    case .list(let items): spread = .list(index.map { items[$0] })
    default: spread = p.e
    }
    return Low(spread, union)
  }
  return (out, union)
}

// MARK: - The lowering context

/// Looks a named list up; nil for a name that is not one. Throws when the
/// name clearly means a list but cannot produce one.
typealias GetList = (String) throws -> Low?

private final class Ctx {
  var getList: GetList
  let opts: ResolveOpts
  /// List elements materialized so far (ranges, zips, maps all count).
  var items = 0
  /// Numbers held in packed arrays built so far.
  var data = 0
  /// hist(…) nodes built: they are whole rows, not values.
  var hists = 0
  /// Point lists `comp` nodes pick from, lowered once however many ask.
  var comps: [(value: Expr, low: Low)] = []
  /// Columns templates have named so far.
  var columns = 0
  /// While a comparison lowers as a value, the lists its nodes lowered to:
  /// the multiset whose members it keeps is one of them (`comparisonValue`).
  var lowered: [(node: Expr, low: Low)]?
  /// Whether a member with no value ([none]) may be in reach.
  var none = false

  init(getList: @escaping GetList, opts: ResolveOpts) {
    self.getList = getList
    self.opts = opts
  }
}

private func num(_ value: Double) -> Expr { .num(value) }

private func listOf(_ items: [Expr], _ ctx: Ctx) throws -> Expr {
  ctx.items += items.count
  if ctx.items > ITEMS_MAX {
    throw LanguageError("This expression expands to too many list elements (limit \(ITEMS_MAX)).")
  }
  return .list(items)
}

private func dataOf(_ values: [Double], _ ctx: Ctx) throws -> Expr {
  ctx.data += values.count
  if ctx.data > DATA_MAX {
    throw LanguageError("This expression works over too much data (limit \(DATA_MAX) values).")
  }
  return .data(values: values)
}

private func tooMany(_ n: Int) -> LanguageError {
  LanguageError("That is \(n) values; only \(ITEMS_MAX) can be combined with sliders, t, or comparisons.")
}

/// Turn a packed array back into one expression per element, for operations
/// the fast path cannot carry (`expand`).
private func expand(_ p: Low) throws -> Low {
  switch p.e {
  case .data(let values):
    if values.count > ITEMS_MAX { throw tooMany(values.count) }
    return Low(.list(values.map(num)), p.axes)
  case .text(let values):
    if values.count > ITEMS_MAX { throw tooMany(values.count) }
    return Low(.list(values.map { .str($0) }), p.axes)
  case .lazy:
    if p.count > ITEMS_MAX { throw tooMany(p.count) }
    return Low(.list(instances(p.e)), p.axes)
  default:
    return p
  }
}

/// A lazy list's elements, one tree each: the template per instance.
private func instances(_ e: Expr) -> [Expr] {
  guard case .lazy(let cols, let body) = e else { return [] }
  let n = cols.first?.values.count ?? 0
  return (0..<n).map { k in
    var env: [String: Expr] = [:]
    for c in cols { env[c.name] = num(c.values[k]) }
    return substVars(body, env)
  }
}

/// A list's values as numbers, when that is all it holds.
private func numbersOf(_ p: Low) -> [Double]? {
  switch p.e {
  case .data(let values): return values
  case .list(let items):
    var out: [Double] = []
    out.reserveCapacity(items.count)
    for it in items {
      guard case .num(let value) = it else { return nil }
      out.append(value)
    }
    return out
  default: return nil
  }
}

/// Combine operands elementwise as one template over their packed columns,
/// when every list among them is numbers or already a template (`lazyMap`).
private func lazyMap(_ raw: [Low], _ build: ([Expr]) -> Expr, _ ctx: Ctx) throws -> Low? {
  var packed: [Low] = []
  var listy = false
  for p in raw {
    // Text only ever compares: zipN refuses it in arithmetic, in its words.
    if case .str = p.e { return nil }
    guard p.isSeq else {
      packed.append(p)
      continue
    }
    listy = true
    if case .lazy(_, let body) = p.e {
      // Arithmetic over a list of points is zipN's to refuse, in its words.
      if case .vec = body { return nil }
      packed.append(p)
      continue
    }
    guard let values = numbersOf(p) else { return nil }
    packed.append(p.isData ? p : Low(.data(values: values), p.axes))
  }
  if !listy { return nil }
  // A template still becomes one expression per element wherever it is
  // settled, so it may only span what the symbolic path could.
  let (union, _) = try unionAxes(packed.filter(\.isSeq).map(\.own))
  if size(union) > ITEMS_MAX { return nil }
  let (parts, axes) = try align(packed)
  var cols: [Column] = []
  let comps = parts.map { p -> Expr in
    switch p.e {
    case .lazy(let own, let body):
      for c in own where !cols.contains(where: { $0.name == c.name }) { cols.append(c) }
      return body
    case .data(let values):
      ctx.columns += 1
      let name = "@col\(ctx.columns)"
      cols.append(Column(name: name, values: values))
      return .var(name)
    default:
      return p.e
    }
  }
  return Low(.lazy(cols: cols, body: build(comps)), axes)
}

/// A lazy list as per-element trees, for operations that need elements as
/// nodes; everything else passes through (`settle`).
private func settle(_ p: Low, _ ctx: Ctx) throws -> Low {
  guard p.isLazy else { return p }
  if p.count > ITEMS_MAX { throw tooMany(p.count) }
  return Low(try listOf(instances(p.e), ctx), p.axes)
}

/// Combine operands elementwise as numbers, when they all are numbers:
/// packed arrays and literals only (`fastMap`).
private func fastMap(_ raw: [Low], _ f: ([Double]) -> Double, _ ctx: Ctx) throws -> Low? {
  for p in raw {
    if p.isData { continue }
    guard case .num = p.e else { return nil }
  }
  var n: Int?
  let (parts, axes) = try align(raw)
  for p in parts where p.isData {
    if let n, p.count != n { throw LanguageError("Lists have different lengths (\(n) vs \(p.count)).") }
    n = p.count
  }
  guard let n else { return nil }
  var out = [Double](repeating: 0, count: n)
  var xs = parts.map { p -> Double in if case .num(let value) = p.e { value } else { 0 } }
  let columns = parts.map { $0.isData ? $0.values : nil }
  for k in 0..<n {
    for (i, column) in columns.enumerated() {
      if let column { xs[i] = column[k] }
    }
    out[k] = f(xs)
  }
  return Low(try dataOf(out, ctx), axes)
}

private func binOp(_ op: BinOp) -> (Double, Double) -> Double {
  switch op {
  case .add: { $0 + $1 }
  case .sub: { $0 - $1 }
  case .mul: { $0 * $1 }
  case .div: { $0 / $1 }
  case .pow: realPow
  }
}

/// Members that are complex numbers, which have no order or spread along a
/// line (`re(z)` only passes through them) (`refuseComplex`).
private func refuseComplex(_ name: String, _ items: [Expr]) throws {
  if items.contains(where: isComplexValued) {
    throw LanguageError(
      "\(name)(…) takes real numbers, and these are complex: reduce them with abs(…), re(…) or im(…) first.")
  }
}

/// A comparison whose sides are real values reached through complex ones
/// (`re(L) > 0`), as their real parts (`realSides`).
private func realSides(_ cond: Expr, _ what: String) throws -> Expr {
  switch cond {
  case .ineq(let op, let l, let r, let grouped):
    return .ineq(op, try realSides(l, what), try realSides(r, what), grouped: grouped)
  case .eqtest(let op, let l, let r):
    var text = false
    if case .str = l { text = true }
    if case .str = r { text = true }
    // Complex numbers are equal when their difference is 0: |l - r| == 0.
    if !text, isComplexValued(l) || isComplexValued(r) {
      return .eqtest(op, try realValue(.call("abs", [.bin(.sub, l, r)]), what), .num(0))
    }
    func real(_ a: Expr) throws -> Expr { if case .str = a { a } else { try realValue(a, what) } }
    return .eqtest(op, try real(l), try real(r))
  default:
    return try realValue(cond, what)
  }
}

/// Evaluate a subexpression that must be a known number (range bounds,
/// indices) from constants and sliders (`constVal`).
private func constVal(_ expr: Expr, _ ctx: Ctx, _ what: String, whole: Bool = false) throws -> Double {
  // A real value reached through complex ones (|1 + i|) is its real part.
  let e = try realValue(expr, what)
  var env: [String: Double] = [:]
  for fv in freeVars(e) {
    guard let v = ctx.opts.consts(fv) else {
      if fv == "t" { throw LanguageError("\(what) cannot depend on t.") }
      throw LanguageError("\(what) must be constant — add \"\(fv) = 5\" in a row above.")
    }
    // Only what has to be an integer snaps its slider to whole numbers.
    if whole { ctx.opts.boundConsts?.names.insert(fv) }
    env[fv] = v
  }
  let v = try evaluate(e, env)
  if !v.isFinite { throw LanguageError("\(what) is not finite.") }
  return v
}

private func TUPLES_AND_OTHERS(_ width: Int) -> String {
  "A multiset of \(width)-tuples cannot also hold numbers or points: a tuple is one element, not its values."
}

/// Expand the items of a list literal: ranges become runs of numbers, with
/// the step set by the element just before the range (`expandItems`).
/// `width`: the length of the tuples it holds, when it holds tuples.
private func expandItems(_ raw: [Expr], _ ctx: Ctx) throws -> (items: [Expr], width: Int?) {
  var out: [Expr] = []
  var width: Int?
  /// Tuples among the items, and other things, for the one message.
  var tuples = 0
  for item in raw {
    guard case .range(let a, let b) = item else {
      let low = try lower(item, ctx)
      // A bracket is a multiset sum: a multiset among the items contributes
      // every one of its elements. A tuple is one element, not its
      // positions. (A tuple of 2 or 3 numbers is a point, and joins as one.)
      if low.isSeq {
        let axes = low.own
        let values = try expand(try settle(low, ctx)).items
        if let at = axes.firstIndex(where: \.ordered), at == axes.count - 1 {
          let w = axes[at].n
          let anyVec = values.contains { if case .vec = $0 { true } else { false } }
          if w <= 3 && !anyVec {
            var k = 0
            while k < values.count {
              out.append(.vec(Array(values[k..<min(k + w, values.count)])))
              k += w
            }
            continue
          }
          if let width, width != w {
            throw LanguageError("A multiset holds tuples of one length, not \(width) and \(w).")
          }
          width = w
          tuples += values.count / w
        }
        out.append(contentsOf: values)
      } else {
        out.append(low.e)
      }
      if let width, tuples * width != out.count { throw LanguageError(TUPLES_AND_OTHERS(width)) }
      continue
    }
    if let width { throw LanguageError(TUPLES_AND_OTHERS(width)) }
    // Not marked whole: a range bound is an ordinary number.
    let lo = try constVal(a, ctx, "A \"..\" range bound")
    let hi = try constVal(b, ctx, "A \"..\" range bound")
    var step: Double = hi >= lo ? 1 : -1
    if let last = out.last {
      // The element before the range sets the step, so it needs a value at
      // expansion time — a constant or a slider counts.
      let prev = try constVal(last, ctx, "The element before a \"..\" range (it sets the step)")
      step = lo - prev
      if step == 0 { throw LanguageError("The \"..\" range step is zero.") }
      if (hi - lo) / step < -1e-9 {
        throw LanguageError("The \"..\" range step points away from its end value.")
      }
    }
    let count = ((hi - lo) / step + 1e-9).rounded(.down) + 1
    if count > Double(RANGE_MAX) {
      throw LanguageError(
        "[\(JS.string(lo))..\(JS.string(hi))] expands to \(JS.string(count)) elements (limit \(RANGE_MAX)).")
    }
    var k = 0.0
    while k < count {
      out.append(num(lo + k * step))
      k += 1
    }
  }
  return (out, width)
}

private func isEquality(_ e: Expr) -> Bool { if case .eqtest = e { true } else { false } }

/// A comparison over a list is a mask — the thing a filter selects with. It
/// is not a value: only indexing consumes one (`isMask`).
private func isMask(_ p: Low) -> Bool {
  guard case .list(let items) = p.e, !items.isEmpty else { return false }
  return items.allSatisfy {
    switch $0 {
    case .ineq, .eqtest: true
    default: false
    }
  }
}

/// Combine lowered operands elementwise: same-axis lists zip, independent
/// lists cross, scalars broadcast (`zipN`).
private func zipN(_ raw: [Low], _ build: ([Expr]) -> Expr, _ ctx: Ctx) throws -> Low {
  // Nearly every node of nearly every row: no list in sight, nothing to align.
  if !raw.contains(where: \.isSeq) { return Low(build(raw.map(\.e))) }
  var n: Int?
  let (parts, axes) = try align(raw)
  for p in parts where p.isList {
    if let n, p.count != n { throw LanguageError("Lists have different lengths (\(n) vs \(p.count)).") }
    n = p.count
  }
  guard let n else { return Low(build(parts.map(\.e))) }
  // A mask only ever grows into a longer comparison chain; anything else
  // built from one is arithmetic on a filter. Text is the same shape of
  // mistake: only a comparison may consume it.
  let masked = parts.contains(where: isMask)
  let textual = parts.contains { p in
    if case .str = p.isList ? p.items.first : p.e { true } else { false }
  }
  let columns = parts.map { $0.isList ? $0.items : nil }
  var items: [Expr] = []
  items.reserveCapacity(n)
  for k in 0..<n {
    var comps: [Expr] = []
    for (i, column) in columns.enumerated() {
      guard let column else {
        comps.append(parts[i].e)
        continue
      }
      // An element that is itself a point cannot feed scalar operations or
      // nest inside another point.
      if case .vec = column[k] {
        throw LanguageError(
          "Arithmetic over a list of points is not supported yet — operate on coordinate lists instead.")
      }
      comps.append(column[k])
    }
    let built = build(comps)
    if masked {
      guard case .ineq = built else {
        throw LanguageError(
          "A comparison over a list is a filter, not a value — put it in brackets, like L[L > 2].")
      }
    }
    if textual && !isEquality(built) {
      throw LanguageError("Text has no numeric value — it can only be compared, inside a filter.")
    }
    items.append(built)
  }
  return Low(try listOf(items, ctx), axes)
}

/// Rounding one equation allows (lib/expr.ts `sameNumber`).
private func sameNumber(_ a: Double, _ b: Double) -> Bool {
  a == b || (a.isFinite && b.isFinite && abs(a - b) <= 8 * Double.ulpOfOne * JS.max([1, abs(a), abs(b)]))
}

/// Whether one comparison (or a chain like 18 <= a < 65) holds (`holds`).
private func holds(_ cond: Expr, _ env: [String: Double]) throws -> Bool {
  if case .eqtest(let op, let l, let r) = cond {
    // Text compares as text and numbers as numbers; the two never match.
    var texts: [String?] = [nil, nil]
    if case .str(let s) = l { texts[0] = s }
    if case .str(let s) = r { texts[1] = s }
    if texts[0] != nil || texts[1] != nil {
      // A blank cell is text's NaN, so it fails every test including `!=`.
      if texts[0] == "" || texts[1] == "" { return false }
      // …and a numeric gap on the other side is still a gap.
      for (side, text) in zip([l, r], texts) where text == nil {
        if try evaluate(side, env).isNaN { return false }
      }
      let same = texts[0] != nil && texts[0] == texts[1]
      return op == .eq ? same : !same
    }
    let a = try evaluate(l, env)
    let b = try evaluate(r, env)
    // A missing cell (NaN) fails every test, `!=` included.
    if a.isNaN || b.isNaN { return false }
    let same = sameNumber(a, b)
    return op == .eq ? same : !same
  }
  for (op, l, r) in ineqComparisons(cond) {
    let a = try evaluate(l, env)
    let b = try evaluate(r, env)
    let ok =
      switch op {
      case .lt: a < b
      case .le: a <= b
      case .gt: a > b
      case .ge: a >= b
      }
    if !ok { return false }
  }
  return true
}

/// A member a guard decided has no value: one holding [none], through any
/// arithmetic or coordinate. (Not inside a case: a case that moves with t
/// may not reach it.)
private func undefinedMember(_ e: Expr) -> Bool {
  if case .call(NONE, _) = e { return true }
  if case .piecewise = e { return false }
  return childrenOf(e).contains(where: undefinedMember)
}

/// Settle a list of piecewise members whose conditions are constant: each
/// becomes the value of the case that holds, or [none] where none does
/// (`decideMembers`). What depends on t stays a piecewise.
private func decideMembers(_ items: [Expr], _ axes: [Axis], _ ctx: Ctx) throws -> Low {
  let none = Expr.call(NONE, [])
  enum Decision { case yes, no, none, moving }
  func decide(_ cond: Expr) throws -> Decision {
    if undefinedMember(cond) { return .none }
    switch cond {
    case .ineq, .eqtest: break
    default: return .moving
    }
    var env: [String: Double] = [:]
    for fv in freeVars(cond) {
      guard let v = ctx.opts.consts(fv) else { return .moving }
      env[fv] = v
    }
    return try holds(cond, env) ? .yes : .no
  }
  // What stays a case evaluates as it runs, where a case is an inequality:
  // an equality of numbers there is the tolerance form (`exactCase`).
  func running(_ cond: Expr) -> Expr {
    if case .eqtest(.eq, let l, let r) = cond {
      if case .str = l { return cond }
      if case .str = r { return cond }
      return exactCase(l, r)
    }
    return cond
  }
  let out = try items.map { item -> Expr in
    guard case .piecewise(let cases, let otherwise) = item else { return item }
    var rest: [Expr.Case] = []
    ctx.none = true
    for c in cases {
      switch try decide(c.cond) {
      case .no: continue
      // A condition on a member with no value has none either.
      case .none: return rest.isEmpty ? none : .piecewise(rest, otherwise: none)
      case .yes: return rest.isEmpty ? c.value : .piecewise(rest, otherwise: c.value)
      case .moving: rest.append(Expr.Case(cond: running(c.cond), value: c.value))
      }
    }
    if rest.isEmpty { return otherwise ?? none }
    return .piecewise(rest, otherwise: otherwise)
  }
  return Low(try listOf(out, ctx), axes)
}

/// Collect a multiset: a member no case of a guard holds for is not in it
/// (`dropUndefined`). `cols`: the lists that pair up member by member (one,
/// or a list and its sort key); a whole member goes from each at once.
private func dropUndefined(_ cols: [Low], _ ctx: Ctx) throws -> [Low] {
  // Only a guard makes a member with no value.
  guard ctx.none, let first = cols.first, cols.allSatisfy(\.isList) else { return cols }
  let total = first.count
  if total == 0 || cols.contains(where: { $0.count != total }) { return cols }
  let own = first.own
  // A multiset of tuples, the positions stored innermost, goes a whole tuple
  // at a time; a lone tuple keeps its order, as a filter of one does.
  let positions = own.count > 1 && own.last!.ordered ? own.last : nil
  let width = positions?.n ?? 1
  if positions == nil, own.contains(where: \.ordered), own.count > 1 { return cols }
  let n = total / width
  let columns = cols.map(\.items)
  let keep = (0..<n).map { j in
    (0..<width).allSatisfy { w in columns.allSatisfy { !undefinedMember($0[j * width + w]) } }
  }
  if keep.allSatisfy({ $0 }) { return cols }
  let kept = keep.filter { $0 }.count
  let tuple = own.count == 1 && own[0].ordered
  let members = positions != nil ? Array(own.dropLast()) : own
  let cut: [Axis] =
    tuple
    ? [tupleAxis(kept)]
    : [
      Axis(
        id: "\(members.map(\.id).joined(separator: "×")){\(keep.map { $0 ? "1" : "0" }.joined())}", n: kept)
    ] + (positions.map { [$0] } ?? [])
  return try columns.map { items in
    Low(try listOf(items.enumerated().filter { keep[$0.offset / width] }.map(\.element), ctx), cut)
  }
}

private func dropUndefined(_ p: Low, _ ctx: Ctx) throws -> Low {
  try dropUndefined([p], ctx)[0]
}

/// Lower a filter's condition and decide it, for a caller that filters
/// something other than a list — `adults = person[person.age >= 18]` cuts a
/// whole data file (Tables.swift). Nil when the condition is not a comparison
/// over a list (`lowerMask`).
func lowerMask(_ cond: Expr, _ getList: @escaping GetList, _ opts: ResolveOpts) throws -> [Bool]? {
  try maskValues(try lowerCond(cond, Ctx(getList: getList, opts: opts)), opts)
}

/// Decide a mask, element by element (`maskValues`). A filter has to settle
/// at lowering time, so conditions read constants and sliders but not t.
private func maskValues(_ mask: Low, _ opts: ResolveOpts) throws -> [Bool]? {
  guard isMask(mask) else { return nil }
  return try mask.items.map { cond in
    let cond = try realSides(cond, "A filter")
    var env: [String: Double] = [:]
    for fv in freeVars(cond) {
      guard let v = opts.consts(fv) else {
        throw LanguageError(
          fv == "t"
            ? "A filter cannot depend on t — the list would change length every frame."
            : "A filter must be constant — add \"\(fv) = 5\" in a row above.")
      }
      env[fv] = v
    }
    return try holds(cond, env)
  }
}

/// Whether an element carries a missing cell (`holdsGap`): a gap is stored
/// as NaN, and NaN poisons every operation it reaches.
private func holdsGap(_ e: Expr) -> Bool {
  switch e {
  case .num(let value): value.isNaN
  case .data(let values): values.contains(where: \.isNaN)
  case .neg(let a): holdsGap(a)
  case .bin(_, let a, let b, _), .eq(let a, let b), .ineq(_, let a, let b, _): holdsGap(a) || holdsGap(b)
  case .call(_, let items), .vec(let items), .list(let items): items.contains(where: holdsGap)
  case .piecewise(let cases, let otherwise):
    cases.contains { holdsGap($0.cond) || holdsGap($0.value) } || (otherwise.map(holdsGap) ?? false)
  default: false
  }
}

/// Numeric values of a constant list, for order-dependent reductions.
private func numericItems(_ items: [Expr], _ ctx: Ctx, _ name: String) throws -> [Double] {
  try items.map { try constVal($0, ctx, "\(name)(…) needs a constant list, so each element") }
}

private func noValues(_ name: String) -> LanguageError {
  LanguageError("\(name)(…) has no values to work with — every cell there is missing.")
}

private func median(_ sorted: [Double]) -> Double {
  let n = sorted.count
  return n % 2 == 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
}

/// Reductions straight off a packed array: no expression tree at all
/// (`reduceData`).
private func reduceData(_ name: String, _ all: [Double], _ ctx: Ctx) throws -> Expr {
  // `count` asks how many rows there are, gaps included. Every other
  // reduction answers about the values that are there.
  if name == "count" { return num(Double(all.count)) }
  let xs = all.contains(where: \.isNaN) ? all.filter { !$0.isNaN } : all
  let n = xs.count
  if n == 0 { throw noValues(name) }
  switch name {
  case "total", "mean":
    var sum = 0.0
    for x in xs { sum += x }
    return num(name == "total" ? sum : sum / Double(n))
  case "min":
    return num(xs.dropFirst().reduce(xs[0]) { JS.min([$0, $1]) })
  case "max":
    return num(xs.dropFirst().reduce(xs[0]) { JS.max([$0, $1]) })
  case "stdev":
    if n < 2 { throw LanguageError("stdev needs at least 2 elements.") }
    var sum = 0.0
    for x in xs { sum += x }
    let mean = sum / Double(n)
    var sq = 0.0
    for x in xs { sq += (x - mean) * (x - mean) }
    return num((sq / Double(n - 1)).squareRoot())
  case "median":
    return num(median(xs.sorted()))
  case "sort":
    return try dataOf(xs.sorted(), ctx)
  default:
    throw LanguageError("Unknown reduction: \(name).")
  }
}

/// Combine a list into one expression as a balanced tree, pairing neighbours
/// and halving until one is left (`fold`): the depth is log₂ n.
private func fold(_ items: [Expr], _ join: (Expr, Expr) -> Expr) -> Expr? {
  if items.isEmpty { return nil }
  var level = items
  while level.count > 1 {
    var next: [Expr] = []
    var k = 0
    while k < level.count {
      next.append(k + 1 < level.count ? join(level[k], level[k + 1]) : level[k])
      k += 2
    }
    level = next
  }
  return level[0]
}

private let SORT_POINTS =
  "Points have no order of their own — sort them by a key written in the list: sort(P, P.x)."
private func SORT_TUPLES(_ width: Int) -> String {
  "sort(…) of a multiset of \(width)-tuples is not defined — a tuple is one element, not its values; "
    + "only count, total and mean are."
}

private func isVec(_ e: Expr) -> Bool { if case .vec = e { true } else { false } }
private func vecItems(_ e: Expr) -> [Expr] { if case .vec(let items) = e { items } else { [] } }

private func reduce(_ name: String, _ all: [Expr], _ ctx: Ctx) throws -> Expr {
  // `count` asks how many, not what they are.
  if name == "count" { return num(Double(all.count)) }
  if all.contains(where: isVec) {
    if name == "sort" { throw LanguageError(SORT_POINTS) }
    // A total or mean of points is taken coordinate by coordinate.
    if (name == "total" || name == "mean") && all.allSatisfy(isVec) {
      let dims = vecItems(all[0]).count
      if all.contains(where: { vecItems($0).count != dims }) {
        throw LanguageError("All points in a list need the same number of coordinates.")
      }
      return .vec(try (0..<dims).map { k in try reduce(name, all.map { vecItems($0)[k] }, ctx) })
    }
    throw LanguageError("\(name)(…) over a list of points is not supported yet.")
  }
  // Gaps leave the same way they leave a packed array (reduceData).
  let items = all.filter { !holdsGap($0) }
  let n = items.count
  // The empty multiset `[]`: a sum over nothing is 0; anything that picks or
  // averages a value has none to pick.
  if all.isEmpty {
    if name == "total" { return num(0) }
    if name == "sort" { return try listOf([], ctx) }
    throw LanguageError("\(name)(…) of an empty list has no value.")
  }
  if n == 0 { throw noValues(name) }
  switch name {
  case "total", "mean":
    let acc = fold(items, add) ?? num(0)
    return name == "total" ? acc : div(acc, num(Double(n)))
  case "min", "max":
    return fold(items) { .call(name, [$0, $1]) }!
  case "stdev":
    if n < 2 { throw LanguageError("stdev needs at least 2 elements.") }
    let xs = try numericItems(items, ctx, name)
    let mean = xs.reduce(0, +) / Double(n)
    return num((xs.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / Double(n - 1)).squareRoot())
  case "median":
    return num(median(try numericItems(items, ctx, name).sorted()))
  case "sort":
    return try listOf(try numericItems(items, ctx, name).sorted().map(num), ctx)
  default:
    throw LanguageError("Unknown reduction: \(name).")
  }
}

/// `sort(P, key)`: the elements of P as a tuple, in ascending order of the
/// key (`sortBy`). The key is written in P, so it runs over the very same
/// instances and each element carries its own key.
private func sortBy(_ p: Low, _ key: Low, _ ctx: Ctx) throws -> Low {
  let usage = "sort(P, key) orders P by a key written in P, like sort(P, P.x)."
  let scatter = isDataScatter(p.e)
  guard scatter || p.isSeq else { throw LanguageError(usage) }
  let own = p.own
  if p.isText { throw LanguageError("sort(…) orders numbers or points; that column holds text.") }
  // Identical, not merely as long: a key from another list would pair up
  // elements that have nothing to do with each other.
  let keyAxes = key.isSeq ? key.own : []
  if !key.isSeq || keyAxes.isEmpty || keyAxes.contains(where: { a in !own.contains { $0.id == a.id } }) {
    throw LanguageError(
      "The sort key has to be written in the list it sorts, so each element carries its own: sort(P, P.x).")
  }
  let n = size(own)
  let same = keyAxes.count == own.count && zip(keyAxes, own).allSatisfy { $0.id == $1.id }
  let spread =
    same ? key : try align([Low(.data(values: [Double](repeating: 0, count: n)), own), key]).parts[1]
  let keys = try sortKeys(spread, ctx)
  // Stable, and a missing key (a gap) leaves its element out, as sort(L) does.
  var order = (0..<n).filter { !keys[$0].isNaN }
  order.sort { keys[$0] != keys[$1] ? keys[$0] < keys[$1] : $0 < $1 }
  let axes = [tupleAxis(order.count)]
  func pick(_ values: [Double]) -> [Double] { order.map { values[$0] } }
  if scatter, case .vec(let items) = p.e {
    return Low(
      .vec(
        try items.map { it in
          if case .data(let values) = it { return try dataOf(pick(values), ctx) }
          return it
        }), axes)
  }
  switch p.e {
  case .data(let values):
    return Low(try dataOf(pick(values), ctx), axes)
  case .lazy(let cols, let body):
    return Low(.lazy(cols: cols.map { Column(name: $0.name, values: pick($0.values)) }, body: body), axes)
  default:
    let items = p.items
    return Low(try listOf(order.map { items[$0] }, ctx), axes)
  }
}

/// A sort key's value per element, from constants and sliders like a filter's.
private func sortKeys(_ key: Low, _ ctx: Ctx) throws -> [Double] {
  if key.isData { return key.values }
  if key.isText { throw LanguageError("A sort key has to be a number; that column holds text.") }
  var env: [String: Double] = [:]
  func bind(_ e: Expr) throws {
    for fv in freeVars(e) where env[fv] == nil && !fv.hasPrefix("@") {
      guard let v = ctx.opts.consts(fv) else {
        throw LanguageError(
          fv == "t"
            ? "A sort key cannot depend on t — the order would change every frame."
            : "A sort key must be constant — add \"\(fv) = 5\" in a row above.")
      }
      env[fv] = v
    }
  }
  if case .lazy(let cols, let raw) = key.e {
    let body = try realValue(raw, "A sort key")
    try bind(body)
    var out = [Double](repeating: 0, count: key.count)
    for k in 0..<out.count {
      for c in cols { env[c.name] = c.values[k] }
      out[k] = try evaluate(body, env)
    }
    return out
  }
  return try key.items.map { item in
    if isVec(item) { throw LanguageError("A sort key has to be a number per element, like P.x.") }
    let it = try realValue(item, "A sort key")
    try bind(it)
    return try evaluate(it, env)
  }
}

/// A point, or a multiset of them: an element of a tuple of points.
private func isPointValue(_ p: Low) -> Bool {
  switch p.e {
  case .vec: return true
  case .list(let items): return items.first.map(isVec) ?? false
  case .lazy(_, let body): return isVec(body)
  default: return false
  }
}

/// A tuple literal that is not a point: `(1, 2, 3, 5, 8)`, or a tuple of
/// points (`tupleOf`). Its positions are one tuple axis; a multiset among its
/// items makes a multiset of tuples, the tuple axis innermost.
private func tupleOf(_ items: [Low], _ ctx: Ctx) throws -> Low {
  let n = items.count
  if items.contains(where: isTuple) {
    throw LanguageError(
      "A tensor over a list — a tuple of tuples with a list inside — is not supported yet: "
        + "take one element at a time, or write the tensor out on a row of its own.")
  }
  let (parts, axes) = try align(items.map { isDataScatter($0.e) ? scatterPoints($0) : $0 })
  guard let axes else { return Low(try listOf(parts.map(\.e), ctx), [tupleAxis(n)]) }
  let total = size(axes)
  let columns = try parts.map { p -> [Expr]? in p.isSeq ? try expand(try settle(p, ctx)).items : nil }
  var out: [Expr] = []
  out.reserveCapacity(total * n)
  for c in 0..<total {
    for k in 0..<n { out.append(columns[k]?[c] ?? parts[k].e) }
  }
  return Low(try listOf(out, ctx), axes + [tupleAxis(n)])
}

/// A scatter of columns as one point per row, over the columns' instances.
func scatterPoints(_ p: Low) -> Low {
  guard case .vec(let items) = p.e else { return p }
  let n = scatterLength(p.e)
  let points = (0..<n).map { k in
    Expr.vec(items.map { c in if case .data(let values) = c { num(values[k]) } else { c } })
  }
  return Low(.list(points), p.axes)
}

/// Bins for n values, when the row did not say: about √n, kept readable.
private func binCount(_ n: Int) -> Int { min(60, max(5, Int(JS.round(Double(n).squareRoot())))) }

/// Bin values into a histogram (`histBars`): a node carrying centers, counts
/// and one bin width, which classify turns into a bar row. It is not a
/// value, so it may not feed anything else.
private func histBars(_ centers: [Double], _ counts: [Double], _ width: Double, _ ctx: Ctx) throws -> Expr {
  ctx.hists += 1
  _ = try dataOf(centers, ctx)
  _ = try dataOf(counts, ctx)
  return .hist(centers: centers, counts: counts, width: width)
}

/// `hist(L) / 1000`, `0.001 hist(L)` — scale the bars (`scaleHist`).
private func scaleHist(_ op: BinOp, _ a: Expr, _ b: Expr, _ ctx: Ctx) throws -> Expr? {
  let hist: Expr
  let other: Expr
  let first: Bool
  if case .hist = a {
    (hist, other, first) = (a, b, true)
  } else if case .hist = b {
    (hist, other, first) = (b, a, false)
  } else {
    return nil
  }
  guard case .hist(let centers, let counts, let width) = hist, case .num(let value) = other,
    op == .mul || (op == .div && first)
  else { throw LanguageError("hist(…) is a whole plot — it can only be scaled, as hist(L)/1000.") }
  let factor = op == .mul ? value : 1 / value
  // The original bars were counted once; only their heights change.
  ctx.hists -= 1
  return try histBars(centers, counts.map { $0 * factor }, width, ctx)
}

private func histogram(_ xs: [Double], _ bins: Int?, _ ctx: Ctx) throws -> Expr {
  let finite = xs.filter(\.isFinite)
  guard var lo = finite.first else { throw LanguageError("hist(…) needs at least one value.") }
  var hi = lo
  for v in finite {
    if v < lo { lo = v }
    if v > hi { hi = v }
  }
  // Every value identical: one bin, a unit wide, centred on the value.
  if hi == lo { return try histBars([lo], [Double(finite.count)], 1, ctx) }
  let k = bins ?? binCount(finite.count)
  let width = (hi - lo) / Double(k)
  var counts = [Double](repeating: 0, count: k)
  for v in finite {
    // The top edge belongs to the last bin, not to a bin past the end.
    counts[min(k - 1, Int(((v - lo) / width).rounded(.down)))] += 1
  }
  let centers = (0..<k).map { lo + (Double($0) + 0.5) * width }
  return try histBars(centers, counts, width, ctx)
}

/// The spelling of a filter's test that names its cut (lib/list.ts `cutBy`):
/// the same cut of the same list is the same instances, however many times
/// it is written. Packed numbers and a literal's identity are left out.
private func testKey(_ e: Expr) -> String {
  func plain(_ e: Expr) -> Expr {
    switch e {
    case .data: return .data(values: [])
    case .lazy(let cols, let body): return .lazy(cols: cols.map { Column(name: $0.name, values: []) }, body: body)
    default:
      if let literal = listLiteral(e) { return .list(literal.items.map(plain)) }
      if let settled = settledList(e) { return plain(settled.e) }
      return mapChildren(e, plain)
    }
  }
  return exprKey(plain(e))
}

/// Keep the elements of a list where a filter holds (`cutBy`).
private func cutBy(_ low: Low, _ keep: [Bool], _ idx: Expr, _ ctx: Ctx) throws -> Low {
  let kept = keep.filter { $0 }.count
  let test = testKey(idx)
  // (A filter keeps the order of what it filters: a cut of a tuple is one.)
  let own = low.own
  let cut: [Axis]? =
    own.count == 1 && own[0].ordered
    ? [tupleAxis(kept)]
    : test.utf16.count > 4096
      ? nil : [Axis(id: "\(own.map(\.id).joined(separator: "×"))[\(test)]", n: kept)]
  func pick<T>(_ values: [T]) -> [T] { values.enumerated().filter { keep[$0.offset] }.map(\.element) }
  switch low.e {
  case .data(let values): return Low(try dataOf(pick(values), ctx), cut)
  case .text(let values): return Low(.text(values: pick(values)), cut)
  default: return Low(try listOf(pick(low.items), ctx), cut)
  }
}

/// Position k (1-based, whole) inside each of a multiset's tuples or points.
private func positionIn(
  _ idx: Expr, _ n: Int, _ has: String, _ what: String, _ name: String, _ ctx: Ctx
) throws -> Int {
  let v = try constVal(idx, ctx, "A list index", whole: true)
  let k = JS.round(v)
  if abs(v - k) > 1e-9 { throw LanguageError("List indices must be whole numbers.") }
  if k == 0 { throw LanguageError("Positions are 1-based: the first is \(name)[1].") }
  if k < 1 || k > Double(n) {
    throw LanguageError("Index \(JS.string(k)) is out of range — \(has) \(n) \(what).")
  }
  return Int(k)
}

/// Bind a function's parameter(s) to one member: `p` (and `p.x`… of a
/// point), or "x,y" spread over a point's coordinates (`bindMember`).
private func bindMember(_ env: inout [String: Expr], _ names: [String], _ member: Expr, _ bare: NameSet) throws {
  if names.count == 1 {
    let p = names[0]
    // Point arithmetic is lowered before lists are, so a body applied per
    // point works on its coordinates, not on the point whole.
    if isVec(member), bare.contains(p) {
      throw LanguageError(
        "A function applied per point of a list reads its coordinates: write p.x and p.y for a parameter p, "
          + "or take them as parameters, f(x, y).")
    }
    env[p] = member
    for (k, c) in vecItems(member).prefix(3).enumerated() { env["\(p).\(["x", "y", "z"][k])"] = c }
    return
  }
  guard isVec(member), vecItems(member).count == names.count else {
    throw LanguageError("This takes a point of \(names.count) coordinates, one per parameter.")
  }
  for (p, c) in zip(names, vecItems(member)) { env[p] = c }
}

private func splitComma(_ s: String) -> [String] {
  var out: [String] = [""]
  for u in s.unicodeScalars {
    if u == "," { out.append("") } else { out[out.count - 1].unicodeScalars.append(u) }
  }
  return out
}

/// The part of a dotted name before its first dot (`name.split('.')[0]`).
func dottedHead(_ name: String) -> String {
  let u = Array(name.utf16)
  guard let dot = u.firstIndex(of: unit(".")) else { return name }
  return String(decoding: u[..<dot], as: UTF16.self)
}

/// A function applied per member of its list arguments ([map], `lowerMap`):
/// the body once per combination of members, as any operation combines (the
/// same list zips, separate ones cross), collected over those arguments' own
/// instances. The body's own lists are its own: a reduction in it consumes
/// them, never the argument.
private func lowerMap(_ args: [Expr], _ ctx: Ctx) throws -> Low {
  guard args.count >= 2, case .str(let fn) = args[0] else { throw LanguageError("Unknown function: \(MAP)") }
  let raw = args[1]
  var binds: [(names: [String], low: Low)] = []
  var k = 2
  while k + 1 < args.count {
    guard case .str(let names) = args[k] else { break }
    let low = try lower(args[k + 1], ctx)
    binds.append((splitComma(names), isDataScatter(low.e) ? scatterPoints(low) : low))
    k += 2
  }
  let params = Set(binds.flatMap(\.names))
  func mentions(_ x: Expr) -> Bool { freeVars(x).contains { params.contains(dottedHead($0)) } }
  // A reduction that mentions no parameter is the same for every member: it
  // is taken once, not once per member.
  func hoist(_ x: Expr) throws -> Expr {
    if case .call(let name, let inner) = x, reducesMembers(name, inner.count), !mentions(x) {
      let low = try lower(x, ctx)
      if !low.isSeq { return low.e }
    }
    return try mapChildren(x, hoist)
  }
  // An error inside says where it happened, and what reduces the list itself.
  func member<T>(_ run: () throws -> T) throws -> T {
    do {
      return try run()
    } catch let error as Unsupported {
      throw error
    } catch {
      throw LanguageError(
        "\(errorMessage(error)) (\(fn) applies per member of its list argument; "
          + "to reduce the list itself, write the reduction in the row.)")
    }
  }
  let body = try hoist(raw)
  let bare = freeVars(body)
  var fixed: [String: Expr] = [:]
  for b in binds where !b.low.isSeq { try bindMember(&fixed, b.names, b.low.e, bare) }
  let seqs = binds.filter(\.low.isSeq)
  if seqs.isEmpty { return try member { try decideOne(try lower(substVars(body, fixed), ctx), ctx) } }
  let (parts, joined) = try align(try seqs.map { try expand(try settle($0.low, ctx)) })
  let axes = joined ?? []
  let members = parts.map(\.items)
  let argStride = axes.indices.map { d in size(Array(axes[(d + 1)...])) }
  // The parameters are names no document spells, so they shadow nothing;
  // the lookups here are only for their coordinates.
  let getList = ctx.getList
  ctx.getList = { name in params.contains(dottedHead(name)) ? nil : try getList(name) }
  defer { ctx.getList = getList }
  var out: [Expr] = []
  var inner: [Axis]??
  // Tuples meet by position, whichever member made them.
  func shape(_ axes: [Axis]) -> String { axes.map { $0.ordered ? "o\($0.n)" : $0.id }.joined(separator: ",") }
  var work = 0
  var poured = false
  for i in 0..<members[0].count {
    var env = fixed
    for (j, b) in seqs.enumerated() { try bindMember(&env, b.names, members[j][i], bare) }
    // What one member's body builds along the way is not kept: only the
    // result counts against the budget, and the whole map against its own.
    let (items, data) = (ctx.items, ctx.data)
    var r = try member { try decideOne(try lower(substVars(body, env), ctx), ctx) }
    work += ctx.items - items + (ctx.data - data)
    ctx.items = items
    ctx.data = data
    // (The first member says what all of them will cost: refuse at once.)
    if work > MAP_WORK || (i == 0 && work * members[0].count > MAP_WORK) {
      throw LanguageError("\(fn), applied per member, does more than \(MAP_WORK) steps of list work.")
    }
    var own: [Axis]? = r.isSeq ? r.own : nil
    var values: [Expr]?
    if let mine = own {
      let flat = try settle(r, ctx)
      var all = flat.isData ? flat.values.map(num) : try expand(flat).items
      // A list the call maps over, met again in the body: this member's own
      // element of it, not all of them.
      let shared = mine.map { a in axes.firstIndex { $0.id == a.id } }
      if shared.contains(where: { $0 != nil }) {
        let ownStride = mine.indices.map { d in size(Array(mine[(d + 1)...])) }
        func at(_ d: Int) -> Int { (i / argStride[d]) % axes[d].n }
        all = all.enumerated().filter { j, _ in
          shared.enumerated().allSatisfy { k, d in d == nil || (j / ownStride[k]) % mine[k].n == at(d!) }
        }.map(\.element)
        let rest = mine.enumerated().filter { shared[$0.offset] == nil }.map(\.element)
        if rest.isEmpty {
          r = Low(all[0])
          own = nil
        } else {
          own = rest
          values = all
        }
      } else {
        values = all
      }
    }
    if let seen = inner, (seen == nil) != (own == nil) {
      throw LanguageError("\(fn) gives a list for some members and a number for others.")
    }
    // Lists of the body's own (a literal, a new box per member) share no
    // instances across members: poured together, a multiset of their own.
    if let seen = inner, let seen, let own, shape(seen) != shape(own) { poured = true }
    if inner == nil { inner = .some(own) }
    if let values { out.append(contentsOf: values) } else { out.append(r.e) }
  }
  if poured { return Low(try listOf(out, ctx), nil) }
  let own = inner.flatMap { $0 } ?? []
  return Low(try listOf(out, ctx), axes + own)
}

/// A member's value decided where its cases are constant: the case that
/// holds, or [none] where none does, as over a list (`decideOne`).
private func decideOne(_ r: Low, _ ctx: Ctx) throws -> Low {
  guard case .piecewise = r.e else { return r }
  let d = try decideMembers([r.e], [Axis(id: "#member", n: 1)], ctx)
  return Low(d.items[0])
}

/// What `L[k]` says when L is a multiset: it has no positions, and sort is
/// the way to give it some (`needsOrder`).
private func needsOrder(_ target: Expr, _ idx: Expr, _ low: Low) -> String {
  func spelled(_ fallback: String) -> String {
    if case .num(let value) = idx { JS.string(value) } else { fallback }
  }
  // A state family's runs are in order only when their starts are (StateFamilies.swift).
  if low.own.first?.id.hasSuffix("#runs") == true {
    let name: String = if case .var(let name) = target { name } else { "p" }
    let k = spelled("k")
    return "\(name)[\(k)] needs an order — its runs start from a list [ … ], which has none. Start them from a "
      + "tuple to number them: \(name)(0) = (sort([1..4]), 0)."
  }
  let points = low.items.first.map(isVec) ?? false
  if listLiteral(target) != nil {
    let k = spelled("k")
    return "[ … ][\(k)] needs an order — a list [ … ] has none. Sort it: "
      + "\(points ? "sort(P, P.x)" : "sort([ … ])")[\(k)]."
  }
  let name: String = if case .var(let name) = target { name } else { "L" }
  return orderMessage(name, idx, points)
}

/// The words of needsOrder, for a caller that knows the shape without the
/// values (`orderMessage`).
func orderMessage(_ name: String, _ idx: Expr, _ points: Bool) -> String {
  let k: String =
    switch idx {
    case .num(let value): JS.string(value)
    case .var(let name): name
    default: "k"
    }
  let u = Array(name.utf16)
  let sorted: String
  if points {
    sorted = "sort(\(name), \(name).x)"
  } else if let dot = u.firstIndex(of: unit(".")), dot > 0 {
    sorted = "sort(\(name), \(String(decoding: u[..<dot], as: UTF16.self)).row)"
  } else {
    sorted = "sort(\(name))"
  }
  return "\(name)[\(k)] needs an order — a list [ … ] has none. Sort it: \(sorted)[\(k)]."
}

private func lowerIndex(_ target: Expr, _ idx: Expr, _ ctx: Ctx) throws -> Low {
  // Before anything is lowered: what the index's shape alone decides.
  if let issue = ctx.opts.indexIssue?(idx, target) { throw LanguageError(issue) }
  let lowered = try settle(try lower(target, ctx), ctx)
  // A point is a tuple of its coordinates: a named one, T = (3, 1, 2),
  // reaches here as (T_x, T_y, T_z) and T[2] is T_y.
  var point: Low?
  if case .var(let name) = lowered.e, let comps = ctx.opts.comps(name) {
    point = Low(.list(comps.map { .var($0) }), [tupleAxis(comps.count)])
  } else if case .vec(let items) = lowered.e, !isDataScatter(lowered.e),
    items.allSatisfy({ !isVec($0) && !isSeq($0) })
  {
    point = Low(.list(items), [tupleAxis(items.count)])
  }
  let low = point ?? (isDataScatter(lowered.e) ? scatterPoints(lowered) : lowered)
  guard low.isSeq else {
    // A function's parameter indexes (p[2]); called with a number, there is
    // no position to read, and a product is written with a space.
    guard case .var(let name) = target else {
      throw LanguageError(
        "That is a number, not a list or tuple: [k] reads a position. For a product, write x 2.")
    }
    throw LanguageError("\(name) is not a list here — define it above where it is used.")
  }
  let n = low.count
  let idxLow = try lowerCond(idx, ctx)
  if let keep = try maskValues(idxLow, ctx.opts) {
    if keep.count != n { throw LanguageError("The filter tests \(keep.count) values but the list has \(n).") }
    return try cutBy(low, keep, idx, ctx)
  }
  // Anything but a filter picks by position, and only a tuple has positions.
  let axes = low.own
  let ordered = axes.firstIndex(where: \.ordered)
  // A multiset of points has no k-th element, so [k] reaches into each
  // point, as it does into longer tuples: A[1] is A.x, over A's own
  // instances.
  let name: String = if case .var(let name) = target { name } else { "P" }
  if ordered == nil, low.isList, !low.items.isEmpty, low.items.allSatisfy(isVec) {
    if idxLow.isSeq { throw LanguageError("A multiset of points takes one index at a time: \(name)[2].") }
    let dims = vecItems(low.items[0]).count
    if low.items.contains(where: { vecItems($0).count != dims }) {
      throw LanguageError("All points in a list need the same number of coordinates.")
    }
    let k = try positionIn(idxLow.e, dims, "each point has", "coordinates", name, ctx)
    return Low(try listOf(low.items.map { vecItems($0)[k - 1] }, ctx), axes)
  }
  guard let ordered else { throw LanguageError(needsOrder(target, idx, low)) }
  func picked(_ at: [Int], _ axes: [Axis]?) throws -> Low {
    switch low.e {
    case .data(let values): return Low(try dataOf(at.map { values[$0] }, ctx), axes)
    case .text(let values): return Low(.text(values: at.map { values[$0] }), axes)
    default:
      let items = low.items
      return Low(try listOf(at.map { items[$0] }, ctx), axes)
    }
  }
  if axes.count > 1 {
    // A multiset of tuples: position k of each, over the multiset.
    if idxLow.isSeq { throw LanguageError("A multiset of tuples takes one index at a time: \(name)[2].") }
    let width = axes[ordered].n
    let k = try positionIn(idxLow.e, width, "each tuple has", "elements", name, ctx)
    let inner = size(Array(axes[(ordered + 1)...]))
    let outer = size(Array(axes[..<ordered]))
    let at = (0..<(outer * inner)).map { j in (j / inner) * width * inner + (k - 1) * inner + (j % inner) }
    return try picked(at, axes.enumerated().filter { $0.offset != ordered }.map(\.element))
  }
  func position(_ v: Double) throws -> Int {
    let k = JS.round(v)
    if abs(v - k) > 1e-9 { throw LanguageError("List indices must be whole numbers.") }
    if k == 0 { throw LanguageError("Lists are 1-based: the first element is L[1].") }
    if k < 1 || k > Double(n) {
      throw LanguageError(
        "Index \(JS.string(k)) is out of range — the list has \(n) element\(n == 1 ? "" : "s").")
    }
    return Int(k) - 1
  }
  // A list of indices picks one element each, over the index list's own
  // instances: `L[N]` zips with every other use of N.
  if idxLow.isSeq {
    let settled = idxLow.isLazy ? try settle(idxLow, ctx) : idxLow
    let numbers =
      try numbersOf(settled)
      ?? (try expand(idxLow).items.map { try constVal($0, ctx, "A list index", whole: true) })
    let at = try numbers.map(position)
    // A slice T[2..4] keeps the tuple's order; any other list of indices
    // picks over its own instances.
    var slice = false
    if let literal = listLiteral(idx), literal.items.count == 1, case .range = literal.items[0] { slice = true }
    return try picked(at, slice ? [tupleAxis(at.count)] : idxLow.own)
  }
  let k = try position(try constVal(idxLow.e, ctx, "A list index", whole: true))
  switch low.e {
  case .data(let values): return Low(num(values[k]))
  case .text(let values): return Low(.str(values[k]))
  default: return Low(low.items[k])
  }
}

/// f(P) for a list of points: the list of their k-th coordinates, over the
/// instances P itself runs over (`lowerComp`). All n components come from
/// the one value, so they zip back together.
private func lowerComp(_ value: Expr, _ k: Int, _ n: Int, _ fn: String, _ ctx: Ctx) throws -> Low {
  var low: Low
  if let hit = ctx.comps.first(where: { $0.value == value }) {
    low = hit.low
  } else {
    low = try lower(value, ctx)
    ctx.comps.append((value, low))
  }
  func dims(_ got: Int) throws {
    if !compFits(n, k, got) { throw LanguageError(compDims(fn, n, value, got)) }
  }
  // A template of points: its k-th coordinate is the template's.
  if case .lazy(let cols, .vec(let items)) = low.e {
    try dims(items.count)
    return Low(.lazy(cols: cols, body: items[k]), low.axes)
  }
  low = try settle(low, ctx)
  // A scatter of columns: its k-th component is just its k-th column.
  if isDataScatter(low.e), case .vec(let items) = low.e {
    try dims(items.count)
    return isSeq(items[k]) ? Low(items[k], low.axes) : Low(items[k])
  }
  guard low.isList, !low.items.isEmpty, low.items.allSatisfy(isVec) else {
    throw LanguageError(compArity(fn, n))
  }
  for it in low.items { try dims(vecItems(it).count) }
  return Low(try listOf(low.items.map { vecItems($0)[k] }, ctx), low.axes)
}

/// A comparison where a condition is expected — inside `L[…]` or a `{…}`
/// piecewise — is decided element by element: over a list it lowers to a
/// mask, one comparison per element (`lowerCond`).
private func lowerCond(_ e: Expr, _ ctx: Ctx) throws -> Low {
  switch e {
  case .eqtest(let op, let a, let b):
    let parts = try [a, b].map { try expand(try lower($0, ctx)) }
    if !parts.contains(where: \.isList) {
      throw LanguageError(
        "'\(op.rawValue)' tests the members of a list, like people.city == \"NYC\"."
          + (op == .ne
            ? " For a factorial equation, put a space before '=': x! = 2."
            : " An equation takes a single '=': x^2 = y."))
    }
    return try zipN(parts, { .eqtest(op, $0[0], $0[1]) }, ctx)
  case .eq(let left, let right):
    var inner = false
    if case .ineq(_, _, _, true) = left { inner = true }
    let l = try expand(inner ? try lower(left, ctx) : try lowerCond(left, ctx))
    let r = try expand(try lower(right, ctx))
    if l.isList || r.isList {
      throw LanguageError(
        "Cannot put a list in an equation — to keep the members equal to a value, write L == 2.")
    }
    return Low(.eq(l.e, r.e))
  case .ineq(let op, let left, let right, let grouped):
    // Comparisons are the symbolic path: a mask is per-element structure
    // (and chains nest), so a packed array expands here.
    var inner = false
    if case .ineq(_, _, _, true) = left { inner = true }
    let l = try expand(inner ? try lower(left, ctx) : try lowerCond(left, ctx))
    let r = try expand(try lower(right, ctx))
    if l.isList || r.isList { return try zipN([l, r], { .ineq(op, $0[0], $0[1]) }, ctx) }
    return Low(.ineq(op, l.e, r.e, grouped: grouped))
  default:
    return try lower(e, ctx)
  }
}

/// A comparison as a value keeps the members of the multiset it runs over
/// (`comparisonValue`): `[1,2,3] < 3` is [1, 2]. The members are those of
/// the multiset, not the values compared: `L^2 < 4` keeps members of L.
/// That multiset is the innermost part of the comparison running over
/// exactly the mask's instances; over two separate multisets the members
/// are the pairs.
private func comparisonValue(_ e: Expr, _ ctx: Ctx) throws -> Low {
  let outer = ctx.lowered
  ctx.lowered = []
  let mask: Low
  do {
    mask = try lowerCond(e, ctx)
  } catch {
    ctx.lowered = outer
    throw error
  }
  let lowered = ctx.lowered ?? []
  ctx.lowered = outer
  guard isMask(mask) else { return mask }
  let want = mask.own
  func same(_ a: [Axis], _ b: [Axis]) -> Bool { a.count == b.count && zip(a, b).allSatisfy { $0.id == $1.id } }
  // Children first, so the innermost part wins: P over P.x.
  func find(_ n: Expr, _ axes: [Axis]) throws -> Low? {
    for c in childrenOf(n) {
      if let hit = try find(c, axes) { return hit }
    }
    // A comparison is no multiset of its own, unless written in parentheses
    // as an operand: its kept members are, ([1,2,3] > 1) > 1.
    switch n {
    case .ineq(_, _, _, false), .eq, .eqtest: return nil
    default: break
    }
    // A member column (P.x) belongs to the list it is read from.
    if case .var(let name) = n {
      let u = Array(name.utf16)
      if let dot = u.lastIndex(of: unit(".")), dot > 0 {
        let base = String(decoding: u[..<dot], as: UTF16.self)
        do {
          let low = try lower(.var(base), ctx)
          if low.isSeq, same(low.own, axes) { return low }
        } catch let error as Unsupported {
          throw error
        } catch {
          // Not a list of its own: the column is the multiset.
        }
      }
    }
    // (The parts as the mask was built from them, not lowered again: a tuple
    // gets a fresh axis each time it lowers.)
    return lowered.first { $0.node == n && same($0.low.own, axes) }?.low
  }
  var subject = try find(e, want)
  if subject == nil, want.count > 1 {
    // Over two separate multisets the members are the pairs.
    let parts = try want.map { try find(e, [$0]) }
    if parts.allSatisfy({ $0 != nil }) {
      subject = try lowerVec(parts.map { $0! }, ctx)
    }
  }
  guard let subject, case let got = try settle(subject, ctx), got.isSeq, !got.isLazy, same(got.own, want),
    let keep = try maskValues(mask, ctx.opts)
  else {
    throw LanguageError(
      "This comparison runs over more than one list in a way that has no members to keep — filter with L[…].")
  }
  return try cutBy(got, keep, e, ctx)
}

private func lower(_ e: Expr, _ ctx: Ctx) throws -> Low {
  let out = try lowerNode(e, ctx)
  if ctx.lowered != nil, out.isSeq { ctx.lowered!.append((e, out)) }
  return out
}

/// A tuple of lowered items: a point, a list of points, a scatter of
/// columns, or a longer tuple (the `vec` case of `lowerNode`).
private func lowerVec(_ items: [Low], _ ctx: Ctx) throws -> Low {
  // Longer than a point, or a tuple of points: values at positions.
  if items.count > 3 || items.contains(where: isPointValue) { return try tupleOf(items, ctx) }
  // A scatter of columns stays packed arrays rather than N points.
  let anyData = items.contains(where: \.isData)
  if anyData, items.allSatisfy({ p in if case .num = p.e { true } else { p.isData } }) {
    let (parts, axes) = try align(items)
    return Low(.vec(parts.map(\.e)), axes)
  }
  if let lazy = try lazyMap(items, { .vec($0) }, ctx) { return lazy }
  return try zipN(try items.map(expand), { .vec($0) }, ctx)
}

/// A list literal: a new origin, or the one it was written with (the `list`
/// case of `lowerNode`). `id`: the literal's identity (Expr.swift).
private func lowerLiteral(_ raw: [Expr], id: String?, _ ctx: Ctx) throws -> Low {
  let (items, width) = try expandItems(raw, ctx)
  let out = try listOf(items, ctx)
  let elements = items.count / (width ?? 1)
  let own = Axis(id: id.map { "#o\($0)" } ?? freshAxisID(), n: elements)
  guard let width else { return Low(out, [own]) }
  // (The same literal is the same tuples: its positions keep their axis.)
  let positions = id.map { Axis(id: "#o\($0)t", n: width, ordered: true) } ?? tupleAxis(width)
  return Low(out, [own, positions])
}

/// Two lowered sides under an operator (the `bin` case of `lowerNode`).
@inline(never)
private func lowerBinOp(_ op: BinOp, _ a: Low, _ b: Low, _ ctx: Ctx) throws -> Low {
  if let scaled = try scaleHist(op, a.e, b.e, ctx) { return Low(scaled) }
  let f = binOp(op)
  if let fast = try fastMap([a, b], { f($0[0], $0[1]) }, ctx) { return fast }
  if let lazy = try lazyMap([a, b], { .bin(op, $0[0], $0[1]) }, ctx) { return lazy }
  return try zipN([try expand(a), try expand(b)], { .bin(op, $0[0], $0[1]) }, ctx)
}

// (A function a kind, below: this walk is a frame per level of the row, and
// a debug build's frame holds every case's temporaries at once.)
private func lowerNode(_ e: Expr, _ ctx: Ctx) throws -> Low {
  switch e {
  case .range:
    throw LanguageError(structuralDiagnostic(e))
  case .hist, .num, .str:
    return Low(e)
  case .data, .text, .lazy:
    return Low(e, nil)
  case .figure, .trail, .label, .family:
    let what: String = if case .figure(let form, _, _, _) = e { form.rawValue } else { e.kind }
    return Low(
      try mapChildren(e) { n in
        let child = try lower(n, ctx)
        if child.isSeq { throw LanguageError("Lists cannot appear inside \(what)(…).") }
        return child.e
      })
  case .var:
    return try lowerNodeVar(e, ctx)
  case .neg:
    return try lowerNodeNeg(e, ctx)
  case .bin:
    return try lowerNodeBin(e, ctx)
  case .eqtest, .eq, .ineq:
    return try comparisonValue(e, ctx)
  case .index(let target, let idx):
    return try lowerIndex(target, idx, ctx)
  case .comp(let value, let index, let arity, let functionName):
    return try lowerComp(value, index, arity, functionName, ctx)
  case .call(let name, let rawArgs):
    return try lowerCall(e, name, rawArgs, ctx)
  case .vec(let items):
    return try lowerVec(try items.map { try lower($0, ctx) }, ctx)
  case .list(let items):
    return try lowerLiteral(items, id: nil, ctx)
  case .piecewise:
    return try lowerNodePiecewise(e, ctx)
  case .loop:
    return try lowerNodeLoop(e, ctx)
  }
}

private func lowerNodeVar(_ e: Expr, _ ctx: Ctx) throws -> Low {
  guard case .var(let name) = e else { return Low(e) }
  guard let hit = try ctx.getList(name) else { return Low(e) }
  // (A scatter of columns is a `vec`: a value to name, not a list.)
  guard hit.isSeq else { return hit }
  if hit.none { ctx.none = true }
  return Low(hit.isList ? try listOf(hit.items, ctx) : hit.e, namedAxes(name, hit.own))
}

private func lowerNodeNeg(_ e: Expr, _ ctx: Ctx) throws -> Low {
  guard case .neg(let inner) = e else { return Low(e) }
  let a = try lower(inner, ctx)
  if let fast = try fastMap([a], { -$0[0] }, ctx) { return fast }
  if let lazy = try lazyMap([a], { .neg($0[0]) }, ctx) { return lazy }
  return try zipN([try expand(a)], { .neg($0[0]) }, ctx)
}

private func lowerNodeBin(_ e: Expr, _ ctx: Ctx) throws -> Low {
  guard case .bin(let op, let lhs, let rhs, _) = e else { return Low(e) }
  let a = try lower(lhs, ctx)
  let b = try lower(rhs, ctx)
  return try lowerBinOp(op, a, b, ctx)
}

private func lowerNodePiecewise(_ e: Expr, _ ctx: Ctx) throws -> Low {
  guard case .piecewise(let rawCases, let rawOtherwise) = e else { return Low(e) }
  // Over a list, a case may test equality, {A.y = B.x: …}: members are
  // decided by `==` (decideMembers). Each side lowers once, and a side
  // that is a list makes it a test per member.
  func cond(_ c: Expr) throws -> Low {
    guard case .eq(let left, let right) = c else { return try lowerCond(c, ctx) }
    let l = try lower(left, ctx)
    let r = try lower(right, ctx)
    if l.isSeq || r.isSeq {
      return try zipN([try expand(l), try expand(r)], { .eqtest(.eq, $0[0], $0[1]) }, ctx)
    }
    return Low(ctx.opts.exactConditions ? exactCase(l.e, r.e) : .eq(l.e, r.e))
  }
  var raw: [Low] = []
  for c in rawCases {
    raw.append(try cond(c.cond))
    raw.append(try lower(c.value, ctx))
  }
  let otherwise = try rawOtherwise.map { try lower($0, ctx) }
  if let otherwise { raw.append(otherwise) }
  if !raw.contains(where: \.isSeq) {
    return Low(
      .piecewise(
        rawCases.indices.map { Expr.Case(cond: raw[2 * $0].e, value: raw[2 * $0 + 1].e) },
        otherwise: otherwise?.e))
  }
  // Over lists, one piecewise per member, like any other operation. A
  // member no case holds for is undefined.
  let (parts, axes) = try align(try raw.map { try expand($0.isSeq ? try settle($0, ctx) : $0) })
  let n = parts.first(where: \.isSeq)!.count
  let columns = parts.map { $0.isList ? $0.items : nil }
  func at(_ p: Int, _ k: Int) -> Expr { columns[p]?[k] ?? parts[p].e }
  let items = (0..<n).map { k in
    Expr.piecewise(
      rawCases.indices.map { j in Expr.Case(cond: at(2 * j, k), value: at(2 * j + 1, k)) },
      otherwise: otherwise == nil ? nil : at(parts.count - 1, k))
  }
  return try decideMembers(items, axes ?? [], ctx)
}

private func lowerNodeLoop(_ e: Expr, _ ctx: Ctx) throws -> Low {
  guard case .loop(let params, let rawSeeds, let rawBody, let limit) = e else { return Low(e) }
  // The params are the loop's own names: in the body they shadow any
  // document list spelled the same.
  let seeds = try rawSeeds.map { try lower($0, ctx) }
  let getList = ctx.getList
  ctx.getList = { name in params.contains(name) ? nil : try getList(name) }
  defer { ctx.getList = getList }
  let body = try lower(rawBody, ctx)
  if body.isSeq || seeds.contains(where: \.isSeq) {
    throw LanguageError("Lists are not supported in a recursive function yet.")
  }
  return Low(.loop(params: params, seeds: seeds.map(\.e), body: body.e, limit: limit))
}

// (In three: the calls that read their arguments unlowered, the arguments,
// and the call of them — so the frame under the arguments, which lower as
// deep as the row nests, is small.)
private func lowerCall(_ e: Expr, _ name: String, _ rawArgs: [Expr], _ ctx: Ctx) throws -> Low {
  if let whole = try lowerWholeCall(e, name, rawArgs, ctx) { return whole }
  var args: [Low] = []
  for arg in rawArgs { args.append(try lower(arg, ctx)) }
  return try callOfLows(name, args, ctx)
}

/// A list literal or one settled already, [map], fourier, reconstruct and hist; nil for any other call.
@inline(never)
private func lowerWholeCall(_ e: Expr, _ name: String, _ rawArgs: [Expr], _ ctx: Ctx) throws -> Low? {
  if let literal = listLiteral(e) { return try lowerLiteral(literal.items, id: literal.id, ctx) }
  // A list lowered earlier (an index the object pass settled first) keeps
  // the instances it already had.
  if let settled = settledList(e) {
    if settled.none { ctx.none = true }
    return settled
  }
  if name == MAP { return try lowerMap(rawArgs, ctx) }
  if name == "fourier" || name == "reconstruct" {
    return try lowerFourier(
      name, rawArgs,
      ListLowering(
        opts: ctx.opts, lower: { try lower($0, ctx) }, settle: { try settle($0, ctx) },
        constVal: { try constVal($0, ctx, $1, whole: $2) }, numericItems: { try numericItems($0, ctx, $1) },
        listOf: { try listOf($0, ctx) }))
  }
  if name == "hist" {
    // How many arguments there are, and what the bin count is, are questions
    // about the row: settled before the list is lowered.
    if rawArgs.count > 2 { throw LanguageError("hist(…) takes a list and, optionally, a number of bins.") }
    var bins: Int?
    if rawArgs.count > 1 {
      let v = try constVal(try lower(rawArgs[1], ctx).e, ctx, "The number of bins", whole: true)
      if !JS.isInteger(v) {
        throw LanguageError("hist(…) takes a whole number of bins; that is \(JS.string(v)).")
      }
      if v < 2 || v > 500 { throw LanguageError("hist(…) takes 2 to 500 bins.") }
      bins = Int(v)
    }
    guard let first = rawArgs.first,
      case let arg = try dropUndefined(try settle(try lower(first, ctx), ctx), ctx), arg.isSeq
    else { throw LanguageError("hist(…) needs a list, like hist(person.age).") }
    if arg.isText { throw LanguageError("hist(…) counts numbers; that column holds text.") }
    if arg.isList { try refuseComplex("hist", arg.items) }
    // Gaps go before the values are read, not after.
    let xs = arg.isData ? arg.values : try numericItems(arg.items.filter { !holdsGap($0) }, ctx, "hist")
    return Low(try histogram(xs, bins, ctx))
  }
  return nil
}

/// A call of lowered arguments: a sort, a reduction, or a builtin mapped over its lists.
@inline(never)
private func callOfLows(_ name: String, _ lowered: [Low], _ ctx: Ctx) throws -> Low {
  var args = lowered
  if name == "sort", args.count == 2 {
    // A member with no value, in the list or its key, is left out of both.
    let (p, key) = (args[0], args[1])
    // (Only a symbolic list can hold one: [none] is never packed.)
    let none = ctx.none && [p, key].contains { $0.isList && $0.items.contains(where: undefinedMember) }
    if none, p.isSeq, key.isSeq, p.count == key.count {
      let both = try dropUndefined([try expand(try settle(p, ctx)), try expand(try settle(key, ctx))], ctx)
      return try sortBy(both[0], both[1], ctx)
    }
    return try sortBy(p, key, ctx)
  }
  let isMinMax = name == "min" || name == "max"
  if SYMBOLIC_REDUCTIONS.contains(name) || NUMERIC_REDUCTIONS.contains(name)
    || (isMinMax && args.count == 1 && args[0].isSeq)
  {
    // A number is the one-member multiset, so a function's parameter reduces
    // as its one member: mean(5) is 5. So does a named constant, slider or
    // t; a name bound nowhere is refused below.
    if name != "sort", args.count == 1, !args[0].isSeq, !isVec(args[0].e) {
      var one = true
      if case .var(let v) = args[0].e { one = v == "t" || ctx.opts.consts(v) != nil }
      if one { args = [Low(try listOf([args[0].e], ctx), nil)] }
    }
    guard args.count == 1, args[0].isSeq else {
      if args.count == 1, case .var(let v) = args[0].e {
        throw LanguageError("\(name)(\(v)) needs \(v) to be a list defined above this row.")
      }
      throw LanguageError("\(name)(…) needs a list, like \(name)([1, 4, 2]).")
    }
    let arg = try dropUndefined(try settle(args[0], ctx), ctx)
    if !SYMBOLIC_REDUCTIONS.contains(name), arg.isList { try refuseComplex(name, arg.items) }
    if arg.isText {
      // count is the only reduction text has an answer for.
      if name == "count" { return Low(num(Double(arg.count))) }
      throw LanguageError("\(name)(…) needs numbers; that column holds text.")
    }
    // A multiset of tuples (the positions stored innermost) is reduced tuple
    // by tuple: count counts the tuples, and total and mean are taken
    // position by position, as they are for points.
    let own = arg.own
    if own.count > 1, let tupleAt = own.firstIndex(where: \.ordered), tupleAt == own.count - 1 {
      let width = own[tupleAt].n
      let all = arg.isData ? arg.values.map(num) : arg.items
      if name == "count" { return Low(num(Double(all.count / width))) }
      // A tuple is one element, not its values: sorting them all together
      // would mix up the tuples. (Short ones are points, with no order.)
      if name == "sort" { throw LanguageError(width <= 3 ? SORT_POINTS : SORT_TUPLES(width)) }
      if name != "total" && name != "mean" {
        throw LanguageError(
          "\(name)(…) of a multiset of \(width)-tuples is not defined — only count, total and mean are.")
      }
      let reduced = try (0..<width).map { k in
        try reduce(name, all.enumerated().filter { $0.offset % width == k }.map(\.element), ctx)
      }
      return Low(try listOf(reduced, ctx), [tupleAxis(width)])
    }
    let reduced = arg.isData ? try reduceData(name, arg.values, ctx) : try reduce(name, arg.items, ctx)
    // sort is the bridge from a multiset to a tuple: the same values, now at
    // positions.
    return isSeq(reduced) ? Low(reduced, [tupleAxis(seqLength(reduced))]) : Low(reduced)
  }
  if !args.contains(where: \.isSeq) { return Low(.call(name, args.map(\.e))) }
  if name == "revolve" {
    // Only a list profile is a family waiting for its plan.
    if !args[0].isSeq { return Low(.call(name, args.map(\.e))) }
    throw LanguageError("revolve of a list is not supported yet — write one revolve(…) row per profile.")
  }
  if NO_LIST_INSIDE.contains(name) {
    throw LanguageError("Lists cannot appear inside \(plainFnName(name))(…).")
  }
  // Scalar builtins map elementwise: sin(L), atan2(L, M), min(L, 5).
  if let fn = evalFunctions[name], let fast = try fastMap(args, fn, ctx) { return fast }
  if let lazy = try lazyMap(args, { .call(name, $0) }, ctx) { return lazy }
  return try zipN(try args.map(expand), { .call(name, $0) }, ctx)
}

/// Eliminate lists from a resolved, geometry-lowered expression
/// (`lowerLists`). The result is either an ordinary scalar expression or a
/// top-level list of scalars or points, ready for classify.
///
/// `named`: a definition (`who = person.name`) rather than a row to draw.
/// `packed`: hand back a `lazy` template as it is, for a caller that
/// evaluates the template itself.
func lowerLists(
  _ e: Expr, _ getList: @escaping GetList, _ opts: ResolveOpts, named: Bool = false, packed: Bool = false
) throws -> Low {
  let ctx = Ctx(getList: getList, opts: opts)
  let lowered = try lower(e, ctx)
  // A row collects its multiset, leaving out members no case holds for. A
  // definition does not: `M = {L > 2: L}` is L's members, some of them with
  // no value, so M zips with L; wherever M is collected, they are left out.
  var out = packed ? lowered : named ? try settle(lowered, ctx) : try dropUndefined(try settle(lowered, ctx), ctx)
  if named && ctx.none { out.none = true }
  if isMask(out) {
    throw LanguageError("A comparison over a list is a filter, not a plot — put it in brackets, like L[L > 2].")
  }
  if !named {
    switch out.e {
    case .text, .str:
      throw LanguageError(
        "Text cannot be plotted — count it, or keep another column where it holds, "
          + "like people.age[people.city == \"NYC\"].")
    default: break
    }
  }
  // Bars are a whole row, never a value — including a named one.
  var isHist = false
  if case .hist = out.e { isHist = true }
  if ctx.hists != 0 && !(!named && isHist) {
    throw LanguageError(
      named
        ? "hist(…) is a whole plot, not a value — write it on a row of its own, with no name."
        : "hist(…) is a whole plot — give it its own row.")
  }
  return out
}

/// What a row shows for a tuple of numbers (`tupleRow`). A tuple of 2 or 3
/// numbers is a point, and a multiset of them is a multiset of points. A
/// longer tuple is a `vec` of its values, which classify reads out rather
/// than draws. Everything else is left as it is.
func tupleRow(_ p: Low) throws -> Expr {
  guard p.isList || p.isData else { return p.e }
  let axes = p.own
  guard let at = axes.firstIndex(where: \.ordered) else { return p.e }
  let items = p.isData ? p.values.map(num) : p.items
  if items.contains(where: isVec) { return p.e }
  let n = axes[at].n
  if n < 2 { return p.e }
  if axes.count == 1 { return .vec(items) }
  // (Positions are stored innermost: see unionAxes.)
  if at != axes.count - 1 || n > 3 {
    throw LanguageError("A multiset of \(n)-tuples has no picture — only tuples of 2 or 3 numbers are points.")
  }
  var points: [Expr] = []
  var k = 0
  while k < items.count {
    points.append(.vec(Array(items[k..<(k + n)])))
    k += n
  }
  return .list(points)
}

/// A multiset of tuples of more than 3 numbers as its values back to back,
/// `count` tuples of `width`, so its row can read out; nil for anything else
/// (`tupleMultiset`).
func tupleMultiset(_ p: Low) -> (values: [Expr], width: Int, count: Int)? {
  guard p.isList || p.isData else { return nil }
  let axes = p.own
  guard axes.count >= 2, let last = axes.last, last.ordered, !axes.dropLast().contains(where: \.ordered),
    last.n > 3
  else { return nil }
  let values = p.isData ? p.values.map(num) : p.items
  if values.contains(where: isVec) { return nil }
  return (values, last.n, values.count / last.n)
}

/// A tuple of more than 3 packed numbers — a sorted column — as its numbers;
/// nil for anything else (`packedTuple`).
func packedTuple(_ p: Low) -> [Double]? {
  guard p.isData, p.count > 3, p.own.count == 1, p.own[0].ordered else { return nil }
  return p.values
}

// MARK: - List identity in a tree (Expr.swift)

private let literalCounter = Mutex(0)

/// A list literal the resolver has met, marked as itself: every copy of it
/// that substitution makes is the same list (`[list]`, Expr.swift).
func identifiedList(_ items: [Expr]) -> Expr {
  let id = literalCounter.withLock {
    $0 += 1
    return $0
  }
  return .call(LIST_ID, [.str("\(id)"), .list(items)])
}

/// A list literal as written or as the resolver marked it: its items, its
/// identity when it has one, and whether that survives a changed copy.
func listLiteral(_ e: Expr) -> (id: String?, origin: Bool, items: [Expr])? {
  switch e {
  case .list(let items):
    return (nil, false, items)
  case .call(let name, let args) where name == LIST_ID || name == LIST_ORIGIN:
    guard args.count == 2, case .str(let id) = args[0], case .list(let items) = args[1] else { return nil }
    return (id, name == LIST_ORIGIN, items)
  default:
    return nil
  }
}

/// Every list literal under `e` marked as an origin: one list in every copy
/// made of it (lib/expr.ts `markOrigins`).
func markOrigins(_ e: Expr) -> Expr {
  if case .call(LIST_ID, let args) = e { return .call(LIST_ORIGIN, args.map(markOrigins)) }
  return mapChildren(e, markOrigins)
}

/// A parsed tree with every list literal in it marked as an origin, before
/// it resolves: what a Σ does to its body, whose every term's copy of a
/// literal is that one list (lib/expr.ts `markOrigins`, on the parsed body).
func markedLists(_ e: Expr) -> Expr {
  switch e {
  case .list(let items):
    guard case .call(_, let marked) = identifiedList(items.map(markedLists)) else { return e }
    return .call(LIST_ORIGIN, marked)
  case .call(let name, let args) where name == LIST_ID || name == LIST_ORIGIN:
    guard args.count == 2, case .list(let items) = args[1] else { return e }
    return .call(LIST_ORIGIN, [args[0], .list(items.map(markedLists))])
  default:
    return mapChildren(e, markedLists)
  }
}

/// A function's body about to have `names` replaced: a list literal there
/// that reads one becomes a new list in each call, as the TypeScript's copy
/// of it is a new object; one that reads none stays the one list it is.
func freshLists(_ body: Expr, replacing names: Set<String>) -> Expr {
  if case .call(LIST_ID, let args) = body, args.count == 2, case .list(let items) = args[1] {
    let inner = items.map { freshLists($0, replacing: names) }
    return freeVars(body).contains(where: names.contains)
      ? identifiedList(inner) : .call(LIST_ID, [args[0], .list(inner)])
  }
  return mapChildren(body) { freshLists($0, replacing: names) }
}

/// A lowered list written back into a tree, with the instances it runs over
/// (`[seq]`, Expr.swift): what the object pass leaves where it settled an
/// index first.
func settledNode(_ p: Low) -> Expr {
  guard p.isSeq || isDataScatter(p.e) else { return p.e }
  let axes = p.own.map { "\($0.ordered ? "o" : "m")\u{1}\($0.n)\u{1}\($0.id)" }
  return .call(LIST_SEQ, [.str((p.none ? "!" : "") + axes.joined(separator: "\u{0}")), p.e])
}

func settledList(_ e: Expr) -> Low? {
  guard case .call(LIST_SEQ, let args) = e, args.count == 2, case .str(var spelled) = args[0] else { return nil }
  let none = spelled.hasPrefix("!")
  if none { spelled.removeFirst() }
  var axes: [Axis] = []
  for part in spelled.split(separator: "\u{0}") {
    let fields = part.split(separator: "\u{1}", maxSplits: 2, omittingEmptySubsequences: false)
    guard fields.count == 3, let n = Int(fields[1]) else { return nil }
    axes.append(Axis(id: String(fields[2]), n: n, ordered: fields[0] == "o"))
  }
  return Low(args[1], axes, none: none)
}

/// A tree with every list written as a plain `list` again: the marks of
/// identity are the port's own, and nothing outside list lowering reads them.
func plainLists(_ e: Expr) -> Expr {
  if let literal = listLiteral(e), case .call = e { return .list(literal.items.map(plainLists)) }
  if let settled = settledList(e) { return plainLists(settled.e) }
  return mapChildren(e, plainLists)
}

/// Whether a list is written anywhere under `e`.
func holdsList(_ e: Expr) -> Bool {
  if isSeq(e) { return true }
  return childrenOf(e).contains(where: holdsList)
}
