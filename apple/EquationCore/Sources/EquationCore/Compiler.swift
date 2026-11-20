/// Independent CPU projection and GPU compilation of a classified row
/// (lib/compiler.ts), and the readout a plan shows under its row
/// (lib/plot.ts `plotReadout`).
///
/// A CPU plan holds expressions, evaluated with the constants' own names; a
/// GPU plan holds GLSL, with each constant it reads (`params`) a uniform.

/// A level-set family for the CPU: f, and its gradient where it has one.
public struct CpuGrid: Equatable, Sendable {
  public var name: String
  public var expr: Expr
  /// [∂f/∂x, ∂f/∂y], or nil where f has no symbolic derivative.
  public var grad: [Expr]?
  public var params: [String]
  /// f is an angle (it reads atan2), so its level sets wrap.
  public var angular: Bool
  public var level: String?
}

public struct GpuGrid: Equatable, Sendable {
  public var glsl: String
  public var gradGlsl: [String]?
  public var params: [String]
}

public enum CpuPlan: Equatable, Sendable {
  case implicit2d(residual: Expr, equation: Expr, levels: CpuGrid?)
  case ineq2d(constraints: [Constraint])
  case scalar2d(expr: Expr)
  case point(dim: Int, coords: [Expr])
  case vfield2d(comps: [Expr])
  case value(expr: Expr)
  case note(expr: Expr, variable: Bool, constant: String?, identity: Bool)

  /// The plan's `type`, as the TypeScript spells it.
  public var type: String {
    switch self {
    case .implicit2d: "implicit2d"
    case .ineq2d: "ineq2d"
    case .scalar2d: "scalar2d"
    case .point: "point"
    case .vfield2d: "vfield2d"
    case .value: "value"
    case .note: "note"
    }
  }
}

public struct GpuPlan: Equatable, Sendable {
  /// The constants the shader reads, each as the uniform `uniformName` gives.
  public var params: [String]
  public var shader: Shader

  public enum Shader: Equatable, Sendable {
    /// Nothing for the GPU: the row is drawn (or only read out) on the CPU.
    case none
    /// The zero set of `field`, F in floats x, y and t.
    case implicit2d(field: String, levels: GpuGrid?)
    /// Where `field` is negative; `edges` are the boundaries that belong to it.
    case ineq2d(field: String, edges: [String])
    case scalar2d(field: String)
    case vfield2d(fx: String, fy: String)
  }

  public var type: String {
    switch shader {
    case .none: "none"
    case .implicit2d: "implicit2d"
    case .ineq2d: "ineq2d"
    case .scalar2d: "scalar2d"
    case .vfield2d: "vfield2d"
    }
  }
}

/// Whether an expression reads an angle: atan2, or the angle(…) measurement.
private func hasAtan2(_ e: Expr) -> Bool {
  if case .call(let name, let args) = e,
    name == "atan2" || name == angleFnName || (name == "atan" && args.count == 2)
  {
    return true
  }
  return childrenOf(e).contains(where: hasAtan2)
}

private func compileGridCpu(_ spec: LevelSetSpec) -> CpuGrid {
  // (No gradient: the renderer takes finite differences.)
  let gradient = try? [Sym.diff(spec.expr, "x"), Sym.diff(spec.expr, "y")]
  return CpuGrid(
    name: spec.name, expr: spec.expr, grad: gradient, params: spec.params, angular: hasAtan2(spec.expr),
    level: spec.level)
}

public func compileCpu(_ classified: Classified) -> CpuPlan {
  switch classified.object {
  case .curveGraph(_, let equation, let levels):
    guard case .eq(let l, let r) = equation else { preconditionFailure("a graph is an equation") }
    return .implicit2d(residual: .bin(.sub, l, r), equation: equation, levels: levels.map(compileGridCpu))
  case .curveImplicit(let residual, let equation, let levels):
    return .implicit2d(residual: residual, equation: equation, levels: levels.map(compileGridCpu))
  case .region(let constraints):
    return .ineq2d(constraints: constraints)
  case .scalarField(let expr):
    return .scalar2d(expr: expr)
  case .vectorField(let components):
    return .vfield2d(comps: components)
  case .point(let coordinates):
    return .point(dim: coordinates.count, coords: coordinates)
  case .value(let expr):
    return .value(expr: expr)
  case .note(let expr, let variable, let constant, let identity):
    return .note(expr: expr, variable: variable, constant: constant, identity: identity)
  }
}

/// GLSL for an expression, with what the shader emitter does not cover yet
/// told apart from what the site refuses too.
private func glsl(_ e: Expr) throws -> String {
  do {
    return try toGLSL(e)
  } catch {
    // Shader.swift is being brought up to lib/glsl.ts; until it is, a
    // function it has no spelling for is the port's gap, not the row's error.
    if error.message.contains("Metal renderer") { throw Unsupported("a function the shaders do not draw yet") }
    throw LanguageError(error.message)
  }
}

private func uniformSub(_ params: [String]) -> (Expr) -> Expr {
  var map: [String: Expr] = [:]
  for name in params { map[name] = .var(uniformName(name)) }
  return { expr in params.isEmpty ? expr : substVars(expr, map) }
}

private func compileGridGpu(_ spec: LevelSetSpec) throws -> GpuGrid {
  let sub = uniformSub(spec.params)
  var gradGlsl: [String]?
  if let dx = try? Sym.diff(spec.expr, "x"), let dy = try? Sym.diff(spec.expr, "y") {
    do {
      gradGlsl = [try glsl(sub(dx)), try glsl(sub(dy))]
    } catch is LanguageError {
      // Finite differences.
    }
  }
  return GpuGrid(glsl: try glsl(sub(spec.expr)), gradGlsl: gradGlsl, params: spec.params)
}

public func compileGpu(_ classified: Classified) throws -> GpuPlan {
  let params = classified.params
  let sub = uniformSub(params)
  func plan(_ shader: GpuPlan.Shader) -> GpuPlan { GpuPlan(params: params, shader: shader) }
  switch classified.object {
  case .curveGraph(_, let equation, let levels), .curveImplicit(_, let equation, let levels):
    // (A graph's `graphEval` is for reconstructed Fourier series, which the
    // port does not reach.)
    return plan(.implicit2d(field: try glsl(sub(equation)), levels: try levels.map(compileGridGpu)))
  case .region(let constraints):
    let fields = try constraints.map { (code: try glsl(sub($0.residual)), edge: !$0.strict) }
    let field = fields.dropFirst().reduce(fields[0].code) { "max(\($0), \($1.code))" }
    return plan(.ineq2d(field: field, edges: fields.filter(\.edge).map(\.code)))
  case .scalarField(let expr):
    return plan(.scalar2d(field: try glsl(sub(expr))))
  case .vectorField(let components):
    return plan(.vfield2d(fx: try glsl(sub(components[0])), fy: try glsl(sub(components[1]))))
  case .point, .value, .note:
    return plan(.none)
  }
}

// MARK: - Readouts

/// The readout of a `value` row: `= 4` when six significant figures say it
/// all, `≈ 1.41421` when they round, `undefined` when there is no number.
public func valueReadout(_ value: Double) -> String {
  if value.isNaN { return "undefined" }
  if !value.isFinite { return value > 0 ? "= ∞" : "= −∞" }
  // Six significant digits, and at most six decimals; a value under 0.001
  // keeps its six digits, so a small one still reads.
  let precise = JS.number(JS.toPrecision(value, 6))
  let shown = abs(value) >= 1e-3 ? JS.number(JS.toFixed(precise, 6)) : precise
  return "\(shown == value ? "=" : "≈") \(JS.string(shown))"
}

/// A decided comparison is a note, independent of the view and render mode.
private func comparisonReadout(
  _ e: Expr, variable: Bool, constant: String?, identity: Bool, _ env: [String: Double]
) throws -> String {
  if identity { return "Holds everywhere (checked numerically)" }
  func six(_ v: Double) -> String { JS.string(JS.number(JS.toPrecision(v, 6))) }
  let truth: Bool
  let values: String
  switch e {
  case .eq(let l, let r):
    let a = try evaluate(l, env)
    let b = try evaluate(r, env)
    if !a.isFinite || !b.isFinite { return "Undefined comparison" }
    truth = a == b
    values = "\(six(a)) \(truth ? "=" : "≠") \(six(b))"
  case .ineq:
    let comparisons = ineqComparisons(e)
    var vals: [(Double, Double)] = []
    for c in comparisons { vals.append((try evaluate(c.l, env), try evaluate(c.r, env))) }
    if !vals.allSatisfy({ $0.0.isFinite && $0.1.isFinite }) { return "Undefined comparison" }
    truth = zip(comparisons, vals).allSatisfy { c, v in
      switch c.op {
      case .lt: v.0 < v.1
      case .le: v.0 <= v.1
      case .gt: v.0 > v.1
      case .ge: v.0 >= v.1
      }
    }
    values = zip(comparisons, vals).map { c, v in "\(six(v.0)) \(c.op.rawValue) \(six(v.1))" }
      .joined(separator: ", ")
  default:
    return ""
  }
  let verdict =
    "\(variable ? (truth ? "True now" : "False now") : truth ? "Always true" : "Never true") (\(values))"
  // `e = 0.6` meant as a slider: the constant cannot be one, so say why the
  // row became a (false) claim instead.
  if let constant, !truth { return "\(verdict) — \(takenNameHint(constant))" }
  return verdict
}

/// One readout per source row, or nil for a plan that has none.
public func plotReadout(_ plan: CpuPlan, _ env: [String: Double]) throws -> String? {
  switch plan {
  case .value(let expr):
    return valueReadout(try evaluate(expr, env))
  case .note(let expr, let variable, let constant, let identity):
    return try comparisonReadout(expr, variable: variable, constant: constant, identity: identity, env)
  default:
    return nil
  }
}
