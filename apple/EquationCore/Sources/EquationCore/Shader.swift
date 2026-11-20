/// Compile a symbolic Expr to a GLSL expression (float-valued): lib/glsl.ts
/// `toGLSL`. The Metal renderer compiles GLSL-flavoured source
/// (EquationRender's GLSL.swift), so this is the site's own shader text.
///
/// An equation l = r compiles to the scalar field F = l - r; the graph is the
/// zero set of F, which the renderer extracts in a fragment shader.
///
/// Only the scalar core is here so far: numbers, the variables the caller
/// declares, arithmetic, the elementary functions and piecewise. Everything
/// else throws, and its row stays with the web renderer.
public struct ShaderError: Error, Equatable, Sendable {
  public var message: String

  init(_ message: String) { self.message = message }
}

/// Emit a GLSL float expression. Free variables compile to their own names,
/// so the caller must declare them (as function parameters, say).
public func toGLSL(_ e: Expr) throws(ShaderError) -> String {
  switch e {
  case .num(let value):
    return try literal(value)
  case .var(let name):
    return name
  case .neg(let a):
    return "(-\(try toGLSL(a)))"
  case .bin(let op, let lhs, let rhs, _):
    let a = try toGLSL(lhs)
    let b = try toGLSL(rhs)
    guard op == .pow else { return "(\(a) \(op.rawValue) \(b))" }
    if case .num(let n) = rhs, n == n.rounded(), n >= 1, n <= 8 {
      // Small integer powers: expand to products (fast, exact for negative
      // bases). Only a name or a number is repeated: a compound base goes
      // through a helper, so it is evaluated, and spelled out, once.
      let count = Int(n)
      var simple = count == 1
      if case .var = lhs { simple = true }
      if case .num = lhs { simple = true }
      if simple { return "(\(Array(repeating: a, count: count).joined(separator: "*")))" }
      return count == 2 ? "eq_sq(\(a))" : "eq_ipow(\(a), \(count))"
    }
    return "eq_pow(\(a), \(b))"
  case .call(let name, let arguments):
    var args: [String] = []
    for argument in arguments { args.append(try toGLSL(argument)) }
    if let fn = unaryFunctions[name], args.count == 1 { return "\(fn)(\(args[0]))" }
    if let fn = binaryFunctions[name], args.count == 2 { return "\(fn)(\(args[0]), \(args[1]))" }
    if name == "min" || name == "max", args.count >= 2 {
      // GLSL's take two.
      return args.dropFirst().reduce(args[0]) { "\(name)(\($0), \($1))" }
    }
    throw ShaderError("\(name)(…) is not drawn by the Metal renderer yet.")
  case .eq(let l, let r):
    return "(\(try toGLSL(l)) - (\(try toGLSL(r))))"
  case .piecewise(let cases, let otherwise):
    // A nested ternary; NaN outside every case when there is no default.
    var out = try otherwise.map { (e: Expr) throws(ShaderError) in try toGLSL(e) } ?? "EQ_NAN"
    for c in cases.reversed() {
      out = "((\(try condition(c.cond))) ? \(try toGLSL(c.value)) : \(out))"
    }
    return out
  case .ineq:
    throw ShaderError("Inequality in scalar context.")
  case .vec:
    throw ShaderError("Vector in scalar context.")
  case .list:
    throw ShaderError("A list can only be plotted as its own row.")
  case .str:
    throw ShaderError("Text cannot be plotted — it can only be compared, inside a filter.")
  case .index, .range, .eqtest:
    throw ShaderError("This expression is not drawn by the Metal renderer yet.")
  }
}

/// A (possibly chained) inequality as a GLSL boolean: 0 < y < x nests left,
/// and compares each neighbouring pair (lib/expr.ts `ineqComparisons`).
private func condition(_ cond: Expr) throws(ShaderError) -> String {
  var chain: [(op: IneqOp, l: Expr, r: Expr)] = []
  var node = cond
  while case .ineq(let op, let l, let r, _) = node {
    chain.insert((op, l, r), at: 0)
    node = l
  }
  guard !chain.isEmpty else { throw ShaderError("A piecewise case needs a condition, like x > 0.") }
  var parts: [String] = []
  for (k, c) in chain.enumerated() {
    let l = k == 0 ? c.l : chain[k - 1].r
    parts.append("(\(try toGLSL(l)) \(c.op.rawValue) \(try toGLSL(c.r)))")
  }
  return parts.joined(separator: " && ")
}

private func literal(_ value: Double) throws(ShaderError) -> String {
  if value.isNaN {
    throw ShaderError("This row has an undefined constant (NaN) in it, so it cannot be drawn.")
  }
  if value.isInfinite {
    throw ShaderError("This row has an infinite constant (\(value > 0 ? "∞" : "−∞")) in it, so it cannot be drawn.")
  }
  // The shader computes in float32; its shortest spelling always has a `.` or an exponent.
  let single = Float(value)
  if single.isInfinite { return value > 0 ? "INFINITY" : "(-INFINITY)" }
  return "\(single)"
}

/// The builtins with a GLSL spelling so far, by the name the parser gives them.
private let unaryFunctions: [String: String] = [
  "sin": "sin", "cos": "cos", "tan": "tan", "asin": "asin", "acos": "acos", "atan": "atan",
  "sinh": "sinh", "cosh": "cosh", "tanh": "eq_tanh", "sech": "eq_sech", "coth": "eq_coth",
  "asinh": "asinh", "acosh": "acosh", "atanh": "atanh",
  "sqrt": "sqrt", "abs": "abs", "exp": "exp", "ln": "log", "log": "eq_log10", "log2": "log2",
  "floor": "floor", "ceil": "ceil", "round": "eq_round", "sign": "sign", "fract": "fract",
  "sinc": "eq_sinc", "erf": "eq_erf", "gamma": "eq_gamma", "factorial": "eq_factorial", "isprime": "eq_isprime",
]

private let binaryFunctions: [String: String] = ["atan2": "atan", "mod": "mod", "gcd": "eq_gcd"]

/// The GLSL identifier for the uniform carrying the constant `p` (lib/glsl.ts
/// `uniformName`). Plain names keep their readable u_<name> form; a name GLSL
/// cannot hold (non-ASCII, a leading `_`, a doubled `_`) becomes u_zz<hex
/// codepoints joined by z>, as does a plain name starting with `zz`.
public func uniformName(_ p: String) -> String {
  let plain = p.unicodeScalars.allSatisfy { c in
    (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "_"
  }
  if plain, !p.isEmpty, !p.hasPrefix("_"), !p.hasPrefix("zz"), !p.contains("__") { return "u_\(p)" }
  return "u_zz" + p.unicodeScalars.map { String($0.value, radix: 16) }.joined(separator: "z")
}

/// What a row draws, as far as the Swift port classifies rows (lib/plot.ts).
public enum RowPlot: Equatable, Sendable {
  /// A blank row or a `# comment`.
  case nothing
  /// `l = r` in x and y: the zero set of `field`, GLSL for F in floats x, y
  /// and t. `animated` when it reads t, seconds since the graph opened.
  case curve(field: String, animated: Bool)
}

/// Classify a row on its own, or nil when it is not a kind the Metal
/// renderer draws yet: anything but an equation in x and y (a definition, a
/// slider's constant, z, a list, a point, …), and anything that doesn't parse.
public func plotRow(_ text: String) -> RowPlot? {
  guard let first = text.first(where: { !$0.isWhitespace }) else { return .nothing }
  if first == "#" { return .nothing }
  guard let expr = try? parseExpr(text), case .eq = expr else { return nil }
  var names: Set<String> = []
  freeVars(expr, into: &names)
  guard names.isSubset(of: ["x", "y", "t"]), names.contains("x") || names.contains("y") else { return nil }
  guard let field = try? toGLSL(expr) else { return nil }
  return .curve(field: field, animated: names.contains("t"))
}

/// Every variable an expression names.
func freeVars(_ e: Expr, into names: inout Set<String>) {
  switch e {
  case .num, .str:
    break
  case .var(let name):
    names.insert(name)
  case .neg(let a):
    freeVars(a, into: &names)
  case .bin(_, let a, let b, _), .index(let a, let b), .range(let a, let b), .eqtest(_, let a, let b), .eq(let a, let b),
    .ineq(_, let a, let b, _):
    freeVars(a, into: &names)
    freeVars(b, into: &names)
  case .call(_, let items), .vec(let items), .list(let items):
    for item in items { freeVars(item, into: &names) }
  case .piecewise(let cases, let otherwise):
    for c in cases {
      freeVars(c.cond, into: &names)
      freeVars(c.value, into: &names)
    }
    if let otherwise { freeVars(otherwise, into: &names) }
  }
}
