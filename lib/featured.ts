/**
 * Graphs shown on a cold visit to `/` (no payload) and by the random control.
 *
 * The homepage URL stays `/` until the visitor edits, picks an example, or
 * clicks random — same contract as the old `y = sin(x)` default, so a
 * reload of the marketing URL is not a random `/g/…` link. Each empty load
 * advances a small cursor in localStorage so repeat visits rotate.
 */

export interface FeaturedGraph {
  /** Short label for the random control. */
  title: string;
  eqs: string[];
}

export const FEATURED_KEY = 'eq-featured';

/** Square math window around a showcase-style (cx, cy, span) framing. */
function viewBox(cx: number, cy: number, span: number): string {
  const hx = span / 2;
  const hy = span / 2;
  const fmt = (v: number) => String(parseFloat(v.toPrecision(6)));
  return `view(x = ${fmt(cx - hx)}..${fmt(cx + hx)}, y = ${fmt(cy - hy)}..${fmt(cy + hy)})`;
}

/**
 * One graph from each of the product's distinct surfaces, framed so a first
 * paint looks like the about gallery rather than the default 12-unit window.
 */
export const FEATURED: FeaturedGraph[] = [
  {
    title: 'traveling wave',
    eqs: ['x^2 + y^2 = 4', 'y = sin(x - 2t)', '-1 <= y - x/2 < 1'],
  },
  {
    title: 'Joukowski map',
    eqs: ['conformal(w + 1/w)', viewBox(0, 0, 8)],
  },
  {
    title: 'double pendulum',
    eqs: [
      'g = 9.8', 'L1 = 1', 'L2 = 1', 'm1 = 1', 'm2 = 1',
      'M = [((m1+m2) L1, m2 L2 cos(th_1 - th_2)), (L1 cos(th_1 - th_2), L2)]',
      'f = (-m2 L2 om_2^2 sin(th_1 - th_2) - (m1+m2) g sin(th_1), L1 om_1^2 sin(th_1 - th_2) - g sin(th_2))',
      "th' = om",
      "om' = solve(M, f)",
      'th(0) = (2.5, 2.4)',
      'b1 = (L1 sin(th_1), -L1 cos(th_1))',
      'b2 = b1 + (L2 sin(th_2), -L2 cos(th_2))',
      'segment((0, 0), b1)',
      'segment(b1, b2)',
      'b1',
      'b2',
      viewBox(0, -0.9, 4.6),
    ],
  },
  {
    title: 'domain coloring',
    eqs: ['domain((w^3 - 1)/w)', viewBox(0, 0, 3)],
  },
  {
    title: 'Fourier series',
    eqs: ['N = 8', 'y = 2 sum[n=1..N] (-1)^(n+1) sin(n x)/n'],
  },
  {
    title: 'Mandelbrot set',
    eqs: ['iter(z^2 + w)', viewBox(-0.5, 0, 2.7)],
  },
  {
    title: 'central limit theorem',
    eqs: [
      'view(x = -0.5..4.5, y = -0.15..1.35)',
      'X1 ~ Uniform(0, 1)', 'X2 ~ Uniform(0, 1)', 'X3 ~ Uniform(0, 1)', 'X4 ~ Uniform(0, 1)',
      'S = X1 + X2 + X3 + X4', 'Z ~ Normal(2, sqrt(1/3))', 'P(S > 3)',
    ],
  },
  {
    title: 'trefoil knot',
    eqs: ['tube((sin(2pi u) + 2sin(4pi u), cos(2pi u) - 2cos(4pi u), -sin(6pi u)))'],
  },
  {
    title: 'tangent line',
    eqs: [
      'f(x) = x^3 - 2x', 'g(x) = d/dx f(x)', 'a = 1',
      'y = f(x)', 'y = f(a) + g(a)(x - a)',
    ],
  },
  {
    title: 'ripples',
    eqs: ['sin(x^2 + y^2 - 4t)/2'],
  },
];

export function sameRows(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((row, i) => row === b[i]);
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** Next featured graph, advancing the stored cursor. Skips `current` if it
 *  already matches, so random never no-ops. */
export function nextFeatured(store: Store | null, current?: string[]): FeaturedGraph {
  const n = FEATURED.length;
  let i = 0;
  try {
    i = Number(store?.getItem(FEATURED_KEY) ?? 0) || 0;
  } catch { /* private mode, quota, … */ }
  i = ((i % n) + n) % n;
  if (current && sameRows(FEATURED[i].eqs, current)) i = (i + 1) % n;
  try {
    store?.setItem(FEATURED_KEY, String(i + 1));
  } catch { /* ignore */ }
  return FEATURED[i];
}
