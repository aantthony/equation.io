import Foundation
import simd

// How a hand and Ask move a panel's window or camera: the arithmetic of
// web/main.ts's pointer handlers (`zoomAt`, `panBy`) and of its eased moves
// (`movePanelView`), apart from any view, so it is under test.

extension View2D {
  /// The math point `px`, `py` device pixels from the window's center (y up).
  public func point(px: Double, py: Double) -> (x: Double, y: Double) {
    (cx + px * upp, cy + py * uppY)
  }

  /// Zoom by `factor` (under 1 moves in), keeping the math point `px`, `py`
  /// device pixels from the center where it is.
  public mutating func zoom(by factor: Double, px: Double = 0, py: Double = 0) {
    guard factor > 0, factor.isFinite else { return }
    let at = point(px: px, py: py)
    upp = min(max(upp * factor, 1e-12), 1e12)
    cx = at.x - px * upp
    cy = at.y - py * uppY
  }

  /// Move the window as if the plot were dragged by (dx, dy) device pixels, dy down the screen.
  public mutating func pan(dx: Double, dy: Double) {
    cx -= dx * upp
    cy += dy * uppY
  }

  /// The window showing the given ranges in a box `width` × `height` pixels:
  /// one range alone keeps the other axis's center, and the scale is the one
  /// that shows every range asked for (lib/view.ts `fitView2D`, as
  /// the site's former voice mode's `movePanelView` uses it).
  public func fitting(x: (Double, Double)?, y: (Double, Double)?, width: Double, height: Double) -> View2D {
    var to = self
    guard width > 0, height > 0 else { return to }
    if let x { to.cx = (x.0 + x.1) / 2 }
    if let y { to.cy = (y.0 + y.1) / 2 }
    let across = x.map { ($0.1 - $0.0) / width } ?? 0
    let up = y.map { ($0.1 - $0.0) * (ratio ?? 1) / height } ?? 0
    let fitted = max(across, up)
    if fitted > 0, fitted.isFinite { to.upp = fitted }
    return to
  }

  /// The window `k` of the way from this one to `to` (0…1): the center
  /// moves evenly and the scale geometrically, so a 100× zoom doesn't spend
  /// its first half barely moving.
  public func eased(to: View2D, _ k: Double) -> View2D {
    var view = self
    view.cx = cx + (to.cx - cx) * k
    view.cy = cy + (to.cy - cy) * k
    view.upp = upp * pow(to.upp / upp, k)
    return view
  }

  /// The ranges a box `width` × `height` pixels shows.
  public func visible(width: Double, height: Double) -> (x: [Double], y: [Double]) {
    let halfX = width / 2 * upp
    let halfY = height / 2 * uppY
    return ([cx - halfX, cx + halfX], [cy - halfY, cy + halfY])
  }
}

/// `k * k * (3 - 2k)`: the site's easeInOut.
public func easeInOut(_ k: Double) -> Double {
  let k = min(max(k, 0), 1)
  return k * k * (3 - 2 * k)
}

/// Where Ask's move_view sends a camera: any of the angles, the distance
/// and the point looked at.
public struct CameraMove: Equatable, Sendable {
  public var theta: Double?
  public var phi: Double?
  public var radius: Double?
  public var target: SIMD3<Double>?

  public init(theta: Double? = nil, phi: Double? = nil, radius: Double? = nil, target: SIMD3<Double>? = nil) {
    self.theta = theta
    self.phi = phi
    self.radius = radius
    self.target = target
  }

  public var isEmpty: Bool { theta == nil && phi == nil && radius == nil && target == nil }
}

extension Camera3D {
  /// The camera a move ends at. Theta goes the short way round, not a spin
  /// through 350 degrees, so it may end a whole turn from the angle asked for.
  public func moved(_ move: CameraMove) -> Camera3D {
    var to = self
    if let theta = move.theta {
      let turn = 2 * Double.pi
      let d = (theta - self.theta).truncatingRemainder(dividingBy: turn)
      to.theta = self.theta + (d + 3 * .pi).truncatingRemainder(dividingBy: turn) - .pi
    }
    if let phi = move.phi { to.phi = clampPhi(phi) }
    if let radius = move.radius, radius > 0 { to.radius = radius }
    if let target = move.target { to.target = target }
    return to
  }

  /// The camera `k` of the way from this one to `to` (0…1): the radius geometrically.
  public func eased(to: Camera3D, _ k: Double) -> Camera3D {
    Camera3D(
      target: target + (to.target - target) * k, radius: radius * pow(to.radius / radius, k),
      theta: theta + (to.theta - theta) * k, phi: phi + (to.phi - phi) * k)
  }

  /// Theta as it shows, in (-pi, pi].
  public var shownTheta: Double {
    theta - 2 * .pi * jsRound(theta / (2 * .pi))
  }
}
