import { structuralDiagnostic } from './expr.ts';
/**
 * Compile a symbolic Expr to a GLSL expression (float-valued).
 *
 * An equation l = r compiles to the scalar field F = l - r; the graph is the
 * zero set of F, which the renderers extract in a fragment shader.
 */
import {
  ANGLE_FN, ANGLE_RATE_FN, BETA_PDF_FN, type Expr, GAMMA_PDF_FN, ISPRIME_MAX, LANCZOS, PMF_FNS, T_PDF_FN,
  WEIBULL_PDF_FN, ineqComparisons,
} from './expr.ts';

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
  [ANGLE_FN]: 'eq_angle',
  [ANGLE_RATE_FN]: 'eq_angle_rate',
  [GAMMA_PDF_FN]: 'eq_gammapdf',
  [BETA_PDF_FN]: 'eq_betapdf',
  [T_PDF_FN]: 'eq_tpdf',
  [WEIBULL_PDF_FN]: 'eq_weibullpdf',
};

/** Helper functions some expressions need; prepend once to the shader. */
export const GLSL_PRELUDE = `
// A real NaN. The literal sqrt(-1.0) is undefined in GLSL and ANGLE
// constant-folds it to 0.0, which turned "undefined" into a plotted zero.
#define EQ_NAN uintBitsToFloat(0x7fc00000u)
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
  if (n > ${ISPRIME_MAX}.0) return EQ_NAN;
  for (int i = 2; i < 2048; i++) {
    float fi = float(i);
    if (fi * fi > n) break;
    float m = mod(n, fi);
    if (m < 0.5 || m > fi - 0.5) return 0.0;
  }
  return 1.0;
}
// ln Gamma(x) for x >= 0.5: Lanczos g=5, the coefficients interpolated from
// LANCZOS in expr.ts. Kept in log space throughout — a bare pow(t, z + 0.5)
// factor overflows float32 from x ≈ 27, well before Gamma itself does (~35).
float eq_lgamma_upper(float x) {
  float z = x - 1.0;
  float ser = 1.000000000190015
${LANCZOS.map((c, i) => `    + ${c} / (z + ${i + 1}.0)`).join('\n')};
  float t = z + 5.5;
  return (z + 0.5) * log(t) - t + log(2.5066282746310002 * ser);
}
float eq_gamma(float x) {
  // gammaFn() twin, with the x < 0.5 reflection inlined (GLSL has no
  // recursion). float32 can't hit the negative-integer poles exactly, so
  // they render as the divergence they neighbor.
  if (x >= 0.5) return exp(eq_lgamma_upper(x));
  return 3.141592653589793 / (sin(3.141592653589793 * x) * exp(eq_lgamma_upper(1.0 - x)));
}
float eq_factorial(float x) { return eq_gamma(x + 1.0); }
// --- the distribution densities: twins of gammaPdf & co. in lib/specfn.ts ---
// Same conventions: 0 outside the support and under an invalid parameter,
// never NaN; a pole is EQ_BIG rather than an Inf a driver may mishandle.
// float32 changes HOW they are computed: every form below keeps its exponent
// O(1) term by term, because a sum of ±1e4-sized logs has no digits left
// (Gamma(200, 1) naively is 860 − 1055 + … ; t with df = 1e6 subtracts two
// lgammas of 6e6 whose ulp is 0.5).
#define EQ_BIG 3.0e38
// ln Gamma(x) for x > 0 (the distributions' shapes; reflection below 1/2).
float eq_lgamma(float x) {
  if (x >= 0.5) return eq_lgamma_upper(x);
  return log(3.141592653589793 / sin(3.141592653589793 * x)) - eq_lgamma_upper(1.0 - x);
}
float eq_log1p(float v) {
  if (abs(v) < 0.01) return v * (1.0 - v * (0.5 - v * (0.3333333333 - v * 0.25)));
  return log(1.0 + v);
}
// ln(1 + d) - d, which is -d*d/2 near 0 where the subtraction would cancel.
float eq_log1pmx(float d) {
  if (abs(d) < 0.1) {
    return d * d * (-0.5 + d * (0.3333333333 + d * (-0.25 + d * (0.2 + d * (-0.1666666667 + d * 0.1428571429)))));
  }
  return log(1.0 + d) - d;
}
// ln of v^a e^-v / Gamma(a): Stirling about the mode from a = 20 (lnGammaKernel).
float eq_lngammakernel(float a, float v) {
  if (a < 20.0) return a * log(v) - v - eq_lgamma(a);
  float r = 1.0 / (a * a);
  float corr = (0.08333333333 - r * (0.002777777778 - r * 0.0007936507937)) / a;
  return a * eq_log1pmx((v - a) / a) + 0.5 * log(a) - 0.9189385332046727 - corr;
}
float eq_gammapdf(float x, float shape, float rate) {
  if (!(shape > 0.0 && rate > 0.0) || !(x >= 0.0)) return 0.0;
  if (x == 0.0) return shape < 1.0 ? EQ_BIG : (shape == 1.0 ? rate : 0.0);
  return min(exp(eq_lngammakernel(shape, rate * x)) / x, EQ_BIG);
}
float eq_betapdf(float x, float a, float b) {
  if (!(a > 0.0 && b > 0.0) || !(x >= 0.0 && x <= 1.0)) return 0.0;
  if (x == 0.0) return a < 1.0 ? EQ_BIG : (a == 1.0 ? b : 0.0);
  if (x == 1.0) return b < 1.0 ? EQ_BIG : (b == 1.0 ? a : 0.0);
  float p = a - 1.0;
  float q = b - 1.0;
  float k;
  if (p > 30.0 && q > 30.0) {
    // About the mode x0 = p/n, where Stirling gives the peak height directly:
    // ln pdf(x0) = ln(n + 1) + ln(n/(2 pi p q))/2 + (1/n - 1/p - 1/q)/12.
    float n = p + q;
    float x0 = p / n;
    k = p * log(x / x0) + q * log((1.0 - x) / (1.0 - x0))
      + log(n + 1.0) + 0.5 * log(n / (6.283185307179586 * p * q))
      + (1.0 / n - 1.0 / p - 1.0 / q) / 12.0;
  } else {
    k = p * log(x) + q * log(1.0 - x) + eq_lgamma(a + b) - eq_lgamma(a) - eq_lgamma(b);
  }
  return min(exp(k), EQ_BIG);
}
float eq_tpdf(float x, float df) {
  if (!(df > 0.0) || isnan(x) || isinf(x)) return 0.0;
  float z = 0.5 * df;
  // lgamma(z + 1/2) - lgamma(z): its own series once the two would cancel.
  float c = z < 30.0
    ? eq_lgamma(z + 0.5) - eq_lgamma(z)
    : 0.5 * log(z) - (0.125 - 0.005208333333 / (z * z)) / z;
  return exp(-(z + 0.5) * eq_log1p(x * x / df) + c - 0.5 * log(df * 3.141592653589793));
}
float eq_weibullpdf(float x, float shape, float scale) {
  if (!(shape > 0.0 && scale > 0.0) || !(x >= 0.0)) return 0.0;
  if (x == 0.0) return shape < 1.0 ? EQ_BIG : (shape == 1.0 ? 1.0 / scale : 0.0);
  float lr = log(x / scale);
  float e = shape * lr; // ln (x/scale)^shape
  if (e > 80.0) return 0.0; // exp(-exp(e)) is 0 long before exp(e) overflows
  return min((shape / scale) * exp((shape - 1.0) * lr - exp(e)), EQ_BIG);
}
float eq_sinc(float x) { return x == 0.0 ? 1.0 : sin(x) / x; }
// 1/tanh, not cosh/sinh: the latter is Inf/Inf = NaN for |x| > ~89 where
// coth is ±1 (and the cothFn() CPU twin says so).
float eq_coth(float x) { return 1.0 / tanh(x); }
// angleFn in lib/expr.ts: the signed angle from arm u to arm v in (-pi, pi],
// NaN for a zero-length arm. Arms are scaled by their largest component so
// float32 products cannot underflow near the vertex, and the straight angle
// is a branch, not a signed zero a compiler is free to fold away.
float eq_angle(float u0, float u1, float v0, float v1) {
  // GLSL max() may return either operand when one is NaN; Math.max does not.
  if (isnan(u0) || isnan(u1) || isnan(v0) || isnan(v1)) return EQ_NAN;
  float su = max(abs(u0), abs(u1));
  float sv = max(abs(v0), abs(v1));
  if (!(su > 0.0 && sv > 0.0)) return EQ_NAN;
  vec2 a = vec2(u0, u1) / su;
  vec2 b = vec2(v0, v1) / sv;
  float c = a.x * b.y - a.y * b.x;
  float d = dot(a, b);
  if (c == 0.0) return d < 0.0 ? 3.141592653589793 : (d > 0.0 ? 0.0 : EQ_NAN);
  return atan(c, d);
}
// angleRateFn in lib/expr.ts: (v x w)/|v|^2 with v scaled by its largest
// component, the per-arm term of eq_angle's derivative.
float eq_angle_rate(float v0, float v1, float w0, float w1) {
  if (isnan(v0) || isnan(v1)) return EQ_NAN;
  float s = max(abs(v0), abs(v1));
  if (!(s > 0.0)) return EQ_NAN;
  vec2 a = vec2(v0, v1) / s;
  return (a.x * (w1 / s) - a.y * (w0 / s)) / dot(a, a);
}
float eq_sq(float a) { return a * a; }
float eq_ipow(float a, int n) {
  float r = a;
  for (int k = 1; k < n; k++) r *= a;
  return r;
}
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
      if (mod(qr, 2.0) < 0.5) return EQ_NAN; // even root: undefined
      float sign = mod(abs(pr), 2.0) > 0.5 ? -1.0 : 1.0;
      return sign * pow(-a, b);
    }
  }
  return EQ_NAN; // no small-denominator rational found
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

/** Nested-ternary GLSL for a piecewise; NaN outside all cases when no default.
 *  `emitValue` compiles the case values when they are typed differently from
 *  the (real) condition sides, with `nan` the undefined value of that type. */
export function piecewiseGLSL(
  e: Expr & { kind: 'piecewise' },
  emit: (x: Expr) => string,
  emitValue: (x: Expr) => string = emit,
  nan = 'EQ_NAN',
): string {
  let out = e.otherwise ? emitValue(e.otherwise) : nan;
  for (let k = e.cases.length - 1; k >= 0; k--) {
    const c = e.cases[k];
    out = `((${condGLSL(c.cond, emit)}) ? ${emitValue(c.value)} : ${out})`;
  }
  return out;
}

/**
 * Functions a compiled expression refers to beyond the prelude — a recursive
 * function's loop — by name. Names hash their own source, so equal loops
 * share a declaration and a shader's source alone identifies its program.
 * compileProgram (web/gl.ts) splices the declarations a shader refers to in
 * after the prelude with withHelpers(); nothing else needs to carry them.
 */
const helpers = new Map<string, string>();
const HELPER_NAME = /\beq_loop_[0-9a-f]+\b/g;
export function declareHelper(source: string): string {
  // FNV-1a over the source with its own name blanked out.
  let hash = 0x811c9dc5;
  for (let k = 0; k < source.length; k++) hash = Math.imul(hash ^ source.charCodeAt(k), 0x01000193);
  const name = `eq_loop_${(hash >>> 0).toString(16)}`;
  helpers.set(name, source.replaceAll(HELPER_SELF, name));
  return name;
}
export const HELPER_SELF = '@self';
export function withHelpers(shader: string): string {
  if (!shader.includes('eq_loop_')) return shader;
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (text: string): void => {
    for (const [name] of text.matchAll(HELPER_NAME)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const source = helpers.get(name);
      if (!source) throw new Error(`Shader refers to an undeclared helper ${name}.`);
      visit(source); // dependencies (an inner loop) declare first
      order.push(name);
    }
  };
  visit(shader);
  return shader.replace(GLSL_PRELUDE, `${GLSL_PRELUDE}\n${order.map(name => helpers.get(name)).join('\n')}\n`);
}

function fmt(value: number): string {
  if (!isFinite(value)) throw new Error(`Cannot compile non-finite constant: ${value}`);
  const s = String(value);
  return /[.e]/.test(s) ? s.replace('e', 'E') : `${s}.0`;
}

/**
 * The GLSL identifier for the uniform carrying the constant `p`. Plain names
 * keep their readable u_<name> form; a name GLSL cannot hold — θ or T₀
 * (non-ASCII), `_a` or `a__b` (a leading `_` here or a doubled `_` anywhere
 * makes a reserved GLSL identifier) — becomes u_zz<hex codepoints joined by
 * z>. `z` is not a hex digit, so that spelling is unambiguous, and a plain
 * name starting with `zz` is encoded too, so distinct names never share a
 * uniform. Every site that names a uniform — substitution, shader
 * declaration, and getUniformLocation — must go through this one function.
 */
export const uniformName = (p: string): string =>
  /^[A-Za-z0-9_]+$/.test(p) && !p.startsWith('_') && !p.startsWith('zz') && !p.includes('__')
    ? `u_${p}`
    : `u_zz${[...p].map(c => c.codePointAt(0)!.toString(16)).join('z')}`;

/**
 * Emit a GLSL float expression. Free variables compile to their own names,
 * so the caller must declare/provide them (e.g. as function parameters).
 */
export function toGLSL(e: Expr): string {
  switch (e.kind) {
    case 'index': case 'range': case 'eqtest': case 'comp': case 'figure': case 'trail': case 'hist': case 'family': throw new Error(structuralDiagnostic(e));
    case 'num': return fmt(e.value);
    case 'var': return e.name;
    case 'neg': return `(-${toGLSL(e.a)})`;
    case 'bin': {
      const a = toGLSL(e.a);
      const b = toGLSL(e.b);
      if (e.op === '^') {
        if (e.b.kind === 'num' && Number.isInteger(e.b.value) && e.b.value >= 1 && e.b.value <= 8) {
          // Small integer powers: expand to products (fast, exact for negative
          // bases). Only a name or a number is repeated, though: a compound
          // base goes through a helper, so (Σ 40 terms)^2 evaluates — and
          // spells out — its base once, not once per factor.
          if (e.a.kind === 'var' || e.a.kind === 'num' || e.b.value === 1) {
            return `(${Array.from({ length: e.b.value }, () => a).join('*')})`;
          }
          return e.b.value === 2 ? `eq_sq(${a})` : `eq_ipow(${a}, ${e.b.value})`;
        }
        return `eq_pow(${a}, ${b})`;
      }
      return `(${a} ${e.op} ${b})`;
    }
    case 'call': {
      // No float32 twin, on purpose: a pmf is nonzero only AT the integers, a
      // set of measure zero no fragment ever lands on. Rows draw it as stems.
      if (PMF_FNS.has(e.name)) throw new Error('A probability mass function is drawn as stems, not as a curve.');
      // A Σ/Π is either expanded away or evaluated on the CPU (a sequence
      // term). It has no shader form.
      if (e.name === 'sum' || e.name === 'prod') {
        throw new Error(`${e.name === 'sum' ? 'Σ' : 'Π'} must be expanded before it can be drawn as a curve.`);
      }
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
    case 'str':
    case 'text':
      throw new Error('Text cannot be plotted — it can only be compared, inside a filter.');
    case 'piecewise':
      return piecewiseGLSL(e, toGLSL);
    case 'loop':
      // compileTyped (lib/complex.ts) emits loops; it types the params.
      throw new Error('A recursive function cannot be used here yet.');
  }
}
