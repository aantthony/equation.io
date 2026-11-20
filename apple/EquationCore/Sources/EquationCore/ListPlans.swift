/// What a row of lists is and how it is planned (lib/plot.ts `classifyRow`
/// and `classifyLowered`, lib/compiler.ts, lib/plot.ts `plotReadout`, for the
/// list kinds): lists of numbers and of points, scatters of packed columns,
/// histograms, tuples that only read out, and families.

/// A list as a row draws it (lib/math-object.ts, the `list` objects).
public enum ListObject: Equatable, Sendable {
  /// Numbers, one expression each: a dot plot on the number line.
  case scalars([Expr])
  /// Numbers held as one array.
  case packed([Double])
  /// Points, one row of coordinates each.
  case points(dimension: Int, values: [[Expr]])
  /// Complex numbers, drawn on the Argand plane as one complex value is:
  /// each member at (re, im).
  case complex([Expr])
  /// Points as whole columns, one array per coordinate.
  case scatter(dimension: Int, coordinates: [[Double]])

  var publicKind: String {
    switch self {
    case .scalars: "vlist"
    case .packed: "dlist"
    case .points, .complex: "plist"
    case .scatter: "dscatter"
    }
  }
}

/// The program a family's members share (lib/math-object.ts `shared`).
public struct FamilyShared: Equatable, Sendable {
  public var classified: Classified
  public var index: String
}

/// A family member's plan, with what it is.
public struct FamilyMember: Equatable, Sendable {
  public var classified: Classified
  public var cpu: CpuPlan
}

/// Nodes across every member of a figure family (lib/size.ts `FAMILY_NODES`).
private let FAMILY_NODES = 1 << 21

/// Lower and classify a resolved row's value (lib/plot.ts `classifyRow`): a
/// tuple of numbers is shown as what it is, and everything else is
/// classified as lowered.
func classifyRow(_ low: Low, defined: Set<String>, fields: [String: Expr]) throws -> Classified {
  // A long tuple of packed numbers — a sorted column — keeps only what its
  // readout shows, rather than a node per value.
  if let packed = packedTuple(low) {
    let values = packed.prefix(TUPLE_SHOWN).map { Expr.num($0) }
    return Classified(
      object: .tuple(values: values, shape: nil, length: packed.count), animated: false, needs3D: false,
      params: [])
  }
  // A multiset of longer tuples reads out, as a multiset of matrices does.
  if let tuples = tupleMultiset(low),
    !tuples.values.contains(where: { freeVars($0).contains(where: ["x", "y", "z", "u", "v", "t"].contains) })
  {
    return Classified(
      object: .tuples(values: tuples.values, shape: [tuples.width], count: tuples.count), animated: false,
      needs3D: false, params: [])
  }
  return try classify(try tupleRow(low), defined: defined, fields: fields)
}

/// A multiset of matrices or tensors on a row of its own: it has no
/// position, so it is drawn as its values, a readout (lib/plot.ts
/// `classifyLowered`, the tensors of a list). Nil for any other row.
func classifyTensors(_ expr: Expr, hasSpace: Bool, hasParam: Bool) throws -> MathObject? {
  guard case .list(let items) = expr, !items.isEmpty else { return nil }
  let tensors = items.compactMap(tensorOfNode)
  guard tensors.count == items.count else { return nil }
  if hasSpace || hasParam {
    throw LanguageError(
      "Only a 2×2 matrix in x and y draws as a field; a larger one has no picture yet — "
        + "apply it to a vector, like M (x, y, z).")
  }
  return .tuples(values: tensors.flatMap(\.data), shape: tensors[0].shape, count: tensors.count)
}

/// What a lowered list is (lib/plot.ts `classifyLowered`, from "Typed-array
/// lists" to the list of points), or nil for anything that is not one.
/// `vars`: the row's free variables that are not constants.
func classifyList(_ expr: Expr, _ vars: NameSet) throws -> MathObject? {
  switch expr {
  case .text, .str:
    throw LanguageError(
      "Text cannot be plotted — compare it inside a filter, like people[people.city == \"NYC\"].")
  case .hist(let centers, let counts, let width):
    return .histogram(centers: centers, counts: counts, width: width)
  case .data(let values):
    return .list(.packed(values))
  case .vec(let items) where items.contains(where: { if case .data = $0 { true } else { false } }):
    var n = 0
    for it in items {
      if case .data(let values) = it {
        n = values.count
        break
      }
    }
    if items.count != 2 && items.count != 3 { throw LanguageError("Expected 2 or 3 vector components.") }
    // A scalar coordinate rides along as a constant column: (col, 0) is a
    // row of points on the axis.
    let coords = try items.map { it -> [Double] in
      switch it {
      case .data(let values): return values
      case .num(let value): return [Double](repeating: value, count: n)
      default: throw LanguageError("A point mixing data with an expression is not supported yet.")
      }
    }
    if items.count == 3 { throw Unsupported("points in space") }
    return .list(.scatter(dimension: items.count, coordinates: coords))
  case .list(let items):
    for v in vars where v != "t" {
      throw LanguageError("A list may only use constants and t (found \(v)).")
    }
    let vecs = items.compactMap { it -> [Expr]? in if case .vec(let comps) = it { comps } else { nil } }
    // One complex member makes the list complex, as one complex term makes a
    // sum complex. Members that only pass through complex values are real.
    if items.contains(where: { it in if case .vec = it { false } else { isComplexValued(it) } }) {
      if !vecs.isEmpty { throw LanguageError("Lists cannot mix complex numbers and points.") }
      return .list(.complex(items))
    }
    // A point's coordinates are real, in a list as on a row of its own.
    if vecs.contains(where: { $0.contains(where: isComplexValued) }) {
      throw LanguageError("Complex values are not supported in vectors.")
    }
    if vecs.isEmpty { return .list(.scalars(items)) }
    if vecs.count != items.count { throw LanguageError("Lists cannot mix numbers and points.") }
    if Set(vecs.map(\.count)).count > 1 {
      throw LanguageError("All points in a list need the same number of coordinates.")
    }
    if vecs[0].count == 3 { throw Unsupported("points in space") }
    return .list(.points(dimension: vecs[0].count, values: vecs))
  default:
    return nil
  }
}

/// Merge scalar differences into one uniform-selected expression. Structural
/// nodes (equations, vectors and calls) retain their shape (lib/plot.ts
/// `familyTemplate`).
private func familyTemplate(_ es: [Expr], _ index: String) throws -> Expr {
  let first = es[0]
  let key = exprKey(first)
  if es.allSatisfy({ exprKey($0) == key }) { return first }
  switch first {
  case .eq:
    let sides = es.compactMap { e -> (Expr, Expr)? in if case .eq(let l, let r) = e { (l, r) } else { nil } }
    if sides.count == es.count {
      return .eq(try familyTemplate(sides.map(\.0), index), try familyTemplate(sides.map(\.1), index))
    }
  case .ineq(let op, _, _, let grouped):
    let sides = es.compactMap { e -> (Expr, Expr)? in
      if case .ineq(op, let l, let r, _) = e { (l, r) } else { nil }
    }
    if sides.count == es.count {
      return .ineq(
        op, try familyTemplate(sides.map(\.0), index), try familyTemplate(sides.map(\.1), index),
        grouped: grouped)
    }
  case .vec(let items):
    let all = es.compactMap { e -> [Expr]? in
      if case .vec(let own) = e, own.count == items.count { own } else { nil }
    }
    if all.count == es.count {
      return .vec(try items.indices.map { k in try familyTemplate(all.map { $0[k] }, index) })
    }
  case .call(let name, let args):
    let all = es.compactMap { e -> [Expr]? in
      if case .call(name, let own) = e, own.count == args.count { own } else { nil }
    }
    if all.count == es.count {
      return .call(name, try args.indices.map { k in try familyTemplate(all.map { $0[k] }, index) })
    }
  case .bin(let op, _, _, let glyph):
    let sides = es.compactMap { e -> (Expr, Expr)? in
      if case .bin(op, let a, let b, _) = e { (a, b) } else { nil }
    }
    if sides.count == es.count {
      return .bin(
        op, try familyTemplate(sides.map(\.0), index), try familyTemplate(sides.map(\.1), index), glyph: glyph)
    }
  default:
    break
  }
  let shaped = es.contains { e in
    switch e {
    case .eq, .ineq, .vec: true
    default: false
    }
  }
  if shaped { throw LanguageError("Family members need matching object shapes.") }
  return .piecewise(
    es.dropLast().enumerated().map { k, value in
      Expr.Case(cond: .ineq(.lt, .var(index), .num(Double(k) + 0.5)), value: value)
    }, otherwise: es[es.count - 1])
}

/// A family: one member per list element, each classified as its own row
/// (lib/plot.ts `classifyLowered`, the family case).
func classifyFamily(_ members: [Expr], defined: Set<String>, fields: [String: Expr]) throws -> Classified {
  // Figures are CPU-drawn from a few numbers each; everything else is a draw
  // call (or a shader pass) per member.
  let figures = members.allSatisfy { if case .figure = $0 { true } else { false } }
  let limit = figures ? FIGURE_FAMILY_MAX : FAMILY_MAX
  if members.isEmpty || members.count > limit {
    throw LanguageError("An object family needs 1–\(limit) members.")
  }
  let tooLarge =
    figures
    ? exceedsNodes(.family(members: members), FAMILY_NODES) : members.contains { exceedsNodes($0, 8192) }
  if tooLarge {
    throw LanguageError(
      figures
        ? "This object family is too large to render (\(FAMILY_NODES) nodes in all) — draw fewer members."
        : "A family element is too large to render (8192 nodes).")
  }
  var classified: [Classified] = []
  for (i, e) in members.enumerated() {
    do {
      classified.append(try classify(e, defined: defined, fields: fields))
    } catch let error as Unsupported {
      throw error
    } catch {
      throw LanguageError("Family element \(i + 1): \(errorMessage(error))")
    }
  }
  let first = classified[0].object.publicKind
  if first == "scalar2d" {
    throw LanguageError(
      "A family of scalar fields cannot be drawn — for curves write y = …, or pick one member, like L[k].")
  }
  if first == "solid" {
    throw LanguageError("A list of solids cannot be drawn yet — write each solid on a row of its own.")
  }
  if first == "scalar3d" {
    throw LanguageError(
      "A family of fields in space cannot be drawn — for nested level surfaces write f(x, y, z) = [1..5], "
        + "or pick one member, like L[k].")
  }
  let alone: Set<String> = [
    "family", "rgb2d", "hsl2d", "oklch2d", "domain2d", "complex2d", "conformal2d", "fractal2d", "density", "pmf",
    "prob", "expect", "trail", "label",
  ]
  if alone.contains(first) {
    throw LanguageError(
      "Families of \(first) do not superimpose meaningfully — select a list element L[k] instead.")
  }
  if let odd = classified.firstIndex(where: {
    $0.object.publicKind != first || $0.needs3D != classified[0].needs3D
  }) {
    // `y = [1, i] x`: a complex member is a complex equation, solved for
    // points, where the real ones draw curves.
    if usesComplex(members[odd]) != usesComplex(members[0]) {
      let complex = usesComplex(members[0]) ? 0 : odd
      let real = complex == 0 ? odd : 0
      throw LanguageError(
        "Family element \(complex + 1) is complex where element \(real + 1) is not, so it draws a different "
          + "kind of object — a list of complex numbers draws as points on a row of its own.")
    }
    throw LanguageError("Family element \(odd + 1) has a different object kind or dimension.")
  }
  // An implicit surface is raymarched across the whole screen, once per
  // member, and a curve of intersection or a field in space is traced per
  // member, so their families stay small.
  if first == "implicit3d" && classified.count > 8 {
    throw LanguageError(
      "A family of implicit surfaces has at most 8 members — each is raymarched across the screen.")
  }
  if (first == "spacecurve" || first == "vfield3d") && classified.count > 8 {
    throw LanguageError(
      "A family of \(first == "spacecurve" ? "curves of intersection" : "fields in space") has at most 8 "
        + "members — each is traced on its own.")
  }
  var shared: FamilyShared?
  if ["implicit2d", "ineq2d", "implicit3d", "psurface", "vfield2d"].contains(first) {
    var index = "eqioFamilyIndex"
    while defined.contains(index) || members.contains(where: { freeVars($0).contains(index) }) { index += "X" }
    // Members already describe the post-field math; source merging here
    // retains the same desugaring pass before GPU compilation.
    let merged = try familyTemplate(members, index)
    if exceedsNodes(merged, 32768) {
      throw LanguageError("The shared family program is too large (32768 nodes).")
    }
    shared = FamilyShared(
      classified: try classify(merged, defined: defined.union([index]), fields: fields), index: index)
  }
  var params: [String] = []
  for p in classified.flatMap(\.params) where !params.contains(p) { params.append(p) }
  return Classified(
    object: .family(members: classified, shared: shared), animated: classified.contains(where: \.animated),
    needs3D: classified.contains(where: \.needs3D), params: params)
}

// MARK: - Plans (lib/compiler.ts)

/// A complex list's members split into real and imaginary parts
/// (lib/compiler.ts `complexMembers`): a member with no slider or t in it
/// is two numbers, however long its split is spelled.
private func complexMembers(_ values: [Expr]) throws -> [[Expr]] {
  var left = FAMILY_NODES
  return try values.map { value in
    let split = try splitWithin(value, "list member", "evaluate")
    let parts = try [split.re, split.im].map { part in
      freeVars(part).isEmpty ? Expr.num(try evaluate(part, [:])) : part
    }
    left -= countNodes(parts[0]) + countNodes(parts[1])
    if left < 0 {
      throw LanguageError(
        "This complex list is too large to draw (\(FAMILY_NODES) nodes in all, once split into real and "
          + "imaginary parts) — draw fewer members.")
    }
    return parts
  }
}

func compileListCpu(_ object: MathObject) throws -> CpuPlan {
  switch object {
  case .list(.scalars(let values)): return .vlist(values: try values.map(real))
  case .list(.packed(let values)): return .dlist(values: values)
  case .list(.complex(let values)): return .plist(dim: 2, pts: try complexMembers(values))
  case .list(.points(let dimension, let values)):
    return .plist(dim: dimension, pts: try values.map { try $0.map(real) })
  case .list(.scatter(let dimension, let coordinates)): return .dscatter(dim: dimension, coords: coordinates)
  case .histogram(let centers, let counts, let width):
    return .histogram(centers: centers, counts: counts, width: width)
  case .tuples(let values, let shape, let count):
    return .tuples(values: try values.map(real), shape: shape, count: count)
  case .family(let members, _):
    return .family(members: try members.map { FamilyMember(classified: $0, cpu: try compileCpu($0)) })
  default:
    preconditionFailure("not a list object")
  }
}

/// A family on the GPU: the one program its members share, each with its own
/// value of the index uniform, or a plan per member.
func compileFamilyGpu(_ members: [Classified], _ shared: FamilyShared?, params: [String]) throws -> GpuPlan {
  if let shared {
    let plan = try compileGpu(shared.classified)
    let each = members.indices.map { k -> GpuPlan in
      var member = plan
      member.uniforms = [shared.index: Double(k)]
      return member
    }
    return GpuPlan(params: params, shader: .family(members: each))
  }
  return GpuPlan(params: params, shader: .family(members: try members.map(compileGpu)))
}

// MARK: - Readouts (lib/plot.ts plotReadout)

/// A readout without its `=` or `≈`.
private func bare(_ readout: String) -> String {
  readout.hasPrefix("= ") || readout.hasPrefix("≈ ") ? String(readout.dropFirst(2)) : readout
}

/// The readout of a list of numbers, a tuple, or a family of readouts.
func listReadout(_ plan: CpuPlan, _ env: [String: Double]) throws -> String? {
  switch plan {
  case .tuples(let all, let shape, let count):
    // A multiset of tuples or tensors is listed like one of numbers.
    let each = shape.reduce(1, *)
    let shown = min(count, 8)
    let values = try all.prefix(shown * each).map { valueReadout(try evaluate($0, env)) }
    let prefix = values.contains { $0.hasPrefix("≈") } ? "≈" : "="
    let plain = values.map(bare)
    let parts = (0..<shown).map { k in nestedText(shape, Array(plain[(k * each)..<((k + 1) * each)])) }
    return "\(prefix) [\(parts.joined(separator: ", "))\(count > shown ? ", …" : "")]"
  case .vlist(let all):
    let values = try all.prefix(8).map { valueReadout(try evaluate($0, env)) }
    let prefix = values.contains { $0.hasPrefix("≈") } ? "≈" : "="
    return "\(prefix) [\(values.map(bare).joined(separator: ", "))\(all.count > 8 ? ", …" : "")]"
  case .family(let members):
    // `i = [0..9]`: claims about a taken name explain it once, not per member.
    var taken: String?
    if case .note(_, _, let constant, _)? = members.first?.cpu { taken = constant }
    var parts: [String] = []
    for m in members {
      var cpu = m.cpu
      if taken != nil, case .note(let expr, let variable, _, let identity) = cpu {
        cpu = .note(expr: expr, variable: variable, constant: nil, identity: identity)
      }
      guard let part = try plotReadout(cpu, env) else { return nil }
      parts.append(part)
    }
    let list = "[\(parts.prefix(8).joined(separator: "; "))\(parts.count > 8 ? "; …" : "")]"
    if let taken, parts.contains(where: { $0.hasPrefix("Never true") || $0.hasPrefix("False now") }) {
      return "\(list) — \(takenNameHint(taken))"
    }
    return list
  default:
    return nil
  }
}

/// A list of numbers drawn as its values (lib/plot.ts `dotPlot`): a dot plot
/// on the number line. Each value sits at x = value and its copies stack
/// upward, the j-th at y = j, so a column's height is the value's
/// multiplicity. With `width` > 0, values are first gathered into columns
/// that wide.
public func dotPlot(_ values: [Double], width: Double = 0) -> (xs: [Double], ys: [Double]) {
  var xs: [Double] = []
  var ys: [Double] = []
  var heights: [Double: Double] = [:]
  for v in values where v.isFinite {
    let x = width > 0 ? ((v / width).rounded(.down) + 0.5) * width : v
    let j = (heights[x] ?? 0) + 1
    heights[x] = j
    xs.append(x)
    ys.append(j)
  }
  return (xs, ys)
}
