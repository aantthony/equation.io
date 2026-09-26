/** Independent CPU projection and GPU compilation of immutable mathematical objects. */
import { complexParts, SplitTooLarge } from './complex-parts.ts';
import { compileTyped, usesComplex, type Typed } from './complex.ts';
import { diff } from './diff.ts';
import type { ProbBounds } from './dist.ts';
import { type Column, type Expr, exprKey, freeVars, mapChildren, substVars } from './expr.ts';
import { toGLSL, uniformName } from './glsl.ts';
import { hasAtan2 } from './grid.ts';
import type { IntShade } from './intshade.ts';
import type { Classified, ColorSpace, LevelSetSpec, PointSource } from './math-object.ts';
import { PATH_NODE_BUDGET } from './path.ts';

export interface CpuGrid {
  name: string;
  expr: Expr;
  grad?: [Expr, Expr];
  params: string[];
  angular: boolean;
  level?: string;
}
export interface GpuGrid {
  glsl: string;
  gradGlsl?: [string, string];
  params: string[];
}
export type CpuPlan =
  | { type: 'family'; members: Array<{ cls: Classified; cpu: CpuPlan }> }
  | { type: 'implicit2d'; residual: Expr; equation: Expr; levels?: CpuGrid }
  | { type: 'implicit3d'; residual: Expr; equation: Expr; heightmap?: Expr }
  | { type: 'ineq2d'; constraints: Array<{ residual: Expr; strict: boolean }> }
  | { type: 'scalar2d'; expr: Expr }
  | { type: `${ColorSpace}2d`; channels: Expr[] }
  | { type: 'complex2d'; expr: Expr }
  | { type: 'domain2d'; expr: Expr }
  | { type: 'conformal2d'; expr: Expr }
  | { type: 'fractal2d'; step: Expr; seed: 'pixel' | 'zero'; maxIter: number }
  | { type: 'point'; dim: 2 | 3; coords: Expr[] }
  | { type: 'trail'; dim: 2 | 3; coords: Expr[] }
  | { type: 'label'; dim: 2 | 3; coords: Expr[]; text: string }
  | { type: 'orbit'; dim: 2 | 3; paths: Expr[][]; series: boolean; from: Expr; to: Expr }
  /** `pts` flat, or with `over` one vertex template run over the columns. */
  | {
      type: 'polygon';
      dim: 2 | 3;
      pts: Expr[];
      closed: boolean;
      arrow?: boolean;
      hull?: boolean;
      over?: readonly Column[];
    }
  | { type: 'spacecurve'; residuals: Expr[] }
  | {
      type: 'system';
      dim: 2 | 3;
      residuals: Expr[];
      complexEquation?: Expr;
      parametric?: boolean;
      angular?: boolean[];
      coordinates?: Expr[];
    }
  | { type: 'vfield2d'; comps: [Expr, Expr] }
  | { type: 'vfield3d'; comps: Expr[] }
  | { type: 'pcurve'; dim: 2 | 3; comps: Expr[]; tube?: Expr; d1?: Expr[]; d2?: Expr[]; d3?: Expr[] }
  | { type: 'psurface'; comps: [Expr, Expr, Expr] }
  | { type: 'vlist'; values: Expr[] }
  | { type: 'plist'; dim: 2 | 3; pts: Expr[][] }
  | { type: 'dlist'; values: Float64Array }
  | { type: 'dscatter'; dim: 2 | 3; coords: Float64Array[] }
  | { type: 'histogram'; centers: Float64Array; counts: Float64Array; width: number }
  | { type: 'sequence'; term: Expr; index: string }
  | { type: 'cobweb'; f: Expr; recVar: string; a0Name?: string }
  | { type: 'bifurcation'; expr: Expr; recVar: string; a0Name?: string }
  | { type: 'automaton'; rule: Expr; radius: number; seed?: Expr }
  | { type: 'density'; rv: string }
  | { type: 'pmf'; rv: string }
  | { type: 'expect'; rv: string }
  | { type: 'prob'; body: Expr; shade?: { rv: string } & ProbBounds }
  | { type: 'value'; expr: Expr; shade?: IntShade }
  | { type: 'tuple'; values: Expr[] }
  | { type: 'note'; expr: Expr; variable: boolean; constant?: string; identity?: true };

export type GpuPlan = { params: string[]; uniforms?: Record<string, number> } & (
  | { type: 'none' }
  | { type: 'family'; members: GpuPlan[] }
  | { type: 'implicit2d'; field: string; levels?: GpuGrid }
  | { type: 'implicit3d'; field: string; grad?: [string, string, string] }
  | { type: 'ineq2d'; field: string; edges: string[] }
  | { type: 'scalar2d'; field: string }
  | { type: `${ColorSpace}2d`; space: ColorSpace; field: string; locals: string }
  | { type: 'complex2d'; field: string }
  | { type: 'domain2d'; field: string }
  | { type: 'conformal2d'; field: string }
  | { type: 'fractal2d'; step: string; seed: 'pixel' | 'zero'; maxIter: number }
  | { type: 'vfield2d'; fx: string; fy: string }
  | { type: 'vfield3d'; comps: [string, string, string] }
  | { type: 'psurface'; comps: [string, string, string]; du?: [string, string, string]; dv?: [string, string, string] }
  | { type: 'cobweb'; curveField: string }
  | { type: 'bifurcation'; field: string }
);

const zero: Expr = { kind: 'num', value: 0 };
const equationOf = (residual: Expr): Expr => ({ kind: 'eq', l: residual, r: zero });
const graphEquation = (rhs: Expr): Expr => ({ kind: 'eq', l: { kind: 'var', name: 'y' }, r: rhs });
const residualOf = (equation: Expr): Expr =>
  equation.kind === 'eq' ? { kind: 'bin', op: '-', a: equation.l, b: equation.r } : equation;
const splitWithin = (expr: Expr, what: string, verb: string): [Expr, Expr] => {
  try {
    return complexParts(expr, PATH_NODE_BUDGET);
  } catch (error) {
    if (error instanceof SplitTooLarge)
      throw new Error(
        `This complex ${what} is too large to ${verb} once split into real and imaginary parts — reduce the nesting or the powers.`,
      );
    throw error;
  }
};
/** CPU evaluators are real: real outputs containing complex subterms need projection too. */
const real = (expr: Expr): Expr => (usesComplex(expr) ? splitWithin(expr, 'expression', 'evaluate')[0] : expr);
const realEquation = (expr: Expr): Expr =>
  expr.kind === 'eq' ? { ...expr, l: real(expr.l), r: real(expr.r) } : real(expr);
const point = (source: PointSource, what: string): Expr[] =>
  source.representation === 'complex'
    ? splitWithin(source.expr, what, what === 'path' ? 'sample' : 'evaluate')
    : source.coordinates.map(real);
const derivatives = (exprs: Expr[] | undefined, variable: string): Expr[] | undefined => {
  try {
    return exprs?.map(expr => diff(expr, variable));
  } catch {
    return undefined;
  }
};

export function compileGridCpu(spec: LevelSetSpec): CpuGrid {
  const expr = real(spec.expr);
  let gradient: [Expr, Expr] | undefined;
  try {
    gradient = [diff(expr, 'x'), diff(expr, 'y')];
  } catch {
    /* finite differences */
  }
  return { ...spec, params: [...spec.params], expr, grad: gradient, angular: hasAtan2(spec.expr) };
}
export function compileGridGpu(spec: LevelSetSpec): GpuGrid {
  const sub = uniformSub(spec.params);
  let gradGlsl: [string, string] | undefined;
  try {
    gradGlsl = [toGLSL(sub(diff(spec.expr, 'x'))), toGLSL(sub(diff(spec.expr, 'y')))];
  } catch {
    /* finite differences */
  }
  return { glsl: toGLSL(sub(spec.expr)), gradGlsl, params: [...spec.params] };
}

export function compileCpu(classified: Classified): CpuPlan {
  const object = classified.object;
  switch (object.kind) {
    case 'curve':
      switch (object.form) {
        case 'graph': {
          const equation = realEquation(object.equation);
          return {
            type: 'implicit2d',
            equation,
            residual: residualOf(equation),
            levels: object.levels && compileGridCpu(object.levels),
          };
        }
        case 'implicit':
          return {
            type: 'implicit2d',
            residual: real(object.residual),
            equation: realEquation(object.equation ?? equationOf(object.residual)),
            levels: object.levels && compileGridCpu(object.levels),
          };
        case 'parametric': {
          const comps = point(object.source, 'path');
          const d1 = derivatives(comps, 'u');
          const d2 = derivatives(d1, 'u');
          return {
            type: 'pcurve',
            dim: comps.length as 2 | 3,
            comps,
            tube: object.tube,
            d1,
            d2,
            d3: derivatives(d2, 'u'),
          };
        }
      }
    case 'surface':
      if (object.form === 'parametric')
        return { type: 'psurface', comps: object.coordinates.map(real) as [Expr, Expr, Expr] };
      else {
        const equation = realEquation(object.equation ?? equationOf(object.residual));
        const height =
          equation.kind === 'eq'
            ? equation.l.kind === 'var' && equation.l.name === 'z'
              ? equation.r
              : equation.r.kind === 'var' && equation.r.name === 'z'
                ? equation.l
                : undefined
            : undefined;
        return {
          type: 'implicit3d',
          equation,
          residual: real(object.residual),
          heightmap: height && !freeVars(height).has('z') ? real(height) : undefined,
        };
      }
    case 'intersection':
      return { type: 'spacecurve', residuals: object.residuals.map(real) };
    case 'region':
      return { type: 'ineq2d', constraints: object.constraints.map(c => ({ ...c, residual: real(c.residual) })) };
    case 'scalar-field':
      return { type: 'scalar2d', expr: real(object.expr) };
    // Like domain coloring, these expressions are rendered per pixel on the GPU.
    case 'color-field':
      return { type: `${object.space}2d`, channels: [...object.channels] };
    case 'vector-field':
      return object.components.length === 2
        ? { type: 'vfield2d', comps: object.components.map(real) as [Expr, Expr] }
        : { type: 'vfield3d', comps: object.components.map(real) };
    case 'complex-field':
      return object.form === 'fractal'
        ? { type: 'fractal2d', step: object.step, seed: object.seed, maxIter: object.maxIter }
        : {
            type: object.form === 'potential' ? 'complex2d' : object.form === 'domain' ? 'domain2d' : 'conformal2d',
            expr: object.expr,
          };
    case 'point': {
      const coords = point(object.source, 'point');
      return { type: 'point', dim: coords.length as 2 | 3, coords };
    }
    case 'trail':
      return { type: 'trail', dim: object.coordinates.length as 2 | 3, coords: object.coordinates.map(real) };
    case 'label':
      return {
        type: 'label',
        dim: object.coordinates.length as 2 | 3,
        coords: object.coordinates.map(real),
        text: object.text,
      };
    case 'orbit':
      return {
        type: 'orbit',
        dim: object.series ? 2 : (object.paths[0].length as 2 | 3),
        paths: object.paths.map(p => p.map(real)),
        series: object.series,
        from: object.from,
        to: object.to,
      };
    case 'figure':
      return {
        type: 'polygon',
        dim: object.dimension,
        pts: [...object.vertices],
        closed: ['polygon', 'square', 'hull'].includes(object.form),
        ...(object.form === 'vector' ? { arrow: true } : {}),
        ...(object.form === 'hull' ? { hull: true } : {}),
        ...(object.over ? { over: object.over } : {}),
      };
    case 'system': {
      const { source, parametric, angular, coordinates } = object;
      if (source.representation === 'real')
        return {
          type: 'system',
          dim: source.residuals.length as 2 | 3,
          residuals: source.residuals.map(real),
          ...(parametric ? { parametric } : {}),
          ...(angular ? { angular: [...angular] } : {}),
          ...(coordinates ? { coordinates: [...coordinates] } : {}),
        };
      const equation = source.equation;
      const a = splitWithin(equation.kind === 'eq' ? equation.l : equation, 'equation', 'solve');
      const b = splitWithin(equation.kind === 'eq' ? equation.r : zero, 'equation', 'solve');
      return {
        type: 'system',
        dim: 2,
        complexEquation: equation,
        residuals: a.map((c, k) => ({ kind: 'bin', op: '-', a: c, b: b[k] })),
        ...(parametric ? { parametric } : {}),
        ...(angular ? { angular: [...angular] } : {}),
        ...(coordinates ? { coordinates: [...coordinates] } : {}),
      };
    }
    case 'sequence':
      if (object.form === 'explicit') return { type: 'sequence', term: object.term, index: object.index };
      return object.form === 'cobweb'
        ? { type: 'cobweb', f: object.expr, recVar: object.variable, a0Name: object.seedName }
        : { type: 'bifurcation', expr: object.expr, recVar: object.variable, a0Name: object.seedName };
    case 'automaton':
      return {
        type: 'automaton',
        rule: object.rule,
        radius: object.radius,
        ...(object.seed ? { seed: object.seed } : {}),
      };
    case 'list':
      if (object.element === 'scalar')
        return object.storage === 'packed'
          ? { type: 'dlist', values: object.values }
          : { type: 'vlist', values: object.values.map(real) };
      return object.storage === 'packed'
        ? { type: 'dscatter', dim: object.dimension, coords: [...object.coordinates] }
        : { type: 'plist', dim: object.dimension, pts: object.values.map(row => row.map(real)) };
    case 'histogram':
      return { type: 'histogram', centers: object.centers, counts: object.counts, width: object.width };
    case 'distribution':
      return object.form === 'prob'
        ? { type: 'prob', body: object.body, shade: object.shade }
        : { type: object.form, rv: object.rv };
    case 'value':
      return { type: 'value', expr: real(object.expr), shade: object.shade };
    case 'tuple':
      return { type: 'tuple', values: object.values.map(real) };
    case 'note':
      return {
        type: 'note',
        expr: object.expr,
        variable: object.variable,
        constant: object.constant,
        ...(object.identity && { identity: true as const }),
      };
    case 'family':
      return { type: 'family', members: object.members.map(cls => ({ cls, cpu: compileCpu(cls) })) };
  }
}

function uniformSub(params: readonly string[]): (expr: Expr) => Expr {
  const map = Object.fromEntries(params.map(name => [name, { kind: 'var', name: uniformName(name) } as Expr]));
  return expr => (params.length ? substVars(expr, map) : expr);
}

/** Node kinds whose children all live in the enclosing scope, so a child may
 * be emitted as a shader local ahead of its parent. Anything that binds a
 * variable (a Σ/Π, or any future binder) compiles as one unit instead.
 */
const HOISTABLE = new Set<Expr['kind']>(['num', 'var', 'bin', 'neg', 'call', 'piecewise', 'ineq', 'eq']);
const bindsVariable = (e: Expr): boolean =>
  !HOISTABLE.has(e.kind) || (e.kind === 'call' && (e.name === 'sum' || e.name === 'prod') && e.args.length >= 4);

/** Emit shared channel calculations once. Inlining a nested complex map into
 * three colors otherwise duplicates it at every re/im/arg use and can leave
 * the browser compiling megabytes of GLSL. Intern shallow lowered nodes too:
 * separate channel expressions may contain identical but unshared trees.
 * All expressions are pure; undefined values in an unselected piecewise arm
 * stay in that arm's temporary and do not affect the selected result.
 */
function colorProgram(channels: readonly Expr[], params: readonly string[]): { field: string; locals: string } {
  const sub = uniformSub(params);
  const memo = new WeakMap<Expr, Expr>();
  const shared = new Map<string, Expr>();
  const bindings: Record<string, Typed> = {};
  const complexLocals = new Set<string>();
  const lines: string[] = [];
  const visit = (expr: Expr): Expr => {
    const known = memo.get(expr);
    if (known) return known;
    let result: Expr;
    if (expr.kind === 'num') result = expr;
    else if (expr.kind === 'var' || bindsVariable(expr)) result = sub(expr);
    else {
      const lowered = mapChildren(expr, visit);
      // Inequalities retain their boolean shape for piecewiseGLSL.
      if (expr.kind === 'ineq') result = lowered;
      else {
        const key = exprKey(lowered);
        const reused = shared.get(key);
        if (reused) result = reused;
        else {
          const value = compileTyped(lowered, bindings, complexLocals);
          const name = `eqColor${lines.length}`;
          lines.push(`${value.type === 'complex' ? 'vec2' : 'float'} ${name} = ${value.code};`);
          if (value.type === 'complex') {
            bindings[name] = { type: 'complex', code: name };
            complexLocals.add(name);
          }
          result = { kind: 'var', name };
          shared.set(key, result);
        }
      }
    }
    memo.set(expr, result);
    return result;
  };
  const colors = channels.map(channel => compileTyped(visit(channel), bindings, complexLocals).code);
  return { field: `vec3(${colors.join(', ')})`, locals: lines.join('\n') };
}

export function compileGpu(classified: Classified): GpuPlan {
  const { object } = classified;
  const params = [...classified.params];
  const sub = uniformSub(params);
  const typed = (expr: Expr) => compileTyped(sub(expr));
  const scalar = (expr: Expr) => typed(expr).code;
  const gradient = (exprs: readonly Expr[], variable: string): [string, string, string] | undefined => {
    try {
      return exprs.map(e => toGLSL(sub(diff(e, variable)))) as [string, string, string];
    } catch {
      return undefined;
    }
  };
  switch (object.kind) {
    case 'curve':
      if (object.form === 'parametric') break;
      return {
        type: 'implicit2d',
        params,
        field: scalar(object.form === 'graph' ? object.equation : (object.equation ?? object.residual)),
        levels: object.levels ? compileGridGpu(object.levels) : undefined,
      };
    case 'surface':
      if (object.form === 'parametric')
        return {
          type: 'psurface',
          params,
          comps: object.coordinates.map(e => toGLSL(sub(e))) as [string, string, string],
          du: gradient(object.coordinates, 'u'),
          dv: gradient(object.coordinates, 'v'),
        };
      else {
        let grad: [string, string, string] | undefined;
        try {
          grad = ['x', 'y', 'z'].map(v => toGLSL(sub(diff(object.equation ?? object.residual, v)))) as [
            string,
            string,
            string,
          ];
        } catch {
          /* finite differences */
        }
        return { type: 'implicit3d', params, field: scalar(object.equation ?? object.residual), grad };
      }
    case 'region': {
      const fields = object.constraints.map(c => ({ code: scalar(c.residual), edge: !c.strict }));
      const field = fields.slice(1).reduce((combined, f) => `max(${combined}, ${f.code})`, fields[0].code);
      return { type: 'ineq2d', params, field, edges: fields.filter(f => f.edge).map(f => f.code) };
    }
    case 'scalar-field':
      return { type: 'scalar2d', params, field: scalar(object.expr) };
    case 'color-field':
      return { type: `${object.space}2d`, space: object.space, params, ...colorProgram(object.channels, params) };
    case 'vector-field':
      if (object.components.length === 2)
        return {
          type: 'vfield2d',
          params,
          fx: toGLSL(sub(object.components[0])),
          fy: toGLSL(sub(object.components[1])),
        };
      // Only the optional streamline view uses this; trajectories and arrows
      // trace on the CPU, so a field GLSL cannot express still draws.
      try {
        return {
          type: 'vfield3d',
          params,
          comps: object.components.map(c => toGLSL(sub(c))) as [string, string, string],
        };
      } catch {
        break;
      }
    case 'complex-field':
      if (object.form === 'fractal') {
        const step = compileTyped(sub(object.step), { z: { type: 'complex', code: 'zc' } });
        return {
          type: 'fractal2d',
          params,
          step: step.type === 'complex' ? step.code : `vec2(${step.code}, 0.0)`,
          seed: object.seed,
          maxIter: object.maxIter,
        };
      }
      return {
        type: object.form === 'potential' ? 'complex2d' : object.form === 'domain' ? 'domain2d' : 'conformal2d',
        params,
        field: scalar(object.expr),
      };
    case 'sequence':
      if (object.form === 'explicit') break;
      if (object.form === 'cobweb') {
        const f = substVars(object.expr, { [object.variable]: { kind: 'var', name: 'x' } });
        return { type: 'cobweb', params, curveField: compileTyped(sub(graphEquation(f))).code };
      }
      return {
        type: 'bifurcation',
        params,
        field: compileTyped(sub(substVars(object.expr, { [object.variable]: { kind: 'var', name: 'a' } }))).code,
      };
    case 'family':
      if (object.shared) {
        const shared = compileGpu(object.shared.classified);
        return {
          type: 'family',
          params,
          members: object.members.map((_, k) => ({ ...shared, uniforms: { [object.shared!.index]: k } })),
        };
      }
      return { type: 'family', params, members: object.members.map(compileGpu) };
    case 'intersection':
    case 'point':
    case 'trail':
    case 'label':
    case 'orbit':
    case 'figure':
    case 'system':
    case 'list':
    case 'histogram':
    case 'distribution':
    case 'value':
    case 'tuple':
    case 'note':
    case 'automaton':
      break;
  }
  return { type: 'none', params };
}

/** Shader cache identity includes generated source and layout, never member values or source-row IDs. */
export function shaderKey(plan: GpuPlan): string {
  switch (plan.type) {
    case 'none':
      return 'none';
    case 'family':
      return `family:${plan.members.map(shaderKey).join('|')}`;
    case 'implicit2d':
      return JSON.stringify([
        plan.type,
        plan.params,
        plan.field,
        plan.levels?.glsl,
        plan.levels?.gradGlsl,
        plan.levels?.params,
      ]);
    case 'implicit3d':
      return JSON.stringify([plan.type, plan.params, plan.field, plan.grad]);
    case 'ineq2d':
      return JSON.stringify([plan.type, plan.params, plan.field, plan.edges]);
    case 'rgb2d':
    case 'hsl2d':
    case 'oklch2d':
      return JSON.stringify([plan.type, plan.params, plan.field, plan.locals]);
    case 'scalar2d':
    case 'complex2d':
    case 'domain2d':
    case 'conformal2d':
      return JSON.stringify([plan.type, plan.params, plan.field]);
    case 'fractal2d':
      return JSON.stringify([plan.type, plan.params, plan.step, plan.seed, plan.maxIter]);
    case 'vfield2d':
      return JSON.stringify([plan.type, plan.params, plan.fx, plan.fy]);
    case 'vfield3d':
      return JSON.stringify([plan.type, plan.params, plan.comps]);
    case 'psurface':
      return JSON.stringify([plan.type, plan.params, plan.comps, plan.du, plan.dv]);
    case 'cobweb':
      return JSON.stringify([plan.type, plan.params, plan.curveField]);
    case 'bifurcation':
      return JSON.stringify([plan.type, plan.params, plan.field]);
  }
}

/** CPU/system structure identity excludes source IDs, list axes/origins and
 * current frame/sample values. Packed data identity belongs to the runtime
 * that owns those buffers; only their layout affects this structural key.
 */
export function cpuStructureKey(plan: CpuPlan): string {
  const expressions = (values: Expr[]) => values.map(exprKey);
  let structure: unknown;
  switch (plan.type) {
    case 'family':
      structure = plan.members.map(member => cpuStructureKey(member.cpu));
      break;
    case 'implicit2d':
    case 'implicit3d':
      structure = exprKey(plan.residual);
      break;
    case 'ineq2d':
      structure = plan.constraints.map(c => [exprKey(c.residual), c.strict]);
      break;
    case 'rgb2d':
    case 'hsl2d':
    case 'oklch2d':
      structure = expressions(plan.channels);
      break;
    case 'scalar2d':
    case 'complex2d':
    case 'domain2d':
    case 'conformal2d':
    case 'value':
    case 'note':
      structure = exprKey(plan.expr);
      break;
    case 'fractal2d':
      structure = [exprKey(plan.step), plan.seed, plan.maxIter];
      break;
    case 'point':
    case 'trail':
      structure = expressions(plan.coords);
      break;
    case 'label':
      structure = [expressions(plan.coords), plan.text];
      break;
    case 'orbit':
      structure = [plan.series, plan.paths.map(expressions), exprKey(plan.from), exprKey(plan.to)];
      break;
    case 'polygon':
      structure = [
        plan.dim,
        expressions(plan.pts),
        plan.closed,
        plan.arrow,
        plan.hull,
        plan.over?.map(c => [c.name, c.values.length]),
      ];
      break;
    case 'spacecurve':
      structure = expressions(plan.residuals);
      break;
    case 'system':
      structure = [expressions(plan.residuals), plan.parametric, plan.angular, plan.coordinates?.map(exprKey)];
      break;
    case 'vfield2d':
    case 'vfield3d':
    case 'psurface':
      structure = expressions(plan.comps);
      break;
    case 'pcurve':
      structure = [expressions(plan.comps), plan.tube && exprKey(plan.tube)];
      break;
    case 'vlist':
    case 'tuple':
      structure = expressions(plan.values);
      break;
    case 'plist':
      structure = [plan.dim, plan.pts.map(expressions)];
      break;
    case 'dlist':
      structure = plan.values.length;
      break;
    case 'dscatter':
      structure = [plan.dim, plan.coords.map(c => c.length)];
      break;
    case 'histogram':
      structure = [plan.centers.length, plan.counts.length];
      break;
    case 'sequence':
      structure = [exprKey(plan.term), plan.index];
      break;
    case 'cobweb':
      structure = [exprKey(plan.f), plan.recVar, plan.a0Name];
      break;
    case 'bifurcation':
      structure = [exprKey(plan.expr), plan.recVar, plan.a0Name];
      break;
    case 'automaton':
      structure = [exprKey(plan.rule), plan.radius, plan.seed && exprKey(plan.seed)];
      break;
    case 'density':
    case 'pmf':
    case 'expect':
      structure = plan.rv;
      break;
    case 'prob':
      structure = [exprKey(plan.body), plan.shade && exprKey(plan.shade)];
      break;
  }
  return JSON.stringify([plan.type, structure]);
}
