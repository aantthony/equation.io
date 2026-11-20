/// Content hashing for pinned data files (lib/hash.ts).
///
/// A CSV cannot live in the URL, but its identity can: `open("people.csv",
/// 3a7f…)` names the bytes, and whoever holds files holds them by it. The
/// hash is what makes a shared graph honest — open it against a different
/// file and the row says so instead of quietly plotting other numbers.
///
/// The site asks the browser for the digest; the core has no library to ask
/// (it builds without Foundation, for WebAssembly too), so SHA-256 is written
/// out here (FIPS 180-4).

private let K: [UInt32] = [
  0x428a_2f98, 0x7137_4491, 0xb5c0_fbcf, 0xe9b5_dba5, 0x3956_c25b, 0x59f1_11f1, 0x923f_82a4, 0xab1c_5ed5,
  0xd807_aa98, 0x1283_5b01, 0x2431_85be, 0x550c_7dc3, 0x72be_5d74, 0x80de_b1fe, 0x9bdc_06a7, 0xc19b_f174,
  0xe49b_69c1, 0xefbe_4786, 0x0fc1_9dc6, 0x240c_a1cc, 0x2de9_2c6f, 0x4a74_84aa, 0x5cb0_a9dc, 0x76f9_88da,
  0x983e_5152, 0xa831_c66d, 0xb003_27c8, 0xbf59_7fc7, 0xc6e0_0bf3, 0xd5a7_9147, 0x06ca_6351, 0x1429_2967,
  0x27b7_0a85, 0x2e1b_2138, 0x4d2c_6dfc, 0x5338_0d13, 0x650a_7354, 0x766a_0abb, 0x81c2_c92e, 0x9272_2c85,
  0xa2bf_e8a1, 0xa81a_664b, 0xc24b_8b70, 0xc76c_51a3, 0xd192_e819, 0xd699_0624, 0xf40e_3585, 0x106a_a070,
  0x19a4_c116, 0x1e37_6c08, 0x2748_774c, 0x34b0_bcb5, 0x391c_0cb3, 0x4ed8_aa4a, 0x5b9c_ca4f, 0x682e_6ff3,
  0x748f_82ee, 0x78a5_636f, 0x84c8_7814, 0x8cc7_0208, 0x90be_fffa, 0xa450_6ceb, 0xbef9_a3f7, 0xc671_78f2,
]

private func rotr(_ x: UInt32, _ n: UInt32) -> UInt32 { (x >> n) | (x << (32 - n)) }

/// SHA-256 of the bytes, lowercase hex (`sha256Hex`).
public func sha256Hex<Bytes: Sequence>(_ data: Bytes) -> String where Bytes.Element == UInt8 {
  var h: [UInt32] = [
    0x6a09_e667, 0xbb67_ae85, 0x3c6e_f372, 0xa54f_f53a, 0x510e_527f, 0x9b05_688c, 0x1f83_d9ab, 0x5be0_cd19,
  ]
  var w = [UInt32](repeating: 0, count: 64)
  func compress(_ block: ArraySlice<UInt8>) {
    var i = block.startIndex
    for t in 0..<16 {
      w[t] = UInt32(block[i]) << 24 | UInt32(block[i + 1]) << 16 | UInt32(block[i + 2]) << 8 | UInt32(block[i + 3])
      i += 4
    }
    for t in 16..<64 {
      let s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >> 3)
      let s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >> 10)
      w[t] = w[t - 16] &+ s0 &+ w[t - 7] &+ s1
    }
    var (a, b, c, d, e, f, g, hh) = (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7])
    for t in 0..<64 {
      let s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      let ch = (e & f) ^ (~e & g)
      let t1 = hh &+ s1 &+ ch &+ K[t] &+ w[t]
      let s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      let maj = (a & b) ^ (a & c) ^ (b & c)
      let t2 = s0 &+ maj
      (hh, g, f, e, d, c, b, a) = (g, f, e, d &+ t1, c, b, a, t1 &+ t2)
    }
    for (k, v) in [a, b, c, d, e, f, g, hh].enumerated() { h[k] = h[k] &+ v }
  }
  // Whole blocks as they come, then the padding: 0x80, zeros, and the
  // length in bits as 64 big-endian bits.
  var pending: [UInt8] = []
  pending.reserveCapacity(128)
  var length: UInt64 = 0
  for byte in data {
    pending.append(byte)
    length &+= 1
    if pending.count == 64 {
      compress(pending[...])
      pending.removeAll(keepingCapacity: true)
    }
  }
  pending.append(0x80)
  while pending.count % 64 != 56 { pending.append(0) }
  let bits = length &* 8
  for shift in stride(from: 56, through: 0, by: -8) { pending.append(UInt8((bits >> UInt64(shift)) & 0xff)) }
  for start in stride(from: 0, to: pending.count, by: 64) { compress(pending[start..<(start + 64)]) }
  let digits = Array("0123456789abcdef".utf8)
  var hex: [UInt8] = []
  for word in h {
    for shift in stride(from: 28, through: 0, by: -4) { hex.append(digits[Int((word >> UInt32(shift)) & 0xf)]) }
  }
  return String(decoding: hex, as: UTF8.self)
}

/// Hex characters of the hash written into a row (`HASH_TOKEN_LEN`): 48 bits.
public let HASH_TOKEN_LEN = 12

/// The hash as a row writes it (`shortHash`).
public func shortHash(_ hex: String) -> String { String(hex.utf8.prefix(HASH_TOKEN_LEN))! }
