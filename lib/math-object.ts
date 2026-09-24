/** Mathematical objects contain source expressions, never backend programs.
 * Semantic properties and collections are readonly, enforced by the type
 * checker rather than at runtime: objects are shared by reference, never
 * copied or frozen. Packed numeric buffers are zero-copy, read-only by
 * convention.
 */
import type { Column, Expr } from './expr.ts';
import type { ProbBounds } from './dist.ts';
import type { IntShade } from './intshade.ts';

export type ColorSpace = 'rgb' | 'hsl' | 'oklch';

export type Components = readonly [Expr, Expr] | readonly [Expr, Expr, Expr];
export type PointSource =
  | { readonly representation: 'real'; readonly coordinates: Components }
  | { readonly representation: 'complex'; readonly expr: Expr };
export type SystemSource =
  | { readonly representation: 'real'; readonly residuals: Components }
  | { readonly representation: 'complex'; readonly equation: Expr };
export interface LevelSetSpec {
  readonly name: string;
  readonly expr: Expr;
  readonly params: readonly string[];
  readonly level?: string;
}
export type MathObject =
  | { readonly kind: 'curve'; readonly form: 'graph'; readonly rhs: Expr; readonly equation?: Expr; readonly levels?: LevelSetSpec }
  | { readonly kind: 'curve'; readonly form: 'implicit'; readonly residual: Expr; readonly equation?: Expr; readonly levels?: LevelSetSpec }
  | { readonly kind: 'curve'; readonly form: 'parametric'; readonly source: PointSource; readonly tube?: Expr }
  | { readonly kind: 'surface'; readonly form: 'implicit'; readonly residual: Expr; readonly equation?: Expr }
  | { readonly kind: 'surface'; readonly form: 'parametric'; readonly coordinates: readonly [Expr, Expr, Expr] }
  | { readonly kind: 'intersection'; readonly residuals: readonly [Expr, Expr] }
  | { readonly kind: 'region'; readonly constraints: ReadonlyArray<{ readonly residual: Expr; readonly strict: boolean }> }
  | { readonly kind: 'scalar-field'; readonly expr: Expr }
  | { readonly kind: 'color-field'; readonly space: ColorSpace; readonly channels: readonly [Expr, Expr, Expr] }
  | { readonly kind: 'vector-field'; readonly components: Components }
  | { readonly kind: 'complex-field'; readonly form: 'potential' | 'domain' | 'conformal'; readonly expr: Expr }
  | { readonly kind: 'complex-field'; readonly form: 'fractal'; readonly step: Expr; readonly seed: 'pixel' | 'zero'; readonly maxIter: number }
  | { readonly kind: 'point'; readonly source: PointSource }
  | { readonly kind: 'trail'; readonly coordinates: Components }
  /** Where states go over [from, to], integrated ahead of time (orbit.ts):
   *  one path per run, each a point's coordinates or, for a series, the one
   *  value drawn against t. */
  | { readonly kind: 'orbit'; readonly paths: readonly (readonly Expr[])[]; readonly series: boolean; readonly from: Expr; readonly to: Expr }
  /** `vertices` flat, or with `over` one vertex template run over the columns. */
  | { readonly kind: 'figure'; readonly form: 'segment' | 'polyline' | 'vector' | 'polygon' | 'square' | 'hull'; readonly dimension: 2 | 3; readonly vertices: readonly Expr[]; readonly over?: readonly Column[] }
  | { readonly kind: 'system'; readonly source: SystemSource; readonly parametric?: boolean; readonly angular?: readonly boolean[]; readonly coordinates?: readonly Expr[] }
  | { readonly kind: 'sequence'; readonly form: 'explicit'; readonly term: Expr; readonly index: string }
  | { readonly kind: 'sequence'; readonly form: 'cobweb'; readonly expr: Expr; readonly variable: string; readonly seedName?: string }
  | { readonly kind: 'sequence'; readonly form: 'bifurcation'; readonly expr: Expr; readonly variable: string; readonly seedName?: string }
  /** A 1D cellular automaton (lib/automaton.ts): `rule` reads the previous
   *  row's cells within `radius`; `seed` is row 0 as an expression in its cell. */
  | { readonly kind: 'automaton'; readonly rule: Expr; readonly radius: number; readonly seed?: Expr }
  | { readonly kind: 'list'; readonly element: 'scalar'; readonly storage: 'expressions'; readonly values: readonly Expr[] }
  | { readonly kind: 'list'; readonly element: 'scalar'; readonly storage: 'packed'; readonly values: Float64Array }
  | { readonly kind: 'list'; readonly element: 'point'; readonly storage: 'expressions'; readonly dimension: 2 | 3; readonly values: ReadonlyArray<readonly Expr[]> }
  | { readonly kind: 'list'; readonly element: 'point'; readonly storage: 'packed'; readonly dimension: 2 | 3; readonly coordinates: readonly Float64Array[] }
  | { readonly kind: 'histogram'; readonly centers: Float64Array; readonly counts: Float64Array; readonly width: number }
  | { readonly kind: 'distribution'; readonly form: 'density' | 'pmf' | 'expect'; readonly rv: string }
  | { readonly kind: 'distribution'; readonly form: 'prob'; readonly body: Expr; readonly shade?: Readonly<{ rv: string } & ProbBounds> }
  | { readonly kind: 'value'; readonly expr: Expr; readonly shade?: Readonly<IntShade> }
  // `constant`: the row reads like a slider named e, pi or tau (see
  // takenDefinitionName), which the readout explains.
  | { readonly kind: 'note'; readonly expr: Expr; readonly variable: boolean; readonly constant?: string }
  | { readonly kind: 'family'; readonly members: readonly Classified[]; readonly shared?: { readonly classified: Classified; readonly index: string } };

export interface Classified {
  readonly object: MathObject;
  readonly animated: boolean;
  readonly needs3D: boolean;
  readonly params: readonly string[];
}

/** Stable public compatibility API; backend selection never changes it. */
export function publicKind(object: MathObject) {
  switch (object.kind) {
    case 'curve': return object.form === 'parametric' ? 'pcurve' : 'implicit2d';
    case 'surface': return object.form === 'parametric' ? 'psurface' : 'implicit3d';
    case 'intersection': return 'spacecurve';
    case 'region': return 'ineq2d';
    case 'scalar-field': return 'scalar2d';
    case 'color-field': return `${object.space}2d` as const;
    case 'vector-field': return object.components.length === 3 ? 'vfield3d' : 'vfield2d';
    case 'complex-field':
      switch (object.form) {
        case 'potential': return 'complex2d';
        case 'domain': return 'domain2d';
        case 'conformal': return 'conformal2d';
        case 'fractal': return 'fractal2d';
      }
    case 'figure': return 'polygon';
    case 'sequence': return object.form === 'explicit' ? 'sequence' : object.form;
    case 'list': return object.element === 'scalar'
      ? object.storage === 'packed' ? 'dlist' : 'vlist'
      : object.storage === 'packed' ? 'dscatter' : 'plist';
    case 'distribution': return object.form;
    case 'point': case 'trail': case 'orbit': case 'system': case 'histogram': case 'value': case 'note': case 'family': case 'automaton': return object.kind;
  }
}
export type PublicKind = ReturnType<typeof publicKind>;

export function components(items: readonly Expr[]): Components {
  if (items.length !== 2 && items.length !== 3) throw new Error('A point or vector needs 2 or 3 components.');
  return items as Components;
}

export function objectNeeds3D(object: MathObject): boolean {
  switch (object.kind) {
    case 'surface': case 'intersection': return true;
    case 'point': return object.source.representation === 'real' && object.source.coordinates.length === 3;
    case 'curve': return object.form === 'parametric' && object.source.representation === 'real' && object.source.coordinates.length === 3;
    case 'vector-field': return object.components.length === 3;
    case 'trail': return object.coordinates.length === 3;
    case 'orbit': return !object.series && object.paths[0]?.length === 3;
    case 'figure': return object.dimension === 3;
    case 'system': return object.source.representation === 'real' && object.source.residuals.length === 3;
    case 'list': return object.element === 'point' && object.dimension === 3;
    case 'family': return object.members.some(member => member.needs3D);
    case 'region': case 'scalar-field': case 'color-field': case 'complex-field': case 'sequence': case 'automaton': case 'histogram': case 'distribution': case 'value': case 'note': return false;
  }
}
