import CoreGraphics
import CoreText
import Foundation

// What is drawn over a 3D frame with a 2D context: web/render3d.ts
// `drawLabels3D`. The context is in points with y down, as Overlay2D's.

/// The system font at `size`, slanted or heavier: the site's `italic 13px`
/// and `600 13px ui-sans-serif, system-ui`.
private func labelFont(_ size: CGFloat, italic: Bool = false, weight: CGFloat = 0) -> CTFont {
  var traits: [CFString: Any] = [kCTFontWeightTrait: weight]
  if italic { traits[kCTFontSymbolicTrait] = CTFontSymbolicTraits.traitItalic.rawValue }
  let descriptor = CTFontDescriptorCreateWithAttributes([kCTFontTraitsAttribute: traits] as CFDictionary)
  return CTFontCreateCopyWithAttributes(overlayFont(size), size, nil, descriptor)
}

/// A label's text beside its anchor, haloed in the page background so it
/// stays legible across curves and gridlines (web/render2d.ts `drawTextLabel`).
func drawTextLabel(_ ctx: CGContext, _ text: String, _ sx: Double, _ sy: Double, color: RGB, theme: GraphTheme) {
  let font = labelFont(13, weight: 0.3)
  // The halo: the text's outline, four points wide with round joins.
  let attributes: [CFString: Any] = [kCTFontAttributeName: font, kCTForegroundColorFromContextAttributeName: true]
  let line = CTLineCreateWithAttributedString(
    CFAttributedStringCreate(nil, text as CFString, attributes as CFDictionary)!)
  ctx.saveGState()
  ctx.setLineJoin(.round)
  ctx.setLineWidth(4)
  ctx.setStrokeColor(cgColor(theme.bg))
  ctx.setTextDrawingMode(.stroke)
  ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
  ctx.textPosition = CGPoint(x: sx + 8, y: sy - 8)
  CTLineDraw(line, ctx)
  ctx.restoreGState()
  fillText(ctx, text, x: sx + 8, y: sy - 8, font: font, color: cgColor(color))
}

/// Project axis-end labels (x, y, z), the points' names and the text labels
/// onto the overlay. `box` is the panel's, in points from the context's
/// origin; nothing is drawn outside it.
public func drawLabels3D(
  _ ctx: CGContext, box: CGRect, cam: Camera3D, points: [Scene3D.Point] = [], texts: [Scene3D.Text] = [],
  theme: GraphTheme, axes: Bool = true
) {
  let w = Double(box.width)
  let h = Double(box.height)
  guard w > 0, h > 0 else { return }
  ctx.saveGState()
  defer { ctx.restoreGState() }
  ctx.clip(to: box)
  ctx.translateBy(x: box.minX, y: box.minY)
  let vp = cameraMatrices(cam, w / h).vp
  let boxR = cameraBoxR(cam)
  let font = labelFont(13, italic: true)
  let hex = { (r: Float, g: Float, b: Float) in RGB(r, g, b) / 15 }
  var labels: [(text: String, at: SIMD3<Double>, color: RGB, dot: Bool)] = []
  if axes {
    labels += [
      ("x", [boxR * 1.04, 0, 0], hex(0xa, 0x4, 0x4), false),
      ("y", [0, boxR * 1.04, 0], hex(0x4, 0xa, 0x4), false),
      ("z", [0, 0, boxR * 1.04], hex(0x4, 0x6, 0xa), false),
    ]
  }
  for p in points {
    if let label = p.label, !label.isEmpty { labels.append((label, p.pos, p.color, true)) }
  }
  for (text, p, color, dot) in labels {
    guard let at = projectToScreen(vp, p, w, h) else { continue }
    // Clear of the dot, which grows nearer the eye (see POINT_VERT): 7px
    // beside one of POINT_PX at the target distance.
    var off = 7.0
    if dot { off = 7 * min(max(cam.radius / viewDepth(vp, p), 0.6), POINT_MAX_PX / POINT_PX) }
    fillText(ctx, text, x: at.x + off, y: at.y - off, font: font, color: cgColor(color))
  }
  for label in texts {
    guard let at = projectToScreen(vp, label.pos, w, h) else { continue }
    drawTextLabel(ctx, label.text, at.x, at.y, color: label.color, theme: theme)
  }
}
