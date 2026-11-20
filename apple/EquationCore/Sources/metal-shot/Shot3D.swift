import EquationCore
import EquationRender
import Foundation

// 3D graphs for metal-shot. Rows that draw in space go through the Swift
// pipeline as the app's do (analyze, then Document3D); --scene with a
// Graph3D (EquationRender/Scene3D.swift), which is told from a Scene2D by
// its "scene" key, draws a scene written down — one apple/tools/scene3d.ts
// builds with the TypeScript, to set beside the Swift builder's.

/// The graph in the file at `path`, or nil if what is there is not a 3D one.
func graph3D(_ path: String) -> Graph3D? {
  guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
    let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], object["scene"] != nil
  else { return nil }
  do {
    return try Graph3D.decode(data)
  } catch {
    fail("Can't read the scene: \(error)")
  }
}

/// The rows' graph when they draw in space, at --time, from the camera
/// their camera(…) row sets; nil for a document in the plane. A vector
/// field draws as streamlines when its note says `# streamlines` and as
/// arrows for `# arrows` (the site keeps those toggles outside the text;
/// apple/tools/scene3d.ts reads the same notes).
func spaceGraph(_ rows: [String], theme: GraphTheme, time: Double, explain: Bool) -> Graph3D? {
  let analysis = analyze(rows, files: shotFiles)
  guard Graph.kind(of: analysis) == .space else { return nil }
  for (row, text) in zip(analysis.rows, rows) {
    if let problem = row.error ?? row.unsupported ?? row.dataLocal {
      FileHandle.standardError.write(Data("not drawn: \(text): \(problem)\n".utf8))
    }
  }
  let colors = Graph2D.colors(analysis, ids: Array(rows.indices), previous: [:], theme: theme, sources: rows).colors
  var document = Document3D(analysis, colors: colors)
  document.theme = theme
  for (k, text) in rows.enumerated() {
    guard let at = noteStart(text) else { continue }
    let note = String(decoding: Array(text.utf16.dropFirst(at)), as: UTF16.self)
    if note.contains("streamlines") { document.streamlines.insert(k) }
    if note.contains("arrows") { document.arrows.insert(k) }
  }
  if explain {
    for (k, row) in analysis.rows.enumerated() {
      print(
        "\(rows[k])\n    kind \(row.kind ?? "-"), cpu \(row.cpu?.type ?? "-"), gpu \(row.gpu?.type ?? "-"), "
          + "color \(colors[k].map { "\($0)" } ?? "-")\(row.info.map { ", reads \($0)" } ?? "")")
    }
    print("in space, \(document.animated ? "moves with t" : "still"), camera \(document.camera)")
  }
  // The states, and what the trails have seen, where a viewer watching since t = 0 would find them.
  var run = StateStepper(analysis)
  run.play(to: time)
  return document.graph(at: time, run: run)
}
