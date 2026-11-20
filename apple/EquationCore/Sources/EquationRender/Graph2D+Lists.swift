import EquationCore
import Foundation

/// What list rows draw (web/main.ts, the 'vlist', 'plist', 'dlist',
/// 'dscatter' and 'histogram' cases of its 2D overlay, and `renderMembers`):
/// a list of numbers as a dot plot on the number line, a list of points as
/// its points, a histogram as bars, and a family as one drawing per member,
/// each a shade lighter than the last.
extension Graph2D {
  /// Above this many points, a packed list draws as a bulk cloud rather than
  /// as individual outlined points (web/session.ts `CLOUD_MIN`).
  static let cloudMin = 400
  /// Dot diameters in points: a listed point (r 4) and a cloud dot.
  static let pointDotPx = 8.0
  static let cloudDotPx = 3.0

  /// A family member's color: the row's, lightened toward white with its
  /// place in the family (web/main.ts `familyShade`, `rowColor`).
  static func familyColor(_ color: RGB, member k: Int, of count: Int) -> RGB {
    let shade = Float(0.45 * Double(k) / Double(max(1, count - 1)))
    return color + (RGB(repeating: 1) - color) * shade
  }

  /// A row as the rows that draw it: itself, or — a family — one row per
  /// member with the member's plans and its shade of the row's color
  /// (web/scene.ts `renderMembers`).
  static func familyMembers(_ row: RowAnalysis, _ cpu: CpuPlan, _ color: RGB) -> [(row: RowAnalysis, color: RGB)] {
    guard case .family(let members) = cpu else { return [(row, color)] }
    var shaders: [GpuPlan] = []
    if case .family(let plans)? = row.gpu?.shader { shaders = plans }
    return members.enumerated().map { k, member in
      var one = row
      one.classified = member.classified
      one.cpu = member.cpu
      one.gpu = k < shaders.count ? shaders[k] : nil
      return (one, familyColor(color, member: k, of: members.count))
    }
  }

  /// What a plan sets itself, by the uniform's name (web/render-plan.ts `shaderBindings`).
  static func shaderUniforms(_ plan: GpuPlan?) -> [String: Double]? {
    guard let plan, !plan.uniforms.isEmpty else { return nil }
    var uniforms: [String: Double] = [:]
    for (name, value) in plan.uniforms { uniforms[uniformName(name)] = value }
    return uniforms
  }

  /// The shader layers of a family: each member's plan, with the index it
  /// reads in the program its family shares as a uniform of its own.
  static func addFamily(
    _ members: [GpuPlan], color: RGB, curves: inout [Curve2D], ineqs: inout [Ineq2D], vfields: inout [VField2D]
  ) {
    for (k, member) in members.enumerated() {
      let shaded = familyColor(color, member: k, of: members.count)
      let uniforms = shaderUniforms(member)
      switch member.shader {
      case .implicit2d(let field, _):
        curves.append(Curve2D(field: field, color: shaded, params: member.params, uniforms: uniforms))
      case .ineq2d(let field, let edges):
        ineqs.append(Ineq2D(field: field, color: shaded, params: member.params, uniforms: uniforms, edges: edges))
      case .vfield2d(let fx, let fy):
        vfields.append(VField2D(uniforms: uniforms, fx: fx, fy: fy, color: shaded, params: member.params))
      default:
        // Points, curves and figures are the overlay's; members in space are the 3D scene's.
        break
      }
    }
  }

  /// A list of numbers as its dot plot (lib/plot.ts `dotPlot`), stacked in
  /// columns one dot wide at the current zoom: dots that would overlap share
  /// a column, and values at least a dot apart keep their exact place, so a
  /// small list stacks exact copies (web/session.ts `columnStacks`).
  /// `pointsPerUnit` is the zoom; without it nothing is gathered.
  static func columnStacks(_ values: [Double], dotPx: Double, pointsPerUnit: Double?) -> (xs: [Double], ys: [Double]) {
    let width = pointsPerUnit.map { dotPx / $0 } ?? 0
    var binned = values.count > cloudMin
    if !binned, width > 0 {
      // Whether two different values lie closer than a dot's width.
      let sorted = values.filter(\.isFinite).sorted()
      binned = zip(sorted, sorted.dropFirst()).contains { $1 - $0 > 0 && $1 - $0 < width }
    }
    return dotPlot(values, width: binned ? width : 0)
  }

  /// Draws `plan` into `overlay` if it is a list, a histogram or a family;
  /// false for any other plan. `env` holds the constants and t.
  func drawList(
    _ plan: CpuPlan, _ env: [String: Double], color: RGB, pointsPerUnit: Double?, into overlay: inout Overlay2D
  ) -> Bool {
    let css = CSSColor(color)
    func dots(_ values: [Double]) {
      // Few enough to read as individual points, and they go through the
      // same path as any other point (outlines); past that they are a cloud,
      // drawn in bulk.
      if values.count > Self.cloudMin {
        let stacks = Self.columnStacks(values, dotPx: Self.cloudDotPx, pointsPerUnit: pointsPerUnit)
        overlay.clouds = (overlay.clouds ?? []) + [.init(xs: stacks.xs, ys: stacks.ys, color: css)]
        return
      }
      let stacks = Self.columnStacks(values, dotPx: Self.pointDotPx, pointsPerUnit: pointsPerUnit)
      for (x, y) in zip(stacks.xs, stacks.ys) { overlay.points.append(.init(x: x, y: y, color: css, r: 4)) }
    }
    switch plan {
    case .vlist(let values):
      // Numbers on the number line, copies stacked.
      dots(values.map { (try? evaluate($0, env)) ?? .nan })
    case .dlist(let values):
      dots(values)
    case .plist(2, let pts):
      // A handful of points read as points; a few thousand read as a cloud,
      // where fat outlined dots would merge into one white smear.
      let dense = pts.count > 200
      for comps in pts where comps.count == 2 {
        guard let x = try? evaluate(comps[0], env), let y = try? evaluate(comps[1], env), x.isFinite, y.isFinite
        else { continue }
        overlay.points.append(.init(x: x, y: y, color: css, r: dense ? 2 : 4, bare: dense))
      }
    case .dscatter(2, let coords) where coords.count == 2:
      let (xs, ys) = (coords[0], coords[1])
      if xs.count > Self.cloudMin {
        overlay.clouds = (overlay.clouds ?? []) + [.init(xs: xs, ys: ys, color: css)]
      } else {
        for (x, y) in zip(xs, ys) where x.isFinite && y.isFinite {
          overlay.points.append(.init(x: x, y: y, color: css, r: 4))
        }
      }
    case .histogram(let centers, let counts, let width):
      overlay.bars =
        (overlay.bars ?? [])
        + zip(centers, counts).map { .init(x: $0, y: $1, halfWidth: width / 2, color: css) }
    case .family(let members):
      for (k, member) in members.enumerated() {
        drawMember(
          member.cpu, env, color: Self.familyColor(color, member: k, of: members.count),
          pointsPerUnit: pointsPerUnit, into: &overlay)
      }
    default:
      return false
    }
    return true
  }

  /// One member of a family, drawn as its row would be: the kinds a family
  /// can hold that the CPU draws (a point, a parametric curve, a figure, a
  /// list). Curves, regions and fields are shader layers (`addFamily`).
  private func drawMember(
    _ plan: CpuPlan, _ env: [String: Double], color: RGB, pointsPerUnit: Double?, into overlay: inout Overlay2D
  ) {
    let css = CSSColor(color)
    switch plan {
    case .point(2, let coords) where coords.count == 2:
      guard let x = try? evaluate(coords[0], env), let y = try? evaluate(coords[1], env), x.isFinite, y.isFinite
      else { return }
      overlay.points.append(.init(x: x, y: y, color: css))
    case .pcurve(2, let comps, _, _, _) where comps.count == 2:
      var pts: [Double] = []
      pts.reserveCapacity(Self.curveSamples * 2)
      var scope = env
      for k in 0..<Self.curveSamples {
        scope["u"] = Double(k) / Double(Self.curveSamples - 1)
        // A sample the curve has no value at is a gap in the line.
        pts.append((try? evaluate(comps[0], scope)) ?? .nan)
        pts.append((try? evaluate(comps[1], scope)) ?? .nan)
      }
      overlay.polylines.append(.init(pts: pts, color: css))
    case .polygon, .label:
      _ = drawGeometry(plan, env, color: color, into: &overlay)
    default:
      _ = drawList(plan, env, color: color, pointsPerUnit: pointsPerUnit, into: &overlay)
    }
  }
}
