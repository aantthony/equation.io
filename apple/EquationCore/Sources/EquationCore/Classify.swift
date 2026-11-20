/// What a row is, mathematically (lib/math-object.ts `MathObject`,
/// lib/plot.ts `classify`): source expressions, never backend programs.
///
/// - "l = r" → an implicit curve in x and y
/// - an inequality in x and y → the region it holds in
/// - a bare scalar in x and/or y → a 2D scalar field, drawn per pixel
/// - a pair of numbers → a point; a pair in x and y → a vector field
/// - ODEs: dy/dx = f and y' = f are the direction field (1, f); a system
///   (x', y') = (P, Q) the phase-plane field (P, Q)
/// - a pair in u → the parametric curve it traces, u ∈ (0, 1)
/// - with no x or y at all, a number or a claim to read out
/// - t is always allowed and means "animated": seconds since the start
///
/// The 2D kinds above are the ones ported, with lists, tuples and families
/// (ListPlans.swift). Everything else the site draws (surfaces, curves in
/// space, systems, …) throws `Unsupported`.
public indirect enum MathObject: Equatable, Sendable {
  /// `y = f(x)`: a curve that is a graph.
  case curveGraph(rhs: Expr, equation: Expr, levels: LevelSetSpec?)
  case curveImplicit(residual: Expr, equation: Expr, levels: LevelSetSpec?)
  case region(constraints: [Constraint])
  /// A pair in u and v: the region it fills as both run from 0 to 1 (the
  /// site's region of form `parametric`).
  case regionParametric(coordinates: [Expr])
  case scalarField(expr: Expr)
  case vectorField(components: [Expr])
  case point(coordinates: [Expr])
  /// A pair in u: the curve it traces as u runs from 0 to 1.
  case curveParametric(coordinates: [Expr])
  case value(expr: Expr, shade: IntShade? = nil)
  /// `label(point, "text")`: text anchored at a point.
  case label(coordinates: [Expr], text: String)
  /// A segment, polyline, vector, polygon, square or hull: its vertices,
  /// flat, `dimension` numbers each.
  case figure(form: FigureForm, dimension: Int, vertices: [Expr], over: [Column]?)
  /// A 2×2 matrix over the plane, row-major: drawn as glyphs, or with
  /// `streamlines` along its major eigenvector.
  case tensorField(entries: [Expr], streamlines: Bool)
  /// A tuple of more than 3 values, or a matrix or tensor (`shape`), read
  /// out. `length`: how many values a long tuple has, of which `values` are
  /// the ones shown.
  case tuple(values: [Expr], shape: [Int]?, length: Int?)
  /// A claim with no x or y in it (`2 + 2 = 4`), or an equation whose sides
  /// agree everywhere (`identity`). `constant`: the row reads like a slider
  /// named e, pi or i, which the readout explains.
  case note(expr: Expr, variable: Bool, constant: String?, identity: Bool)
  /// A complex number with no x or y in it: the point it is in the plane of w.
  case complexPoint(expr: Expr)
  /// A complex expression in u alone: the path it traces in the plane of w.
  case complexPath(expr: Expr)
  /// A complex value at every pixel: a potential (its real and imaginary
  /// level curves), `domain(…)` coloring, or the grid `conformal(…)` pulls back.
  case complexField(form: ComplexForm, expr: Expr)
  /// `iter(step)`: z ↦ step(z), counted until it escapes. `seed` is "zero"
  /// when the pixel enters the step (Mandelbrot), "pixel" when it starts it (Julia).
  case fractal(step: Expr, seed: String, maxIter: Int)
  /// `rgb(…)`, `hsl(…)`, `oklch(…)`: a colour at every pixel; `space` is the call's name.
  case colorField(space: String, channels: [Expr])
  /// `a_n = …`: a sequence's terms, drawn at whole n (Sequences.swift).
  case sequence(term: Expr, index: String)
  /// A recurrence `a_{n+1} = f(a_n)`: its cobweb diagram, or (with x free in
  /// f) its orbit diagram over x. `variable` is the previous term's name.
  case cobweb(expr: Expr, variable: String, seedName: String?)
  case bifurcation(expr: Expr, variable: String, seedName: String?)
  /// A cellular automaton (Automaton.swift): `rule` reads the previous
  /// generation's cells within `radius`; `seed` is generation 0 as an
  /// expression in the cells. One dimension draws rows over time, two one
  /// generation of a board. `axes` names the lattice's across and down indices.
  case automaton(rule: Expr, radius: Int, seed: Expr?, dims: Int, axes: [String])
  /// A function on the integer lattice, `T[i, j] = …`.
  case lattice(expr: Expr, axes: [String])
  // In space (Classify3D.swift).
  /// `tube(curve[, radius])`: a curve in space swept as a lit tube.
  case curveTube(coordinates: [Expr], radius: Expr)
  /// An equation in x, y and z: the surface it holds on.
  case surfaceImplicit(residual: Expr, equation: Expr)
  /// A triple in u and v; `paint` a scalar in u and v it is coloured by.
  case surfaceParametric(coordinates: [Expr], paint: Expr?)
  /// `(f, g) = (a, b)` in x, y and z: the curve two surfaces meet in.
  case intersection(residuals: [Expr])
  /// A bare expression in x, y and z, drawn as a translucent cloud.
  case scalarField3D(expr: Expr)
  /// A square system, one residual per unknown: its isolated solutions, or
  /// with u (`parametric`) the curve they trace.
  /// `coordinates` are the coordinates a position names, `(r, theta) = (2, 0.8)`,
  /// as functions of x and y: a drag of its point writes them back.
  case system(residuals: [Expr], parametric: Bool, angular: [Bool], coordinates: [Expr]? = nil)
  /// A complex equation in w, `w^3 = 1`: its roots, the solutions of the
  /// system its real and imaginary parts make in x and y (ComplexRoots.swift).
  case complexSystem(equation: Expr)
  /// A random variable's row the CPU draws (a density curve, a pmf's stems),
  /// or the marker of an `E(…)` row. `mass` multiplies what is drawn.
  case distribution(form: DistributionForm, rv: String, mass: Expr? = nil)
  /// A `P(…)` row with no closed-form region: its event, and the variable whose law it shades.
  case probability(body: Expr, shade: ProbShade?)
  /// Where states go over [from, to], integrated ahead of time (Orbit.swift):
  /// each path a point's coordinates, or with `series` one value drawn against t.
  case orbit(paths: [[Expr]], series: Bool, from: Expr, to: Expr)
  /// `trail(A)`: where a moving point has been (Trail.swift).
  case trail(coordinates: [Expr])
  /// A list of numbers or of points, as expressions (`values`: one per
  /// number, or one row of coordinates per point) or packed (ListPlans.swift).
  case list(ListObject)
  /// `hist(L)`: bars at `centers`, `counts` high and `width` wide.
  case histogram(centers: [Double], counts: [Double], width: Double)
  /// A multiset of `count` tuples, matrices or tensors of one `shape`, their
  /// values back to back: read out, as one is.
  case tuples(values: [Expr], shape: [Int], count: Int)
  /// A multivector's coefficients, by blade, read out as `1 + 2 e_xy` (or in
  /// i, j, k: `quat`); `count` of them back to back for a multiset.
  case blades(values: [Expr], dim: Int, quat: Bool, count: Int?)
  /// The coefficients of a point, line, plane or motor of projective
  /// geometry (PGA.swift), read out as what it is.
  case flat(values: [Expr], dim: Int, grade: Int, count: Int?)
  /// One copy of the row per list element. `shared`: the one program its
  /// members are drawn with, each choosing itself by the uniform `index`.
  case family(members: [Classified], shared: FamilyShared?)
  /// A panel's metric (`ds^2 = …`) and the rows that follow it: geodesics,
  /// light cones, tidal forces (MetricObjects.swift).
  case metric(MetricObject)

  /// The kind as the site's tools name it (`publicKind`).
  public var publicKind: String {
    switch self {
    case .curveGraph, .curveImplicit: "implicit2d"
    case .region: "ineq2d"
    case .regionParametric: "pregion"
    case .scalarField: "scalar2d"
    case .vectorField(let components): components.count == 3 ? "vfield3d" : "vfield2d"
    case .point: "point"
    case .curveParametric, .curveTube: "pcurve"
    case .surfaceImplicit: "implicit3d"
    case .surfaceParametric: "psurface"
    case .intersection: "spacecurve"
    case .scalarField3D: "scalar3d"
    case .system, .complexSystem: "system"
    case .value: "value"
    case .label: "label"
    case .figure: "polygon"
    case .tensorField: "tfield2d"
    case .tuple: "tuple"
    case .note: "note"
    case .complexPoint: "point"
    case .complexPath: "pcurve"
    case .complexField(let form, _): form.planType
    case .fractal: "fractal2d"
    case .colorField(let space, _): "\(space)2d"
    case .sequence: "sequence"
    case .cobweb: "cobweb"
    case .bifurcation: "bifurcation"
    case .automaton: "automaton"
    case .lattice: "lattice"
    case .distribution(let form, _, _): form.rawValue
    case .probability: "prob"
    case .orbit: "orbit"
    case .trail: "trail"
    case .list(let list): list.publicKind
    case .histogram: "histogram"
    case .tuples, .blades, .flat: "tuple"
    case .family: "family"
    case .metric(let object): object.publicKind
    }
  }
}

/// One side of a region: the residual is negative inside it.
public struct Constraint: Equatable, Sendable {
  public var residual: Expr
  public var strict: Bool
}

/// `f(x, y) = c` with c a defined constant: f, whose level sets the plot
/// can draw as a family.
public struct LevelSetSpec: Equatable, Sendable {
  public var name: String
  public var expr: Expr
  public var params: [String]
  public var level: String?
}

public struct Classified: Equatable, Sendable {
  public var object: MathObject
  public var animated: Bool
  public var needs3D: Bool
  public var params: [String]
  /// The value a row of glyphs pictures, read out beside them: a
  /// multivector's blades, a flat, or the matrix of `action(M)`.
  public var readout: MathObject? = nil
  /// A plane of projective geometry, a x + b y + c z + d = 0: an implicit
  /// surface drawn translucent, as a plane.
  public var plane: [Expr]? = nil
}

/// The message for a row that tries to define t, which is animation time.
let tReserved =
  "t is reserved for time (it animates, counting seconds); use another name for a constant, like k = 3, "
  + "and write k where you meant t."

private let spaceVarNames: Set<String> = ["x", "y", "z"]
private let paramVarNames: Set<String> = ["u", "v"]

/// JavaScript's default sort: by UTF-16 code units.
func jsSorted(_ names: [String]) -> [String] {
  names.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
}

private func isVar(_ e: Expr, _ name: String) -> Bool {
  if case .var(name) = e { return true }
  return false
}

private func isVec(_ e: Expr) -> Bool {
  if case .vec = e { return true }
  return false
}

/// Result typing (lib/complex.ts `inferScalarType`), where all that is asked
/// of it is what it refuses.
func checkScalar(_ e: Expr) throws {
  _ = try inferScalarType(e)
}

/// Match an equation that spells an ODE — dy/dx = f, y' = f, or a system
/// (x', y') = (P, Q) — and return its direction field as a tuple (lib/ode.ts).
func matchODE(_ e: Expr) throws -> [Expr]? {
  guard case .eq(let l, let r) = e else { return nil }
  if case .bin(.div, let a, let b, _) = l {
    if isVar(a, "dy") && isVar(b, "dx") { return [.num(1), r] }
    if isVar(a, "dx") && isVar(b, "dy") { return [r, .num(1)] }
  }
  if isVar(l, "y'") { return [.num(1), r] }
  guard case .vec(let items) = l else { return nil }
  if items.count == 3, isVar(items[0], "x'"), isVar(items[1], "y'"), isVar(items[2], "z'") {
    guard case .vec(let velocity) = r, velocity.count == 3 else {
      throw LanguageError("A 3D flow needs three velocity components.")
    }
    return velocity
  }
  if items.count == 2, isVar(items[0], "x'"), isVar(items[1], "y'") {
    guard case .vec(let velocity) = r, velocity.count == 2 else {
      throw LanguageError("A system needs two components on the right: (x', y') = (P, Q).")
    }
    return velocity
  }
  return nil
}

/// A named condition (`within = r < R`, written in with the fields) read as
/// a number — anywhere but a whole row or a piecewise case's condition.
private func conditionAsValue(_ e: Expr, _ fields: [String: Expr], whole: Bool = true) -> String? {
  if case .var(let name) = e {
    if !whole, case .ineq? = fields[name] { return name }
    return nil
  }
  var parts: [Expr]
  if case .piecewise(let cases, let otherwise) = e {
    parts = cases.flatMap { c -> [Expr] in
      if case .var = c.cond { return [c.value] }
      return [c.cond, c.value]
    }
    if let otherwise { parts.append(otherwise) }
  } else {
    parts = childrenOf(e)
  }
  for part in parts {
    if let hit = conditionAsValue(part, fields, whole: false) { return hit }
  }
  return nil
}

/// `f(x,y) = c` (either way around) where c is a defined constant: the
/// level-set family of f, so the plot can draw the whole contour stack.
private func levelFamily(_ l: Expr, _ r: Expr, _ params: [String], _ defined: Set<String>) -> LevelSetSpec? {
  func level(_ s: Expr) -> String? {
    if case .var(let name) = s, params.contains(name) { return name }
    return nil
  }
  let f: Expr
  let name: String?
  if let c = level(r) {
    f = l
    name = c
  } else if level(l) != nil {
    f = r
    // (The level is the left side when that is a name.)
    if case .var(let left) = l { name = left } else { name = nil }
  } else {
    return nil
  }
  let fv = freeVars(f)
  if !fv.contains("x") && !fv.contains("y") { return nil }
  return LevelSetSpec(name: "F", expr: f, params: jsSorted(fv.list.filter(defined.contains)), level: name)
}

/// Whether the two sides of an equation agree at every x, y, z, t and slider
/// value — a numerical check, not a proof: they are compared at seeded
/// random points spread over several scales, where both are defined.
func holdsEverywhere(_ l: Expr, _ r: Expr) -> Bool {
  let names = freeVars(.eq(l, r)).list.filter { $0 != "pi" && $0 != "e" }
  var seed: Int32 = Int32(truncatingIfNeeded: 0x9e37_79b9 as UInt32)
  func random() -> Double {
    seed = seed &+ 0x6d2b_79f5
    let s = UInt32(bitPattern: seed)
    var q = UInt32(bitPattern: Int32(bitPattern: s ^ (s >> 15)) &* Int32(bitPattern: 1 | s))
    q = (q &+ UInt32(bitPattern: Int32(bitPattern: q ^ (q >> 7)) &* Int32(bitPattern: 61 | q))) ^ q
    return Double(q ^ (q >> 14)) / 4294967296
  }
  // Magnitudes from 0.1 to 100, either sign.
  func sample() -> Double {
    let sign: Double = random() < 0.5 ? -1 : 1
    return sign * JS.pow(10, 3 * random() - 1)
  }
  var agreed = 0
  var k = 0
  while k < 64 && agreed < 24 {
    k += 1
    var env: [String: Double] = [:]
    for n in names { env[n] = sample() }
    guard let a = try? evaluate(l, env), let b = try? evaluate(r, env) else { return false }
    if !a.isFinite || !b.isFinite { continue }
    if abs(a - b) > 1e-9 * (1 + abs(a) + abs(b)) { return false }
    agreed += 1
  }
  return agreed >= 24
}

/// Classify a lowered row (`classifyLowered`). `defined` are the names with
/// a value each frame; `fields` the coordinate fields and named conditions,
/// written into the row here.
func classify(_ lowered: Expr, defined: Set<String>, fields: [String: Expr]) throws -> Classified {
  var expr = lowered
  if case .call(STREAMLINES_CALL, let args) = lowered, let inner = args.first {
    return try streamlined(try classify(inner, defined: defined, fields: fields))
  }
  // gaussian(S) alone on a row: the surface S, coloured by its curvature.
  if case .call(PAINT_CALL, let args) = expr { return try paintedSurface(args, defined: defined, fields: fields) }
  if case .family(let members) = expr { return try classifyFamily(members, defined: defined, fields: fields) }
  if fields.values.contains(where: { if case .ineq = $0 { true } else { false } }),
    let misread = conditionAsValue(expr, fields)
  {
    throw LanguageError(conditionAsNumber(misread))
  }
  // A row naming coordinates in a tuple on the left: a position
  // `(r, theta) = (2, pi/4)`, or a flow `(r', theta') = (F, G)`, which
  // lowers to the Cartesian one (Coordinate.swift).
  let coordinate = try coordinateRow(expr, fields)
  expr = try lowerCoordinateFlow(expr, fields)
  let ode = try matchODE(expr)
  if let ode { expr = .vec(ode) }
  if let nested = nestedFigure(expr) { throw LanguageError("\(nested)(…) must be the whole expression.") }
  let tube = try matchTube(expr)
  if let tube { expr = tube.inner }
  if let surface = try matchRevolve(expr) { expr = surface }

  let special = specialForm(expr)
  if let nested = nestedSpecial(expr, isRoot: true) {
    throw LanguageError("\(nested)(…) must be the whole expression.")
  }
  var vars = freeVars(expr)
  vars.remove("i")
  // iter binds z as the iterate: z ↦ step(z) starting from the seed.
  if special == "iter" { vars.remove("z") }
  if vars.remove("w") {
    vars.insert("x")
    vars.insert("y")
  }
  if let tube { try checkTubeRadius(tube.radius, &vars) }
  var params: [String] = []
  for v in vars.list where defined.contains(v) {
    params.append(v)
    vars.remove(v)
  }
  params = jsSorted(params)
  for v in vars where !spaceVarNames.contains(v) && !paramVarNames.contains(v) && v != "t" {
    if v.hasSuffix("'") { throw LanguageError("\(v) can only appear on the left of an ODE like y' = x - y.") }
    let u = Array(v.utf16)
    if v == "d" || (u.count == 2 && u[0] == unit("d") && isASCIILetter(u[1])) {
      throw LanguageError("Write derivatives as d/dx (…).")
    }
    if let fn = builtinFn(v) {
      throw LanguageError("\(v) is a function — write it with parentheses, e.g. \(fn)(x).")
    }
    throw LanguageError("Unknown variable: \(v). Define \"\(v) = 1\" to make a slider.")
  }
  let animated = vars.contains("t")
  let hasParam = vars.contains("u") || vars.contains("v")
  let hasSpace = vars.contains("x") || vars.contains("y") || vars.contains("z")
  var paramSystem = false
  if case .eq(.vec, _) = expr { paramSystem = vars.contains("u") && !vars.contains("v") }
  if hasParam && hasSpace && !paramSystem { throw LanguageError("Cannot mix u/v with x/y/z.") }
  // A bare complex expression in u alone is a path in the plane (below);
  // every other complex use of u, v, or z has no 2D reading.
  let complexRow = usesComplex(expr)
  let complexPath = complexRow && isBareScalar(expr) && special == nil && vars.contains("u") && !vars.contains("v")
  // (Vectors, lists, and domain(…)-style forms each say below what they take.)
  if complexRow && hasParam && !complexPath && special == nil && !isVec(expr) && !isListNode(expr) {
    throw LanguageError("A complex path is a bare expression in u alone, like exp(i 2 pi u).")
  }
  if complexRow && vars.contains("z") { throw LanguageError("Complex expressions plot in 2D only (x, y, w).") }

  func done(_ object: MathObject) -> Classified {
    var moving = animated
    if case .vectorField(let components) = object, components.count == 2 { moving = true }
    return Classified(object: object, animated: moving, needs3D: objectNeeds3D(object), params: params)
  }

  // A multivector, a flat or action(M) on a row of its own (AlgebraPlans.swift).
  if let algebra = try classifyAlgebra(
    expr, hasSpace: hasSpace, hasParam: hasParam, done: done,
    family: { try classify(.family(members: $0), defined: defined, fields: fields) })
  {
    return algebra
  }
  // A matrix or tensor on a row of its own, or a multiset of them.
  if let tensors = try classifyTensors(expr, hasSpace: hasSpace, hasParam: hasParam) { return done(tensors) }
  if let tensor = try classifyTensor(expr, hasSpace: hasSpace, hasParam: hasParam, hasZ: vars.contains("z")) {
    return done(tensor)
  }

  // `t = 3` reads like a constant, but t is time: the row would be a silent
  // claim about the clock. Say so instead of drawing nothing.
  if case .eq(.var("t"), let r) = expr, !freeVars(r).contains("t"), !hasSpace, !hasParam {
    throw LanguageError(tReserved)
  }
  var sides: (l: Expr, r: Expr)?
  switch expr {
  case .eq(let l, let r), .ineq(_, let l, let r, _): sides = (l, r)
  default: break
  }
  if let sides, !isVec(sides.l), !isVec(sides.r), !hasSpace, !hasParam {
    return done(.note(expr: expr, variable: animated || !params.isEmpty, constant: nil, identity: false))
  }
  // An equation whose sides agree everywhere has no curve to draw — it is a
  // claim, and it holds.
  if case .eq(let l, let r) = expr, !isVec(l), !isVec(r), hasSpace, !hasParam, !complexRow, holdsEverywhere(l, r) {
    return done(.note(expr: expr, variable: false, constant: nil, identity: true))
  }

  if case .trail(let coordinates) = expr {
    return done(try classifyTrail(coordinates, off: hasSpace || hasParam || complexRow))
  }

  if let figure = try classifyFigure(expr, hasSpace: hasSpace, hasParam: hasParam, complex: complexRow) {
    var classified = done(figure.object)
    classified.needs3D = figure.needs3D
    return classified
  }

  // Lists, histograms and scatters of columns (ListPlans.swift).
  if let object = try classifyList(expr, vars) { return done(object) }

  if let special, case .call(_, let args) = expr {
    return done(try classifySpecial(special, args, vars))
  }

  if case .vec(let items) = expr {
    // sort(S, re(S)) of a complex list: its members in order, a tuple.
    if items.allSatisfy(isComplexValued) {
      throw LanguageError(
        "A tuple of complex numbers has no picture yet — a list of them draws as points, and T[k] picks one.")
    }
    if complexRow { throw LanguageError("Complex values are not supported in vectors.") }
    // Longer than a point: values at positions, shown as a readout.
    if items.count > 3 {
      if hasSpace || hasParam || items.contains(where: isVec) {
        throw LanguageError(
          "A tuple of more than 3 values is a value to read, not a picture: (1, 2, 3, 5, 8).")
      }
      return done(classifyTuple(items))
    }
    if hasSpace || ode != nil {
      if hasParam { throw LanguageError("Vector fields cannot use u or v.") }
      if items.count == 3 { return done(.vectorField(components: items)) }
      if vars.contains("z") { throw LanguageError("A field using z needs three components.") }
      return done(.vectorField(components: items))
    }
    if vars.contains("v") && !vars.contains("u") { throw LanguageError("Parametric surfaces use u (and v).") }
    if vars.contains("u") && vars.contains("v") {
      // Two parameters in the plane fill the region they trace.
      if items.count == 2 { return done(.regionParametric(coordinates: items)) }
      return done(.surfaceParametric(coordinates: items, paint: nil))
    }
    if vars.contains("u") {
      if let tube { return done(.curveTube(coordinates: items, radius: tube.radius)) }
      return done(.curveParametric(coordinates: items))
    }
    if tube != nil { throw LanguageError("tube(…) needs a curve in u, like tube((cos(u), sin(u), u/4)).") }
    return done(.point(coordinates: items))
  }

  // A complex-valued expression in u is the image of a path: its real and
  // imaginary parts are an ordinary 2D parametric curve in the Argand plane
  // (the plane of w = x + iy, where complex points and roots already sit).
  if complexPath { return done(try classifyComplexPath(expr)) }
  if hasParam && !paramSystem {
    throw LanguageError(
      "u and v trace a curve or surface in a tuple, like (cos(u), sin(u)) or (u, v, u v); "
        + "to set the range one runs over, define it as an interval: u = interval(0, 2pi)."
    )
  }

  // A vector equation is a system, one residual per component.
  if case .eq(let l, let r) = expr, isVec(l) || isVec(r) {
    guard case .vec(let left) = l, case .vec(let right) = r else {
      throw LanguageError("A vector equation needs components on both sides, like (f, g) = (0, 0).")
    }
    if left.count != right.count {
      throw LanguageError("Mismatched components: \(left.count) on the left, \(right.count) on the right.")
    }
    if complexRow { throw LanguageError("Complex values are not supported in systems.") }
    return done(
      try classifySystem(
        left, right, vars: vars, hasParam: hasParam, parametric: paramSystem, coordinate: coordinate, fields: fields))
  }

  if case .ineq = expr {
    if vars.contains("z") { throw LanguageError("Inequalities are 2D only.") }
    let comparisons = ineqComparisons(expr)
    if Set(comparisons.map { $0.op == .lt || $0.op == .le }).count > 1 {
      throw LanguageError("Chained inequalities must point the same way.")
    }
    var constraints: [Constraint] = []
    for c in comparisons {
      let less = c.op == .lt || c.op == .le
      let residual = Expr.bin(.sub, less ? c.l : c.r, less ? c.r : c.l)
      if try inferScalarType(residual) == .complex {
        throw LanguageError("Complex inequality: compare re(…) or im(…) instead.")
      }
      constraints.append(Constraint(residual: residual, strict: c.op == .lt || c.op == .gt))
    }
    return done(.region(constraints: constraints))
  }

  if case .eq(let l, let r) = expr {
    let left = try inferScalarType(l)
    if try left == .complex || inferScalarType(r) == .complex {
      if !hasSpace {
        throw LanguageError("A constant complex comparison has no isolated roots — use w as the unknown.")
      }
      return done(.complexSystem(equation: expr))
    }
    if vars.contains("z") { return done(.surfaceImplicit(residual: .bin(.sub, l, r), equation: expr)) }
    let graphRhs: Expr? = isVar(l, "y") ? r : isVar(r, "y") ? l : nil
    let levels = levelFamily(l, r, params, defined)
    if let graphRhs, !freeVars(graphRhs).contains("y"), !freeVars(graphRhs).contains("w") {
      return done(.curveGraph(rhs: graphRhs, equation: expr, levels: levels))
    }
    return done(.curveImplicit(residual: .bin(.sub, l, r), equation: expr, levels: levels))
  }

  // A bare scalar that depends on the screen's x and y is drawn at every
  // pixel. There is no implicit graph: the curve is `y = sin(x)`.
  // Bare scalar expression: typing does not generate shader text.
  if try inferScalarType(expr) == .complex {
    if !hasSpace && !hasParam { return done(.complexPoint(expr: expr)) }
    return done(.complexField(form: .potential, expr: expr))
  }
  if vars.contains("z") { return done(.scalarField3D(expr: expr)) }
  if hasSpace { return done(.scalarField(expr: expr)) }
  return done(.value(expr: expr))
}
