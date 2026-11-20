import EquationCore
import Foundation

/// What the CPU draws of a definite integral's row (web/main.ts, the `value`
/// case of its plan switch): the number lives in the row's readout; the plot
/// is the area it measures. Parts that add to the value take the row color,
/// parts that subtract its complement.
extension Graph2D {
  /// Draw the area a `value` plan shades. The integrand is sampled across
  /// the stretch of the x-axis in view (`shadeRuns`), again only when that
  /// stretch or a value the shade reads (its bounds, a slider, t) changes —
  /// the site's `shadeCache` — so a vertical pan only clamps the runs to the
  /// new window (`runPaths`). On mapped axes the runs are in the panel's
  /// screen coordinates already, and stand on where y = 0 is drawn there.
  func drawIntegral(
    _ shade: IntShade, row: Int, color: RGB, env: [String: Double], bounds: Bounds, into overlay: inout Overlay2D
  ) {
    let minus = minusTint(Double(color.x), Double(color.y), Double(color.z))
    let tints = (plus: color, minus: RGB(Float(minus.0), Float(minus.1), Float(minus.2)))
    let key = DrawnLaws.Key(
      rows: analysis.rows.map(\.text), color: color,
      values: shadeNames(shade).map { (env[$0] ?? .nan).bitPattern }, xmin: bounds.xmin, xmax: bounds.xmax,
      pointsPerUnit: nil)
    // The runs as sampled, kept as polylines: each in its tint, `closed`
    // where the window cut its start and `arrow` where it cut its end.
    let sampled = lawsDrawn.drawn(row: row, key: key) {
      var fresh = Overlay2D()
      for run in shadeRuns(shade, env, bounds.xmin, bounds.xmax, maps: maps ?? AxisMaps()) {
        fresh.polylines.append(
          .init(
            pts: run.pts, color: CSSColor(run.sign > 0 ? tints.plus : tints.minus), closed: run.clipLo ? true : nil,
            arrow: run.clipHi ? true : nil))
      }
      return fresh
    }
    let zero = maps?.y.map { toScreenOrEdge($0, 0) } ?? 0
    for line in sampled.polylines {
      let run = ShadeRun(sign: 1, pts: line.pts, clipLo: line.closed == true, clipHi: line.arrow == true)
      // Only real edges are stroked: not where the window cut the range.
      let (fill, stroke) = runPaths(run, bounds.ymin, bounds.ymax, zero: zero)
      var tinted = line.color
      tinted.a = 0.16
      overlay.polylines.append(.init(pts: fill, color: line.color, closed: true, fill: tinted, noStroke: true))
      overlay.polylines.append(.init(pts: stroke, color: line.color))
    }
  }
}
