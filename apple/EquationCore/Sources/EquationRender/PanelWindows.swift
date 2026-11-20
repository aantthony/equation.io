import EquationCore
import Foundation

// A panel's window: the one its view(…) row frames, and the axes it shares
// with the panel it split from (`--- below, shared x`). lib/view.ts
// `fitView2D`, `linkedWindow` and `fitPanelWindow`, and web/main.ts
// `syncLinks`, on the renderer's `View2D`.

/// What a view(…) row asks for: [lo, hi] of each axis it names, and the
/// ratio (pixels per y unit over pixels per x unit). In a mapped panel the
/// ranges are the screen's (lib/view.ts `View2DSpec`).
public struct WindowSpec: Equatable, Sendable {
  public var x: [Double]?
  public var y: [Double]?
  public var ratio: Double?

  public init(x: [Double]? = nil, y: [Double]? = nil, ratio: Double? = nil) {
    self.x = x
    self.y = y
    self.ratio = ratio
  }
}

/// Fit the requested box into a w × h viewport: the ratio asked for (1
/// without), the whole box visible, centered. A single-axis spec centers the
/// other axis at 0 with its span implied by the aspect ratio (`fitView2D`).
public func fitView2D(_ spec: WindowSpec, _ w: Double, _ h: Double) -> View2D {
  let x = spec.x.flatMap { $0.count == 2 ? $0 : nil }
  let y = spec.y.flatMap { $0.count == 2 ? $0 : nil }
  let sx = x.map { $0[1] - $0[0] } ?? 0
  let sy = y.map { $0[1] - $0[0] } ?? 0
  return View2D(
    cx: x.map { ($0[0] + $0[1]) / 2 } ?? 0, cy: y.map { ($0[0] + $0[1]) / 2 } ?? 0,
    upp: max(sx / w, sy * (spec.ratio ?? 1) / h), ratio: spec.ratio)
}

/// A panel's window with its shared axes taken from the panels that own them
/// (`from.x`, `from.y`; see `linkRoot`). Sharing x shares the center and the
/// units per pixel across, and the panel keeps its own ratio, so zooming one
/// zooms the other's y by the same factor; sharing y is the transpose.
/// Sharing both takes the whole window (`linkedWindow`).
public func linkedWindow(
  _ own: View2D, sharedX: Bool, sharedY: Bool, from: (x: View2D?, y: View2D?)
) -> View2D {
  let x = sharedX ? from.x : nil
  let y = sharedY ? from.y : nil
  if let x, let y { return View2D(cx: x.cx, cy: y.cy, upp: x.upp, ratio: x.upp / y.uppY) }
  var out = own
  if let x {
    out.cx = x.cx
    out.upp = x.upp
  } else if let y {
    out.cy = y.cy
    out.upp = y.uppY * (own.ratio ?? 1)
  }
  return out
}

/// The window a panel's view row asks for, given the window its shared axes
/// already put it in (`linked`, from `linkedWindow`). A panel sharing x
/// frames y alone — the row's y range fits the panel exactly, through its
/// ratio — and one sharing y frames x alone. One sharing both has nothing to
/// frame (`fitPanelWindow`).
public func fitPanelWindow(
  _ spec: WindowSpec, _ w: Double, _ h: Double, sharedX: Bool, sharedY: Bool, linked: View2D
) -> View2D {
  if sharedX && sharedY { return linked }
  var out = linked
  if sharedX {
    guard let y = spec.y, y.count == 2 else { return linked }
    out.cy = (y[0] + y[1]) / 2
    out.ratio = linked.upp / ((y[1] - y[0]) / h)
    return out
  }
  if sharedY {
    guard let x = spec.x, x.count == 2 else { return linked }
    let upp = (x[1] - x[0]) / w
    out.cx = (x[0] + x[1]) / 2
    out.upp = upp
    out.ratio = upp / linked.uppY
    return out
  }
  var fitted = fitView2D(spec, w, h)
  if fitted.ratio == nil { fitted.ratio = 1 }
  return fitted
}

private func sameWindow(_ a: View2D, _ b: View2D) -> Bool {
  a.cx == b.cx && a.cy == b.cy && a.upp == b.upp && (a.ratio ?? 1) == (b.ratio ?? 1)
}

/// Carry shared axes between panels (web/main.ts `syncLinks`). A panel a
/// gesture `moved` first pushes its shared axes up to the panels that own
/// them; then every sharing panel takes them from there, in panel order, so
/// an owner (always earlier) is settled before the panels that follow it.
/// Without `moved` the owners win. Returns the panels whose window changed.
@discardableResult
public func syncLinks(_ views: inout [View2D], _ layout: [PanelLayout], moved: Int? = nil) -> Set<Int> {
  var changed: Set<Int> = []
  let count = min(views.count, layout.count)
  func assign(_ p: Int, _ w: View2D) {
    if sameWindow(views[p], w) { return }
    views[p] = w
    changed.insert(p)
  }
  func roots(_ p: Int) -> (x: Int, y: Int) {
    let (x, y) = (linkRoot(layout, p, .x), linkRoot(layout, p, .y))
    return (x < count ? x : p, y < count ? y : p)
  }
  if let moved, moved < count {
    let root = roots(moved)
    let m = views[moved]
    let shared = layout[moved]
    if shared.sharedX && shared.sharedY && root.x == root.y {
      assign(root.x, m)
    } else {
      if shared.sharedX && root.x != moved {
        var w = views[root.x]
        w.cx = m.cx
        w.upp = m.upp
        assign(root.x, w)
      }
      if shared.sharedY && root.y != moved {
        var w = views[root.y]
        w.cy = m.cy
        w.upp = m.uppY * (w.ratio ?? 1)
        assign(root.y, w)
      }
    }
  }
  for p in 0..<count {
    let root = roots(p)
    let from = (x: root.x == p ? nil : views[root.x], y: root.y == p ? nil : views[root.y])
    assign(p, linkedWindow(views[p], sharedX: layout[p].sharedX, sharedY: layout[p].sharedY, from: from))
  }
  return changed
}
