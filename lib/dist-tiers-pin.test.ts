/**
 * Pins the tier a CONTINUOUS variable lands in, and what that tier says — the
 * selection logic in RVSystem (exactLaw → usum → conditional-CDF quadrature →
 * sampled KDE; exactMoments → quadMoments → curve) is the riskiest code in
 * lib/dist.ts, and discrete variables (plan #6) thread through all of it. The
 * expected values were recorded before that work; a change here is a change to
 * continuous behaviour, which #6 must not make.
 */
import { describe, expect, it } from 'vitest';
import { RVSystem, buildRVSystem, scanRandomRows, toProbability } from './dist.ts';
import { parseExpr } from './expr.ts';

const none = new Set<string>();
const DOC = [
  'X ~ Normal(0, 1)',
  'Y ~ Normal(1, 2)',
  'U ~ Uniform(0, 1)',
  'V ~ Uniform(0, 2)',
  'T ~ Exponential(2)',
  'G ~ Gamma(2, 3)',
  'C ~ Cauchy(0, 1)',
  'S ~ StudentT(2)',
  'L ~ LogNormal(0, 1)',
  'A = 2 X + Y - 1',
  'B = U + V',
  'D = X^2',
  'F = X Y',
  'H = 1 / X',
  'I = U^2',
  'J = X + U + T',
  'K = {X > 0: X, 0}',
  'M = G + T',
  'N = C + 1',
  'O = S + 1',
  'Q = L X',
  'R = X + X',
  'W = 3 T',
  'Z = sqrt(X)',
];
const NAMES = DOC.map(r => r.split(/[~=]/)[0].trim());

const sig = (x: number | undefined): number | string | undefined =>
  x === undefined ? undefined : Number.isFinite(x) ? Number(x.toPrecision(10)) : String(x);

function record(): Record<string, unknown> {
  const sys = new RVSystem();
  buildRVSystem(sys, scanRandomRows(DOC), {
    fnNames: none,
    getFn: () => undefined,
    constNames: none,
    taken: () => false,
  });
  const out: Record<string, unknown> = {};
  for (const name of NAMES) {
    const law = sys.exactLaw(name);
    const c = sys.exactDist(name) ? null : sys.curve(name, {});
    const m = sys.moments(name, {});
    out[name] = {
      law: law ? (law.kind === 'dist' ? law.dist.kind : law.kind) : null,
      quad: sys.quadMoments(name, {}) !== null,
      moments: m && Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === 'number' ? sig(v) : v])),
      mean: sig(sys.mean(name, {})),
      unstable: sys.meanUnstable(name, {}),
      curve: c && {
        n: c.pts.length,
        atoms: (c.atoms ?? []).map(a => [sig(a.x), sig(a.p)]),
        area: sig(c.pts.reduce((s, y, i) => (i % 2 ? s + y : s), 0)),
      },
    };
  }
  const names = new Set(NAMES);
  for (const body of ['X > Y', 'F > 0.5', 'X < U < Y', 'K <= 0', 'H > 2']) {
    out[`P(${body})`] = sig(sys.probability(toProbability(parseExpr(body, none), names).body, {}));
  }
  for (const [name, body] of [
    ['B', '0.5 < B < 1.5'],
    ['A', 'A < 0'],
    ['M', 'M > 1'],
  ] as const) {
    const s = toProbability(parseExpr(body, none), names).single!;
    out[`exact P(${body})`] = sig(sys.exactProbability(name, s.lo, s.hi, {}, s) ?? undefined);
  }
  return out;
}

describe('continuous tier selection is pinned', () => {
  it('every representative row keeps its tier and its numbers', () => {
    const got = record();
    if (process.env.PIN_RECORD) console.log(`PIN${JSON.stringify(got)}PIN`);
    expect(got).toEqual(EXPECTED);
  });
});

// Recorded at bb21c53 (PIN_RECORD=1 prints a fresh one).
const EXPECTED: Record<string, unknown> = {
  X: {
    law: 'normal',
    quad: false,
    moments: { kind: 'exact', mean: 0, sd: 1, mass: 1 },
    mean: 0,
    unstable: false,
    curve: null,
  },
  Y: {
    law: 'normal',
    quad: false,
    moments: { kind: 'exact', mean: 1, sd: 2, mass: 1 },
    mean: 1,
    unstable: false,
    curve: null,
  },
  U: {
    law: 'uniform',
    quad: false,
    moments: { kind: 'exact', mean: 0.5, sd: 0.2886751346, mass: 1 },
    mean: 0.5,
    unstable: false,
    curve: null,
  },
  V: {
    law: 'uniform',
    quad: false,
    moments: { kind: 'exact', mean: 1, sd: 0.5773502692, mass: 1 },
    mean: 1,
    unstable: false,
    curve: null,
  },
  T: {
    law: 'exponential',
    quad: false,
    moments: { kind: 'exact', mean: 0.5, sd: 0.5, mass: 1 },
    mean: 0.5,
    unstable: false,
    curve: null,
  },
  G: {
    law: 'gamma',
    quad: false,
    moments: { kind: 'exact', mean: 0.6666666667, sd: 0.4714045208, mass: 1 },
    mean: 0.6666666667,
    unstable: false,
    curve: null,
  },
  C: {
    law: 'cauchy',
    quad: false,
    moments: { kind: 'robust', median: -0.01647980088, iqr: 2.019603568, meanOk: false, mass: 1 },
    mean: 'NaN',
    unstable: true,
    curve: null,
  },
  S: {
    law: 'studentt',
    quad: false,
    moments: { kind: 'robust', median: -0.007498872585, iqr: 1.6671425, meanOk: true, mass: 1 },
    mean: 0,
    unstable: false,
    curve: null,
  },
  L: {
    law: 'lognormal',
    quad: false,
    moments: { kind: 'exact', mean: 1.648721271, sd: 2.161197416, mass: 1 },
    mean: 1.648721271,
    unstable: false,
    curve: null,
  },
  A: {
    law: 'normal',
    quad: false,
    moments: { kind: 'exact', mean: 0, sd: 2.828427125, mass: 1 },
    mean: 0,
    unstable: false,
    curve: null,
  },
  B: {
    law: 'usum',
    quad: false,
    moments: { kind: 'exact', mean: 1.5, sd: 0.6454972244, mass: 1 },
    mean: 1.5,
    unstable: false,
    curve: { n: 522, atoms: [], area: 87 },
  },
  D: {
    law: 'chisquared',
    quad: true,
    moments: { kind: 'exact', mean: 1, sd: 1.414213562, mass: 1 },
    mean: 1,
    unstable: false,
    curve: null,
  },
  F: {
    law: null,
    quad: false,
    moments: { kind: 'estimate', mean: -3.614458993e-17, sd: 2.230984054, mass: 1 },
    mean: -3.614458993e-17,
    unstable: false,
    curve: { n: 1026, atoms: [], area: 28.25898999 },
  },
  H: {
    law: null,
    quad: false,
    moments: { kind: 'robust', median: 0.2602857996, iqr: 2.965204623, meanOk: false, mass: 1 },
    mean: 'NaN',
    unstable: true,
    curve: { n: 1026, atoms: [], area: 11.05056307 },
  },
  I: {
    law: null,
    quad: true,
    moments: { kind: 'estimate', mean: 0.3333333333, sd: 0.298142397, mass: 1 },
    mean: 0.3333333333,
    unstable: false,
    curve: { n: 1030, atoms: [], area: 521.8293363 },
  },
  J: {
    law: null,
    quad: false,
    moments: { kind: 'estimate', mean: 0.9999986779, sd: 1.156176714, mass: 1 },
    mean: 0.9999986779,
    unstable: false,
    curve: { n: 1026, atoms: [], area: 72.7559525 },
  },
  K: {
    law: null,
    quad: true,
    moments: { kind: 'estimate', mean: 0.3989422804, sd: 0.5838193701, mass: 1 },
    mean: 0.3989422804,
    unstable: false,
    curve: { n: 1028, atoms: [[0, 0.5]], area: 90.95044679 },
  },
  M: {
    law: null,
    quad: false,
    moments: { kind: 'estimate', mean: 1.16608437, sd: 0.6842846283, mass: 1 },
    mean: 1.16608437,
    unstable: false,
    curve: { n: 1028, atoms: [], area: 160.2997149 },
  },
  N: {
    law: 'cauchy',
    quad: false,
    moments: { kind: 'robust', median: 1.000191748, iqr: 2.000000147, meanOk: false, mass: 1 },
    mean: 'NaN',
    unstable: true,
    curve: null,
  },
  O: {
    law: null,
    quad: true,
    moments: { kind: 'robust', median: 1.000172633, iqr: 1.632993227, meanOk: true, mass: 1 },
    mean: 1,
    unstable: false,
    curve: { n: 1026, atoms: [], area: 27.52899831 },
  },
  Q: {
    law: null,
    quad: false,
    moments: { kind: 'estimate', mean: -7.047314121e-19, sd: 2.631573036, mass: 1 },
    mean: -7.047314121e-19,
    unstable: false,
    curve: { n: 1026, atoms: [], area: 26.91505343 },
  },
  R: {
    law: 'normal',
    quad: true,
    moments: { kind: 'exact', mean: 0, sd: 2, mass: 1 },
    mean: 0,
    unstable: false,
    curve: null,
  },
  W: {
    law: 'exponential',
    quad: true,
    moments: { kind: 'exact', mean: 1.5, sd: 1.5, mass: 1 },
    mean: 1.5,
    unstable: false,
    curve: null,
  },
  Z: {
    law: null,
    quad: true,
    moments: { kind: 'estimate', mean: 0.8221789587, sd: 0.3491508567, mass: 0.5 },
    mean: 0.8221789587,
    unstable: false,
    curve: { n: 1030, atoms: [], area: 131.4116123 },
  },
  'P(X > Y)': 0.3275527954,
  'P(F > 0.5)': 0.3128662109,
  'P(X < U < Y)': 0.4043655396,
  'P(K <= 0)': 0.5,
  'P(H > 2)': 0.1914596558,
  'exact P(0.5 < B < 1.5)': 0.4375,
  'exact P(A < 0)': 0.5,
};
