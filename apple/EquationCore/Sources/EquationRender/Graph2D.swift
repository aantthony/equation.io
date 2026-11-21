import EquationCore
import Foundation

/// From what the language makes of a document (EquationCore `analyze`) to
/// what the renderer draws: the part of web/main.ts between a row's plans and
/// the 2D renderer's layers and overlay. The app and metal-shot both draw
/// through here, so a shot of some rows is the app's picture of them.
///
/// It covers the plans the language's port compiles so far; a kind joins the
/// switch below as it is ported.
public struct Graph2D: Equatable, Sendable {
  public var analysis: DocumentAnalysis
  /// Each row's color, or nil for a row that takes none.
  public var colors: [RGB?]
  /// The shader passes: they depend on the rows alone, not on the time.
  public var layers = Layers2D()
  /// How much of the grid is drawn (a `grid(…)` row).
  public var grid: Frame2D.Grid = .on
  /// The coordinates a `grid(r, theta)` row names (Graph2D+Grid.swift).
  public var gridCoords: [String]?
  /// The window a `view(…)` row asks for.
  public var window: Window?
  /// The axis maps of the panel's view(…) row (`view(x = 10^X)`): the window
  /// is then the screen's, and what a row places is carried there (Graph2D+Maps.swift).
  public var maps: AxisMaps?
  /// Each orbit row's polyline (`p(0..50)`), integrated when the graph is
  /// made, and the error of one that cannot be (Graph2D+States.swift).
  public var orbits: [Int: [Double]] = [:]
  public var orbitErrors: [Int: String] = [:]
  /// Something moves with t, so the graph redraws every frame.
  public var animated = false
  /// The sequence rows that plot their partial sums S_N = Σ a_n instead of
  /// their terms (the site's toggle on such a row).
  public var partialSums: Set<Int> = []
  /// The system rows whose search box is certified (the site's "certify
  /// search box" toggle on such a row; Graph2D+Systems.swift).
  public var certified: Set<Int> = []
  /// The index names across and down when the graph is a lattice panel (its
  /// rows are an automaton's or a table's, or its view row names them): the
  /// grid then runs between cells and the cells are numbered. Nil for the plane.
  public var lattice: [String]?
  /// The cells kept from frame to frame.
  let discrete = DiscreteCache()
  /// What each random variable's row last drew (Graph2D+Distributions.swift).
  let lawsDrawn = DrawnLaws()
  /// What each system row last solved (Graph2D+Systems.swift).
  let systemsSolved = SolvedSystems()
  /// Each parametric region's triangles (Graph2D+ParametricRegions.swift).
  let sampledRegions = SampledRegions()
  /// The way back through the panel's plane map (Graph2D+Maps.swift).
  let planes = PlaneInverses()
  /// Each graph row's layout (Graph2D+Graphs.swift).
  let graphLayouts = GraphLayouts()
  /// The integral-curve seeds dropped on the panel's vector fields, and the
  /// one under the pointer (Graph2D+Seeds.swift): the drawer's, like `partialSums`.
  public var seeds: [FieldSeed] = []
  public var hotSeed: Int?
  /// The matrix-field rows that draw streamlines of their major eigenvector
  /// instead of glyphs (the site's toggle on such a row), and the row of each
  /// matrix-field pass.
  public var tensorStreamlines: Set<Int> = []
  var tensorRows: [Int] = []

  public struct Window: Equatable, Sendable {
    public var x: [Double]?
    public var y: [Double]?
    public var ratio: Double?
  }

  /// Samples along a parametric curve (lib/path.ts `CURVE_SAMPLES`).
  static let curveSamples = CURVE_SAMPLES

  public init(_ analysis: DocumentAnalysis, colors: [RGB?]) {
    self.analysis = analysis
    self.colors = colors
    animated = !analysis.animated.isEmpty
    var vfields: [VField2D] = []
    var ineqs: [Ineq2D] = []
    var projections: [Projected2D] = []
    var scalars: [Scalar2D] = []
    var curves: [Curve2D] = []
    var complexLayers = ComplexLayers()
    var tfields: [TField2D] = []
    var bifs: [Bif2D] = []
    var written: [String]?
    func error(_ row: RowAnalysis) -> String? { row.error ?? row.unsupported }
    for (index, row) in analysis.rows.enumerated() {
      switch row.view {
      case .grid(let mode)?: grid = Frame2D.Grid(rawValue: mode) ?? .on
      case .gridCoords(let names)?: gridCoords = names
      case .view(let x, let y, let ratio, _)?:
        window = Window(x: x, y: y, ratio: ratio)
        if error(row) == nil, written == nil { written = row.viewAxes }
      case .mappedView(let x, let y, let ratio, _, let mapped)?:
        window = Window(x: x, y: y, ratio: ratio)
        maps = mapped
      default: break
      }
      if row.classified?.animated == true { animated = true }
      guard row.error == nil, row.unsupported == nil, let gpu = row.gpu, index < colors.count,
        let color = colors[index]
      else { continue }
      switch gpu.shader {
      case .none:
        break
      case .family(let members):
        // One layer per member (Graph2D+Lists.swift).
        Self.addFamily(members, color: color, curves: &curves, ineqs: &ineqs, vfields: &vfields)
        Self.addProjections(members, color: color, into: &projections)
      case .implicit2d(let field, _):
        let graphEval = gpu.graphEval.map { Curve2D.GraphEval(glsl: $0.glsl, slopeScale: $0.slopeScale) }
        curves.append(Curve2D(field: field, graphEval: graphEval, color: color, params: gpu.params))
      case .ineq2d(let field, let edges):
        ineqs.append(Ineq2D(field: field, color: color, params: gpu.params, edges: edges))
      case .projected2d:
        // A family over an interval, searched along u per pixel (Graph2D+Intervals.swift).
        Self.addProjections([gpu], color: color, into: &projections)
      case .scalar2d(let field):
        scalars.append(Scalar2D(field: field, color: color, params: gpu.params))
      case .vfield2d(let fx, let fy):
        vfields.append(VField2D(fx: fx, fy: fy, color: color, params: gpu.params))
      case .complexField, .fractal2d, .color2d:
        complexLayers.add(gpu, color: color)
      case .tfield2d(let entries, let streamlines, let jacobian):
        tfields.append(
          TField2D(
            entries: entries, color: color, params: gpu.params, streamlines: streamlines, jacobian: jacobian))
        tensorRows.append(index)
      case .cobweb(let curveField):
        // The map's curve y = f(x); its path is the overlay's.
        curves.append(Curve2D(field: curveField, color: color, params: gpu.params))
      case .bifurcation(let field):
        var seed = 0.5
        if case .bifurcation(_, _, let a0Name)? = row.cpu { seed = Self.seed(a0Name, analysis.env) }
        bifs.append(Bif2D(field: field, color: color, params: gpu.params, uniforms: ["uSeed": seed]))
      case .implicit3d, .scalar3d, .vfield3d, .psurface:
        // Drawn in space (Document3D).
        break
      }
    }
    // A vector field's streamlines flow whether or not it reads t.
    // A state system is never at rest.
    if !vfields.isEmpty || gridAnimated || analysis.stateSystem != nil { animated = true }
    (orbits, orbitErrors) = Self.orbits(analysis)
    layers = Layers2D(vfields: vfields, ineqs: ineqs, scalars: scalars, curves: curves)
    complexLayers.write(to: &layers)
    if !tfields.isEmpty { layers.tfields = tfields }
    if !bifs.isEmpty { layers.bifs = bifs }
    if !projections.isEmpty { layers.projections = projections }
    if Self.isGraphPanel(analysis) { grid = .off }
    lattice = Self.latticeAxes(analysis)
    if let lattice, let written, let asked = window {
      let oriented = Self.orientLattice(x: asked.x, y: asked.y, written: written, axes: lattice)
      window = Window(x: oriented.x, y: oriented.y, ratio: asked.ratio)
    }
  }

  /// The constants' values `time` seconds after the graph opened: what the uniforms read.
  public func environment(at time: Double) -> [String: Double] {
    analysis.environment(at: time)
  }

  /// What is drawn over the shader passes at a time: the rows the CPU
  /// evaluates (points, parametric curves, a random variable's law). `bounds`
  /// is the part of the plane in view, which a sequence's dots and a cobweb's
  /// diagonal are drawn over, and a pmf's stems; `theme` gives that diagonal
  /// its color. Without bounds they are drawn over a window wide enough for
  /// most: a sequence's first 4000 terms, one dot each as the site draws them
  /// in any window narrower; and a law whole. `pointsPerUnit` is how far
  /// apart whole numbers stand on screen, which says whether stems have room
  /// for their dots. `run` has the states where the frame finds them
  /// (Graph2D+States.swift).
  /// `view` is the window itself, which a seeded integral curve steps by.
  public func overlay(
    at time: Double, bounds: Bounds? = nil, theme: GraphTheme = .light, pointsPerUnit: Double? = nil,
    run: StateStepper? = nil, view: View2D? = nil
  ) -> Overlay2D {
    let window = bounds
    let bounds = bounds ?? Bounds(xmin: -4000, xmax: 3999, ymin: -4000, ymax: 4000)
    var env = environment(at: time, run: run)
    env["t"] = time
    var overlay = Overlay2D()
    var named: [(row: Int, point: Overlay2D.Point)] = []
    for (index, row) in analysis.rows.enumerated() {
      guard row.error == nil, row.unsupported == nil, index < colors.count, let color = colors[index]
      else { continue }
      let css = CSSColor(color)
      // A mapped panel carries what the row places to its screen.
      let mark = markOverlay(overlay)
      defer { carry(&overlay, row, since: mark, bounds: bounds) }
      // A named point (`A = (1, 2)`) has no plan of its own: its components
      // are the constants A_x and A_y, and it is drawn with its name, after
      // every row's plot (below).
      if row.cpu == nil, let name = row.definition?.name, let x = env["\(name)_x"], let y = env["\(name)_y"],
        env["\(name)_z"] == nil, x.isFinite, y.isFinite
      {
        named.append((index, .init(x: x, y: y, color: css, label: writtenName(name))))
        continue
      }
      guard let cpu = row.cpu else { continue }
      switch cpu {
      case .point(2, let coords) where coords.count == 2:
        guard let x = try? evaluate(coords[0], env), let y = try? evaluate(coords[1], env), x.isFinite, y.isFinite
        else { continue }
        overlay.points.append(.init(x: x, y: y, color: css))
      case .pcurve(2, let comps, _, _, _) where comps.count == 2:
        // Sampled along u and broken at its jumps (branch cuts, steps, poles): a
        // sample the curve has no value at is a gap in the line too.
        overlay.polylines.append(.init(pts: samplePath(comps, env), color: css))
      case .polygon, .label:
        _ = drawGeometry(cpu, env, color: color, into: &overlay)
      case .vlist, .plist, .dlist, .dscatter, .histogram:
        _ = drawList(cpu, env, color: color, pointsPerUnit: pointsPerUnit, into: &overlay)
      case .family(let members):
        _ = drawList(cpu, env, color: color, pointsPerUnit: pointsPerUnit, into: &overlay)
        // A family of fields: each member traces its own curve through every
        // seed, in its shade (web/scene.ts `renderMembers`, case 'vfield2d').
        for (k, member) in members.enumerated() {
          guard case .vfield2d(let comps) = member.cpu else { continue }
          let shade = CSSColor(Self.familyColor(color, member: k, of: members.count))
          drawSeeds(comps, color: shade, env: env, view: view, bounds: bounds, into: &overlay)
        }
      case .sequence(let term, let n):
        overlay.points += Self.sequenceDots(
          term: term, index: n, env: env, bounds: bounds, color: css, partialSum: partialSums.contains(index))
      case .cobweb(let f, let recVar, let a0Name):
        Self.cobweb(
          f: f, recVar: recVar, seed: Self.seed(a0Name, env), env: env, bounds: bounds, color: css,
          axis: theme.axis, into: &overlay)
      case .density, .pmf, .prob, .expect:
        drawDistribution(
          cpu, row: index, color: color, env: env, window: window, pointsPerUnit: pointsPerUnit, into: &overlay)
      case .system(2, _, _, _, _), .complexSystem:
        drawSystem(cpu, row: index, color: css, env: env, window: window, into: &overlay)
      case .value(_, let shade?):
        // A definite integral's row: the area it measures (Graph2D+Integrals.swift).
        drawIntegral(shade, row: index, color: color, env: env, bounds: bounds, into: &overlay)
      case .pregion(let comps) where comps.count == 2:
        drawParametricRegion(comps, row: index, env: env, color: color, into: &overlay)
      case .vfield2d(let comps):
        // The curves through the seeds a viewer dropped (Graph2D+Seeds.swift).
        drawSeeds(comps, color: css, env: env, view: view, bounds: bounds, into: &overlay)
      case .graph(let edges):
        drawGraph(edges, row: index, color: css, env: env, time: time, pointsPerUnit: pointsPerUnit, into: &overlay)
      case .orbit:
        if let pts = orbits[index] { overlay.polylines.append(.init(pts: pts, color: css)) }
      case .trail(2, let coords):
        // Where the point has been, as the run saw it, and where it is now.
        if let trail = run?.trails[index] {
          overlay.polylines.append(.init(pts: trail.coordinates, color: css))
          if let p = trail.head { overlay.points.append(.init(x: p[0], y: p[1], color: css)) }
        } else if let x = try? evaluate(coords[0], env), let y = try? evaluate(coords[1], env), x.isFinite, y.isFinite {
          overlay.points.append(.init(x: x, y: y, color: css))
        }
      default:
        break
      }
    }
    // Named points draw over what the rows drew, in their rows' order
    // (web/scene.ts `renderFrame`, after its loop over the rows).
    for (index, point) in named {
      let mark = markOverlay(overlay)
      overlay.points.append(point)
      carry(&overlay, analysis.rows[index], since: mark, bounds: bounds)
    }
    return overlay
  }

  /// The window the graph opens with in a frame `width` × `height` pixels:
  /// the one a `view(…)` row asks for, or else the origin at the center with
  /// 12 units across the shorter side. A lattice with no view row opens on
  /// its cells (lib/automaton.ts `latticeFrame`), a table's big enough to
  /// print its values at `dpr` pixels to a point.
  public func opening(width: Double, height: Double, dpr: Double = 1) -> View2D {
    var view = View2D.opening(width: width, height: height)
    if lattice != nil, window == nil, width > 0, height > 0 {
      let first = analysis.rows.lazy.filter { $0.error == nil && $0.unsupported == nil }.compactMap(\.cpu).first {
        switch $0 {
        case .automaton, .lattice: true
        default: false
        }
      }
      let frame = latticeFrame(first, analysis.env, width: width, height: height, cellPx: (latticeValuePx + 30) * dpr)
      return View2D(cx: frame.cx, cy: frame.cy, upp: frame.upp)
    }
    guard let window, width > 0, height > 0 else { return view }
    if let ratio = window.ratio, ratio > 0, ratio.isFinite { view.ratio = ratio }
    if let x = window.x, x.count == 2 { view.cx = (x[0] + x[1]) / 2 }
    if let y = window.y, y.count == 2 { view.cy = (y[0] + y[1]) / 2 }
    // The scale that shows every range asked for.
    let acrossX = window.x.flatMap { $0.count == 2 ? abs($0[1] - $0[0]) / width : nil }
    let acrossY = window.y.flatMap { $0.count == 2 ? abs($0[1] - $0[0]) / height * (view.ratio ?? 1) : nil }
    if let upp = [acrossX, acrossY].compactMap({ $0 }).max(), upp > 0, upp.isFinite { view.upp = upp }
    return view
  }

  /// How the frame is drawn: how much of the grid, and whether between the
  /// cells of a lattice.
  public var frame: Frame2D { Frame2D(grid: grid, lattice: lattice == nil ? nil : true) }

  /// The frame written down, for a picture of it (`MetalContext.image`).
  /// `view` is the window to draw (the opening one without): a panel's, as
  /// its drawer has moved it. `run` has the states where the frame finds them.
  public func scene(
    at time: Double, width: Double, height: Double, dpr: Double = 1, theme: GraphTheme = .light,
    view: View2D? = nil, run: StateStepper? = nil
  ) -> Scene2D {
    var scene = Scene2D(layers: toggled(layers), env: environment(at: time, run: run), frame: frame, time: time)
    let view = view ?? opening(width: width, height: height, dpr: dpr)
    scene.view = view
    let drawn = cells(at: time, view: view, width: width, height: height, dpr: dpr)
    if !drawn.cells.isEmpty { scene.layers.cells = drawn.cells }
    scene.lattice = drawn.labels
    scene.overlay = overlay(
      at: time, bounds: Bounds(view: view, width: width, height: height), theme: theme,
      pointsPerUnit: 1 / (view.upp * dpr), run: run, view: view)
    scene.gridSpecs = gridSpecs(at: time, view: view, width: width, height: height)
    scene.maps = maps
    return scene
  }
}

extension Graph2D {
  /// Which rows take a palette color, and the slot each takes (lib/palette.ts):
  /// `previous` is each row's slot so far, by the editor's id for it, so a
  /// row keeps its color as others come and go. A `#hex` note picks its own:
  /// it is read from `sources`, the rows as written (the analysis keeps a
  /// row's text without its note).
  public static func colors<ID: Hashable>(
    _ analysis: DocumentAnalysis, ids: [ID], previous: [ID: Int], theme: GraphTheme, sources: [String]? = nil
  ) -> (colors: [RGB?], slots: [ID: Int]) {
    let takes = analysis.rows.map { row -> Bool in
      // The language does not say whether a row it cannot read yet takes a
      // color; a row with an error does (it is usually a curve being typed).
      if row.unsupported != nil {
        return !row.comment && row.view == nil && row.definition == nil
          && row.text.contains { !$0.isWhitespace } && noteColor(row.text) == nil
      }
      return row.takesColor
    }
    let index = assignColors(
      rows: zip(ids, takes).map { (id: $0, takes: $1) }, previous: previous, size: theme.palette.count)
    var slots: [ID: Int] = [:]
    var colors: [RGB?] = []
    for (k, row) in analysis.rows.enumerated() {
      let slot = k < index.count ? index[k] : -1
      if slot >= 0, k < ids.count { slots[ids[k]] = slot }
      let written = sources.flatMap { k < $0.count ? $0[k] : nil } ?? row.text
      colors.append(noteColor(written) ?? (slot >= 0 ? theme.palette[slot] : nil))
    }
    return (colors, slots)
  }
}
