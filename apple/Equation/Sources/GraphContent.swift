import EquationCore
import EquationRender
import Foundation

// A document as the graph view shows it: EquationRender's `GraphPanels` (the
// site's panels — their layout, windows, shared axes and 2D scenes) with what
// the view adds to it: each 3D panel's scene builder, the row that frames
// each panel, and the display toggles rows are shown with. metal-shot draws
// the same `GraphPanels`, so a shot of some rows is the app's picture of them.

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
  var grid: Frame2D.Grid { document?.grid ?? graph?.frame?.grid ?? .on }

  /// What the panel draws at a time, seen from `camera`: what is solved or
  /// traced on the CPU is found over the box the camera looks at. `run` has
  /// the document's states where the frame finds them.
  func scene(at time: Double, camera: Camera3D, run: StateStepper?) -> Scene3D {
    document?.scene(at: time, camera: camera, run: run) ?? graph?.scene ?? Scene3D()
  }
  func environment(at time: Double, run: StateStepper?) -> [String: Double] {
    if let document { return run?.environment(at: time) ?? document.environment(at: time) }
    return graph?.env ?? [:]
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

/// The display toggles the site keeps on a row outside its text (web/main.ts
/// `Equation.showLevels`, `partialSum`, `showStreamlines`, `showArrows`), by
/// row index here; the document's view model keeps them by row id.
struct RowToggles: Equatable {
  /// Level sets `f(x, y) = c` drawing every level of f.
  var levels: Set<Int> = []
  /// Sequences plotting their partial sums.
  var sums: Set<Int> = []
  /// Vector fields in space drawn as streamlines, or as arrows.
  var streamlines: Set<Int> = []
  var arrows: Set<Int> = []
}

/// What the view keeps of one panel beside its `GraphPanels.Panel`.
struct PanelFraming: Equatable {
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
  /// A lattice view row's axes as written (`view(n = 0..80, i = -60..60)`),
  /// which a rewrite keeps the order of.
  var written: [String]?
}

/// A document's panels, as the graph view draws and moves them.
struct GraphContent: Equatable {
  var panels: GraphPanels
  /// One per panel.
  var framing: [PanelFraming]
  var toggles: RowToggles

  var analysis: DocumentAnalysis { panels.analysis }
  var animated: Bool {
    zip(panels.panels, framing).contains { panel, framing in framing.space?.animated ?? panel.graph.animated }
  }

  init(
    _ analysis: DocumentAnalysis, colors: [RGB?], toggles: RowToggles = RowToggles(),
    space fixture: SpaceGraph? = SpaceGraph.fixture
  ) {
    var panels = GraphPanels(analysis, colors: colors)
    self.toggles = toggles
    let rows = panels.panels.map(\.rows)
    func frames(_ index: Int, camera: Bool) -> Bool {
      guard analysis.rows[index].error == nil else { return false }
      switch analysis.rows[index].view {
      case .camera?: return camera
      case .view?, .mappedView?: return !camera
      default: return false
      }
    }
    // The fixture's panel: the first with a camera(…) row, or else the first.
    let spatial = fixture == nil ? nil : rows.firstIndex { $0.contains { frames($0, camera: true) } } ?? 0
    framing = panels.panels.indices.map { k in
      var out = PanelFraming()
      if k == spatial {
        out.space = fixture
      } else if panels.panels[k].needs3D {
        // The panel's own rows: the others neither draw in it nor frame it.
        var document = Document3D(analysis.panel(k), colors: colors)
        document.streamlines = toggles.streamlines
        document.arrows = toggles.arrows
        out.space = SpaceGraph(document: document)
      }
      if out.space != nil {
        // (The first such row, as web/main.ts `viewportRow` finds it.)
        out.frameRow = rows[k].first { frames($0, camera: true) }
        if let row = out.frameRow,
          case .camera(let theta, let phi, let radius, let target, let spin, let locked)? = analysis.rows[row].view
        {
          let at = target.flatMap { $0.count == 3 ? SIMD3($0[0], $0[1], $0[2]) : nil }
          out.camera = Camera3D(target: at ?? .zero, radius: radius ?? 14, theta: theta, phi: clampPhi(phi))
          out.spin = spin ?? 0
          out.locked = locked
        }
      } else {
        out.frameRow = rows[k].first { frames($0, camera: false) }
        out.locked = panels.panels[k].locked
        out.written = out.frameRow.flatMap { analysis.rows[$0].viewAxes }
        panels.panels[k].graph.partialSums = toggles.sums
      }
      return out
    }
    self.panels = panels
  }

  /// The panel a row is in.
  func panel(of row: Int) -> Int {
    panels.panels.firstIndex { $0.rows.contains(row) } ?? 0
  }

  /// One frame: each panel in its box, the 2D ones as `GraphPanels.scene`
  /// writes them down (what metal-shot draws from the same rows), the 3D
  /// ones from their cameras. `views` and `cameras` are the panels' windows
  /// and cameras as the view has moved them; `run` the document's states;
  /// `hot` the row whose point is under a drag, drawn with a halo.
  func frames(
    at time: Double, width: Double, height: Double, dpr: Double, theme: GraphTheme, views: [View2D],
    cameras: [Camera3D], run: StateStepper?, hot: Int? = nil
  ) -> (frames: [PanelFrame], layout: [PanelLayout]) {
    let drawn = panels.scene(at: time, width: width, height: height, dpr: dpr, theme: theme, views: views, run: run)
    var out: [PanelFrame] = []
    for (k, entry) in drawn.panels.enumerated() {
      let r = entry.layout.rect
      if let space = framing[k].space {
        guard r.w >= 1, r.h >= 1, k < cameras.count else { continue }
        out.append(
          PanelFrame(
            layout: entry.layout,
            content: .space(
              camera: cameras[k], scene: space.scene(at: time, camera: cameras[k], run: run),
              env: space.environment(at: time, run: run), grid: space.grid)))
        continue
      }
      guard var scene = entry.scene, let view = scene.view else { continue }
      let panel = panels.panels[k]
      // A level set's contour stack, where its row's "all levels" is on (web/main.ts `showLevels`).
      let levels = toggles.levels.intersection(panel.rows)
      if !levels.isEmpty {
        let stacks = panel.graph.levelStacks(rows: levels, at: time, view: view, width: r.w, height: r.h)
        if !stacks.isEmpty { scene.layers.levels = stacks }
      }
      if let hot, panel.rows.contains(hot), var overlay = scene.overlay {
        // The overlay doesn't say which row a dot is: the one where the held point is.
        for at in grabPoints(panel: k, rows: hot..<(hot + 1), time: time, run: run) {
          for index in overlay.points.indices where overlay.points[index].x == at.x && overlay.points[index].y == at.y {
            overlay.points[index].hot = true
          }
        }
        scene.overlay = overlay
      }
      out.append(PanelFrame(layout: entry.layout, content: .plane(scene)))
    }
    return (out, drawn.panels.map(\.layout))
  }

  /// The points of panel `k` a drag can move, where the panel draws them: on
  /// a panel with mapped axes, in its screen's coordinates (web/main.ts `carry`).
  func grabPoints(panel k: Int, rows: Range<Int>? = nil, time: Double, run: StateStepper?) -> [GrabPoint] {
    let panel = panels.panels[k]
    var env = panel.graph.environment(at: time, run: run)
    env["t"] = time
    var points = analysis.grabPoints(rows: rows ?? panel.rows, env: env)
    if let maps = panel.graph.maps {
      for index in points.indices {
        if let map = maps.x { points[index].x = toScreen(map, points[index].x) }
        if let map = maps.y { points[index].y = toScreen(map, points[index].y) }
      }
      points.removeAll { !$0.x.isFinite || !$0.y.isFinite }
    }
    return points
  }
}
