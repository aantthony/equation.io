/// Graph links (lib/link.ts): the rows as the part after `/g/`.
///
/// Percent-encoded rows joined by `;`. Beyond encodeURIComponent, ( ) ! ' *
/// are escaped too — chat-app linkifiers cut links at them — and a `;`
/// inside a row is encoded twice, so `%3B` in a payload is always a
/// separator. A payload with a literal `%` carries the `~2~` marker and
/// escapes those as well.
public func encodePayload(_ texts: [String]) -> String {
  let rows = texts.map(jsTrimmed).filter { !$0.isEmpty }
  let escapePercent = rows.contains { $0.contains("%") }
  let encoded = rows.map { row in
    encodeRow(escapePercent ? row.replacing("%", with: "%25") : row)
  }
  return (escapePercent ? "~2~" : "") + encoded.joined(separator: ";")
}

/// The share link for a graph: `https://equation.io/g/…`, or the site
/// itself for an empty one.
public func graphLink(_ texts: [String], origin: String = "https://equation.io") -> String {
  let payload = encodePayload(texts)
  return payload.isEmpty ? origin + "/" : origin + "/g/" + payload
}

/// encodeURIComponent, then ( ) ! ' * escaped, then `%3B` encoded again.
private func encodeRow(_ text: String) -> String {
  var out = ""
  for byte in text.utf8 {
    if isUnreserved(byte) {
      out.unicodeScalars.append(Unicode.Scalar(byte))
    } else if byte == 0x3B {
      out += "%253B"
    } else {
      out += "%" + hex(byte)
    }
  }
  return out
}

/// What survives encodeURIComponent and the link escapes: A–Z a–z 0–9 - _ . ~
private func isUnreserved(_ b: UInt8) -> Bool {
  (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) || (b >= 0x30 && b <= 0x39) || b == 0x2D || b == 0x5F
    || b == 0x2E || b == 0x7E
}

private func hex(_ b: UInt8) -> String {
  let digits = Array("0123456789ABCDEF".unicodeScalars)
  return String(String.UnicodeScalarView([digits[Int(b >> 4)], digits[Int(b & 0xF)]]))
}
