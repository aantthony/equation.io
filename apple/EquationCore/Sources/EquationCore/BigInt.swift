/// Arbitrary-precision integers: JavaScript's BigInt, for what lib/poly.ts
/// and lib/integrate.ts ask of it (exact rational polynomial arithmetic and
/// root isolation). The core has no Foundation and Swift no big integers of
/// its own, so this is the small part of one those need: + − × ÷ % as
/// JavaScript defines them (division truncates, a remainder takes the
/// dividend's sign), shifts (>> floors, as an arithmetic shift does), powers,
/// comparison, and the conversions to and from a double (`Number(x)` rounds
/// to nearest, ties to even; `BigInt(v)` is exact for an integral double).
///
/// Sign and magnitude, the magnitude in 32-bit limbs from the least
/// significant, with no zero limb on top; zero is the empty magnitude and is
/// never negative, so equal values are equal structs.
struct BigInt: Equatable, Hashable, Sendable {
  private(set) var negative: Bool
  private(set) var mag: [UInt32]

  private init(negative: Bool, mag: [UInt32]) {
    var m = mag
    while let top = m.last, top == 0 { m.removeLast() }
    self.mag = m
    self.negative = negative && !m.isEmpty
  }

  static let zero = BigInt(negative: false, mag: [])
  static let one = BigInt(1)

  init(_ value: Int) {
    var m: [UInt32] = []
    var u = value.magnitude
    while u != 0 {
      m.append(UInt32(truncatingIfNeeded: u))
      u >>= 32
    }
    self.init(negative: value < 0, mag: m)
  }

  /// `BigInt(v)` of a double that is a whole number (exact); nil otherwise.
  init?(exactly v: Double) {
    guard v.isFinite, v == v.rounded(.towardZero) else { return nil }
    if v == 0 {
      self = .zero
      return
    }
    // v = significand · 2^(exponent − 52), the significand a 53-bit integer.
    let significand = v.significandBitPattern | (1 << 52)
    let shift = Int(v.exponent) - 52
    let m = BigInt(negative: false, mag: [UInt32(truncatingIfNeeded: significand), UInt32(significand >> 32)])
    let scaled = shift >= 0 ? m << shift : m >> -shift
    self.init(negative: v < 0, mag: scaled.mag)
  }

  /// A decimal numeral, as BigInt("…") reads one: digits with an optional sign.
  init?(_ text: String) {
    var digits = Array(text.utf8)
    var negative = false
    if let first = digits.first, first == UInt8(ascii: "-") || first == UInt8(ascii: "+") {
      negative = first == UInt8(ascii: "-")
      digits.removeFirst()
    }
    guard !digits.isEmpty else { return nil }
    var out = BigInt.zero
    let ten = BigInt(10)
    for d in digits {
      guard d >= UInt8(ascii: "0"), d <= UInt8(ascii: "9") else { return nil }
      out = out * ten + BigInt(Int(d - UInt8(ascii: "0")))
    }
    self.init(negative: negative, mag: out.mag)
  }

  var isZero: Bool { mag.isEmpty }

  /// −1, 0 or 1.
  var signum: Int { mag.isEmpty ? 0 : negative ? -1 : 1 }

  var magnitude: BigInt { BigInt(negative: false, mag: mag) }

  /// Bits in the magnitude: 0 for zero. (`x.toString(2).length` is this, but 1 for zero.)
  var bitWidth: Int {
    guard let top = mag.last else { return 0 }
    return mag.count * 32 - top.leadingZeroBitCount
  }

  /// Whether the value is odd.
  var isOdd: Bool { (mag.first ?? 0) & 1 == 1 }

  /// The value as an Int, when it fits.
  var int: Int? {
    if bitWidth > 63 { return self == BigInt(Int.min) ? Int.min : nil }
    var u: UInt = 0
    for limb in mag.reversed() { u = (u << 32) | UInt(limb) }
    return negative ? -Int(u) : Int(u)
  }

  // MARK: Magnitudes

  private static func compareMag(_ a: [UInt32], _ b: [UInt32]) -> Int {
    if a.count != b.count { return a.count < b.count ? -1 : 1 }
    var i = a.count - 1
    while i >= 0 {
      if a[i] != b[i] { return a[i] < b[i] ? -1 : 1 }
      i -= 1
    }
    return 0
  }

  private static func addMag(_ a: [UInt32], _ b: [UInt32]) -> [UInt32] {
    let (long, short) = a.count >= b.count ? (a, b) : (b, a)
    var out = [UInt32](repeating: 0, count: long.count + 1)
    var carry: UInt64 = 0
    for i in 0..<long.count {
      let sum = UInt64(long[i]) + (i < short.count ? UInt64(short[i]) : 0) + carry
      out[i] = UInt32(truncatingIfNeeded: sum)
      carry = sum >> 32
    }
    out[long.count] = UInt32(carry)
    return out
  }

  /// a − b for |a| ≥ |b|.
  private static func subMag(_ a: [UInt32], _ b: [UInt32]) -> [UInt32] {
    var out = [UInt32](repeating: 0, count: a.count)
    var borrow: Int64 = 0
    for i in 0..<a.count {
      var d = Int64(a[i]) - (i < b.count ? Int64(b[i]) : 0) - borrow
      borrow = 0
      if d < 0 {
        d += 1 << 32
        borrow = 1
      }
      out[i] = UInt32(d)
    }
    return out
  }

  private static func mulMag(_ a: [UInt32], _ b: [UInt32]) -> [UInt32] {
    if a.isEmpty || b.isEmpty { return [] }
    var out = [UInt32](repeating: 0, count: a.count + b.count)
    for i in 0..<a.count {
      var carry: UInt64 = 0
      let x = UInt64(a[i])
      if x == 0 { continue }
      for j in 0..<b.count {
        let t = x * UInt64(b[j]) + UInt64(out[i + j]) + carry
        out[i + j] = UInt32(truncatingIfNeeded: t)
        carry = t >> 32
      }
      out[i + b.count] = UInt32(carry)
    }
    return out
  }

  /// Magnitude ÷ one limb.
  private static func divModSmall(_ a: [UInt32], _ d: UInt32) -> (q: [UInt32], r: UInt32) {
    var q = [UInt32](repeating: 0, count: a.count)
    var rem: UInt64 = 0
    var i = a.count - 1
    while i >= 0 {
      let cur = (rem << 32) | UInt64(a[i])
      q[i] = UInt32(cur / UInt64(d))
      rem = cur % UInt64(d)
      i -= 1
    }
    return (q, UInt32(rem))
  }

  /// Magnitude ÷ magnitude (Knuth's algorithm D); b is not zero.
  private static func divModMag(_ a: [UInt32], _ b: [UInt32]) -> (q: [UInt32], r: [UInt32]) {
    if compareMag(a, b) < 0 { return ([], a) }
    if b.count == 1 {
      let (q, r) = divModSmall(a, b[0])
      return (q, r == 0 ? [] : [r])
    }
    // Normalize so the divisor's top limb has its high bit set.
    let s = b[b.count - 1].leadingZeroBitCount
    let v = shiftLeftMag(b, s)
    var u = shiftLeftMag(a, s)
    if u.count == a.count { u.append(0) }
    let n = v.count
    let m = u.count - n - 1
    var q = [UInt32](repeating: 0, count: m + 1)
    let base: UInt64 = 1 << 32
    var j = m
    while j >= 0 {
      let top = (UInt64(u[j + n]) << 32) | UInt64(u[j + n - 1])
      var qhat = top / UInt64(v[n - 1])
      var rhat = top % UInt64(v[n - 1])
      while qhat >= base || qhat * UInt64(v[n - 2]) > ((rhat << 32) | UInt64(u[j + n - 2])) {
        qhat -= 1
        rhat += UInt64(v[n - 1])
        if rhat >= base { break }
      }
      // Multiply and subtract.
      var borrow: Int64 = 0
      var carry: UInt64 = 0
      for i in 0..<n {
        let p = qhat * UInt64(v[i]) + carry
        carry = p >> 32
        let t = Int64(u[i + j]) - borrow - Int64(p & 0xFFFF_FFFF)
        u[i + j] = UInt32(truncatingIfNeeded: t)
        borrow = t < 0 ? 1 : 0
      }
      let t = Int64(u[j + n]) - borrow - Int64(carry)
      u[j + n] = UInt32(truncatingIfNeeded: t)
      if t < 0 {
        // The estimate was one too large: add the divisor back.
        qhat -= 1
        var c: UInt64 = 0
        for i in 0..<n {
          let sum = UInt64(u[i + j]) + UInt64(v[i]) + c
          u[i + j] = UInt32(truncatingIfNeeded: sum)
          c = sum >> 32
        }
        u[j + n] = UInt32(truncatingIfNeeded: UInt64(u[j + n]) + c)
      }
      q[j] = UInt32(truncatingIfNeeded: qhat)
      j -= 1
    }
    return (q, shiftRightMag(Array(u[0..<n]), s))
  }

  private static func shiftLeftMag(_ a: [UInt32], _ bits: Int) -> [UInt32] {
    if a.isEmpty { return [] }
    let limbs = bits / 32
    let s = bits % 32
    var out = [UInt32](repeating: 0, count: limbs)
    if s == 0 { return out + a }
    var carry: UInt32 = 0
    for limb in a {
      out.append((limb << UInt32(s)) | carry)
      carry = limb >> UInt32(32 - s)
    }
    if carry != 0 { out.append(carry) }
    return out
  }

  /// The magnitude shifted right, bits dropped.
  private static func shiftRightMag(_ a: [UInt32], _ bits: Int) -> [UInt32] {
    let limbs = bits / 32
    let s = bits % 32
    if limbs >= a.count { return [] }
    let kept = Array(a[limbs...])
    if s == 0 { return kept }
    var out = [UInt32](repeating: 0, count: kept.count)
    for i in 0..<kept.count {
      let high = i + 1 < kept.count ? kept[i + 1] << UInt32(32 - s) : 0
      out[i] = (kept[i] >> UInt32(s)) | high
    }
    return out
  }

  // MARK: Arithmetic

  static prefix func - (a: BigInt) -> BigInt { BigInt(negative: !a.negative, mag: a.mag) }

  static func + (a: BigInt, b: BigInt) -> BigInt {
    if a.negative == b.negative { return BigInt(negative: a.negative, mag: addMag(a.mag, b.mag)) }
    let c = compareMag(a.mag, b.mag)
    if c == 0 { return .zero }
    return c > 0
      ? BigInt(negative: a.negative, mag: subMag(a.mag, b.mag))
      : BigInt(negative: b.negative, mag: subMag(b.mag, a.mag))
  }

  static func - (a: BigInt, b: BigInt) -> BigInt { a + (-b) }

  static func * (a: BigInt, b: BigInt) -> BigInt {
    BigInt(negative: a.negative != b.negative, mag: mulMag(a.mag, b.mag))
  }

  /// The quotient toward zero and the remainder with the dividend's sign
  /// (JavaScript's `/` and `%`). Division by zero is a RangeError there and
  /// a precondition here: no caller divides by a zero it has not tested.
  func quotientAndRemainder(dividingBy b: BigInt) -> (quotient: BigInt, remainder: BigInt) {
    precondition(!b.isZero, "BigInt division by zero")
    let (q, r) = BigInt.divModMag(mag, b.mag)
    return (BigInt(negative: negative != b.negative, mag: q), BigInt(negative: negative, mag: r))
  }

  static func / (a: BigInt, b: BigInt) -> BigInt { a.quotientAndRemainder(dividingBy: b).quotient }
  static func % (a: BigInt, b: BigInt) -> BigInt { a.quotientAndRemainder(dividingBy: b).remainder }

  static func += (a: inout BigInt, b: BigInt) { a = a + b }
  static func -= (a: inout BigInt, b: BigInt) { a = a - b }
  static func *= (a: inout BigInt, b: BigInt) { a = a * b }
  static func /= (a: inout BigInt, b: BigInt) { a = a / b }

  static func << (a: BigInt, bits: Int) -> BigInt {
    if bits < 0 { return a >> -bits }
    return BigInt(negative: a.negative, mag: shiftLeftMag(a.mag, bits))
  }

  /// An arithmetic shift: the floor of a / 2^bits, so −1 >> 1 is −1.
  static func >> (a: BigInt, bits: Int) -> BigInt {
    if bits < 0 { return a << -bits }
    let shifted = shiftRightMag(a.mag, bits)
    if !a.negative { return BigInt(negative: false, mag: shifted) }
    // Toward −∞: one further from zero when any dropped bit was set.
    let limbs = bits / 32
    var dropped = false
    for i in 0..<min(limbs, a.mag.count) where a.mag[i] != 0 { dropped = true }
    if !dropped, limbs < a.mag.count, bits % 32 != 0 {
      dropped = a.mag[limbs] & ((1 << UInt32(bits % 32)) - 1) != 0
    }
    let out = BigInt(negative: true, mag: shifted)
    return dropped ? out - .one : out
  }

  /// a ** n for n ≥ 0.
  func power(_ n: Int) -> BigInt {
    var result = BigInt.one
    var base = self
    var k = n
    while k > 0 {
      if k & 1 == 1 { result *= base }
      k >>= 1
      if k > 0 { base *= base }
    }
    return result
  }

  // MARK: Conversions

  /// `Number(x)`: the nearest double, ties to even; ±∞ past the largest.
  var double: Double {
    let bits = bitWidth
    if bits == 0 { return 0 }
    var top: UInt64
    var shift = 0
    if bits <= 64 {
      top = 0
      for limb in mag.reversed() { top = (top << 32) | UInt64(limb) }
    } else {
      // The top 64 bits, with a sticky bit for whatever lies below: 64 is
      // more than a double's 53 and its rounding bit, so one conversion
      // rounds as the whole number would.
      shift = bits - 64
      let high = BigInt.shiftRightMag(mag, shift)
      top = (UInt64(high.count > 1 ? high[1] : 0) << 32) | UInt64(high[0])
      let limbs = shift / 32
      var sticky = false
      for i in 0..<limbs where mag[i] != 0 { sticky = true }
      if !sticky, shift % 32 != 0 { sticky = mag[limbs] & ((1 << UInt32(shift % 32)) - 1) != 0 }
      if sticky { top |= 1 }
    }
    let d = Double(sign: .plus, exponent: shift, significand: Double(top))
    return negative ? -d : d
  }
}

extension BigInt: Comparable {
  static func < (a: BigInt, b: BigInt) -> Bool {
    if a.negative != b.negative { return a.negative }
    let c = compareMag(a.mag, b.mag)
    return a.negative ? c > 0 : c < 0
  }
}

extension BigInt: ExpressibleByIntegerLiteral {
  init(integerLiteral value: Int) { self.init(value) }
}

extension BigInt: CustomStringConvertible {
  /// The decimal numeral, as `String(x)` writes one.
  var description: String {
    if mag.isEmpty { return "0" }
    // Nine digits at a time, the least significant first.
    var chunks: [UInt32] = []
    var rest = mag
    while !rest.isEmpty {
      let (q, r) = BigInt.divModSmall(rest, 1_000_000_000)
      chunks.append(r)
      rest = q
      while let top = rest.last, top == 0 { rest.removeLast() }
    }
    var out = negative ? "-" : ""
    out += String(chunks[chunks.count - 1])
    for chunk in chunks.dropLast().reversed() {
      let digits = String(chunk)
      out += String(repeating: "0", count: 9 - digits.count) + digits
    }
    return out
  }
}

/// gcd(|a|, |b|), by Euclid (lib/poly.ts `bgcd`).
func bgcd(_ a: BigInt, _ b: BigInt) -> BigInt {
  var a = a.magnitude
  var b = b.magnitude
  while !b.isZero {
    let t = a % b
    a = b
    b = t
  }
  return a
}
