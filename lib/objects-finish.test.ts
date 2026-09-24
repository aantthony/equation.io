import { evaluateFrame } from './env.ts';
import { describe, expect, it } from 'vitest';
import { analyze } from '../worker/graph.ts';
import { canRenderOg, renderRaster } from '../worker/og.ts';
import { evaluate, parseExpr } from './expr.ts';

import { fieldEvaluator, FLOW_GLYPH_N, FLOW_SEEDS, FLOW_STEPS, streamline, traceField } from './flow.ts';
import { traceIntersection, INTERSECTION_BRANCHES, INTERSECTION_STEPS } from './intersection.ts';
import { certifySystem, nextFloat, iadd, imul } from './certify.ts';
import { complexRootLabel } from './complex-label.ts';

const runRows = (rows: string[]) => {
  const a = analyze(rows);
  expect(a.rows.map(r => r.error)).toEqual(rows.map(() => undefined));
  return a;
};
const last = (rows: string[]) => runRows(rows).rows.at(-1)!;
const exprs = (s: string[]) => s.map(e => parseExpr(e));

describe('3D objects across definition, analysis and rendering', () => {
  it('preserves tuple dimensions, component dependencies, cross products and unsigned angles', () => {
    const a = runRows([
      'h=3',
      'A=(1,0,h)',
      'B=(0,1,0)',
      'C=cross(A,B)',
      'D=midpoint(A,B)',
      'A_z',
      'angle(A,B)',
      'segment(A,B)',
      'vector((0,0,0),C)',
      'polygon(A,B,C)',
    ]);
    expect(a.constEnv.C_x).toBe(-3);
    expect(a.constEnv.C_z).toBe(1);
    expect(a.constEnv.D_z).toBe(1.5);
    expect(a.rows[5].info).toBe('= 3');
    expect(a.rows[6].info).toBe('≈ 1.5708');
    for (const r of a.rows.slice(7))
      expect({ cls: r.cls, cpu: r.cpu }).toMatchObject({ cls: { needs3D: true }, cpu: { type: 'polygon', dim: 3 } });
    const bad = analyze(['A=(1,2,3)', 'perp(A)', 'angle(A,(1,2))']);
    expect(bad.rows[1].error).toMatch(/2D/);
    expect(bad.rows[2].error).toMatch(/matching dimensions/);
    const zero = runRows(['angle((0,0,0),(1,0,0))']).rows[0].cpu!;
    expect(zero.type).toBe('value');
    if (zero.type === 'value') expect(evaluate(zero.expr, {})).toBeNaN();
  });
  it('lowers a 3D chart by its Jacobian, including time-dependent chart drift', () => {
    const a = runRows(['r=sqrt(x^2+y^2)', 'theta=atan2(y,x)', "(r',theta',z')=(0,1,2)"]);
    const p = a.rows.at(-1)!.cpu!;
    expect(p.type).toBe('vfield3d');
    if (p.type === 'vfield3d') expect(fieldEvaluator(p.comps)([2, 0, 0])).toEqual([0, 2, 2]);
    const moving = last(['q=x+t', "(q',y',z')=(0,0,0)"]).cpu!;
    if (moving.type === 'vfield3d') expect(fieldEvaluator(moving.comps, { t: 4 })([2, 0, 0])).toEqual([-1, 0, 0]);
    const f = fieldEvaluator(exprs(['x', 'y']));
    const u = f([1, 2]),
      v = f([3, 4]);
    expect(u).toEqual([1, 2]);
    expect(v).toEqual([3, 4]);
    const h = 1e-6,
      fa = f([2 + h, 0]),
      fb = f([2 - h, 0]);
    expect((fa[0] - fb[0]) / (2 * h)).toBeCloseTo(1);
  });
  it('traces normalized fields in either dimension with deterministic work bounds', () => {
    const p = streamline(v => [-v[1], v[0]], [1, 0], 0.01, [-2, -2], [2, 2], 100);
    expect(p.length).toBe(201);
    expect(Math.max(...p.map(v => Math.abs(Math.hypot(...v) - 1)))).toBeLessThan(1e-7);
    const comps = exprs(['-y', 'x', '0']);
    const paths = traceField(comps, [-2, -2, -2], [2, 2, 2]);
    expect(paths).toEqual(traceField(comps, [-2, -2, -2], [2, 2, 2]));
    expect(paths.length).toBe(FLOW_SEEDS);
    expect(paths.every(p => p.length <= 2 * FLOW_STEPS + 1)).toBe(true);
    const glyphs = traceField(comps, [-2, -2, -2], [2, 2, 2], {}, true);
    expect(glyphs.length).toBeLessThanOrEqual(FLOW_GLYPH_N ** 3);
    expect(glyphs.length).toBeGreaterThan(FLOW_GLYPH_N ** 2);
    expect(glyphs.every(p => p.length === 2)).toBe(true);
    expect(traceField(exprs(['1', '0', '0']), [-1, -1, -1], [1, 1, 1], {}, true).length).toBe(FLOW_GLYPH_N ** 3);
    expect(traceField(exprs(['0', '0', '0']), [-1, -1, -1], [1, 1, 1], {}, true)).toEqual([]);
  });
});

describe('object families and sequence values', () => {
  it('shares shader source across zipped members and uses per-draw uniforms', () => {
    for (const row of [
      'y=[1,2,3]x',
      'x^2+y^2=[1,4,9]',
      'circle((0,0),[1,2,3])',
      'x<[1,2,3]',
      'revolve([1,2,3]x)',
      '(u,v,[1,2,3]u v)',
      '([1,2,3]y,-x)',
    ]) {
      const p = last([row]).gpu!;
      expect(p.type, row).toBe('family');
      if (p.type !== 'family') continue;
      expect(p.members.length).toBe(3);
      expect(new Set(p.members.map(m => JSON.stringify({ ...m, uniforms: undefined }))).size, row).toBe(1);
      expect(p.members.map(m => Object.values(m.uniforms!)[0])).toEqual([0, 1, 2]);
      expect(p.members[0].params.every(n => !('u_' + n).includes('__'))).toBe(true);
    }
  });
  it('supports point lists, named arithmetic, paths and CPU families', () => {
    const a = runRows([
      'P=[(0,0),(1,1),(2,0)]',
      'Q=P+(2,3)',
      'Q',
      'polyline(Q)',
      'polygon(P)',
      'distance(P[1],P[2])',
      'segment((0,0),([1,2,3],1))',
      '(cos(u),sin(u),[1,2,3])',
    ]);
    expect(a.rows[2].cpu!.type).toBe('plist');
    expect(a.rows[3].cpu!.type).toBe('polygon');
    expect(a.rows[5].info).toBe('≈ 1.41421');
    expect(a.rows[6].cpu!.type).toBe('family');
    expect(a.rows[7].cls!.needs3D).toBe(true);
    expect(last(['P=([1..100],0)', 'P+(1,1)']).cpu!.type).toBe('plist');
    expect(last(['s=x^2', '[1,2]s']).cpu!.type).toBe('family');
  });
  it('crosses independent lists and zips every use of the same one', () => {
    const pts = (rows: string[]) => {
      const p = last(rows).cpu!;
      if (p.type !== 'plist') throw new Error(p.type);
      return p.pts.map(pt => pt.map(c => evaluate(c, {})).join());
    };
    expect(pts(['([0,1],[0,1],[0,1])'])).toEqual([
      '0,0,0',
      '0,0,1',
      '0,1,0',
      '0,1,1',
      '1,0,0',
      '1,0,1',
      '1,1,0',
      '1,1,1',
    ]);
    expect(pts(['a=[0,1]', '(a,a,a)'])).toEqual(['0,0,0', '1,1,1']);
    expect(pts(['s=[1..3]', 'q=s^2', '(s,q)'])).toEqual(['1,1', '2,4', '3,9']);
    expect(pts(['a=[0,1]', 'b=[5,6,7]', '(a,b)'])).toHaveLength(6);
    expect(pts(['a=[1..4]', '(a[a>2],a[a>2]^2)'])).toEqual(['3,9', '4,16']);
    expect(pts(['a_n=2n', 'n=[1..3]', '(n,a_[n])'])).toEqual(['1,2', '2,4', '3,6']);
    const family = (rows: string[]) => {
      const p = last(rows).cpu!;
      return p.type === 'family' ? p.members.length : 0;
    };
    expect(family(['y=[1,2]x+[1,2,3]'])).toBe(6);
    expect(family(['m=[1,2]', 'y=m x+m'])).toBe(2);
    expect(family(['(cos(u),sin(u),[1,2,3])'])).toBe(3);
    expect(family(['circle(([0,1],[0,1]),[1,2])'])).toBe(8);
  });
  it('builds regular figures from a list of turns', () => {
    const pts = (rows: string[]) => {
      const a = runRows(rows);
      const p = a.rows.at(-1)!.cpu!;
      if (p.type !== 'plist') throw new Error(p.type);
      return p.pts.map(pt => pt.map(c => +evaluate(c, a.constEnv).toFixed(3)).join());
    };
    expect(pts(['J=[(0,-1),(1,0)]', 'th=2pi [0..3]/4', 'e^(th J) (1,0)'])).toEqual(['1,0', '0,1', '-1,0', '0,-1']);
    // One literal written into every output component is still one list: the
    // icosahedron is 3 turns × 2 × 2 = 12 vertices, all at the same radius.
    const ico = pts(['phi=(1+sqrt(5))/2', 'k=2pi [0..2]/3', 'e^(k cross((1,1,1)/sqrt(3))) (0,[-1,1],[-phi,phi])']);
    expect(new Set(ico).size).toBe(12);
    expect(ico).toEqual(pts(['phi=(1+sqrt(5))/2', 'k=2pi [0..2]/3', 'rotate((0,[-1,1],[-phi,phi]),k,(1,1,1))']));
    expect(last(['th=2pi [0..4]/5', 'polygon(rotate((1,0),th))']).cpu!).toMatchObject({ type: 'polygon' });
    const spokes = last(['th=2pi [0..4]/5', 'segment((0,0),rotate((1,0),th))']).cpu!;
    expect(spokes.type === 'family' && spokes.members.length).toBe(5);
  });
  it('draws a whole lattice of arrows: figure families are CPU-cheap, so their cap is 1024', () => {
    const arrows = last(['a=[0..20]', 'b=[0..20]', 'f(x,y)=(x+y/2,y+sin(x)/2)', 'vector((a,b),f(a,b))']).cpu!;
    expect(arrows.type === 'family' && arrows.members.length).toBe(441);
    expect(arrows.type === 'family' && arrows.members[0].cpu).toMatchObject({ type: 'polygon', arrow: true });
    const space = last(['a=[0..3]', 'b=[0..3]', 'segment((a,b,0),(a,b,1+a b/4))']).cpu!;
    expect(space.type === 'family' && space.members.length).toBe(16);
    expect(analyze(['a=[0..40]', 'b=[0..40]', 'segment((a,b),(a+1,b))']).rows[2].error).toMatch(
      /1–1024 members \(got 1681\)/,
    );
  });
  it('enforces member and dimension limits before rendering', () => {
    for (const [row, pattern] of [
      ['y=[1..33]x', /32/],
      ['revolve([1..9]x)', /8/],
      ['y=[1..6]x+[1..6]', /32/],
      ['total([1..1000]+[1..1000])', /1000000 combinations/],
      ['domain([w,w^2])', /select a list element/],
      ['y=[1,(2,3)]', /point|number|mix/],
    ] as const)
      expect(analyze([row]).rows[0].error, row).toMatch(pattern);
  });
  it('reads explicit and recurrence terms in statistics, regressions and shader uniforms', () => {
    const a = runRows(['a_n=2n', 'X=a_[1..4]', 'Y=2X+1', 'Y~m X+b', 'a_3']);
    expect(a.constEnv.m).toBeCloseTo(2);
    expect(a.constEnv.b).toBeCloseTo(1);
    expect(a.rows[4].info).toBe('= 6');
    const r = runRows(['r=2', 'a_0=.2', 'a_{n+1}=r a_n', 'a_3', 'a_[0..5]', 'y=a_3 x']);
    expect(r.rows[3].info).toBe('= 1.6');
    const env = evaluateFrame(r.defs, 0);
    expect(env.eqioSeq_a_5).toBeCloseTo(6.4);
    expect([...r.defs.consts].filter(([k]) => k.startsWith('eqioSeq_')).length).toBe(6);
    expect(last(['a_{n+1}=a_n+t', 'a_3']).cpu!.type).toBe('value');
    expect(analyze(['a_n=n', 'a_[1001]']).rows[1].error).toMatch(/0 to 1000/);
    // A sum up to the index is a number once a concrete term is named.
    const tri = runRows(['a_n=Σ(s=1..n, s)', 'a_5', 'y=a_4']);
    expect(tri.rows[1].info).toBe('= 15');
    const curve = tri.rows[2].gpu!;
    expect(curve.type).toBe('implicit2d');
    if (curve.type === 'implicit2d') expect(curve.field).toContain('10');
  });
});

describe('solver extensions and comparison notes', () => {
  it('follows a closed surface intersection without leaving either constraint', () => {
    const paths = traceIntersection(exprs(['x^2+y^2+z^2-9', 'z-1']), [-4, -4, -4], [4, 4, 4]);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.length).toBeLessThanOrEqual(INTERSECTION_BRANCHES);
    expect(paths.every(p => p.length <= 2 * INTERSECTION_STEPS + 1)).toBe(true);
    for (const p of paths.flat()) {
      expect(p[2]).toBeCloseTo(1, 8);
      expect(p[0] ** 2 + p[1] ** 2 + p[2] ** 2).toBeCloseTo(9, 7);
    }
    expect(paths.some(p => Math.hypot(...p[0].map((v, k) => v - p.at(-1)![k])) < 0.1)).toBe(true);
    // min has no symbolic Jacobian, so this is the finite-difference fallback.
    const fd = traceIntersection(exprs(['min(x^2+y^2+z^2,100)-9', 'z-1']), [-4, -4, -4], [4, 4, 4]);
    expect(fd.length).toBeGreaterThan(0);
    for (const p of fd.flat()) {
      expect(p[2]).toBeCloseTo(1, 5);
      expect(p[0] ** 2 + p[1] ** 2 + p[2] ** 2).toBeCloseTo(9, 4);
    }
  });
  it('labels rational and quadratic complex roots exactly and keeps an algebraic fallback', () => {
    expect(complexRootLabel(parseExpr('w^3=1'), [-0.5, Math.sqrt(3) / 2], {})).toBe('-1/2 + √3/2 i');
    expect(complexRootLabel(parseExpr('w^2+1=0'), [0, 1], {})).toBe('i');
    expect(complexRootLabel(parseExpr('(w^2+1)(w^2+4)=0'), [0, -2], {})).toBe('-2 i');
    expect(complexRootLabel(parseExpr('w^5+w+1=0'), [0, 1], {})).toMatch(/^root of/);
    expect(complexRootLabel(parseExpr('sin(w)=1'), [0, 1], {})).toBeUndefined();
  });
  it('rounds intervals outward and never treats an unsupported or singular system as complete', () => {
    expect(nextFloat(1, true)).toBeGreaterThan(1);
    expect(nextFloat(1, false)).toBeLessThan(1);
    expect(iadd([0.1, 0.1], [0.2, 0.2])[0]).toBeLessThanOrEqual(0.3);
    expect(imul([-2, 3], [-4, 5])).toEqual([nextFloat(-12, false), nextFloat(15, true)]);
    const linear = certifySystem(exprs(['x-1', 'y-2']), ['x', 'y'], [-3, -3], [3, 3]);
    expect(linear.complete).toBe(true);
    expect(linear.roots).toEqual([[1, 2]]);
    const two = certifySystem(exprs(['x^2-1', 'y']), ['x', 'y'], [-3, -3], [3, 3]);
    expect(two.complete).toBe(true);
    expect(two.roots.length).toBe(2);
    expect(certifySystem(exprs(['x^2+1', 'y']), ['x', 'y'], [-3, -3], [3, 3]).complete).toBe(true);
    for (const fs of [
      ['sin(x)', 'y'],
      ['x^2', 'y'],
      ['x+0*(1/0)', 'y'],
    ]) {
      const proof = certifySystem(exprs(fs), ['x', 'y'], [-1, -1], [1, 1], {}, 64);
      expect(proof.complete, fs.join()).toBe(false);
      expect(proof.visited).toBeLessThanOrEqual(64);
      expect(proof.unresolved).toBeGreaterThan(0);
    }
  });
  it('reads decided comparisons instead of drawing degenerate curves', () => {
    const a = runRows(['2+2=4', 'e=2', '1<2<3', 'a=2', 'a+1=3']);
    expect(a.rows[0].info).toBe('Always true (4 = 4)');
    expect(a.rows[1].info).toMatch(/^Never true/);
    expect(a.rows[2].info).toMatch(/^Always true/);
    expect(runRows(['2=[1,2]']).rows[0].info).toMatch(/Never true.*Always true/);
    // Repeated constant definitions still follow definition ownership.
  });
  it('explains a slider named after a constant or d', () => {
    // Still a claim about e, but one that says why no slider appeared.
    const [e, tau, pi] = runRows(['e = 0.6', 'tau = 1', 'pi = pi']).rows;
    expect(e.info).toBe('Never true (2.71828 ≠ 0.6) — e is a constant; name a slider something else');
    expect(tau.info).toMatch(/— tau is a constant/);
    expect(pi.info).toBe('Always true (3.14159 = 3.14159)');
    // `d` starts d/dx: the definition row itself says so, as a function too.
    for (const row of ['d = 1', 'd(x) = x^2']) {
      expect(analyze([row]).rows[0].error, row).toMatch(/^d is taken by derivatives/);
    }
    // Derivatives and names merely starting with d are unaffected.
    const ok = runRows(['dx = 1', 'y = d/dx (x^2)', 'y = d^2/dx^2 (x^3)']).rows;
    expect(ok.map(r => r.error)).toEqual([undefined, undefined, undefined]);
  });
  it('has real preview paths or explicit fallback for new objects', () => {
    for (const rows of [
      ['A=(1,2,3)', 'vector(A)'],
      ["(x',y',z')=(-y,x,0)"],
      ['y=[1,2,3]x'],
      ['(x^2+y^2+z^2,z)=(9,1)'],
    ]) {
      expect(canRenderOg(rows), rows.join()).toBe(true);
      const r = renderRaster(rows, 160, 120);
      expect(r.px.some(v => v < 100)).toBe(true);
    }
    const one = renderRaster(['y=x'], 160, 120),
      family = renderRaster(['y=[1,2,3]x'], 160, 120);
    expect(family.px).not.toEqual(one.px);
  });
});
