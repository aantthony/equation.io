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
  /// The window a `view(…)` row asks for.
  public var window: Window?
  /// Something moves with t, so the graph redraws every frame.
  public var animated = false
  /// The sequence rows that plot their partial sums S_N = Σ a_n instead of
  /// their terms (the site's toggle on such a row).
  public var partialSums: Set<Int> = []
  /// The index names across and down when the graph is a lattice panel (its
  /// rows are an automaton's or a table's, or its view row names them): the
  /// grid then runs between cells and the cells are numbered. Nil for the plane.
  public var lattice: [String]?
  /// The cells kept from frame to frame.
  let discrete = DiscreteCache()

  public struct Window: Equatable, Sendable {
    public var x: [Double]?
    public var y: [Double]?
    public var ratio: Double?
  }

  /// Samples along a parametric curve (lib/path.ts `CURVE_SAMPLES`).
  static let curveSamples = 400

  public init(_ analysis: DocumentAnalysis, colors: [RGB?]) {
    self.analysis = analysis
    self.colors = colors
    animated = !analysis.animated.isEmpty
    var vfields: [VField2D] = []
    var ineqs: [Ineq2D] = []
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
      case .view(let x, let y, let ratio, _)?:
        window = Window(x: x, y: y, ratio: ratio)
        if error(row) == nil, written == nil { written = row.viewAxes }
      default: break
      }
      if row.classified?.animated == true { animated = true }
      guard row.error == nil, row.unsupported == nil, let gpu = row.gpu, index < colors.count,
        let color = colors[index]
      else { continue }
      switch gpu.shader {
      case .none:
        break
      case .implicit2d(let field, _):
        let graphEval = gpu.graphEval.map { Curve2D.GraphEval(glsl: $0.glsl, slopeScale: $0.slopeScale) }
        curves.append(Curve2D(field: field, graphEval: graphEval, color: color, params: gpu.params))
      case .ineq2d(let field, let edges):
        ineqs.append(Ineq2D(field: field, color: color, params: gpu.params, edges: edges))
      case .scalar2d(let field):
        scalars.append(Scalar2D(field: field, color: color, params: gpu.params))
      case .vfield2d(let fx, let fy):
        vfields.append(VField2D(fx: fx, fy: fy, color: color, params: gpu.params))
      case .complexField, .fractal2d, .color2d:
        complexLayers.add(gpu, color: color)
      case .tfield2d(let entries, let streamlines):
        tfields.append(TField2D(entries: entries, color: color, params: gpu.params, streamlines: streamlines))
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
    if !vfields.isEmpty { animated = true }
    layers = Layers2D(vfields: vfields, ineqs: ineqs, scalars: scalars, curves: curves)
    complexLayers.write(to: &layers)
    if !tfields.isEmpty { layers.tfields = tfields }
    if !bifs.isEmpty { layers.bifs = bifs }
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
  /// evaluates (points, parametric curves). `bounds` is the part of the
  /// plane in view, which a sequence's dots and a cobweb's diagonal are
  /// drawn over; `theme` gives that diagonal its color. Without bounds they
  /// are drawn over a window wide enough for most: a sequence's first 4000
  /// terms, one dot each as the site draws them in any window narrower.
  public func overlay(at time: Double, bounds: Bounds? = nil, theme: GraphTheme = .light) -> Overlay2D {
    let bounds = bounds ?? Bounds(xmin: -4000, xmax: 3999, ymin: -4000, ymax: 4000)
    var env = environment(at: time)
    env["t"] = time
    var overlay = Overlay2D()
    for (index, row) in analysis.rows.enumerated() {
      guard row.error == nil, row.unsupported == nil, index < colors.count, let color = colors[index]
      else { continue }
      let css = CSSColor(color)
      // A named point (`A = (1, 2)`) has no plan of its own: its components
      // are the constants A_x and A_y, and it is drawn with its name.
      if row.cpu == nil, let name = row.definition?.name, let x = env["\(name)_x"], let y = env["\(name)_y"],
        env["\(name)_z"] == nil, x.isFinite, y.isFinite
      {
        overlay.points.append(.init(x: x, y: y, color: css, label: name))
        continue
      }
      guard let cpu = row.cpu else { continue }
      switch cpu {
      case .point(2, let coords) where coords.count == 2:
        guard let x = try? evaluate(coords[0], env), let y = try? evaluate(coords[1], env), x.isFinite, y.isFinite
        else { continue }
        overlay.points.append(.init(x: x, y: y, color: css))
      case .pcurve(2, let comps, _, _, _) where comps.count == 2:
        var pts: [Double] = []
        pts.reserveCapacity(Self.curveSamples * 2)
        var scope = env
        for k in 0..<Self.curveSamples {
          scope["u"] = Double(k) / Double(Self.curveSamples - 1)
          // A sample the curve has no value at is a gap in the line.
          pts.append((try? evaluate(comps[0], scope)) ?? .nan)
          pts.append((try? evaluate(comps[1], scope)) ?? .nan)
        }
        overlay.polylines.append(.init(pts: pts, color: css))
      case .polygon, .label:
        _ = drawGeometry(cpu, env, color: color, into: &overlay)
      case .sequence(let term, let n):
        overlay.points += Self.sequenceDots(
          term: term, index: n, env: env, bounds: bounds, color: css, partialSum: partialSums.contains(index))
      case .cobweb(let f, let recVar, let a0Name):
        Self.cobweb(
          f: f, recVar: recVar, seed: Self.seed(a0Name, env), env: env, bounds: bounds, color: css,
          axis: theme.axis, into: &overlay)
      default:
        break
      }
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
  public func scene(
    at time: Double, width: Double, height: Double, dpr: Double = 1, theme: GraphTheme = .light
  ) -> Scene2D {
    var scene = Scene2D(layers: layers, env: environment(at: time), frame: frame, time: time)
    let view = opening(width: width, height: height, dpr: dpr)
    scene.view = view
    let drawn = cells(at: time, view: view, width: width, height: height, dpr: dpr)
    if !drawn.cells.isEmpty { scene.layers.cells = drawn.cells }
    scene.lattice = drawn.labels
    scene.overlay = overlay(at: time, bounds: Bounds(view: view, width: width, height: height), theme: theme)
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
