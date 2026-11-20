import EquationCore
import Foundation

/// What geometry rows draw over the shader passes (web/main.ts, the
/// 'polygon' and 'label' cases of its 2D overlay): a figure as a polyline
/// through its vertices — closed and filled for a polygon, a square or a
/// hull, with an arrow head for a vector — and a label as text at its point.
extension Graph2D {
  /// Opacity of a closed figure's fill (web/main.ts: `cssColorA(color, 0.16)`).
  static let figureFillAlpha = 0.16

  /// Draws `plan` into `overlay` if it is a 2D figure or label; false for any
  /// other plan. `env` holds the constants and t.
  func drawGeometry(_ plan: CpuPlan, _ env: [String: Double], color: RGB, into overlay: inout Overlay2D) -> Bool {
    let css = CSSColor(color)
    switch plan {
    case .polygon(2, let pts, let closed, let arrow, let hull, let over):
      // A vertex with no value draws nothing: the figure waits for it.
      guard var coordinates = try? figureCoordinates(pts, over: over, env), coordinates.allSatisfy(\.isFinite)
      else { return true }
      if hull {
        coordinates = hullFaces(coordinates, dim: 2)[0].outline.flatMap { [$0[0], $0[1]] }
      }
      overlay.polylines.append(
        .init(
          pts: coordinates, color: css, closed: closed,
          fill: closed ? CSSColor(color, alpha: Self.figureFillAlpha) : nil, arrow: arrow ? true : nil))
      return true
    case .label(2, let coords, let text):
      guard let x = try? evaluate(coords[0], env), let y = try? evaluate(coords[1], env), x.isFinite, y.isFinite
      else { return true }
      overlay.texts = (overlay.texts ?? []) + [.init(x: x, y: y, text: text, color: css)]
      return true
    default:
      return false
    }
  }
}
