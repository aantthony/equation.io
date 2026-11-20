/// A complex equation in w (lib/plot.ts, lib/compiler.ts `compileCpu`, case
/// 'system' with a complex source): `w^3 = 1` is the system its real and
/// imaginary parts make in x and y, whose solutions are its roots.
///
/// The site names a root it can write exactly, `-1/2 + √3/2 i`: ComplexLabel.swift.

func compileComplexSystem(_ equation: Expr) throws -> CpuPlan {
  var (l, r) = (equation, Expr.num(0))
  if case .eq(let left, let right) = equation { (l, r) = (left, right) }
  let a = try splitWithin(l, "equation", "solve")
  let b = try splitWithin(r, "equation", "solve")
  return .complexSystem(residuals: [.bin(.sub, a.re, b.re), .bin(.sub, a.im, b.im)], equation: equation)
}
