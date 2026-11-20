/// Compile a symbolic Expr to a Metal Shading Language expression
/// (float-valued), as lib/glsl.ts `toGLSL` does for WebGL.
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

/// Emit an MSL float expression. Free variables compile to their own names,
/// so the caller must declare them (as function parameters, say).
public func toMetal(_ e: Expr) throws(ShaderError) -> String {
  switch e {
  case .num(let value):
    return try literal(value)
  case .var(let name):
    return name
  case .neg(let a):
    return "(-\(try toMetal(a)))"
  case .bin(let op, let lhs, let rhs, _):
    let a = try toMetal(lhs)
    let b = try toMetal(rhs)
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
    for argument in arguments { args.append(try toMetal(argument)) }
    if let fn = unaryFunctions[name], args.count == 1 { return "\(fn)(\(args[0]))" }
    if let fn = binaryFunctions[name], args.count == 2 { return "\(fn)(\(args[0]), \(args[1]))" }
    if name == "min" || name == "max", args.count >= 2 {
      // MSL's take two.
      return args.dropFirst().reduce(args[0]) { "\(name)(\($0), \($1))" }
    }
    throw ShaderError("\(name)(…) is not drawn by the Metal renderer yet.")
  case .eq(let l, let r):
    return "(\(try toMetal(l)) - (\(try toMetal(r))))"
  case .piecewise(let cases, let otherwise):
    // A nested ternary; NaN outside every case when there is no default.
    var out = try otherwise.map { (e: Expr) throws(ShaderError) in try toMetal(e) } ?? "EQ_NAN"
    for c in cases.reversed() {
      out = "((\(try condition(c.cond))) ? \(try toMetal(c.value)) : \(out))"
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

/// A (possibly chained) inequality as an MSL boolean: 0 < y < x nests left,
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
    parts.append("(\(try toMetal(l)) \(c.op.rawValue) \(try toMetal(c.r)))")
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

/// The builtins with an MSL spelling so far, by the name the parser gives them.
private let unaryFunctions: [String: String] = [
  "sin": "sin", "cos": "cos", "tan": "tan", "asin": "asin", "acos": "acos", "atan": "atan",
  "sinh": "sinh", "cosh": "cosh", "tanh": "eq_tanh", "sech": "eq_sech", "coth": "eq_coth",
  "asinh": "asinh", "acosh": "acosh", "atanh": "atanh",
  "sqrt": "sqrt", "abs": "abs", "exp": "exp", "ln": "log", "log": "eq_log10", "log2": "log2",
  "floor": "floor", "ceil": "ceil", "round": "eq_round", "sign": "sign", "fract": "fract",
  "sinc": "eq_sinc", "erf": "eq_erf",
]

private let binaryFunctions: [String: String] = ["atan2": "atan2", "mod": "eq_mod", "gcd": "eq_gcd"]

/// Helper functions compiled expressions call; prepend once to the shader
/// (lib/glsl.ts `GLSL_PRELUDE`, the part the functions above need). Compile
/// with fast math off: the renderers rely on NaN and Inf surviving.
public let metalPrelude = """
  #define EQ_NAN as_type<float>(0x7fc00000u)
  static float eq_log10(float x) { return log(x) * 0.4342944819032518; }
  static float eq_round(float x) { return floor(x + 0.5); }
  static float eq_sech(float x) { return 1.0 / cosh(x); }
  // GLSL's mod: the sign of the divisor, where fmod takes the dividend's.
  static float eq_mod(float a, float b) { return a - b * floor(a / b); }
  static float eq_erf(float x) {
    // Abramowitz & Stegun 7.1.26; max absolute error ~1.5e-7.
    float a = abs(x);
    float t = 1.0 / (1.0 + 0.3275911 * a);
    float y = 1.0 - ((((1.061405429*t - 1.453152027)*t + 1.421413741)*t - 0.284496736)*t + 0.254829592)
      * t * exp(-a * a);
    return sign(x) * y;
  }
  static float eq_gcd(float a, float b) {
    a = abs(floor(a + 0.5)); b = abs(floor(b + 0.5));
    for (int k = 0; k < 64; k++) {
      if (b < 0.5) break;
      float t = eq_mod(a, b); a = b; b = t;
    }
    return a;
  }
  static float eq_sinc(float x) { return x == 0.0 ? 1.0 : sin(x) / x; }
  // tanh may be Inf/Inf = NaN for |x| > ~89, where it is ±1: in float, it is
  // ±1 from |x| = 9.1 on.
  static float eq_tanh(float x) { return tanh(clamp(x, -20.0, 20.0)); }
  // 1/tanh, not cosh/sinh, which overflow the same way.
  static float eq_coth(float x) { return 1.0 / eq_tanh(x); }
  static float eq_sq(float a) { return a * a; }
  static float eq_ipow(float a, int n) {
    float r = a;
    for (int k = 1; k < n; k++) r *= a;
    return r;
  }
  static float eq_pow(float a, float b) {
    // Negative bases take the "real odd root" convention, (-8)^(1/3) = -2:
    // find the exponent's rational form p/q in lowest terms among small
    // denominators (q = 1..12); if q is odd the root is real, negative iff p
    // is odd. No match within 1e-6, or an even q, is NaN. Kept in sync with
    // eq_pow in lib/glsl.ts and realPow() in lib/expr.ts.
    if (a >= 0.0) return pow(a, b);
    for (int q = 1; q <= 12; q++) {
      float fq = float(q);
      float p = floor(b * fq + 0.5);
      float g = eq_gcd(abs(p), fq);
      if (g < 1.0) g = 1.0;
      float pr = p / g;
      float qr = fq / g;
      if (abs(b - pr / qr) < 1e-6) {
        if (eq_mod(qr, 2.0) < 0.5) return EQ_NAN;
        float sign = eq_mod(abs(pr), 2.0) > 0.5 ? -1.0 : 1.0;
        return sign * pow(-a, b);
      }
    }
    return EQ_NAN;
  }
  """

/// What a row draws, as far as the Swift port classifies rows (lib/plot.ts).
public enum RowPlot: Equatable, Sendable {
  /// A blank row or a `# comment`.
  case nothing
  /// `l = r` in x and y: the zero set of `field`, MSL for F in floats x, y
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
  guard let field = try? toMetal(expr) else { return nil }
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
