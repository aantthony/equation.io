/**
 * Compile a symbolic Expr to a GLSL expression (float-valued).
 *
 * An equation l = r compiles to the scalar field F = l - r; the graph is the
 * zero set of F, which the renderers extract in a fragment shader.
 */
import { type Expr, ISPRIME_MAX, LANCZOS, ineqComparisons } from './expr.ts';

export const FN_GLSL: Record<string, string> = {
  ln: 'log',
  log: 'eq_log10',
  atan2: 'atan',
  round: 'eq_round',
  sech: 'eq_sech',
  fract: 'fract',
  erf: 'eq_erf',
  normalpdf: 'eq_normalpdf',
  normalcdf: 'eq_normalcdf',
  gcd: 'eq_gcd',
  isprime: 'eq_isprime',
  gamma: 'eq_gamma',
  factorial: 'eq_factorial',
  sinc: 'eq_sinc',
  coth: 'eq_coth',
};

/** Helper functions some expressions need; prepend once to the shader. */
export const GLSL_PRELUDE = `
float eq_log10(float x) { return log(x) * 0.4342944819032518; }
float eq_round(float x) { return floor(x + 0.5); }
float eq_sech(float x) { return 1.0 / cosh(x); }
float eq_erf(float x) {
  // Abramowitz & Stegun 7.1.26; max absolute error ~1.5e-7.
  float a = abs(x);
  float t = 1.0 / (1.0 + 0.3275911 * a);
  float y = 1.0 - ((((1.061405429*t - 1.453152027)*t + 1.421413741)*t - 0.284496736)*t + 0.254829592)
    * t * exp(-a * a);
  return sign(x) * y;
}
float eq_normalpdf(float x, float mean, float sd) {
  float z = (x - mean) / sd;
  return exp(-0.5 * z * z) / (sd * 2.5066282746310002);
}
float eq_normalcdf(float x, float mean, float sd) {
  return 0.5 * (1.0 + eq_erf((x - mean) * 0.7071067811865476 / sd));
}
float eq_gcd(float a, float b) {
  a = abs(floor(a + 0.5)); b = abs(floor(b + 0.5));
  for (int k = 0; k < 64; k++) {
    if (b < 0.5) break;
    float t = mod(a, b); a = b; b = t;
  }
  return a;
}
float eq_isprime(float x) {
  float n = floor(x + 0.5);
  if (abs(x - n) > 1e-6 || n < 2.0) return 0.0;
  // Trial division; floats are exact for integers below 2^24 (cap covers n < ~4.2M).
  // Beyond that the divisors run out before √n, so the answer is unknown, not
  // prime — report NaN, matching the CPU twin (both bounded by ISPRIME_MAX).
  if (n > ${ISPRIME_MAX}.0) return sqrt(-1.0);
  for (int i = 2; i < 2048; i++) {
    float fi = float(i);
    if (fi * fi > n) break;
    float m = mod(n, fi);
    if (m < 0.5 || m > fi - 0.5) return 0.0;
  }
  return 1.0;
}
float eq_gamma(float x) {
  // Lanczos g=5 — the coefficients interpolate from LANCZOS in expr.ts, the
  // gammaFn() twin — with the x < 0.5 reflection inlined (GLSL has no
  // recursion). float32 can't hit the negative-integer poles exactly, so
  // they render as the divergence they neighbor.
  float z = x < 0.5 ? 1.0 - x : x;
  z -= 1.0;
  float ser = 1.000000000190015
${LANCZOS.map((c, i) => `    + ${c} / (z + ${i + 1}.0)`).join('\n')};
  float t = z + 5.5;
  // Assembled in log space: a bare pow(t, z + 0.5) factor overflows float32
  // from x ≈ 27, well before Γ itself does (~35).
  float g = exp((z + 0.5) * log(t) - t + log(2.5066282746310002 * ser));
  if (x >= 0.5) return g;
  return 3.141592653589793 / (sin(3.141592653589793 * x) * g);
}
float eq_factorial(float x) { return eq_gamma(x + 1.0); }
float eq_sinc(float x) { return x == 0.0 ? 1.0 : sin(x) / x; }
// 1/tanh, not cosh/sinh: the latter is Inf/Inf = NaN for |x| > ~89 where
// coth is ±1 (and the cothFn() CPU twin says so).
float eq_coth(float x) { return 1.0 / tanh(x); }
float eq_pow(float a, float b) {
  // Support negative bases via the "real odd root" convention, e.g.
  // (-8)^(1/3) = -2, matching graphing calculators like Desmos. For a < 0,
  // find the exponent's rational form p/q in lowest terms via a tolerance
  // search over small denominators (q = 1..12); if q is odd, the root is
  // real: sign * |a|^b, sign negative iff the reduced numerator p is odd.
  // No match within tolerance, or an even q (an even root, e.g. (-4)^(1/2)),
  // leaves the result NaN. Tolerance 1e-6 is tight enough that a typed
  // decimal like 0.33333 (~3.3e-6 from 1/3) is left undefined rather than
  // silently snapped. Kept in sync with realPow() in expr.ts (same
  // algorithm; eq_gcd stands in for the CPU version's inline gcd loop).
  if (a >= 0.0) return pow(a, b);
  for (int q = 1; q <= 12; q++) {
    float fq = float(q);
    float p = floor(b * fq + 0.5);
    float g = eq_gcd(abs(p), fq);
    if (g < 1.0) g = 1.0;
    float pr = p / g;
    float qr = fq / g;
    if (abs(b - pr / qr) < 1e-6) {
      if (mod(qr, 2.0) < 0.5) return sqrt(-1.0); // even root: undefined
      float sign = mod(abs(pr), 2.0) > 0.5 ? -1.0 : 1.0;
      return sign * pow(-a, b);
    }
  }
  return sqrt(-1.0); // no small-denominator rational found
}
// Complex arithmetic on vec2(re, im).
vec2 c_mul(vec2 a, vec2 b) { return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
vec2 c_div(vec2 a, vec2 b) { return vec2(a.x*b.x + a.y*b.y, a.y*b.x - a.x*b.y) / dot(b, b); }
vec2 c_ln(vec2 z) { return vec2(0.5 * log(dot(z, z)), atan(z.y, z.x)); }
vec2 c_exp(vec2 z) { return exp(z.x) * vec2(cos(z.y), sin(z.y)); }
vec2 c_pow(vec2 a, vec2 b) { return c_exp(c_mul(b, c_ln(a))); }
vec2 c_sqrt(vec2 z) {
  float r = length(z);
  return vec2(sqrt(0.5 * (r + z.x)), sign(z.y) * sqrt(0.5 * (r - z.x)));
}
vec2 c_log10(vec2 z) { return c_ln(z) * 0.4342944819032518; }
vec2 c_sin(vec2 z) { return vec2(sin(z.x) * cosh(z.y), cos(z.x) * sinh(z.y)); }
vec2 c_cos(vec2 z) { return vec2(cos(z.x) * cosh(z.y), -sin(z.x) * sinh(z.y)); }
vec2 c_tan(vec2 z) { return c_div(c_sin(z), c_cos(z)); }
vec2 c_sinh(vec2 z) { return vec2(sinh(z.x) * cos(z.y), cosh(z.x) * sin(z.y)); }
vec2 c_cosh(vec2 z) { return vec2(cosh(z.x) * cos(z.y), sinh(z.x) * sin(z.y)); }
vec2 c_tanh(vec2 z) { return c_div(c_sinh(z), c_cosh(z)); }
`;

/**
 * Compile a (possibly chained) inequality to a GLSL boolean via the given
 * scalar emitter (toGLSL here; complex.ts passes its real-checked emitter).
 */
export function condGLSL(cond: Expr, emit: (x: Expr) => string): string {
  if (cond.kind !== 'ineq') throw new Error('Piecewise conditions must be inequalities, like x < 0.');
  return ineqComparisons(cond).map(c => `(${emit(c.l)} ${c.op} ${emit(c.r)})`).join(' && ');
}

/** Nested-ternary GLSL for a piecewise; NaN outside all cases when no default. */
export function piecewiseGLSL(
  e: Expr & { kind: 'piecewise' },
  emit: (x: Expr) => string,
): string {
  let out = e.otherwise ? emit(e.otherwise) : 'sqrt(-1.0)';
  for (let k = e.cases.length - 1; k >= 0; k--) {
    const c = e.cases[k];
    out = `((${condGLSL(c.cond, emit)}) ? ${emit(c.value)} : ${out})`;
  }
  return out;
}

function fmt(value: number): string {
  if (!isFinite(value)) throw new Error(`Cannot compile non-finite constant: ${value}`);
  const s = String(value);
  return /[.e]/.test(s) ? s.replace('e', 'E') : `${s}.0`;
}

/**
 * Emit a GLSL float expression. Free variables compile to their own names,
 * so the caller must declare/provide them (e.g. as function parameters).
 */
export function toGLSL(e: Expr): string {
  switch (e.kind) {
    case 'num': return fmt(e.value);
    case 'var': return e.name;
    case 'neg': return `(-${toGLSL(e.a)})`;
    case 'bin': {
      const a = toGLSL(e.a);
      const b = toGLSL(e.b);
      if (e.op === '^') {
        if (e.b.kind === 'num' && Number.isInteger(e.b.value) && e.b.value >= 1 && e.b.value <= 8) {
          // Small integer powers: expand to products (fast, exact for negative bases).
          return `(${Array.from({ length: e.b.value }, () => a).join('*')})`;
        }
        return `eq_pow(${a}, ${b})`;
      }
      return `(${a} ${e.op} ${b})`;
    }
    case 'call': {
      const name = FN_GLSL[e.name] ?? e.name;
      return `${name}(${e.args.map(toGLSL).join(', ')})`;
    }
    case 'eq':
      return `(${toGLSL(e.l)} - (${toGLSL(e.r)}))`;
    case 'ineq':
      throw new Error('Inequality in scalar context.');
    case 'vec':
      throw new Error('Vector in scalar context.');
    case 'list':
    case 'data':
      throw new Error('A list can only be plotted as its own row.');
    case 'piecewise':
      return piecewiseGLSL(e, toGLSL);
  }
}
