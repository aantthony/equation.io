#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(WASILibc)
  import WASILibc
#endif

/// JavaScript's numbers, where the language's answers are defined by them:
/// how a number is written (`String(v)`, `toPrecision`, `toFixed`), and the
/// corners of `Math` that C's libm answers differently. Readouts and slider
/// write-backs are text the site produces with these, so the port has to
/// spell them the same way.
enum JS {
  // MARK: Math

  /// `Math.round`: halves go up (-0.5 is -0, 2.5 is 3).
  static func round(_ x: Double) -> Double {
    if !x.isFinite { return x }
    let down = x.rounded(.down)
    let r = x - down >= 0.5 ? down + 1 : down
    return r == 0 && x < 0 ? -0.0 : r
  }

  /// `Math.sign`: ±0 and NaN are themselves.
  static func sign(_ x: Double) -> Double {
    x > 0 ? 1 : x < 0 ? -1 : x
  }

  /// `Math.max`: NaN if any argument is, -∞ of none, and +0 over -0.
  static func max(_ xs: [Double]) -> Double {
    var out = -Double.infinity
    for x in xs {
      if x.isNaN { return .nan }
      if x > out || (x == 0 && out == 0 && out.sign == .minus) { out = x }
    }
    return out
  }

  /// `Math.min`: NaN if any argument is, +∞ of none, and -0 under +0.
  static func min(_ xs: [Double]) -> Double {
    var out = Double.infinity
    for x in xs {
      if x.isNaN { return .nan }
      if x < out || (x == 0 && out == 0 && x.sign == .minus) { out = x }
    }
    return out
  }

  /// `Math.pow`: C's pow, except a NaN exponent is always NaN and ±1 to an
  /// infinite power is NaN (C answers 1 for both).
  static func pow(_ a: Double, _ b: Double) -> Double {
    if b.isNaN { return .nan }
    if b == 0 { return 1 }
    if b.isInfinite && (a == 1 || a == -1) { return .nan }
    return _pow(a, b)
  }

  static func isInteger(_ x: Double) -> Bool { x.isFinite && x == x.rounded(.towardZero) }

  // MARK: Writing numbers

  /// `String(v)`: the shortest digits that read back as `v`, as a plain
  /// decimal from 1e-7 up to 1e21 and in exponent form outside it.
  static func string(_ v: Double) -> String {
    if v.isNaN { return "NaN" }
    if v == 0 { return "0" }
    if v.isInfinite { return v < 0 ? "-Infinity" : "Infinity" }
    let (digits, point) = shortestDigits(Swift.abs(v))
    return (v < 0 ? "-" : "") + layout(digits, point)
  }

  /// `v.toPrecision(p)`, for 1 ≤ p ≤ 100.
  static func toPrecision(_ v: Double, _ p: Int) -> String {
    if v.isNaN { return "NaN" }
    if v.isInfinite { return v < 0 ? "-Infinity" : "Infinity" }
    let sign = v < 0 ? "-" : ""
    if v == 0 { return p > 1 ? "0." + String(repeating: "0", count: p - 1) : "0" }
    var (digits, point) = exactDigits(Swift.abs(v))
    // Round half up at p significant digits (the larger n of a tie).
    if digits.count > p {
      let up = digits[p] >= 5
      digits = Array(digits[..<p])
      if up && increment(&digits) { point += 1 }
    }
    while digits.count < p { digits.append(0) }
    let e = point - 1
    let text = digits.map { String($0) }.joined()
    if e < -6 || e >= p {
      let mantissa = p > 1 ? "\(text.prefix(1)).\(text.dropFirst())" : text
      return "\(sign)\(mantissa)e\(e < 0 ? "-" : "+")\(Swift.abs(e))"
    }
    if e == p - 1 { return sign + text }
    if e >= 0 { return "\(sign)\(text.prefix(e + 1)).\(text.dropFirst(e + 1))" }
    return "\(sign)0.\(String(repeating: "0", count: -(e + 1)))\(text)"
  }

  /// `v.toFixed(d)`, for 0 ≤ d ≤ 100.
  static func toFixed(_ v: Double, _ d: Int) -> String {
    if v.isNaN { return "NaN" }
    if Swift.abs(v) >= 1e21 { return string(v) }
    var (digits, point) = v == 0 ? ([UInt8](), 0) : exactDigits(Swift.abs(v))
    // Digits before the point, then d after it.
    if point < 0 {
      digits = Array(repeating: 0, count: -point) + digits
      point = 0
    }
    let keep = point + d
    if digits.count > keep {
      let up = digits[keep] >= 5
      digits = Array(digits[..<keep])
      if up && increment(&digits) { point += 1 }
    }
    while digits.count < point + d { digits.append(0) }
    let whole = point == 0 ? "0" : digits[..<point].map { String($0) }.joined()
    let fraction = digits[point...].map { String($0) }.joined()
    // (A negative number keeps its sign even when it rounds to zero: "-0.00".)
    return (v < 0 ? "-" : "") + whole + (d > 0 ? "." + fraction : "")
  }

  /// `Number(text)` for the decimal text this file writes.
  static func number(_ text: String) -> Double {
    switch text {
    case "NaN": return .nan
    case "Infinity": return .infinity
    case "-Infinity": return -.infinity
    default: return Double(text) ?? .nan
    }
  }

  /// Add one in the last place; true when the digits carried into a new place
  /// (999 → 100, one place up).
  private static func increment(_ digits: inout [UInt8]) -> Bool {
    var i = digits.count - 1
    while i >= 0 {
      if digits[i] < 9 {
        digits[i] += 1
        return false
      }
      digits[i] = 0
      i -= 1
    }
    if digits.isEmpty {
      digits = [1]
    } else {
      digits[0] = 1
    }
    return true
  }

  /// JavaScript's layout of shortest digits: `point` is where the decimal
  /// point sits (digits d₁d₂… are 0.d₁d₂… × 10^point).
  private static func layout(_ digits: [UInt8], _ point: Int) -> String {
    let text = digits.map { String($0) }.joined()
    let k = digits.count
    if k <= point && point <= 21 { return text + String(repeating: "0", count: point - k) }
    if 0 < point && point <= 21 { return "\(text.prefix(point)).\(text.dropFirst(point))" }
    if -6 < point && point <= 0 { return "0." + String(repeating: "0", count: -point) + text }
    let e = point - 1
    let mantissa = k == 1 ? text : "\(text.prefix(1)).\(text.dropFirst())"
    return "\(mantissa)e\(e < 0 ? "-" : "+")\(Swift.abs(e))"
  }

  /// The shortest digits that read back as `v` (> 0, finite), from Swift's
  /// own shortest description, with where the decimal point sits.
  private static func shortestDigits(_ v: Double) -> ([UInt8], Int) {
    var mantissa = Substring(v.description)
    var exponent = 0
    if let e = mantissa.firstIndex(where: { $0 == "e" || $0 == "E" }) {
      exponent = Int(mantissa[mantissa.index(after: e)...])!
      mantissa = mantissa[..<e]
    }
    var digits: [UInt8] = []
    var point = 0
    var seenDot = false
    for c in mantissa.utf8 {
      if c == 0x2E {
        seenDot = true
      } else {
        digits.append(c - 0x30)
        if !seenDot { point += 1 }
      }
    }
    point += exponent
    while digits.count > 1, digits.last == 0 { digits.removeLast() }
    while digits.count > 1, digits.first == 0 {
      digits.removeFirst()
      point -= 1
    }
    return (digits, point)
  }

  /// Every decimal digit of `v` (> 0, finite), exactly: a double is
  /// m × 2^e, so it has a finite expansion, and rounding it to a number of
  /// places is then exact too.
  private static func exactDigits(_ v: Double) -> ([UInt8], Int) {
    var m = v.significandBitPattern
    var e = Int(v.exponentBitPattern)
    if e == 0 {
      e = -1074
    } else {
      m |= 1 << 52
      e -= 1075
    }
    // Decimal digits of the integer m × 2^e (e ≥ 0) or m × 5^-e (e < 0),
    // least significant first.
    var big: [UInt8] = []
    var rest = m
    while rest > 0 {
      big.append(UInt8(rest % 10))
      rest /= 10
    }
    func multiply(by factor: UInt32) {
      var carry: UInt32 = 0
      for i in big.indices {
        let x = UInt32(big[i]) * factor + carry
        big[i] = UInt8(x % 10)
        carry = x / 10
      }
      while carry > 0 {
        big.append(UInt8(carry % 10))
        carry /= 10
      }
    }
    if e >= 0 {
      for _ in 0..<e { multiply(by: 2) }
    } else {
      for _ in 0..<(-e) { multiply(by: 5) }
    }
    var digits = Array(big.reversed())
    // With e < 0 the integer is v × 10^-e.
    let point = digits.count + (e < 0 ? e : 0)
    while digits.count > 1, digits.last == 0 { digits.removeLast() }
    return (digits, point)
  }
}

// The C library's functions, under names that cannot be taken for JS.Math's.
@inline(__always) func _pow(_ a: Double, _ b: Double) -> Double { pow(a, b) }
