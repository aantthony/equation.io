import EquationCore
import Foundation

// A panel whose view(…) row maps its axes (lib/axis-map.ts), as web/main.ts
// draws it. Rows drawn per pixel were rewritten in the screen's coordinates
// when they were classified (EquationCore `classifyMapped`), so their shaders
// need nothing here. What a row places — points, parametric curves, a named
// point — is computed in x and y as anywhere else, and carried to the screen
// as it is added to the overlay (web/scene.ts `since` and `carry`). The grid
// is drawn at the mapped axes' ticks, and the axis numbers follow them: both
// read the scene's `maps` (`MetalContext.image`, `drawLabels2D`).

extension Graph2D {
  /// Carry what `row` added to the overlay since `mark` to the mapped
  /// panel's screen (`mapOverlay`); nothing on a panel without maps, or for
  /// a row drawn per pixel.
  func carry(_ overlay: inout Overlay2D, _ row: RowAnalysis, since mark: OverlayMark) {
    guard let maps else { return }
    // A named point (`A = (10, 1)`) has no plan of its own, and is placed.
    if let object = row.classified?.object, axisMapping(object) != .place { return }
    mapOverlay(&overlay, mark: mark, maps: maps)
  }
}
