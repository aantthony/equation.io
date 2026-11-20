#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

/// Real, periodic signals: a one-sided amplitude spectrum and a Fourier
/// reconstruction (lib/fourier.ts). Samples cover [lo, hi), never duplicate
/// the endpoint. The forward DFT uses exp(-2πijk/n); cosine = 2 Re/n,
/// sine = -2 Im/n. DC and an even-length Nyquist bin occur only once, so are
/// not doubled.
///
/// Port: `fourier(…)` and `reconstruct(…)` reach these through list lowering
/// (lib/list.ts), which samples the signal; until lists are ported no row
/// calls them. The series `reconstructSeries` writes is the gated sum
/// Shader.swift's `fourierLoop` compiles to a coefficient table.
let FOURIER_SAMPLES = 256
let FOURIER_MAX_SAMPLES = 4096
let FOURIER_MAX_HARMONICS = 128

struct FourierCoefficients: Equatable {
  var cosine: [Double]
  var sine: [Double]
}

/// In-place radix-2 FFT; inverse includes the 1/n normalization.
private func fft(_ re: inout [Double], _ im: inout [Double], inverse: Bool = false) {
  let n = re.count
  var j = 0
  for i in stride(from: 1, to: n, by: 1) {
    var bit = n >> 1
    while j & bit != 0 {
      j ^= bit
      bit >>= 1
    }
    j ^= bit
    if i < j {
      re.swapAt(i, j)
      im.swapAt(i, j)
    }
  }
  var width = 2
  while width <= n {
    let angle = ((inverse ? 2 : -2) * Double.pi) / Double(width)
    let wr = cos(angle)
    let wi = sin(angle)
    for start in stride(from: 0, to: n, by: width) {
      var r = 1.0
      var s = 0.0
      for k in 0..<(width / 2) {
        let a = start + k
        let b = a + width / 2
        let br = re[b] * r - im[b] * s
        let bi = re[b] * s + im[b] * r
        re[b] = re[a] - br
        im[b] = im[a] - bi
        re[a] += br
        im[a] += bi
        (r, s) = (r * wr - s * wi, r * wi + s * wr)
      }
    }
    width *= 2
  }
  if inverse {
    for k in 0..<n {
      re[k] /= Double(n)
      im[k] /= Double(n)
    }
  }
}

/// Bluestein turns any sample count into one power-of-two convolution. It
/// preserves the original period and bin spacing; no zero padding of the
/// signal, discarded tail samples, or quadratic-time DFT fallback.
private func transform(_ xs: [Double]) -> (re: [Double], im: [Double]) {
  let n = xs.count
  if n & (n - 1) == 0 {
    var re = xs
    var im = [Double](repeating: 0, count: n)
    fft(&re, &im)
    return (re, im)
  }
  var size = 1
  while size < 2 * n - 1 { size *= 2 }
  var ar = [Double](repeating: 0, count: size)
  var ai = ar
  var br = ar
  var bi = ar
  func chirp(_ j: Int) -> (c: Double, s: Double) {
    let angle = (Double.pi * Double((j * j) % (2 * n))) / Double(n)
    return (cos(angle), sin(angle))
  }
  for j in 0..<n {
    let (c, s) = chirp(j)
    ar[j] = xs[j] * c
    ai[j] = -xs[j] * s
    br[j] = c
    bi[j] = s
    if j != 0 {
      br[size - j] = c
      bi[size - j] = s
    }
  }
  fft(&ar, &ai)
  fft(&br, &bi)
  for j in 0..<size {
    let r = ar[j] * br[j] - ai[j] * bi[j]
    ai[j] = ar[j] * bi[j] + ai[j] * br[j]
    ar[j] = r
  }
  fft(&ar, &ai, inverse: true)
  var re = [Double](repeating: 0, count: n)
  var im = re
  for j in 0..<n {
    let (c, s) = chirp(j)
    re[j] = ar[j] * c + ai[j] * s
    im[j] = ai[j] * c - ar[j] * s
  }
  return (re, im)
}

func realFourier(_ xs: [Double]) throws -> FourierCoefficients {
  let n = xs.count
  if n < 2 || n > FOURIER_MAX_SAMPLES {
    throw LanguageError("Fourier analysis needs 2 to \(FOURIER_MAX_SAMPLES) samples.")
  }
  if xs.contains(where: { !$0.isFinite }) {
    throw LanguageError(
      "Fourier analysis needs finite real samples; missing values cannot be skipped without changing their spacing.")
  }
  let (re, im) = transform(xs)
  let count = n / 2 + 1
  var cosine = [Double](repeating: 0, count: count)
  var sine = cosine
  // Remove FFT roundoff relative to this signal, preserving small signals.
  let tolerance = xs.reduce(0) { JS.max([$0, abs($1)]) } * 1e-12
  for k in 0..<count {
    let single = k == 0 || 2 * k == n
    let a = (re[k] * (single ? 1 : 2)) / Double(n)
    let b = single ? 0 : (-2 * im[k]) / Double(n)
    if !a.isFinite || !b.isFinite { throw LanguageError("Fourier coefficients overflowed; rescale the signal.") }
    cosine[k] = abs(a) <= tolerance ? 0 : a
    sine[k] = abs(b) <= tolerance ? 0 : b
  }
  return FourierCoefficients(cosine: cosine, sine: sine)
}

/// Ordinary points: the existing scatter, figures and CPU previews all
/// understand them without a new mathematical object kind.
func spectrumPoints(_ c: FourierCoefficients, _ period: Double) -> [Expr] {
  c.cosine.enumerated().map { k, a in .vec([.num(Double(k) / period), .num(hypot(a, c.sine[k]))]) }
}

/// The signed DC term is always included; N selects bins 1..N. Phase is
/// retained, so full reconstruction interpolates the original samples.
func reconstructSeries(
  _ c: FourierCoefficients, harmonics: Int, lo: Double, period: Double, count: Expr? = nil
) -> Expr {
  var result = Expr.num(c.cosine[0])
  let position = sub(.var("x"), .num(lo))
  for k in stride(from: 1, through: harmonics, by: 1) {
    let angle = mul(.num((2 * Double.pi * Double(k)) / period), position)
    var term = Expr.num(0)
    if c.cosine[k] != 0, !c.cosine[k].isNaN { term = add(term, mul(.num(c.cosine[k]), .call("cos", [angle]))) }
    if c.sine[k] != 0, !c.sine[k].isNaN { term = add(term, mul(.num(c.sine[k]), .call("sin", [angle]))) }
    if term == .num(0) { continue }
    // A bounded count is a uniform: the coefficient table and shader stay
    // fixed across a drag. Each guard covers both phase components and its
    // symbolic spatial derivative, skipping harmonics above the count.
    result = add(
      result,
      count.map {
        .piecewise([Expr.Case(cond: .ineq(.ge, $0, .num(Double(k))), value: term)], otherwise: .num(0))
      } ?? term)
  }
  return result
}
