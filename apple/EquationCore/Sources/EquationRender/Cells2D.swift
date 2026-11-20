import Foundation
import Metal

// Cells on the integer lattice: web/render2d.ts's Cells2D, CELLS_FRAG, and the textures its renderer keeps.

/// A grid of cell shades, 0 empty to 255 solid, row after row. A class, so
/// that the renderer can tell one buffer from another without reading them:
/// its texture is uploaded once per buffer (the site keys its textures by
/// the Uint8Array). Written down, it is the array of its bytes.
public final class CellShades: Equatable, Codable, Sendable {
  public let bytes: [UInt8]

  public init(_ bytes: [UInt8]) {
    self.bytes = bytes
  }

  public convenience init(from decoder: any Decoder) throws {
    self.init(try decoder.singleValueContainer().decode([UInt8].self))
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(bytes)
  }

  public static func == (a: CellShades, b: CellShades) -> Bool {
    a === b || a.bytes == b.bytes
  }
}

/// Cells on the integer lattice (lib/automaton.ts): `shades` holds `rows`
/// rows of `width` cells, 0 empty to 255 solid; cell (i, k) is the unit
/// square centred on (i, -k), in column i - x0 of row k - y0. `runs` says
/// which edges run on past the texture (an automaton's background) rather
/// than stop: a 1D diagram's columns, a board's columns and rows, a
/// table's neither.
public struct Cells2D: Equatable, Codable, Sendable {
  public var shades: CellShades
  public var width: Int
  public var rows: Int
  public var x0: Double
  public var y0: Double
  public var runs: Runs
  public var color: RGB

  public struct Runs: Equatable, Codable, Sendable {
    public var x: Bool
    public var y: Bool

    public init(x: Bool, y: Bool) {
      self.x = x
      self.y = y
    }
  }

  public init(shades: CellShades, width: Int, rows: Int, x0: Double, y0: Double, runs: Runs, color: RGB) {
    self.shades = shades
    self.width = width
    self.rows = rows
    self.x0 = x0
    self.y0 = y0
    self.runs = runs
    self.color = color
  }
}

let CELLS_FRAG = """
    #version 300 es
    precision highp float;
    uniform vec2 uCenter;
    uniform vec2 uUpp;
    uniform vec2 uRes;
    uniform vec2 uOrigin;
    uniform vec3 uColor;
    uniform highp usampler2D uCells;
    uniform vec2 uSize;
    uniform vec2 uCorner;
    uniform vec2 uRuns;
    out vec4 outColor;
    void main() {
      vec2 p = uCenter + (gl_FragCoord.xy - uOrigin - 0.5 * uRes) * uUpp;
      float row = floor(0.5 - p.y) - uCorner.y;
      float col = floor(p.x + 0.5) - uCorner.x;
      if (uRuns.y > 0.5) row = clamp(row, 0.0, uSize.y - 1.0);
      else if (row < 0.0 || row >= uSize.y) discard;
      if (uRuns.x > 0.5) col = clamp(col, 0.0, uSize.x - 1.0);
      else if (col < 0.0 || col >= uSize.x) discard;
      float v = float(texelFetch(uCells, ivec2(int(col), int(row)), 0).r) / 255.0;
      if (v <= 0.0) discard;
      // Once cells are big enough to count, a hairline gap keeps them apart.
      vec2 px = 1.0 / uUpp;
      vec2 edge = (0.5 - abs(fract(vec2(p.x, -p.y) + 0.5) - 0.5)) * px;
      float gap = min(px.x, px.y) >= 8.0 && min(edge.x, edge.y) < 0.75 ? 0.55 : 1.0;
      outColor = vec4(uColor, 0.92 * v * gap);
    }

    """

/// The cell textures a renderer holds: one per shade buffer, kept while a
/// frame still draws it (web/render2d.ts `cellTexture`, `endFrame`).
final class CellTextures {
  /// Cell textures by the shade buffer they were uploaded from. The buffer
  /// is held too, so its identity is not taken by another while its texture is here.
  private var textures: [ObjectIdentifier: (shades: CellShades, texture: any MTLTexture)] = [:]
  /// Shade buffers drawn since the last endFrame.
  private var drawn: Set<ObjectIdentifier> = []

  /// The texture for these cells, uploaded once per buffer; nil when the
  /// buffer is not `width` × `rows` cells, or is empty.
  func texture(_ c: Cells2D, device: any MTLDevice) -> (any MTLTexture)? {
    let id = ObjectIdentifier(c.shades)
    drawn.insert(id)
    if let held = textures[id] { return held.texture }
    guard c.width > 0, c.rows > 0, c.shades.bytes.count == c.width * c.rows else { return nil }
    // One unsigned byte a cell, read as it is: the site's R8UI.
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(
      pixelFormat: .r8Uint, width: c.width, height: c.rows, mipmapped: false)
    descriptor.usage = [.shaderRead]
    guard let texture = device.makeTexture(descriptor: descriptor) else { return nil }
    c.shades.bytes.withUnsafeBytes { raw in
      texture.replace(
        region: MTLRegionMake2D(0, 0, c.width, c.rows), mipmapLevel: 0, withBytes: raw.baseAddress!,
        bytesPerRow: c.width)
    }
    textures[id] = (c.shades, texture)
    return texture
  }

  /// Drop the textures nothing drew since the last call.
  func endFrame() {
    textures = textures.filter { drawn.contains($0.key) }
    drawn.removeAll()
  }

  var count: Int { textures.count }
}
