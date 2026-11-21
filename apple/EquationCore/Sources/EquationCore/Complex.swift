/// Complex-typed GLSL compilation (lib/complex.ts).
///
/// `i` is the imaginary unit and `w` is shorthand for x + iy, so a complex
/// potential like ln(w-1) - ln(w+1) compiles to a GLSL vec2 (re, im). Purely
/// real subtrees delegate to the scalar compiler in Shader.swift, so real
/// plots are unaffected; re()/im()/arg()/abs() take a complex value back to a
/// real one, which lets equations like im(ln(w)) = 1 flow through the
/// implicit-curve path.

public enum ScalarType: String, Equatable, Sendable {
  case real, complex
}

/// A compiled expression and the type it came to (lib/complex.ts `Typed`).
public struct Typed: Equatable, Sendable {
  public var type: ScalarType
  public var code: String

  public init(type: ScalarType, code: String) {
    self.type = type
    self.code = code
  }
}

/// Special forms handled by classify() as whole-expression plot modes; they
/// never compile inline (iter needs a shader loop, the others pick a renderer).
let SPECIAL_FORMS: Set<String> = ["domain", "conformal", "iter", "rgb", "hsl", "oklch"]

/// Does this expression involve complex values anywhere? `extra`: additional
/// variable names known to be complex-valued (e.g. an iteration variable
/// bound by an enclosing special form) (lib/complex.ts `usesComplex`).
public func usesComplex(_ e: Expr, _ extra: Set<String> = []) -> Bool {
  switch e {
  case .num, .data, .str, .text: false
  case .var(let name): name == "i" || name == "w" || extra.contains(name)
  // A loop's param is complex only through its seed, and a seed that is
  // complex already answers; the body then only matters for i and w of its own.
  default: childrenOf(e).contains { usesComplex($0, extra) }
  }
}

private let C_FNS: [String: String] = [
  "sin": "c_sin", "cos": "c_cos", "tan": "c_tan", "exp": "c_exp", "ln": "c_ln", "log": "c_log10",
  "sqrt": "c_sqrt", "sinh": "c_sinh", "cosh": "c_cosh", "tanh": "c_tanh",
]

/// Complex-argument functions returning a real value.
private let C_TO_REAL: [String: @Sendable (String) -> String] = [
  "abs": { "length(\($0))" },
  "re": { "(\($0)).x" },
  "im": { "(\($0)).y" },
  "arg": { "atan((\($0)).y, (\($0)).x)" },
]
private let projections: Set<String> = ["re", "im", "arg"]

/// Shared builtin return/arity rules for inference and shader compilation.
private func inferCallType(_ name: String, _ args: [ScalarType]) throws(LanguageError) -> ScalarType {
  if SPECIAL_FORMS.contains(name) { throw LanguageError("\(name)(…) must be the whole expression.") }
  let complex = args.contains(.complex)
  if name == "conj" {
    if args.count != 1 { throw LanguageError("conj takes one argument.") }
    return .complex
  }
  if C_TO_REAL[name] != nil, complex || projections.contains(name) {
    if args.count != 1 { throw LanguageError("\(name) takes one argument.") }
    return .real
  }
  if !complex { return .real }
  if C_FNS[name] == nil { throw LanguageError("\(plainFnName(name)) is not supported for complex values.") }
  if args.count != 1 { throw LanguageError("\(name) takes one argument.") }
  return .complex
}

private func promote(_ v: Typed) -> String {
  v.type == .complex ? v.code : "vec2(\(v.code), 0.0)"
}

private func cast(_ v: Typed, _ type: ScalarType) -> String { type == .complex ? promote(v) : v.code }
private func glType(_ type: ScalarType) -> String { type == .complex ? "vec2" : "float" }
private func nanOf(_ type: ScalarType) -> String { type == .complex ? "vec2(EQ_NAN)" : "EQ_NAN" }
private func typesOf(_ env: [String: Typed]) -> [String: ScalarType] { env.mapValues(\.type) }

/// re/im/arg/conj of a real value still need complex handling, and a loop is
/// emitted by `compileTyped`, whatever its types.
private func touchesComplexFns(_ n: Expr) -> Bool {
  switch n {
  case .call(let name, let args):
    return C_TO_REAL[name] != nil || name == "conj" || SPECIAL_FORMS.contains(name)
      || args.contains(where: touchesComplexFns)
  case .bin, .neg, .eq, .ineq, .vec, .list, .piecewise:
    return childrenOf(n).contains(where: touchesComplexFns)
  case .loop:
    return true
  default:
    return false
  }
}

/// Typing's refusals, as the shader compiler reports them.
private func typed<T>(_ run: () throws(LanguageError) -> T) throws(ShaderError) -> T {
  do { return try run() } catch { throw ShaderError(error.message) }
}

/// Compile an expression, inferring real vs complex type (lib/complex.ts
/// `compileTyped`). `env` binds variable names to pre-typed values (e.g.
/// iter's iterate z ↦ a complex GLSL local), overriding the default
/// treatment of that name.
public func compileTyped(
  _ e: Expr, _ env: [String: Typed] = [:], complexNames: Set<String>? = nil
) throws(ShaderError) -> Typed {
  // A caller compiling many nodes against one growing env passes the complex
  // names it already knows so each call does not rescan the whole env.
  let envComplex = complexNames ?? Set(env.filter { $0.value.type == .complex }.keys)
  if !usesComplex(e, envComplex), !touchesComplexFns(e) { return Typed(type: .real, code: try toGLSL(e)) }

  switch e {
  case .index, .range, .eqtest, .comp, .figure, .lazy, .trail, .label, .hist, .family:
    throw ShaderError(structuralDiagnostic(e))
  case .num:
    return Typed(type: .real, code: try toGLSL(e))
  case .var(let name):
    if let bound = env[name] { return bound }
    if name == "i" { return Typed(type: .complex, code: "vec2(0.0, 1.0)") }
    if name == "w" { return Typed(type: .complex, code: "vec2(x, y)") }
    return Typed(type: .real, code: name)
  case .neg(let inner):
    let a = try compileTyped(inner, env, complexNames: envComplex)
    return Typed(type: a.type, code: "(-\(a.code))")
  case .bin(let op, let lhs, let rhs, _):
    let a = try compileTyped(lhs, env, complexNames: envComplex)
    let b = try compileTyped(rhs, env, complexNames: envComplex)
    if a.type == .real && b.type == .real {
      if op == .pow { return Typed(type: .real, code: "eq_pow(\(a.code), \(b.code))") }
      return Typed(type: .real, code: "(\(a.code) \(op.rawValue) \(b.code))")
    }
    let ca = promote(a)
    let cb = promote(b)
    switch op {
    case .add: return Typed(type: .complex, code: "(\(ca) + \(cb))")
    case .sub: return Typed(type: .complex, code: "(\(ca) - \(cb))")
    case .mul: return Typed(type: .complex, code: "c_mul(\(ca), \(cb))")
    case .div: return Typed(type: .complex, code: "c_div(\(ca), \(cb))")
    case .pow:
      // Small integer powers as repeated c_mul: exact at 0 (c_pow goes
      // through ln), and much cheaper inside fractal iteration loops.
      if case .num(let n) = rhs, JS.isInteger(n), n >= 1, n <= 8 {
        var code = ca
        for _ in 1..<Int(n) { code = "c_mul(\(code), \(ca))" }
        return Typed(type: .complex, code: code)
      }
      return Typed(type: .complex, code: "c_pow(\(ca), \(cb))")
    }
  case .call(let name, let arguments):
    if SPECIAL_FORMS.contains(name) { throw ShaderError("\(name)(…) must be the whole expression.") }
    var args: [Typed] = []
    for a in arguments { args.append(try compileTyped(a, env, complexNames: envComplex)) }
    let types = args.map(\.type)
    _ = try typed { () throws(LanguageError) in try inferCallType(name, types) }
    let anyComplex = types.contains(.complex)
    if name == "conj" { return Typed(type: .complex, code: "(\(promote(args[0])) * vec2(1.0, -1.0))") }
    if let toReal = C_TO_REAL[name], anyComplex || projections.contains(name) {
      return Typed(type: .real, code: toReal(promote(args[0])))
    }
    if !anyComplex {
      return Typed(type: .real, code: "\(fnGLSL[name] ?? name)(\(args.map(\.code).joined(separator: ", ")))")
    }
    return Typed(type: .complex, code: "\(C_FNS[name]!)(\(promote(args[0])))")
  case .eq(let lhs, let rhs):
    let l = try compileTyped(lhs, env, complexNames: envComplex)
    let r = try compileTyped(rhs, env, complexNames: envComplex)
    if l.type == .complex || r.type == .complex {
      throw ShaderError("Complex equation: compare re(…) or im(…) instead.")
    }
    return Typed(type: .real, code: "(\(l.code) - (\(r.code)))")
  case .ineq:
    // classify compiles each comparison's l - r separately; a nested
    // inequality here means something like a = (x < 2) or a < (b < c).
    throw ShaderError("Unexpected inequality.")
  case .vec:
    throw ShaderError("Vector in scalar context.")
  case .list:
    throw ShaderError("A list can only be plotted as its own row.")
  case .data, .str, .text:
    // (No complex value is in one, and nothing here touches one: the scalar
    // compiler has already said what it is.)
    return Typed(type: .real, code: try toGLSL(e))
  case .piecewise(let cases, let otherwise):
    let types = typesOf(env)
    let type = try typed { () throws(LanguageError) in try inferScalarType(e, types) }
    let code = try piecewiseGLSL(
      cases, otherwise: otherwise,
      { (x: Expr) throws(ShaderError) in try compileTyped(x, env, complexNames: envComplex).code },
      emitValue: { (x: Expr) throws(ShaderError) in cast(try compileTyped(x, env, complexNames: envComplex), type) },
      nan: nanOf(type))
    return Typed(type: type, code: code)
  case .loop(let params, let seeds, let body, let limit):
    return try compileLoop(params, seeds, body, limit, env)
  }
}

/// A loop is a GLSL function: expressions cannot hold statements. It takes
/// the params, then every free variable of the body (x and y are locals of
/// the caller; passing the uniforms too keeps one rule), so it depends on
/// nothing declared around it, and it is declared once by content (see
/// declareHelper). Each pass tests the params for finiteness — a state that
/// blew up will not terminate and reads as undefined — then walks the body's
/// cases as if/else: an exit leaf returns, a self-call assigns and continues
/// (lib/complex.ts `compileLoop`).
private func compileLoop(
  _ params: [String], _ seeds: [Expr], _ loopBody: Expr, _ limit: Int, _ env: [String: Typed]
) throws(ShaderError) -> Typed {
  guard seeds.count == params.count else { throw ShaderError("A loop needs a seed for each of its parameters.") }
  let outer = typesOf(env)
  let types = try typed { () throws(LanguageError) in try loopTypes(params, seeds, loopBody, outer) }
  let (ptypes, result) = (types.params, types.result)
  var free = NameSet()
  for v in freeVars(loopBody) {
    if params.contains(v) || v == "i" { continue }
    if v == "w" && env[v] == nil {
      free.insert("x")
      free.insert("y")
    } else {
      free.insert(v)
    }
  }
  // The params become the locals p<d>_0, p<d>_1, … by substitution, not only
  // by binding: a real subtree compiles through toGLSL, which spells
  // variables by name. (No user name can clash: sliders arrive as u_…
  // uniforms.) d is the nesting depth: a loop in an outer loop's exit leaf
  // sees the outer locals as free variables and must not redeclare them.
  var depth = 0
  while env.keys.contains(where: { $0.hasPrefix("p\(depth)_") }) { depth += 1 }
  func local(_ k: Int) -> String { "p\(depth)_\(k)" }
  var locals: [String: Expr] = [:]
  for (k, p) in params.enumerated() { locals[p] = .var(local(k)) }
  let body = substVars(loopBody, locals)
  var inner = env
  var args: [String] = []
  var decls: [String] = []
  for k in params.indices {
    inner[local(k)] = Typed(type: ptypes[k], code: local(k))
    decls.append("\(glType(ptypes[k])) \(local(k))")
    args.append(cast(try compileTyped(seeds[k], env), ptypes[k]))
  }
  for v in free {
    let type = env[v]?.type ?? .real
    inner[v] = Typed(type: type, code: v)
    decls.append("\(glType(type)) \(v)")
    args.append(env[v]?.code ?? v)
  }
  let scope = inner
  func emitCond(_ x: Expr) throws(ShaderError) -> String { try compileTyped(x, scope).code }
  func emitLeaf(_ leaf: Expr) throws(ShaderError) -> String {
    guard let recur = recurArgs(leaf) else { return "return \(cast(try compileTyped(leaf, scope), result));" }
    var next: [String] = []
    for (k, a) in recur.enumerated() {
      // (A self-call passing more values than there are params: the extra are real.)
      let type = k < ptypes.count ? ptypes[k] : .real
      next.append("\(glType(type)) n\(k) = \(cast(try compileTyped(a, scope), type));")
    }
    let assigns = params.indices.map { "\(local($0)) = n\($0);" }
    return "\(next.joined(separator: " ")) \(assigns.joined(separator: " ")) continue;"
  }
  func emitBody(_ body: Expr) throws(ShaderError) -> String {
    guard case .piecewise(let cases, let otherwise) = body else { return try emitLeaf(body) }
    var parts: [String] = []
    for c in cases { parts.append("if (\(try condGLSL(c.cond, emitCond))) { \(try emitBody(c.value)) }") }
    let last = try otherwise.map { (o: Expr) throws(ShaderError) in try emitBody(o) } ?? "return \(nanOf(result));"
    return "\(parts.joined(separator: " else ")) else { \(last) }"
  }
  let finite = params.indices.map { k in
    ptypes[k] == .complex
      ? "any(isnan(\(local(k)))) || any(isinf(\(local(k))))" : "isnan(\(local(k))) || isinf(\(local(k)))"
  }.joined(separator: " || ")
  let name = declareHelper(
    """
    \(glType(result)) \(helperSelf)(\(decls.joined(separator: ", "))) {
      for (int k = 0; k < \(limit); k++) {
        if (\(finite)) return \(nanOf(result));
        \(try emitBody(body))
      }
      return \(nanOf(result));
    }
    """)
  return Typed(type: result, code: "\(name)(\(args.joined(separator: ", ")))")
}

/// The types a loop's params settle to, and its result's (lib/complex.ts
/// `loopTypes`). A param starts as its seed's type and becomes complex once
/// any self-call passes it a complex value (which may depend on the other
/// params: iterate to a fixed point; complex is absorbing, so it needs at
/// most one round per param). The result is complex if any exit leaf is.
func loopTypes(
  _ names: [String], _ seeds: [Expr], _ body: Expr, _ env: [String: ScalarType]
) throws(LanguageError) -> (params: [ScalarType], result: ScalarType) {
  var params: [ScalarType] = []
  for seed in seeds { params.append(try inferScalarType(seed, env)) }
  let leaves = loopLeaves(body)
  func bound() -> [String: ScalarType] {
    var inner = env
    // (A param with no seed has no type: it reads as its name does outside.)
    for (k, p) in names.enumerated() { inner[p] = k < params.count ? params[k] : nil }
    return inner
  }
  var changed = true
  while changed {
    changed = false
    let inner = bound()
    for leaf in leaves {
      guard let args = recurArgs(leaf) else { continue }
      for (k, a) in args.enumerated() where k < params.count && params[k] == .real {
        if try inferScalarType(a, inner) == .complex {
          params[k] = .complex
          changed = true
        }
      }
    }
  }
  let inner = bound()
  try checkConditions(body, inner)
  var result = ScalarType.real
  for leaf in leaves where recurArgs(leaf) == nil {
    if try inferScalarType(leaf, inner) == .complex {
      result = .complex
      break
    }
  }
  return (params, result)
}

/// Every comparison in a loop body's cases compares real values.
private func checkConditions(_ body: Expr, _ env: [String: ScalarType]) throws(LanguageError) {
  guard case .piecewise(let cases, let otherwise) = body else { return }
  for c in cases {
    try realCondition(c.cond, env)
    try checkConditions(c.value, env)
  }
  if let otherwise { try checkConditions(otherwise, env) }
}

private func realCondition(_ cond: Expr, _ env: [String: ScalarType]) throws(LanguageError) {
  if case .ineq(_, let l, let r, _) = cond {
    try realCondition(l, env)
    try realCondition(r, env)
    return
  }
  if try inferScalarType(cond, env) == .complex {
    throw LanguageError("Complex condition: compare re(…), im(…), or abs(…).")
  }
}

/// Whether `e` is a complex number — not merely passing through complex
/// values (`re(z)`, `|z|`), and not something typing refuses.
func isComplexValued(_ e: Expr) -> Bool {
  usesComplex(e) && (try? inferScalarType(e)) == .complex
}

/// Result typing, independent of code generation and structural complex
/// involvement (lib/complex.ts `inferScalarType`).
public func inferScalarType(_ e: Expr, _ env: [String: ScalarType] = [:]) throws(LanguageError) -> ScalarType {
  // (A kind to a function, below: this walk is a frame per level of the expression, and a debug
  // build's frame holds every case's temporaries at once.)
  switch e {
  case .num:
    return .real
  case .var(let name):
    return env[name] ?? (name == "i" || name == "w" ? .complex : .real)
  case .neg(let a):
    return try inferScalarType(a, env)
  case .bin(_, let lhs, let rhs, _):
    let a = try inferScalarType(lhs, env)
    let b = try inferScalarType(rhs, env)
    return a == .complex || b == .complex ? .complex : .real
  case .call:
    return try inferTypeCall(e, env)
  case .eq:
    return try inferTypeEq(e, env)
  case .ineq:
    throw LanguageError("Unexpected inequality.")
  case .vec:
    throw LanguageError("Vector in scalar context.")
  case .list:
    throw LanguageError("A list can only be plotted as its own row.")
  case .piecewise:
    return try inferTypePiecewise(e, env)
  case .loop(let params, let seeds, let body, _):
    return try loopTypes(params, seeds, body, env).result
  case .index, .range, .eqtest, .comp, .figure, .lazy, .trail, .label, .hist, .family:
    throw LanguageError("This object must be lowered before scalar type inference.")
  case .data, .str, .text:
    throw LanguageError("Expected a scalar expression.")
  }
}

private func inferTypeCall(_ e: Expr, _ env: [String: ScalarType]) throws(LanguageError) -> ScalarType {
  guard case .call(let name, let args) = e else { return .real }
  // (A list literal as the resolver marks it is the list: Expr.swift, "List identity".)
  if name == LIST_ID || name == LIST_ORIGIN, let list = args.last { return try inferScalarType(list, env) }
  var types: [ScalarType] = []
  for a in args { types.append(try inferScalarType(a, env)) }
  return try inferCallType(name, types)
}

private func inferTypeEq(_ e: Expr, _ env: [String: ScalarType]) throws(LanguageError) -> ScalarType {
  guard case .eq(let l, let r) = e else { return .real }
  var complex = try inferScalarType(l, env) == .complex
  if !complex { complex = try inferScalarType(r, env) == .complex }
  if complex { throw LanguageError("Complex equation: compare re(…) or im(…) instead.") }
  return .real
}

private func inferTypePiecewise(_ e: Expr, _ env: [String: ScalarType]) throws(LanguageError) -> ScalarType {
  guard case .piecewise(let cases, let otherwise) = e else { return .real }
  var complex = false
  for c in cases {
    try realCondition(c.cond, env)
    if try inferScalarType(c.value, env) == .complex { complex = true }
  }
  if let otherwise, try inferScalarType(otherwise, env) == .complex { complex = true }
  return complex ? .complex : .real
}
