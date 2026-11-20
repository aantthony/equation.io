import EquationCore
import EquationRender
import Foundation

// A document as the panels the graph view shows: one, and one more for each
// `---` row, each with its own rows, window or camera, and grid.
//
// This is the app's side of a panels API EquationRender is still getting
// (the site's lib/panels.ts over a document). Until it lands, a panel's
// graph is built over the document with the other panels' rows masked out:
// `Graph2D` for one in the plane, and for one with a row in space
// (`Graph.kind(of:)`) `Document3D`, the 3D scene builder. Nothing past this
// file knows where a panel's graph came from.

/// A 3D panel's graph: what the scene builder gives for a panel's rows.
struct SpaceGraph: Equatable {
  /// The panel's rows, as the builder draws them.
  var document: Document3D?
  /// A scene written down (apple/tools/scene3d.ts), in place of the builder's
  /// (EQUATION_SCENE3D, below).
  var graph: Graph3D?

  init(document: Document3D) { self.document = document }
  init(graph: Graph3D) { self.graph = graph }

  /// The camera the panel opens with, when no camera(…) row says.
  var opening: Camera3D { document?.camera ?? graph?.camera ?? Camera3D() }
  /// The GLSL of the loop helpers a written scene's shaders name (the
  /// builder's link from the language's own registry).
  var helpers: String? { graph?.helpers }
  /// Something moves with t, so the panel redraws every frame.
  var animated: Bool { document?.animated ?? (graph?.scene.streamlines?.isEmpty == false) }

  /// What the panel draws at a time, seen from `camera`: what is solved or
  /// traced on the CPU is found over the box the camera looks at.
  func scene(at time: Double, camera: Camera3D) -> Scene3D {
    document?.scene(at: time, camera: camera) ?? graph?.scene ?? Scene3D()
  }
  func environment(at time: Double) -> [String: Double] {
    document?.environment(at: time) ?? graph?.env ?? [:]
  }

  #if DEBUG
    /// EQUATION_SCENE3D: a Graph3D's JSON, or the path of a file of it the
    /// app can read (its container), or `demo` for a scene made here: a
    /// scene the TypeScript builds, to set beside the builder's in the app.
    /// With it set, that scene is drawn in the panel with a camera(…) row,
    /// or the first panel when none has one:
    ///
    ///   node --experimental-transform-types apple/tools/scene3d.ts "z = sin(x) cos(y)" > scene.json
    ///   open -n Equation.app --env EQUATION_SCRATCH='y = x' --env EQUATION_SCENE3D="$(cat scene.json)"
    static let fixture: SpaceGraph? = {
      guard let value = ProcessInfo.processInfo.environment["EQUATION_SCENE3D"], !value.isEmpty else { return nil }
      if value == "demo" { return SpaceGraph(graph: demo) }
      let json = value.hasPrefix("{") ? Data(value.utf8) : (try? Data(contentsOf: URL(fileURLWithPath: value)))
      return json.flatMap { try? Graph3D.decode($0) }.map { SpaceGraph(graph: $0) }
    }()

    /// A sphere through a saddle, with a named point: an implicit surface
    /// (refined at rest), a parametric one, and the overlay's labels.
    private static let demo: Graph3D = {
      let (x, y) = ("(8.0*u - 4.0)", "(8.0*v - 4.0)")
      return Graph3D(
        scene: Scene3D(
          implicits: [Surface3D(field: "x*x + y*y + z*z - 9.0", color: [0.176, 0.439, 0.702])],
          psurfaces: [.init(comps: [x, y, "0.15*(\(x)*\(x) - \(y)*\(y))"], color: [0.78, 0.267, 0.251])],
          points: [.init(pos: [0, 0, 3], color: [0.22, 0.549, 0.275], label: "N", group: 0)]))
    }()
  #else
    static let fixture: SpaceGraph? = nil
  #endif
}

/// One panel: its rows, and what it draws.
struct GraphPanel: Equatable {
  /// The document's rows that are the panel's, its `---` row first.
  var rows: Range<Int>
  /// The panel's 2D graph: its layers, overlay, grid and the window its view(…) row asks for.
  var plane: Graph2D
  /// Set when the panel is 3D.
  var space: SpaceGraph?
  /// The row that frames the panel, which moving it rewrites: a view(…) row
  /// in 2D, a camera(…) row in 3D.
  var frameRow: Int?
  /// The camera and spin a camera(…) row asks for.
  var camera: Camera3D?
  var spin = 0.0
  /// `view(…, locked)` or `camera(…, locked)`: the panel is held still.
  var locked = false

  var grid: Frame2D.Grid { plane.grid }
  var animated: Bool { space?.animated ?? plane.animated }
}

/// A document's panels.
struct GraphPanels: Equatable {
  var analysis: DocumentAnalysis
  var panels: [GraphPanel]
  /// The dividers, in order: panel k + 1 is opened by entry k.
  var splits: [ViewSpec]

  var animated: Bool { panels.contains(where: \.animated) }

  init(_ analysis: DocumentAnalysis, colors: [RGB?], space fixture: SpaceGraph? = SpaceGraph.fixture) {
    self.analysis = analysis
    splits = analysis.rows.compactMap { $0.divider ? $0.view : nil }
    // Each row's panel: 0 until the first divider, then one more per divider.
    var starts = [0]
    for (index, row) in analysis.rows.enumerated() where row.divider { starts.append(index) }
    let ranges = starts.indices.map { k in
      starts[k]..<(k + 1 < starts.count ? starts[k + 1] : analysis.rows.count)
    }
    let cameraRow = { (rows: Range<Int>) in
      rows.first { index in
        if case .camera? = analysis.rows[index].view { return analysis.rows[index].error == nil }
        return false
      }
    }
    // The fixture's panel: the first with a camera(…) row, or else the first.
    let spatial = fixture == nil ? nil : ranges.firstIndex { cameraRow($0) != nil } ?? 0
    panels = ranges.enumerated().map { k, rows in
      // The panel's own rows: the others neither draw nor frame it.
      var own = analysis
      if ranges.count > 1 {
        for index in own.rows.indices where !rows.contains(index) {
          own.rows[index].view = nil
          own.rows[index].error = own.rows[index].error ?? ""
        }
      }
      var panel = GraphPanel(rows: rows, plane: Graph2D(own, colors: colors))
      if k == spatial {
        panel.space = fixture
      } else if Graph.kind(of: own) == .space {
        panel.space = SpaceGraph(document: Document3D(own, colors: colors))
      }
      if panel.space != nil {
        panel.frameRow = cameraRow(rows)
        if let row = panel.frameRow,
          case .camera(let theta, let phi, let radius, let target, let spin, let locked)? = analysis.rows[row].view
        {
          let at = target.flatMap { $0.count == 3 ? SIMD3($0[0], $0[1], $0[2]) : nil }
          panel.camera = Camera3D(target: at ?? .zero, radius: radius ?? 14, theta: theta, phi: clampPhi(phi))
          panel.spin = spin ?? 0
          panel.locked = locked
        }
      } else {
        panel.frameRow = rows.first { index in
          if case .view(_, _, _, let locked)? = analysis.rows[index].view, analysis.rows[index].error == nil {
            panel.locked = locked
            return true
          }
          return false
        }
      }
      return panel
    }
  }

  /// The panel a row is in.
  func panel(of row: Int) -> Int {
    panels.firstIndex { $0.rows.contains(row) } ?? 0
  }
}
