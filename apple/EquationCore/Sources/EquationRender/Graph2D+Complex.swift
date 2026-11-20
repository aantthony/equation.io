import EquationCore
import Foundation

/// The layers of the rows drawn per pixel from a complex value or as a
/// colour (web/main.ts, the `complex2d`, `domain2d`, `conformal2d`,
/// `fractal2d` and `rgb2d`/`hsl2d`/`oklch2d` cases of the plans' switch).
struct ComplexLayers {
  var fractals: [Fractal2D] = []
  var domains: [Curve2D] = []
  var colors: [ColorField2D] = []
  var conformals: [Curve2D] = []
  var complexes: [Curve2D] = []

  mutating func add(_ gpu: GpuPlan, color: RGB) {
    switch gpu.shader {
    case .complexField(let form, let field):
      let layer = Curve2D(field: field, color: color, params: gpu.params)
      switch form {
      case .potential: complexes.append(layer)
      case .domain: domains.append(layer)
      case .conformal: conformals.append(layer)
      }
    case .fractal2d(let step, let seed, let maxIter):
      fractals.append(
        Fractal2D(
          step: step, seed: Fractal2D.Seed(rawValue: seed) ?? .pixel, maxIter: maxIter, color: color,
          params: gpu.params))
    case .color2d(let space, let field, let locals):
      guard let space = ColorSpace(rawValue: space) else { return }
      colors.append(ColorField2D(field: field, color: color, params: gpu.params, space: space, locals: locals))
    default:
      break
    }
  }

  /// (A kind no row draws stays nil, as a scene written by hand leaves it.)
  func write(to layers: inout Layers2D) {
    if !fractals.isEmpty { layers.fractals = fractals }
    if !domains.isEmpty { layers.domains = domains }
    if !colors.isEmpty { layers.colors = colors }
    if !conformals.isEmpty { layers.conformals = conformals }
    if !complexes.isEmpty { layers.complexes = complexes }
  }
}
