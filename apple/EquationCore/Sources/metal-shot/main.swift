import CoreGraphics
import EquationCore
import EquationRender
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Renders a graph to a PNG with the app's Metal renderer, without the app.
//
//   swift run metal-shot --out a.png "y = sin(x)" "x^2 + y^2 = 9"
//   swift run metal-shot --out a.png --scene scene.json     (a Scene2D, EquationRender/Scene2D.swift)
//   swift run metal-shot --diff a.png b.png [--out diff.png]
//
//   --size 800x600   the frame in points (default 800x600)
//   --scale 2        device pixels per point (default 2)
//   --dark           the dark theme
//   --view cx,cy,upp the window (upp in math units per device pixel); default the opening window
//   --time 1.5       seconds since the graph opened (t)
//
// Set a shot beside the site's (apple/tools/web-shot.ts takes the same
// rows, size and theme) to see whether the two renderers agree; --diff
// counts the pixels that don't.

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

func load(_ path: String) -> CGImage {
  guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
  else { fail("Can't read \(path).") }
  return image
}

func save(_ image: CGImage, _ path: String) {
  guard
    let destination = CGImageDestinationCreateWithURL(
      URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil)
  else { fail("Can't write \(path).") }
  CGImageDestinationAddImage(destination, image, nil)
  if !CGImageDestinationFinalize(destination) { fail("Can't write \(path).") }
}

/// An image's pixels as sRGB RGBA bytes.
func pixels(_ image: CGImage) -> [UInt8] {
  var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
  bytes.withUnsafeMutableBytes { raw in
    let ctx = CGContext(
      data: raw.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8,
      bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
  }
  return bytes
}

var arguments = Array(CommandLine.arguments.dropFirst())
var options: [String: String] = [:]
var flags: Set<String> = []
var rest: [String] = []
while !arguments.isEmpty {
  let argument = arguments.removeFirst()
  switch argument {
  case "--dark", "--help": flags.insert(argument)
  case "--out", "--scene", "--size", "--scale", "--view", "--time":
    guard !arguments.isEmpty else { fail("\(argument) needs a value.") }
    options[argument] = arguments.removeFirst()
  case "--diff":
    guard arguments.count >= 2 else { fail("--diff needs two images.") }
    options["--diff"] = arguments.removeFirst()
    options["--with"] = arguments.removeFirst()
  default: rest.append(argument)
  }
}
if flags.contains("--help") {
  print(
    """
    metal-shot --out a.png [--size 800x600] [--scale 2] [--dark] [--view cx,cy,upp] [--time s] (--scene scene.json | rows…)
    metal-shot --diff a.png b.png [--out diff.png]
    """)
  exit(0)
}

if let first = options["--diff"], let second = options["--with"] {
  let a = load(first)
  let b = load(second)
  guard a.width == b.width, a.height == b.height else {
    fail("Sizes differ: \(a.width)x\(a.height) and \(b.width)x\(b.height).")
  }
  let pa = pixels(a)
  let pb = pixels(b)
  var out = [UInt8](repeating: 255, count: pa.count)
  var total = 0
  var differing = 0
  var far = 0
  for i in stride(from: 0, to: pa.count, by: 4) {
    let d = max(abs(Int(pa[i]) - Int(pb[i])), abs(Int(pa[i + 1]) - Int(pb[i + 1])), abs(Int(pa[i + 2]) - Int(pb[i + 2])))
    total += d
    if d > 8 { differing += 1 }
    if d > 64 { far += 1 }
    // The first image, faded, with what differs in red.
    let gray = UInt8((Int(pa[i]) + Int(pa[i + 1]) + Int(pa[i + 2])) / 3 / 2 + 127)
    out[i] = d > 8 ? 255 : gray
    out[i + 1] = d > 8 ? UInt8(max(0, 200 - d * 2)) : gray
    out[i + 2] = d > 8 ? 0 : gray
  }
  let count = pa.count / 4
  print(
    String(
      format: "mean difference %.3f of 255; %.2f%% of pixels differ by more than 8, %.2f%% by more than 64",
      Double(total) / Double(count), 100 * Double(differing) / Double(count), 100 * Double(far) / Double(count)))
  if let path = options["--out"] {
    let image = out.withUnsafeMutableBytes { raw in
      CGContext(
        data: raw.baseAddress, width: a.width, height: a.height, bitsPerComponent: 8, bytesPerRow: a.width * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        .makeImage()!
    }
    save(image, path)
  }
  exit(0)
}

guard let out = options["--out"] else { fail("Where to? Pass --out a.png (or --help).") }
let size = (options["--size"] ?? "800x600").split(separator: "x").compactMap { Double($0) }
guard size.count == 2 else { fail("--size is like 800x600.") }
let scale = Double(options["--scale"] ?? "2") ?? 2
let theme = flags.contains("--dark") ? GraphTheme.dark : .light

var scene: Scene2D
if let path = options["--scene"] {
  do {
    scene = try JSONDecoder().decode(Scene2D.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
  } catch {
    fail("Can't read the scene: \(error)")
  }
} else {
  // Until the language's own pipeline builds the scene: the rows the first
  // stage classifies, in palette order.
  var curves: [Curve2D] = []
  for row in rest {
    switch plotRow(row) {
    case .curve(let field, _)?:
      curves.append(Curve2D(field: field, color: theme.palette[curves.count % theme.palette.count]))
    case .nothing?: break
    case nil: FileHandle.standardError.write(Data("not drawn: \(row)\n".utf8))
    }
  }
  scene = Scene2D(layers: Layers2D(curves: curves))
}
if let text = options["--view"] {
  let parts = text.split(separator: ",").compactMap { Double($0) }
  guard parts.count == 3 else { fail("--view is cx,cy,upp.") }
  scene.view = View2D(cx: parts[0], cy: parts[1], upp: parts[2])
}
if let time = options["--time"].flatMap(Double.init) { scene.time = time }

guard let metal = MetalContext() else { fail("No Metal device.") }
guard
  let image = metal.image(
    of: scene, width: Int(size[0] * scale), height: Int(size[1] * scale), dpr: scale, theme: theme)
else { fail("Couldn't draw.") }
save(image, out)
