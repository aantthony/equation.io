/// Split views: where each panel of a document goes (lib/panels.ts).
///
/// `---` rows divide the document into panels. Rows below a divider draw in
/// a panel of their own, with its own x and y, its own `view(…)` row and its
/// own `grid(…)`; definitions stay document-wide. Splits tile: each divides
/// the most recent tiled panel (the tmux rule), so a scene on the left with
/// two panels stacked on its right is `--- right 40%` then `--- below`.
/// Insets float over the most recent tiled panel and are placed after
/// tiling, against that panel's final box.
///
/// The divider itself is read in View.swift (`parseDividerRow`); here is what
/// the dividers of a document come to in a frame.

/// A box in device pixels, from the top-left corner.
public struct PanelRect: Equatable, Sendable {
  public var x: Double
  public var y: Double
  public var w: Double
  public var h: Double

  public init(x: Double, y: Double, w: Double, h: Double) {
    self.x = x
    self.y = y
    self.w = w
    self.h = h
  }
}

public struct PanelLayout: Equatable, Sendable {
  public var rect: PanelRect
  /// The panel this one split from or floats over (itself for the first).
  public var host: Int
  public var inset: Bool
  /// The axes locked to the host's: same center and scale, so stacked
  /// panels line up column for column, and panning either pans both.
  public var sharedX: Bool
  public var sharedY: Bool

  public init(rect: PanelRect, host: Int, inset: Bool, sharedX: Bool, sharedY: Bool) {
    self.rect = rect
    self.host = host
    self.inset = inset
    self.sharedX = sharedX
    self.sharedY = sharedY
  }
}

/// An inset's share of its host's width and height when its row gives none.
private let defaultInset = 0.35

/// Each row's panel: 0 until the first divider, then one more per divider.
/// A divider belongs to the panel it opens (`panelIndices`).
public func panelIndices(_ rows: [RowAnalysis]) -> [Int] {
  var panel = 0
  return rows.map { row in
    if row.divider { panel += 1 }
    return panel
  }
}

/// The dividers of a document, in order: panel k + 1 is opened by entry k (`splitsOf`).
public func splitsOf(_ rows: [RowAnalysis]) -> [ViewSpec] {
  rows.compactMap { $0.divider ? $0.view : nil }
}

/// Lay the panels out in a w × h frame (`layoutPanels`). `margin` is the
/// gap, in the same pixels, between an inset and its host's edges. Entries
/// of `splits` that are not dividers are skipped.
public func layoutPanels(_ splits: [ViewSpec], _ w: Double, _ h: Double, margin: Double = 0) -> [PanelLayout] {
  struct Split {
    var place: String?
    var corner: String?
    var size: Double?
    var sharedX: Bool
    var sharedY: Bool
  }
  let specs = splits.compactMap { spec -> Split? in
    guard case .split(let place, let corner, let size, let sharedX, let sharedY) = spec else { return nil }
    return Split(place: place, corner: corner, size: size, sharedX: sharedX, sharedY: sharedY)
  }
  var out = [
    PanelLayout(rect: PanelRect(x: 0, y: 0, w: w, h: h), host: 0, inset: false, sharedX: false, sharedY: false)
  ]
  var tile = 0
  for s in specs {
    if s.place == "inset" {
      out.append(
        PanelLayout(
          rect: PanelRect(x: 0, y: 0, w: 0, h: 0), host: tile, inset: true, sharedX: s.sharedX, sharedY: s.sharedY))
      continue
    }
    let region = out[tile].rect
    // A bare `---` splits along the longer side.
    let place = s.place ?? (region.w >= region.h ? "right" : "below")
    let f = s.size ?? 0.5
    let across = place == "right" || place == "left"
    let total = across ? region.w : region.h
    let size = JS.max([1, JS.min([total - 1, JS.round(total * f)])])
    let rest = total - size
    var host = region
    var rect = region
    if across {
      host.w = rest
      rect.w = size
      if place == "right" { rect.x = region.x + rest } else { host.x = region.x + size }
    } else {
      host.h = rest
      rect.h = size
      if place == "below" { rect.y = region.y + rest } else { host.y = region.y + size }
    }
    out[tile].rect = host
    out.append(PanelLayout(rect: rect, host: tile, inset: false, sharedX: s.sharedX, sharedY: s.sharedY))
    tile = out.count - 1
  }
  for (k, s) in specs.enumerated() where s.place == "inset" {
    let box = out[out[k + 1].host].rect
    let f = s.size ?? defaultInset
    let iw = JS.max([1, JS.round(box.w * f)])
    let ih = JS.max([1, JS.round(box.h * f)])
    let m = JS.max([0, JS.min([margin, (box.w - iw) / 2, (box.h - ih) / 2])])
    let corner = s.corner ?? "top-right"
    let top = corner.hasPrefix("top")
    let left = corner.hasSuffix("left")
    out[k + 1].rect = PanelRect(
      x: JS.round(left ? box.x + m : box.x + box.w - iw - m),
      y: JS.round(top ? box.y + m : box.y + box.h - ih - m),
      w: iw, h: ih)
  }
  return out
}

public enum PanelAxis: Sendable {
  case x, y
}

/// The panel whose axis panel i follows: up the chain of shared hosts (`linkRoot`).
public func linkRoot(_ layout: [PanelLayout], _ i: Int, _ axis: PanelAxis) -> Int {
  var k = i
  var guardCount = 0
  while guardCount < layout.count, layout.indices.contains(k),
    axis == .x ? layout[k].sharedX : layout[k].sharedY, layout[k].host != k
  {
    k = layout[k].host
    guardCount += 1
  }
  return k
}

/// The topmost panel containing a point, in the layout's pixels (insets draw
/// over tiles, later over earlier) (`panelAt`).
public func panelAt(_ layout: [PanelLayout], _ x: Double, _ y: Double) -> Int {
  func holds(_ r: PanelRect) -> Bool { x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h }
  for i in layout.indices.reversed() where layout[i].inset && holds(layout[i].rect) { return i }
  for i in layout.indices.reversed() where !layout[i].inset && holds(layout[i].rect) { return i }
  return 0
}

extension DocumentAnalysis {
  /// The document as its panel `index` draws it: the rows of every other
  /// panel left blank, so what is read off the rows (plots, named points,
  /// the view and grid rows) is that panel's alone. Definitions are
  /// document-wide, and stay so: the constants' values are not the rows'.
  public func panel(_ index: Int) -> DocumentAnalysis {
    var out = self
    for (i, at) in panelIndices(rows).enumerated() where at != index {
      out.rows[i] = RowAnalysis(text: "", noteStart: nil)
    }
    return out
  }
}
