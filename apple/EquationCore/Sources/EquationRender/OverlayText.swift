import CoreGraphics
import CoreText
import EquationCore
import Foundation

// The canvas's colors and text, as the overlay (Overlay2D.swift) needs them:
// a CSS color string, `fillText` and `strokeText` with the canvas's
// `textAlign` and `textBaseline`, and the fonts the site names.

/// A color the overlay is handed: on the site a CSS string, `rgb(45, 112,
/// 179)` or `rgba(45, 112, 179, 0.16)` (web/main.ts `cssColor`, `cssColorA`),
/// or a hex one from the theme. Kept as numbers here, and written down as the
/// string, so an overlay in JSON is the site's.
public struct CSSColor: Equatable, Sendable, Codable, ExpressibleByStringLiteral {
  /// Each from 0 to 1.
  public var r: Double
  public var g: Double
  public var b: Double
  public var a: Double

  public init(r: Double, g: Double, b: Double, a: Double = 1) {
    self.r = r
    self.g = g
    self.b = b
    self.a = a
  }

  /// web/main.ts `cssColor` and `cssColorA`: a row's color, rounded to the
  /// 255ths a CSS string carries.
  public init(_ c: RGB, alpha: Double = 1) {
    self.init(
      r: Double((c.x * 255).rounded()) / 255, g: Double((c.y * 255).rounded()) / 255,
      b: Double((c.z * 255).rounded()) / 255, a: alpha)
  }

  /// `rgb(r, g, b)`, `rgba(r, g, b, a)`, `#rgb`, `#rrggbb` or `#rrggbbaa`; nil for anything else.
  public init?(css: String) {
    let text = css.trimmingCharacters(in: .whitespaces).lowercased()
    if text.hasPrefix("#") {
      var digits = Array(text.dropFirst())
      if digits.count == 3 || digits.count == 4 { digits = digits.flatMap { [$0, $0] } }
      guard digits.count == 6 || digits.count == 8, let value = UInt64(String(digits), radix: 16) else { return nil }
      let rgba = digits.count == 8 ? value : value << 8 | 0xff
      self.init(
        r: Double((rgba >> 24) & 0xff) / 255, g: Double((rgba >> 16) & 0xff) / 255,
        b: Double((rgba >> 8) & 0xff) / 255, a: Double(rgba & 0xff) / 255)
      return
    }
    guard text.hasPrefix("rgb"), let open = text.firstIndex(of: "("), text.hasSuffix(")") else { return nil }
    let parts = text[text.index(after: open)...].dropLast().split(separator: ",").map {
      Double($0.trimmingCharacters(in: .whitespaces))
    }
    guard parts.count == 3 || parts.count == 4, let r = parts[0], let g = parts[1], let b = parts[2] else { return nil }
    guard let a = parts.count == 4 ? parts[3] : 1 else { return nil }
    self.init(r: r / 255, g: g / 255, b: b / 255, a: a)
  }

  public init(stringLiteral value: String) {
    self = CSSColor(css: value) ?? CSSColor(r: 0, g: 0, b: 0)
  }

  public var css: String {
    let c = [r, g, b].map { Int(($0 * 255).rounded()) }
    return a == 1 ? "rgb(\(c[0]), \(c[1]), \(c[2]))" : "rgba(\(c[0]), \(c[1]), \(c[2]), \(JS.string(a)))"
  }

  public init(from decoder: any Decoder) throws {
    let text = try decoder.singleValueContainer().decode(String.self)
    guard let color = CSSColor(css: text) else {
      throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not a color: \(text)"))
    }
    self = color
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(css)
  }

  var cgColor: CGColor { CGColor(srgbRed: r, green: g, blue: b, alpha: a) }
}

func cgColor(_ c: RGB, alpha: CGFloat = 1) -> CGColor {
  CGColor(srgbRed: CGFloat(c.x), green: CGFloat(c.y), blue: CGFloat(c.z), alpha: alpha)
}

/// The site's `cssRgb(theme.bg)`: the page behind the graph, which halos text.
func cssRgb(_ c: RGB) -> CGColor { CSSColor(c).cgColor }

/// The site's `ui-sans-serif, system-ui` at a CSS weight: 400 as `11px` has
/// it, 600 and `bold`.
enum OverlayWeight: CGFloat {
  case regular = 0
  case semibold = 0.3
  case bold = 0.4
}

func overlayFont(_ size: CGFloat = 11, weight: OverlayWeight = .regular) -> CTFont {
  let base =
    CTFontCreateUIFontForLanguage(.system, size, nil) ?? CTFontCreateWithName("Helvetica" as CFString, size, nil)
  guard weight != .regular else { return base }
  let traits = [kCTFontWeightTrait: weight.rawValue] as CFDictionary
  let descriptor = CTFontDescriptorCreateCopyWithAttributes(
    CTFontCopyFontDescriptor(base), [kCTFontTraitsAttribute: traits] as CFDictionary)
  return CTFontCreateWithFontDescriptor(descriptor, size, nil)
}

/// canvas `textAlign`.
enum TextAlign {
  case left, center
}

/// canvas `textBaseline`: `middle` is the middle of the font's em box.
enum TextBaseline {
  case alphabetic, middle
}

/// canvas `strokeText` then `fillText` at (x, y): the halo (a round-joined
/// outline `width` wide, in `color`) under the text, when one is asked for.
/// Either may be left out.
func drawText(
  _ ctx: CGContext, _ text: String, x: Double, y: Double, font: CTFont, fill: CGColor?,
  stroke: (color: CGColor, width: Double)? = nil, align: TextAlign = .left, baseline: TextBaseline = .alphabetic
) {
  guard !text.isEmpty else { return }
  func line(_ attributes: [CFString: Any]) -> CTLine {
    CTLineCreateWithAttributedString(CFAttributedStringCreate(nil, text as CFString, attributes as CFDictionary)!)
  }
  var origin = CGPoint(x: x, y: y)
  if baseline == .middle { origin.y += (CTFontGetAscent(font) - CTFontGetDescent(font)) / 2 }
  var lines: [CTLine] = []
  if let stroke {
    // A stroke's width is a percentage of the font's size; positive, the glyphs are outlined and not filled.
    lines.append(
      line([
        kCTFontAttributeName: font, kCTStrokeColorAttributeName: stroke.color,
        kCTStrokeWidthAttributeName: 100 * stroke.width / Double(CTFontGetSize(font)),
      ]))
  }
  if let fill { lines.append(line([kCTFontAttributeName: font, kCTForegroundColorAttributeName: fill])) }
  if align == .center, let first = lines.first {
    origin.x -= CTLineGetTypographicBounds(first, nil, nil, nil) / 2
  }
  ctx.saveGState()
  ctx.setLineJoin(.round)
  // Text is drawn y up; the context counts y down.
  ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
  for line in lines {
    ctx.textPosition = origin
    CTLineDraw(line, ctx)
  }
  ctx.restoreGState()
}

/// canvas `fillText`: `text` with its left end on the baseline at (x, y).
func fillText(_ ctx: CGContext, _ text: String, x: Double, y: Double, font: CTFont, color: CGColor) {
  drawText(ctx, text, x: x, y: y, font: font, fill: color)
}

/// A label's text beside its anchor, haloed in the page background so it
/// stays legible across curves and gridlines (web/render2d.ts
/// `drawTextLabel`). Shared with the 3D overlay.
public func drawTextLabel(
  _ ctx: CGContext, _ text: String, sx: Double, sy: Double, color: CSSColor, theme: GraphTheme
) {
  drawText(
    ctx, text, x: sx + 8, y: sy - 8, font: overlayFont(13, weight: .semibold), fill: color.cgColor,
    stroke: (cssRgb(theme.bg), 4))
}
