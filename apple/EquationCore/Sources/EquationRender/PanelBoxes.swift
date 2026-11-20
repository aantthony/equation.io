import EquationCore
import Foundation

// Where a document's panels go in the frame: lib/panels.ts `layoutPanels`,
// `linkRoot` and `panelAt`. Each `---` row opens a panel; splits tile, each
// dividing the most recent tiled panel, and insets float over it.

/// One panel's place: its box in pixels from the frame's top-left corner,
/// the panel it split from or floats over (itself for the first), and the
/// axes it shares with that one.
public struct PanelBox: Equatable, Sendable {
  public var x: Double
  public var y: Double
  public var w: Double
  public var h: Double
  public var host: Int
  public var inset: Bool
  public var sharedX: Bool
  public var sharedY: Bool

  public func contains(_ px: Double, _ py: Double) -> Bool {
    px >= x && px < x + w && py >= y && py < y + h
  }

  /// The box as the renderers take it: from the bottom-left corner of a
  /// frame `height` pixels high, as GL counts.
  public func frame(in height: Double) -> Frame2D.Box {
    Frame2D.Box(x: x, y: height - y - h, w: w, h: h)
  }
}

/// An inset's share of its host's width and height, when its row gives none.
private let defaultInset = 0.35

/// Lay the panels out in a `w` × `h` frame: one for the document, and one
/// more for each divider in `splits` (`ViewSpec.split` values; others are
/// skipped). `margin` is the gap, in the same pixels, between an inset and
/// its host's edges.
public func panelBoxes(_ splits: [ViewSpec], width w: Double, height h: Double, margin: Double = 0) -> [PanelBox] {
  var out = [PanelBox(x: 0, y: 0, w: w, h: h, host: 0, inset: false, sharedX: false, sharedY: false)]
  var insets: [(panel: Int, corner: String?, size: Double?)] = []
  var tile = 0
  for spec in splits {
    guard case .split(let place, let corner, let size, let sharedX, let sharedY) = spec else { continue }
    if place == "inset" {
      out.append(PanelBox(x: 0, y: 0, w: 0, h: 0, host: tile, inset: true, sharedX: sharedX, sharedY: sharedY))
      insets.append((out.count - 1, corner, size))
      continue
    }
    let region = out[tile]
    // A bare `---` splits along the longer side.
    let side = place ?? (region.w >= region.h ? "right" : "below")
    let across = side == "right" || side == "left"
    let total = across ? region.w : region.h
    let taken = max(1, min(total - 1, jsRound(total * (size ?? 0.5))))
    let rest = total - taken
    var host = region
    var box = PanelBox(
      x: region.x, y: region.y, w: region.w, h: region.h, host: tile, inset: false, sharedX: sharedX,
      sharedY: sharedY)
    if across {
      host.w = rest
      box.w = taken
      if side == "right" { box.x = region.x + rest } else { host.x = region.x + taken }
    } else {
      host.h = rest
      box.h = taken
      if side == "below" { box.y = region.y + rest } else { host.y = region.y + taken }
    }
    out[tile] = host
    out.append(box)
    tile = out.count - 1
  }
  // Insets are placed after tiling, against their host's final box.
  for inset in insets {
    let box = out[out[inset.panel].host]
    let f = inset.size ?? defaultInset
    let iw = max(1, jsRound(box.w * f))
    let ih = max(1, jsRound(box.h * f))
    let m = max(0, min(margin, (box.w - iw) / 2, (box.h - ih) / 2))
    let corner = (inset.corner ?? "top-right").split(separator: "-")
    out[inset.panel].x = jsRound(corner.last == "left" ? box.x + m : box.x + box.w - iw - m)
    out[inset.panel].y = jsRound(corner.first == "top" ? box.y + m : box.y + box.h - ih - m)
    out[inset.panel].w = iw
    out[inset.panel].h = ih
  }
  return out
}

/// The panel whose x (or y) axis panel `i` follows: up the chain of shared hosts.
public func linkRoot(_ boxes: [PanelBox], _ i: Int, x: Bool) -> Int {
  var k = i
  for _ in boxes.indices {
    guard x ? boxes[k].sharedX : boxes[k].sharedY, boxes[k].host != k else { break }
    k = boxes[k].host
  }
  return k
}

/// The topmost panel containing a point (insets draw over tiles, later over earlier).
public func panelAt(_ boxes: [PanelBox], _ x: Double, _ y: Double) -> Int {
  for inset in [true, false] {
    for i in boxes.indices.reversed() where boxes[i].inset == inset && boxes[i].contains(x, y) { return i }
  }
  return 0
}

/// A panel's window with its shared axes taken from the panels that own
/// them (lib/view.ts `linkedWindow`). Sharing x shares the center and the
/// units per pixel across, and the panel keeps its own ratio; sharing y is
/// the transpose; sharing both takes the whole window.
public func linkedWindow(_ own: View2D, x: View2D?, y: View2D?) -> View2D {
  var view = own
  if let x, let y {
    view = View2D(cx: x.cx, cy: y.cy, upp: x.upp, ratio: x.upp / y.uppY)
  } else if let x {
    view.cx = x.cx
    view.upp = x.upp
  } else if let y {
    view.cy = y.cy
    view.upp = y.uppY * (own.ratio ?? 1)
  }
  return view
}

/// Carry the windows of panels that share axes to one another: `moved`
/// (the panel a gesture just moved, if any) first gives its shared axes to
/// the panels that own them, then every panel takes its shared axes from
/// their owners (web/main.ts `syncLinks`).
public func syncLinkedWindows(_ views: inout [View2D], _ boxes: [PanelBox], moved: Int? = nil) {
  guard views.count == boxes.count else { return }
  if let moved, views.indices.contains(moved) {
    let m = views[moved]
    let rootX = linkRoot(boxes, moved, x: true)
    let rootY = linkRoot(boxes, moved, x: false)
    if boxes[moved].sharedX, boxes[moved].sharedY, rootX == rootY {
      views[rootX] = m
    } else {
      if boxes[moved].sharedX, rootX != moved {
        views[rootX].cx = m.cx
        views[rootX].upp = m.upp
      }
      if boxes[moved].sharedY, rootY != moved {
        views[rootY].cy = m.cy
        views[rootY].upp = m.uppY * (views[rootY].ratio ?? 1)
      }
    }
  }
  for i in views.indices {
    let rootX = linkRoot(boxes, i, x: true)
    let rootY = linkRoot(boxes, i, x: false)
    views[i] = linkedWindow(views[i], x: rootX == i ? nil : views[rootX], y: rootY == i ? nil : views[rootY])
  }
}
