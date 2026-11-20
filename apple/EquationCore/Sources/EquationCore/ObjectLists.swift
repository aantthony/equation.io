/// Lists in object positions (lib/object-lists.ts `lowerObjects`): a row's or
/// a definition's value once points and lists have lowered. A list of
/// numbers or points stays a list; a list a curve or a region reads becomes
/// one member per element, a family (`y = [1, 2, 3] x`); arithmetic on a
/// list of points (`P + (1, 0)`) is taken point by point.
///
/// Ordinary rows go through geometry lowering and then list lowering
/// (Lists.swift), which get first refusal. What is left of the TypeScript
/// here — a matrix or a tensor read as the list of its rows, lines and
/// planes — is not ported: such a row says it is not supported.

/// Members a family of curves or regions may have (`FAMILY_MAX`).
let FAMILY_MAX = 32
/// Point figures are a handful of numbers each, so a family of them can be a
/// whole lattice (`FIGURE_FAMILY_MAX`).
let FIGURE_FAMILY_MAX = 1024

/// Reductions that take a multiset of points whole: count, and total and
/// mean coordinate by coordinate.
private let REDUCES_POINTS: Set<String> = ["count", "total", "mean"]
/// Reductions that need an order or a scale, which a tensor has not.
private let TENSOR_REFUSED: Set<String> = ["min", "max", "median", "stdev"]

/// The place in an expansion's template where list `k`'s member goes: a call
/// no row can spell.
private let MEMBER = "[member]"

/// Whether `e` has more than `limit` nodes, walking no further than it takes
/// to know (lib/size.ts `exceedsNodes`): the TypeScript counts objects, so
/// an argument list or a case counts as one too. A list the port has marked
/// or settled counts as the TypeScript's node does.
func exceedsListNodes(_ e: Expr, _ limit: Int, settledAreLeaves: Bool = false) -> Bool {
  var n = 0
  func walk(_ x: Expr) -> Bool {
    if let literal = listLiteral(x), case .call = x { return walk(.list(literal.items)) }
    if let settled = settledList(x) { return settledAreLeaves ? count(1) : walk(settled.e) }
    switch x {
    case .num, .var, .str: return count(1)
    case .neg, .bin, .eq, .ineq, .comp: return count(1) || childrenOf(x).contains(where: walk)
    case .data, .text: return count(2)
    case .hist: return count(3)
    case .piecewise(let cases, let otherwise):
      _ = otherwise
      return count(2 + cases.count) || childrenOf(x).contains(where: walk)
    case .lazy(let cols, _): return count(2 + 2 * cols.count) || childrenOf(x).contains(where: walk)
    case .figure(_, _, _, let over):
      return count(2 + (over.map { 1 + 2 * $0.count } ?? 0)) || childrenOf(x).contains(where: walk)
    case .loop: return count(3) || childrenOf(x).contains(where: walk)
    case .call, .index, .range, .eqtest, .vec, .list, .trail, .label, .family:
      return count(2) || childrenOf(x).contains(where: walk)
    }
  }
  func count(_ k: Int) -> Bool {
    n += k
    return n > limit
  }
  return walk(e)
}

// MARK: - Named lists (lib/defs.ts listGetter, pointColumn, indexIssue)

/// `P.x`, `P.y`, `P.z` of a named point list: the list of that coordinate,
/// over P's own instances — so `(P.x, P.y - (m P.x + b))` pairs up point by
/// point (lib/defs.ts `pointColumn`).
private func pointColumn(_ defs: BuiltDefs, _ name: String, _ axis: String) throws -> Low? {
  // (A tuple of two 2D points is a matrix; its rows are the same points.)
  if defs.mats.has(name) { throw Unsupported("a matrix read as a list of its rows") }
  guard let points = defs.lists[name], case .list(let items) = points.e else { return nil }
  let k = ["x", "y", "z"].firstIndex(of: axis) ?? -1
  let dims = items.map { p -> Int in if case .vec(let comps) = p { comps.count } else { 0 } }
  if items.isEmpty || dims.contains(0) {
    throw LanguageError("\(name).\(axis) reads a coordinate of a list of points; \(name) is a list of numbers.")
  }
  let dim = dims.min()!
  if k < 0 || k >= dim {
    let coords = ["x", "y", "z"].prefix(dim).map { "\(name).\($0)" }.joined(separator: ", ")
    throw LanguageError("\(name) is a list of \(dim)D points: its coordinates are \(coords).")
  }
  let column = items.map { p -> Expr in if case .vec(let comps) = p { comps[k] } else { p } }
  return Low(.list(column), namedAxes(name, points.own), none: points.none)
}

/// Resolve a name to list elements: a named list, or a coordinate of a named
/// list of points (lib/defs.ts `listGetter`). Data files are not ported, so
/// no name is a column; nor is a matrix read as the list of its rows
/// (lib/object-lists.ts `rowsAsPoints`), which says so.
func listGetter(_ defs: BuiltDefs) -> GetList {
  { name in
    if let hit = defs.lists[name] { return hit }
    if defs.mats.has(name) { throw Unsupported("a matrix read as a list of its rows") }
    let u = Array(name.utf16)
    guard let dot = u.firstIndex(of: unit(".")), dot > 0 else { return nil }
    return try pointColumn(
      defs, String(decoding: u[..<dot], as: UTF16.self), String(decoding: u[(dot + 1)...], as: UTF16.self))
  }
}

/// Resolve a name to a tensor: a named tensor, or — asked with `tuples`, by
/// an operation on tensors — a named tuple, which is one too: a tuple of
/// numbers a vector, a tuple of points a rank-2 tensor (lib/defs.ts
/// `tensorGetter`).
func tensorGetter(_ defs: BuiltDefs) -> GetTensor {
  { name, tuples in
    if let hit = defs.tensors[name] { return hit }
    guard tuples, let list = defs.lists[name], list.isList || list.isData, list.own.count == 1,
      list.own[0].ordered
    else { return nil }
    // A tuple of numbers is a vector of any length: T = sort(L).
    if list.isData { return vectorTensor(list.values.map { .num($0) }) }
    let plain = list.items.allSatisfy { item in
      switch item {
      case .vec, .list: false
      default: true
      }
    }
    if plain { return vectorTensor(list.items) }
    var rows: [Tensor] = []
    for item in list.items {
      guard case .vec(let coords) = item else { return nil }
      rows.append(vectorTensor(coords))
    }
    return rows.isEmpty ? nil : (try? stack(rows)) ?? nil
  }
}

/// Whether a name reads as a list (lib/defs.ts `isListName`, over
/// `listNamesOf`): a list, a matrix or a tensor, or a dotted path whose head
/// is one.
func isListName(_ defs: BuiltDefs, _ n: String) -> Bool {
  func listed(_ name: String) -> Bool { defs.lists.has(name) || defs.mats.has(name) || defs.tensors.has(name) }
  return listed(n) || listed(dottedHead(n))
}

/// Whether this side of a comparison is still a list by the time the
/// comparison sees it, asked of the shape alone (lib/defs.ts `staysList`).
private func staysList(_ e: Expr, _ defs: BuiltDefs) -> Bool {
  switch e {
  case .var(let name):
    if defs.lists.has(name) { return true }
    // `P.x` of a point list, or of the rows of a matrix.
    let head = dottedHead(name)
    return head != name && (defs.lists.has(head) || defs.mats.has(head))
  case .list, .data, .text: return true
  case .neg(let a): return staysList(a, defs)
  case .bin(_, let a, let b, _): return staysList(a, defs) || staysList(b, defs)
  case .call(let name, let args):
    // A reduction answers with one number however long its argument is.
    if SCALAR_REDUCTIONS.contains(name) { return false }
    if (name == "min" || name == "max") && args.count == 1 { return false }
    if name == "hist" { return false }
    return args.contains { staysList($0, defs) }
  case .vec(let items): return items.contains { staysList($0, defs) }
  default: return false
  }
}

/// What is wrong with the index in `L[idx]`, judged by shape alone — or nil
/// (lib/defs.ts `indexIssue`): a comparison that decides the same answer for
/// every element is not a filter, whatever it mentions.
func indexIssue(_ idx: Expr, _ defs: BuiltDefs) -> String? {
  let operands: [Expr]
  switch idx {
  case .ineq: operands = ineqComparisons(idx).flatMap { [$0.l, $0.r] }
  case .eqtest(_, let a, let b): operands = [a, b]
  default: return nil
  }
  return operands.contains { staysList($0, defs) }
    ? nil
    : "A filter has to test the list itself, like L[L > 2] — this one answers the same for every element."
}

// MARK: - lowerObjects

/// A list's elements, with the instances it runs over.
private struct ListValue {
  var items: [Expr]
  var axes: [Axis]
}

/// Errors the port's own gaps throw pass through every recovery below: what
/// the site would have made of the row there is not known.
private func recover<T>(_ run: () throws -> T) throws -> T? {
  do {
    return try run()
  } catch let error as Unsupported {
    throw error
  } catch {
    return nil
  }
}

func lowerObjects(_ e: Expr, _ defs: BuiltDefs, _ opts: ResolveOpts, named: Bool = false) throws -> Low {
  var e = e
  func plotVariable(_ v: String) -> Bool { ["x", "y", "z", "u", "v"].contains(v) || defs.fields.has(v) }
  // Drawn over something continuous: a plot variable.
  func continuous(_ e: Expr) -> Bool { freeVars(e).contains(where: plotVariable) }
  let get = listGetter(defs)
  // (A named point's components, and a vector state's.)
  let comps = opts.comps
  let mats: GetMat = { defs.mats[$0] }
  let tensors = tensorGetter(defs)
  // T[2] of a tensor is a slice of it, which geometry lowering takes.
  func ofTensor(_ n: Expr) -> Bool {
    switch n {
    case .var(let name): defs.tensors.has(name)
    case .index(let target, _): ofTensor(target)
    default: false
    }
  }
  func indices(_ n: Expr) throws -> Expr {
    guard case .index(let target, let idx) = n else { return try mapChildren(n, indices) }
    if ofTensor(target) { return n }
    // A named point is a tuple of its coordinates: T[2] of T = (3, 1, 2) is 1.
    if case .var(let name) = target, defs.points.contains(name), let names = comps(name) {
      let tuple = Low(.list(names.map { .var($0) }), [Axis(id: "\(name)#0", n: names.count, ordered: true)])
      return settledNode(try lowerLists(.index(settledNode(tuple), idx), get, opts, named: true))
    }
    return settledNode(try lowerLists(n, get, opts, named: true))
  }
  if !exceedsListNodes(e, 32768) { e = try indices(e) }
  let isList: (String) -> Bool = { name in ((try? get(name)) ?? nil) != nil }
  // A list of points beside a matrix (R P) is a multiset of points, not a
  // matrix scaled by a list: it is taken point by point (`matrixRows`).
  let besidePoints: (Expr) -> Bool = { arg in
    freeVars(arg).contains { v in
      guard !defs.mats.has(v), let list = (try? get(v)) ?? nil else { return false }
      if case .list(let items) = list.e { return items.contains { if case .vec = $0 { true } else { false } } }
      return !list.isData
    }
  }
  func ordinary(_ e: Expr, packed: Bool = false) throws -> Low {
    try lowerLists(
      try lowerGeomObjects(
        e, comps: comps, mats: mats, tensors: tensors, isList: isList, notMatrix: besidePoints), get, opts,
      named: named, packed: packed)
  }
  func listValue(_ e: Expr) throws -> ListValue? {
    guard let value = try recover({ try ordinary(e) }) else { return nil }
    switch value.e {
    case .list(let items):
      return ListValue(items: items, axes: value.own)
    case .data(let values):
      if values.count > 100000 { throw LanguageError("A point path accepts at most 100000 vertices.") }
      return ListValue(items: values.map { .num($0) }, axes: value.own)
    default:
      guard isDataScatter(value.e) else { return nil }
      let points = scatterPoints(value)
      if points.count > 100000 { throw LanguageError("A point path accepts at most 100000 vertices.") }
      return ListValue(items: points.items, axes: value.own)
    }
  }

  /// What the ordinary pass said, when it failed, and its words.
  var originalError: Error?
  var message = ""
  // A transformed figure. A list in the transform is one figure per element
  // — e^(th J) hull(P) is a rosette of hulls, not the hull of every copy —
  // so those expand first, around the figure; then the transform moves
  // inside (lowerFigureObjects).
  var isFigure = false
  if case .call(let name, _) = e, POINT_FIGURES.contains(name) { isFigure = true }
  if !isFigure, !exceedsListNodes(e, 32768), holdsFigure(e), let family = try expand(e, outside: true) {
    return family
  }
  e = try lowerFigureObjects(e, comps, mats, tensors, notMatrix: besidePoints)
  // Connectedness consumes a whole list; it does not broadcast its vertices
  // into separate one-vertex figures.
  if case .call(let form, let args) = e, ["polyline", "polygon", "hull"].contains(form), args.count == 1,
    let connected = try connectedFigure(form, args[0])
  {
    return connected
  }
  var attempt = 0
  while true {
    do {
      let value = try ordinary(e)
      // Lists of functions and parametrics become families; constant lists
      // keep their dot and scatter representation.
      if !value.isList || !value.items.contains(where: continuous) { return value }
      break
    } catch let error as Unsupported {
      throw error
    } catch {
      if originalError == nil { originalError = error }
    }
    // f(R P), f(P + (1, 0)): the argument is a point list only this pass can
    // compute. Settle it once, as the lists of its coordinates, and the row
    // is ordinary again.
    let settled = attempt == 0 && !exceedsListNodes(e, 32768) ? try settleComps(e) : e
    if settled == e { break }
    e = settled
    attempt += 1
  }
  message = originalError.map(errorMessage) ?? ""
  // A bracket that mixes tuples with other things is wrong as written, and a
  // reduction a multiset of tuples has no answer for is too; one member per
  // element would only hide that.
  if let originalError,
    message.contains("A multiset holds tuples")
      || (message.contains("A multiset of ") && message.contains("-tuples cannot"))
      || (message.contains("of a multiset of ") && message.contains("-tuples is not defined"))
      || message.contains("takes real numbers, and these are complex")
  {
    throw originalError
  }
  do {
    return try expand(e, outside: false)!
  } catch let error as Unsupported {
    throw error
  } catch {
    // A matrix or tensor error is about the matrix: the expansion's own
    // complaint, made while reading things as lists of points, would only
    // bury it. So is a sort key's: expanded, sort(P, L) is only ever handed
    // single values.
    let lowercase = message.lowercased()
    let aboutTensors =
      (lowercase.contains("matri") || lowercase.contains("tensor")) && !message.contains("not a value on its own")
    if let originalError, aboutTensors || message.contains("sort(P, P.x)") { throw originalError }
    throw error
  }

  /// Every `comp` whose value is a computed point list, replaced by the list
  /// of that coordinate — over the value's own instances, so they still zip
  /// (`settleComps`).
  func settleComps(_ n: Expr) throws -> Expr {
    switch n {
    case .comp(let rawValue, let index, let arity, let functionName):
      let value = try settleComps(rawValue)
      let call = Expr.comp(value: value, index: index, arity: arity, functionName: functionName)
      // (Anything else — one point, a wrong dimension — is the ordinary path's to judge.)
      guard let pts = try recover({ try lowerObjects(value, defs, opts, named: true) }), pts.isList,
        !pts.items.isEmpty,
        pts.items.allSatisfy({ p in
          if case .vec(let items) = p { compFits(arity, index, items.count) } else { false }
        })
      else { return call }
      let coords = pts.items.map { p -> Expr in if case .vec(let items) = p { items[index] } else { p } }
      return settledNode(Low(.list(coords), pts.axes))
    case .call(let name, let args) where TENSOR_REFUSED.contains(name) && args.count == 1:
      // max(P ⊗ P): the other reductions have no order on tensors.
      if let value = try recover({ try lowerObjects(args[0], defs, opts, named: true) }), value.isList,
        !value.items.isEmpty, value.items.allSatisfy({ tensorOfNode($0) != nil })
      {
        throw LanguageError(
          "\(name) is not defined for tensors — total, mean and count take them entry by entry.")
      }
      return try mapChildren(n, settleComps)
    case .call(let name, let args) where REDUCES_POINTS.contains(name) && args.count == 1:
      // count(2 P), mean(R P): a reduction takes the computed multiset of
      // points whole, rather than one member per point.
      guard var pts = try recover({ try lowerObjects(args[0], defs, opts, named: true) }), pts.isList,
        !pts.items.isEmpty
      else { return try mapChildren(n, settleComps) }
      // Points that meet and join made are the tuples they are; lines and
      // planes count, but have no total or mean.
      let flats = pts.items.compactMap(flatOfNode)
      if flats.count == pts.items.count {
        if flats.allSatisfy(isPoint) {
          pts.e = .list(tupleItems(pts.items))
        } else if name == "count" {
          return .num(Double(flats.count))
        } else {
          throw LanguageError("\(name) is not defined for lines and planes — count takes them.")
        }
      }
      if pts.items.allSatisfy({ if case .vec = $0 { true } else { false } }) {
        return .call(name, [settledNode(pts)])
      }
      // total(P ⊗ P), mean of a multiset of matrices: entry by entry, as a
      // point's are coordinate by coordinate — one tensor.
      let tensors = pts.items.compactMap(tensorOfNode)
      if tensors.count == pts.items.count, tensors.allSatisfy({ $0.shape == tensors[0].shape }) {
        if name == "count" { return .num(Double(tensors.count)) }
        let data = tensors[0].data.indices.map { i in
          Expr.call(name, [settledNode(Low(.list(tensors.map { $0.data[i] }), pts.axes))])
        }
        return tensorNode(Tensor(shape: tensors[0].shape, data: data))
      }
      return try mapChildren(n, settleComps)
    default:
      if listLiteral(n) != nil || settledList(n) != nil { return n }
      return try mapChildren(n, settleComps)
    }
  }

  /// A connected figure of one argument, when that is a list of points
  /// (lib/object-lists.ts, the polyline/polygon/hull block): a path or a
  /// polygon walks its points in order, so it takes a tuple; a hull is the
  /// same whatever the order. Nil when the argument is not a list.
  func connectedFigure(_ form: String, _ arg: Expr) throws -> Low? {
    // (A tuple of points written out and a matrix are lowerFigureObjects'.)
    if case .vec(let items) = arg, items.count >= 2,
      items.allSatisfy({ p in
        switch p {
        case .vec: true
        case .var(let name): comps(name) != nil
        default: false
        }
      })
    {
      return nil
    }
    if case .var(let name) = arg, defs.mats.has(name) { return nil }
    func inOrder(_ axes: [Axis]) throws {
      if form == "hull" || axes.contains(where: \.ordered) { return }
      let p: String = if case .var(let name) = arg { name } else { "P" }
      throw LanguageError(
        "\(form) needs an order — a list [ … ] has none. Sort it: \(form)(sort(\(p), \(p).x)).")
    }
    // Points computed over packed numbers with a slider or t in the way —
    // polyline(F(k)) through thousands of k — stay one vertex template.
    if let value = try recover({ try ordinary(arg, packed: true) }), case .lazy(let cols, let body) = value.e {
      let axes = value.own
      try inOrder(axes)
      return try walkEach(axes) { cut in
        try packedFigure(form, cols.map { c in Column(name: c.name, values: cut.map { c.values[$0] }) }, body)
      }
    }
    // A point list may itself be computed — R P, P + (1, 0), rotate(P, a) —
    // which is the expansion below, asked for the values it yields.
    func computed() throws -> ListValue? {
      guard let value = try recover({ try lowerObjects(arg, defs, opts, named: true) }), value.isList else {
        return nil
      }
      return ListValue(items: value.items, axes: value.own)
    }
    var found = try listValue(arg)
    if found == nil { found = try computed() }
    guard var pts = found else { return nil }
    pts.items = tupleItems(pts.items)
    guard pts.items.allSatisfy({ if case .vec = $0 { true } else { false } }) else {
      throw LanguageError("\(form) needs a list of points.")
    }
    try inOrder(pts.axes)
    return try walkEach(pts.axes) { cut in try ordinary(.call(form, cut.map { pts.items[$0] })).e }
  }

  /// A connected figure walks the positions of its tuple; every other axis
  /// is a multiset of such tuples, and gives one figure per element — a
  /// family, as the tuple written out would (`walkEach`). `figure` builds
  /// one member from the flat indices of its vertices, in order.
  func walkEach(_ axes: [Axis], _ figure: ([Int]) throws -> Expr) throws -> Low {
    let total = axes.reduce(1) { $0 * $1.n }
    guard let at = axes.firstIndex(where: \.ordered), axes.count > 1 else {
      return Low(try figure(Array(0..<total)))
    }
    let n = axes[at].n
    let inner = axes[(at + 1)...].reduce(1) { $0 * $1.n }
    let members = total / n
    if members > FIGURE_FAMILY_MAX {
      throw LanguageError("An object family needs 1–\(FIGURE_FAMILY_MAX) members (got \(members)).")
    }
    if named { throw LanguageError("An object family is a whole row; give it a row of its own.") }
    return Low(
      .family(
        members: try (0..<members).map { m in
          let base = (m / inner) * n * inner + (m % inner)
          return try figure((0..<n).map { base + $0 * inner })
        }))
  }

  /// A connected figure through a template of points: the template is its
  /// one vertex, evaluated once per element of the columns (`packedFigure`).
  func packedFigure(_ form: String, _ cols: [Column], _ body: Expr) throws -> Expr {
    guard case .vec(let items) = tupleItems([body])[0], items.count == 2 || items.count == 3 else {
      throw LanguageError("\(form) needs a list of points.")
    }
    let n = cols.first?.values.count ?? 0
    if n > 100000 { throw LanguageError("A point path accepts at most 100000 vertices.") }
    if n < (form == "polyline" ? 2 : 3) {
      throw LanguageError(
        form == "polyline"
          ? "polyline needs at least 2 points: polyline(A, B, C)."
          : form == "hull"
            ? "hull needs at least 3 points: hull(A, B, C, D), or hull(P) for a list of points."
            : "polygon needs at least 3 vertices.")
    }
    return .figure(form: FigureForm(rawValue: form)!, dimension: items.count, vertices: items, over: cols)
  }

  /// One member per combination of the lists in `source` (`expand`).
  /// `outside`: only the lists around a figure, each member a figure lowered
  /// in its own right; nil when there are none.
  func expand(_ source: Expr, outside: Bool) throws -> Low? {
    if exceedsListNodes(source, 32768, settledAreLeaves: true) {
      throw LanguageError("This object family is too large to expand (32768 nodes).")
    }
    var lists: [ListValue] = []
    // Inside a recursive function's loop, its params are its own names, not
    // the document lists they may share a spelling with.
    var bound: Set<String> = []
    /// Whether a [map] argument was expanded here (point-list arithmetic).
    var mapArgs = false
    // A matrix name is the matrix, not a list of row-points, along the row's
    // own algebra (2 M, M v). Those rows are a list only where a call asks
    // for points — hull(M), distance(P, A) — and there still not as the
    // matrix factor of a product.
    func visit(_ node: Expr) throws -> Expr { try visitNode(node, true) }
    func visitNode(_ node: Expr, _ asMatrix: Bool) throws -> Expr {
      func visit(_ n: Expr) throws -> Expr { try visitNode(n, true) }
      func within(_ n: Expr) throws -> Expr { try visitNode(n, asMatrix) }
      if case .var(let name) = node, bound.contains(name) { return node }
      if case .var(let name) = node, let m = defs.mats[name] {
        // M = ((a, 0), (0, 1)) with a list among its entries is a multiset
        // of matrices, one per member; and where a call asks for points a
        // matrix is the list of its rows. Neither is ported.
        if !asMatrix { throw Unsupported("a matrix read as a list of its rows") }
        let overList = m.contains { row in row.contains { freeVars($0).contains(where: isList) } }
        if overList { throw Unsupported("a matrix over a list") }
        return node
      }
      // Around a figure, only the transform's lists count: the figure keeps its own.
      if outside, case .call(let name, _) = node, POINT_FIGURES.contains(name) { return node }
      let mentionsBound = !bound.isEmpty && freeVars(node).contains(where: bound.contains)
      if !mentionsBound, let values = try listValue(node),
        !values.items.contains(where: { tensorOfNode($0) != nil })
      {
        if values.items.count > 100000 {
          throw LanguageError("Point-list arithmetic needs at most 100000 values.")
        }
        lists.append(values)
        return .call(MEMBER, [.num(Double(lists.count - 1))])
      }
      // A piecewise condition is decided per member, never a list of its
      // own: as a value `k < 3` is the members kept, so taking it whole
      // would drop the comparison. Its sides are what expand — a chain's
      // inner comparison too, unless written in parentheses as an operand.
      func cond(_ c: Expr) throws -> Expr {
        switch c {
        case .ineq(let op, let l, let r, let grouped):
          var chain = false
          if case .ineq(_, _, _, false) = l { chain = true }
          return .ineq(op, chain ? try cond(l) : try visit(l), try visit(r), grouped: grouped)
        case .eqtest(let op, let a, let b):
          return .eqtest(op, try visit(a), try visit(b))
        default:
          return try visit(c)
        }
      }
      switch node {
      case .call(let name, let args):
        // A reduction takes its list whole: mean(s) is one number in every
        // member, not s broadcast into mean.
        if SCALAR_REDUCTIONS.contains(name) || ((name == "min" || name == "max") && args.count == 1) {
          return node
        }
        // A function applied per member ([map]) is list lowering's to run.
        // An argument that is point-list arithmetic (P + (1, 0)) is expanded
        // here on its own, as its row would be.
        if name == MAP {
          return .call(
            name,
            try args.enumerated().map { i, n in
              if i < 3 || i % 2 == 0 { return n }
              guard let low = try recover({ try lowerObjects(n, defs, opts) }), low.isList else { return n }
              mapArgs = true
              return settledNode(low)
            })
        }
        if listLiteral(node) != nil || settledList(node) != nil { return node }
        return .call(name, try args.map { try visitNode($0, false) })
      case .bin(let op, let a, let b, let glyph):
        return .bin(op, try visitNode(a, asMatrix || op == .mul), try within(b), glyph: glyph)
      case .neg(let a):
        return .neg(try within(a))
      case .vec(let items):
        return .vec(try items.map(within))
      case .comp(let value, let index, let arity, let functionName):
        return .comp(value: try visitNode(value, false), index: index, arity: arity, functionName: functionName)
      case .eq(let l, let r):
        return .eq(try visit(l), try visit(r))
      case .ineq(let op, let l, let r, let grouped):
        return .ineq(op, try visit(l), try visit(r), grouped: grouped)
      case .piecewise(let cases, let otherwise):
        return .piecewise(
          try cases.map { Expr.Case(cond: try cond($0.cond), value: try visit($0.value)) },
          otherwise: try otherwise.map(visit))
      case .loop(let params, let seeds, let body, let limit):
        let visited = try seeds.map(within)
        let outer = bound
        bound.formUnion(params)
        defer { bound = outer }
        return .loop(params: params, seeds: visited, body: try within(body), limit: limit)
      default:
        return try mapChildren(node, within)
      }
    }
    let template = try visit(source)
    if lists.isEmpty {
      // A [map] whose point-list argument was expanded here is no family:
      // with that argument lowered, the row is ordinary again.
      if mapArgs { return try ordinary(template) }
      if outside { return nil }
      throw originalError ?? LanguageError("This expression cannot be expanded as an object family.")
    }
    // One member per instance: uses of the same list move together, lists
    // with different origins are independent and cross.
    let (axes, canon) = try unionAxes(lists.map(\.axes))
    let n = axes.reduce(1) { $0 * $1.n }
    // A × [] = []: an empty multiset anywhere leaves no combinations.
    // (A reduction that has no value there says so rather than vanishing.)
    if n == 0 && !outside {
      if let originalError, message.contains("of an empty list") { throw originalError }
      return Low(.list([]), axes)
    }
    if n > 100000 {
      throw LanguageError(
        "Independent lists combine every value with every other — that is \(n) combinations. "
          + "Name one list and reuse it to pair values up instead.")
    }
    // Where member k sits in each list: its own axes, row-major like the rest.
    func at(_ list: ListValue, _ k: Int) -> Int {
      var index = 0
      var rest = k
      for d in axes.indices.reversed() {
        defer { rest /= axes[d].n }
        guard let own = list.axes.firstIndex(where: { canon($0) == axes[d].id }) else { continue }
        index += (rest % axes[d].n) * list.axes[(own + 1)...].reduce(1) { $0 * $1.n }
      }
      return index
    }
    func instantiate(_ node: Expr, _ k: Int) -> Expr {
      if case .call(MEMBER, let args) = node, case .num(let which)? = args.first {
        let list = lists[Int(which)]
        return list.items[at(list, k)]
      }
      if listLiteral(node) != nil || settledList(node) != nil { return node }
      return mapChildren(node) { instantiate($0, k) }
    }
    var objects = outside || continuous(source) || lists.contains { $0.items.contains(where: continuous) }
    var limit = outside ? FIGURE_FAMILY_MAX : FAMILY_MAX
    switch source {
    case .eq, .ineq: objects = true
    case .call(let name, _):
      if wholeStatement(name) { objects = true }
      if POINT_FIGURES.contains(name) { limit = FIGURE_FAMILY_MAX }
    default: break
    }
    if objects && n > limit { throw LanguageError("An object family needs 1–\(limit) members (got \(n)).") }
    let members = try (0..<n).map { k in
      outside
        ? try lowerObjects(instantiate(template, k), defs, opts).e : try ordinary(instantiate(template, k)).e
    }
    let valuesOnly = members.allSatisfy { m in
      if continuous(m) { return false }
      switch m {
      case .figure, .trail, .label, .hist, .family, .eq, .ineq: return false
      case .call(let name, _): return !wholeStatement(name) && name != STREAMLINES_CALL
      default: return true
      }
    }
    // (Over the instances it was expanded along: Q = P + (1, 0) moves with P.)
    if valuesOnly { return Low(.list(members), axes) }
    if n > limit { throw LanguageError("An object family has at most \(limit) members.") }
    if named { throw LanguageError("An object family is a whole row; give it a row of its own.") }
    return Low(.family(members: members))
  }
}

/// A call that is a whole row: a geometry statement, or a form drawn per
/// pixel (lib/geom.ts `GEOM_STATEMENTS`, lib/complex.ts `WHOLE_EXPR_NAMES`).
private func wholeStatement(_ name: String) -> Bool {
  GEOM_STATEMENTS.contains(name) || SPECIAL_FORMS.contains(name)
}

// MARK: - Geometry lowering's part (lib/geom.ts)

/// Why an argument that failed to be a point is list-shaped, if it is: a
/// list value (L, 2L, -P, sort(L), sin(L)) or one element of a list (P[1]).
/// A reduction is one number, so total(L) is neither (`listShape`).
private func listShaped(_ a: Expr, _ isList: (String) -> Bool) -> Bool {
  switch a {
  case .list, .data: return true
  case .var(let name): return isList(name)
  case .neg(let inner): return listShaped(inner, isList)
  case .bin(_, let l, let r, _): return listShaped(l, isList) || listShaped(r, isList)
  case .index: return true
  case .call(let name, let args):
    if SCALAR_REDUCTIONS.contains(name) || ((name == "min" || name == "max") && args.count == 1) { return false }
    return args.contains { listShaped($0, isList) }
  default: return false
  }
}

/// f(P) whose one argument is no point but list-shaped: the `comp` as it
/// waits for list lowering, which picks the coordinate of every point in the
/// list (lib/geom.ts `lower`, case 'comp', its `wait`). Nil when the
/// argument is a point, or is neither: geometry lowering's to settle.
func waitingComp(_ e: Expr, isList: (String) -> Bool, _ lo: (Expr) throws -> Lowered) throws -> Expr? {
  guard case .comp(let value, let k, let n, let fn) = e, listShaped(value, isList) else { return nil }
  do {
    guard case .scalar(let low) = try lo(value) else { return nil }
    return .comp(value: low, index: k, arity: n, functionName: fn)
  } catch let error as Unsupported {
    throw error
  } catch is MatrixSeen {
    throw MatrixSeen()
  } catch {
    // Point-list arithmetic (P + (1, 0)) is no point here either: it is the
    // object expansion's, which finds the list inside.
    return e
  }
}

/// A function applied per member of lists is list lowering's to run; the
/// point arithmetic in its body is lowered here, like any other, and its
/// arguments too: a list of named points is a list of points (lib/geom.ts
/// `lower`, the [map] call).
func lowerMapPoints(_ args: [Expr], _ lower: (Expr) throws -> Expr) throws -> Expr {
  .call(
    MAP,
    try args.enumerated().map { i, a in
      if i == 0 || (i > 1 && i % 2 == 0) { return a }
      if i == 1 { return try lower(a) }
      do {
        return try lower(a)
      } catch let error as Unsupported {
        throw error
      } catch {
        // Point-list arithmetic is the object pass's.
        return a
      }
    })
}

// MARK: - The resolver's part (lib/defs.ts rx, lib/measure.ts reduceOverSet)

private let coordNames = ["x", "y", "z"]

/// The parameters a body reduces over: those inside a reduction's argument
/// (a dotted p.x counts as p). Only those make a call a map (`reducedParams`).
private func reducedParams(_ body: Expr) -> Set<String> {
  var hit: Set<String> = []
  func walk(_ e: Expr) {
    if case .call(let name, let args) = e, reducesMembers(name, args.count) {
      for a in args {
        for v in freeVars(a) { hit.insert(dottedHead(v)) }
      }
    }
    for c in childrenOf(e) { walk(c) }
  }
  walk(body)
  return hit
}

/// The name a mapped parameter takes in its body: one no document can spell,
/// the same every time the row resolves (`mapName`).
private func mapName(_ fn: String, _ k: Int) -> String { "@\(fn):\(k)" }

/// Whether a resolved argument may be a list: a literal, a column, or a name
/// (or a dotted column of one) the document defines as a list (`mayBeList`).
private func mayBeList(_ a: Expr, _ opts: ResolveOpts) -> Bool {
  switch a {
  case .list, .data: return true
  case .var(let name): return opts.isList(dottedHead(name))
  default: return childrenOf(a).contains { mayBeList($0, opts) }
  }
}

extension Resolver {
  /// A list literal: its items resolve, and a range's bounds do — `[1..10]`
  /// expands later, in list lowering, where constant values are known. The
  /// literal is marked as itself (Expr.swift, "List identity").
  func resolveList(_ items: [Expr]) throws -> Expr {
    identifiedList(
      try items.map { x in
        if case .range(let a, let b) = x { return .range(try resolve(a), try resolve(b)) }
        return try resolve(x)
      })
  }

  /// `count`, `total`, `mean`, … of one argument (lib/measure.ts
  /// `reduceOverSet`): over a list it lowers later, as the call it is. Over
  /// x, u or a filter it is an integral against a measure (Measure.swift).
  func resolveReduction(_ name: String, _ raw: Expr) throws -> Expr {
    /// `{c1, c2: f}` (or `{c1, c2}`, f = 1): conditions each written without
    /// a value, then the value — or nil for any other piecewise.
    func barePiecewise(_ e: Expr) -> (conds: [Expr], value: Expr)? {
      guard case .piecewise(let cases, nil) = e, let last = cases.last, cases.dropLast().allSatisfy(\.bare)
      else { return nil }
      return (cases.map(\.cond), last.bare ? .num(1) : last.value)
    }
    // A reduction reads a condition by its shape, so even in a function body
    // it is written in now — unless a parameter would capture it.
    func resolveCondition(_ x: Expr) throws -> Expr {
      let resolved = try resolve(x)
      guard case .var = x, case .var(let name) = resolved, let value = namedCondition(name) else {
        return resolved
      }
      if let captured = freeVars(value).first(where: { opts.params?.contains($0) == true }) {
        throw LanguageError(
          "\(name) reads \(captured), which this function's parameter \(captured) would capture — "
            + "rename the parameter.")
      }
      return value
    }
    var conds: [Expr] = []
    var value: Expr
    var arg: Expr
    if let filter = barePiecewise(raw) {
      conds = try filter.conds.map(resolveCondition)
      value = try resolve(filter.value)
      arg = raw
    } else {
      // count(within): a named condition alone is the filter it names. Or
      // handed back by a function: f(k) = {0 < x < k: x} is the same filter.
      let whole = try resolveCondition(raw)
      arg = whole
      let handed = barePiecewise(whole)
      if let handed { conds = handed.conds }
      value = handed?.value ?? whole
    }
    func comparison(_ e: Expr) -> Bool {
      switch e {
      case .eq, .ineq: true
      default: false
      }
    }
    let filtered = !conds.isEmpty
    if !filtered && comparison(value) {
      conds = [value]
      value = .num(1)
    } else if filtered && comparison(value) {
      throw LanguageError(
        "In {condition: value}, the value is a number to reduce; put every comparison before the colon.")
    }
    let whole = conds + [value]
    func hasList(_ e: Expr) -> Bool {
      if isSeq(e) { return true }
      if case .var(let name) = e, opts.isList(name) { return true }
      return childrenOf(e).contains(where: hasList)
    }
    // Over x, u or a filter of them: an integral against a measure (Measure.swift).
    let continuous = continuousNames(whole)
    if !continuous.isEmpty && !whole.contains(where: hasList) {
      return try reduceContinuous(
        name, conds: conds, value: value, lone: !filtered && !conds.isEmpty && name != "count", names: continuous)
    }
    if barePiecewise(raw) != nil { arg = try resolve(raw) }
    // A tuple literal spreads into arguments, as legacyCallArgs does.
    if case .vec = raw, case .vec(let items) = arg { return .call(name, items) }
    return .call(name, [arg])
  }

  /// A call to a document's function whose arguments are lists it reduces
  /// over: bound per member ([map], lib/list.ts), since the body would
  /// otherwise consume a list argument along with its own lists. Nil when
  /// the call is no map (lib/defs.ts `rx`, the call case).
  func resolveMap(_ name: String, _ fn: FnDef, _ args: [Expr]) throws -> Expr? {
    let reduced = reducedParams(fn.body)
    let listy = args.map { mayBeList($0, opts) }
    guard zip(fn.params, listy).contains(where: { reduced.contains($0) && $1 }) else { return nil }
    var env: [String: Expr] = [:]
    var scalar: [(String, Expr)] = []
    for (k, p) in fn.params.enumerated() where !listy[k] {
      env[p] = args[k]
      scalar.append((p, args[k]))
    }
    for (key, value) in try coordParams(name, fn.body, scalar) { env[key] = value }
    var pairs: [Expr] = []
    for (k, p) in fn.params.enumerated() where listy[k] {
      let mapped = mapName(name, k)
      env[p] = .var(mapped)
      for c in coordNames { env["\(p).\(c)"] = .var("\(mapped).\(c)") }
      pairs.append(.str(mapped))
      pairs.append(args[k])
    }
    return .call(MAP, [.str(name), substVars(freshLists(fn.body, replacing: Set(env.keys)), env)] + pairs)
  }

  /// f(P) ≡ f(P_1, …, P_n): one argument that is an n-component point, or a
  /// list of them. A tuple in hand gives up its items; anything else is not
  /// known to be a point until it lowers, so each parameter asks for its
  /// component of the same node — which is what keeps a list argument's
  /// components moving together (lib/defs.ts `rx`, the call case).
  func resolvePointCall(_ name: String, _ fn: FnDef, _ argument: Expr) throws -> Expr {
    let n = fn.params.count
    let arg = markOrigins(argument)
    if case .vec(let items) = arg, items.count != n {
      throw LanguageError(compDims(name, n, arg, items.count))
    }
    // A body that reduces takes a list of points one point at a time.
    if fn.params.contains(where: reducedParams(fn.body).contains), mayBeList(arg, opts) {
      let names = fn.params.indices.map { mapName(name, $0) }
      var env: [String: Expr] = [:]
      for (p, mapped) in zip(fn.params, names) { env[p] = .var(mapped) }
      let body = substVars(freshLists(fn.body, replacing: Set(env.keys)), env)
      return .call(MAP, [.str(name), body, .str(names.joined(separator: ",")), arg])
    }
    var env: [String: Expr] = [:]
    for (k, p) in fn.params.enumerated() {
      if case .vec(let items) = arg {
        env[p] = items[k]
      } else {
        env[p] = .comp(value: arg, index: k, arity: n, functionName: name)
      }
    }
    return substVars(freshLists(fn.body, replacing: Set(env.keys)), env)
  }

  /// The coordinates of point parameters a body reads, `p.x`, as the
  /// argument's own: a list's are its dotted columns, a named point's are
  /// its components, a tuple gives up its items, and anything else takes a
  /// component of that one node (lib/defs.ts `coordParams`).
  func coordParams(_ name: String, _ body: Expr, _ bound: [(String, Expr)]) throws -> [String: Expr] {
    let used = freeVars(body)
    var env: [String: Expr] = [:]
    for (p, arg) in bound {
      for (k, c) in coordNames.enumerated() where used.contains("\(p).\(c)") {
        let key = "\(p).\(c)"
        if case .var(let argName) = arg, opts.isList(argName) {
          env[key] = .var("\(argName).\(c)")
        } else if case .var(let argName) = arg, let own = pointCoord("\(argName).\(c)") {
          env[key] = own
        } else if case .vec(let items) = arg {
          if k >= items.count { throw LanguageError(compDims(name, 0, arg, items.count)) }
          env[key] = items[k]
        } else {
          env[key] = .comp(value: arg, index: k, arity: 0, functionName: name)
        }
      }
    }
    return env
  }

  /// A list literal marked before it resolved (`markedLists`): its items
  /// resolve, and it keeps the identity it was given. Nil for any other call.
  func resolveMarkedList(_ name: String, _ args: [Expr]) throws -> Expr? {
    guard name == LIST_ID || name == LIST_ORIGIN, args.count == 2, case .list(let items) = args[1] else {
      return nil
    }
    let resolved = try items.map { x -> Expr in
      if case .range(let a, let b) = x { return .range(try resolve(a), try resolve(b)) }
      return try resolve(x)
    }
    return .call(name, [args[0], .list(resolved)])
  }

  /// A Σ/Π whose bounds name a list: one sum per element, a list over that
  /// list's own instances (lib/defs.ts `expandSum`, with `boundList`). Nil
  /// when the bounds name none. One list at a time: two would have to cross
  /// or zip, and neither reading is obvious from `sum(n=A..B, …)`.
  func sumOverList(_ name: String, _ sym: String, _ args: [Expr], _ body: Expr) throws -> Expr? {
    guard let get = opts.getList else { return nil }
    var names: [String] = []
    for n in freeVars(args[1]).list + freeVars(args[2]).list
    where !names.contains(n) && opts.consts(n) == nil && !opts.openVars.contains(n) && opts.isList(n) {
      names.append(n)
    }
    guard let listName = names.first else { return nil }
    if names.count > 1 {
      throw LanguageError(
        "\(sym) bounds can use one list at a time (found \(names.joined(separator: " and "))).")
    }
    var seq: Low?
    do {
      seq = try get(listName)
    } catch let error as Unsupported {
      throw error
    } catch {
      // Reported below.
    }
    var values: [Double]?
    switch seq?.e {
    case .data(let numbers)?: values = numbers
    case .list(let items)?:
      let numbers = items.compactMap { item -> Double? in if case .num(let v) = item { v } else { nil } }
      if numbers.count == items.count { values = numbers }
    default: break
    }
    guard let seq, seq.isSeq, let values else {
      throw LanguageError("\(sym) bounds need a list of plain numbers — \(listName) is not one.")
    }
    if values.count > sumMaxTerms {
      throw LanguageError("\(listName) has too many elements to bound a \(sym) (limit \(sumMaxTerms)).")
    }
    // Each element's sum would itself be a list: a family of families.
    let inner =
      freeVars(body).first { $0 != listName && opts.isList($0) } ?? (holdsList(body) ? "a list literal" : nil)
    if let inner {
      throw LanguageError("\(sym) over the list \(listName) cannot also use \(inner) in its body.")
    }
    let before = ctx.terms
    let items = try values.map { v -> Expr in
      func at(_ e: Expr) -> Expr { substIdx(e, listName, .num(v)) }
      do {
        return try expandSum(.call(name, [args[0], at(args[1]), at(args[2])]), at(body))
      } catch let error as Unsupported {
        throw error
      } catch {
        if ctx.terms <= sumMaxTotal { throw error }
        throw LanguageError(
          "\(sym) over the list \(listName) expands to over \(ctx.terms - before) terms across its values "
            + "(limit \(sumMaxTotal) total).")
      }
    }
    return settledNode(Low(.list(items), namedAxes(listName, seq.own)))
  }

  /// What a derivative cannot reach yet: the site differentiates a list
  /// literal item by item, and refuses a named one.
  func refuseListDerivative(_ e: Expr) throws {
    if holdsList(e) || freeVars(e).contains(where: opts.isList) {
      throw Unsupported("the derivative of a list")
    }
  }
}

/// Whether an unsupported row may be what makes a slider step in whole
/// numbers on the site: it indexes, or bins (`boundConsts`).
func mayBindWholeNumbers(_ text: String) -> Bool {
  text.utf16.contains(unit("[")) || writtenNames(text).contains("hist")
}

// MARK: - Definitions and rows (lib/defs.ts buildDefs, lib/analysis.ts)

/// The builtins that read lists, beside the elementary functions: the
/// resolver lets a call to one through, and list lowering runs it.
let listFunctions: Set<String> = ["count", "total", "mean", "stdev", "median", "sort", "hist"]

/// A list drawn by a binder: the same members, one axis of its own. A
/// scatter of columns is drawn column by column, on that one axis; a tuple,
/// one ordered value with no members to choose among, is itself
/// (lib/defs.ts `drawnFrom`).
private func drawnFrom(_ name: String, _ p: Low) -> Low {
  let own = p.own
  let positions = own.filter(\.ordered)
  if positions.count == own.count { return p }
  let n = own.filter { !$0.ordered }.reduce(1) { $0 * $1.n }
  return Low(p.e, [Axis(id: "\(name)∈", n: n)] + positions, none: p.none)
}

/// A constant definition's value once points and lists have lowered: a list
/// (or a scatter of columns) when it names one, anything else as it is
/// (lib/defs.ts `buildDefs`, from lowerGeom to the list it stores).
func namedList(
  _ name: String, _ resolved: Expr, draw: Bool, ofPoints: Bool, _ defs: BuiltDefs, _ opts: ResolveOpts,
  comps: @escaping (String) -> [String]?
) throws -> Low {
  var e: Expr
  do {
    if ofPoints { throw LanguageError("points") }
    e = try lowerGeom(
      resolved, comps: comps, mats: { defs.mats[$0] }, tensors: tensorGetter(defs), isList: defs.lists.has)
  } catch let error as Unsupported {
    throw error
  } catch {
    // Arithmetic on a list of points is the object pass's.
    e = settledNode(try lowerObjects(resolved, defs, opts, named: true))
  }
  var low = try lowerLists(e, listGetter(defs), opts, named: true)
  // A draw is a choice of its own: A's members over an axis named for the
  // binder, so `p ∈ A`, `q ∈ A` cross where A and A zip.
  if draw, low.isSeq || isDataScatter(low.e) { low = drawnFrom(name, low) }
  if case .list(let items) = low.e {
    let vecs = items.compactMap { it -> Int? in if case .vec(let comps) = it { comps.count } else { nil } }
    if !vecs.isEmpty, vecs.count != items.count { throw LanguageError("Lists cannot mix numbers and points.") }
    if Set(vecs).count > 1 {
      throw LanguageError("All points in a list need the same number of coordinates.")
    }
  }
  return low
}

/// Whether a definition reads a named multiset of points: `M Q` with Q one
/// is those points moved, never a matrix (lib/defs.ts `ofPoints`).
func readsPointList(_ resolved: Expr, _ defs: BuiltDefs) -> Bool {
  freeVars(resolved).contains { name in
    if case .list(let items)? = defs.lists[name]?.e, case .vec? = items.first { return true }
    return false
  }
}

/// Complex constants written into the named lists that read them, as they
/// are into the constants (lib/defs.ts `buildDefs`, after `writeComplex`).
func writeComplexLists(_ defs: inout BuiltDefs) {
  for (name, list) in defs.lists.entries {
    guard case .list(let items) = list.e else { continue }
    var changed = false
    let written = items.map { item -> Expr in
      var sub: [String: Expr] = [:]
      for v in freeVars(item) {
        if let value = defs.complexes[v] { sub[v] = value }
      }
      if sub.isEmpty { return item }
      changed = true
      return substVars(item, sub)
    }
    if changed { defs.lists[name] = Low(.list(written), list.axes, none: list.none) }
  }
}

/// The named lists whose elements read something that is not a constant or
/// t, with what each says: a list holds data (lib/defs.ts `buildDefs`).
func strayListNames(_ defs: BuiltDefs, _ constNames: Set<String>) -> [(String, String)] {
  var out: [(String, String)] = []
  for (name, seq) in defs.lists.entries {
    guard case .list(let items) = seq.e else { continue }
    let stray = items.lazy.flatMap { freeVars($0).list }.first {
      $0 != "t" && $0 != "i" && !constNames.contains($0)
    }
    guard let stray else { continue }
    out.append(
      (
        name,
        defs.conditions.has(stray)
          ? conditionAsNumber(stray)
          : "\(name) is a list, so its elements may only use constants and t (found \(stray))."
      ))
  }
  return out
}

/// Every equality case below `e` as exactCase, but one whose side is a list:
/// that stays an equation, for list lowering to decide member by member. (A
/// list inside a reduction is one number.) (lib/analysis.ts, lib/automaton.ts
/// `exactCases` with `keep`.)
func exactCases(_ e: Expr, keepingLists isList: (String) -> Bool) -> Expr {
  func listy(_ side: Expr) -> Bool {
    switch side {
    case .list, .data: return true
    case .var(let name): return isList(name)
    case .call(let name, let args):
      if SCALAR_REDUCTIONS.contains(name) || ((name == "min" || name == "max") && args.count == 1) {
        return false
      }
      return args.contains(where: listy)
    default: return childrenOf(side).contains(where: listy)
    }
  }
  func walk(_ e: Expr) -> Expr {
    let inner = mapChildren(e, walk)
    guard case .piecewise(let cases, let otherwise) = inner else { return inner }
    return .piecewise(
      cases.map { c in
        if case .eq(let l, let r) = c.cond, !listy(l), !listy(r) {
          return Expr.Case(cond: exactCase(l, r), value: c.value, bare: c.bare)
        }
        return c
      }, otherwise: otherwise)
  }
  return walk(e)
}

/// A note for a call that applies per member ([map]) where a reduction in
/// its body sees nothing but the member: `avg(s) = mean(s)`; `avg(L)` is L,
/// each member reduced alone, which reads like a wrapper for mean(L)
/// (lib/analysis.ts `perMemberNote`).
func perMemberNote(_ e: Expr, _ isList: (String) -> Bool) -> String? {
  if case .call(MAP, let args) = e, case .str(let fn)? = args.first, args.count >= 2 {
    var members: Set<String> = []
    for a in args.dropFirst(2) {
      guard case .str(let names) = a else { continue }
      var name = ""
      for u in names.unicodeScalars {
        if u == "," {
          members.insert(name)
          name = ""
        } else {
          name.unicodeScalars.append(u)
        }
      }
      members.insert(name)
    }
    func listFree(_ x: Expr) -> Bool {
      switch x {
      case .list, .data: return false
      case .var(let name): return !isList(dottedHead(name))
      default: return childrenOf(x).allSatisfy(listFree)
      }
    }
    var lone: String?
    func walk(_ x: Expr) {
      if lone != nil { return }
      if case .call(let name, let inner) = x, reducesMembers(name, inner.count) {
        let vars = inner.flatMap { freeVars($0).list.map(dottedHead) }
        if vars.contains(where: members.contains), inner.allSatisfy(listFree) { lone = name }
        return
      }
      for c in childrenOf(x) { walk(c) }
    }
    walk(args[1])
    if let lone {
      return "\(fn) applies per member, so its \(lone) sees one member at a time; "
        + "for the whole list, write \(lone)(…) in the row"
    }
  }
  for c in childrenOf(e) {
    if let note = perMemberNote(c, isList) { return note }
  }
  return nil
}

/// A readout followed by the row's note (lib/analysis.ts `withNote`).
func withNote(_ info: String?, _ note: String?) -> String? {
  guard let note else { return info }
  return info.map { "\($0) · \(note)" } ?? note
}

/// A note for `p ∈ [a, b]` with a < b: the notation reads as the interval
/// from a to b, and here it is the two members a and b (lib/analysis.ts
/// `pairDrawNote`).
func pairDrawNote(_ name: String, _ rhs: String) -> String? {
  // ^\s*\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]\s*$
  var s = RowScanner(rhs)
  func number() -> String? {
    let start = s.i
    _ = s.eat("-")
    let digits = s.i
    while let c = s.peek, isDigit(c) || c == unit(".") { s.i += 1 }
    return s.i > digits ? s.text(start..<s.i) : nil
  }
  s.space()
  guard s.eat("[") else { return nil }
  s.space()
  guard let a = number() else { return nil }
  s.space()
  guard s.eat(",") else { return nil }
  s.space()
  guard let b = number() else { return nil }
  s.space()
  guard s.eat("]") else { return nil }
  s.space()
  guard s.atEnd, JS.number(a) < JS.number(b) else { return nil }
  return "\(name) is \(a) or \(b), the list's two members; for every number from \(a) to \(b), "
    + "write \(name) = interval(\(a), \(b))"
}

/// Whether a row's value is a point, points, or a figure through them —
/// anything classify draws by position rather than as numbers, which have a
/// density (lib/analysis.ts `pointValued`).
func drawnByPosition(_ value: Expr) -> Bool {
  switch value {
  case .vec, .figure, .family: return true
  case .list(let items): return items.contains { if case .vec = $0 { true } else { false } }
  case .lazy(_, let body): if case .vec = body { return true } else { return false }
  default: return false
  }
}

/// A state's rate or start, which may not read a list yet: a list of starts
/// is a family of runs, one state per member (lib/defs.ts, the state
/// families), which is not ported.
func withoutStateFamily(_ resolved: Expr, _ opts: ResolveOpts) throws -> Expr {
  if readsLists(resolved, opts) { throw Unsupported("a family of states") }
  return resolved
}

/// Whether a resolved expression reads a list anywhere: a literal, a named
/// list, a position or a filter, text, or a function that reduces or sorts
/// one. What a pass that does not lower lists asks before it goes on. (A
/// matrix or a tensor indexes as a list does, but is none.)
func readsLists(_ e: Expr, _ opts: ResolveOpts) -> Bool {
  readsLists(e) { name in ((try? opts.getList?(name)) ?? nil) != nil }
}

private func readsLists(_ e: Expr, _ isList: (String) -> Bool) -> Bool {
  switch e {
  case .list, .data, .text, .lazy, .index, .eqtest, .str, .hist: return true
  case .var(let name): return isList(name) || isList(dottedHead(name))
  case .call(let name, let args):
    if listFunctions.contains(name) || name == MAP || name == LIST_SEQ { return true }
    if (name == "min" || name == "max") && args.count == 1 { return true }
    return args.contains { readsLists($0, isList) }
  default: return childrenOf(e).contains { readsLists($0, isList) }
  }
}

/// The body of a P(…) or E(…) row once its points and lists have lowered
/// (lib/analysis.ts `parseRowBody`): points first, as in a plot row — what
/// geometry refuses stays as written — then lists, with no expansion into a
/// family.
func lowerBody(_ e: Expr, _ defs: BuiltDefs, _ opts: ResolveOpts) throws -> Expr {
  let get = listGetter(defs)
  var lowered = e
  do {
    lowered = try lowerGeom(
      e, comps: opts.comps, mats: { defs.mats[$0] }, isList: { name in ((try? get(name)) ?? nil) != nil })
  } catch let error as Unsupported {
    throw error
  } catch {
    // As written.
  }
  return try lowerLists(lowered, get, opts).e
}
