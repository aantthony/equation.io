/// What a multivector, a flat or `action(M)` is on a row of its own, how it
/// is planned and how it reads out (lib/plot.ts `classifyLowered` and
/// `plotReadout`, lib/compiler.ts, for these kinds): glyphs — ordinary
/// figures, a family of them — with the value they picture read out beside.

extension Classified {
  /// The row's kind as the site's tools name it (lib/math-object.ts
  /// `publicKind`): one multivector or matrix drawn as several glyphs is not
  /// a list.
  var rowKind: String {
    switch readout {
    case nil: solid != nil ? "solid" : object.publicKind
    case .flat: "flat"
    case .blades: "multivector"
    default: "action"
    }
  }
}

/// Glyphs drawn with the value they picture read out beside them (lib/plot.ts
/// `withReadout`). The row animates and follows sliders by its value, not
/// only by the parts drawn: the scalar part of cos(t) + e_xyz has no glyph
/// but still changes.
private func withReadout(_ drawn: Classified, _ readout: Classified) -> Classified {
  var out = drawn
  out.animated = drawn.animated || readout.animated
  var params = drawn.params
  for p in readout.params where !params.contains(p) { params.append(p) }
  out.params = jsSorted(params)
  out.readout = readout.object
  return out
}

/// A multivector, a point, line or plane, or `action(M)` on a row of its own,
/// or a multiset of them; nil for any other row. `done` makes a row of an
/// object, and `family` classifies the figures that draw it.
func classifyAlgebra(
  _ expr: Expr, hasSpace: Bool, hasParam: Bool, done: (MathObject) -> Classified,
  family: ([Expr]) throws -> Classified
) throws -> Classified? {
  var listed: [Expr]?
  if case .list(let items) = expr { listed = items }

  // action(M): what the matrix does to the unit square, circle and axes,
  // drawn, with the matrix read out; over a multiset of matrices, each one's
  // picture in one figure family, and each matrix read out.
  let acting = listed.map { $0.map(actionOfNode) } ?? [actionOfNode(expr)]
  if acting.contains(where: { $0 != nil }) {
    let ms = acting.compactMap { $0 }
    if ms.count != acting.count {
      throw LanguageError("action draws matrices only — every element must be one.")
    }
    let n = ms[0].count
    if ms.contains(where: { $0.count != n }) {
      throw LanguageError("action draws a multiset of one size — all 2×2 or all 3×3, not both.")
    }
    if hasSpace || hasParam {
      throw LanguageError("action takes a constant matrix — sliders and t are fine, x, y, u and v are not.")
    }
    let values = ms.flatMap { $0.flatMap { $0 } }
    let readout = done(
      listed == nil
        ? .tuple(values: values, shape: [n, n], length: nil)
        : .tuples(values: values, shape: [n, n], count: ms.count))
    let glyphs = ms.map(actionGlyphs)
    if glyphs.reduce(0, { $0 + $1.count }) > FIGURE_FAMILY_MAX {
      let most = FIGURE_FAMILY_MAX / glyphs[0].count
      throw LanguageError("action draws at most \(most) \(n)×\(n) matrices at once (got \(ms.count)).")
    }
    return withReadout(try family(glyphs.flatMap { $0 }), readout)
  }

  let items = listed.flatMap { $0.isEmpty ? nil : $0 } ?? [expr]

  // A multivector on a row of its own draws grade by grade, and reads out its
  // value (docs/clifford.md); a multiset of them draws and reads out each.
  let mvs = items.compactMap(mvOfNode)
  if mvs.count == items.count {
    if hasSpace || hasParam {
      throw LanguageError(
        "A multivector in x, y, z, u or v has no picture yet — take a part of it, like grade(A, 1), "
          + "to draw a field or a curve.")
    }
    let dim = mvs.contains(where: { $0.dim == 3 }) ? 3 : 2
    let quat = mvs.allSatisfy(\.quat)
    // A plane member lifts into space unchanged: its blades keep their bitmasks.
    let lifted = mvs.map { m in
      Multivector(dim: dim, data: (0..<(1 << dim)).map { $0 < m.data.count ? m.data[$0] : .num(0) }, quat: m.quat)
    }
    let readout = done(
      .blades(values: lifted.flatMap(\.data), dim: dim, quat: quat, count: listed == nil ? nil : mvs.count))
    // Each member draws as it would on a row of its own, over one another.
    // A quaternion that is only a number (i i = -1) has nothing to draw.
    let glyphs = lifted.flatMap(multivectorGlyphs)
    if glyphs.isEmpty { return readout }
    return withReadout(try family(glyphs), readout)
  }

  // A point, line or plane of projective geometry draws as the set of points
  // it is, and reads out what it is (docs/pga.md); a multiset of them draws
  // each.
  let flats = items.compactMap(flatOfNode)
  if flats.count == items.count {
    if hasSpace || hasParam {
      throw LanguageError(
        "A point, line or plane in x, y, z, u or v has no picture — build it from points, sliders and t.")
    }
    let (dim, grade) = (flats[0].dim, flats[0].grade)
    if flats.contains(where: { $0.dim != dim || $0.grade != grade }) {
      throw LanguageError("A multiset mixes points, lines or planes — give each kind a row of its own.")
    }
    let readout = done(
      .flat(
        // A motor reads out as one element of the algebra, its slide in it.
        values: try flats.flatMap { try motorOf($0).data }, dim: dim, grade: grade,
        count: listed == nil ? nil : flats.count))
    var drawn = try family(try flats.map(flatFigure))
    // A plane of space is drawn translucent, as a plane (Renderer3D.swift).
    if dim == 3, grade == 1, case .family(var members, _) = drawn.object, members.count == flats.count {
      for k in members.indices {
        guard case .surfaceImplicit = members[k].object else { continue }
        let (normal, offset) = hyperplaneParts(flats[k])
        members[k].plane = normal + [offset]
      }
      // Each compiles on its own: the shared template would drop the plane.
      drawn.object = .family(members: members, shared: nil)
    }
    return withReadout(drawn, readout)
  }
  return nil
}

/// The plan of the value a row of glyphs reads out, or nil for a row that
/// has none (lib/compiler.ts, a family's `readout`).
func compileReadout(_ classified: Classified) throws -> CpuPlan? {
  guard let readout = classified.readout else { return nil }
  return try compileCpu(
    Classified(object: readout, animated: classified.animated, needs3D: false, params: classified.params))
}

/// A plane of projective geometry on the GPU: its coefficients beside the
/// surface's field (lib/compiler.ts `compileGpu`, an implicit surface's `plane`).
func compilePlane(_ plan: GpuPlan, _ classified: Classified) throws -> GpuPlan {
  guard let plane = classified.plane else { return plan }
  let sub = uniformSub(classified.params)
  var out = plan
  out.plane = try plane.map { try typedGLSL(sub($0)).code }
  return out
}

/// A readout without its `=` or `≈`, noting which it had.
private func bare(_ value: Double, _ approx: inout Bool) -> String {
  let r = valueReadout(value)
  if r.hasPrefix("≈") { approx = true }
  return r.hasPrefix("= ") || r.hasPrefix("≈ ") ? String(r.dropFirst(2)) : r
}

/// A multivector reads as its blades, a multiset of them as a list; a point,
/// line or plane reads as what it is, a multiset of them as a list
/// (lib/plot.ts `plotReadout`, a tuple with `blades` or `flat`).
func algebraReadout(_ plan: CpuPlan, _ env: [String: Double]) throws -> String? {
  var approx = false
  switch plan {
  case .blades(let all, let dim, let quat, let count):
    let each = 1 << dim
    let shown = min(count ?? 1, 8)
    let parts = try (0..<shown).map { k in
      let values = try all[(k * each)..<((k + 1) * each)].map { try evaluate($0, env) }
      return mvText(dim: dim, quat: quat, values) { bare($0, &approx) }
    }
    let prefix = approx ? "≈" : "="
    guard let count else { return "\(prefix) \(parts[0])" }
    return "\(prefix) [\(parts.joined(separator: ", "))\(count > shown ? ", …" : "")]"
  case .flat(let all, let dim, let grade, let count):
    let each = 1 << (dim + 1)
    let shown = min(count ?? 1, 8)
    let parts = try (0..<shown).map { k in
      let values = try all[(k * each)..<((k + 1) * each)].map { try evaluate($0, env) }
      return try flatText(dim: dim, grade: grade, values) { bare($0, &approx) }
    }
    let prefix = approx ? "≈" : "="
    guard let count else { return "\(prefix) \(parts[0])" }
    return "\(prefix) [\(parts.joined(separator: "; "))\(count > shown ? "; …" : "")]"
  default:
    return nil
  }
}
