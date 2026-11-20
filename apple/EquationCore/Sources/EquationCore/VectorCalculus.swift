/// The vector-calculus operators — `grad(f)`, `div(F)`, `curl(F)`,
/// `laplacian(f)`, and the matrices `jacobian(F)` and `hessian(f)` — and `∇`
/// as a prefix operator (lib/defs.ts `splitNablaChain`, `vectorOperand`,
/// `vectorCalculus`). Each expands symbolically at resolve time, as d/dx
/// does, so nothing downstream sees an operator.

/// The vector-calculus operators, each also written with ∇ (`VECTOR_OPS`).
let vectorOps: Set<String> = ["grad", "div", "curl", "laplacian", "jacobian", "hessian"]

private let vectorOpExample: [String: String] = [
  "grad": "grad(x^2 + y^2)",
  "div": "div((x y, y^2))",
  "curl": "curl((-y, x))",
  "laplacian": "laplacian(x^2 - y^2)",
  "jacobian": "jacobian((x^2 - y^2, 2 x y))",
  "hessian": "hessian(x^2 - y^2)",
]

private let spaceAxes = ["x", "y", "z"]

extension Resolver {
  /// `∇` as a prefix operator (`splitNablaChain`). It tokenizes as a bare
  /// `grad` factor, and like d/dx binds the rest of its product chain: `∇f`,
  /// `∇ x^2 y`, `∇f(x, y)`. A written `·` or `×` right after it makes `∇·F`
  /// (div) and `∇×F` (curl); `∇^2 f` is laplacian(f). The operand stops at
  /// the next written `·` or `×`, so `∇f · v` is (∇f)·v. Returns the
  /// rewritten chain, or nil when it has no ∇.
  func splitNablaChain(_ e: Expr) throws -> Expr? {
    struct Factor {
      var e: Expr
      var op: BinOp
      var glyph: ProductGlyph?
    }
    var factors: [Factor] = []
    var node = e
    while case .bin(let op, let a, let b, let glyph) = node, op == .mul || op == .div {
      factors.insert(Factor(e: b, op: op, glyph: glyph), at: 0)
      node = a
    }
    factors.insert(Factor(e: node, op: .mul, glyph: nil), at: 0)
    // A graph that defines its own `grad` keeps it (it is shadowable).
    let shadowed = try getFn("grad") != nil || opts.definition("grad") != nil
    func bare(_ n: Expr) -> Bool {
      if case .var("grad") = n { return !shadowed }
      return false
    }
    func header(_ f: Expr) -> (laplacian: Bool, negate: Bool)? {
      if case .neg(let a) = f {
        guard let h = header(a) else { return nil }
        return (h.laplacian, !h.negate)
      }
      if bare(f) { return (false, false) }
      if case .bin(.pow, let a, .num(2), _) = f, bare(a) { return (true, false) }
      return nil
    }
    // A Σ/∫ further left binds the ∇ into its own body, which resolves on its own.
    guard let at = factors.firstIndex(where: { header($0.e) != nil }),
      !factors[..<at].contains(where: { isSumHeader($0.e) || isIntHeader($0.e) })
    else { return nil }
    let h = header(factors[at].e)!
    // (A bare ∇: classify says to write it with parentheses.)
    guard at + 1 < factors.count else { return nil }
    let first = factors[at + 1]
    if first.op == .div { throw LanguageError("∇ needs something to act on: ∇f, ∇·F, ∇×F or ∇²f.") }
    if h.laplacian && first.glyph != nil { throw LanguageError("∇² takes a scalar field: write ∇²f.") }
    if first.glyph == .outer || first.glyph == .wedge || first.glyph == .geometric {
      throw LanguageError("∇ makes ∇f, ∇·F, ∇×F or ∇²f — not ⊗, ∧ or ⟑.")
    }
    var end = at + 2
    while end < factors.count && factors[end].glyph == nil { end += 1 }
    var operand = first.e
    for f in factors[(at + 2)..<end] { operand = .bin(f.op, operand, f.e) }
    let name = h.laplacian ? "laplacian" : first.glyph == .dot ? "div" : first.glyph == .cross ? "curl" : "grad"
    var out = Expr.call(name, [operand])
    if h.negate { out = .neg(out) }
    if at > 0 {
      var coeff = factors[0].e
      for f in factors[1..<at] { coeff = .bin(f.op, coeff, f.e, glyph: f.glyph) }
      out = .bin(factors[at].op, coeff, out, glyph: factors[at].glyph)
    }
    for f in factors[end...] { out = .bin(f.op, out, f.e, glyph: f.glyph) }
    return out
  }

  /// What a vector operator differentiates (`vectorOperand`). A bare function
  /// name stands for the function at its own parameters (`grad(f)` with
  /// f(x, y) = …), a named vector for its components, and named fields are
  /// written out — otherwise each would differentiate as a constant and
  /// quietly give 0.
  private func vectorOperand(_ name: String, _ arg: Expr) throws -> Expr {
    if case .var(let written) = arg {
      if let fn = try getFn(written) {
        let bad = fn.params.contains { !spaceAxes.contains($0) && $0 != "t" }
        if bad || fn.recursive {
          throw LanguageError(
            "\(name)(\(written)) needs \(written) to be a function of x, y, z or t; "
              + "write \(name)(\(written)(x, y)) to choose.")
        }
        return fn.body
      }
      // Differentiated as it stands, an unknown name is a constant: say so
      // rather than draw grad(f) as the point (0, 0).
      if !spaceAxes.contains(written), written != "t", opts.definition(written) == nil, opts.comps(written) == nil,
        !opts.isList(written)
      {
        throw LanguageError(
          "\(name)(\(written)): \(written) is not defined. Define a function \(written)(x, y) = … or a field "
            + "\(written) = … first.")
      }
    }
    return throughFields(try lowerGeom(arg, comps: opts.comps, isList: opts.isList))
  }

  /// grad, div, curl and laplacian — and the matrices jacobian and hessian —
  /// expanded symbolically as d/dx is (`vectorCalculus`).
  func vectorCalculus(_ name: String, _ args: [Expr]) throws -> Expr {
    let example = vectorOpExample[name]!
    if args.count != 1 { throw LanguageError("\(name) takes one expression: \(example).") }
    let f = try vectorOperand(name, args[0])
    var components: [Expr]?
    switch f {
    case .list, .eq, .ineq:
      let what = name == "div" || name == "curl" ? "a vector field" : "a scalar expression"
      throw LanguageError("\(name) needs \(what), like \(example).")
    case .vec(let items):
      components = items
    default:
      break
    }
    func d(_ g: Expr, _ v: String, _ order: Int = 1) throws -> Expr { try applyDiff(g, v, order) }
    func matrix(_ rows: [[Expr]]) -> Expr { .vec(rows.map { .vec($0) }) }
    func total(_ terms: [Expr]) -> Expr { terms.dropFirst().reduce(terms[0]) { add($0, $1) } }
    if name == "hessian" {
      if components != nil {
        throw LanguageError("hessian takes a scalar field, like hessian(x^2 - y^2); for a map, jacobian.")
      }
      // The matrix of second derivatives: in the plane unless f uses z.
      let axes = Array(spaceAxes[..<(freeVars(f).contains("z") ? 3 : 2)])
      let firsts = try axes.map { try d(f, $0) }
      return matrix(try firsts.map { fi in try axes.map { try d(fi, $0) } })
    }
    if name == "jacobian" {
      guard let components, components.count == 2 || components.count == 3 else {
        throw LanguageError(
          "jacobian takes a map of 2 or 3 components, like \(example); for a scalar f, hessian(f).")
      }
      // Row i is the gradient of component i, over as many axes as components.
      let axes = Array(spaceAxes[..<components.count])
      return matrix(try components.map { c in try axes.map { try d(c, $0) } })
    }
    if name == "grad" || name == "laplacian" {
      if components != nil {
        throw LanguageError(
          name == "grad"
            ? "grad takes a scalar field; for a vector field F, div(F) is its divergence and curl(F) its curl."
            : "laplacian takes a scalar field, like laplacian(x^2 - y^2); the Laplacian of a vector field is "
              + "not supported.")
      }
      // z joins only when f uses it, so a plane field stays in the plane.
      let axes = Array(spaceAxes[..<(freeVars(f).contains("z") ? 3 : 2)])
      if name == "grad" { return .vec(try axes.map { try d(f, $0) }) }
      return total(try axes.map { try d(f, $0, 2) })
    }
    guard let components, components.count == 2 || components.count == 3 else {
      throw LanguageError(
        "\(name) takes a vector field of 2 or 3 components, like \(example); for a scalar f, grad(f) is its "
          + "gradient.")
    }
    if name == "div" { return total(try components.enumerated().map { try d($0.element, spaceAxes[$0.offset]) }) }
    let (p, q) = (components[0], components[1])
    // In the plane, the scalar ∂Q/∂x − ∂P/∂y (the z-component of the 3D curl).
    guard components.count == 3 else { return sub(try d(q, "x"), try d(p, "y")) }
    let r = components[2]
    return .vec([
      sub(try d(r, "y"), try d(q, "z")), sub(try d(p, "z"), try d(r, "x")), sub(try d(q, "x"), try d(p, "y")),
    ])
  }
}
