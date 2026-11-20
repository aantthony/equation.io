import Foundation

// The layers that fill part of the plane (web/render2d.ts): contour stacks,
// inequalities, families projected over an interval, orbit diagrams and
// scalar fields. Their shaders are in Frag2D+Regions.swift. The site's
// interfaces extend Curve2D; a struct can't, so each repeats its fields.

/// A level-set family drawn in an equation's color (topographic map): a
/// GridSpec and the color.
public struct LevelSpec: Equatable, Codable, Sendable {
  /// GLSL for f(x, y) (constants as u_<name> uniforms).
  public var glsl: String
  /// GLSL for ∇f in math units; absent → screen derivatives (dFdx/dFdy).
  public var gradGlsl: [String]?
  public var params: [String]
  public var major: Double
  public var minor: Double
  public var color: RGB

  public init(
    glsl: String, gradGlsl: [String]? = nil, params: [String] = [], major: Double, minor: Double, color: RGB
  ) {
    self.glsl = glsl
    self.gradGlsl = gradGlsl
    self.params = params
    self.major = major
    self.minor = minor
    self.color = color
  }
}

public struct Ineq2D: Equatable, Codable, Sendable {
  /// GLSL expression for F(x,y) in terms of floats x, y: the region is F < 0.
  public var field: String
  public var graphEval: Curve2D.GraphEval?
  public var color: RGB
  public var params: [String]?
  public var uniforms: [String: Double]?
  /// Fields whose zero sets get a solid boundary line (the <= / >= parts).
  public var edges: [String]

  public init(
    field: String, graphEval: Curve2D.GraphEval? = nil, color: RGB, params: [String]? = nil,
    uniforms: [String: Double]? = nil, edges: [String] = []
  ) {
    self.field = field
    self.graphEval = graphEval
    self.color = color
    self.params = params
    self.uniforms = uniforms
    self.edges = edges
  }
}

/// A family over an interval (lib/plot.ts projectedRegion): `field` is
/// F(x, y, u), with `slope` ∂F/∂u when it has one.
public struct Projected2D: Equatable, Codable, Sendable {
  public var field: String
  public var graphEval: Curve2D.GraphEval?
  public var color: RGB
  public var params: [String]?
  public var uniforms: [String: Double]?
  public var relation: Relation
  public var slope: String?

  public enum Relation: String, Codable, Sendable {
    case eq, ineq
  }

  public init(
    field: String, graphEval: Curve2D.GraphEval? = nil, color: RGB, params: [String]? = nil,
    uniforms: [String: Double]? = nil, relation: Relation, slope: String? = nil
  ) {
    self.field = field
    self.graphEval = graphEval
    self.color = color
    self.params = params
    self.uniforms = uniforms
    self.relation = relation
    self.slope = slope
  }
}

/// An orbit diagram: field is f(a, x), iterated per pixel column from uSeed.
public typealias Bif2D = Curve2D

/// A scalar field F(x, y), shaded by its sign and size.
public struct Scalar2D: Equatable, Codable, Sendable {
  public var field: String
  public var graphEval: Curve2D.GraphEval?
  public var color: RGB
  public var params: [String]?
  public var uniforms: [String: Double]?
  /// Multiplies F before it is shaded (0.6 without).
  public var gain: Double?

  public init(
    field: String, graphEval: Curve2D.GraphEval? = nil, color: RGB, params: [String]? = nil,
    uniforms: [String: Double]? = nil, gain: Double? = nil
  ) {
    self.field = field
    self.graphEval = graphEval
    self.color = color
    self.params = params
    self.uniforms = uniforms
    self.gain = gain
  }
}
