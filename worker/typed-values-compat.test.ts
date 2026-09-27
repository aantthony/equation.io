import { compileCpu, type CpuPlan } from '../lib/compiler.ts';
import { describe, expect, it } from 'vitest';
import { type Expr, evaluate, freeVars } from '../lib/expr.ts';
import { classify, publicKind } from '../lib/plot.ts';
import { analyze } from './graph.ts';
import { PUBLIC_KIND_ROWS } from './typed-values.fixtures.ts';

function successful(rows: string[]) {
  const analysis = analyze(rows);
  expect(
    analysis.rows.map(r => r.error),
    rows.join('; '),
  ).toEqual(rows.map(() => undefined));
  return analysis;
}

/** Check executable CPU payloads, not just kind snapshots or generated GLSL. */
function numbers(plot: CpuPlan, env: Record<string, number>): number[] {
  let expressions: Expr[];
  switch (plot.type) {
    case 'value':
      expressions = [plot.expr];
      break;
    case 'point':
    case 'trail':
    case 'label':
      expressions = plot.coords;
      break;
    case 'polygon':
      expressions = plot.pts;
      break;
    case 'pcurve':
    case 'vfield2d':
    case 'vfield3d':
      expressions = plot.comps;
      break;
    case 'vlist':
      expressions = plot.values;
      break;
    case 'plist':
      expressions = plot.pts.flat();
      break;
    default:
      throw new Error(`No numeric fixture projection for ${plot.type}`);
  }
  return expressions.map(e => evaluate(e, env));
}

describe('typed-values public kind baseline', () => {
  it.each(Object.entries(PUBLIC_KIND_ROWS))('%s keeps its public string', (kind, rows) => {
    const a = successful(rows);
    expect(publicKind(a.rows.at(-1)!.cls!.object)).toBe(kind);
  });

  it('covers all 41 kinds, keeping packed lists and scatters distinct', () => {
    const values = new Float64Array([1, 2, 3]);
    const ys = new Float64Array([4, 5, 6]);
    const column: Expr = { kind: 'data', values };
    const listObject = classify(column);
    const list = compileCpu(listObject);
    const scatterObject = classify({ kind: 'vec', items: [column, { kind: 'data', values: ys }] });
    const scatter = compileCpu(scatterObject);
    expect(publicKind(listObject.object)).toBe('dlist');
    expect(publicKind(scatterObject.object)).toBe('dscatter');
    expect(list.type === 'dlist' && list.values).toBe(values);
    expect(scatter.type === 'dscatter' && scatter.coords[0]).toBe(values);
    expect(scatter.type === 'dscatter' && scatter.coords[1]).toBe(ys);
    expect(Object.keys(PUBLIC_KIND_ROWS).length + 2).toBe(41);
  });
});

interface CallFixture {
  calls: string[];
  setup?: string[];
  kind: CpuPlan['type'];
  values: number[];
}

// This inventory intentionally includes the old flatten-and-ignore behavior.
// Rejecting unary tuples is a separate, breaking follow-up to the migration.
const CALLS: CallFixture[] = [
  { calls: ['segment((0,0),(1,1))', 'segment(0,0,1,1)'], kind: 'polygon', values: [0, 0, 1, 1] },
  { calls: ['vector((0,0),(1,1))', 'vector(0,0,1,1)'], kind: 'polygon', values: [0, 0, 1, 1] },
  { calls: ['polyline((0,0),(1,1),(2,0))', 'polyline(0,0,1,1,2,0)'], kind: 'polygon', values: [0, 0, 1, 1, 2, 0] },
  { calls: ['polygon((0,0),(1,1),(2,0))', 'polygon(0,0,1,1,2,0)'], kind: 'polygon', values: [0, 0, 1, 1, 2, 0] },
  { calls: ['segment((0,0,1),(1,1,2))'], kind: 'polygon', values: [0, 0, 1, 1, 1, 2] },
  { calls: ['dot((1,2),(3,4))', 'dot(1,2,3,4)'], kind: 'value', values: [11] },
  { calls: ['dot((1,2,3),(4,5,6))'], kind: 'value', values: [32] },
  { calls: ['cross((1,0,0),(0,1,0))'], kind: 'point', values: [0, 0, 1] },
  { calls: ['distance((0,0),(3,4))', 'distance(0,0,3,4)'], kind: 'value', values: [5] },
  { calls: ['angle((1,0),(0,1))', 'angle(1,0,0,1)'], kind: 'value', values: [Math.PI / 2] },
  { calls: ['midpoint((1,2),(3,4))', 'midpoint(1,2,3,4)'], kind: 'point', values: [2, 3] },
  { calls: ['perp((1,2))', 'perp(1,2)'], kind: 'point', values: [-2, 1] },
  { calls: ['unit((3,4))', 'unit(3,4)'], kind: 'point', values: [0.6, 0.8] },
  { calls: ['rotate((1,2),0)', 'rotate(1,2,0)'], kind: 'point', values: [1, 2] },
  { calls: ['rotate((2,1),pi/2,(1,1))', 'rotate(2,1,pi/2,1,1)'], kind: 'point', values: [1, 2] },
  { calls: ['rotate((1,0,0),pi/2,(0,0,1))', 'rotate(1,0,0,pi/2,0,0,1)'], kind: 'point', values: [0, 1, 0] },
  {
    calls: ['tube((u,2u,3u))', 'tube(u,2u,3u)', 'tube((u,2u,3u),0.2)', 'tube(u,2u,3u,0.2)'],
    kind: 'pcurve',
    values: [0.5, 1, 1.5],
  },
  { setup: ['M = ((2,0),(0,4))'], calls: ['solve(M,(6,8))', 'solve(M,6,8)'], kind: 'point', values: [3, 2] },
  { calls: ['abs(-3)'], kind: 'value', values: [3] },
  { calls: ['abs((3,4))', 'abs(3,4)', 'abs(A)'], setup: ['A = (3,4)'], kind: 'value', values: [5] },
  { calls: ['abs((2,3,6))', 'abs(2,3,6)'], kind: 'value', values: [2] },
  { calls: ['abs(A)'], setup: ['A = (2,3,6)'], kind: 'value', values: [7] },
  { calls: ['sin((1,2))', 'sin(1,2)'], kind: 'value', values: [Math.sin(1)] },
  { calls: ['ln((2,3))', 'ln(2,3)'], kind: 'value', values: [Math.log(2)] },
  { calls: ['atan2((1,2))', 'atan2(1,2)'], kind: 'value', values: [Math.atan2(1, 2)] },
  { calls: ['max((1,2),3)', 'max(1,(2,3))'], kind: 'value', values: [3] },
  { calls: ['max((1,2),(3,4))'], kind: 'value', values: [4] },
  { calls: ['min((3,2),1)', 'min(3,(2,1))'], kind: 'value', values: [1] },
  {
    setup: ['f(x,y,z) = x + 10y + 100z'],
    calls: ['f(1,2,3)', 'f((1,2),3)', 'f(1,(2,3))', 'f((1,2,3))'],
    kind: 'value',
    values: [321],
  },
  { setup: ['gamma(x,y) = x + y'], calls: ['gamma((1,2))', 'gamma(1,2)'], kind: 'value', values: [3] },
  { setup: ['gamma = 2'], calls: ['gamma(3)'], kind: 'value', values: [6] },
  { setup: ['open(x,y) = x + y'], calls: ['open((1,2))', 'open(1,2)'], kind: 'value', values: [3] },
  { setup: ['P(x,y) = x + y', 'E(x,y) = x y'], calls: ['P((1,2))', 'E((1,3))'], kind: 'value', values: [3] },
  { calls: ['sum(n=1..3,n)'], kind: 'value', values: [6] },
  { calls: ['sum(n=1..3,(n,99))'], kind: 'point', values: [6, 297] },
  { calls: ['prod(n=1..3,n)'], kind: 'value', values: [6] },
  { calls: ['int(0..1,x dx)'], kind: 'value', values: [0.5] },
];

describe('call-shape compatibility before preserving tuple syntax', () => {
  for (const fixture of CALLS) {
    it.each(fixture.calls)('%s keeps its numerical meaning', call => {
      const a = successful([...(fixture.setup ?? []), call]);
      const p = a.rows.at(-1)!.cpu!;
      expect(publicKind(a.rows.at(-1)!.cls!.object)).toBe(fixture.kind);
      const actual = numbers(p, { ...a.constEnv, t: 0, u: 0.5 });
      expect(actual).toHaveLength(fixture.values.length);
      actual.forEach((v, i) => expect(v).toBeCloseTo(fixture.values[i], 10));
      if (p.type === 'pcurve') expect(evaluate(p.tube!, {})).toBe(call.includes('0.2') ? 0.2 : 0.1);
      if (p.type === 'polygon') {
        expect(p.closed).toBe(call.startsWith('polygon'));
        expect(!!p.arrow).toBe(call.startsWith('vector'));
      }
    });
  }

  it('preserves scalar-pair circles and their residuals', () => {
    const plots = ['circle((0,0),2)', 'circle(0,0,2)'].map(call => successful([call]).rows[0]);
    expect(plots[0].cls).toEqual(plots[1].cls);
    expect(plots[0].cpu!.type).toBe('implicit2d');
    const cpu = plots[0].cpu!;
    if (cpu.type !== 'implicit2d') throw new Error('Expected circle');
    const e = cpu.equation;
    if (e.kind !== 'eq') throw new Error('Expected a circle equation');
    expect(evaluate(e.l, { x: 2, y: 0 }) - evaluate(e.r, {})).toBe(0);
    expect(evaluate(e.l, { x: 0, y: 0 }) - evaluate(e.r, {})).toBe(-4);
  });

  it('keeps distribution tuple arguments and exact readouts', () => {
    const a = successful(['X ~ Normal((0,1))', 'P(X < 0)', 'E(X)']);
    expect(a.rows[1].info).toBe('≈ 0.5000');
    expect(a.rows[2].info).toContain('0');
    const b = successful(['X ~ Binomial((4,0.5))', 'P(X <= 2)', 'E(X)']);
    expect(b.rows[1].info).toBe('≈ 0.6875');
    expect(b.rows[2].info).toContain('2');
  });

  it('does not spread a named point among scalar arguments or into scalar builtins', () => {
    const a = analyze(['A = (1,2)', 'F(x,y,z) = x+y+z', 'atan2(A)', 'F(A,3)']);
    expect(a.rows[2].error).toBe('atan2 is not defined for points.');
    expect(a.rows[3].error).toBe('F takes 3 arguments.');
  });
});

describe('typed-values semantic edge baseline', () => {
  it('keeps deferred computed-point components zipped through function composition', () => {
    const setup = ['f(x,y) = (x+y/2,y)', 'A = (1,2)', 'B = (3,4)', 'J = ((0,-1),(1,0))'];
    for (const [call, expected] of [
      ['f(J A)', [-1.5, 1]],
      ['f(A+A)', [4, 4]],
      ['f(midpoint(A,B))', [3.5, 3]],
      ['f(f(A))', [3, 2]],
      ['f(f([A,B]))', [3, 2, 7, 4]],
    ] as const) {
      const a = successful([...setup, call]);
      expect(numbers(a.rows.at(-1)!.cpu!, a.constEnv)).toEqual(expected);
    }
  });

  it('keeps alias parameters live on the CPU and stable in shaders', () => {
    const make = (x: number) => successful([`A = (${x},2)`, 'A', 'y = A_x x + A_y']);
    const a = make(1),
      b = make(5);
    const point = a.rows[1].cpu!;
    expect(numbers(point, a.constEnv)).toEqual([1, 2]);
    expect(numbers(point, b.constEnv)).toEqual([5, 2]);
    if (point.type !== 'point') throw new Error('Expected point');
    expect(point.coords.map(c => [...freeVars(c)])).toEqual([['A_x'], ['A_y']]);
    expect(a.rows[2].cls).toEqual(b.rows[2].cls);
    expect(a.rows[2].cls!.params).toEqual(['A_x', 'A_y']);
  });

  it('distinguishes real complex projections, complex points, paths and equations', () => {
    const a = successful(['re(w)', 're(w)=0', 'w^2=1', '1+2i', 'exp(i pi u)']);
    expect(a.rows.map(r => publicKind(r.cls!.object))).toEqual(['scalar2d', 'implicit2d', 'system', 'point', 'pcurve']);
    expect(numbers(a.rows[3].cpu!, {})).toEqual([1, 2]);
    const path = numbers(a.rows[4].cpu!, { u: 0.5 });
    expect(path[0]).toBeCloseTo(0, 10);
    expect(path[1]).toBeCloseTo(1, 10);
    const system = a.rows[2].cpu!;
    if (system.type !== 'system') throw new Error('Expected complex roots');
    expect(system.complexEquation).toBeDefined();
    for (const x of [-1, 1]) {
      for (const residual of system.residuals) expect(evaluate(residual, { x, y: 0 })).toBeCloseTo(0, 10);
    }
  });

  it('shares the browser rule for function level sets and exact duplicates', () => {
    const duplicate = analyze(['f(x,y)=x+y', 'f(x,y)=x+y']);
    expect(duplicate.rows[0].error).toBeUndefined();
    expect(duplicate.rows[1].error).toBe('f is already defined.');
    const level = successful(['f(x,y)=x+y', 'f(x,y)=2']);
    expect(level.rows[1].cpu!.type).toBe('implicit2d');
    const cpu = level.rows[1].cpu!;
    if (cpu.type !== 'implicit2d') throw new Error('Expected level set');
    expect(evaluate(cpu.residual, { x: 0.5, y: 1.5 })).toBe(0);
    // Coordinate-field duplicates already behave as level-set plots.
    const a = successful(['r=sqrt(x^2+y^2)', 'r=2']);
    expect(a.rows[1].cpu!.type).toBe('implicit2d');
  });
});
