import EquationCore
import Foundation
import Metal
import simd

/// The values a draw gives its program's uniforms, by name.
typealias Uniforms3D = [String: [Float]]

/// GPU storage for geometry that holds from frame to frame
/// (web/retained-geometry.ts). The site keys an entry by the array object;
/// arrays here are values, so the key is their length and a hash of their
/// bits. Unused entries are freed each frame, so animation, edits and
/// deleted rows cannot accumulate old buffers.
final class RetainedGeometry {
  private var entries: [String: (buffers: [any MTLBuffer], used: Bool)] = [:]

  func buffers(_ key: [Float], make: () -> [any MTLBuffer]?) -> [any MTLBuffer]? {
    let id = "\(key.count):\(hashBits(key[...]))"
    if let entry = entries[id] {
      entries[id]!.used = true
      return entry.buffers
    }
    guard let made = make() else { return nil }
    entries[id] = (made, true)
    return made
  }

  func endFrame() {
    entries = entries.filter { $0.value.used }.mapValues { ($0.buffers, false) }
  }

  func clear() {
    entries = [:]
  }
}

/// A buffer of some numbers, or nil for none: Metal makes no empty buffer.
private func makeBuffer<T: BitwiseCopyable>(_ device: any MTLDevice, _ values: [T]) -> (any MTLBuffer)? {
  values.withUnsafeBytes { bytes in
    bytes.baseAddress.flatMap { bytes.isEmpty ? nil : device.makeBuffer(bytes: $0, length: bytes.count) }
  }
}

/// The 3D renderer: web/render3d.ts `Renderer3D`.
///
/// The site draws a frame in one call, binding its offscreen surface targets
/// in the middle of it. A Metal pass has one target from start to end, so a
/// frame here is two calls: `prepare`, which raymarches the implicit
/// surfaces and clouds into their targets with passes of its own on the
/// command buffer, then `render`, which draws everything else into the
/// frame's pass and composites those targets where the site does. The
/// frame's pass needs a `depthFormat` depth attachment cleared to 1, and
/// `sampleCount` samples.
public final class Renderer3D {
  public let metal: MetalContext
  /// Samples per pixel of the pass `render` draws into. The site's canvas
  /// is antialiased the same way (`antialias: true`); the raymarched
  /// surfaces are smoothed by their own jittered passes instead.
  public let sampleCount: Int
  /// How long the surfaces must hold still before refining begins, in
  /// seconds (the site's REST_MS): during a drag the gaps between moves
  /// would otherwise each draw a refinement pass, as costly as the drag's
  /// own frames, only for the next move to discard it. A picture drawn all
  /// at once sets it to 0.
  public var rest = 0.15
  /// The GLSL of the loop helpers the scenes' shaders name (see ProgramCache3D).
  public var helpers: String {
    get { cache.helpers }
    set { cache.helpers = newValue }
  }
  /// Shaders compiled since the renderer was made (web/gl.ts `glStats`).
  public var compiles: Int { cache.compiles }
  /// How many of them didn't compile, and so draw nothing.
  public var failures: Int { cache.failures }

  let cache: ProgramCache3D
  let geometry = RetainedGeometry()
  let spacings = SpacingCache()
  /// Per panel, by its viewport origin.
  var surfaceStates: [String: SurfaceState] = [:]
  /// A depth texture to stand behind a sampler nothing reads.
  private(set) lazy var noDepth: (any MTLTexture)? = makeTarget(1, 1)?.depth

  private let depthStates: [Bool: [Bool: any MTLDepthStencilState]]
  let support: (scatter: Program3D, composite: Program3D, upscale: Program3D)?
  let quadBuffer: (any MTLBuffer)?
  private let axesBuffer: (any MTLBuffer)?
  private let cone: (positions: (any MTLBuffer)?, normals: (any MTLBuffer)?, indices: (any MTLBuffer)?, count: Int)
  private let grid: (uvs: (any MTLBuffer)?, indices: (any MTLBuffer)?, count: Int)
  private let streamlineSeeds: (buffer: (any MTLBuffer)?, count: Int)

  static let quadLayout = VertexLayout.interleaved([2])
  private static let axesLayout = VertexLayout.interleaved([3, 3])
  private static let lineLayout = VertexLayout.interleaved([3])
  private static let pointLayout = VertexLayout.interleaved([3, 3, 3])
  private static let tubeLayout = VertexLayout.separate([3, 3, 2])
  private static let gridLayout = VertexLayout.interleaved([2])
  private static let seedLayout = VertexLayout.interleaved([4], perInstance: true)
  /// The unit cone's positions and normals, then a buffer of instances: tip, direction, scale.
  private static let coneLayout = VertexLayout(
    attributes: [
      .init(location: 0, size: 3, buffer: 0, offset: 0), .init(location: 1, size: 3, buffer: 1, offset: 0),
      .init(location: 2, size: 3, buffer: 2, offset: 0), .init(location: 3, size: 3, buffer: 2, offset: 12),
      .init(location: 4, size: 2, buffer: 2, offset: 24),
    ],
    buffers: [.init(stride: 12), .init(stride: 12), .init(stride: 32, perInstance: true)])

  public init(_ metal: MetalContext, sampleCount: Int = 4) {
    self.metal = metal
    self.sampleCount = sampleCount
    cache = ProgramCache3D(metal)
    let device = metal.device

    var states: [Bool: [Bool: any MTLDepthStencilState]] = [:]
    for always in [false, true] {
      for write in [false, true] {
        let descriptor = MTLDepthStencilDescriptor()
        descriptor.depthCompareFunction = always ? .always : .lessEqual
        descriptor.isDepthWriteEnabled = write
        states[always, default: [:]][write] = device.makeDepthStencilState(descriptor: descriptor)
      }
    }
    depthStates = states

    do {
      let library = try metal.makeLibrary(supportSource)
      let program = { Program3D(library, vertex: "eq3_quad", fragment: $0) }
      support = (program("eq3_scatter"), program("eq3_composite"), program("eq3_upscale"))
    } catch {
      print("Shader compile error: \(error)")
      support = nil
    }

    func buffer<T: BitwiseCopyable>(_ values: [T]) -> (any MTLBuffer)? { makeBuffer(device, values) }
    quadBuffer = buffer([Float](arrayLiteral: -1, -1, 3, -1, -1, 3))

    let unitCone = buildUnitCone()
    cone = (buffer(unitCone.positions), buffer(unitCone.normals), buffer(unitCone.indices), unitCone.indices.count)

    // Static (u,v) unit-square grid, displaced per-surface in the vertex shader.
    var uvs: [Float] = []
    for j in 0..<GRID_N {
      for i in 0..<GRID_N { uvs += [Float(i) / Float(GRID_N - 1), Float(j) / Float(GRID_N - 1)] }
    }
    var indices: [UInt32] = []
    for j in 0..<(GRID_N - 1) {
      for i in 0..<(GRID_N - 1) {
        let a = UInt32(j * GRID_N + i)
        let n = UInt32(GRID_N)
        indices += [a, a + 1, a + n, a + 1, a + n + 1, a + n]
      }
    }
    grid = (buffer(uvs), buffer(indices), indices.count)

    // Jittered lattice seeds in the unit box, each with a wave phase.
    let n = STREAMLINE_CELLS_N
    var seeds: [Float] = []
    var hash: UInt32 = 0x2545_f491
    func random() -> Double {
      hash ^= hash << 13
      hash ^= hash >> 17
      hash ^= hash << 5
      return Double(hash) / 4294967296
    }
    for k in 0..<n {
      for j in 0..<n {
        for i in 0..<n {
          for _ in 0..<STREAMLINES_PER_CELL {
            seeds.append(Float(-1 + 2 * (Double(i) + random()) / Double(n)))
            seeds.append(Float(-1 + 2 * (Double(j) + random()) / Double(n)))
            seeds.append(Float(-1 + 2 * (Double(k) + random()) / Double(n)))
            seeds.append(Float(2 * Double.pi * random()))
          }
        }
      }
    }
    streamlineSeeds = (buffer(seeds), n * n * n * STREAMLINES_PER_CELL)

    axesBuffer = buffer([
      // x axis: red-ish
      -1, 0, 0, 0.75, 0.3, 0.3, 1, 0, 0, 0.75, 0.3, 0.3,
      // y axis: green-ish
      0, -1, 0, 0.3, 0.65, 0.3, 0, 1, 0, 0.3, 0.65, 0.3,
      // z axis: blue-ish
      0, 0, -1, 0.3, 0.4, 0.8, 0, 0, 1, 0.3, 0.4, 0.8,
    ] as [Float])
  }

  public func clearGeometry() {
    geometry.clear()
  }

  // MARK: - What a draw is told

  /// A panel's box, the camera through it, and the uniforms every program is offered.
  struct Panel {
    /// The box in device pixels, from the bottom-left corner as GL counts.
    var box: Frame2D.Box
    /// The target's height, to turn the box over.
    var targetHeight: Int
    var vp: Mat4
    var invVp: Mat4
    var eye: SIMD3<Double>
    var boxR: Double
    var time: Double
    var env: [String: Double]
    /// The site's key for a panel's surface states: its viewport origin.
    var id: String { "\(box.x),\(box.y)" }
    var w: Int { Int(box.w) }
    var h: Int { Int(box.h) }

    init(_ cam: Camera3D, target: (width: Int, height: Int), frame: Frame2D, time: Double, env: [String: Double]) {
      box = frame.vp ?? Frame2D.Box(x: 0, y: 0, w: Double(target.width), h: Double(target.height))
      targetHeight = target.height
      (vp, invVp, eye) = cameraMatrices(cam, box.w / box.h)
      boxR = cameraBoxR(cam)
      self.time = time
      self.env = env
    }

    /// The site's `setCommon`.
    var common: Uniforms3D {
      [
        "uVP": vp, "uInvVP": invVp, "uRes": [Float(box.w), Float(box.h)], "uOrigin": [Float(box.x), Float(box.y)],
        "uBoxR": [Float(boxR)], "t": [Float(time)], "uEye": [Float(eye.x), Float(eye.y), Float(eye.z)],
      ]
    }

    /// The site's `setParams`: each constant a shader reads, as its u_<name> uniform.
    func params(_ params: [String]?, _ uniforms: [String: Double]?) -> Uniforms3D {
      var values: Uniforms3D = [:]
      for p in params ?? [] {
        let name = uniformName(p)
        values[name] = [Float(uniforms?[name] ?? env[p] ?? 0)]
      }
      return values
    }

    /// The values of a row's constants, for a key of what its pixels depend on.
    func values(_ params: [String]?, _ uniforms: [String: Double]?) -> [Double] {
      (params ?? []).map { uniforms?[uniformName($0)] ?? env[$0] ?? 0 }
    }
  }

  /// Make `program` the one drawn with: its pipeline for this layout, blend
  /// and target, its uniforms from `values` (one it names and they don't
  /// is 0), and its textures. False if it can't be drawn with.
  @discardableResult
  func use(
    _ encoder: any MTLRenderCommandEncoder, _ program: Program3D, layout: VertexLayout?, blend: Blend3D = .over,
    target: Target3D, height: Int, depth: (always: Bool, write: Bool) = (false, true), _ values: Uniforms3D,
    textures: [(any MTLTexture)?] = []
  ) -> Bool {
    guard let state = program.state(layout: layout, blend: blend, target: target) else { return false }
    encoder.setRenderPipelineState(state)
    encoder.setDepthStencilState(depthStates[depth.always]?[depth.write])
    if program.count > 0 {
      var floats = [Float](repeating: 0, count: program.count)
      floats[0] = Float(height)
      for (name, slot) in program.slots {
        guard let given = values[name] else { continue }
        for k in 0..<min(slot.count, given.count) { floats[slot.offset + k] = given[k] }
      }
      let length = floats.count * MemoryLayout<Float>.stride
      encoder.setVertexBytes(&floats, length: length, index: uniformBufferIndex)
      encoder.setFragmentBytes(&floats, length: length, index: uniformBufferIndex)
    }
    for (index, texture) in textures.enumerated() { encoder.setFragmentTexture(texture, index: index) }
    return true
  }

  func buffer<T: BitwiseCopyable>(_ values: [T]) -> (any MTLBuffer)? { makeBuffer(metal.device, values) }

  /// The fullscreen triangle, with whatever program is in use.
  func drawQuad(_ encoder: any MTLRenderCommandEncoder) {
    encoder.setVertexBuffer(quadBuffer, offset: 0, index: 0)
    encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
  }

  // MARK: - A frame

  /// Draw a panel's frame into `encoder`, whose target is `target` pixels
  /// (web/render3d.ts `Renderer3D.render`). `prepare` comes first, on the
  /// same command buffer, with the same arguments.
  public func render(
    _ encoder: any MTLRenderCommandEncoder,
    target: (width: Int, height: Int),
    cam: Camera3D,
    scene: Scene3D,
    time: Double = 0,
    env: [String: Double] = [:],
    frame: Frame2D = Frame2D(),
    theme: GraphTheme
  ) {
    let panel = Panel(cam, target: target, frame: frame, time: time, env: env)
    let box = panel.box
    guard box.w >= 1, box.h >= 1 else { return }
    let grid = frame.grid ?? .on
    // GL counts the box up from the bottom of the target; Metal, down from the top.
    let top = Double(target.height) - box.y - box.h
    encoder.setViewport(MTLViewport(originX: box.x, originY: top, width: box.w, height: box.h, znear: 0, zfar: 1))
    let left = min(max(Int(box.x), 0), target.width)
    let upper = min(max(Int(top), 0), target.height)
    encoder.setScissorRect(
      MTLScissorRect(
        x: left, y: upper, width: max(min(Int(box.w), target.width - left), 0),
        height: max(min(Int(box.h), target.height - upper), 0)))

    let main = Target3D(color: MetalContext.pixelFormat, samples: sampleCount)
    let common = panel.common
    let boxR = panel.boxR
    /// `use`, into the frame.
    func use(
      _ program: Program3D, _ layout: VertexLayout, _ values: Uniforms3D, blend: Blend3D = .over, write: Bool = true
    ) -> Bool {
      self.use(
        encoder, program, layout: layout, blend: blend, target: main, height: target.height, depth: (false, write),
        common.merging(values) { $1 })
    }
    let color = { (c: RGB) in ["uColor": [c.x, c.y, c.z]] as Uniforms3D }

    // Axes lines.
    if grid != .off, let program = cache.get(AXES_VERT, AXES_FRAG), let axesBuffer,
      use(program, Self.axesLayout, [:])
    {
      encoder.setVertexBuffer(axesBuffer, offset: 0, index: 0)
      encoder.drawPrimitives(type: .line, vertexStart: 0, vertexCount: 6)
    }

    if !scene.implicits.isEmpty, let state = surfaceStates[panel.id] {
      composite(encoder, state.full, panel, target: main, write: true)
    }

    func drawGrid() {
      encoder.setVertexBuffer(self.grid.uvs, offset: 0, index: 0)
      if let indices = self.grid.indices {
        encoder.drawIndexedPrimitives(
          type: .triangle, indexCount: self.grid.count, indexType: .uint32, indexBuffer: indices, indexBufferOffset: 0)
      }
    }
    for s in scene.psurfaces {
      guard let program = cache.get(psurfVert(s.comps, s.params), psurfFrag(s.comps, s.du, s.dv, s.params, s.paint))
      else { continue }
      var values = panel.params(s.params, s.uniforms).merging(color(s.color)) { $1 }
      if s.paint != nil { values["uGain"] = [Float(s.gain ?? 1)] }
      if use(program, Self.gridLayout, values) { drawGrid() }
    }

    // Rows painted on a surface: over it, pulled a hair toward the eye so
    // they win its depth test, and translucent, so they leave depth alone.
    if let paints = scene.paints, !paints.isEmpty {
      encoder.setDepthBias(-4, slopeScale: -1, clamp: 0)
      for s in paints {
        guard
          let program = cache.get(
            psurfVert(s.comps, s.params, s.lift ?? false), paintFrag(s.comps, s.du, s.dv, s.xy, s.paint, s.params))
        else { continue }
        var values = panel.params(s.params, s.uniforms).merging(color(s.color)) { $1 }
        if s.paint.kind == .scalar { values["uGain"] = [Float(s.paint.gain ?? 0.6)] }
        if use(program, Self.gridLayout, values, write: false) { drawGrid() }
      }
      encoder.setDepthBias(0, slopeScale: 0, clamp: 0)
    }

    // CPU-built lit meshes: tubes and hull solids. Pushed a hair back so a
    // hull's edge lines, which lie exactly in its faces, stay on top of them.
    if !scene.tubes.isEmpty, let program = cache.get(TUBE_VERT, TUBE_FRAG) {
      encoder.setDepthBias(1, slopeScale: 1, clamp: 0)
      for tube in scene.tubes {
        let make = { () -> [any MTLBuffer]? in
          guard let positions = self.buffer(tube.positions), let normals = self.buffer(tube.normals),
            let uvs = self.buffer(tube.uvs), let indices = self.buffer(tube.indices)
          else { return nil }
          return [positions, normals, uvs, indices]
        }
        guard let buffers = tube.retained == true ? geometry.buffers(tube.positions, make: make) : make(),
          use(program, Self.tubeLayout, color(tube.color).merging(["uCells": [tube.cells.x, tube.cells.y]]) { $1 })
        else { continue }
        for index in 0..<3 { encoder.setVertexBuffer(buffers[index], offset: 0, index: index) }
        encoder.drawIndexedPrimitives(
          type: .triangle, indexCount: tube.indices.count, indexType: .uint32, indexBuffer: buffers[3],
          indexBufferOffset: 0)
      }
      encoder.setDepthBias(0, slopeScale: 0, clamp: 0)
    }

    // CPU-sampled parametric curves and points.
    let line = cache.get(LINE_VERT, LINE_FRAG)
    for c in scene.curves {
      guard let line else { break }
      let cones = c.arrow == true ? arrowConeInstances(c.pts, finiteRuns(c.pts), boxR) : nil
      let pts = cones?.shafts ?? c.pts
      guard let vertices = buffer(pts) else { continue }
      let count = pts.count / 3
      func useLine(alpha: Float, write: Bool = true) -> Bool {
        let values: Uniforms3D = [
          "uAlpha": [alpha], "uFade": [c.fade == true ? 1 : 0], "uCount": [Float(count)],
        ]
        guard use(line, Self.lineLayout, values.merging(color(c.color)) { $1 }, write: write) else { return false }
        encoder.setVertexBuffer(vertices, offset: 0, index: 0)
        return true
      }
      // A fan from the first vertex, as triangles: Metal has no fan to draw.
      if c.fill == true, count >= 4, useLine(alpha: 0.18, write: false) {
        let fan: [UInt32] = (1..<(count - 2)).flatMap { [0, UInt32($0), UInt32($0 + 1)] }
        if let indices = buffer(fan) {
          encoder.drawIndexedPrimitives(
            type: .triangle, indexCount: fan.count, indexType: .uint32, indexBuffer: indices, indexBufferOffset: 0)
        }
      }
      // One strip per finite run: a NaN vertex inside a strip is not a pen
      // lift. A lattice of 2-point glyphs packs as lines so hundreds of
      // arrows are one draw.
      let runs = finiteRuns(pts)
      let glyphLattice = c.arrow == true && runs.count > 1 && runs.allSatisfy { $0.count == 2 }
      if glyphLattice {
        let packed = runs.flatMap { pts[($0.first * 3)..<($0.first * 3 + 6)] }
        if let lines = buffer(packed), useLine(alpha: 1) {
          encoder.setVertexBuffer(lines, offset: 0, index: 0)
          encoder.drawPrimitives(type: .line, vertexStart: 0, vertexCount: runs.count * 2)
        }
      } else if useLine(alpha: 1) {
        for run in runs { encoder.drawPrimitives(type: .lineStrip, vertexStart: run.first, vertexCount: run.count) }
      }
      if let cones, cones.count > 0, let program = cache.get(CONE_VERT, CONE_FRAG),
        let instances = buffer(cones.instances), let indices = cone.indices,
        use(program, Self.coneLayout, color(c.color))
      {
        encoder.setVertexBuffer(cone.positions, offset: 0, index: 0)
        encoder.setVertexBuffer(cone.normals, offset: 0, index: 1)
        encoder.setVertexBuffer(instances, offset: 0, index: 2)
        encoder.drawIndexedPrimitives(
          type: .triangle, indexCount: cone.count, indexType: .uint16, indexBuffer: indices, indexBufferOffset: 0,
          instanceCount: cones.count)
      }
    }
    for s in scene.segments {
      guard let line else { break }
      let make = { self.buffer(s.pts).map { [$0] } }
      let values: Uniforms3D = ["uAlpha": [1], "uFade": [0], "uCount": [Float(s.pts.count / 3)]]
      guard let buffers = s.retained == true ? geometry.buffers(s.pts, make: make) : make(),
        use(line, Self.lineLayout, values.merging(color(s.color)) { $1 })
      else { continue }
      encoder.setVertexBuffer(buffers[0], offset: 0, index: 0)
      encoder.drawPrimitives(type: .line, vertexStart: 0, vertexCount: s.pts.count / 3)
    }
    if !scene.points.isEmpty, let program = cache.get(POINT_VERT, POINT_FRAG) {
      // One upload and two draws for every point in the scene: a 10 000-point
      // cloud is not 10 000 draws (see POINT_VERT for the two passes).
      let liftK = POINT_LIFT * tan(FOV / 2) / box.h
      // Framebuffer pixels per world unit, times the depth.
      let pxK = box.h / (2 * tan(FOV / 2))
      var values: Uniforms3D = [
        "uLiftK": [liftK.isFinite ? Float(liftK) : 0], "uPxK": [Float(pxK)], "uMaxPx": [Float(POINT_MAX_PX)],
        "uDepthPass": [0],
      ]
      let verts = pointVertices(
        panel.vp, scene.points, loneD: POINT_PX * cam.radius / pxK, minD: POINT_CLOUD_MIN_PX * cam.radius / pxK,
        minSpan: boxR, spacings: spacings)
      if let vertices = buffer(verts) {
        if use(program, Self.pointLayout, values, write: false) {
          encoder.setVertexBuffer(vertices, offset: 0, index: 0)
          encoder.drawPrimitives(type: .point, vertexStart: 0, vertexCount: scene.points.count)
        }
        values["uDepthPass"] = [1]
        if use(program, Self.pointLayout, values, blend: .depthOnly) {
          encoder.setVertexBuffer(vertices, offset: 0, index: 0)
          encoder.drawPrimitives(type: .point, vertexStart: 0, vertexCount: scene.points.count)
        }
      }
    }

    // Planes over everything opaque, translucent: depth-tested, writing none.
    for s in scene.planes ?? [] {
      guard let program = cache.get(QUAD_VERT, planeSheetFrag(s.coeffs, s.params)) else { continue }
      if use(program, Self.quadLayout, panel.params(s.params, s.uniforms).merging(color(s.color)) { $1 }, write: false)
      {
        drawQuad(encoder)
      }
    }

    // Clouds over everything opaque, raymarched like the surfaces — as
    // costly, so drawn progressively the same way, into targets of their own:
    // one for the part of each ray beyond the grid's plane, drawn now, and one
    // for the part before it, drawn over the grid (see volumeFrag).
    func drawClouds(back: Bool) {
      guard scene.volumes?.isEmpty == false, let state = surfaceStates[panel.id + "/volume-\(back ? "back" : "front")"]
      else { return }
      composite(encoder, state.full, panel, target: main, write: false)
    }
    drawClouds(back: true)

    // Streamlines blend over everything opaque but write no depth, so the
    // dense cloud never hides itself.
    for f in scene.streamlines ?? [] {
      guard let program = cache.get(streamlineVert(f.comps, f.params), STREAMLINE_FRAG) else { continue }
      var values = panel.params(f.params, f.uniforms).merging(color(f.color)) { $1 }
      values["uTarget"] = [Float(cam.target.x), Float(cam.target.y), Float(cam.target.z)]
      if use(program, Self.seedLayout, values, write: false) {
        encoder.setVertexBuffer(streamlineSeeds.buffer, offset: 0, index: 0)
        encoder.drawPrimitives(
          type: .lineStrip, vertexStart: 0, vertexCount: 2 * STREAMLINE_STEPS + 1,
          instanceCount: streamlineSeeds.count)
      }
    }

    // Reference grid plane at z=0, last and without writing depth so its
    // translucent lines never occlude surfaces.
    if grid == .on, let plane = cache.get(QUAD_VERT, planeFrag(theme: theme)) {
      let spacing = niceSpacing(boxR / 300, 60)
      let values: Uniforms3D = ["uMajor": [Float(spacing.major)], "uMinor": [Float(spacing.minor)]]
      if use(plane, Self.quadLayout, values, write: false) { drawQuad(encoder) }
    }
    drawClouds(back: false)
  }

  /// Free retained geometry no render drew since the last call. Once per
  /// frame, after every panel has rendered: a split view renders several
  /// scenes a frame, and each must keep the others' meshes.
  public func endFrame() {
    geometry.endFrame()
    surfaceStates = surfaceStates.filter { $0.value.used }
    for state in surfaceStates.values { state.used = false }
  }
}
