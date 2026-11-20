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

/// The display toggles the site keeps on a row outside its text (web/session.ts
/// `Equation.showLevels`, `partialSum`, `showStreamlines`, `showArrows`,
/// `certify`, `combK`, `combT`), by row index here; the document's view model
/// keeps them by row id.
struct RowToggles: Equatable {
  /// Level sets `f(x, y) = c` drawing every level of f.
  var levels: Set<Int> = []
  /// Sequences plotting their partial sums.
  var sums: Set<Int> = []
  /// Vector fields in space drawn as streamlines, or as arrows.
  var streamlines: Set<Int> = []
  var arrows: Set<Int> = []
  /// Matrix fields in the plane drawn as streamlines of their major eigenvector.
  var tensors: Set<Int> = []
  /// Systems whose search box is certified.
  var certified: Set<Int> = []
  /// Curves in space wearing a comb of their curvature, and of their torsion.
  var combK: Set<Int> = []
  var combT: Set<Int> = []
}

/// A point of a panel a drag can move: a row's, which the drag rewrites, or
/// a seed dropped on the panel's vector fields, which is the view's.
struct Grabbable: Equatable {
  enum Target: Equatable {
    case row(Int)
    case seed(Int)
    /// One of the solutions of a point placed by its coordinates' names
    /// (`(r, theta) = (2, 0.8)`): the drag rewrites the row's right-hand pair.
    case solution(row: Int, index: Int)
  }
  var target: Target
  /// Where the panel draws it: on a panel with mapped axes, on its screen.
  var x: Double
  var y: Double
}

/// What a row says once it has been drawn, in place of what its analysis said.
struct RowNote: Equatable {
  var info: String?
  var error: String?
}

/// The point of a panel under a drag or the pointer, drawn with a halo.
struct HotPoint: Equatable {
  var panel: Int
  var target: Grabbable.Target
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
  /// In a graph that moves, each row's readout as it opens (`notes`).
  private var readouts: [Int: OpeningReadout] = [:]

  struct OpeningReadout: Equatable {
    var readout: String
    var note: String
  }

  var analysis: DocumentAnalysis { panels.analysis }
  var animated: Bool {
    zip(panels.panels, framing).contains { panel, framing in framing.space?.animated ?? panel.graph.animated }
  }

  init(
    _ analysis: DocumentAnalysis, colors: [RGB?], toggles: RowToggles = RowToggles(), theme: GraphTheme = .light,
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
        // The theme shades a panel's bare surface (an on(…) row).
        document.theme = theme
        document.streamlines = toggles.streamlines
        document.arrows = toggles.arrows
        document.combK = toggles.combK
        document.combT = toggles.combT
        out.space = SpaceGraph(document: document)
      }
      if out.space != nil {
        // (The first such row, as web/scene.ts `viewportRow` finds it.)
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
        panels.panels[k].graph.tensorStreamlines = toggles.tensors
        panels.panels[k].graph.certified = toggles.certified
      }
      return out
    }
    self.panels = panels
    if animated { readouts = Self.openingReadouts(analysis) }
  }

  /// The panel a row is in.
  func panel(of row: Int) -> Int {
    panels.panels.firstIndex { $0.rows.contains(row) } ?? 0
  }

  /// One frame: each panel in its box, the 2D ones as `GraphPanels.scene`
  /// writes them down (what metal-shot draws from the same rows), the 3D
  /// ones from their cameras. `views` and `cameras` are the panels' windows
  /// and cameras as the view has moved them; `run` the document's states;
  /// `seeds` what a viewer dropped on each panel's vector fields; `hot` the
  /// point under a drag or the pointer, drawn with a halo.
  func frames(
    at time: Double, width: Double, height: Double, dpr: Double, theme: GraphTheme, views: [View2D],
    cameras: [Camera3D], run: StateStepper?, seeds: [[FieldSeed]] = [], hot: HotPoint? = nil
  ) -> (frames: [PanelFrame], layout: [PanelLayout]) {
    // The seeds are the view's, kept through every rebuild of the panels
    // (web/session.ts `Panel.drops`): each frame's graph is given them.
    var panels = panels
    for (k, dropped) in seeds.enumerated() where k < panels.panels.count && framing[k].space == nil {
      guard !dropped.isEmpty, panels.panels[k].graph.takesSeeds else { continue }
      panels.panels[k].graph.seeds = dropped
      if let hot, hot.panel == k, case .seed(let index) = hot.target { panels.panels[k].graph.hotSeed = index }
    }
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
      var hotRow: Int?
      switch hot?.target {
      case .row(let row)?, .solution(let row, _)?: hotRow = row
      default: break
      }
      if let hot, hot.panel == k, let row = hotRow, var overlay = scene.overlay {
        // The overlay doesn't say which row a dot is: the one where the held point is.
        let held = grabPoints(
          panel: k, rows: row..<(row + 1), time: time, run: run, view: view, width: r.w, height: r.h)
        for at in held where at.target == hot.target {
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

  /// What rows say that only drawing them finds, once a frame at `time` has
  /// been drawn, by row: a certified search box's verdict (web/scene.ts,
  /// the 'certify' trace's `info`, or the error that kept it from running),
  /// a geodesic cut short by its budget (`geodesicNote`), and, in a graph
  /// that moves, each row's readout now (`plotReadout` every frame).
  func notes(at time: Double, run: StateStepper?) -> [Int: RowNote] {
    var out: [Int: RowNote] = [:]
    for (k, panel) in panels.panels.enumerated() {
      if let document = framing[k].space?.document {
        for row in panel.rows {
          switch analysis.rows[row].cpu {
          case .geodesic?, .family?:
            if let note = document.geodesicNote(row: row) { out[row] = RowNote(info: note) }
          default: break
          }
        }
      } else if framing[k].space == nil {
        for row in toggles.certified.intersection(panel.rows) where panel.graph.canCertify(row: row) {
          let found = panel.graph.certificate(row: row)
          // (Until its first frame, as the site says while its worker runs.)
          out[row] = RowNote(
            info: found.info ?? (found.error == nil ? "Certifying search box…" : nil), error: found.error)
        }
      }
    }
    guard animated else { return out }
    for (k, panel) in panels.panels.enumerated() {
      var env = framing[k].space?.environment(at: time, run: run) ?? panel.graph.environment(at: time, run: run)
      env["t"] = time
      for row in panel.rows where out[row] == nil {
        let read = analysis.rows[row]
        guard read.error == nil, read.unsupported == nil, let plan = read.readout ?? read.cpu,
          let opening = readouts[row], let now = try? plotReadout(plan, env), now != opening.readout
        else { continue }
        out[row] = RowNote(info: now + opening.note)
      }
    }
    return out
  }

  /// Each row's readout as the analysis has it, apart from the note that
  /// follows it (lib/analysis.ts `withNote`: "readout · note"), for the rows
  /// whose readout can be found again at another time.
  private static func openingReadouts(_ analysis: DocumentAnalysis) -> [Int: OpeningReadout] {
    var out: [Int: OpeningReadout] = [:]
    var env = analysis.environment(at: 0)
    env["t"] = 0
    for (index, row) in analysis.rows.enumerated() {
      guard row.error == nil, row.unsupported == nil, let info = row.info, let plan = row.readout ?? row.cpu,
        let opening = try? plotReadout(plan, env), info.hasPrefix(opening)
      else { continue }
      let note = String(info.dropFirst(opening.count))
      if note.isEmpty || note.hasPrefix(" · ") { out[index] = OpeningReadout(readout: opening, note: note) }
    }
    return out
  }

  /// The surface panel `k` draws its 2D rows on (its first on(…) row that
  /// reads), with the names that surface reads, which a drag along it holds
  /// still (web/main.ts `surfaceReads`): the names in its text and, through
  /// the constants' rows, what those are made of.
  ///
  /// Port: the site follows a state's rate and start too (lib/defs.ts
  /// `definitionDependencies`); the constants' rows are what is read here.
  func surface(panel k: Int) -> (map: SurfaceMap, reads: Set<String>)? {
    guard framing[k].space?.document != nil else { return nil }
    for row in panels.panels[k].rows where analysis.rows[row].error == nil {
      guard case .surface(let map)? = analysis.rows[row].view, (try? surfaceGLSL(map)) != nil else { continue }
      return (map, reads(names(in: map.text)))
    }
    return nil
  }

  private func names(in text: String) -> [String] {
    (try? parseExpr(text, valueNames: analysis.valueNames)).map { Array(freeVars($0)) } ?? []
  }

  /// `names` and, through the constants' rows, everything they are made of
  /// (lib/defs.ts `definitionDependencies`, less a state's rate and start).
  func reads(_ names: [String]) -> Set<String> {
    var made: [String: String] = [:]
    for row in analysis.rows {
      if case .constant(let name, let rhs, _)? = row.definition { made[name] = rhs }
    }
    var reads: Set<String> = []
    var next = names
    while let name = next.popLast() {
      guard reads.insert(name).inserted, let rhs = made[name] else { continue }
      next += self.names(in: rhs)
    }
    return reads
  }

  /// The named points of a surface panel a drag can move along the surface,
  /// in the surface's x and y (web/scene.ts, the named points of a panel
  /// with a surface).
  func surfacePoints(panel k: Int, reads: Set<String>, time: Double, run: StateStepper?) -> [Grabbable] {
    guard let space = framing[k].space else { return [] }
    var env = space.environment(at: time, run: run)
    env["t"] = time
    return analysis.grabPoints(rows: panels.panels[k].rows, env: env, pinned: reads)
      .filter { analysis.rows[$0.row].definition != nil }
      .map { Grabbable(target: .row($0.row), x: $0.x, y: $0.y) }
  }

  /// The points of panel `k` a drag can move, where the panel draws them in
  /// the window `view` of a box `width` by `height` pixels: on a panel with
  /// mapped axes, in its screen's coordinates, and not at all where the
  /// screen does not show the point (web/scene.ts `carry`, of `grabs`). With
  /// `seeds`, the panel's seeds after them, which are on the screen already.
  func grabPoints(
    panel k: Int, rows: Range<Int>? = nil, time: Double, run: StateStepper?, view: View2D, width: Double,
    height: Double, seeds: [FieldSeed] = []
  ) -> [Grabbable] {
    let panel = panels.panels[k]
    var env = panel.graph.environment(at: time, run: run)
    env["t"] = time
    let shown = view.visible(width: width, height: height)
    let bounds = Graph2D.Bounds(xmin: shown.x[0], xmax: shown.x[1], ymin: shown.y[0], ymax: shown.y[1])
    var points: [Grabbable] = analysis.grabPoints(rows: rows ?? panel.rows, env: env).compactMap { point in
      panel.graph.screenPoint(point.x, point.y, bounds: bounds).map {
        Grabbable(target: .row(point.row), x: $0.x, y: $0.y)
      }
    }
    // A point placed by its coordinates' names, at each solution it was drawn
    // with. (Not on a mapped panel: its solutions are on the screen, and
    // the coordinates read x and y.)
    if panel.graph.maps == nil {
      for row in rows ?? panel.rows {
        guard let names = analysis.coordinateNames(row: row),
          analysis.movesCoordinatePoint(row: row, pinned: reads(names))
        else { continue }
        for (index, at) in panel.graph.solvedPoints(row: row).enumerated() where at.count == 2 {
          points.append(Grabbable(target: .solution(row: row, index: index), x: at[0], y: at[1]))
        }
      }
    }
    // A seed is one grabbable point however many fields trace a curve from it.
    if panel.graph.takesSeeds {
      points += seeds.enumerated().map { Grabbable(target: .seed($0.offset), x: $0.element.x, y: $0.element.y) }
    }
    return points
  }
}
