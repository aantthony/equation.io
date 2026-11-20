import EquationCore
import Foundation

// Coordinate grids (lib/grid.ts), as web/main.ts draws them behind a panel:
// the level sets of the coordinate fields defined among the panel's rows
// (`r = sqrt(x^2 + y^2)`, `theta = atan2(y, x)`), or of those its
// `grid(r, theta)` row names (`panelGridFields`), spaced by the size of
// their gradient over the window (`levelSpacing`). And a level set's contour
// stack, which a row shows when asked (`showLevels`).

extension Graph2D {
  /// One family of grid lines: x or y themselves, or a coordinate field.
  enum GridFamily {
    case x, y
    case field(GridField)
  }

  /// Which grid families draw behind the panel: those its grid(…) row names,
  /// or else the coordinate fields defined among its rows. Empty is
  /// Cartesian (web/main.ts `panelGridFields`, without a plane map).
  var gridFamilies: [GridFamily] {
    if let coords = gridCoords {
      // grid(x, y) is the plain grid.
      if coords.count == 2, coords.contains("x"), coords.contains("y") { return [] }
      return coords.flatMap { name -> [GridFamily] in
        if name == "x" { return [.x] }
        if name == "y" { return [.y] }
        return analysis.gridFields.filter { $0.name == name }.map { .field($0) }
      }
    }
    // The fields whose definitions are among this panel's rows.
    let defined = Set(analysis.rows.compactMap { $0.definition?.name })
    return analysis.gridFields.filter { defined.contains($0.name) }.map { .field($0) }
  }

  /// The grid moves with t: a field reads it, or a constant that does.
  var gridAnimated: Bool {
    gridFamilies.contains { family in
      guard case .field(let f) = family else { return false }
      return freeVars(f.cpu.expr).contains("t") || f.cpu.params.contains(where: analysis.animated.contains)
    }
  }

  /// Spacing for any level-set family (custom grids, contour stacks): |∇c|
  /// is sampled around the view to convert the target pixel gap into
  /// coordinate units (π-based for angles) (web/main.ts `levelSpacing`).
  func levelSpacing(
    _ f: CpuGrid, view: View2D, width: Double, height: Double, env: [String: Double]
  ) -> (major: Double, minor: Double) {
    let halfW = width / 2 * view.upp
    let halfH = height / 2 * view.uppY
    let pts = [
      (view.cx, view.cy), (view.cx - halfW / 2, view.cy), (view.cx + halfW / 2, view.cy),
      (view.cx, view.cy - halfH / 2), (view.cx, view.cy + halfH / 2),
    ]
    let cupp = sampleGradMag(f, pts, env, view.upp * 4, ratio: view.ratio ?? 1) * view.upp
    return f.angular ? angularSpacing(cupp, 90) : niceSpacing(cupp, 90)
  }

  /// The grid families the renderer draws in place of the Cartesian grid, in
  /// a window `view` of a frame `width` × `height` pixels, or nil for the
  /// Cartesian grid. Coordinate fields are written in x and y, not a mapped
  /// panel's screen coordinates: a panel with its axes mapped grids at their
  /// ticks instead.
  public func gridSpecs(at time: Double, view: View2D, width: Double, height: Double) -> [GridSpec]? {
    guard grid == .on, maps == nil else { return nil }
    let families = gridFamilies
    if families.isEmpty { return nil }
    var env = environment(at: time)
    env["t"] = time
    return families.map { family in
      switch family {
      case .x:
        let sp = niceSpacing(view.upp, 90)
        return GridSpec(glsl: "x", gradGlsl: ["1.0", "0.0"], major: sp.major, minor: sp.minor)
      case .y:
        let sp = niceSpacing(view.uppY, 90)
        return GridSpec(glsl: "y", gradGlsl: ["0.0", "1.0"], major: sp.major, minor: sp.minor)
      case .field(let f):
        let sp = levelSpacing(f.cpu, view: view, width: width, height: height, env: env)
        return GridSpec(
          glsl: f.gpu.glsl, gradGlsl: f.gpu.gradGlsl, params: f.gpu.params, major: sp.major, minor: sp.minor)
      }
    }
  }

  /// The contour stacks of the level-set rows in `rows` (`f(x, y) = c` with
  /// c a constant: every level of f, in the row's color, under the other
  /// layers), for `Layers2D.levels`. The site draws one when its row's
  /// "all levels" button is on; which rows show theirs is the drawer's state.
  public func levelStacks(
    rows: Set<Int>, at time: Double, view: View2D, width: Double, height: Double
  ) -> [LevelSpec] {
    var env = environment(at: time)
    env["t"] = time
    var out: [LevelSpec] = []
    for index in rows.sorted() where analysis.rows.indices.contains(index) {
      let row = analysis.rows[index]
      guard row.error == nil, row.unsupported == nil, index < colors.count, let color = colors[index],
        case .implicit2d(_, _, let levels?)? = row.cpu, case .implicit2d(_, let shader?)? = row.gpu?.shader
      else { continue }
      let sp = levelSpacing(levels, view: view, width: width, height: height, env: env)
      out.append(
        LevelSpec(
          glsl: shader.glsl, gradGlsl: shader.gradGlsl, params: levels.params, major: sp.major, minor: sp.minor,
          color: color))
    }
    return out
  }

  /// The rows that have a contour stack to show.
  public var levelRows: [Int] {
    analysis.rows.indices.filter {
      if case .implicit2d(_, _, .some)? = analysis.rows[$0].cpu { return true }
      return false
    }
  }
}
