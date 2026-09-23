/** Mathematical objects contain source expressions, never backend programs.
 * Semantic properties and collections are readonly. Expr payloads retain the
 * shared resolver IR type; freezeClassified snapshots and freezes their trees
 * at runtime. Packed numeric buffers remain zero-copy, read-only by convention.
 */
import type { Expr } from './expr.ts';
import type { ProbBounds } from './dist.ts';
import type { IntShade } from './intshade.ts';

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
  | { readonly kind: 'vector-field'; readonly components: Components }
  | { readonly kind: 'complex-field'; readonly form: 'potential' | 'domain' | 'conformal'; readonly expr: Expr }
  | { readonly kind: 'complex-field'; readonly form: 'fractal'; readonly step: Expr; readonly seed: 'pixel' | 'zero'; readonly maxIter: number }
  | { readonly kind: 'point'; readonly source: PointSource }
  | { readonly kind: 'trail'; readonly coordinates: Components }
  | { readonly kind: 'figure'; readonly form: 'segment' | 'polyline' | 'vector' | 'polygon' | 'square' | 'hull'; readonly dimension: 2 | 3; readonly vertices: readonly Expr[] }
  | { readonly kind: 'system'; readonly source: SystemSource; readonly parametric?: boolean; readonly angular?: readonly boolean[]; readonly coordinates?: readonly Expr[] }
  | { readonly kind: 'sequence'; readonly form: 'explicit'; readonly term: Expr; readonly index: string }
  | { readonly kind: 'sequence'; readonly form: 'cobweb'; readonly expr: Expr; readonly variable: string; readonly seedName?: string }
  | { readonly kind: 'sequence'; readonly form: 'bifurcation'; readonly expr: Expr; readonly variable: string; readonly seedName?: string }
  | { readonly kind: 'list'; readonly element: 'scalar'; readonly storage: 'expressions'; readonly values: readonly Expr[] }
  | { readonly kind: 'list'; readonly element: 'scalar'; readonly storage: 'packed'; readonly values: Float64Array }
  | { readonly kind: 'list'; readonly element: 'point'; readonly storage: 'expressions'; readonly dimension: 2 | 3; readonly values: ReadonlyArray<readonly Expr[]> }
  | { readonly kind: 'list'; readonly element: 'point'; readonly storage: 'packed'; readonly dimension: 2 | 3; readonly coordinates: readonly Float64Array[] }
  | { readonly kind: 'histogram'; readonly centers: Float64Array; readonly counts: Float64Array; readonly width: number }
  | { readonly kind: 'distribution'; readonly form: 'density' | 'pmf' | 'expect'; readonly rv: string }
  | { readonly kind: 'distribution'; readonly form: 'prob'; readonly body: Expr; readonly shade?: Readonly<{ rv: string } & ProbBounds> }
  | { readonly kind: 'value'; readonly expr: Expr; readonly shade?: Readonly<IntShade> }
  | { readonly kind: 'note'; readonly expr: Expr; readonly variable: boolean }
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
    case 'point': case 'trail': case 'system': case 'histogram': case 'value': case 'note': case 'family': return object.kind;
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
    case 'figure': return object.dimension === 3;
    case 'system': return object.source.representation === 'real' && object.source.residuals.length === 3;
    case 'list': return object.element === 'point' && object.dimension === 3;
    case 'family': return object.members.some(member => member.needs3D);
    case 'region': case 'scalar-field': case 'complex-field': case 'sequence': case 'histogram': case 'distribution': case 'value': case 'note': return false;
  }
}

const snapshots = new WeakSet<object>();

/** Snapshot mathematical trees without freezing caller-owned resolver/Env nodes.
 * A memo preserves DAG sharing; packed buffers are immutable-by-convention leaves
 * and stay zero-copy, so a million-row column still occupies one payload.
 */
function snapshot<T>(value: T, memo: WeakMap<object, object>): T {
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
  if (snapshots.has(value)) return value;
  const existing = memo.get(value);
  if (existing) return existing as T;
  const copy: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
  memo.set(value, copy);
  for (const [key, item] of Object.entries(value)) (copy as Record<string, unknown>)[key] = snapshot(item, memo);
  Object.freeze(copy);
  snapshots.add(copy);
  return copy as T;
}

/** One immutable semantic snapshot, shared safely by CPU and GPU compilation. */
export function freezeClassified(value: Classified): Classified {
  return snapshot(value, new WeakMap());
}
