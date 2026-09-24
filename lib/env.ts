/** Canonical ownership of document values. Scalar maps below are read-only
 * projections: only names stores definitions, and a vector owns its aliases. */
import type { FnDef, StateDef, TableDef } from './defs.ts';
import type { RV } from './dist.ts';
import { type Expr, evaluate, freeVars } from './expr.ts';
import { pointComps, vecStateComps } from './geom.ts';
import type { Seq } from './list.ts';
import type { Mat } from './mat.ts';
import type { SeqScan } from './seq.ts';

export type Components = readonly [Expr, Expr] | readonly [Expr, Expr, Expr];
export type SeqValue =
  | { representation: 'sequence'; sequence: Seq }
  | { representation: 'scatter'; vector: Expr & { kind: 'vec' } };
export type NumericBinding = Readonly<
  | { tag: 'scalar'; role: 'const' | 'field'; expr: Expr }
  | { tag: 'vector'; role: 'const' | 'field'; components: Components }
  | { tag: 'scalar'; role: 'state'; deriv: Expr; init: Expr }
  | { tag: 'vector'; role: 'state'; deriv: Components; init: Components }
>;
export type Binding =
  | NumericBinding
  | Readonly<
      | { tag: 'fn'; fn: FnDef }
      | { tag: 'matrix'; matrix: Mat }
      | { tag: 'seq'; value: SeqValue }
      | { tag: 'table'; table: TableDef; unavailable?: { message: string; list: boolean } }
      | { tag: 'rv'; declaration: RV }
      | { tag: 'missing'; message: string; list: boolean }
    >;
export type NameEntry = Readonly<
  { kind: 'binding'; binding: Binding } | { kind: 'component'; owner: string; index: 0 | 1 | 2 }
>;
export type ScalarDefinition = Extract<NumericBinding, { tag: 'scalar' }>;

/** Read-only at runtime as well as in TypeScript; callers cannot mutate a
 * projection through Map.set or accidentally keep a stale snapshot. */
class ReadMap<V> implements ReadonlyMap<string, V> {
  constructor(private readonly source: () => ReadonlyMap<string, V>) {}
  get size(): number {
    return this.source().size;
  }
  get(key: string): V | undefined {
    return this.source().get(key);
  }
  has(key: string): boolean {
    return this.source().has(key);
  }
  entries(): MapIterator<[string, V]> {
    return this.source().entries();
  }
  keys(): MapIterator<string> {
    return this.source().keys();
  }
  values(): MapIterator<V> {
    return this.source().values();
  }
  [Symbol.iterator](): MapIterator<[string, V]> {
    return this.entries();
  }
  forEach(callback: (value: V, key: string, map: ReadonlyMap<string, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this) callback.call(thisArg, value, key, this);
  }
}
class ReadSet implements ReadonlySet<string> {
  constructor(private readonly source: () => ReadonlySet<string>) {}
  get size(): number {
    return this.source().size;
  }
  has(value: string): boolean {
    return this.source().has(value);
  }
  entries(): SetIterator<[string, string]> {
    return this.source().entries();
  }
  keys(): SetIterator<string> {
    return this.source().keys();
  }
  values(): SetIterator<string> {
    return this.source().values();
  }
  [Symbol.iterator](): SetIterator<string> {
    return this.values();
  }
  forEach(callback: (value: string, key: string, set: ReadonlySet<string>) => void, thisArg?: unknown): void {
    for (const value of this) callback.call(thisArg, value, value, this);
  }
}

function aliases(name: string, binding: Binding): string[] {
  if (binding.tag !== 'vector') return [];
  const dim = binding.role === 'state' ? binding.deriv.length : binding.components.length;
  if (dim !== 2 && dim !== 3) throw new Error('A vector needs 2 or 3 components.');
  if (binding.role === 'state' && binding.init.length !== dim)
    throw new Error('State derivative and initial dimensions must match.');
  return binding.role === 'state' ? vecStateComps(name, dim) : pointComps(name, dim);
}

export class Env {
  private readonly owned = new Map<string, NameEntry>();
  readonly names: ReadonlyMap<string, NameEntry> = new ReadMap(() => this.owned);
  readonly sequences: ReadonlyMap<string, SeqScan>;
  private generation = 0;
  constructor(
    sequences: Iterable<readonly [string, SeqScan]> = [],
    readonly sequencePrefix = 'eqioSeq',
  ) {
    const scans = new Map(sequences);
    this.sequences = new ReadMap(() => scans);
  }

  /** Commit one complete owner and all reserved aliases, or change nothing. */
  bind(name: string, binding: Binding): void {
    const components = aliases(name, binding);
    for (const key of [name, ...components]) {
      if (this.owned.has(key)) throw new Error(`${key} is already defined.`);
    }
    this.owned.set(name, { kind: 'binding', binding });
    components.forEach((key, index) =>
      this.owned.set(key, { kind: 'component', owner: name, index: index as 0 | 1 | 2 }),
    );
    this.generation++;
  }

  /** Removal always follows ownership, even when called with an alias. */
  drop(name: string): void {
    const entry = this.owned.get(name);
    if (!entry) return;
    if (entry.kind === 'component') {
      this.drop(entry.owner);
      return;
    }
    for (const alias of aliases(name, entry.binding)) this.owned.delete(alias);
    this.owned.delete(name);
    this.generation++;
  }

  private projection<V>(
    select: (name: string, value: Binding) => V | undefined,
    components = false,
  ): ReadonlyMap<string, V> {
    let version = -1;
    let values: ReadonlyMap<string, V> = new Map();
    return new ReadMap(() => {
      if (version !== this.generation) {
        const next = new Map<string, V>();
        for (const [name, entry] of this.owned) {
          const binding = entry.kind === 'binding' ? entry.binding : components ? lookupValue(this, name) : undefined;
          if (!binding) continue;
          const value = select(name, binding);
          if (value !== undefined) next.set(name, value);
        }
        values = next;
        version = this.generation;
      }
      return values;
    });
  }

  /** Derived views retain scalar runtime names for evaluators and uniforms. */
  readonly consts = this.projection((_, b) => (b.tag === 'scalar' && b.role === 'const' ? b.expr : undefined), true);
  readonly fields = this.projection((_, b) => (b.tag === 'scalar' && b.role === 'field' ? b.expr : undefined), true);
  readonly states: ReadonlyMap<string, StateDef> = this.projection(
    (_, b) => (b.tag === 'scalar' && b.role === 'state' ? { deriv: b.deriv, init: b.init } : undefined),
    true,
  );
  readonly fns = this.projection((_, b) => (b.tag === 'fn' ? b.fn : undefined));
  readonly mats = this.projection((_, b) => (b.tag === 'matrix' ? b.matrix : undefined));
  readonly lists = this.projection((_, b) =>
    b.tag === 'seq' ? (b.value.representation === 'sequence' ? b.value.sequence : b.value.vector) : undefined,
  );
  readonly tables = this.projection((_, b) => (b.tag === 'table' ? b.table : undefined));
  readonly missingData = this.projection((_, b) =>
    b.tag === 'missing' ? { message: b.message, list: b.list } : b.tag === 'table' ? b.unavailable : undefined,
  );
  readonly rvs = this.projection((_, b) => (b.tag === 'rv' ? b.declaration : undefined));
  readonly pointDims: ReadonlyMap<string, number> = this.projection((_, b) =>
    b.tag === 'vector' && b.role !== 'state' ? b.components.length : undefined,
  );
  readonly vecStates: ReadonlyMap<string, number> = this.projection((_, b) =>
    b.tag === 'vector' && b.role === 'state' ? b.deriv.length : undefined,
  );
  readonly points: ReadonlySet<string> = new ReadSet(() => new Set(this.pointDims.keys()));
  readonly scalars: ReadonlyMap<string, ScalarDefinition> = this.projection(
    (_, b) => (b.tag === 'scalar' ? b : undefined),
    true,
  );
}

/** Scalar aliases are views of their owner, never independent definitions. */
export function lookupValue(env: Env, name: string): Binding | undefined {
  const entry = env.names.get(name);
  if (!entry) return undefined;
  if (entry.kind === 'binding') return entry.binding;
  const owner = env.names.get(entry.owner);
  if (owner?.kind !== 'binding' || owner.binding.tag !== 'vector')
    throw new Error(`Invalid component owner: ${entry.owner}.`);
  const b = owner.binding,
    index = entry.index;
  const dim = b.role === 'state' ? b.deriv.length : b.components.length;
  if (index < 0 || index >= dim) throw new Error(`Invalid component index: ${name}.`);
  return b.role === 'state'
    ? { tag: 'scalar', role: 'state', deriv: b.deriv[index]!, init: b.init[index]! }
    : { tag: 'scalar', role: b.role, expr: b.components[index]! };
}

export function lowerValueRef(env: Env, name: string): Expr {
  const entry = env.names.get(name);
  if (entry?.kind === 'binding' && entry.binding.tag === 'vector') {
    return { kind: 'vec', items: aliases(name, entry.binding).map(name => ({ kind: 'var', name })) };
  }
  return { kind: 'var', name };
}
export const scalarDefinitions = (env: Env): ReadonlyMap<string, ScalarDefinition> => env.scalars;
export const nameTaken = (env: Env, name: string): boolean => env.names.has(name);
export const emptyEnv = (): Env => new Env();

/** Frame values use the established scalar/alias names. State references read
 * the supplied integrated values and never evaluate derivative expressions. */
export function evaluateFrame(
  env: Env,
  time: number,
  stateValues: Record<string, number> = {},
): Record<string, number> {
  const out = { ...stateValues };
  const visiting = new Set<string>();
  const get = (name: string): number => {
    if (name in out) return out[name];
    const value = lookupValue(env, name);
    if (value?.tag !== 'scalar' || value.role !== 'const') throw new Error(`${name} is not defined.`);
    if (visiting.has(name)) throw new Error(`${name} is defined in terms of itself.`);
    visiting.add(name);
    try {
      const vars: Record<string, number> = { t: time };
      for (const fv of freeVars(value.expr)) if (fv !== 't') vars[fv] = get(fv);
      return (out[name] = evaluate(value.expr, vars));
    } finally {
      visiting.delete(name);
    }
  };
  for (const name of env.consts.keys()) get(name);
  return out;
}

/** Read-only projections used while constructing or resolving definitions.
 * The builder's temporary draft implements this same query contract. */
export type ValueDefinitions = Pick<
  Env,
  | 'consts'
  | 'fields'
  | 'states'
  | 'fns'
  | 'mats'
  | 'lists'
  | 'tables'
  | 'missingData'
  | 'pointDims'
  | 'vecStates'
  | 'points'
  | 'sequences'
  | 'sequencePrefix'
>;
