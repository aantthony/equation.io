import CoreGraphics
import CoreText
import Foundation

// What is drawn over the shader passes with a 2D context: web/render2d.ts
// from `drawLatticeLabels` on (the site's overlay canvas). The axis numbers,
// a lattice panel's labels, and the geometry the CPU samples: points,
// polylines, clouds, bars, regions, glyphs, a graph's vertices, and text.
//
// The context is in points with y down, as a canvas has it: the app's views
// hand one over as they are, and a bitmap context is flipped first. It must
// be a layer of its own over the graph (a SwiftUI Canvas is; a bitmap that
// already holds the shader passes opens a transparency layer first), because
// a panel clears its box before it draws, as the site's separate canvas does.

/// Arrowhead length for vector(…) rows, in points.
let arrowHeadPx = 12.0

/// A graph vertex's radius in points.
public let graphNodePx = 13.0

/// Below this many points per cell, lattice values are not printed.
public let latticeValuePx = 18.0

/// A coordinate as JSON carries one: a number, or `null` for NaN, as
/// JavaScript writes a gap; `"Infinity"` and `"-Infinity"` for the edges a
/// mapped bar stands on, which JSON has no number for.
@propertyWrapper
public struct JSNumber: Equatable, Codable, Sendable {
  public var wrappedValue: Double

  public init(wrappedValue: Double) {
    self.wrappedValue = wrappedValue
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      wrappedValue = .nan
    } else if let text = try? container.decode(String.self) {
      wrappedValue = text == "Infinity" ? .infinity : text == "-Infinity" ? -.infinity : .nan
    } else {
      wrappedValue = try container.decode(Double.self)
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    if wrappedValue.isFinite {
      try container.encode(wrappedValue)
    } else if wrappedValue.isNaN {
      try container.encodeNil()
    } else {
      try container.encode(wrappedValue > 0 ? "Infinity" : "-Infinity")
    }
  }
}

/// A list of coordinates, each as `JSNumber` writes it (a JavaScript
/// `number[]` or `Float64Array`).
@propertyWrapper
public struct JSNumbers: Equatable, Codable, Sendable {
  public var wrappedValue: [Double]

  public init(wrappedValue: [Double]) {
    self.wrappedValue = wrappedValue
  }

  public init(from decoder: any Decoder) throws {
    wrappedValue = try decoder.singleValueContainer().decode([JSNumber].self).map(\.wrappedValue)
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(wrappedValue.map(JSNumber.init))
  }
}

/// The CPU-sampled geometry of a panel (web/render2d.ts `Overlay2D`), in math
/// coordinates.
public struct Overlay2D: Equatable, Codable, Sendable {
  /// hot: pointer is over it (or dragging it) — drawn with a grab halo.
  /// label: text drawn beside the point (a named point's name).
  /// r: dot radius in points (sequence/list dots draw slightly smaller).
  /// bare: no outline — in a dense scatter the outlines of later dots paint
  /// over the fill of earlier ones, turning the whole trace the outline
  /// colour.
  public struct Point: Equatable, Codable, Sendable {
    @JSNumber public var x: Double
    @JSNumber public var y: Double
    public var color: CSSColor
    public var hot: Bool?
    public var label: String?
    public var r: Double?
    public var bare: Bool?

    public init(
      x: Double, y: Double, color: CSSColor, hot: Bool? = nil, label: String? = nil, r: Double? = nil,
      bare: Bool? = nil
    ) {
      self.x = x
      self.y = y
      self.color = color
      self.hot = hot
      self.label = label
      self.r = r
      self.bare = bare
    }
  }

  /// A bulk scatter (CSV columns): drawn as plain squares under everything
  /// else, since at these counts a dot is a pixel.
  public struct Cloud: Equatable, Codable, Sendable {
    @JSNumbers public var xs: [Double]
    @JSNumbers public var ys: [Double]
    public var color: CSSColor
    public var r: Double?

    public init(xs: [Double], ys: [Double], color: CSSColor, r: Double? = nil) {
      self.xs = xs
      self.ys = ys
      self.color = color
      self.r = r
    }
  }

  /// `pts` is x, y pairs; a pair that is not finite breaks the line. closed
  /// joins the last vertex back to the first; fill (usually translucent)
  /// paints the enclosed region when every vertex is finite. arrow puts a
  /// head at the last vertex, sized in points so it does not scale with
  /// zoom. noStroke fills only (the outline is its own entry).
  public struct Polyline: Equatable, Codable, Sendable {
    @JSNumbers public var pts: [Double]
    public var color: CSSColor
    public var closed: Bool?
    public var fill: CSSColor?
    public var width: Double?
    public var arrow: Bool?
    public var noStroke: Bool?

    public init(
      pts: [Double], color: CSSColor, closed: Bool? = nil, fill: CSSColor? = nil, width: Double? = nil,
      arrow: Bool? = nil, noStroke: Bool? = nil
    ) {
      self.pts = pts
      self.color = color
      self.closed = closed
      self.fill = fill
      self.width = width
      self.arrow = arrow
      self.noStroke = noStroke
    }
  }

  /// A filled parametric region: triangles [x0, y0, x1, y1, x2, y2, …], all
  /// counter-clockwise (lib/path.ts regionSampler), filled as one path by the
  /// nonzero rule, so overlaps show once. No outline.
  public struct Region: Equatable, Codable, Sendable {
    @JSNumbers public var tris: [Double]
    public var fill: CSSColor

    public init(tris: [Double], fill: CSSColor) {
      self.tris = tris
      self.fill = fill
    }
  }

  /// A vertical bar from y = 0, or from `base` (±infinity: the window's
  /// bottom or top edge; in JSON `"-Infinity"` and `"Infinity"`), halfWidth
  /// in math units (histograms).
  public struct Bar: Equatable, Codable, Sendable {
    @JSNumber public var x: Double
    @JSNumber public var y: Double
    public var halfWidth: Double
    public var color: CSSColor
    public var base: Double? {
      get { baseNumber?.wrappedValue }
      set { baseNumber = newValue.map(JSNumber.init) }
    }
    private var baseNumber: JSNumber?

    private enum CodingKeys: String, CodingKey {
      case x, y, halfWidth, color
      case baseNumber = "base"
    }

    public init(x: Double, y: Double, halfWidth: Double, color: CSSColor, base: Double? = nil) {
      self.x = x
      self.y = y
      self.halfWidth = halfWidth
      self.color = color
      self.baseNumber = base.map(JSNumber.init)
    }
  }

  /// Text at a math point: a `label(point, "text")` row's, drawn beside it
  /// above everything, or a tag's, small and centred on it.
  public struct Text: Equatable, Codable, Sendable {
    @JSNumber public var x: Double
    @JSNumber public var y: Double
    public var text: String
    public var color: CSSColor

    public init(x: Double, y: Double, text: String, color: CSSColor) {
      self.x = x
      self.y = y
      self.text = text
      self.color = color
    }
  }

  /// A graph's vertex (lib/graph.ts): a ring of `graphNodePx` with the
  /// vertex's value in it, filled in its colour when marked (`mark(v)`).
  public struct Node: Equatable, Codable, Sendable {
    @JSNumber public var x: Double
    @JSNumber public var y: Double
    public var text: String
    public var color: CSSColor
    public var mark: Bool?

    public init(x: Double, y: Double, text: String, color: CSSColor, mark: Bool? = nil) {
      self.x = x
      self.y = y
      self.text = text
      self.color = color
      self.mark = mark
    }
  }

  /// Many small glyphs, each list one path (light cones, lib/light-cone.ts
  /// coneGlyphs): `rings` closed, filled with `fill` and outlined; `lines`
  /// stroked thinly; runs of both end with NaN, NaN. `dots` are x, y pairs,
  /// drawn as discs. `lineWidth` and `lineAlpha` make the strokes bolder
  /// (tidal glyphs, lib/tidal.ts: solid bars).
  public struct Glyph: Equatable, Codable, Sendable {
    @JSNumbers public var rings: [Double]
    @JSNumbers public var lines: [Double]
    @JSNumbers public var dots: [Double]
    public var color: CSSColor
    public var fill: CSSColor
    public var lineWidth: Double?
    public var lineAlpha: Double?

    public init(
      rings: [Double] = [], lines: [Double] = [], dots: [Double] = [], color: CSSColor, fill: CSSColor,
      lineWidth: Double? = nil, lineAlpha: Double? = nil
    ) {
      self.rings = rings
      self.lines = lines
      self.dots = dots
      self.color = color
      self.fill = fill
      self.lineWidth = lineWidth
      self.lineAlpha = lineAlpha
    }
  }

  public var points: [Point]
  public var clouds: [Cloud]?
  public var polylines: [Polyline]
  public var regions: [Region]?
  public var bars: [Bar]?
  /// `label(point, "text")` rows: text beside a math point, drawn above everything.
  public var texts: [Text]?
  public var nodes: [Node]?
  /// Small text centred on a math point, haloed: a graph edge's labels.
  public var tags: [Text]?
  public var glyphs: [Glyph]?

  public init(
    points: [Point] = [], clouds: [Cloud]? = nil, polylines: [Polyline] = [], regions: [Region]? = nil,
    bars: [Bar]? = nil, texts: [Text]? = nil, nodes: [Node]? = nil, tags: [Text]? = nil, glyphs: [Glyph]? = nil
  ) {
    self.points = points
    self.clouds = clouds
    self.polylines = polylines
    self.regions = regions
    self.bars = bars
    self.texts = texts
    self.nodes = nodes
    self.tags = tags
    self.glyphs = glyphs
  }

  private enum CodingKeys: String, CodingKey {
    case points, clouds, polylines, regions, bars, texts, nodes, tags, glyphs
  }

  // The site's `points` and `polylines` are always there; a scene written by
  // hand may leave either out.
  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    points = try c.decodeIfPresent([Point].self, forKey: .points) ?? []
    clouds = try c.decodeIfPresent([Cloud].self, forKey: .clouds)
    polylines = try c.decodeIfPresent([Polyline].self, forKey: .polylines) ?? []
    regions = try c.decodeIfPresent([Region].self, forKey: .regions)
    bars = try c.decodeIfPresent([Bar].self, forKey: .bars)
    texts = try c.decodeIfPresent([Text].self, forKey: .texts)
    nodes = try c.decodeIfPresent([Node].self, forKey: .nodes)
    tags = try c.decodeIfPresent([Text].self, forKey: .tags)
    glyphs = try c.decodeIfPresent([Glyph].self, forKey: .glyphs)
  }
}

/// Where an overlay's lists end, so what one row adds can be told apart.
public struct OverlayMark: Equatable, Sendable {
  public var points: Int
  public var clouds: Int
  public var polylines: Int
  public var regions: Int
  public var texts: Int
  public var bars: Int
}

public func markOverlay(_ o: Overlay2D) -> OverlayMark {
  OverlayMark(
    points: o.points.count, clouds: o.clouds?.count ?? 0, polylines: o.polylines.count,
    regions: o.regions?.count ?? 0, texts: o.texts?.count ?? 0, bars: o.bars?.count ?? 0)
}

/// A panel's box on the overlay, in points from the top-left corner.
public struct OverlayBox: Equatable, Codable, Sendable {
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

/// What a lattice panel labels (docs/discrete.md).
public struct LatticeLabels: Equatable, Codable, Sendable {
  /// The index names across and down, as the view row or the rows name them.
  public var axes: [String]
  /// Values to print in their cells (cell (i, k)), once cells are big enough to read.
  public var values: [Value]?
  /// A corner note, like which generation a board shows.
  public var status: String?

  public struct Value: Equatable, Codable, Sendable {
    public var i: Double
    public var k: Double
    public var text: String

    public init(i: Double, k: Double, text: String) {
      self.i = i
      self.k = k
      self.text = text
    }
  }

  public init(axes: [String] = ["x", "y"], values: [Value]? = nil, status: String? = nil) {
    self.axes = axes
    self.values = values
    self.status = status
  }
}

/// web/render2d.ts `latticeSpacing`: a lattice panel's grid has its majors
/// every 1, 2, 5 × 10^k cells, and the edge of every cell once cells are big
/// enough to see apart.
public func latticeSpacing(_ upp: Double) -> (major: Double, minor: Double) {
  let major = max(1, niceSpacing(upp, 90).major)
  return (major, 1 / upp >= 6 ? 1 : major)
}

/// lib/geom.ts `arrowHead`: the triangle at the tip of the segment (x0, y0) →
/// (x1, y1), `size` long (or the segment's length, when shorter), and where
/// the shaft stops inside it.
struct ArrowHead {
  var tip: CGPoint
  var left: CGPoint
  var right: CGPoint
  var shaftEnd: CGPoint
}

func arrowHead(_ x0: Double, _ y0: Double, _ x1: Double, _ y1: Double, _ size: Double) -> ArrowHead? {
  let len = hypot(x1 - x0, y1 - y0)
  guard len > 0, len.isFinite else { return nil }
  let (ux, uy) = ((x1 - x0) / len, (y1 - y0) / len)
  let h = min(size, len)
  let w = h * 0.4  // half-width: a 2.5:2 head, slim enough to read as a direction
  let (bx, by) = (x1 - ux * h, y1 - uy * h)
  return ArrowHead(
    tip: CGPoint(x: x1, y: y1), left: CGPoint(x: bx - uy * w, y: by + ux * w),
    right: CGPoint(x: bx + uy * w, y: by - ux * w), shaftEnd: CGPoint(x: bx + ux * h * 0.25, y: by + uy * h * 0.25))
}

/// Save the overlay and set it up for one panel: the panel's corner at the
/// origin and everything clipped to its box (web/render2d.ts `beginOverlay`;
/// the context is in points already). Without a box the whole overlay,
/// `size`, is the panel and is cleared first. A split view clears the overlay
/// once per frame, before its panels draw, and each panel clears its own box
/// too, so an inset hides what its host drew beneath it. The caller restores
/// the context when the panel is drawn.
@discardableResult
public func beginOverlay(_ ctx: CGContext, size: CGSize, box: OverlayBox? = nil) -> (w: Double, h: Double) {
  ctx.saveGState()
  guard let box else {
    ctx.clear(CGRect(origin: .zero, size: size))
    return (Double(size.width), Double(size.height))
  }
  ctx.translateBy(x: box.x, y: box.y)
  ctx.clip(to: CGRect(x: 0, y: 0, width: box.w, height: box.h))
  ctx.clear(CGRect(x: 0, y: 0, width: box.w, height: box.h))
  return (box.w, box.h)
}

/// An axis numeral: plain to ten significant digits, 1e5 and 2e-5 beyond.
public func axisLabel(_ v: Double) -> String {
  if v == 0 { return "0" }
  let a = abs(v)
  if a >= 1e5 || a < 1e-4 {
    // toExponential(0), with `e+` as `e`.
    var exponent = Int(floor(log10(a)))
    var mantissa = (v / pow(10, Double(exponent))).rounded()
    if abs(mantissa) >= 10 {
      mantissa /= 10
      exponent += 1
    }
    return "\(Int(mantissa))e\(exponent)"
  }
  // String(parseFloat(v.toPrecision(10)))
  let text = "\(Double(String(format: "%.9e", v)) ?? v)"
  return text.hasSuffix(".0") ? String(text.dropLast(2)) : text
}

/// The panel's linear maps between the plane and the screen, in points.
private struct Screen {
  var view: View2D
  var w: Double
  var h: Double
  /// Math units per point, across and up.
  var upp: Double
  var uppY: Double

  @inline(__always) func x(_ x: Double) -> Double { (x - view.cx) / upp + w / 2 }
  @inline(__always) func y(_ y: Double) -> Double { h / 2 - (y - view.cy) / uppY }
}

/// A lattice panel's labels: cell values in their cells, the column indices
/// along the top edge and the row indices down the left (cell centres, at
/// the grid's major spacing), and the axis names in the corner.
private func drawLatticeLabels(
  _ ctx: CGContext, _ lattice: LatticeLabels, numbers: Bool, screen s: Screen, theme: GraphTheme
) {
  let (w, h) = (s.w, s.h)
  let cell = min(1 / s.upp, 1 / s.uppY)
  let halo = (color: cssRgb(theme.bg), width: 3.0)
  let ink = cgColor(theme.label)
  if let values = lattice.values, !values.isEmpty, cell >= latticeValuePx {
    let font = overlayFont(min(15, max(9, cell * 0.38)))
    for v in values {
      let (sx, sy) = (s.x(v.i), s.y(-v.k))
      if sx < -cell || sx > w + cell || sy < -cell || sy > h + cell { continue }
      drawText(ctx, v.text, x: sx, y: sy, font: font, fill: ink, stroke: halo, align: .center, baseline: .middle)
    }
  }
  let font = overlayFont()
  func label(_ text: String, _ x: Double, _ y: Double, _ align: TextAlign = .left) {
    drawText(ctx, text, x: x, y: y, font: font, fill: ink, stroke: halo, align: align)
  }
  if numbers {
    // The grid's own spacing (device px), so every number sits on a major line.
    let major = latticeSpacing(s.view.upp).major
    let majorY = latticeSpacing(s.view.uppY).major
    // The plane coordinate at the screen's left and top edges (the site's invX, invY).
    let left = ((s.view.cx - w / 2 * s.upp) / major).rounded(.up) * major
    // No window has room for a thousand labels; the bound stops a walk that cannot advance.
    for n in 0..<1000 {
      let i = left + Double(n) * major
      let sx = s.x(i)
      if !(sx < w) { break }
      if sx > 24 { label(jsNumber(i), sx, 13, .center) }
    }
    let top = (-(s.view.cy + h / 2 * s.uppY) / majorY).rounded(.up) * majorY
    for n in 0..<1000 {
      let k = top + Double(n) * majorY
      let sy = s.y(-k)
      if !(sy < h) { break }
      if sy > 24, sy < h - 24 { label(jsNumber(k), 4, sy + 4) }
    }
  }
  // The corner note sits bottom left, clear of the equation panel.
  let corner = "\(lattice.axes.first ?? "x") → \(lattice.axes.dropFirst().first ?? "y") ↓"
  label(lattice.status.map { $0.isEmpty ? corner : "\(corner)    \($0)" } ?? corner, 6, h - 8)
}

/// Axis labels plus CPU-sampled geometry (points, parametric curves):
/// web/render2d.ts `drawLabels2D`. `size` is the whole overlay's, in points,
/// and `dpr` is device pixels per point. numbers = false skips the axis
/// numerals (custom coordinate grids have no straight axes to label them
/// along). A lattice panel numbers its cells instead, along the top and left
/// edges. A mapped axis is labelled at its ticks, in its own units.
public func drawLabels2D(
  _ ctx: CGContext, size: CGSize, view: View2D, dpr: Double, theme: GraphTheme, extras: Overlay2D? = nil,
  numbers: Bool = true, box: OverlayBox? = nil, lattice: LatticeLabels? = nil, maps: AxisMaps = AxisMaps()
) {
  let (w, h) = beginOverlay(ctx, size: size, box: box)
  defer { ctx.restoreGState() }
  let upp = view.upp * dpr  // math units per point
  let uppY = upp / (view.ratio ?? 1)
  guard w > 0, h > 0, upp > 0, uppY > 0, upp.isFinite, uppY.isFinite else { return }
  let s = Screen(view: view, w: w, h: h, upp: upp, uppY: uppY)

  if let lattice {
    drawLatticeLabels(ctx, lattice, numbers: numbers, screen: s, theme: theme)
  } else if numbers {
    drawAxisNumbers(ctx, screen: s, dpr: dpr, maps: maps, theme: theme)
  }
  if let extras { drawExtras(ctx, extras, screen: s, dpr: dpr, theme: theme) }
}

/// The numbers along the axes: at each major grid line, beside the axis, or
/// along the edge once the axis is off screen.
private func drawAxisNumbers(_ ctx: CGContext, screen s: Screen, dpr: Double, maps: AxisMaps, theme: GraphTheme) {
  let (w, h, view) = (s.w, s.h, s.view)
  let major = niceSpacing(view.upp, 90).major
  let majorY = niceSpacing(view.uppY, 90).major
  let font = overlayFont()
  let color = cgColor(theme.label)
  // A mapped axis is labelled at its ticks, in its own units; its zero
  // (none on a log axis) is where the other axis's labels run, or else
  // they run along the panel's edge.
  let ticks = mappedTicks(view, w * dpr, h * dpr, maps)
  let zeroX = maps.x != nil ? ticks.x?.zero ?? -.infinity : 0
  let zeroY = maps.y != nil ? ticks.y?.zero ?? -.infinity : 0
  let axisY = min(max(s.y(zeroY), 12), h - 6)
  let axisX = min(max(s.x(zeroX), 4), w - 30)
  func xLabel(_ x: Double, at: Double) {
    fillText(ctx, axisLabel(x), x: s.x(at) + 2, y: axisY + 13 <= h ? axisY + 13 : axisY - 4, font: font, color: color)
  }
  func yLabel(_ y: Double, at: Double) {
    fillText(ctx, axisLabel(y), x: axisX + 4, y: s.y(at) - 3, font: font, color: color)
  }
  /// The multiples of `step` between two edges, but zero. The site adds
  /// `step` to a running sum; a multiple is the nearer number.
  func multiples(from low: Double, to high: Double, step: Double) -> [Double] {
    guard step > 0, step.isFinite else { return [] }
    let first = (low / step).rounded(.up)
    let count = min(max(Int((high / step).rounded(.down) - first) + 1, 0), 400)
    return (0..<count).map { (first + Double($0)) * step }.filter { abs($0) >= step / 2 }
  }
  if let ticks = ticks.x {
    for t in ticks.major where t.value != 0 { xLabel(t.value, at: t.at) }
  } else {
    for x in multiples(from: view.cx - w / 2 * s.upp, to: view.cx + w / 2 * s.upp, step: major) { xLabel(x, at: x) }
  }
  if let ticks = ticks.y {
    for t in ticks.major where t.value != 0 { yLabel(t.value, at: t.at) }
  } else {
    for y in multiples(from: view.cy - h / 2 * s.uppY, to: view.cy + h / 2 * s.uppY, step: majorY) {
      yLabel(y, at: y)
    }
  }
}

/// A glyph list as one path: runs end at a NaN, and a ring is closed by a
/// line back to its start.
private func trace(_ pts: [Double], close: Bool, screen s: Screen) -> CGPath {
  let path = CGMutablePath()
  var pen = false
  var start = CGPoint.zero
  var i = 0
  while i + 1 < pts.count {
    defer { i += 2 }
    if pts[i].isNaN {
      if pen, close { path.addLine(to: start) }
      pen = false
      continue
    }
    let p = CGPoint(x: s.x(pts[i]), y: s.y(pts[i + 1]))
    if pen {
      path.addLine(to: p)
    } else {
      path.move(to: p)
      start = p
    }
    pen = true
  }
  if pen, close { path.addLine(to: start) }
  return path
}

/// Up to this many points a cloud is filled a square at a time.
private let cloudMaskFrom = 2000

/// A data cloud: one color, one square per point, and off-screen points
/// skipped. A CSV column can be 100k points, which the site hands its canvas
/// as 100k `fillRect`s; CoreGraphics takes tens of milliseconds over the
/// same (and seconds over them as one list or one path). So a big cloud is
/// painted here instead, each square onto a mask of the panel's device
/// pixels, and the mask is filled once: a few milliseconds whatever the
/// count. The squares land on whole pixels, their antialiased edges gone,
/// which at these counts is not seen, and where they overlap the color is
/// laid down once (a cloud's color is opaque, so it is the same picture).
private func drawCloud(_ ctx: CGContext, _ cloud: Overlay2D.Cloud, screen s: Screen, dpr: Double) {
  let (w, h) = (s.w, s.h)
  let r = cloud.r ?? 1.5
  let d = r * 2
  let count = min(cloud.xs.count, cloud.ys.count)
  ctx.setFillColor(cloud.color.cgColor)
  let (mw, mh) = (Int((w * dpr).rounded(.up)), Int((h * dpr).rounded(.up)))
  guard count > cloudMaskFrom, mw > 0, mh > 0, mw * mh <= 1 << 26 else {
    for i in 0..<count {
      let (sx, sy) = (s.x(cloud.xs[i]), s.y(cloud.ys[i]))
      // NaN fails every comparison, so gaps in the data fall out here too.
      if !(sx > -d && sx < w + d && sy > -d && sy < h + d) { continue }
      ctx.fill(CGRect(x: sx - r, y: sy - r, width: d, height: d))
    }
    return
  }
  var mask = Data(count: mw * mh)
  mask.withUnsafeMutableBytes { (mask: UnsafeMutableRawBufferPointer) in
    cloud.xs.withUnsafeBufferPointer { xs in
      cloud.ys.withUnsafeBufferPointer { ys in
        for i in 0..<count {
          let (sx, sy) = (s.x(xs[i]), s.y(ys[i]))
          if !(sx > -d && sx < w + d && sy > -d && sy < h + d) { continue }
          let x0 = max(Int(((sx - r) * dpr).rounded()), 0)
          let x1 = min(Int(((sx + r) * dpr).rounded()), mw)
          let y0 = max(Int(((sy - r) * dpr).rounded()), 0)
          let y1 = min(Int(((sy + r) * dpr).rounded()), mh)
          if x0 >= x1 { continue }
          // An image is drawn y up, and the context counts y down: the mask's rows run from the bottom.
          for y in y0..<max(y0, y1) { memset(mask.baseAddress! + (mh - 1 - y) * mw + x0, 255, x1 - x0) }
        }
      }
    }
  }
  guard let provider = CGDataProvider(data: mask as CFData),
    let image = CGImage(
      width: mw, height: mh, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: mw,
      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
      provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
  else { return }
  let frame = CGRect(x: 0, y: 0, width: Double(mw) / dpr, height: Double(mh) / dpr)
  ctx.saveGState()
  ctx.clip(to: frame, mask: image)
  ctx.fill(frame)
  ctx.restoreGState()
}

private func drawExtras(_ ctx: CGContext, _ extras: Overlay2D, screen s: Screen, dpr: Double, theme: GraphTheme) {
  let (w, h) = (s.w, s.h)
  let outline = cgColor(theme.pointOutline)

  // Data clouds first and in bulk, under everything else.
  for cloud in extras.clouds ?? [] { drawCloud(ctx, cloud, screen: s, dpr: dpr) }

  for bar in extras.bars ?? [] {
    let sx = s.x(bar.x)
    // A base past the window's edge (a log axis's y = 0) is just beyond it.
    let sy0 = min(max(s.y(bar.base ?? 0), -2), h + 2)
    let sy = s.y(bar.y)
    if !sx.isFinite || !sy.isFinite || !sy0.isFinite { continue }
    let hw = bar.halfWidth / s.upp
    let rect = CGRect(x: sx - hw, y: min(sy0, sy), width: hw * 2, height: abs(sy - sy0))
    let color = bar.color
    ctx.setFillColor(CSSColor(r: color.r, g: color.g, b: color.b, a: color.a * 0.3).cgColor)
    ctx.fill(rect)
    ctx.setStrokeColor(color.cgColor)
    ctx.stroke(rect, width: 1.5)
  }

  for region in extras.regions ?? [] {
    let path = CGMutablePath()
    let tris = region.tris
    var i = 0
    while i + 5 < tris.count {
      path.move(to: CGPoint(x: s.x(tris[i]), y: s.y(tris[i + 1])))
      path.addLine(to: CGPoint(x: s.x(tris[i + 2]), y: s.y(tris[i + 3])))
      path.addLine(to: CGPoint(x: s.x(tris[i + 4]), y: s.y(tris[i + 5])))
      path.closeSubpath()
      i += 6
    }
    ctx.addPath(path)
    ctx.setFillColor(region.fill.cgColor)
    ctx.fillPath(using: .winding)
  }

  for glyph in extras.glyphs ?? [] {
    // One path each, so a lattice of hundreds costs a fill and two strokes.
    ctx.setLineJoin(.round)
    ctx.setLineCap(.round)
    if !glyph.rings.isEmpty {
      let rings = trace(glyph.rings, close: true, screen: s)
      ctx.addPath(rings)
      ctx.setFillColor(glyph.fill.cgColor)
      ctx.fillPath()
      ctx.addPath(rings)
      ctx.setStrokeColor(glyph.color.cgColor)
      ctx.setLineWidth(1.25)
      ctx.strokePath()
    }
    if !glyph.lines.isEmpty {
      ctx.setAlpha(glyph.lineAlpha ?? 0.55)
      ctx.addPath(trace(glyph.lines, close: false, screen: s))
      ctx.setStrokeColor(glyph.color.cgColor)
      ctx.setLineWidth(glyph.lineWidth ?? 1)
      ctx.strokePath()
      ctx.setAlpha(1)
    }
    if !glyph.dots.isEmpty {
      var i = 0
      while i + 1 < glyph.dots.count {
        let (sx, sy) = (s.x(glyph.dots[i]), s.y(glyph.dots[i + 1]))
        if sx.isFinite, sy.isFinite { ctx.addEllipse(in: CGRect(x: sx - 1.75, y: sy - 1.75, width: 3.5, height: 3.5)) }
        i += 2
      }
      ctx.setFillColor(glyph.color.cgColor)
      ctx.fillPath()
    }
    ctx.setLineCap(.butt)
  }

  for line in extras.polylines {
    let pts = line.pts
    let n = pts.count
    var head: ArrowHead?
    if line.arrow == true, n >= 4 {
      head = arrowHead(s.x(pts[n - 4]), s.y(pts[n - 3]), s.x(pts[n - 2]), s.y(pts[n - 1]), arrowHeadPx)
    }
    let path = CGMutablePath()
    var pen = false
    var broken = false
    var i = 0
    while i + 1 < n {
      defer { i += 2 }
      // The shaft stops inside the head, so the tip stays sharp.
      var p = CGPoint(x: s.x(pts[i]), y: s.y(pts[i + 1]))
      if let head, i + 2 >= n { p = head.shaftEnd }
      if !p.x.isFinite || !p.y.isFinite {
        pen = false
        broken = true
        continue
      }
      if pen {
        path.addLine(to: p)
      } else {
        path.move(to: p)
        pen = true
      }
    }
    if line.closed == true, pen, !broken { path.closeSubpath() }
    if let fill = line.fill, !broken {
      ctx.addPath(path)
      ctx.setFillColor(fill.cgColor)
      ctx.fillPath()
    }
    if line.noStroke != true {
      ctx.addPath(path)
      ctx.setStrokeColor(line.color.cgColor)
      ctx.setLineWidth(line.width ?? 2.25)
      ctx.setLineJoin(.round)
      ctx.strokePath()
    }
    if let head {
      ctx.move(to: head.tip)
      ctx.addLine(to: head.left)
      ctx.addLine(to: head.right)
      ctx.closePath()
      ctx.setFillColor(line.color.cgColor)
      ctx.fillPath()
    }
  }

  var labelFont: CTFont?
  for pt in extras.points {
    let (sx, sy) = (s.x(pt.x), s.y(pt.y))
    if !sx.isFinite || !sy.isFinite { continue }
    let color = pt.color.cgColor
    if pt.hot == true {
      // A ring, not a wash: a translucent disc in the point's own color
      // disappears into a field drawn in that same color.
      let ring = CGRect(x: sx - 10, y: sy - 10, width: 20, height: 20)
      ctx.setLineWidth(2)
      ctx.setStrokeColor(outline)
      ctx.strokeEllipse(in: ring)
      ctx.setLineWidth(1.5)
      ctx.setStrokeColor(color)
      ctx.strokeEllipse(in: ring)
    }
    let r = pt.r ?? 5
    let dot = CGRect(x: sx - r, y: sy - r, width: 2 * r, height: 2 * r)
    ctx.setFillColor(color)
    ctx.fillEllipse(in: dot)
    if pt.bare != true {
      ctx.setLineWidth(r < 4 ? 1.25 : 2)
      ctx.setStrokeColor(outline)
      ctx.strokeEllipse(in: dot)
    }
    if let label = pt.label, !label.isEmpty {
      let font = labelFont ?? overlayFont(12, weight: .bold)
      labelFont = font
      fillText(ctx, label, x: sx + 8, y: sy - 8, font: font, color: color)
    }
  }

  if !(extras.nodes ?? []).isEmpty || !(extras.tags ?? []).isEmpty {
    let bg = cssRgb(theme.bg)
    let tagFont = overlayFont(12)
    for tag in extras.tags ?? [] {
      let (sx, sy) = (s.x(tag.x), s.y(tag.y))
      if !sx.isFinite || !sy.isFinite { continue }
      drawText(
        ctx, tag.text, x: sx, y: sy, font: tagFont, fill: tag.color.cgColor, stroke: (bg, 4), align: .center,
        baseline: .middle)
    }
    let nodeFont = overlayFont(12, weight: .semibold)
    for node in extras.nodes ?? [] {
      let (sx, sy) = (s.x(node.x), s.y(node.y))
      if !sx.isFinite || !sy.isFinite { continue }
      let marked = node.mark == true
      let ring = CGRect(x: sx - graphNodePx, y: sy - graphNodePx, width: 2 * graphNodePx, height: 2 * graphNodePx)
      ctx.setFillColor(marked ? node.color.cgColor : bg)
      ctx.fillEllipse(in: ring)
      ctx.setLineWidth(marked ? 3 : 1.75)
      ctx.setStrokeColor(node.color.cgColor)
      ctx.strokeEllipse(in: ring)
      drawText(
        ctx, node.text, x: sx, y: sy + 0.5, font: nodeFont, fill: marked ? bg : node.color.cgColor, align: .center,
        baseline: .middle)
    }
  }

  for label in extras.texts ?? [] {
    let (sx, sy) = (s.x(label.x), s.y(label.y))
    if sx.isFinite, sy.isFinite { drawTextLabel(ctx, label.text, sx: sx, sy: sy, color: label.color, theme: theme) }
  }
}
