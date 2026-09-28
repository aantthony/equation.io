/**
 * An escape-time fractal of the plane as rows a person could type: a
 * tail-recursive count M, and M(w, 0) as a bare scalar field, so it is
 * drawn in the row's own color like any other field. Shared by the
 * examples, the about page and the featured graph, and the same form
 * lib/plot.ts rewrites an old `iter(step)` link into.
 *
 * M(w, 0) iterates z ↦ step from the pixel: with w in the step that is the
 * Mandelbrot convention (z₁ = w), with a fixed constant a Julia set. The
 * exit value k − log₂ ln|z| is the smooth escape count, near 0 far from the
 * set; divided by escapeScale it spans the scalar shading's ramp (a tanh
 * that saturates near 3), so the far field fades out and the filaments
 * stay distinct. An orbit still bounded after `count` passes is inside and
 * returns ESCAPE_INSIDE, well past saturation: the set is solid.
 */

/**
 * The escape test runs after a step, so |z| can reach ESCAPE_RADIUSⁿ for a
 * degree-n map, and GLSL's length() squares that: 100 keeps both inside
 * float32 through degree 9, where 10^6 already overflowed at degree 4 and
 * the pixel came out transparent. Big enough that the smooth count shows
 * no bands.
 */
export const ESCAPE_RADIUS = 100;

/** What an orbit bounded after every pass returns: saturated shading. */
export const ESCAPE_INSIDE = 10;

/** The count's divisor for a cap: counts near the set grow with the cap
 *  (a deep zoom needs more passes), so the ramp stretches with it: about
 *  count/8, rounded to a multiple of 5 for rows people read. */
export const escapeScale = (count: number): number => Math.max(5, 5 * Math.round(count / 40));

export function escapeTimeRows(step: string, count = 250): string[] {
  return [
    `M(z, k) = {|z| > ${ESCAPE_RADIUS}: max(k - log2(ln(|z|)), 0)/${escapeScale(count)}, k >= ${count}: ${ESCAPE_INSIDE}, M(${step}, k + 1)}`,
    'M(w, 0)',
  ];
}
