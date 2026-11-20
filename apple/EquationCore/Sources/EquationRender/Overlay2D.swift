import CoreGraphics
import CoreText
import Foundation

// What is drawn over the shader passes with a 2D context: web/render2d.ts
// `drawLabels2D` (the site's overlay canvas). The axis numbers are here; the
// rest of the overlay (points, polylines, clouds, bars, …) joins them as it
// is ported.
//
// The context is in points with y down, as a canvas has it: the app's views
// hand one over as they are, and a bitmap context is flipped first.

func cgColor(_ c: RGB, alpha: CGFloat = 1) -> CGColor {
  CGColor(srgbRed: CGFloat(c.x), green: CGFloat(c.y), blue: CGFloat(c.z), alpha: alpha)
}

/// The site's `11px ui-sans-serif, system-ui`.
func overlayFont(_ size: CGFloat = 11) -> CTFont {
  CTFontCreateUIFontForLanguage(.system, size, nil) ?? CTFontCreateWithName("Helvetica" as CFString, size, nil)
}

/// canvas `fillText`: `text` with its left end on the baseline at (x, y).
func fillText(_ ctx: CGContext, _ text: String, x: Double, y: Double, font: CTFont, color: CGColor) {
  let attributes: [CFString: Any] = [kCTFontAttributeName: font, kCTForegroundColorAttributeName: color]
  let line = CTLineCreateWithAttributedString(
    CFAttributedStringCreate(nil, text as CFString, attributes as CFDictionary)!)
  ctx.saveGState()
  // Text is drawn y up; the context counts y down.
  ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
  ctx.textPosition = CGPoint(x: x, y: y)
  CTLineDraw(line, ctx)
  ctx.restoreGState()
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

/// The numbers along the axes: at each major grid line, beside the axis, or
/// along the edge once the axis is off screen. `size` is the frame's, in
/// points; `dpr` is device pixels per point.
public func drawLabels2D(
  _ ctx: CGContext, size: CGSize, view: View2D, dpr: Double, theme: GraphTheme, numbers: Bool = true
) {
  let w = Double(size.width)
  let h = Double(size.height)
  let upp = view.upp * dpr  // math units per point
  let uppY = upp / (view.ratio ?? 1)
  let major = niceSpacing(view.upp, 90).major
  let majorY = niceSpacing(view.uppY, 90).major
  guard numbers, w > 0, h > 0, upp > 0, major > 0, majorY > 0, major.isFinite, majorY.isFinite else { return }
  let toScreenX = { (x: Double) in (x - view.cx) / upp + w / 2 }
  let toScreenY = { (y: Double) in h / 2 - (y - view.cy) / uppY }
  let font = overlayFont()
  let color = cgColor(theme.label)

  let axisY = min(max(toScreenY(0), 12), h - 6)
  let axisX = min(max(toScreenX(0), 4), w - 30)
  /// The multiples of `step` between two edges, but zero.
  func ticks(from low: Double, to high: Double, step: Double) -> [Double] {
    let first = (low / step).rounded(.up)
    let count = min(max(Int((high / step).rounded(.down) - first) + 1, 0), 400)
    return (0..<count).map { (first + Double($0)) * step }.filter { abs($0) >= step / 2 }
  }
  for x in ticks(from: view.cx - w / 2 * upp, to: view.cx + w / 2 * upp, step: major) {
    fillText(
      ctx, axisLabel(x), x: toScreenX(x) + 2, y: axisY + 13 <= h ? axisY + 13 : axisY - 4, font: font, color: color)
  }
  for y in ticks(from: view.cy - h / 2 * uppY, to: view.cy + h / 2 * uppY, step: majorY) {
    fillText(ctx, axisLabel(y), x: axisX + 4, y: toScreenY(y) - 3, font: font, color: color)
  }
}
