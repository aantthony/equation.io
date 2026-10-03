/** Real, periodic signals: a one-sided amplitude spectrum and a Fourier
 * reconstruction. Samples cover [lo, hi), never duplicate the endpoint.
 * The forward DFT uses exp(-2πijk/n); cosine = 2 Re/n, sine = -2 Im/n.
 * DC and an even-length Nyquist bin occur only once, so are not doubled.
 * See https://numpy.org/doc/stable/reference/routines.fft.html.
 */
import { add, mul, sub } from './diff.ts';
import type { Expr } from './expr.ts';

export const FOURIER_SAMPLES = 256;
export const FOURIER_MAX_SAMPLES = 4096;
export const FOURIER_MAX_HARMONICS = 128;

export interface FourierCoefficients {
  cosine: Float64Array;
  sine: Float64Array;
}

/** In-place radix-2 FFT; inverse includes the 1/n normalization. */
function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let width = 2; width <= n; width *= 2) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / width;
    const wr = Math.cos(angle),
      wi = Math.sin(angle);
    for (let start = 0; start < n; start += width) {
      let r = 1,
        s = 0;
      for (let k = 0; k < width / 2; k++) {
        const a = start + k,
          b = a + width / 2;
        const br = re[b] * r - im[b] * s,
          bi = re[b] * s + im[b] * r;
        re[b] = re[a] - br;
        im[b] = im[a] - bi;
        re[a] += br;
        im[a] += bi;
        [r, s] = [r * wr - s * wi, r * wi + s * wr];
      }
    }
  }
  if (inverse)
    for (let k = 0; k < n; k++) {
      re[k] /= n;
      im[k] /= n;
    }
}

/** Bluestein turns any sample count into one power-of-two convolution.
 * It preserves the original period and bin spacing; no zero padding of
 * the signal, discarded tail samples, or quadratic-time DFT fallback. */
function transform(xs: Float64Array): [Float64Array, Float64Array] {
  const n = xs.length;
  if ((n & (n - 1)) === 0) {
    const re = xs.slice(),
      im = new Float64Array(n);
    fft(re, im);
    return [re, im];
  }
  let size = 1;
  while (size < 2 * n - 1) size *= 2;
  const ar = new Float64Array(size),
    ai = new Float64Array(size);
  const br = new Float64Array(size),
    bi = new Float64Array(size);
  for (let j = 0; j < n; j++) {
    const angle = (Math.PI * ((j * j) % (2 * n))) / n;
    const c = Math.cos(angle),
      s = Math.sin(angle);
    ar[j] = xs[j] * c;
    ai[j] = -xs[j] * s;
    br[j] = c;
    bi[j] = s;
    if (j) {
      br[size - j] = c;
      bi[size - j] = s;
    }
  }
  fft(ar, ai);
  fft(br, bi);
  for (let j = 0; j < size; j++) {
    const r = ar[j] * br[j] - ai[j] * bi[j];
    ai[j] = ar[j] * bi[j] + ai[j] * br[j];
    ar[j] = r;
  }
  fft(ar, ai, true);
  const re = new Float64Array(n),
    im = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    const angle = (Math.PI * ((j * j) % (2 * n))) / n;
    const c = Math.cos(angle),
      s = Math.sin(angle);
    re[j] = ar[j] * c + ai[j] * s;
    im[j] = ai[j] * c - ar[j] * s;
  }
  return [re, im];
}

export function realFourier(xs: Float64Array): FourierCoefficients {
  const n = xs.length;
  if (n < 2 || n > FOURIER_MAX_SAMPLES) throw new Error(`Fourier analysis needs 2 to ${FOURIER_MAX_SAMPLES} samples.`);
  if (xs.some(x => !Number.isFinite(x))) {
    throw new Error(
      'Fourier analysis needs finite real samples; missing values cannot be skipped without changing their spacing.',
    );
  }
  const [re, im] = transform(xs);
  const count = Math.floor(n / 2) + 1;
  const cosine = new Float64Array(count),
    sine = new Float64Array(count);
  // Remove FFT roundoff relative to this signal, preserving small signals.
  const tolerance = xs.reduce((m, x) => Math.max(m, Math.abs(x)), 0) * 1e-12;
  for (let k = 0; k < count; k++) {
    const single = k === 0 || 2 * k === n;
    const a = (re[k] * (single ? 1 : 2)) / n;
    const b = single ? 0 : (-2 * im[k]) / n;
    if (!Number.isFinite(a) || !Number.isFinite(b))
      throw new Error('Fourier coefficients overflowed; rescale the signal.');
    cosine[k] = Math.abs(a) <= tolerance ? 0 : a;
    sine[k] = Math.abs(b) <= tolerance ? 0 : b;
  }
  return { cosine, sine };
}

const num = (value: number): Expr => ({ kind: 'num', value });

/** Ordinary points: the existing scatter, figures, CPU previews and MCP
 * backends all understand them without a new mathematical object kind. */
export function spectrumPoints(c: FourierCoefficients, period: number): Expr[] {
  return Array.from(c.cosine, (a, k) => ({
    kind: 'vec',
    items: [num(k / period), num(Math.hypot(a, c.sine[k]))],
  }));
}

/** The signed DC term is always included; N selects bins 1..N. Phase is
 * retained, so full reconstruction interpolates the original samples. */
export function reconstructSeries(
  c: FourierCoefficients,
  harmonics: number,
  lo: number,
  period: number,
  count?: Expr,
): Expr {
  let result: Expr = num(c.cosine[0]);
  const position = sub({ kind: 'var', name: 'x' }, num(lo));
  for (let k = 1; k <= harmonics; k++) {
    const angle = mul(num((2 * Math.PI * k) / period), position);
    let term: Expr = num(0);
    if (c.cosine[k]) term = add(term, mul(num(c.cosine[k]), { kind: 'call', name: 'cos', args: [angle] }));
    if (c.sine[k]) term = add(term, mul(num(c.sine[k]), { kind: 'call', name: 'sin', args: [angle] }));
    if (term.kind === 'num' && term.value === 0) continue;
    // A bounded count is a uniform: the coefficient table and shader stay
    // fixed across a drag. Each guard covers both phase components and its
    // symbolic spatial derivative, skipping harmonics above the count.
    result = add(
      result,
      count
        ? {
            kind: 'piecewise',
            cases: [{ cond: { kind: 'ineq', op: '>=', l: count, r: num(k) }, value: term }],
            otherwise: num(0),
          }
        : term,
    );
  }
  return result;
}
