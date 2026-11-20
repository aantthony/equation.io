import Foundation
import Testing

@testable import EquationCore
@testable import EquationRender

/// Holds the Swift scene builder to the site's: for each document of
/// Scenes/3D/documents.json (apple/corpus/scenes3d.ts, which records what
/// apple/tools/scene3d.ts builds with the TypeScript pipeline), `Document3D`
/// must make the same scene from the same rows — the same shaders, and the
/// same sampled, traced and solved geometry to within rounding. Regenerate with
///
///   pnpm swift:scenes3d
@Suite struct Document3DConformance {
  struct Recorded {
    var rows: [String]
    var time: Double
    var graph: Graph3D
  }

  static func recorded() throws -> [Recorded] {
    let url = try #require(Bundle.module.url(forResource: "documents", withExtension: "json", subdirectory: "Scenes/3D"))
    let docs = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]])
    return try docs.map { doc in
      Recorded(
        rows: doc["rows"] as! [String], time: (doc["time"] as! NSNumber).doubleValue,
        graph: try Graph3D.decode(try JSONSerialization.data(withJSONObject: doc["graph"]!)))
    }
  }

  /// The document as the app builds it, in the light theme.
  static func built(_ rows: [String], at time: Double) -> (Document3D, Graph3D) {
    let analysis = analyze(rows)
    let colors = Graph2D.colors(analysis, ids: Array(rows.indices), previous: [:], theme: .light, sources: rows).colors
    var document = Document3D(analysis, colors: colors)
    // The notes apple/tools/scene3d.ts reads for the page's toggles.
    for (k, text) in rows.enumerated() {
      if text.contains("# streamlines") { document.streamlines.insert(k) }
      if text.contains("# arrows") { document.arrows.insert(k) }
    }
    // (The recorded camera is the row's, before any spin.)
    return (document, document.graph(at: time, camera: document.camera))
  }

  @Test func documentsBuildTheSitesScenes() throws {
    var failures: [String] = []
    for doc in try Self.recorded() {
      let name = doc.rows.joined(separator: "; ")
      let analysis = analyze(doc.rows)
      #expect(Graph.kind(of: analysis) == .space, "\(name)")
      let (_, mine) = Self.built(doc.rows, at: doc.time)
      for difference in compare(mine, doc.graph) { failures.append("\(name): \(difference)") }
    }
    #expect(failures.isEmpty, "\(failures.count) differences:\n\(failures.prefix(40).joined(separator: "\n"))")
  }

  @Test func aDocumentInThePlaneIsNotInSpace() {
    #expect(Graph.kind(of: analyze(["y = x^2", "(1, 2)", "x^2 + y^2 < 1"])) == .plane)
    #expect(Graph.kind(of: analyze(["y = x^2", "(1, 2, 3)"])) == .space)
    #expect(Graph.kind(of: analyze(["y = x^2", "A = (1, 2, 3)"])) == .space)
    // A row in error draws nothing, in space or anywhere.
    #expect(Graph.kind(of: analyze(["y = x^2", "tube((1, 2, 3))"])) == .plane)
  }

  @Test func theCameraRowSetsTheOpeningCamera() {
    func document(_ rows: [String]) -> Document3D { Self.built(rows, at: 0).0 }
    #expect(document(["z = x"]).camera == Camera3D())
    let set = document(["z = x", "camera(0.4, 2, 12, (1, 0, -1), spin = 0.2, locked)"])
    #expect(set.camera == Camera3D(target: SIMD3(1, 0, -1), radius: 12, theta: 0.4, phi: clampPhi(2)))
    #expect(set.spin == 0.2 && set.locked && set.animated)
    #expect(document(["z = x", "camera(1, 0.5)"]).camera.radius == 14)
    // The picture of a spinning graph turns with the time.
    #expect(set.graph(at: 2).camera?.theta == 0.4 + 0.2 * 2)
    #expect(document(["z = x", "grid(off)"]).grid == .off)
  }

  @Test func whatMovesIsAnimated() {
    func animated(_ rows: [String]) -> Bool { Self.built(rows, at: 0).0.animated }
    #expect(!animated(["z = x y", "(1, 2, 3)", "(y, -x, 1)"]))
    #expect(animated(["z = sin(x + t)"]))
    #expect(animated(["a = t", "z = a x"]))
  }

  /// A solve or a trace is kept while nothing it reads changes, and made
  /// again when the camera's box or a constant does.
  @Test func tracesFollowTheCameraAndTheConstants() {
    let (document, _) = Self.built(["a = 1", "(x + y + z, x - y, z) = (a, 0, 2)"], at: 0)
    let near = document.scene(at: 0, camera: Camera3D())
    #expect(near.points.count == 1)
    #expect(document.scene(at: 0, camera: Camera3D()) == near)
    // The solution is outside a box far from it.
    #expect(document.scene(at: 0, camera: Camera3D(target: SIMD3(100, 0, 0), radius: 2)).points.isEmpty)
    let (moved, _) = Self.built(["a = 3", "(x + y + z, x - y, z) = (a, 0, 2)"], at: 0)
    #expect(moved.scene(at: 0, camera: Camera3D()).points.first?.pos != near.points.first?.pos)
  }

  // MARK: Comparing a scene

  private func compare(_ mine: Graph3D, _ theirs: Graph3D) -> [String] {
    var out: [String] = []
    func check<T: Equatable>(_ what: String, _ a: T, _ b: T) {
      if a != b { out.append("\(what): got \("\(a)".prefix(300)), want \("\("\(b)".prefix(300))")") }
    }
    func glsl(_ what: String, _ a: [String]?, _ b: [String]?) {
      check(what, a?.map(normalizeGLSL), b?.map(normalizeGLSL))
    }
    /// Floats that agree to within `tolerance` of the scene's size, gaps (NaN) in the same places.
    func floats(_ what: String, _ a: [Float], _ b: [Float], _ tolerance: Double = 2e-3) {
      guard a.count == b.count else { return out.append("\(what): \(a.count) floats, want \(b.count)") }
      for (k, (x, y)) in zip(a, b).enumerated() where !(x.isNaN && y.isNaN) {
        if x.isNaN != y.isNaN || abs(Double(x) - Double(y)) > tolerance * max(1, abs(Double(y))) {
          return out.append("\(what): float \(k) of \(a.count) is \(x), want \(y)")
        }
      }
    }
    func near(_ what: String, _ a: Double, _ b: Double, _ tolerance: Double = 1e-9) {
      if !(abs(a - b) <= tolerance * max(1, abs(b))) { out.append("\(what): got \(a), want \(b)") }
    }
    func color(_ what: String, _ a: RGB, _ b: RGB) {
      if (0..<3).contains(where: { abs(a[$0] - b[$0]) > 1e-5 }) { out.append("\(what) color: got \(a), want \(b)") }
    }
    /// A layer's items, pair by pair, once there are as many.
    func each<T>(_ what: String, _ a: [T]?, _ b: [T]?, _ item: (String, T, T) -> Void) {
      let (a, b) = (a ?? [], b ?? [])
      guard a.count == b.count else { return out.append("\(what): \(a.count), want \(b.count)") }
      for (k, (x, y)) in zip(a, b).enumerated() { item("\(what) \(k)", x, y) }
    }

    let (cam, want) = (mine.camera ?? Camera3D(), theirs.camera ?? Camera3D())
    near("camera theta", cam.theta, want.theta)
    near("camera phi", cam.phi, want.phi)
    near("camera radius", cam.radius, want.radius)
    for k in 0..<3 { near("camera target", cam.target[k], want.target[k]) }
    check("env names", (mine.env ?? [:]).keys.sorted(), (theirs.env ?? [:]).keys.sorted())
    // (The recorded environment is the constants at t = 0.)
    near("time", mine.time ?? 0, theirs.time ?? 0)

    let (a, b) = (mine.scene, theirs.scene)
    each("implicit", a.implicits, b.implicits) { what, x, y in
      glsl("\(what) field", [x.field], [y.field])
      glsl("\(what) grad", x.grad, y.grad)
      check("\(what) params", x.params ?? [], y.params ?? [])
      color(what, x.color, y.color)
    }
    each("psurface", a.psurfaces, b.psurfaces) { what, x, y in
      glsl("\(what) comps", x.comps, y.comps)
      glsl("\(what) du", x.du, y.du)
      glsl("\(what) dv", x.dv, y.dv)
      glsl("\(what) paint", x.paint.map { [$0] }, y.paint.map { [$0] })
      check("\(what) params", x.params ?? [], y.params ?? [])
      if let gain = y.gain { near("\(what) gain", x.gain ?? .nan, gain, 1e-6) } else { check("\(what) gain", x.gain, nil) }
      color(what, x.color, y.color)
    }
    each("volume", a.volumes, b.volumes) { what, x, y in
      glsl("\(what) field", [x.field], [y.field])
      near("\(what) scale", x.scale, y.scale, 1e-9)
      check("\(what) params", x.params ?? [], y.params ?? [])
      color(what, x.color, y.color)
    }
    each("streamlines", a.streamlines, b.streamlines) { what, x, y in
      glsl("\(what) comps", x.comps, y.comps)
      check("\(what) params", x.params ?? [], y.params ?? [])
      color(what, x.color, y.color)
    }
    each("curve", a.curves, b.curves) { what, x, y in
      floats("\(what) pts", x.pts, y.pts)
      check("\(what) arrow", x.arrow ?? false, y.arrow ?? false)
      check("\(what) fill", x.fill ?? false, y.fill ?? false)
      check("\(what) fade", x.fade ?? false, y.fade ?? false)
      color(what, x.color, y.color)
    }
    each("segments", a.segments, b.segments) { what, x, y in
      floats("\(what) pts", x.pts, y.pts)
      color(what, x.color, y.color)
    }
    each("tube", a.tubes, b.tubes) { what, x, y in
      floats("\(what) positions", x.positions, y.positions)
      floats("\(what) normals", x.normals, y.normals)
      floats("\(what) uvs", x.uvs, y.uvs)
      check("\(what) indices", x.indices, y.indices)
      check("\(what) cells", x.cells, y.cells)
      color(what, x.color, y.color)
    }
    each("point", a.points, b.points) { what, x, y in
      for k in 0..<3 { near("\(what) pos", x.pos[k], y.pos[k], 1e-6) }
      check("\(what) label", x.label, y.label)
      color(what, x.color, y.color)
    }
    // Which points are one row's (a cloud) and which stand alone.
    func runs(_ points: [Scene3D.Point]) -> [Bool] {
      zip(points, points.dropFirst()).map { $0.group == $1.group }
    }
    if a.points.count == b.points.count { check("point groups", runs(a.points), runs(b.points)) }
    each("text", a.texts, b.texts) { what, x, y in
      check("\(what) text", x.text, y.text)
      for k in 0..<3 { near("\(what) pos", x.pos[k], y.pos[k], 1e-6) }
    }
    check("planes", a.planes?.count ?? 0, b.planes?.count ?? 0)
    check("paints", a.paints?.count ?? 0, b.paints?.count ?? 0)
    return out
  }
}

/// GLSL with every number literal respelled from its float32 value, so the
/// two emitters' texts compare whatever digits each chose to write (as
/// EquationCoreTests' `normalizeGLSL`, which is another target's).
private func normalizeGLSL(_ glsl: String) -> String {
  let u = Array(glsl.utf8)
  var out = ""
  var i = 0
  func isDigit(_ c: UInt8) -> Bool { c >= 0x30 && c <= 0x39 }
  func isWord(_ c: UInt8) -> Bool {
    isDigit(c) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c == 0x5F
  }
  while i < u.count {
    let c = u[i]
    guard isDigit(c), i == 0 || !(isWord(u[i - 1]) || u[i - 1] == 0x2E) else {
      out.unicodeScalars.append(Unicode.Scalar(c))
      i += 1
      continue
    }
    var j = i
    while j < u.count, isDigit(u[j]) { j += 1 }
    if j < u.count, u[j] == 0x2E {
      j += 1
      while j < u.count, isDigit(u[j]) { j += 1 }
    }
    if j < u.count, u[j] == 0x45 || u[j] == 0x65 {
      var k = j + 1
      if k < u.count, u[k] == 0x2B || u[k] == 0x2D { k += 1 }
      if k < u.count, isDigit(u[k]) {
        while k < u.count, isDigit(u[k]) { k += 1 }
        j = k
      }
    }
    out += "\(Float(Double(String(decoding: u[i..<j], as: UTF8.self)) ?? .nan))"
    i = j
  }
  return out
}
