/// Real expression components for CPU solving and point rendering
/// (lib/complex-parts.ts), and the structural size of a tree (lib/size.ts).

/// Nodes in `e`, a shared subtree counted once per use (lib/size.ts
/// `countNodes`): every object of the TypeScript's tree is one — a node, a
/// piecewise case, a packed column and its array — and its strings and
/// numbers none. Counting stops once past `limit`, when all that is asked is
/// whether the tree is larger than that.
func countNodes(_ e: Expr, limit: Int = .max) -> Int {
  var n = 0
  func walk(_ e: Expr) {
    n += 1
    if n > limit { return }
    switch e {
    case .piecewise(let cases, let otherwise):
      for c in cases {
        n += 1
        walk(c.cond)
        walk(c.value)
      }
      if let otherwise { walk(otherwise) }
    case .hist: n += 2
    case .data: n += 1
    case .figure(_, _, let vertices, let over):
      for v in vertices { walk(v) }
      n += 2 * (over?.count ?? 0)
    case .lazy(let cols, let body):
      n += 2 * cols.count
      walk(body)
    default:
      for child in childrenOf(e) where n <= limit { walk(child) }
    }
  }
  walk(e)
  return n
}

/// Whether `e` has more than `limit` nodes (lib/size.ts `exceedsNodes`).
func exceedsNodes(_ e: Expr, _ limit: Int) -> Bool {
  countNodes(e, limit: limit) > limit
}

/// A value's real and imaginary parts.
typealias Pair = (re: Expr, im: Expr)

private func num(_ value: Double) -> Expr { .num(value) }
private func bin(_ op: BinOp, _ a: Expr, _ b: Expr) -> Expr { .bin(op, a, b) }
private func call(_ name: String, _ args: Expr...) -> Expr { .call(name, args) }
private func both(_ a: Pair, _ f: (Expr) -> Expr) -> Pair { (f(a.re), f(a.im)) }

private func addParts(_ a: Pair, _ b: Pair) -> Pair { (bin(.add, a.re, b.re), bin(.add, a.im, b.im)) }
private func mulParts(_ a: Pair, _ b: Pair) -> Pair {
  (
    bin(.sub, bin(.mul, a.re, b.re), bin(.mul, a.im, b.im)),
    bin(.add, bin(.mul, a.re, b.im), bin(.mul, a.im, b.re))
  )
}
private func negPart(_ a: Expr) -> Expr { bin(.mul, num(-1), a) }
private func norm2(_ a: Pair) -> Expr { bin(.add, bin(.pow, a.re, num(2)), bin(.pow, a.im, num(2))) }
private func divParts(_ a: Pair, _ b: Pair) -> Pair {
  both(mulParts(a, (b.re, negPart(b.im)))) { bin(.div, $0, norm2(b)) }
}
private func expParts(_ a: Pair) -> Pair {
  (bin(.mul, call("exp", a.re), call("cos", a.im)), bin(.mul, call("exp", a.re), call("sin", a.im)))
}
private func lnParts(_ a: Pair) -> Pair { (bin(.div, call("ln", norm2(a)), num(2)), call("atan2", a.im, a.re)) }

/// Nodes (lib/size.ts) a split may grow to: one sample of a complex path, a
/// list member, a real value read through complex ones. Splitting duplicates
/// subterms — every product uses both parts of both factors — so nesting grows
/// the tree geometrically (three deep of w^2 + w is ~5k nodes, eight deep
/// would be millions). The budget keeps a per-frame resample of an animated
/// path within a few milliseconds.
let SPLIT_NODE_BUDGET = 10000

/// What a split past SPLIT_NODE_BUDGET says, of `subject`.
func splitTooLarge(_ subject: String, _ verb: String) -> String {
  "\(subject) is too large to \(verb) once split into real and imaginary parts — reduce the nesting or the powers."
}

/// Thrown when a split outgrows its budget; callers word it for their row.
struct SplitTooLarge: Error {}

/// complexParts within SPLIT_NODE_BUDGET: "This complex `what` is too large…" past it.
func splitWithin(_ e: Expr, _ what: String, _ verb: String) throws -> Pair {
  do {
    return try complexParts(e, budget: SPLIT_NODE_BUDGET)
  } catch is SplitTooLarge {
    throw LanguageError(splitTooLarge("This complex \(what)", verb))
  }
}

/// A real value reached through complex ones (`|1 + i|`, `re(e^(iπ/3))`) as
/// its real part, which a real evaluator can read — `e` itself when it meets
/// none. A complex value has no real reading, and `what` says so.
func realValue(_ e: Expr, _ what: String) throws -> Expr {
  if !usesComplex(e) && !hasProjection(e) { return e }
  if isComplexValued(e) { throw LanguageError("\(what) must be real — take re(…), im(…) or abs(…).") }
  do {
    return try complexParts(e, budget: SPLIT_NODE_BUDGET).re
  } catch is SplitTooLarge {
    throw LanguageError(splitTooLarge(what, "evaluate"))
  }
}

private func hasProjection(_ e: Expr) -> Bool {
  switch e {
  case .call(let name, let args):
    return ["re", "im", "conj", "arg"].contains(name) || args.contains(where: hasProjection)
  case .bin, .neg, .eq, .ineq, .piecewise, .loop:
    return childrenOf(e).contains(where: hasProjection)
  default:
    return false
  }
}

/// Complex variables bound by an enclosing loop, as their two real parts.
private typealias ComplexVars = [String: Pair]

private func typesOf(_ vars: ComplexVars) -> [String: ScalarType] { vars.mapValues { _ in .complex } }

/// The real and imaginary parts of `e` (lib/complex-parts.ts `complexParts`).
/// Splitting duplicates subterms — every complex product uses both parts of
/// both factors — so a nested product grows geometrically. With a `budget`
/// (in nodes, shared subtrees counted per use) the split stops with
/// SplitTooLarge at the first subterm past it, having built only that far.
func complexParts(_ e: Expr, budget: Int? = nil) throws -> Pair {
  try complexParts(e, budget, [:])
}

private func complexParts(_ e: Expr, _ budget: Int?, _ vars: ComplexVars) throws -> Pair {
  let parts = try splitParts(e, budget, vars)
  if let budget {
    let re = countNodes(parts.re, limit: budget)
    if re > budget || re + countNodes(parts.im, limit: budget) > budget { throw SplitTooLarge() }
  }
  return parts
}

private func splitParts(_ e: Expr, _ budget: Int?, _ vars: ComplexVars) throws -> Pair {
  func parts(_ a: Expr) throws -> Pair { try complexParts(a, budget, vars) }
  if !usesComplex(e, Set(vars.keys)) && !hasProjection(e) { return (e, num(0)) }
  switch e {
  case .var(let name):
    return vars[name] ?? (name == "i" ? (num(0), num(1)) : (.var("x"), .var("y")))
  case .neg(let a):
    return both(try parts(a), negPart)
  case .eq(let l, let r):
    return (.eq(try parts(l).re, try parts(r).re), num(0))
  case .ineq(let op, let l, let r, let grouped):
    return (.ineq(op, try parts(l).re, try parts(r).re, grouped: grouped), num(0))
  case .piecewise(let cases, let otherwise):
    // Keep the shader's typing rules (real conditions).
    let type = try inferScalarType(e, typesOf(vars))
    var conds: [Expr] = []
    var values: [Pair] = []
    for c in cases {
      conds.append(try parts(c.cond).re)
      values.append(try parts(c.value))
    }
    let other = try otherwise.map(parts)
    func part(_ pick: (Pair) -> Expr) -> Expr {
      .piecewise(
        zip(conds, values).map { Expr.Case(cond: $0, value: pick($1)) }, otherwise: other.map(pick))
    }
    return (part { $0.re }, type == .complex ? part { $0.im } : num(0))
  case .loop(let params, let seeds, let body, let limit):
    return try splitLoop(params, seeds, body, limit, budget, vars)
  case .bin(let op, let lhs, let rhs, _):
    let a = try parts(lhs)
    let b = try parts(rhs)
    if try inferScalarType(e, typesOf(vars)) == .real { return (bin(op, a.re, b.re), num(0)) }
    switch op {
    case .add: return addParts(a, b)
    case .sub: return addParts(a, both(b, negPart))
    case .mul: return mulParts(a, b)
    case .div: return divParts(a, b)
    case .pow:
      if case .num(let value) = rhs, JS.isInteger(value), abs(value) <= 16 {
        // Binomial terms keep the evaluated tree linear in n; repeated
        // complex multiplication duplicates both previous component trees.
        let n = Int(abs(value))
        var p = [num(0), num(0)]
        var coefficient = 1.0
        for k in 0...n {
          let term = mul(
            num(k % 4 < 2 ? coefficient : -coefficient), mul(pow(a.re, num(Double(n - k))), pow(a.im, num(Double(k)))))
          p[k % 2] = add(p[k % 2], term)
          coefficient = (coefficient * Double(n - k)) / Double(k + 1)
        }
        return value < 0 ? divParts((num(1), num(0)), (p[0], p[1])) : (p[0], p[1])
      }
      return expParts(mulParts(b, lnParts(a)))
    }
  case .call(let name, let args):
    // Keep function support and arity consistent with the shader.
    let type = try inferScalarType(e, typesOf(vars))
    if type == .real && !["re", "im", "arg", "abs"].contains(name) {
      return (.call(name, try args.map { try parts($0).re }), num(0))
    }
    let a = try parts(args[0])
    let (x, y) = a
    let sin: Pair = (bin(.mul, call("sin", x), call("cosh", y)), bin(.mul, call("cos", x), call("sinh", y)))
    let cos: Pair = (bin(.mul, call("cos", x), call("cosh", y)), negPart(bin(.mul, call("sin", x), call("sinh", y))))
    let sinh: Pair = (bin(.mul, call("sinh", x), call("cos", y)), bin(.mul, call("cosh", x), call("sin", y)))
    let cosh: Pair = (bin(.mul, call("cosh", x), call("cos", y)), bin(.mul, call("sinh", x), call("sin", y)))
    switch name {
    case "re": return (x, num(0))
    case "im": return (y, num(0))
    case "abs": return (call("sqrt", norm2(a)), num(0))
    case "arg": return (call("atan2", y, x), num(0))
    case "conj": return (x, negPart(y))
    case "exp": return expParts(a)
    case "ln": return lnParts(a)
    case "log": return both(lnParts(a)) { bin(.div, $0, call("ln", num(10))) }
    case "sqrt":
      let radius = call("sqrt", norm2(a))
      let re = call("sqrt", bin(.div, bin(.add, radius, x), num(2)))
      let im = call("sqrt", bin(.div, bin(.sub, radius, x), num(2)))
      let signedIm = Expr.piecewise([Expr.Case(cond: .ineq(.lt, y, num(0)), value: negPart(im))], otherwise: im)
      let positive = Expr.ineq(.gt, x, num(0))
      let zero = Expr.ineq(.le, radius, num(0))
      // Compute the smaller component from 2 re im = y, avoiding
      // cancellation in radius ± x and singular derivatives on the axes.
      return (
        .piecewise(
          [Expr.Case(cond: zero, value: num(0)), Expr.Case(cond: positive, value: re)],
          otherwise: bin(.div, y, bin(.mul, num(2), signedIm))),
        .piecewise(
          [Expr.Case(cond: zero, value: num(0)), Expr.Case(cond: positive, value: bin(.div, y, bin(.mul, num(2), re)))],
          otherwise: signedIm)
      )
    case "sin": return sin
    case "cos": return cos
    case "tan": return divParts(sin, cos)
    case "sinh": return sinh
    case "cosh": return cosh
    case "tanh": return divParts(sinh, cosh)
    default: break
    }
  default:
    break
  }
  throw LanguageError("This complex expression cannot be evaluated as a point or root system.")
}

/// A loop over complex state becomes a loop over twice as many real params:
/// each complex param `p` is carried as `p.re` and `p.im` (names no row can
/// spell), bound to that pair while its body splits. A complex result is two
/// loops, one per part, which run the same passes.
private func splitLoop(
  _ names: [String], _ seeds: [Expr], _ body: Expr, _ limit: Int, _ budget: Int?, _ vars: ComplexVars
) throws -> Pair {
  let (types, result) = try loopTypes(names, seeds, body, typesOf(vars))
  var inner = vars
  var params: [String] = []
  for (k, p) in names.enumerated() {
    if k >= types.count || types[k] == .real {
      inner[p] = nil
      params.append(p)
      continue
    }
    inner[p] = (.var("\(p).re"), .var("\(p).im"))
    params += ["\(p).re", "\(p).im"]
  }
  func flatten(_ args: [Expr], _ scope: ComplexVars) throws -> [Expr] {
    var out: [Expr] = []
    for (k, a) in args.enumerated() {
      let parts = try complexParts(a, budget, scope)
      out += k >= types.count || types[k] == .real ? [parts.re] : [parts.re, parts.im]
    }
    return out
  }
  let flatSeeds = try flatten(seeds, vars)
  func rebuilt(_ pick: (Pair) -> Expr) throws -> Expr {
    func rebuild(_ node: Expr) throws -> Expr {
      if let args = recurArgs(node) { return .call(RECUR, try flatten(args, inner)) }
      guard case .piecewise(let cases, let otherwise) = node else { return pick(try complexParts(node, budget, inner)) }
      return .piecewise(
        try cases.map {
          Expr.Case(cond: try complexParts($0.cond, budget, inner).re, value: try rebuild($0.value))
        }, otherwise: try otherwise.map(rebuild))
    }
    return .loop(params: params, seeds: flatSeeds, body: try rebuild(body), limit: limit)
  }
  return (try rebuilt { $0.re }, result == .complex ? try rebuilt { $0.im } : num(0))
}
