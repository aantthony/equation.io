import Synchronization

/// Compile a symbolic Expr to a GLSL expression (float-valued): lib/glsl.ts.
/// The Metal renderer compiles GLSL-flavoured source (EquationRender's
/// GLSL.swift), so this is the site's own shader text, byte for byte.
///
/// An equation l = r compiles to the scalar field F = l - r; the graph is the
/// zero set of F, which the renderers extract in a fragment shader.
public struct ShaderError: Error, Equatable, Sendable {
  public var message: String

  init(_ message: String) { self.message = message }
}

/// The shader spelling of a function, where it is not the function's own
/// name (lib/glsl.ts `FN_GLSL`). The bracketed names are calls only lowering
/// writes: lib/expr.ts ANGLE_FN, ANGLE_RATE_FN and the *_PDF_FN densities.
public let fnGLSL: [String: String] = [
  "ln": "log",
  "log": "eq_log10",
  "atan2": "atan",
  "round": "eq_round",
  "sech": "eq_sech",
  "fract": "fract",
  "erf": "eq_erf",
  "normalpdf": "eq_normalpdf",
  "normalcdf": "eq_normalcdf",
  "gcd": "eq_gcd",
  "isprime": "eq_isprime",
  "gamma": "eq_gamma",
  "factorial": "eq_factorial",
  "sinc": "eq_sinc",
  "coth": "eq_coth",
  "tanh": "eq_tanh",
  "[angle]": "eq_angle",
  "[angle′]": "eq_angle_rate",
  "[gammapdf]": "eq_gammapdf",
  "[betapdf]": "eq_betapdf",
  "[tpdf]": "eq_tpdf",
  "[weibullpdf]": "eq_weibullpdf",
]

/// The probability mass functions of the discrete laws (lib/expr.ts `PMF_FNS`).
private let pmfFns: Set<String> = [
  "[binomialpmf]", "[poissonpmf]", "[negativebinomialpmf]", "[discreteuniformpmf]",
]

/// Compile a (possibly chained) inequality to a GLSL boolean via the given
/// scalar emitter (lib/glsl.ts `condGLSL`).
public func condGLSL(_ cond: Expr, _ emit: (Expr) throws(ShaderError) -> String) throws(ShaderError) -> String {
  guard case .ineq = cond else { throw ShaderError(notACondition(cond)) }
  var parts: [String] = []
  for c in ineqComparisons(cond) {
    let l = try emit(c.l)
    parts.append("(\(l) \(c.op.rawValue) \(try emit(c.r)))")
  }
  return parts.joined(separator: " && ")
}

/// Nested-ternary GLSL for a piecewise; NaN outside all cases when no default
/// (lib/glsl.ts `piecewiseGLSL`). `emitValue` compiles the case values when
/// they are typed differently from the (real) condition sides, with `nan`
/// the undefined value of that type.
public func piecewiseGLSL(
  _ cases: [Expr.Case],
  otherwise: Expr?,
  _ emit: (Expr) throws(ShaderError) -> String,
  emitValue: ((Expr) throws(ShaderError) -> String)? = nil,
  nan: String = "EQ_NAN"
) throws(ShaderError) -> String {
  func value(_ e: Expr) throws(ShaderError) -> String {
    if let emitValue { return try emitValue(e) }
    return try emit(e)
  }
  var out = nan
  if let otherwise { out = try value(otherwise) }
  for c in cases.reversed() {
    let cond = try condGLSL(c.cond, emit)
    out = "((\(cond)) ? \(try value(c.value)) : \(out))"
  }
  return out
}

// MARK: - Helpers

/// Functions a compiled expression refers to beyond the prelude — recursive
/// and Fourier loops — by name. Names hash their source and coefficient
/// data, so equal loops share a declaration and a shader's source alone
/// identifies its program. `withHelpers` splices the declarations a shader
/// refers to in after the prelude; nothing else needs to carry them.
private struct Helpers {
  var sources: [String: String] = [:]
  var tables: [String: [Float]] = [:]
  /// Oldest first, as the TypeScript's Map keeps its keys.
  var recent: [String] = []

  mutating func set(_ name: String, _ source: String) {
    if let at = recent.firstIndex(of: name) { recent.remove(at: at) }
    recent.append(name)
    sources[name] = source
  }

  mutating func link(_ shader: String, _ tableBudget: Double) -> Result<String, ShaderError> {
    var order: [String] = []
    var seen: Set<String> = []
    func visit(_ text: String) throws(ShaderError) {
      for name in helperNames(text) where !seen.contains(name) {
        seen.insert(name)
        guard let source = sources[name] else {
          throw ShaderError("Shader refers to an undeclared helper \(name).")
        }
        set(name, source)  // still in use: keep
        try visit(source)  // dependencies (an inner loop) declare first
        order.append(name)
      }
    }
    do throws(ShaderError) {
      try visit(shader)
      let slots = order.reduce(0.0) { $0 + Double(tables[$1]?.count ?? 0) / 4 }
      var declarations: [String] = []
      for name in order {
        let source = sources[name]!
        guard let values = tables[name], !(slots <= tableBudget) else {
          declarations.append(source)
          continue
        }
        // A row with many independent series can exceed a device's uniform
        // budget. Keep the same loop, with a constant table on that device.
        var rows: [String] = []
        for k in 0..<(values.count / 4) {
          var row: [String] = []
          for value in values[(4 * k)..<(4 * k + 4)] { row.append(try fmt(Double(value))) }
          rows.append("vec4(\(row.joined(separator: ", ")))")
        }
        let n = rows.count
        declarations.append(
          source.replacing(
            "uniform vec4 \(name)_terms[\(n)];",
            with: "const vec4 \(name)_terms[\(n)] = vec4[\(n)](\(rows.joined(separator: ", ")));",
            maxReplacements: 1))
      }
      let spliced = "\(glslPrelude)\n\(declarations.joined(separator: "\n"))\n"
      return .success(shader.replacing(glslPrelude, with: spliced, maxReplacements: 1))
    } catch {
      return .failure(error)
    }
  }
}

private let helpers = Mutex(Helpers())

/// Each edit of a recursive function declares a fresh helper; keep the most
/// recently declared or spliced, well beyond the 64 programs a renderer
/// caches, so a live shader's helpers are still here when it recompiles.
private let helperLimit = 512

/// What a helper's source calls itself until `declareHelper` names it.
public let helperSelf = "@self"

/// Every /\beq_loop_[0-9a-f]+\b/ in `text`, in order.
private func helperNames(_ text: String) -> [String] {
  let bytes = Array(text.utf8)
  let prefix = Array("eq_loop_".utf8)
  func isWord(_ b: UInt8) -> Bool {
    (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) || b == 0x5F
  }
  func isHex(_ b: UInt8) -> Bool { (b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66) }
  var names: [String] = []
  var i = 0
  while i + prefix.count < bytes.count {
    guard bytes[i] == prefix[0], !(i > 0 && isWord(bytes[i - 1])), bytes[i...].starts(with: prefix) else {
      i += 1
      continue
    }
    var end = i + prefix.count
    while end < bytes.count, isHex(bytes[end]) { end += 1 }
    // The digits are word characters, so the name ends only where the word does.
    if end > i + prefix.count, !(end < bytes.count && isWord(bytes[end])) {
      names.append(String(decoding: bytes[i..<end], as: UTF8.self))
      i = end
    } else {
      i += 1
    }
  }
  return names
}

/// Declare a helper function and return its name: eq_loop_<FNV-1a of the
/// source, with its own name left as `helperSelf`, and of the table's bytes>
/// (lib/glsl.ts `declareHelper`).
public func declareHelper(_ source: String, table: [Float]? = nil) -> String {
  var hash: UInt32 = 0x811c_9dc5
  for unit in source.utf16 { hash = (hash ^ UInt32(unit)) &* 0x0100_0193 }
  if let table {
    for value in table {
      let bits = value.bitPattern
      for shift in [0, 8, 16, 24] as [UInt32] { hash = (hash ^ ((bits >> shift) & 0xFF)) &* 0x0100_0193 }
    }
  }
  let name = "eq_loop_" + String(hash, radix: 16)
  helpers.withLock { helpers in
    helpers.set(name, source.replacing(helperSelf, with: name))  // re-insert at the recent end
    if let table { helpers.tables[name] = table }
    while helpers.recent.count > helperLimit {
      let oldest = helpers.recent.removeFirst()
      helpers.sources[oldest] = nil
      helpers.tables[oldest] = nil
    }
  }
  return name
}

/// The shader with the helpers it refers to declared after the prelude
/// (lib/glsl.ts `withHelpers`). A coefficient table is a uniform array while
/// the shader's tables fit `tableBudget` vec4 slots, and a constant array
/// otherwise.
public func withHelpers(_ shader: String, tableBudget: Double = .infinity) throws(ShaderError) -> String {
  if !shader.contains("eq_loop_") { return shader }
  return try helpers.withLock { $0.link(shader, tableBudget) }.get()
}

/// Immutable coefficient tables used by helpers in the fully linked source
/// (lib/glsl.ts `shaderTables`). The program uploads these once; slider
/// uniforms are updated per draw.
public func shaderTables(_ shader: String) -> [(name: String, values: [Float])] {
  var seen: Set<String> = []
  let names = helperNames(shader).filter { seen.insert($0).inserted }
  return helpers.withLock { helpers in
    names.compactMap { name in helpers.tables[name].map { ("\(name)_terms", $0) } }
  }
}

/// A number as GLSL writes a float (lib/glsl.ts `fmt`): JavaScript's
/// String(value), with an `E` for its exponent, or `.0` after a whole number.
func fmt(_ value: Double) throws(ShaderError) -> String {
  if value.isNaN {
    throw ShaderError("This row has an undefined constant (NaN) in it, so it cannot be drawn.")
  }
  if value.isInfinite {
    throw ShaderError(
      "This row has an infinite constant (\(value > 0 ? "∞" : "−∞")) in it, so it cannot be drawn"
        + " — a count or total over an unbounded set is ∞.")
  }
  let s = jsNumberString(value)
  if let e = s.firstIndex(of: "e") { return "\(s[..<e])E\(s[s.index(after: e)...])" }
  return s.contains(".") ? s : "\(s).0"
}

private struct FourierLoop {
  var name: String
  var position: Expr
  var count: Expr

  func call(_ reach: String) throws(ShaderError) -> String {
    let at = try toGLSL(position)
    return "\(name)(\(at), \(try toGLSL(count)), \(reach))"
  }
}

/// Recognize the ordinary gated sine/cosine sum emitted by reconstruction
/// (lib/glsl.ts `fourierLoop`). Keep that AST for CPU evaluation,
/// substitution and differentiation; only its shader spelling becomes a
/// coefficient table and a runtime loop.
private func fourierLoop(_ e: Expr) throws(ShaderError) -> FourierLoop? {
  guard case .bin(.add, _, .piecewise, _) = e else { return nil }
  var terms: [Expr] = []
  var base = e
  while case .bin(.add, let a, let b, _) = base {
    terms.append(b)
    base = a
  }
  if case .piecewise = base {
    terms.append(base)
    base = .num(0)
  }
  guard case .num(let offset) = base, terms.count >= 4, terms.count <= 128 else { return nil }
  terms.reverse()
  var count: Expr?
  var position: Expr?
  var last = 0.0
  var table: [Float] = []
  for term in terms {
    guard case .piecewise(let cases, .num(0)?) = term, cases.count == 1,
      case .ineq(.ge, let gate, .num(let harmonic), _) = cases[0].cond,
      harmonic.isFinite, harmonic == harmonic.rounded(), harmonic > last, harmonic <= 128
    else { return nil }
    if let count, !sameExprKey(gate, count) { return nil }
    count = gate
    last = harmonic
    let value = cases[0].value
    var components = [value]
    if case .bin(.add, let a, let b, _) = value { components = [a, b] }
    var frequency: Double?
    var cosine = 0.0
    var sine = 0.0
    for var component in components {
      var coefficient = 1.0
      if case .bin(.mul, .num(let c), let rest, _) = component {
        coefficient = c
        component = rest
      }
      guard case .call(let fn, let args) = component, fn == "cos" || fn == "sin", args.count == 1 else { return nil }
      var angle = args[0]
      var rate = 1.0
      if case .bin(.mul, .num(let r), let rest, _) = angle {
        rate = r
        angle = rest
      }
      if let frequency, rate != frequency { return nil }
      if let position, !sameExprKey(angle, position) { return nil }
      frequency = rate
      position = angle
      if fn == "cos" { cosine += coefficient } else { sine += coefficient }
    }
    // A NaN is the one JavaScript makes, so the table's bytes — and the name — agree.
    table += [last, frequency!, cosine, sine].map { $0.isNaN ? Float.nan : Float($0) }
  }
  // (value, slope, lower, upper): the series and its derivative at the
  // position, and the band it stays in within `reach` of it. Each harmonic
  // moves at most its amplitude times its rate times the reach, and never
  // past its amplitude, so a harmonic too fast to resolve at that scale
  // spans its whole range while a slow one stays near its value.
  let start = try fmt(offset)
  let n = table.count / 4
  let name = declareHelper(
    """
    uniform vec4 \(helperSelf)_terms[\(n)];
    vec4 \(helperSelf)(float position, float count, float reach) {
      vec4 result = vec4(\(start), 0.0, \(start), \(start));
      for (int j = 0; j < \(n) && count >= \(helperSelf)_terms[j].x; ++j) {
        vec4 term = \(helperSelf)_terms[j];
        float angle = term.y * position;
        vec2 phase = vec2(cos(angle), sin(angle));
        float value = dot(term.zw, phase);
        float amplitude = length(term.zw);
        float travel = amplitude * abs(term.y) * reach;
        result += vec4(
          value,
          term.y * dot(term.zw, vec2(-phase.y, phase.x)),
          max(value - travel, -amplitude),
          min(value + travel, amplitude));
      }
      return result;
    }
    """,
    table: table)
  return FourierLoop(name: name, position: position!, count: count!)
}

/// Only a complete series at an affine position with a spatially constant
/// count is smooth everywhere (lib/glsl.ts `fourierGraphGLSL`). More general
/// compositions retain the renderer's two-scale finite differences and pole
/// checks.
///
/// `glsl` is a vec4 in x and `reach` (in x units): the value, the slope in
/// the position, and the band the curve stays in within reach of x.
///
/// `diff` is lib/diff.ts `diff`, d(e)/d(v), which this file does not have:
/// the caller passes it.
public func fourierGraphGLSL(
  _ e: Expr, diff: (Expr, String) throws -> Expr
) throws(ShaderError) -> (glsl: String, slopeScale: Double)? {
  guard let loop = try fourierLoop(e) else { return nil }
  var names: Set<String> = []
  freeVars(loop.count, into: &names)
  if names.contains("x") { return nil }
  do {
    if case .num(let slope) = try diff(loop.position, "x"), slope.isFinite {
      return (try loop.call("\(try fmt(abs(slope))) * reach"), slope)
    }
  } catch {
    // A discontinuous or nonlinear position uses the general curve shader.
  }
  return nil
}

/// The GLSL identifier for the uniform carrying the constant `p` (lib/glsl.ts
/// `uniformName`). Plain names keep their readable u_<name> form; a name GLSL
/// cannot hold — θ or T₀ (non-ASCII), `_a` or `a__b` (a leading `_` here or a
/// doubled `_` anywhere makes a reserved GLSL identifier) — becomes u_zz<hex
/// codepoints joined by z>. `z` is not a hex digit, so that spelling is
/// unambiguous, and a plain name starting with `zz` is encoded too, so
/// distinct names never share a uniform. Every site that names a uniform
/// must go through this one function.
public func uniformName(_ p: String) -> String {
  let plain = p.unicodeScalars.allSatisfy { c in
    (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "_"
  }
  if plain, !p.isEmpty, !p.hasPrefix("_"), !p.hasPrefix("zz"), !p.contains("__") { return "u_\(p)" }
  return "u_zz" + p.unicodeScalars.map { String($0.value, radix: 16) }.joined(separator: "z")
}

/// Emit a GLSL float expression (lib/glsl.ts `toGLSL`). Free variables
/// compile to their own names, so the caller must declare them (as function
/// parameters, say).
public func toGLSL(_ e: Expr) throws(ShaderError) -> String {
  switch e {
  case .index, .range, .eqtest:
    throw ShaderError(structuralDiagnostic(e))
  case .num(let value):
    return try fmt(value)
  case .var(let name):
    return name
  case .neg(let a):
    return "(-\(try toGLSL(a)))"
  case .bin(let op, let lhs, let rhs, _):
    if let loop = try fourierLoop(e) { return "(\(try loop.call("0.0"))).x" }
    let a = try toGLSL(lhs)
    let b = try toGLSL(rhs)
    guard op == .pow else { return "(\(a) \(op.rawValue) \(b))" }
    if case .num(let n) = rhs, n == n.rounded(), n >= 1, n <= 8 {
      // Small integer powers: expand to products (fast, exact for negative
      // bases). Only a name or a number is repeated, though: a compound
      // base goes through a helper, so (Σ 40 terms)^2 evaluates — and
      // spells out — its base once, not once per factor.
      let count = Int(n)
      var simple = count == 1
      if case .var = lhs { simple = true }
      if case .num = lhs { simple = true }
      if simple { return "(\(Array(repeating: a, count: count).joined(separator: "*")))" }
      return count == 2 ? "eq_sq(\(a))" : "eq_ipow(\(a), \(count))"
    }
    return "eq_pow(\(a), \(b))"
  case .call(let name, let arguments):
    // No float32 twin, on purpose: a pmf is nonzero only AT the integers, a
    // set of measure zero no fragment ever lands on. Rows draw it as stems.
    if pmfFns.contains(name) {
      throw ShaderError("A probability mass function is drawn as stems, not as a curve.")
    }
    // A Σ/Π is either expanded away or evaluated on the CPU (a sequence
    // term). It has no shader form.
    if name == "sum" || name == "prod" {
      throw ShaderError("\(name == "sum" ? "Σ" : "Π") must be expanded before it can be drawn as a curve.")
    }
    var args: [String] = []
    for argument in arguments { args.append(try toGLSL(argument)) }
    return "\(fnGLSL[name] ?? name)(\(args.joined(separator: ", ")))"
  case .eq(let l, let r):
    let left = try toGLSL(l)
    return "(\(left) - (\(try toGLSL(r))))"
  case .ineq:
    throw ShaderError("Inequality in scalar context.")
  case .vec:
    throw ShaderError("Vector in scalar context.")
  case .list:
    throw ShaderError("A list can only be plotted as its own row.")
  case .str:
    throw ShaderError("Text cannot be plotted — it can only be compared, inside a filter.")
  case .piecewise(let cases, let otherwise):
    return try piecewiseGLSL(cases, otherwise: otherwise, toGLSL)
  }
}

// MARK: - The interim row classifier

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
  guard let parsed = try? parseExpr(text), case .eq = parsed, let expr = scalarCalls(parsed) else { return nil }
  var names: Set<String> = []
  freeVars(expr, into: &names)
  guard names.isSubset(of: ["x", "y", "t"]), names.contains("x") || names.contains("y") else { return nil }
  guard let field = try? toGLSL(expr) else { return nil }
  return .curve(field: field, animated: names.contains("t"))
}

/// The builtins a shader can call as they are parsed, with how many
/// arguments each takes. The resolver and lowering decide this on the site;
/// until they are ported, `plotRow` draws only rows that need neither.
private let scalarFunctions: [String: Int] = [
  "sin": 1, "cos": 1, "tan": 1, "asin": 1, "acos": 1, "atan": 1, "sinh": 1, "cosh": 1, "tanh": 1, "sech": 1,
  "coth": 1, "asinh": 1, "acosh": 1, "atanh": 1, "sqrt": 1, "abs": 1, "exp": 1, "ln": 1, "log": 1, "floor": 1,
  "ceil": 1, "round": 1, "sign": 1, "fract": 1, "sinc": 1, "erf": 1, "gamma": 1, "factorial": 1, "isprime": 1,
  "atan2": 2, "mod": 2, "gcd": 2, "min": 2, "max": 2,
]

/// `e` with min and max of several arguments nested in pairs, as GLSL's
/// take two; nil when it calls anything a shader cannot.
private func scalarCalls(_ e: Expr) -> Expr? {
  func all(_ items: [Expr]) -> [Expr]? {
    let mapped = items.compactMap(scalarCalls)
    return mapped.count == items.count ? mapped : nil
  }
  switch e {
  case .num, .var, .str:
    return e
  case .neg(let a):
    return scalarCalls(a).map { .neg($0) }
  case .bin(let op, let a, let b, let glyph):
    guard let a = scalarCalls(a), let b = scalarCalls(b) else { return nil }
    return .bin(op, a, b, glyph: glyph)
  case .eq(let l, let r):
    guard let l = scalarCalls(l), let r = scalarCalls(r) else { return nil }
    return .eq(l, r)
  case .ineq(let op, let l, let r, let grouped):
    guard let l = scalarCalls(l), let r = scalarCalls(r) else { return nil }
    return .ineq(op, l, r, grouped: grouped)
  case .call(let name, let arguments):
    guard let arity = scalarFunctions[name], let args = all(arguments) else { return nil }
    if name == "min" || name == "max", args.count >= 2 {
      return args.dropFirst().reduce(args[0]) { .call(name, [$0, $1]) }
    }
    return args.count == arity ? .call(name, args) : nil
  case .piecewise(let cases, let otherwise):
    var mapped: [Expr.Case] = []
    for c in cases {
      guard let cond = scalarCalls(c.cond), let value = scalarCalls(c.value) else { return nil }
      mapped.append(Expr.Case(cond: cond, value: value, bare: c.bare))
    }
    guard let otherwise else { return .piecewise(mapped, otherwise: nil) }
    return scalarCalls(otherwise).map { .piecewise(mapped, otherwise: $0) }
  case .index, .range, .eqtest, .vec, .list:
    return nil
  }
}
