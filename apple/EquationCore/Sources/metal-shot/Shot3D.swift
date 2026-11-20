import EquationRender
import Foundation

// A 3D scene for metal-shot: --scene with a Graph3D
// (EquationRender/Scene3D.swift), which is told from a Scene2D by its
// "scene" key. The language's Swift port doesn't compile 3D rows yet, so
// the JSON comes from the TypeScript: its shader strings and sampled
// geometry for the rows, with the camera their camera(…) row sets.

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
