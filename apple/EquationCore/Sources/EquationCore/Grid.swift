/// Grid families from coordinate fields (lib/grid.ts).
///
/// A coordinate field c(x, y) contributes grid lines along its level sets
/// c = k·spacing, rendered per pixel with the same distance-estimate
/// antialiasing as curves. The default Cartesian grid is just the identity
/// pair (x, y) going through the same path; polar is
/// (sqrt(x² + y²), atan2(y, x)): define `r` and `theta` and the panel they
/// are defined in is gridded by them, or name them in a `grid(r, theta)` row.

/// A coordinate field compiled for both backends (lib/grid.ts `GridField`),
/// and the panel it is defined in, whose grid it draws (web/main.ts
/// `gridFieldPanels`).
public struct GridField: Equatable, Sendable {
  public var cpu: CpuGrid
  public var gpu: GpuGrid
  public var panel: Int

  public var name: String { cpu.name }
}

/// A field over the plane draws its level sets as a grid family; one that
/// uses z has no planar level sets to draw, so it only defines — as does one
/// over the parameters u, v, which is a curve or surface, not a grid, and a
/// complex one (`q = x + iy`), which has no real level sets (`planarField`).
func planarField(_ expr: Expr) -> Bool {
  let vars = freeVars(expr)
  return !vars.contains("z") && !vars.contains("i") && !vars.contains("w") && !vars.contains("u")
    && !vars.contains("v")
}

/// The document's planar coordinate fields, in the order they are defined
/// (lib/analysis.ts `prepareDocument`'s `gridFields`, compiled as
/// web/main.ts compiles them). A field the shaders cannot draw is left out.
func buildGridFields(_ built: BuiltDefs, constNames: Set<String>) -> [GridField] {
  var skip: Set<String> = []
  for p in built.points { skip.formUnion(pointComps(p, built.pointDims[p] ?? 2)) }
  var out: [GridField] = []
  for (name, expr) in built.fields.entries where !skip.contains(name) && planarField(expr) {
    let spec = LevelSetSpec(
      name: name, expr: expr, params: jsSorted(freeVars(expr).list.filter(constNames.contains)), level: nil)
    guard let gpu = try? compileGridGpu(spec), let cpu = try? compileGridCpu(spec) else { continue }
    out.append(GridField(cpu: cpu, gpu: gpu, panel: 0))
  }
  return out
}

/// Each field with the panel its definition is in, once the rows say which
/// of them are dividers (web/main.ts `gridFieldPanels`).
func inPanels(_ fields: [GridField], owner: [String: Int], rows: [RowAnalysis]) -> [GridField] {
  let panels = panelIndices(rows)
  return fields.map { field in
    var out = field
    if let row = owner[field.name], row < panels.count { out.panel = panels[row] }
    return out
  }
}

/// Why `name` cannot draw as a grid family, or nil when it can: x, y, or
/// one of the document's planar coordinate fields. `fields` tells a field
/// that is not planar apart from a name that is no field at all
/// (lib/panels.ts `gridCoordinateProblem`).
func gridCoordinateProblem(_ name: String, gridFields: Set<String>, fields: (String) -> Bool) -> String? {
  if name == "x" || name == "y" || gridFields.contains(name) { return nil }
  if name == "z" { return "z has no level sets in the plane; a grid draws x, y, or coordinates over them." }
  if fields(name) {
    return "\(name) is not a coordinate over the plane (it uses z, u or v, is complex, or is a point's part)."
  }
  return "\(name) is not a coordinate — define it as a function of x and y first, like r = sqrt(x^2 + y^2)."
}

/// The coordinates a `grid(r, theta)` row names (lib/panels.ts
/// `parseGridRow`, past its words): each argument one name, none twice.
func parseGridCoords(_ args: [String]) throws -> [String] {
  var coords: [String] = []
  for arg in args {
    guard let e = try? parseExpr(arg) else {
      throw LanguageError("Expected grid(off), grid(axes), grid(on), or grid(r, theta) naming coordinates.")
    }
    guard case .var(let name) = e else {
      throw LanguageError("grid(…) names coordinates, like grid(r, theta) — not \"\(arg)\".")
    }
    if coords.contains(name) { throw LanguageError("grid(…) names \(name) twice.") }
    coords.append(name)
  }
  return coords
}

/// Spacings for angle-valued coordinates: divisors of 2π, so grid lines land
/// exactly on the atan2 branch cut instead of straddling it.
private let angularMajors: [Double] = [
  .pi / 96, .pi / 48, .pi / 24, .pi / 12, .pi / 6, .pi / 4, .pi / 2, .pi, 2 * .pi,
]

/// Angular analogue of `niceSpacing`: cupp is coordinate units per pixel.
public func angularSpacing(_ cupp: Double, _ minPx: Double) -> (major: Double, minor: Double) {
  let target = cupp * minPx
  for m in angularMajors where m >= target { return (m, m / 4) }
  return (2 * .pi, .pi / 2)
}

/// Median |∇c| over sample points (skipping singular or undefined ones),
/// used to convert "pixels between grid lines" into coordinate-unit spacing.
/// h is the finite-difference step for fields with no symbolic gradient.
public func sampleGradMag(
  _ f: CpuGrid, _ pts: [(Double, Double)], _ env: [String: Double], _ h: Double, ratio: Double = 1
) -> Double {
  var mags: [Double] = []
  var scope = env
  func value(_ e: Expr, _ x: Double, _ y: Double) throws -> Double {
    scope["x"] = x
    scope["y"] = y
    return try evaluate(e, scope)
  }
  for (x, y) in pts {
    let gx: Double
    let gy: Double
    do {
      if let grad = f.grad, grad.count == 2 {
        gx = try value(grad[0], x, y)
        gy = try value(grad[1], x, y)
      } else {
        gx = (try value(f.expr, x + h, y) - (try value(f.expr, x - h, y))) / (2 * h)
        gy = (try value(f.expr, x, y + h) - (try value(f.expr, x, y - h))) / (2 * h)
      }
    } catch {
      continue
    }
    let (a, b) = (gx, gy / ratio)
    let m = (a * a + b * b).squareRoot()
    if m.isFinite && m > 0 { mags.append(m) }
  }
  if mags.isEmpty { return 1 }
  mags.sort()
  return mags[mags.count >> 1]
}
