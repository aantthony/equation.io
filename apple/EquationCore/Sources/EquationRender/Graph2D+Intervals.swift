import EquationCore

// Rows over an interval in the plane (web/scene.ts `renderPanel`, the
// `projected2d` case): the region a family sweeps is a shader layer of its
// own, `Layers2D.projections`, which projFrag searches along u per pixel. A
// row over intervals with no x or y is drawn as what classify made of it — a
// curve, a region in u and v, a density — by the rows that draw those.

extension Graph2D {
  /// The projection layers of a row's plan, or of the members of its family
  /// (`y = [1, 2] a x`, each member shaded as a family's are).
  static func addProjections(_ members: [GpuPlan], color: RGB, into projections: inout [Projected2D]) {
    for (k, member) in members.enumerated() {
      guard case .projected2d(let relation, let field, let slope) = member.shader else { continue }
      let shaded = members.count > 1 ? familyColor(color, member: k, of: members.count) : color
      projections.append(
        Projected2D(
          field: field, color: shaded, params: member.params, uniforms: shaderUniforms(member),
          relation: relation == .eq ? .eq : .ineq, slope: slope))
    }
  }
}
