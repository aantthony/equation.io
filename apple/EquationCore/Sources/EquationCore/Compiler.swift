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
  /// A curve in u, with its first three derivatives in u where it has them
  /// (the renderer takes finite differences otherwise).
  case pcurve(dim: Int, comps: [Expr], d1: [Expr]?, d2: [Expr]?, d3: [Expr]?)
  case vfield2d(comps: [Expr])
  case value(expr: Expr)
  case label(dim: Int, coords: [Expr], text: String)
  /// A figure: `pts` flat, or with `over` one vertex template run over the
  /// columns. `arrow`: a head at the last vertex; `hull`: the convex hull of
  /// the points is what is drawn.
  case polygon(dim: Int, pts: [Expr], closed: Bool, arrow: Bool, hull: Bool, over: [Column]?)
  /// A 2×2 matrix field's entries, row-major.
  case tfield2d(entries: [Expr], streamlines: Bool)
  /// Values read out: a long tuple's (`length` of them in all), or a
  /// matrix's or tensor's, nested by `shape`.
  case tuple(values: [Expr], shape: [Int]?, length: Int?)
  case note(expr: Expr, variable: Bool, constant: String?, identity: Bool)
  /// Drawn per pixel on the GPU, like the three below: the complex expression itself.
  case complexField(form: ComplexForm, expr: Expr)
  case fractal2d(step: Expr, seed: String, maxIter: Int)
  case color2d(space: String, channels: [Expr])
  /// A sequence's term in its index, evaluated at whole numbers.
  case sequence(term: Expr, index: String)
  /// A recurrence's map f in `recVar`, iterated from the constant `a0Name`
  /// (or 1/2): its cobweb, or its orbit diagram over x.
  case cobweb(f: Expr, recVar: String, a0Name: String?)
  case bifurcation(expr: Expr, recVar: String, a0Name: String?)
  /// An automaton's rule over its neighbours and its seed over the cells.
  case automaton(rule: Expr, radius: Int, seed: Expr?, dims: Int, axes: [String])
  /// A table's value over the cells.
  case lattice(expr: Expr, axes: [String])
  // In space (Compiler3D.swift).
  /// `heightmap`: f, when the surface is z = f(x, y).
  case implicit3d(residual: Expr, equation: Expr, heightmap: Expr?)
  case scalar3d(expr: Expr)
  case spacecurve(residuals: [Expr])
  case system(dim: Int, residuals: [Expr], parametric: Bool, angular: [Bool])
  /// A complex equation's system in x and y, with the equation its roots are
  /// named from (the TypeScript's `system` plan with a `complexEquation`).
  case complexSystem(residuals: [Expr], equation: Expr)
  case vfield3d(comps: [Expr])
  /// A `pcurve` in space with its `tube` radius (the TypeScript's plan is one type).
  case tube(comps: [Expr], radius: Expr, d1: [Expr]?, d2: [Expr]?, d3: [Expr]?)
  case psurface(comps: [Expr], paint: Expr?)
  /// A random variable's density, drawn from its law on the CPU.
  case density(rv: String, mass: Expr?)
  /// A discrete random variable's mass function, drawn as stems.
  case pmf(rv: String, mass: Expr?)
  /// An `E(…)` row: a marker at the mean under the variable's law.
  case expect(rv: String)
  /// A `P(…)` row: its event, and the variable whose law it shades.
  case prob(body: Expr, shade: ProbShade?)
  /// States' paths over a time range (Orbit.swift); `dim` 2 for a series against t.
  case orbit(dim: Int, paths: [[Expr]], series: Bool, from: Expr, to: Expr)
  /// A moving point whose past positions are drawn (Trail.swift).
  case trail(dim: Int, coords: [Expr])
  /// A list of numbers: a dot plot on the number line.
  case vlist(values: [Expr])
  /// A list of points.
  case plist(dim: Int, pts: [[Expr]])
  /// A packed list of numbers, and a scatter of packed columns.
  case dlist(values: [Double])
  case dscatter(dim: Int, coords: [[Double]])
  case histogram(centers: [Double], counts: [Double], width: Double)
  /// A multiset of `count` tuples or tensors of one `shape`, read out.
  case tuples(values: [Expr], shape: [Int], count: Int)
  /// A multivector's coefficients, or a multiset's, read out by blade.
  case blades(values: [Expr], dim: Int, quat: Bool, count: Int?)
  /// A point's, line's, plane's or motor's coefficients, read out as what it is.
  case flat(values: [Expr], dim: Int, grade: Int, count: Int?)
  /// One plan per list element.
  indirect case family(members: [FamilyMember])

  /// The plan's `type`, as the TypeScript spells it.
  public var type: String {
    switch self {
    case .implicit2d: "implicit2d"
    case .ineq2d: "ineq2d"
    case .scalar2d: "scalar2d"
    case .point: "point"
    case .pcurve: "pcurve"
    case .vfield2d: "vfield2d"
    case .value: "value"
    case .label: "label"
    case .polygon: "polygon"
    case .tfield2d: "tfield2d"
    case .tuple: "tuple"
    case .note: "note"
    case .complexField(let form, _): form.planType
    case .fractal2d: "fractal2d"
    case .color2d(let space, _): "\(space)2d"
    case .sequence: "sequence"
    case .cobweb: "cobweb"
    case .bifurcation: "bifurcation"
    case .automaton: "automaton"
    case .lattice: "lattice"
    case .implicit3d: "implicit3d"
    case .scalar3d: "scalar3d"
    case .spacecurve: "spacecurve"
    case .system, .complexSystem: "system"
    case .vfield3d: "vfield3d"
    case .tube: "pcurve"
    case .psurface: "psurface"
    case .density: "density"
    case .pmf: "pmf"
    case .expect: "expect"
    case .prob: "prob"
    case .orbit: "orbit"
    case .trail: "trail"
    case .vlist: "vlist"
    case .plist: "plist"
    case .dlist: "dlist"
    case .dscatter: "dscatter"
    case .histogram: "histogram"
    case .tuples, .blades, .flat: "tuple"
    case .family: "family"
    }
  }
}

public struct GpuPlan: Equatable, Sendable {
  /// The constants the shader reads, each as the uniform `uniformName` gives.
  public var params: [String]
  public var shader: Shader
  /// A finite Fourier graph's value and analytic slope, as one vec4 in x and
  /// `reach` (lib/glsl.ts `fourierGraphGLSL`): only a `y = f(x)` curve has one.
  public var graphEval: GraphEval?

  public struct GraphEval: Equatable, Sendable {
    public var glsl: String
    public var slopeScale: Double
  }
  /// Values the plan sets itself, by constant name: a family member's index
  /// into the program its family shares.
  public var uniforms: [String: Double] = [:]
  /// A plane's coefficients a, b, c, d, beside its implicit surface: drawn
  /// translucent, as a plane (lib/compiler.ts, an implicit3d plan's `plane`).
  public var plane: [String]? = nil

  public enum Shader: Equatable, Sendable {
    /// Nothing for the GPU: the row is drawn (or only read out) on the CPU.
    case none
    /// The zero set of `field`, F in floats x, y and t.
    case implicit2d(field: String, levels: GpuGrid?)
    /// Where `field` is negative; `edges` are the boundaries that belong to it.
    case ineq2d(field: String, edges: [String])
    case scalar2d(field: String)
    case vfield2d(fx: String, fy: String)
    /// A complex field, a vec2 in floats x, y and t.
    case complexField(form: ComplexForm, field: String)
    /// One step of the iteration, a vec2 in the vec2 `zc` and floats x, y.
    case fractal2d(step: String, seed: String, maxIter: Int)
    /// `field` is a vec4 of the channels and opacity, read after the shared
    /// calculations `locals` declares.
    case color2d(space: String, field: String, locals: String)
    /// A 2×2 matrix field's entries, row-major, each in floats x, y and t.
    case tfield2d(entries: [String], streamlines: Bool)
    /// A cobweb's curve y = f(x), as an implicit field.
    case cobweb(curveField: String)
    /// A recurrence's map in the float `a`, its parameter the pixel's x.
    case bifurcation(field: String)
    // In space (Compiler3D.swift).
    /// F in floats x, y, z and t; `grad` its gradient, where it has one.
    case implicit3d(field: String, grad: [String]?)
    case scalar3d(field: String)
    case vfield3d(comps: [String])
    /// P(u, v), with its tangents when they are cheaper than finite
    /// differences, and the scalar in u and v it is coloured by.
    case psurface(comps: [String], du: [String]?, dv: [String]?, paint: String?)
    /// One plan per list element.
    indirect case family(members: [GpuPlan])
  }

  public var type: String {
    switch shader {
    case .none: "none"
    case .implicit2d: "implicit2d"
    case .ineq2d: "ineq2d"
    case .scalar2d: "scalar2d"
    case .vfield2d: "vfield2d"
    case .complexField(let form, _): form.planType
    case .fractal2d: "fractal2d"
    case .color2d(let space, _, _): "\(space)2d"
    case .tfield2d: "tfield2d"
    case .cobweb: "cobweb"
    case .bifurcation: "bifurcation"
    case .implicit3d: "implicit3d"
    case .scalar3d: "scalar3d"
    case .vfield3d: "vfield3d"
    case .psurface: "psurface"
    case .family: "family"
    }
  }
}

/// Whether an expression reads an angle: atan2, or the angle(…) measurement.
private func hasAtan2(_ e: Expr) -> Bool {
  if case .call(let name, let args) = e,
    name == "atan2" || name == ANGLE_FN || (name == "atan" && args.count == 2)
  {
    return true
  }
  return childrenOf(e).contains(where: hasAtan2)
}

func compileGridCpu(_ spec: LevelSetSpec) throws -> CpuGrid {
  let expr = try real(spec.expr)
  // (No gradient: the renderer takes finite differences.)
  let gradient = try? [diff(expr, "x"), diff(expr, "y")]
  return CpuGrid(
    name: spec.name, expr: expr, grad: gradient, params: spec.params, angular: hasAtan2(spec.expr),
    level: spec.level)
}

public func compileCpu(_ classified: Classified) throws -> CpuPlan {
  func derivatives(_ exprs: [Expr]?) -> [Expr]? {
    guard let exprs else { return nil }
    return try? exprs.map { try diff($0, "u") }
  }
  func pcurve(_ comps: [Expr]) -> CpuPlan {
    let d1 = derivatives(comps)
    let d2 = derivatives(d1)
    return .pcurve(dim: comps.count, comps: comps, d1: d1, d2: d2, d3: derivatives(d2))
  }
  switch classified.object {
  case .curveGraph(_, let written, let levels):
    let equation = try realEquation(written)
    guard case .eq(let l, let r) = equation else { preconditionFailure("a graph is an equation") }
    return .implicit2d(residual: .bin(.sub, l, r), equation: equation, levels: try levels.map(compileGridCpu))
  case .curveImplicit(let residual, let equation, let levels):
    return .implicit2d(
      residual: try real(residual), equation: try realEquation(equation), levels: try levels.map(compileGridCpu))
  case .region(let constraints):
    return .ineq2d(constraints: try constraints.map { Constraint(residual: try real($0.residual), strict: $0.strict) })
  case .scalarField(let expr):
    return .scalar2d(expr: try real(expr))
  case .vectorField(let components):
    let comps = try components.map(real)
    return comps.count == 3 ? .vfield3d(comps: comps) : .vfield2d(comps: comps)
  case .curveTube, .surfaceImplicit, .surfaceParametric, .intersection, .scalarField3D, .system:
    return try compileCpu3D(classified.object)
  case .complexSystem(let equation):
    return try compileComplexSystem(equation)
  case .point(let coordinates):
    return .point(dim: coordinates.count, coords: try coordinates.map(real))
  case .complexPoint(let expr):
    let (re, im) = try splitWithin(expr, "point", "evaluate")
    return .point(dim: 2, coords: [re, im])
  case .curveParametric(let coordinates):
    return pcurve(try coordinates.map(real))
  case .complexPath(let expr):
    let (re, im) = try splitWithin(expr, "path", "sample")
    return pcurve([re, im])
  case .value(let expr):
    return .value(expr: try real(expr))
  case .label(let coordinates, let text):
    return .label(dim: coordinates.count, coords: try coordinates.map(real), text: text)
  case .figure(let form, let dimension, let vertices, let over):
    return compileFigure(form: form, dimension: dimension, vertices: vertices, over: over)
  case .tensorField(let entries, let streamlines):
    return .tfield2d(entries: try entries.map(real), streamlines: streamlines)
  case .tuple(let values, let shape, let length):
    return .tuple(values: try values.map(real), shape: shape, length: length)
  case .note(let expr, let variable, let constant, let identity):
    return .note(expr: expr, variable: variable, constant: constant, identity: identity)
  // Like domain coloring, these expressions are rendered per pixel on the GPU.
  case .complexField(let form, let expr):
    return .complexField(form: form, expr: expr)
  case .fractal(let step, let seed, let maxIter):
    return .fractal2d(step: step, seed: seed, maxIter: maxIter)
  case .colorField(let space, let channels):
    return .color2d(space: space, channels: channels)
  case .sequence(let term, let index):
    return .sequence(term: term, index: index)
  case .cobweb(let expr, let variable, let seedName):
    return .cobweb(f: expr, recVar: variable, a0Name: seedName)
  case .bifurcation(let expr, let variable, let seedName):
    return .bifurcation(expr: expr, recVar: variable, a0Name: seedName)
  case .automaton(let rule, let radius, let seed, let dims, let axes):
    return .automaton(rule: rule, radius: radius, seed: seed, dims: dims, axes: axes)
  case .lattice(let expr, let axes):
    return .lattice(expr: expr, axes: axes)
  case .distribution(let form, let rv, let mass):
    return switch form {
    case .density: .density(rv: rv, mass: mass)
    case .pmf: .pmf(rv: rv, mass: mass)
    case .expect: .expect(rv: rv)
    }
  case .probability(let body, let shade):
    return .prob(body: body, shade: shade)
  case .orbit(let paths, let series, let from, let to):
    return .orbit(dim: series ? 2 : paths.first?.count ?? 2, paths: paths, series: series, from: from, to: to)
  case .trail(let coordinates):
    return .trail(dim: coordinates.count, coords: try coordinates.map(real))
  case .blades(let values, let dim, let quat, let count):
    return .blades(values: try values.map(real), dim: dim, quat: quat, count: count)
  case .flat(let values, let dim, let grade, let count):
    return .flat(values: try values.map(real), dim: dim, grade: grade, count: count)
  case .list, .histogram, .tuples, .family:
    return try compileListCpu(classified.object)
  }
}

/// GLSL for an expression, with what the shader emitter does not cover yet
/// told apart from what the site refuses too.
func glsl(_ e: Expr) throws -> String {
  do {
    return try toGLSL(e)
  } catch {
    // Shader.swift is being brought up to lib/glsl.ts; until it is, a
    // function it has no spelling for is the port's gap, not the row's error.
    if error.message.contains("Metal renderer") { throw Unsupported("a function the shaders do not draw yet") }
    throw LanguageError(error.message)
  }
}

func uniformSub(_ params: [String]) -> (Expr) -> Expr {
  var map: [String: Expr] = [:]
  for name in params { map[name] = .var(uniformName(name)) }
  return { expr in params.isEmpty ? expr : substVars(expr, map) }
}

func compileGridGpu(_ spec: LevelSetSpec) throws -> GpuGrid {
  let sub = uniformSub(spec.params)
  var gradGlsl: [String]?
  if let dx = try? diff(spec.expr, "x"), let dy = try? diff(spec.expr, "y") {
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
  /// (What the TypeScript calls `scalar`: typed, so a complex subterm or a loop compiles.)
  func scalar(_ e: Expr) throws -> String { try typedGLSL(sub(e)).code }
  switch classified.object {
  case .curveGraph(let rhs, let equation, let levels):
    let field = try scalar(equation)
    let graphEval: GpuPlan.GraphEval?
    do {
      graphEval = try fourierGraphGLSL(sub(rhs)).map { GpuPlan.GraphEval(glsl: $0.glsl, slopeScale: $0.slopeScale) }
    } catch {
      throw LanguageError(error.message)
    }
    var graph = plan(.implicit2d(field: field, levels: try levels.map(compileGridGpu)))
    graph.graphEval = graphEval
    return graph
  case .curveImplicit(_, let equation, let levels):
    return plan(.implicit2d(field: try scalar(equation), levels: try levels.map(compileGridGpu)))
  case .region(let constraints):
    let fields = try constraints.map { (code: try scalar($0.residual), edge: !$0.strict) }
    let field = fields.dropFirst().reduce(fields[0].code) { "max(\($0), \($1.code))" }
    return plan(.ineq2d(field: field, edges: fields.filter(\.edge).map(\.code)))
  case .scalarField(let expr):
    return plan(.scalar2d(field: try scalar(expr)))
  case .vectorField(let components) where components.count == 3:
    return plan(try compileGpu3D(classified.object, sub, scalar))
  case .surfaceImplicit, .surfaceParametric, .scalarField3D:
    return plan(try compileGpu3D(classified.object, sub, scalar))
  case .vectorField(let components):
    return plan(.vfield2d(fx: try glsl(sub(components[0])), fy: try glsl(sub(components[1]))))
  case .colorField(let space, let channels):
    let program = try colorProgram(channels, params)
    return plan(.color2d(space: space, field: program.field, locals: program.locals))
  case .fractal(let step, let seed, let maxIter):
    let compiled = try typedGLSL(sub(step), ["z": Typed(type: .complex, code: "zc")])
    return plan(
      .fractal2d(
        step: compiled.type == .complex ? compiled.code : "vec2(\(compiled.code), 0.0)", seed: seed, maxIter: maxIter))
  case .complexField(let form, let expr):
    return plan(.complexField(form: form, field: try scalar(expr)))
  case .tensorField(let entries, let streamlines):
    return plan(.tfield2d(entries: try entries.map { try glsl(sub($0)) }, streamlines: streamlines))
  case .cobweb(let expr, let variable, _):
    return plan(.cobweb(curveField: try glsl(sub(.eq(.var("y"), substVars(expr, [variable: .var("x")]))))))
  case .bifurcation(let expr, let variable, _):
    return plan(.bifurcation(field: try glsl(sub(substVars(expr, [variable: .var("a")])))))
  case .point, .complexPoint, .curveParametric, .complexPath, .value, .note, .label, .figure, .tuple, .sequence,
    .automaton, .lattice, .curveTube, .intersection, .system, .complexSystem, .distribution, .probability, .orbit,
    .trail,
    .list, .histogram, .tuples, .blades, .flat:
    return plan(.none)
  case .family(let members, let shared):
    return try compileFamilyGpu(members, shared, params: params)
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
    func parts(_ x: Expr) throws -> [Double] {
      guard usesComplex(x) else { return [try evaluate(x, env), 0] }
      let (re, im) = try complexParts(x)
      return [try evaluate(re, env), try evaluate(im, env)]
    }
    let a = try parts(l)
    let b = try parts(r)
    if !(a + b).allSatisfy(\.isFinite) { return "Undefined comparison" }
    truth = a == b
    func fmt(_ p: [Double]) -> String { p[1] == 0 ? six(p[0]) : "\(six(p[0]))\(p[1] < 0 ? "" : "+")\(six(p[1]))i" }
    values = "\(fmt(a)) \(truth ? "=" : "≠") \(fmt(b))"
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
  case .tuple(let values, let shape, let length):
    return try tupleReadout(values, shape: shape, length: length, env)
  case .blades, .flat:
    return try algebraReadout(plan, env)
  case .vlist, .tuples, .family:
    return try listReadout(plan, env)
  default:
    return nil
  }
}
