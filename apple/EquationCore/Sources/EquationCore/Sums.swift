/// Σ and Π (lib/defs.ts `splitSumChain`, `substIdx`, `foldNums`,
/// `expandSum`): a sum is written out term by term when the row resolves,
/// so every backend sees plain arithmetic.
///
/// - `sum(n=1..N, sin(n x)/n)` and the header form `sum[n=1..N] sin(n x)/n`,
///   which binds the rest of its product chain as its body.
/// - A bound reads the constants' values at expansion time; a slider it
///   names steps in whole numbers (`ResolveOpts.boundConsts`).
/// - A bound that uses an open name (a sequence's index, `a_n = Σ(s=1..n,
///   s)`) cannot expand: the sum stays a call and `evaluate` runs it.
///
/// A bound that names a list (one sum per element) needs lists, which are
/// not ported: such a name never resolves here, its rows are left alone.

/// What one resolve counts as it goes (lib/defs.ts `Ctx`).
final class ResolveCtx {
  /// Terms expanded so far across every Σ/Π in this resolve (nesting multiplies).
  var terms = 0
  /// Every ∫ this resolve expanded (`resolveRow`): its resolved pieces when
  /// it is a plain definite integral, nil otherwise. Nil when nobody asked.
  var ints: [IntShade?]?
}

/// Names noted while a document resolves, shared by all of its resolves: the
/// constants a Σ/Π bound reads (lib/defs.ts `boundConsts`).
final class NameBox {
  var names: Set<String> = []
}

/// How many terms every Σ/Π of one resolve may come to (`SUM_MAX_TOTAL`).
let sumMaxTotal = 2000

/// A Σ/Π header awaiting a body: `sum[n=1..N]`, args [index, lo, hi].
func isSumHeader(_ e: Expr) -> Bool {
  if case .call(let name, let args) = e { return (name == "sum" || name == "prod") && args.count == 3 }
  return false
}

/// An ∫ header awaiting its body: `int[a..b]` (bounds) or a bare `int`/∫.
func isIntHeader(_ e: Expr) -> Bool {
  switch e {
  case .call("int", let args): args.count == 2
  case .var("int"): true
  default: false
  }
}

/// The bounds of an ∫ header, or nil for the bare indefinite form.
func intBounds(_ header: Expr) -> (Expr, Expr)? {
  if case .call(_, let args) = header, args.count == 2 { return (args[0], args[1]) }
  return nil
}

/// Canonical call node for an ∫ header and its chain-bound body.
func intCallOf(_ header: Expr, _ body: Expr) -> Expr {
  if let b = intBounds(header) { return .call("int", [b.0, b.1, body]) }
  return .call("int", [body])
}

/// A header and the product chain it binds (lib/defs.ts `splitSumChain`).
struct SumChain {
  var coeff: Expr?
  var op: BinOp
  var header: Expr
  var body: Expr

  /// The header with its body, as the call it stands for.
  var canonical: Expr {
    if isSumHeader(header), case .call(let name, let args) = header { return .call(name, args + [body]) }
    return intCallOf(header, body)
  }
}

/// A header in a product chain binds its trailing factors: in
/// `2 sum[n=1..N] sin(n x)/n` the body is sin(n x)/n and the 2 stays outside
/// (like d/dx, which also binds the rest of its product chain). ∫ headers
/// bind the same way; the leftmost header wins, so
/// `int[0..1] sum[n=1..2] x^n dx` nests the Σ inside the ∫'s body.
func splitSumChain(_ e: Expr) -> SumChain? {
  var factors: [(e: Expr, op: BinOp)] = []
  var node = e
  while case .bin(let op, let a, let b, _) = node, op == .mul || op == .div {
    factors.insert((b, op), at: 0)
    node = a
  }
  factors.insert((node, .mul), at: 0)
  guard let at = factors.firstIndex(where: { isSumHeader($0.e) || isIntHeader($0.e) }) else { return nil }
  let rest = factors[(at + 1)...]
  // (A bodyless header: the call case reports it.)
  guard let first = rest.first else { return nil }
  var body: Expr = first.op == .mul ? first.e : .bin(.div, .num(1), first.e)
  for f in rest.dropFirst() { body = .bin(f.op, body, f.e) }
  var coeff: Expr?
  for f in factors[..<at] { coeff = coeff.map { .bin(f.op, $0, f.e) } ?? f.e }
  return SumChain(coeff: coeff, op: factors[at].op, header: factors[at].e, body: body)
}

/// A differential's name: d and one letter, Latin or Greek (dx, dθ)
/// (lib/defs.ts `dVarName`).
func differentialName(_ e: Expr) -> String? {
  guard case .var(let name) = e else { return nil }
  let u = Array(name.utf16)
  guard u.count == 2, u[0] == unit("d"), isNameLetter(u[1]) else { return nil }
  return String(u[1...])
}

/// An ∫ body split at its measure (lib/defs.ts `StripDx`).
struct StripDx {
  var v: String
  var integrand: Expr
  /// Factors after this integral's measure that carry another d-var: they
  /// belong to an enclosing ∫ (`int[0..1] int[0..y] x dx dy` pairs inside
  /// out), so the expansion multiplies them back on for the outer level.
  var residual: Expr?
}

/// Split the integration variable off a body: the first d<letter> factor in
/// its multiplicative structure (`x^2 dx` → v = x, integrand x^2). Written
/// touching, `1/(1+x^2)dx`, the dx binds tighter than '/' and sits inside the
/// denominator product: the measure is recognized on either side and the
/// rest of that denominator stays a true denominator. A tail after the
/// measure folds into the integrand (`∫ dx/(1+x^2)`) unless it carries its
/// own d-var, in which case it is the enclosing integral's (residual). Sums
/// integrate termwise, so every term must end in the same dx.
func stripDx(_ body: Expr) throws -> StripDx? {
  if case .neg(let a) = body {
    guard var m = try stripDx(a) else { return nil }
    m.integrand = neg(m.integrand)
    return m
  }
  if case .bin(let op, let l, let r, _) = body, op == .add || op == .sub {
    let a = try stripDx(l)
    let b = try stripDx(r)
    if a == nil && b == nil { return nil }
    guard let a, let b, a.v == b.v, a.residual == nil, b.residual == nil else {
      throw LanguageError("Every term under one ∫ must end in the same d\(a?.v ?? b?.v ?? "x").")
    }
    return StripDx(v: a.v, integrand: .bin(op, a.integrand, b.integrand), residual: nil)
  }
  var factors: [(e: Expr, inv: Bool)] = []
  func walk(_ e: Expr, _ inv: Bool) {
    if case .bin(let op, let a, let b, _) = e, op == .mul || op == .div {
      walk(a, inv)
      walk(b, op == .div ? !inv : inv)
      return
    }
    factors.append((e, inv))
  }
  walk(body, false)
  guard let at = factors.firstIndex(where: { differentialName($0.e) != nil }) else { return nil }
  let v = differentialName(factors[at].e)!
  let tail = Array(factors[(at + 1)...])
  let tailHasDx = tail.contains { differentialName($0.e) != nil }
  let inside = tailHasDx ? Array(factors[..<at]) : factors.enumerated().filter { $0.offset != at }.map(\.element)
  func product(_ fs: [(e: Expr, inv: Bool)]) -> Expr {
    var numr: Expr?
    var den: Expr?
    for f in fs {
      if f.inv {
        den = den.map { .bin(.mul, $0, f.e) } ?? f.e
      } else {
        numr = numr.map { .bin(.mul, $0, f.e) } ?? f.e
      }
    }
    let out = numr ?? .num(1)
    return den.map { .bin(.div, out, $0) } ?? out
  }
  return StripDx(v: v, integrand: product(inside), residual: tailHasDx ? product(tail) : nil)
}

/// `substVars` for a Σ/Π index, stopping at nested Σ/Π that rebind the same
/// name (lib/defs.ts `substIdx`).
func substIdx(_ e: Expr, _ idx: String, _ val: Expr) -> Expr {
  func sub(_ x: Expr) -> Expr { substIdx(x, idx, val) }
  switch e {
  case .index, .range, .eqtest, .comp, .figure, .lazy, .trail, .label, .hist, .family:
    return mapChildren(e, sub)
  case .num, .data, .str, .text:
    return e
  case .var(let name):
    if name == idx { return val }
    // A subscript written with the index names a term: a_n at n = 3 is a_3.
    let u = Array(name.utf16)
    let w = Array(idx.utf16)
    if u.count == w.count + 2, u[1] == unit("_"), Array(u[2...]) == w, isNameLetter(u[0]),
      case .num(let k) = val, JS.isInteger(k), k >= 0
    {
      return .var("\(String(u[..<1]))_\(JS.string(k))")
    }
    return e
  case .neg(let a):
    return .neg(sub(a))
  case .bin(let op, let a, let b, _):
    if op == .mul || op == .div, let m = splitSumChain(e) {
      // A bodyless header binds the rest of its product chain as its body
      // (`sum[n=1..2] sum[n=1..3] n`). Canonicalize to the full call so the
      // rebinding guard below sees that body as the inner binder's own, not
      // as a sibling factor ours may substitute into.
      let call = sub(m.canonical)
      return m.coeff.map { .bin(m.op, sub($0), call) } ?? call
    }
    return .bin(op, sub(a), sub(b))
  case .call(let name, let args):
    if name == "sum" || name == "prod", case .var(idx)? = args.first {
      // The inner Σ rebinds idx: substitute in its bounds but not its body.
      return .call(name, args.enumerated().map { k, a in k == 0 || k == 3 ? a : sub(a) })
    }
    if name == "int", args.count == 1 || args.count == 3 {
      // An ∫ whose dx names this index rebinds it: bounds only.
      let bodyAt = args.count - 1
      // (Several dx factors: expansion will report it.)
      if let dx = try? stripDx(args[bodyAt]), dx.v == idx {
        return .call("int", args.enumerated().map { k, a in k == bodyAt ? a : sub(a) })
      }
    }
    return .call(name, args.map(sub))
  case .eq(let l, let r):
    return .eq(sub(l), sub(r))
  case .ineq(let op, let l, let r, let grouped):
    return .ineq(op, sub(l), sub(r), grouped: grouped)
  case .vec(let items):
    return .vec(items.map(sub))
  case .list(let items):
    return .list(items.map(sub))
  case .piecewise(let cases, let otherwise):
    return .piecewise(
      cases.map { Expr.Case(cond: sub($0.cond), value: sub($0.value), bare: $0.bare) }, otherwise: otherwise.map(sub))
  case .loop(let params, let seeds, let body, let limit):
    // A loop's params rebind inside its body: substitute in the seeds only.
    return .loop(params: params, seeds: seeds.map(sub), body: params.contains(idx) ? body : sub(body), limit: limit)
  }
}

/// Fold numeric subtrees ((2·3-1) → 5) so expanded Σ terms compile to
/// compact GLSL (lib/defs.ts `foldNums`). With `calls`, a call whose
/// arguments all folded (cos(1/3)) folds too, for consumers that evaluate
/// the tree on the CPU rather than emit it.
func foldNums(_ e: Expr, calls: Bool = false) -> Expr {
  func fold(_ x: Expr) -> Expr { foldNums(x, calls: calls) }
  switch e {
  case .index, .range, .eqtest, .comp, .figure, .lazy, .trail, .label, .hist, .family:
    return mapChildren(e, fold)
  case .num, .var, .data, .str, .text:
    return e
  case .neg(let a):
    return neg(fold(a))
  case .bin(let op, let l, let r, _):
    let a = fold(l)
    let b = fold(r)
    if case .num = a, case .num = b, let v = try? evaluate(.bin(op, a, b), [:]), v.isFinite { return .num(v) }
    switch op {
    case .add: return add(a, b)
    case .sub: return sub(a, b)
    case .mul: return mul(a, b)
    case .div: return div(a, b)
    case .pow: return pow(a, b)
    }
  case .call(let name, let args):
    let out = Expr.call(name, args.map(fold))
    if calls, case .call(_, let folded) = out, !folded.isEmpty,
      folded.allSatisfy({ if case .num = $0 { true } else { false } }),
      // (Not a scalar builtin: the interpreter keeps it.)
      let v = try? evaluate(out, [:]), v.isFinite
    {
      return .num(v)
    }
    return out
  case .eq(let l, let r):
    return .eq(fold(l), fold(r))
  case .ineq(let op, let l, let r, let grouped):
    return .ineq(op, fold(l), fold(r), grouped: grouped)
  case .vec(let items):
    return .vec(items.map(fold))
  case .list(let items):
    return .list(items.map(fold))
  case .piecewise(let cases, let otherwise):
    return .piecewise(
      cases.map { Expr.Case(cond: fold($0.cond), value: fold($0.value), bare: $0.bare) },
      otherwise: otherwise.map(fold))
  case .loop:
    // (As the TypeScript's `mapChildren(e, foldNums)`: calls do not fold below a loop.)
    return mapChildren(e) { foldNums($0) }
  }
}

extension Resolver {
  /// Expand a Σ/Π into an explicit sum/product of per-index terms
  /// (lib/defs.ts `expandSum`).
  func expandSum(_ header: Expr, _ body: Expr) throws -> Expr {
    guard case .call(let name, let args) = header, args.count >= 3 else { return header }
    let sym = name == "sum" ? "Σ" : "Π"
    guard case .var(let idx) = args[0] else { throw LanguageError("Expected \(name)(n=1..N, …).") }
    if reservedNames.contains(idx) {
      throw LanguageError("Cannot use \"\(idx)\" as a \(sym) index (it is reserved).")
    }
    // A literal in the body is written once: every term's copy is that one
    // list, so the terms pair up element by element rather than crossing.
    // A bound that names a list is one sum per element (ObjectLists.swift).
    let body = markedLists(body)
    if let listed = try sumOverList(name, sym, args, body) { return listed }
    // A bound that uses an open name (the sequence index, or a function's
    // parameter) cannot be expanded here: the sum stays a call and evaluate()
    // runs it once that name is a number.
    func bound(_ b: Expr) throws -> (expr: Expr, value: Double?) {
      let r = try resolve(b)
      var env: [String: Double] = [:]
      var open = false
      for fv in freeVars(r) {
        // A function's parameter is its argument, never the document's name of
        // the same spelling: the bound stays open until the call substitutes it.
        if opts.params?.contains(fv) == true || opts.openVars.contains(fv) {
          open = true
          continue
        }
        if let v = opts.consts(fv) {
          opts.boundConsts?.names.insert(fv)
          env[fv] = v
          continue
        }
        if fv == "t" || reservedNames.contains(fv) { throw LanguageError("\(sym) bounds cannot depend on \(fv).") }
        throw LanguageError("\(sym) bounds must be constant — add \"\(fv) = 5\" in a row above.")
      }
      if open { return (r, nil) }
      let v = try evaluate(r, env)
      if !v.isFinite { throw LanguageError("\(sym) bound is not finite.") }
      return (r, v)
    }
    let lo = try bound(args[1])
    if let loValue = lo.value, let gated = try sliderGated(name, idx, args[2], body, loValue) { return gated }
    let hi = try bound(args[2])
    guard let loValue = lo.value, let hiValue = hi.value else {
      var inner = self
      inner.opts.openVars.insert(idx)
      return .call(name, [.var(idx), lo.expr, hi.expr, try inner.resolve(body)])
    }
    let start = (loValue - 1e-9).rounded(.up)
    let end = (hiValue + 1e-9).rounded(.down)
    let count = end - start + 1
    if count > Double(sumMaxTerms) {
      throw LanguageError("\(sym) expands to \(JS.string(count)) terms (limit \(sumMaxTerms)).")
    }
    ctx.terms += Int(JS.max([count, 0]))
    if ctx.terms > sumMaxTotal {
      throw LanguageError("Nested \(sym) expand to too many terms (limit \(sumMaxTotal) total).")
    }
    var acc: Expr?
    var k = start
    while k <= end {
      let term = foldNums(try resolve(substIdx(body, idx, .num(k))))
      acc = acc.map { name == "sum" ? add($0, term) : mul($0, term) } ?? term
      k += 1
    }
    return acc ?? .num(name == "sum" ? 0 : 1)
  }

  /// Expand the Σ/Π a function's body left open on its parameters, now that
  /// a call has substituted its arguments: `f(N) = sum(k=1..N, k)` keeps the
  /// sum a call (expandSum), and `f(100)` expands it to 100. A bound still
  /// open here — on an enclosing function's parameter or a sequence index —
  /// waits as before (lib/sums.ts `expandClosedSums`).
  func expandClosedSums(_ e: Expr) throws -> Expr {
    if case .call(let name, let args) = e, name == "sum" || name == "prod", args.count == 4 {
      func open(_ b: Expr) -> Bool {
        freeVars(b).contains { opts.params?.contains($0) == true || opts.openVars.contains($0) }
      }
      if open(args[1]) || open(args[2]) { return e }
      return try expandSum(e, args[3])
    }
    return try mapChildren(e) { try expandClosedSums($0) }
  }

  /// A Σ up to a clamped whole-number slider, `N = round(clamp(19, 1, 50))`,
  /// whose terms form a sine/cosine series expands to the slider's maximum,
  /// each term gated on `N >= k`: N is then read at runtime rather than baked
  /// into the expansion, and Shader.swift's fourierLoop runs the series only
  /// up to N, as for reconstruct. Nil for anything else — another bound or
  /// body, a range fourierLoop cannot loop over — which then expands at the
  /// current value as usual (lib/sums.ts `sliderGated`).
  private func sliderGated(_ sum: String, _ idx: String, _ hiE: Expr, _ body: Expr, _ lo: Double) throws -> Expr? {
    guard sum == "sum", case .var(let name) = hiE else { return nil }
    // A parameter or open index named like a slider is its own value.
    if opts.params?.contains(name) == true || opts.openVars.contains(name) { return nil }
    guard opts.consts(name) != nil, let range = wholeClampRange(opts.definition(name)) else { return nil }
    let start = (lo - 1e-9).rounded(.up)
    let count = range.hi - start + 1
    if start < 1 || count > Double(sumMaxTerms) || Double(ctx.terms) + count > Double(sumMaxTotal) { return nil }
    var acc: Expr?
    var k = start
    while k <= range.hi {
      // Even the terms the slider's minimum always keeps are gated: a uniform
      // run of gates is the shape fourierLoop reads.
      let value = Expr.piecewise(
        [Expr.Case(cond: .ineq(.ge, hiE, .num(k)), value: foldNums(try resolve(substIdx(body, idx, .num(k)))))],
        otherwise: .num(0))
      acc = acc.map { add($0, value) } ?? value
      k += 1
    }
    guard let acc, fourierSeries(acc) != nil else { return nil }
    ctx.terms += Int(count)
    opts.boundConsts?.names.insert(name)
    return acc
  }
}

/// The whole-number [lo, hi] of a rounded clamp slider — round(clamp(v, lo,
/// hi)) or clamp(round(v), lo, hi), i.e. min(max(…)) with a round, floor or
/// ceil outside or around v and integer ends — or nil. Its value is then
/// always a whole number in [lo, hi], so `N >= k` gates exactly
/// (lib/sums.ts `wholeClampRange`).
private func wholeClampRange(_ definition: Expr?) -> (lo: Double, hi: Double)? {
  func rounding(_ e: Expr?) -> Expr? {
    if case .call(let name, let args)? = e, ["round", "floor", "ceil"].contains(name), args.count == 1 {
      return args[0]
    }
    return nil
  }
  var e = definition
  var rounded = false
  while let inner = rounding(e) {
    rounded = true
    e = inner
  }
  guard case .call("min", let outer)? = e, outer.count == 2, case .call("max", let inside) = outer[0],
    inside.count == 2
  else { return nil }
  if !rounded && rounding(inside[0]) == nil { return nil }
  guard case .num(let lo) = inside[1], case .num(let hi) = outer[1], lo.isFinite, hi.isFinite,
    lo == lo.rounded(), hi == hi.rounded()
  else { return nil }
  return hi > lo ? (lo, hi) : nil
}
