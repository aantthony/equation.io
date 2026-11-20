/// What a map's Σ and Π read of the document (lib/defs.ts `MapDoc`): the
/// names it defines, which of them are lists, and the sliders a bound reads
/// (noted in `boundConsts`, so they step in whole numbers). `budget` counts
/// the terms written out so far, shared by a row's maps and components under
/// one limit as a row's tuple is.
struct MapDoc {
  var documentNames: Set<String> = []
  var valueNames: Set<String> = []
  var boundConsts: NameBox?
  var isList: (String) -> Bool = { _ in false }
  var getList: GetList?
  var fnNames: Set<String> = []
  var budget = ResolveCtx()
}

/// A map's expression — a view's axis or plane map, an on(…) surface — with
/// its Σ/Π written out term by term, so the GPU and the CPU both see plain
/// arithmetic (lib/defs.ts `expandMapSums`). Only the sums are expanded: the
/// rest stays as written (a d/dx in a map is refused inside a sum or out).
/// Each sum's bounds go through expandSum as a row's do, so they read the
/// sliders in `consts` under the same limits, counted across all of `e` and
/// doc.budget; a bound in `coords`, the map's own coordinates, is refused, as
/// they change from point to point. A bare function name (`cos X`) is caught
/// here too, where it would otherwise read as a name with no value.
func expandMapSums(_ e: Expr, _ coords: [String], _ consts: [String: Double], _ doc: MapDoc) throws -> Expr {
  let budget = doc.budget
  var opts = ResolveOpts()
  opts.consts = { consts[$0] }
  opts.boundConsts = doc.boundConsts
  opts.isList = doc.isList
  opts.getList = doc.getList
  let resolver = Resolver(getFn: { _ in nil }, opts: opts)

  func walk(_ e: Expr) throws -> Expr {
    if case .call(let name, let args) = e, name == "sum" || name == "prod" {
      // Without a body, resolving says so as it does in a row.
      if args.count == 4 { return try expand(e, args[3]) }
      return try Resolver(getFn: { _ in nil }, opts: ResolveOpts()).resolve(e)
    }
    // `2 sum[n=1..3] Y^n/n`: the header binds the rest of its product.
    if case .bin = e, let chain = splitSumChain(e), isSumHeader(chain.header) {
      let sum = try expand(chain.header, chain.body)
      return try chain.coeff.map { .bin(chain.op, try walk($0), sum) } ?? sum
    }
    return try mapChildren(e, walk)
  }

  func expand(_ call: Expr, _ body: Expr) throws -> Expr {
    guard case .call(let fn, let args) = call else { return call }
    let sym = fn == "sum" ? "Σ" : "Π"
    for b in args[1..<3] {
      for v in freeVars(b).list {
        if coords.contains(v) {
          throw LanguageError("\(sym) needs bounds that are fixed numbers or sliders; \(v) changes across the map.")
        } else if doc.fnNames.contains(v) {
          throw LanguageError("\(sym) in a map takes numbers and sliders as bounds; it cannot call \(v) yet.")
        }
      }
    }
    // Expanded with a marker for a body, which says which indices the bounds
    // take; the body itself is written in at each, unresolved.
    let idx = args[0]
    let marked = try resolver.resolve(.call(fn, Array(args[0..<3]) + [.call("floor", [idx])]))
    var at: [Double] = []
    func read(_ m: Expr) throws {
      if case .call("floor", let inner) = m, case .num(let k)? = inner.first {
        at.append(k)
      } else if case .bin(let op, let a, let b, _) = m, op == (fn == "sum" ? .add : .mul) {
        try read(a)
        try read(b)
      } else {
        if case .num = m, at.isEmpty { return }
        // A list bound makes a family of sums, one per element.
        throw LanguageError("\(sym) in a map needs each bound to be one number, not a list.")
      }
    }
    try read(marked)
    budget.terms += at.count
    if budget.terms > sumMaxTotal {
      throw LanguageError("Nested \(sym) expand to too many terms (limit \(sumMaxTotal) total).")
    }
    // expandSum has refused any index but a name.
    guard case .var(let name) = idx else { return call }
    var acc: Expr?
    for k in at {
      let term = foldNums(try walk(substIdx(body, name, .num(k))))
      acc = acc.map { fn == "sum" ? add($0, term) : mul($0, term) } ?? term
    }
    return acc ?? .num(fn == "sum" ? 0 : 1)
  }

  let out = try walk(e)
  for v in freeVars(out).list where builtinFn(v) == v && consts[v] == nil && !doc.documentNames.contains(v) {
    throw LanguageError("\(v) is a function — write it with parentheses, e.g. \(v)(\(coords[0])).")
  }
  return out
}
