import EquationCore
import Foundation

// Axis maps (lib/axis-map.ts) are the language's: EquationCore/AxisMap.swift
// has the map, its inverse by peeling, its slope, and how a row is rewritten
// for one. The overlay needs the map both ways: a row's positions are carried
// to the screen by the inverse (`mapOverlay`), and the axis is labelled at
// ticks chosen on the screen and named in x (`axisTicks`).
//
// Here is only how a map is written down in a scene (metal-shot draws one
// from JSON).

/// What `parseAxisMap` throws: the row's error, as the site words it.
public typealias AxisMapError = LanguageError

// Written down as the row wrote it, and parsed again: the core's Expr is not
// Codable, and a map that names a slider has its value in `forward` already,
// so such a map does not survive the trip.
extension AxisMap.Axis: Codable {}

extension AxisMap: Codable {
  private enum CodingKeys: String, CodingKey {
    case axis, text
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self = try parseAxisMap(
      try container.decode(Axis.self, forKey: .axis), try container.decode(String.self, forKey: .text))
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(axis, forKey: .axis)
    try container.encode(text, forKey: .text)
  }
}

extension AxisMaps: Codable {
  private enum CodingKeys: String, CodingKey {
    case x, y
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.init(
      x: try container.decodeIfPresent(AxisMap.self, forKey: .x),
      y: try container.decodeIfPresent(AxisMap.self, forKey: .y))
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encodeIfPresent(x, forKey: .x)
    try container.encodeIfPresent(y, forKey: .y)
  }
}
