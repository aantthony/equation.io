/// ∫ in a row (lib/defs.ts `expandInt`, `integral`, `resolveRow`), and the
/// area a definite integral's row shades (lib/intshade.ts).

/// What a `value` row carries when it is exactly one definite integral
/// (lib/intshade.ts `IntShade`).
public struct IntShade: Equatable, Sendable {
  /// The integrand, with the d<v> measure stripped.
  public var body: Expr
  /// The integration variable.
  public var v: String
  /// Bounds as written (resolved); ±inf stays the `inf` name.
  public var lo: Expr
  public var hi: Expr
}

extension Resolver {
  /// Expand an ∫ (lib/defs.ts `expandInt`).
  func expandInt(_ bounds: (Expr, Expr)?, _ rawBody: Expr) throws -> Expr {
    // Port: lib/integrate.ts (antiderivative, verifyDefinite, quadratureSum,
    // improperSum) is what writes an integral out.
    throw Unsupported("integrals")
  }
}
