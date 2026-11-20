/// What lib/compiler.ts does for complex values: the real projection a CPU
/// plan holds, typed shader text, and a colour field's program.

/// CPU evaluators are real: real outputs containing complex subterms need
/// projection too (lib/compiler.ts `real`).
func real(_ expr: Expr) throws -> Expr {
  usesComplex(expr) ? try splitWithin(expr, "expression", "evaluate").re : expr
}

func realEquation(_ expr: Expr) throws -> Expr {
  if case .eq(let l, let r) = expr { return .eq(try real(l), try real(r)) }
  return try real(expr)
}

/// `compileTyped`, with what it refuses as the row's error.
func typedGLSL(_ e: Expr, _ env: [String: Typed] = [:]) throws -> Typed {
  do {
    return try compileTyped(e, env)
  } catch {
    throw LanguageError(error.message)
  }
}

/// Node kinds whose children all live in the enclosing scope, so a child may
/// be emitted as a shader local ahead of its parent. Anything that binds a
/// variable (a Σ/Π, or any future binder) compiles as one unit instead.
private func bindsVariable(_ e: Expr) -> Bool {
  switch e {
  case .call(let name, let args): (name == "sum" || name == "prod") && args.count >= 4
  case .num, .var, .bin, .neg, .piecewise, .ineq, .eq: false
  default: true
  }
}

/// Emit shared channel calculations once (lib/compiler.ts `colorProgram`).
/// Inlining a nested complex map into three colors otherwise duplicates it at
/// every re/im/arg use and can leave the device compiling megabytes of
/// shader. Intern shallow lowered nodes too: separate channel expressions may
/// contain identical but unshared trees. All expressions are pure; undefined
/// values in an unselected piecewise arm stay in that arm's temporary and do
/// not affect the selected result.
func colorProgram(_ channels: [Expr], _ params: [String]) throws -> (field: String, locals: String) {
  let sub = uniformSub(params)
  var shared: [String: Expr] = [:]
  var bindings: [String: Typed] = [:]
  var complexLocals: Set<String> = []
  var lines: [String] = []
  func compile(_ e: Expr) throws -> Typed {
    do {
      return try compileTyped(e, bindings, complexNames: complexLocals)
    } catch {
      throw LanguageError(error.message)
    }
  }
  func visit(_ expr: Expr) throws -> Expr {
    var isLoop = false
    switch expr {
    case .num: return expr
    case .var: return sub(expr)
    case .loop: isLoop = true
    default: if bindsVariable(expr) { return sub(expr) }
    }
    // A loop is interned whole, never entered: an escape count read by
    // every channel then runs once per pixel.
    let lowered = isLoop ? sub(expr) : try mapChildren(expr, visit)
    // Inequalities retain their boolean shape for piecewiseGLSL.
    if case .ineq = expr { return lowered }
    let key = exprKey(lowered)
    if let reused = shared[key] { return reused }
    let value = try compile(lowered)
    let name = "eqColor\(lines.count)"
    lines.append("\(value.type == .complex ? "vec2" : "float") \(name) = \(value.code);")
    if value.type == .complex {
      bindings[name] = Typed(type: .complex, code: name)
      complexLocals.insert(name)
    }
    let result = Expr.var(name)
    shared[key] = result
    return result
  }
  var colors: [String] = []
  for channel in channels { colors.append(try compile(try visit(channel)).code) }
  // The optional fourth channel is opacity; without one the field is opaque.
  if colors.count == 3 { colors.append("1.0") }
  return ("vec4(\(colors.joined(separator: ", ")))", lines.joined(separator: "\n"))
}
