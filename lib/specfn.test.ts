import { describe, expect, it } from 'vitest';
import {
  BETA_LIMIT_SUM, T_NORMAL_DF, betaPQ, betaPdf, gammaPQ, gammaPdf, lgamma, lgammaHalfDiff, log1pmx, normalPQ,
  studentTPQ, studentTPdf, weibullPdf,
} from './specfn.ts';

/** |got − want| within `rel` of want (or `rel` absolutely, for want ≈ 0). */
const close = (got: number, want: number, rel = 1e-10): void => {
  expect(Math.abs(got - want)).toBeLessThanOrEqual(rel * Math.max(Math.abs(want), 1e-300) + 1e-300);
};

// Reference values: scipy.special / scipy.stats (1.17).
describe('lgamma', () => {
  it('matches reference values from tiny to huge arguments', () => {
    const refs: Array<[number, number]> = [
      [0.001, 6.907178885383853], [0.3, 1.0957979948180756], [0.5, 0.5723649429247],
      [2.5, 0.2846828704729192], [10, 12.801827480081469], [100.5, 361.43554046777757],
      [1e4, 82099.71749644238], [1e7, 151180949.36947393],
    ];
    for (const [x, want] of refs) close(lgamma(x), want, 1e-13);
    expect(Math.abs(lgamma(1))).toBeLessThan(1e-14);
    expect(Math.abs(lgamma(2))).toBeLessThan(1e-14);
    expect(lgamma(0)).toBe(Infinity);
    expect(lgamma(-3)).toBe(Infinity);
  });

  it('the half-step difference is continuous across its asymptotic switch', () => {
    close(lgammaHalfDiff(9999.999), lgamma(10000.499) - lgamma(9999.999), 1e-9);
    close(lgammaHalfDiff(1e4), lgammaHalfDiff(9999.9999), 1e-8);
    close(lgammaHalfDiff(3), lgamma(3.5) - lgamma(3), 1e-14);
    // Γ(z + ½)/Γ(z) → √z: the subtraction of two 1e13-sized logs would be noise.
    close(lgammaHalfDiff(1e12), 0.5 * Math.log(1e12), 1e-12);
  });

  it('log1pmx keeps its digits near zero', () => {
    close(log1pmx(1e-8), -5e-17 + 1e-24 / 3, 1e-12);
    close(log1pmx(0.29), Math.log1p(0.29) - 0.29, 1e-12);
    close(log1pmx(-0.29), Math.log1p(-0.29) + 0.29, 1e-12);
    close(log1pmx(2), Math.log(3) - 2, 1e-15);
  });
});

describe('gammaPQ', () => {
  const refs: Array<[number, number, number, number]> = [
    [0.5, 0.1, 0.34527915398142317, 0.6547208460185768],
    [0.5, 5, 0.9984345977419975, 0.0015654022580025482],
    [0.01, 1e-05, 0.8963367982671969, 0.10366320173280281],
    [0.01, 3, 0.9998670286434298, 0.00013297135657015539],
    [1, 1, 0.6321205588285577, 0.36787944117144245],
    [2.5, 0.3, 0.011996757205906261, 0.9880032427940937],
    [2.5, 10, 0.9987502694369687, 0.0012497305630313773],
    [10, 3, 0.0011024881301154815, 0.9988975118698845],
    [10, 30, 0.9999928782491372, 7.12175086281558e-06],
    [100, 80, 0.0171083130351331, 0.9828916869648668],
    [100, 100, 0.5132987982791487, 0.48670120172085135],
    [100, 150, 0.9999940754596646, 5.924540335483914e-06],
    [1000, 1100, 0.9989406767460701, 0.0010593232539299771],
    [1e5, 1e5 + 500, 0.9428967300239712, 0.057103269976028694],
    // Far tails (x ≫ a): the survival side must carry its own digits.
    [3, 60, 1, 1.629586652937817e-23],
    [0.2, 40, 1, 4.745472210763559e-20],
  ];
  it('matches reference values in both tails, a < 1 through a = 1e5', () => {
    for (const [a, x, p, q] of refs) {
      const [gp, gq] = gammaPQ(a, x);
      close(gp, p);
      close(gq, q);
    }
  });

  it('converges for astronomically large x instead of running out of iterations', () => {
    // The continued-fraction factor sits one ulp off 1 forever out here; a
    // tolerance below an ulp turned this into NaN (and a quantile table,
    // bisecting through e^345, into a column of NaN).
    expect(gammaPQ(1.5, 7.586674426930235e149)).toEqual([1, 0]);
    expect(gammaPQ(1.2, 1e300)).toEqual([1, 0]);
    expect(gammaPQ(0.3, 1e-300)[1]).toBeCloseTo(1, 12);
  });

  it('handles the edges', () => {
    expect(gammaPQ(2, 0)).toEqual([0, 1]);
    expect(gammaPQ(2, -1)).toEqual([0, 1]);
    expect(gammaPQ(2, Infinity)).toEqual([1, 0]);
    expect(gammaPQ(0, 1)[0]).toBeNaN();
    expect(gammaPQ(-1, 1)[0]).toBeNaN();
    expect(gammaPQ(NaN, 1)[0]).toBeNaN();
    expect(gammaPQ(1, NaN)[0]).toBeNaN();
  });
});

describe('betaPQ', () => {
  const refs: Array<[number, number, number, number, number]> = [
    [0.5, 0.5, 0.3, 0.36901011956554536, 0.6309898804344546],
    [0.1, 0.2, 0.01, 0.43249697421610594, 0.5675030257838942],
    [0.1, 0.2, 0.999, 0.9139598779614837, 0.08604012203851619],
    [2, 3, 0.4, 0.5247999999999999, 0.4752],
    [80, 120, 0.4, 0.5038417015242476, 0.49615829847575244],
    [80, 120, 0.5, 0.997772484414891, 0.002227515585109039],
    [80, 120, 0.3, 0.00138544759726767, 0.9986145524027323],
    // Very asymmetric, mirrored.
    [0.05, 500, 0.0001, 0.8822056986128245, 0.1177943013871754],
    [500, 0.05, 0.9999, 0.11779430138717997, 0.8822056986128199],
    [1, 1, 0.25, 0.25, 0.75],
    [5, 1, 0.9, 0.5904900000000001, 0.40951],
    [1e4, 2e4, 0.333, 0.4517928423812363, 0.5482071576187637],
    [30, 2, 0.5, 1.4901161193847656e-08, 0.9999999850988388],
    [0.5, 2.5, 1e-08, 0.00016976527178252864, 0.9998302347282175],
  ];
  it('matches reference values, a, b < 1 through 1e4', () => {
    for (const [a, b, x, p, q] of refs) {
      const [gp, gq] = betaPQ(a, b, x);
      // 1 − 0.9999 is not 0.0001 in binary: the mirrored row's x carries ~1e-13.
      const tol = a === 500 ? 1e-9 : 1e-10;
      close(gp, p, tol);
      close(gq, q, tol);
    }
  });

  it('satisfies I_x(a, b) = 1 − I_{1−x}(b, a) on both sides of the switch', () => {
    for (const [a, b] of [[0.3, 0.7], [2, 9], [40, 3], [150, 150]]) {
      for (const x of [0.001, 0.2, 0.5, 0.8, 0.999]) {
        const [p, q] = betaPQ(a, b, x, 1 - x);
        const [mp, mq] = betaPQ(b, a, 1 - x, x);
        close(p, mq, 1e-12);
        close(q, mp, 1e-12);
      }
    }
  });

  it('handles the edges', () => {
    expect(betaPQ(2, 3, 0)).toEqual([0, 1]);
    expect(betaPQ(2, 3, 1)).toEqual([1, 0]);
    expect(betaPQ(2, 3, -0.5)).toEqual([0, 1]);
    expect(betaPQ(2, 3, 1.5)).toEqual([1, 0]);
    expect(betaPQ(0, 3, 0.5)[0]).toBeNaN();
    expect(betaPQ(2, -1, 0.5)[0]).toBeNaN();
  });
});

describe('normalPQ and studentTPQ', () => {
  it('normalPQ is double precision in both tails', () => {
    const refs: Array<[number, number, number]> = [
      [-8, 6.22096057427174e-16, 0.9999999999999993], [-1, 0.15865525393145707, 0.8413447460685429],
      [0, 0.5, 0.5], [0.5, 0.6914624612740131, 0.3085375387259869],
      [3, 0.9986501019683699, 0.001349898031630093], [10, 1, 7.619853024160474e-24],
    ];
    for (const [z, p, q] of refs) {
      close(normalPQ(z)[0], p);
      close(normalPQ(z)[1], q);
    }
  });

  it('matches reference values for both signs of t, df < 1 through 1e9', () => {
    const refs: Array<[number, number, number, number]> = [
      [1, 0.5, 0.6475836176504333, 0.35241638234956674],
      [1, -3, 0.10241638234956672, 0.8975836176504333],
      [0.3, 2, 0.7178651505196088, 0.2821348494803913],
      [2, 40, 0.9996877926639076, 0.0003122073360923703],
      [5, -2.5, 0.027245049671188112, 0.9727549503288119],
      [5, 0, 0.5, 0.5],
      [30, 1.96, 0.9703288435519748, 0.029671156448025246],
      [1e6, 1.5, 0.9331926408816036, 0.06680735911839639],
      [1e6, -5, 2.8669989354453713e-07, 0.9999997133001065],
      [3e6, 2, 0.9772498230593416, 0.022750176940658437],
      [1e9, -4, 3.167124410823391e-05, 0.9999683287558918],
      [4, 1e5, 1, 2.9999999979999997e-20],
      [2.5, -1e3, 2.2747463948307453e-08, 0.9999999772525361],
    ];
    for (const [df, t, p, q] of refs) {
      const [gp, gq] = studentTPQ(df, t);
      close(gp, p, 1e-9);
      close(gq, q, 1e-9);
    }
  });

  it('is continuous across the normal-expansion switch and tends to the normal', () => {
    for (const t of [-6, -2, -0.3, 0.7, 3, 5]) {
      const below = studentTPQ(T_NORMAL_DF, t);
      const above = studentTPQ(T_NORMAL_DF * 1.0000001, t);
      close(above[0], below[0], 1e-8);
      close(above[1], below[1], 1e-8);
      close(studentTPQ(1e15, t)[0], normalPQ(t)[0], 1e-10);
    }
    expect(studentTPQ(3, Infinity)).toEqual([1, 0]);
    expect(studentTPQ(3, -Infinity)).toEqual([0, 1]);
    expect(studentTPQ(0, 1)[0]).toBeNaN();
  });
});

describe('densities', () => {
  it('match reference values, large parameters included', () => {
    close(gammaPdf(30, 50, 1), 0.00036813080120212124);
    close(gammaPdf(190, 100, 0.5), 0.018434335718067883); // ChiSquared(200)
    close(gammaPdf(0.2, 0.5, 3), 1.1992065834103995);
    close(gammaPdf(1e6 + 300, 1e6, 1), 0.00038127683239074693, 1e-9);
    close(betaPdf(0.41, 80, 120), 10.947687044308923);
    close(studentTPdf(1.2, 1e6), 0.1941859672888144);
    close(studentTPdf(1.2, 1e9), 0.19418605489551843);
    close(studentTPdf(-2, 3), 0.06750966066389291);
    close(weibullPdf(1.3, 2.5, 2), 0.4659573313431132);
  });

  it('are exactly 0 outside the support and under invalid parameters — never NaN', () => {
    for (const x of [-1, -1e-300, -Infinity]) {
      expect(gammaPdf(x, 2, 1)).toBe(0);
      expect(betaPdf(x, 2, 3)).toBe(0);
      expect(weibullPdf(x, 2, 1)).toBe(0);
    }
    expect(betaPdf(1.0000001, 2, 3)).toBe(0);
    for (const bad of [0, -1, NaN]) {
      expect(gammaPdf(1, bad, 1)).toBe(0);
      expect(gammaPdf(1, 1, bad)).toBe(0);
      expect(betaPdf(0.5, bad, 1)).toBe(0);
      expect(betaPdf(0.5, 1, bad)).toBe(0);
      expect(studentTPdf(0.5, bad)).toBe(0);
      expect(weibullPdf(0.5, bad, 1)).toBe(0);
      expect(weibullPdf(0.5, 1, bad)).toBe(0);
    }
    expect(gammaPdf(Infinity, 2, 1)).toBe(0);
    expect(studentTPdf(Infinity, 2)).toBe(0);
    expect(weibullPdf(1e300, 50, 1)).toBe(0); // (x/λ)^k overflows: still 0, not NaN
  });

  it('take the true boundary value: a pole, the finite limit, or 0', () => {
    expect(gammaPdf(0, 0.5, 2)).toBe(Infinity);
    expect(gammaPdf(0, 1, 2)).toBe(2);
    expect(gammaPdf(0, 3, 2)).toBe(0);
    expect(betaPdf(0, 0.5, 2)).toBe(Infinity);
    expect(betaPdf(0, 1, 4)).toBe(4);
    expect(betaPdf(0, 2, 4)).toBe(0);
    expect(betaPdf(1, 2, 0.5)).toBe(Infinity);
    expect(betaPdf(1, 4, 1)).toBe(4);
    expect(betaPdf(1, 2, 3)).toBe(0);
    expect(weibullPdf(0, 0.5, 2)).toBe(Infinity);
    expect(weibullPdf(0, 1, 2)).toBe(0.5);
    expect(weibullPdf(0, 3, 2)).toBe(0);
    // Just inside a pole the density is large and finite.
    expect(gammaPdf(1e-12, 0.5, 1)).toBeGreaterThan(1e5);
    expect(Number.isFinite(gammaPdf(1e-12, 0.5, 1))).toBe(true);
  });
});

describe('astronomically large parameters', () => {
  it('gammaPQ switches to the uniform expansion continuously', () => {
    for (const d of [-3, -0.5, 0, 0.7, 4]) {
      const a = 1e6;
      const below = gammaPQ(a, a + d * 1e3);
      const above = gammaPQ(a * (1 + 1e-12), a + d * 1e3);
      close(above[0], below[0], 1e-6);
      close(above[1], below[1], 1e-6);
    }
    const [p, q] = gammaPQ(1e13, 1e13);
    close(p, 0.5 + 1 / (3 * Math.sqrt(2 * Math.PI * 1e13)), 1e-9);
    close(p + q, 1, 1e-12);
    close(gammaPQ(1e9, 1e9 + 5e4)[1], 0.05692495616701592, 1e-6); // scipy gammaincc
  });

  it('betaPQ stays accurate where ln B would cancel, and past the fraction\'s reach', () => {
    close(betaPQ(1e12, 1e12, 0.5)[0], 0.5, 1e-9);
    close(betaPQ(1e8, 3e8, 0.25)[0], 0.5000076776477685, 1e-8);
    close(betaPQ(1e8, 3e8, 0.25005)[0], 0.9895370208077992, 1e-8); // scipy betainc
    close(betaPQ(3, 1e13, 2.6740603137235617e-13)[0], 0.5, 1e-6);
    close(betaPQ(1e13, 3, 1 - 2.6740603137235617e-13, 2.6740603137235617e-13)[1], 0.5, 1e-6);
    // Continuous across the switch to the limit laws, in each of their regimes:
    // both huge (skew-corrected normal), and one side modest (a Gamma law).
    for (const [a, b, xs] of [
      [5e9, 5e9 - 1, [0.49999, 0.5, 0.500012]], [8e9, 2e9 - 1, [0.79999, 0.8, 0.800009]],
      [3, 1e10 - 4, [5e-11, 2.674e-10, 9e-10]], [4e4, 1e10 - 5e4, [3.98e-6, 4e-6, 4.03e-6]],
    ] as Array<[number, number, number[]]>) {
      for (const x of xs) {
        const below = betaPQ(a, b, x);
        const above = betaPQ(a, b + 2, x);
        expect(a + b).toBeLessThan(BETA_LIMIT_SUM);
        expect(Math.abs(above[0] - below[0]), `${a}, ${b} at ${x}`).toBeLessThan(2e-5);
        expect(Math.abs(above[1] - below[1]), `${a}, ${b} at ${x}`).toBeLessThan(2e-5);
        close(above[0] + above[1], 1, 1e-12);
      }
    }
  });
});

describe('far tails keep the digits of a tiny x or an exactly supplied y', () => {
  it('betaPQ through the mode-centred kernel (a, b ≥ 20)', () => {
    close(betaPQ(30, 25, 1e-6)[0], 1.402626984044898e-165, 1e-12); // scipy betainc
    close(betaPQ(25, 30, 1 - 1e-6, 1e-6)[1], 1.402626984044898e-165, 1e-12);
    close(betaPQ(40, 60, 1e-3)[0], 7.786186344728064e-93, 1e-12);
    close(betaPQ(60, 40, 0.999, 1e-3)[1], 7.786186344728064e-93, 1e-12);
    close(betaPQ(80, 120, 0.4)[0], 0.5038417015242476, 1e-11); // and the bulk is unchanged
  });

  it('the Student t tail, which hands betaPQ its small side exactly', () => {
    close(studentTPQ(60, 40)[1], 2.8777402433136914e-45, 1e-10);
    close(studentTPQ(60, -40)[0], 2.8777402433136914e-45, 1e-10);
    close(studentTPQ(7, 1e6)[1], 1.3205206763259189e-40, 1e-9);
  });
});
