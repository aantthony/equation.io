import { describe, expect, it } from 'vitest';
import { Env, evaluateFrame, lookupValue, lowerValueRef, scalarDefinitions } from './env.ts';
import { type Expr, parseExpr } from './expr.ts';
import { RVSystem } from './dist.ts';

const n = (value: number): Expr => ({ kind: 'num', value });
describe('canonical value ownership', () => {
  it('owns point expressions once and lowers references through scalar aliases', () => {
    const env = new Env();
    env.bind('A', { tag: 'vector', role: 'const', components: [n(1), n(2)] });
    env.bind('B', { tag: 'vector', role: 'const', components: [parseExpr('A_x+3'), parseExpr('A_y*2')] });
    expect(env.names.get('A_x')).toEqual({ kind: 'component', owner: 'A', index: 0 });
    expect(lookupValue(env, 'A_x')).toEqual({ tag: 'scalar', role: 'const', expr: n(1) });
    expect(lowerValueRef(env, 'A')).toEqual({
      kind: 'vec',
      items: [
        { kind: 'var', name: 'A_x' },
        { kind: 'var', name: 'A_y' },
      ],
    });
    expect(evaluateFrame(env, 0)).toEqual({ A_x: 1, A_y: 2, B_x: 4, B_y: 4 });
    expect('set' in env.consts).toBe(false);
    expect('set' in env.names).toBe(false);
  });
  it('reserves and drops vector components atomically in either collision order', () => {
    for (const first of ['A', 'A_y']) {
      const env = new Env();
      const vector = () => env.bind('A', { tag: 'vector', role: 'const', components: [n(1), n(2)] });
      const scalar = () => env.bind('A_y', { tag: 'scalar', role: 'const', expr: n(5) });
      (first === 'A' ? vector : scalar)();
      const before = [...env.names];
      expect(first === 'A' ? scalar : vector).toThrow('already defined');
      expect([...env.names]).toEqual(before);
    }
    const env = new Env();
    env.bind('A', { tag: 'vector', role: 'field', components: [parseExpr('x'), parseExpr('y')] });
    const view = env.fields;
    env.drop('A_x');
    expect([...env.names]).toEqual([]);
    expect([...view]).toEqual([]);
  });
  it('projects full state payloads but evaluates their integrated values', () => {
    const env = new Env();
    env.bind('om', { tag: 'vector', role: 'state', deriv: [n(20), n(30)], init: [n(2), n(3)] });
    env.bind('a', { tag: 'scalar', role: 'const', expr: parseExpr('om_1+om_2') });
    expect([...scalarDefinitions(env).keys()]).toEqual(['om_1', 'om_2', 'a']);
    expect(env.states.get('om_2')).toEqual({ deriv: n(30), init: n(3) });
    expect(evaluateFrame(env, 0, { om_1: 4, om_2: 5 })).toEqual({ om_1: 4, om_2: 5, a: 9 });
    expect(() =>
      env.bind('bad', { tag: 'vector', role: 'state', deriv: [n(1), n(2)], init: [n(0), n(0), n(0)] }),
    ).toThrow('dimensions');
    expect(env.names.has('bad')).toBe(false);
  });
  it('does not reserve sequence letters as ordinary value names', () => {
    const env = new Env([['a', { name: 'a', rhs: 'a/n^2', rec: false, index: 'n' }]]);
    env.bind('a', { tag: 'scalar', role: 'const', expr: n(2) });
    expect(evaluateFrame(env, 0)).toEqual({ a: 2 });
    expect(env.sequences.has('a')).toBe(true);
  });
});

describe('RV declaration provider', () => {
  const declarationEnv = (mean: number) => {
    const env = new Env();
    env.bind('X', {
      tag: 'rv',
      declaration: { name: 'X', kind: 'base', dist: { kind: 'normal', args: [n(mean), n(1)] } },
    });
    env.bind('Y', { tag: 'rv', declaration: { name: 'Y', kind: 'derived', expr: parseExpr('X+1') } });
    return env;
  };
  it('retains numerical caches across preparation but invalidates changed dependencies', () => {
    const sys = new RVSystem();
    sys.useDeclarations(declarationEnv(0).rvs);
    const samples = sys.columns('Y', {});
    sys.useDeclarations(declarationEnv(0).rvs);
    expect(sys.columns('Y', {})).toBe(samples);
    sys.useDeclarations(declarationEnv(2).rvs);
    const changed = sys.columns('Y', {});
    expect(changed).not.toBe(samples);
    expect(changed[0] - samples[0]).toBeCloseTo(2);
  });
  it('keeps anonymous expression declarations outside user bindings', () => {
    const env = declarationEnv(0),
      sys = new RVSystem();
    sys.useDeclarations(env.rvs);
    sys.addAnonymous({ name: '@E0', kind: 'derived', expr: parseExpr('X+3') });
    expect(sys.has('@E0')).toBe(true);
    expect(env.names.has('@E0')).toBe(false);
    expect(() => sys.addAnonymous({ name: 'Z', kind: 'derived', expr: parseExpr('X+3') })).toThrow('internal name');
    sys.useDeclarations(env.rvs);
    expect(sys.has('@E0')).toBe(false);
  });
});

describe('document binding commits', () => {
  it('does not leave aliases or dependents of a failed point usable', async () => {
    const { buildDefs, scanDefinition } = await import('./defs.ts');
    const built = buildDefs(['A=(1,q)', 'b=A_x+1'].map(row => scanDefinition(row)!));
    expect(built.errors.has('A')).toBe(true);
    expect(built.defs.names.has('A')).toBe(false);
    expect(built.defs.names.has('A_x')).toBe(false);
    expect(built.defs.names.has('A_y')).toBe(false);
    expect(built.errors.has('b')).toBe(true);
    expect(built.defs.names.has('b')).toBe(false);
  });
  it('does not integrate surviving components of a failed vector state', async () => {
    const { buildDefs, scanDefinition } = await import('./defs.ts');
    const built = buildDefs(["om'=(1,q)", 'om(0)=(2,3)'].map(row => scanDefinition(row)!));
    expect(built.errors.has('om')).toBe(true);
    expect([...built.defs.states]).toEqual([]);
    expect([...built.defs.names]).toEqual([]);
  });
  it('keeps vector fields owned and component aliases out of named grids', async () => {
    const { buildDefs, scanDefinition, pointComponentNames } = await import('./defs.ts');
    const built = buildDefs(['A=(x,0)', 'r=A_x+1'].map(row => scanDefinition(row)!));
    expect([...built.errors]).toEqual([]);
    expect(lookupValue(built.defs, 'A')).toMatchObject({ tag: 'vector', role: 'field' });
    expect([...built.defs.fields.keys()]).toEqual(['A_x', 'A_y', 'r']);
    expect([...pointComponentNames(built.defs)]).toEqual(['A_x', 'A_y']);
  });
  it('retains complete state seeds and keys across unrelated and constant edits', async () => {
    const { buildDefs, scanDefinition } = await import('./defs.ts');
    const { buildStateSystem, initialState } = await import('./state.ts');
    const make = (rows: string[]) => buildDefs(rows.map(row => scanDefinition(row)!)).defs;
    const rows = ['c=2', "om'=(-om_1, c-om_2)", 'om(0)=(c,3)'];
    const env = make(rows),
      system = buildStateSystem(env)!;
    expect(initialState(env, system)).toEqual({ om_1: 2, om_2: 3 });
    expect(buildStateSystem(make([...rows, 'b=5']))!.key).toBe(system.key);
    expect(buildStateSystem(make(['c=4', ...rows.slice(1)]))!.key).toBe(system.key);
    expect(buildStateSystem(make([...rows.slice(0, 2), 'om(0)=(c,4)']))!.key).not.toBe(system.key);
    expect(buildStateSystem(make(['c=2', "om'=(-2om_1,c-om_2)", rows[2]]))!.key).not.toBe(system.key);
  });
});

describe('document RV name claims', () => {
  it('lets ordinary names and component aliases win in either row order', async () => {
    const { prepareDocument } = await import('./analysis.ts');
    for (const ordinary of ['a=2', 'a=(1,2)']) {
      for (const rows of [
        [ordinary, 'a ~ Normal(0,1)'],
        ['a ~ Normal(0,1)', ordinary],
      ]) {
        const document = prepareDocument(rows);
        expect(document.defs.rvs.has('a')).toBe(false);
        expect([...document.builtRVs.errors.values()]).toEqual(['a is already defined.']);
      }
    }
    for (const rows of [
      ['A=(1,2)', 'A_x ~ Normal(0,1)'],
      ['A_x ~ Normal(0,1)', 'A=(1,2)'],
    ]) {
      const document = prepareDocument(rows);
      expect(document.defs.rvs.has('A_x')).toBe(false);
      expect([...document.builtRVs.errors.values()]).toEqual(['A_x is already defined.']);
    }
  });
  it('keeps valid named declarations canonical and sequence letters independent', async () => {
    const { prepareDocument } = await import('./analysis.ts');
    const document = prepareDocument(['a_n=1/n^2', 'a ~ Normal(0,1)', 'Y=a+1']);
    expect([...document.builtRVs.errors]).toEqual([]);
    expect(document.defs.names.get('a')).toMatchObject({ kind: 'binding', binding: { tag: 'rv' } });
    expect(document.defs.names.get('Y')).toMatchObject({ kind: 'binding', binding: { tag: 'rv' } });
    expect(document.defs.sequences.has('a')).toBe(true);
  });
});

describe('failed owner dependency propagation', () => {
  it('rejects all dependent binding forms and keeps unrelated states running', async () => {
    const { analyzeRows } = await import('./analysis.ts');
    const { initialState, buildStateSystem, advanceState } = await import('./state.ts');
    const rows = [
      'A=(1,b)',
      "c'=A_x",
      "d'=c",
      'B=(A_x+1,x)',
      'f(q)=q+A_x',
      'g(q)=f(q)',
      'M=((A_x,0),(0,1))',
      'L=[A_x,2]',
      "ok'=1",
      'ok(0)=2',
      'P=(3,4)',
    ];
    const result = analyzeRows(rows);
    for (let i = 0; i < 8; i++) expect(result.rows[i].error, rows[i]).toBeTruthy();
    for (let i = 8; i < rows.length; i++) expect(result.rows[i].error, rows[i]).toBeUndefined();
    for (const name of ['A', 'A_x', 'A_y', 'B', 'B_x', 'B_y', 'c', 'd', 'f', 'g', 'M', 'L']) {
      expect(result.defs.names.has(name), name).toBe(false);
    }
    const system = buildStateSystem(result.defs)!;
    expect(system.names).toEqual(['ok']);
    const values = initialState(result.defs, system);
    advanceState(result.defs, system, values, 0, 0.1);
    expect(values.ok).toBeCloseTo(2.1);
    expect(evaluateFrame(result.defs, 0.1, values)).toMatchObject({ P_x: 3, P_y: 4, ok: values.ok });
  });
  it('retains provenance through field inlining, matrix/list lowering and constant folding', async () => {
    const { analyzeRows } = await import('./analysis.ts');
    const field = analyzeRows(['A=(x,b)', 'q=A_x+1', 'B=(q,y)', 'r=q+1', 's=x+2']);
    for (let i = 0; i < 4; i++) expect(field.rows[i].error).toBeTruthy();
    for (const name of ['A', 'A_x', 'q', 'B', 'B_x', 'B_y', 'r']) expect(field.defs.names.has(name)).toBe(false);
    expect(field.rows[4].error).toBeUndefined();
    expect((await import('./expr.ts')).evaluate(field.defs.fields.get('s')!, { x: 3 })).toBe(5);
    const folded = analyzeRows([
      'A=(2,b)',
      'q=sum(k=1..A_x,k)',
      'L=[1..A_x]',
      'M=((A_x,0),(0,1))',
      'N=2M',
      'r=det(M)',
      'C=M(1,2)',
      's=7',
    ]);
    for (let i = 0; i < 7; i++) expect(folded.rows[i].error, folded.rows[i].text).toBeTruthy();
    for (const name of ['q', 'L', 'M', 'N', 'r', 'C', 'C_x', 'C_y']) expect(folded.defs.names.has(name)).toBe(false);
    expect(folded.rows[7].error).toBeUndefined();
    expect(folded.constEnv.s).toBe(7);
  });
  it('diagnoses invalid seeds without discarding states or valid sibling seeds', async () => {
    const { analyzeRows } = await import('./analysis.ts');
    const { buildStateSystem, initialState, advanceState } = await import('./state.ts');
    const result = analyzeRows([
      'A=(2,b)',
      "c'=1",
      'c(0)=A_x',
      "om'=(1,2)",
      'om(0)=(A_x,3)',
      "p'=1",
      'p(0)=sum(k=1..A_x,k)',
    ]);
    for (const index of [0, 2, 4, 6]) expect(result.rows[index].error).toBeTruthy();
    for (const index of [1, 3, 5]) expect(result.rows[index].error).toBeUndefined();
    const system = buildStateSystem(result.defs)!;
    const values = initialState(result.defs, system);
    expect(values).toEqual({ c: 0, om_1: 0, om_2: 3, p: 0 });
    advanceState(result.defs, system, values, 0, 0.1);
    expect(values.c).toBeCloseTo(0.1);
    expect(values.om_1).toBeCloseTo(0.1);
    expect(values.om_2).toBeCloseTo(3.2);
    expect(values.p).toBeCloseTo(0.1);
  });
  it('respects function parameters and bound sum indices when tracking provenance', async () => {
    const { analyzeRows } = await import('./analysis.ts');
    const result = analyzeRows(['A=(1,b)', 'k=bad', 'f(A)=A+1', 'g(q)=sum(k=1..3,k)+q', 'f(2)', 'g(1)']);
    expect(result.rows[2].error).toBeUndefined();
    expect(result.rows[3].error).toBeUndefined();
    expect(result.rows[4].info).toBe('= 3');
    expect(result.rows[5].info).toBe('= 7');
  });
});
