import EquationCore
import Foundation

// A panel whose view(…) row maps its axes (lib/axis-map.ts), or both at once
// through a plane map (lib/plane-map.ts), as web/scene.ts draws it. Rows
// drawn per pixel were rewritten in the screen's coordinates when they were
// classified (EquationCore `classifyMapped`), so their shaders need nothing
// here. What a row places — points, parametric curves, a named point — is
// computed in x and y as anywhere else, and carried to the screen as it is
// added to the overlay (web/scene.ts `since` and `carry`). The grid is drawn
// at the mapped axes' ticks, and the axis numbers follow them: both read the
// scene's `maps` (`MetalContext.image`, `drawLabels2D`). A plane-mapped
// panel's screen is gridded and numbered in its own X and Y, unless it has
// coordinate grids, which are drawn through the map (`planeGridField`).

/// The way back through a graph's plane map over the window last drawn, and
/// what was carried through it: lib/plane-map.ts `planeInverse` (kept while
/// the window stays) with web/render2d.ts's caches. Shared by the copies of
/// a graph, which are the same rows; one frame carries at a time.
final class PlaneInverses: Equatable, @unchecked Sendable {
  private let lock = NSLock()
  private var map: PlaneMap?
  private var inverse: PlaneInverse?
  private var kept = PlaneCarried()

  /// A cache is no part of what a graph is.
  static func == (_: PlaneInverses, _: PlaneInverses) -> Bool { true }

  /// `body` with the way back for `map` on window `box`, and what it has carried.
  func with<T>(_ map: PlaneMap, _ box: ScreenBox, _ body: (PlaneInverse, inout PlaneCarried) -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    if self.map != map || inverse?.box != box {
      self.map = map
      inverse = PlaneInverse(map, box)
      kept = PlaneCarried()
    }
    return body(inverse!, &kept)
  }
}

extension Graph2D {
  /// The screen window a plane map's way back is built over.
  private func screenBox(_ bounds: Bounds) -> ScreenBox {
    ScreenBox(lo: [bounds.xmin, bounds.ymin], hi: [bounds.xmax, bounds.ymax])
  }

  /// Carry what `row` added to the overlay since `mark` to the mapped
  /// panel's screen, the window `bounds` (`mapOverlay`); nothing on a panel
  /// without maps, or for a row drawn per pixel.
  func carry(_ overlay: inout Overlay2D, _ row: RowAnalysis, since mark: OverlayMark, bounds: Bounds) {
    guard let maps else { return }
    // A named point (`A = (10, 1)`) has no plan of its own, and is placed.
    if let object = row.classified?.object, axisMapping(object, maps) != .place { return }
    guard let plane = maps.plane else { return mapOverlay(&overlay, mark: mark, maps: maps) }
    planes.with(plane, screenBox(bounds)) { inverse, kept in
      planeOverlay(&overlay, mark: mark, inverse: inverse, kept: &kept)
    }
  }

  /// Where a point at (x, y) is drawn on the panel's screen with the window
  /// `bounds`: itself without maps, nil where the maps cannot show it. What
  /// lets a point be grabbed reads this (web/scene.ts `carry`, of `grabs`).
  public func screenPoint(_ x: Double, _ y: Double, bounds: Bounds) -> (x: Double, y: Double)? {
    guard let maps else { return (x, y) }
    let at: ScreenPoint
    if let plane = maps.plane {
      at = planes.with(plane, screenBox(bounds)) { inverse, _ in inverse.first(x, y) }
    } else {
      at = (maps.x.map { toScreen($0, x) } ?? x, maps.y.map { toScreen($0, y) } ?? y)
    }
    return at.0.isFinite && at.1.isFinite ? at : nil
  }

  /// The world point a drag to screen point (sx, sy) puts a point at, on a
  /// plane-mapped panel: the screen point carried to x and y, each rounded
  /// to about a pixel there — the pixel's size in x and y, from the map's
  /// Jacobian — as snapToPixel rounds on a plain panel (web/main.ts
  /// `dragToPlane`). `upp` and `uppY` are the screen's units per pixel. Nil
  /// on a panel without a plane map.
  public func dragToPlane(_ sx: Double, _ sy: Double, upp: Double, uppY: Double) -> (x: Double, y: Double)? {
    guard let plane = maps?.plane else { return nil }
    let (x, y) = planeToWorld(plane, sx, sy)
    let (px, py) = pixelSpan(plane, sx, sy, upp, uppY)
    /// `parseFloat(v.toPrecision(digits))`
    func precise(_ v: Double, _ digits: Int) -> Double {
      v.isFinite ? Double(String(format: "%.*e", digits - 1, v)) ?? v : v
    }
    func round(_ v: Double, _ pixel: Double) -> Double {
      if !(pixel > 0) || !pixel.isFinite { return precise(v, 5) }
      let step = pow(10, log10(pixel * 3).rounded(.down))
      return precise(jsRound(v / step) * step, 12)
    }
    return (round(x, px), round(y, py))
  }

  /// The window a system whose solutions are placed on a mapped panel (a
  /// complex one, in w) solves over: it solves in x and y, over the part of
  /// the window the maps show. Nil when they show none of it. Any other
  /// row's window is the screen's (web/scene.ts `solveFor`).
  func solveWindow(_ row: RowAnalysis, _ window: Bounds) -> Bounds? {
    guard let maps, let object = row.classified?.object, axisMapping(object, maps) == .place else { return window }
    if let plane = maps.plane {
      guard let world = planeWorldBox(plane, screenBox(window)) else { return nil }
      return Bounds(xmin: world.lo[0], xmax: world.hi[0], ymin: world.lo[1], ymax: world.hi[1])
    }
    var out = window
    if let map = maps.x {
      guard let shown = shownRange(map, window.xmin, window.xmax) else { return nil }
      (out.xmin, out.xmax) = shown.world
    }
    if let map = maps.y {
      guard let shown = shownRange(map, window.ymin, window.ymax) else { return nil }
      (out.ymin, out.ymax) = shown.world
    }
    return out
  }

  /// The panel's grid families as a plane-mapped panel draws them: each
  /// coordinate field's level lines through the map, x and y too, which are
  /// curves on its screen (web/scene.ts `panelGridFields` with a plane, and
  /// `planeGridField`).
  func planeGridFields(_ plane: PlaneMap) -> [GridField] {
    if let coords = gridCoords {
      return coords.flatMap { name -> [GridField] in
        if let axis = AxisMap.Axis(rawValue: name) { return [planeGridField(axis: axis, plane)].compactMap { $0 } }
        return analysis.gridFields.filter { $0.name == name }.compactMap { planeGridField($0, plane) }
      }
    }
    return gridFamilies.compactMap { family in
      if case .field(let f) = family { return planeGridField(f, plane) }
      return nil
    }
  }
}

// Written down as the row wrote it, and parsed again, as an axis map is
// (AxisMap.swift): a map that names a slider does not survive the trip.
extension PlaneMap: Codable {
  private enum CodingKeys: String, CodingKey {
    case text
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self = try parsePlaneMap(try container.decode(String.self, forKey: .text))
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(text, forKey: .text)
  }
}
