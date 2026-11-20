/// The plans of the rows drawn in space (lib/compiler.ts `compileCpu` and
/// `compileGpu`, their 3D cases), and how the resolver reads `tube(…)` and
/// `revolve(…)` (lib/defs.ts `rx`). `compileCpu`/`compileGpu`
/// (Compiler.swift) hand these objects here.

private func derivatives(_ exprs: [Expr]?, _ variable: String) -> [Expr]? {
  guard let exprs else { return nil }
  return try? exprs.map { try diff($0, variable) }
}

/// (`real`: CPU evaluators are real, so a real output with complex subterms is projected.)
func compileCpu3D(_ object: MathObject) throws -> CpuPlan {
  switch object {
  case .curveTube(let coordinates, let radius):
    let comps = try coordinates.map(real)
    let d1 = derivatives(comps, "u")
    let d2 = derivatives(d1, "u")
    return .tube(comps: comps, radius: radius, d1: d1, d2: d2, d3: derivatives(d2, "u"))
  case .surfaceImplicit(let residual, let written):
    let equation = try realEquation(written)
    // z = f(x, y), either way around, with no z in f: a height map.
    var height: Expr?
    if case .eq(let l, let r) = equation {
      if case .var("z") = l { height = r } else if case .var("z") = r { height = l }
    }
    if let h = height, freeVars(h).contains("z") { height = nil }
    return .implicit3d(residual: try real(residual), equation: equation, heightmap: try height.map(real))
  case .surfaceParametric(let coordinates, let paint):
    return .psurface(comps: try coordinates.map(real), paint: try paint.map(real))
  case .intersection(let residuals):
    return .spacecurve(residuals: try residuals.map(real))
  case .scalarField3D(let expr):
    return .scalar3d(expr: try real(expr))
  case .system(let residuals, let parametric, let angular):
    return .system(
      dim: residuals.count, residuals: try residuals.map(real), parametric: parametric, angular: angular)
  default:
    preconditionFailure("not an object in space")
  }
}

/// P(u, v)'s GLSL with its tangents, when they are cheaper than the
/// renderer's finite differences (`parametricGLSL`). Differentiating repeats
/// every inlined definition in each product- and chain-rule term, so a long
/// P can have tangents many times its size: they are built a component at a
/// time and abandoned once over budget, or when P cannot be differentiated.
///
/// The budget counts shader text, and Shader.swift spells a number as its
/// float where the TypeScript prints the double: a P whose tangents land
/// within a few characters of the budget could come out the other way here.
public func parametricGLSL(
  _ coordinates: [Expr], _ sub: (Expr) -> Expr = { $0 }
) throws -> (comps: [String], du: [String]?, dv: [String]?) {
  let comps = try coordinates.map { try glsl(sub($0)) }
  var budget = max(4096, 4 * comps.reduce(0) { $0 + $1.utf16.count })
  func tangent(_ variable: String) throws -> [String]? {
    var out: [String] = []
    for e in coordinates {
      guard let d = try? diff(e, variable) else { return nil }
      let code: String
      do {
        code = try glsl(sub(d))
      } catch is LanguageError {
        return nil
      }
      budget -= code.utf16.count
      if budget < 0 { return nil }
      out.append(code)
    }
    return out
  }
  guard let du = try tangent("u"), let dv = try tangent("v") else { return (comps, nil, nil) }
  return (comps, du, dv)
}

/// `scalar` is compileGpu's: typed, so a complex subterm or a loop compiles.
func compileGpu3D(
  _ object: MathObject, _ sub: (Expr) -> Expr, _ scalar: (Expr) throws -> String
) throws -> GpuPlan.Shader {
  switch object {
  case .surfaceImplicit(_, let equation):
    var grad: [String]?
    if let d = try? ["x", "y", "z"].map({ try diff(equation, $0) }) {
      do {
        grad = try d.map { try glsl(sub($0)) }
      } catch is LanguageError {
        // Finite differences.
      }
    }
    return .implicit3d(field: try scalar(equation), grad: grad)
  case .surfaceParametric(let coordinates, let paint):
    let p = try parametricGLSL(coordinates, sub)
    return .psurface(comps: p.comps, du: p.du, dv: p.dv, paint: try paint.map(scalar))
  case .scalarField3D(let expr):
    return .scalar3d(field: try scalar(expr))
  case .vectorField(let components):
    // Only the optional streamline view uses this; trajectories and arrows
    // trace on the CPU, so a field GLSL cannot express still draws.
    do {
      return .vfield3d(comps: try components.map { try glsl(sub($0)) })
    } catch is LanguageError {
      return .none
    }
  default:
    preconditionFailure("not an object in space")
  }
}

extension Resolver {
  /// `tube(…)` and `revolve(…)`, whole-row forms classify reads
  /// (Classify3D.swift): the call is kept, its arguments resolved.
  func resolveSpaceForm(_ name: String, _ args: [Expr]) throws -> Expr {
    if opts.inDefinition {
      if name == "revolve" {
        throw LanguageError("revolve(…) must be a whole row, not part of a definition.")
      }
      // Port: the site keeps a tube a definition names (a function's body).
      throw Unsupported("tube(…) in a definition")
    }
    if name == "revolve", args.count >= 1, args.count <= 2 {
      // revolve(f) names the profile by its function: f stands for f(x), or
      // f(y) / f(z) about the axis asked for. classify checks the rest.
      let f = args[0]
      if case .var(let fname) = f, let profile = try getFn(fname) {
        let axis = try revolveAxis(args.count == 2 ? args[1] : nil)
        if profile.params.count != 1 {
          throw LanguageError(
            "revolve(\(fname)) needs a function of one variable; \(fname) takes \(profile.params.count).")
        }
        let body = substVars(profile.body, [profile.params[0]: .var(axis)])
        return .call(name, [body] + args.dropFirst())
      }
      // Only the bare name stands for its function; inside a larger profile
      // (-f, 2f) it has to be called.
      for v in freeVars(f) where try getFn(v) != nil {
        throw LanguageError("\(v) is a function — write it with parentheses, e.g. \(v)(x).")
      }
    }
    return .call(name, args)
  }
}
