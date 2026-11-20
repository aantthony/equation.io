import CoreGraphics
import CoreText
import Foundation

// What is drawn over a 3D frame with a 2D context: web/render3d.ts
// `drawLabels3D`. The context is in points with y down, as Overlay2D's.

/// The site's `italic 13px ui-sans-serif, system-ui`.
private func italicFont(_ size: CGFloat) -> CTFont {
  let font = overlayFont(size)
  return CTFontCreateCopyWithSymbolicTraits(font, size, nil, .traitItalic, .traitItalic) ?? font
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
  let font = italicFont(13)
  var labels: [(text: String, at: SIMD3<Double>, color: CSSColor, dot: Bool)] = []
  if axes {
    labels += [
      ("x", [boxR * 1.04, 0, 0], "#a44", false),
      ("y", [0, boxR * 1.04, 0], "#4a4", false),
      ("z", [0, 0, boxR * 1.04], "#46a", false),
    ]
  }
  for p in points {
    if let label = p.label, !label.isEmpty { labels.append((label, p.pos, CSSColor(p.color), true)) }
  }
  for (text, p, color, dot) in labels {
    guard let at = projectToScreen(vp, p, w, h) else { continue }
    // Clear of the dot, which grows nearer the eye (see POINT_VERT): 7px
    // beside one of POINT_PX at the target distance.
    var off = 7.0
    if dot { off = 7 * min(max(cam.radius / viewDepth(vp, p), 0.6), POINT_MAX_PX / POINT_PX) }
    fillText(ctx, text, x: at.x + off, y: at.y - off, font: font, color: color.cgColor)
  }
  for label in texts {
    guard let at = projectToScreen(vp, label.pos, w, h) else { continue }
    drawTextLabel(ctx, label.text, sx: at.x, sy: at.y, color: CSSColor(label.color), theme: theme)
  }
}
