import Testing

@testable import EquationCore

/// The numeric half of geometry (Hull.swift, GeomPlans.swift): what the
/// renderers ask once a figure's vertices have values. The lowering itself
/// is held to the site by AnalysisConformance.
@Suite struct Geometry {
  @Test func hullInThePlane() {
    // The interior and collinear points drop out; the outline runs counterclockwise.
    let outline = hull2([[0, 0], [2, 0], [1, 0], [2, 2], [1, 1], [0, 2], [0, 0]])
    #expect(outline == [[0, 0], [2, 0], [2, 2], [0, 2]])
    #expect(hull2([[1, 1], [0, 0]]) == [[0, 0], [1, 1]])
    let faces = hullFaces([0, 0, 2, 0, 1, 0.5, 0, 2], dim: 2)
    #expect(faces.count == 1)
    #expect(faces[0].outline == [[0, 0, 0], [2, 0, 0], [0, 2, 0]])
    #expect(faces[0].triangles == [[0, 1, 2]])
  }

  @Test func hullInSpace() {
    // A cube, with its centre: six square faces, coplanar triangles merged.
    var cube: [[Double]] = [[0.5, 0.5, 0.5]]
    for x in [0.0, 1.0] {
      for y in [0.0, 1.0] {
        for z in [0.0, 1.0] { cube.append([x, y, z]) }
      }
    }
    let faces = hull3(cube)
    #expect(faces.count == 6)
    #expect(faces.allSatisfy { $0.outline.count == 4 && $0.triangles == [[0, 1, 2], [0, 2, 3]] })
    let mesh = hullMesh(faces)
    #expect(mesh.positions.count == 6 * 4 * 3)
    #expect(mesh.indices.count == 6 * 2 * 3)
    // Every face's normal points away from the centre.
    for face in faces {
      let (a, b, c) = (face.outline[0], face.outline[1], face.outline[2])
      let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
      let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
      let out = [a[0] - 0.5, a[1] - 0.5, a[2] - 0.5]
      #expect(n[0] * out[0] + n[1] * out[1] + n[2] * out[2] > 0)
    }
    // Flat, collinear and single: a polygon, a segment, a point.
    #expect(hull3([[0, 0, 1], [1, 0, 1], [0, 1, 1], [0.2, 0.2, 1]]).map(\.outline.count) == [3])
    #expect(hull3([[0, 0, 0], [1, 1, 1], [2, 2, 2]]).map(\.outline) == [[[0, 0, 0], [2, 2, 2]]])
    #expect(hull3([[1, 2, 3], [1, 2, 3]]).map(\.outline) == [[[1, 2, 3]]])
    #expect(hullGeometry([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, .nan], dim: 3) == nil)
  }

  @Test func figureCoordinatesAndFans() throws {
    let rows = ["a = 2", "polygon((0, 0), (a, 0), (a, a t))", "hull((0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, a))"]
    let analysis = analyze(rows)
    guard case .polygon(2, let pts, true, false, false, nil)? = analysis.rows[1].cpu else {
      Issue.record("not a polygon plan: \(String(describing: analysis.rows[1].cpu))")
      return
    }
    #expect(try figureCoordinates(pts, over: nil, ["a": 2, "t": 0.5]) == [0, 0, 2, 0, 2, 1])
    #expect(analysis.rows[1].classified?.animated == true)
    #expect(analysis.rows[2].classified?.needs3D == true)
    // A template over a packed column: one vertex per element.
    let over = [Column(name: "@k", values: [0, 1, 2])]
    let packed = try figureCoordinates([.var("@k"), .bin(.mul, .var("a"), .var("@k"))], over: over, ["a": 3])
    #expect(packed == [0, 0, 1, 3, 2, 6])
    #expect(fanFillable([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]))
    #expect(!fanFillable([0, 0, 0, 1, 0, 0, 1, 1, 1, 0, 1, 0]))
    #expect(!fanFillable([0, 0, 0, 1, 0, 0]))
  }

  @Test func matricesReadOut() {
    let rows = ["J = ((0, -1), (1, 0))", "a = 0.5", "R = e^(a J)", "R", "det(R)", "R (1, 0)", "(1, 2, 3, 4)"]
    let analysis = analyze(rows)
    #expect(analysis.rows.allSatisfy { $0.error == nil && $0.unsupported == nil })
    #expect(analysis.rows[0].kind == "definition (matrix)")
    #expect(analysis.rows[3].info == "≈ ((0.877583, -0.479426), (0.479426, 0.877583))")
    #expect(analysis.rows[4].info == "= 1")
    #expect(analysis.rows[6].info == "= (1, 2, 3, 4)")
    // The rotation's entries are hidden constants, evaluated once per frame.
    #expect(analysis.env.keys.contains { $0.hasPrefix("R#") })
  }
}
