import { type FigureForm, mapChildren } from './expr.ts';
/**
 * Point (2D and 3D vector) values and geometry statements.
 *
 * A constant whose right-hand side is a pair or triple — `A = (0, 0)`, `C = B + D` —
 * is a named point. A pair that depends on x, y, or z (`s = (x, y)`) is a
 * vector field: the same name still expands here, and `dot(s, s) = 1` is the
 * unit circle. Point arithmetic (±, scalar ×/÷, dot, cross, perp,
 * midpoint, unit, distance, angle, |P|) is lowered here into componentwise scalar expressions,
 * with a point name `A` expanding to the derived constants `A_x`, `A_y` (and `A_z` in space).
 * Lowering runs after resolveExpr (functions inlined, Σ expanded) and before
 * classify, so everything downstream — GLSL, evaluate, diff — still sees only
 * scalars, and points stay symbolic all the way to uniforms (dragging a point
 * never recompiles a shader).
 *
 * The statement forms segment/polyline/vector/polygon/square desugar to an
 * internal '[polygon]'-style call holding a flat scalar vertex list (classify
 * turns it into a CPU-drawn polygon plot); line and circle desugar to ordinary
 * implicit equations.
 *
 * Geometry calls preserve grouped tuple literals, so 2D and 3D arguments
 * retain their dimensions. Adjacent ungrouped scalar arguments still pair
 * into 2D points for compatibility.
 */
import { add, div, mul, neg, sub } from './diff.ts';
import { ANGLE_FN, type Expr, compArity, compDims, sameList } from './expr.ts';
import { SCALAR_REDUCTIONS, tupleAxis, withAxes } from './list.ts';
import {
  type GetMat,
  type Mat,
  type MatValue,
  detOf,
  expOf,
  hatOf,
  matAdd,
  matMul,
  matNeg,
  matPow,
  matScale,
  matVec,
  matrixFromRows,
  SHAPE_HINT,
  solveVec,
  traceOf,
} from './mat.ts';
import {
  type GetTensor,
  type Tensor,
  contract,
  fromMat,
  outer,
  product,
  rows,
  scalarTensor,
  shapeText,
  stack,
  tensorAdd,
  tensorNeg,
  tensorNode,
  tensorScale,
  toMat,
  vectorTensor,
  wedge,
} from './tensor.ts';

/** Whole-statement geometry forms (like SPECIAL_FORMS, they never nest). */
export const GEOM_STATEMENTS = new Set([
  'segment',
  'polyline',
  'vector',
  'line',
  'polygon',
  'square',
  'circle',
  'hull',
]);

/** The derived scalar constants a point named `name` expands to. */
export const pointComps = (name: string, dim = 2): string[] =>
  ['x', 'y', 'z'].slice(0, dim).map(axis => name + '_' + axis);

/** The derived scalar states an n-vector state expands to: om_1, om_2(, om_3). */
export const vecStateComps = (name: string, dim: number): string[] =>
  Array.from({ length: dim }, (_, k) => `${name}_${k + 1}`);

/** A vector value under lowering: 2 components (a point) or 3 (a 3-vector). */
type LV = { vec: false; e: Expr } | { vec: true; items: Expr[] };

const sc = (e: Expr): LV => ({ vec: false, e });
const vc = (...items: Expr[]): LV => ({ vec: true, items });
const toExpr = (v: LV): Expr => (v.vec ? { kind: 'vec', items: v.items } : v.e);

/**
 * Component names for a vector-valued definition, or null for scalars.
 * Named points return [A_x, A_y]; vector states return [om_1, om_2(, om_3)].
 */
export type GetComps = (name: string) => readonly string[] | null;

/** Whether a name is a list (so a measurement or figure can say lists wait). */
type IsList = (name: string) => boolean;

/** Functions over points, by how many point arguments they take. */
const POINT_FNS: Record<string, number> = { dot: 2, cross: 2, midpoint: 2, perp: 1, unit: 1 };
const ROTATE_USAGE = 'rotate takes rotate(P, angle), rotate(P, angle, center) in 2D, or rotate(P, angle, axis) in 3D.';

const sq = (e: Expr): Expr => mul(e, e);
const lenOfN = (items: Expr[]): Expr => {
  let s = sq(items[0]);
  for (let k = 1; k < items.length; k++) s = add(s, sq(items[k]));
  return { kind: 'call', name: 'sqrt', args: [s] };
};

/** Both vectors, same length — the shape componentwise arithmetic needs. */
function sameDims(op: string, a: LV, b: LV): asserts a is LV & { vec: true } {
  if (!a.vec || !b.vec) return;
  if (a.items.length !== b.items.length) {
    throw new Error(`Cannot ${op} a ${a.items.length}-component and a ${b.items.length}-component vector.`);
  }
}

/** Re-pair a lowered argument list into vectors of any dimension: vec args
 *  pass through, adjacent scalars (a flattened tuple literal) join into a 2D
 *  point. A scalar left without a partner throws `stray` — a message, or one
 *  made from that argument's index. */
function legacyPointArgs(args: LV[], stray: string | ((index: number) => string)): Expr[][] {
  const vs: Expr[][] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.vec) {
      vs.push(a.items);
      continue;
    }
    const b = args[i + 1];
    if (!b || b.vec) throw new Error(typeof stray === 'string' ? stray : stray(i));
    vs.push([a.e, b.e]);
    i++;
  }
  return vs;
}

/** legacyPointArgs for the figures, which are 2D only. `usage` is the argument list
 *  shown in the error, e.g. 'A' or 'A, B'. */
function pairPoints(name: string, args: LV[], usage: string): Array<[Expr, Expr]> {
  const vs = legacyPointArgs(args, `${name} takes points — write ${name}(${usage}), with A = (0, 0) defined above.`);
  const big = vs.find(v => v.length !== 2);
  if (big) throw new Error(`${name} takes 2D points, not ${big.length}-component vectors.`);
  return vs as Array<[Expr, Expr]>;
}

/** An argument that is itself a list: a literal, a named list, or a named
 *  matrix, read as its rows. (A list deeper inside — (L, 0),
 *  total(L), M A — is a scalar or a point by the time it matters.) */
const isListArg = (a: Expr, getMat: GetMat, isList: IsList): boolean =>
  a.kind === 'list' || a.kind === 'data' || (a.kind === 'var' && (isList(a.name) || getMat(a.name) !== null));

/** Why an argument that failed to be a point is list-shaped, if it is: a
 *  'list' value (L, 2L, -P, sort(L), sin(L)) or one 'element' of a list
 *  (P[1]). A reduction is one number, so total(L) is neither. */
function listShape(a: Expr, getMat: GetMat, isList: IsList): 'list' | 'element' | null {
  if (isListArg(a, getMat, isList)) return 'list';
  const first = (es: readonly Expr[]) => es.map(x => listShape(x, getMat, isList)).find(s => s !== null) ?? null;
  switch (a.kind) {
    case 'neg':
      return first([a.a]);
    case 'bin':
      return first([a.a, a.b]);
    case 'index':
      return 'element';
    case 'call':
      if (SCALAR_REDUCTIONS.has(a.name) || ((a.name === 'min' || a.name === 'max') && a.args.length === 1)) return null;
      return first(a.args);
    default:
      return null;
  }
}

const DISTANCE_USAGE =
  'distance takes two points: distance(A, B) with A = (0, 0) defined above, or distance((0, 0), (3, 4)).';
const ANGLE_USAGE =
  'angle takes three matching points — angle(A, B, C), the angle at B — or two vectors: angle(U, V). Points may be 2D or 3D.';

/** distance(A, B) ≡ |A - B|, in any dimension |A - B| has. `usage` is thrown
 *  for every arity failure: tuple literals arrive flattened — (1, 2, 3) is
 *  three loose scalars — so it is the one message true however they pair. */
function lowerDistance(args: LV[], usage: string, stray: (index: number) => string): Expr {
  const vs = legacyPointArgs(args, stray);
  if (vs.length !== 2) throw new Error(usage);
  const [p, q] = vs;
  if (p.length !== q.length) {
    throw new Error(`distance needs points with the same number of components, not ${p.length} and ${q.length}.`);
  }
  return lenOfN(p.map((pk, k) => sub(pk, q[k])));
}

/** angle(A, B, C), the angle at B turning from B→A to B→C, or angle(U, V):
 *  signed, counterclockwise positive, in (−π, π]. It lowers to one internal
 *  call over the two arms' components (see angleFn), so each component
 *  appears once however large it is. */
function lowerAngle(args: LV[], usage: string, stray: (index: number) => string): Expr {
  const vs = legacyPointArgs(args, stray);
  if (vs.length !== 2 && vs.length !== 3) throw new Error(usage);
  const dim = vs[0].length;
  if ((dim !== 2 && dim !== 3) || vs.some(v => v.length !== dim))
    throw new Error('angle needs points with matching dimensions.');
  const [u, v] = vs.length === 3 ? [vs[0].map((c, k) => sub(c, vs[1][k])), vs[2].map((c, k) => sub(c, vs[1][k]))] : vs;
  if (dim === 3) {
    const cross = u.map((_, k) => sub(mul(u[(k + 1) % 3], v[(k + 2) % 3]), mul(u[(k + 2) % 3], v[(k + 1) % 3])));
    const dot = u.map((c, k) => mul(c, v[k])).reduce(add);
    const valid = { kind: 'ineq', op: '>', l: mul(lenOfN(u), lenOfN(v)), r: { kind: 'num', value: 0 } } as Expr;
    return {
      kind: 'piecewise',
      cases: [{ cond: valid, value: { kind: 'call', name: 'atan2', args: [lenOfN(cross), dot] } }],
    };
  }
  return { kind: 'call', name: ANGLE_FN, args: [...u, ...v] };
}

const NOT_A_VALUE =
  'A matrix is not a value on its own — apply it to a vector, like M (x, y), or name it: R = e^(a J).';
const isE = (e: Expr): boolean => (e.kind === 'var' && e.name === 'e') || (e.kind === 'num' && e.value === Math.E);

/** Matrix-valued subexpressions met during one lowerGeom, so a long scalar
 *  chain asks "is this a matrix?" once per node rather than once per level. */
let matSeen = new WeakMap<Expr, MatValue | null>();
/**
 * Whether matrix algebra is live for this lowering. Nearly every row has no
 * matrix in it, and asking "is this a matrix?" at every node of a huge one is
 * real time — so lowering starts with the question switched off and costs
 * nothing. The only ways a matrix can enter are a matrix NAME, a tuple of
 * points and the generator cross(n); meeting any throws MatrixSeen, and the
 * expression is lowered again with the question switched on.
 */
let matsPossible = false;
/** The values `[comp]` nodes pick from, lowered once per lowerGeom however
 *  many components ask: f(f(f(A))) shares its argument n^depth times over.
 *  `wait` is a value that is no point yet but may be a list of them, left
 *  (as `wait`) for list lowering. */
let compSeen = new WeakMap<Expr, LV | { wait: Expr }>();
/** Tensor-valued subexpressions met during one lowerGeom (see lowerTensor). */
let tenSeen = new WeakMap<Expr, Tensor | null>();
/** Named tensors for the lowering under way. Like the caches above it lives
 *  for one call: lowering is synchronous, and threading it through every
 *  recursive call would touch every caller of lower() for one lookup. */
let tensorNamed: GetTensor = () => null;
let listNamed: IsList = () => false;
class MatrixSeen extends Error {}
function fresh(getTensor: GetTensor, isList: IsList, possible: boolean): void {
  matSeen = new WeakMap();
  compSeen = new WeakMap();
  tenSeen = new WeakMap();
  tensorNamed = getTensor;
  listNamed = isList;
  matsPossible = possible;
}
function withMatrices<T>(getTensor: GetTensor, isList: IsList, run: () => T): T {
  fresh(getTensor, isList, false);
  try {
    return run();
  } catch (err) {
    if (!(err instanceof MatrixSeen)) throw err;
    fresh(getTensor, isList, true);
    return run();
  }
}

/** ⊗, ∧ and their spellings outer(…), wedge(…), contract(…): a tensor operation. */
const tensorOp = (e: Expr): boolean =>
  (e.kind === 'bin' && (e.glyph === 'outer' || e.glyph === 'wedge')) ||
  (e.kind === 'call' && (e.name === 'outer' || e.name === 'wedge' || e.name === 'contract'));

/** Whether a tuple literal holds a row that is no point — a longer tuple, or
 *  a tuple of tuples — so it may be a tensor rather than a tuple of points. */
const deepTupleRow = (e: Expr): boolean =>
  e.kind === 'vec' && (e.items.length > 3 || e.items.some(it => it.kind === 'vec'));
const deepTuple = (e: Expr): boolean => e.kind === 'vec' && e.items.some(deepTupleRow);

const NOT_A_TENSOR_VALUE = (t: Tensor): string =>
  `${shapeText(t.shape).replace('a', 'A')} is not a number or a point here — contract it, like contract(T, 1, 2), or give it a row of its own to read it.`;

/** A constant whole-number argument, such as an index of contract. */
function constIndex(e: Expr, what: string): number {
  let v = NaN;
  if (e.kind === 'num') v = e.value;
  else if (e.kind === 'neg' && e.a.kind === 'num') v = -e.a.value;
  if (!Number.isInteger(v)) throw new Error(`${what} is a whole number written out, like contract(T, 1, 2) or T[2].`);
  return v;
}

/**
 * A tensor-valued expression that matrix algebra alone cannot read: a
 * tensor name, a nested tuple deeper or wider than a matrix, ⊗, ∧,
 * contract, or algebra over any of them — or null. (A square matrix and its
 * algebra stay lowerMat's, so every matrix path keeps its exact expressions
 * and messages; the product of two tensors that happens to be square is
 * handed back to it as a matrix.)
 */
function lowerTensor(e: Expr, lo: (n: Expr) => LV, getMat: GetMat): Tensor | null {
  if (!matsPossible) return null;
  if (tenSeen.has(e)) return tenSeen.get(e)!;
  // A cycle guard: a node under way is not a tensor to itself.
  tenSeen.set(e, null);
  const of = (n: Expr): Tensor | null => lowerTensor(n, lo, getMat);
  const found = ((): Tensor | null => {
    switch (e.kind) {
      case 'var':
        return tensorNamed(e.name);
      case 'vec': {
        if (!e.items.some(it => of(it) || deepTupleRow(it))) return null;
        const t = tupleTensor(e, lo, getMat);
        // A tuple of points that is not square is a tuple of points (§3).
        return t.shape.length === 2 && (t.shape[1] === 2 || t.shape[1] === 3) && !e.items.some(of) ? null : t;
      }
      case 'neg': {
        const a = of(e.a);
        return a && tensorNeg(a);
      }
      case 'bin': {
        const any = (n: Expr) => anyTensor(n, lo, getMat);
        if (e.glyph === 'outer' || e.glyph === 'wedge')
          return (e.glyph === 'outer' ? outer : wedge)(any(e.a), any(e.b));
        const a = of(e.a);
        const b = of(e.b);
        if (!a && !b) {
          // T Q with T a tuple of points: the consumer reads it as a matrix
          // (docs/multisets.md §3), n×k — the rectangular matvec and product.
          // (Scaled, 2 T, it stays a tuple of points; on the right, M T, each
          // of its points is moved.)
          const l = e.op === '*' ? pointRows(e.a, lo, getMat) : null;
          if (!l) {
            // v T, a vector on the left of a tuple of points that is not
            // square: the contraction v_i T_ij, a vector of T's width. (On
            // a square matrix M v is the one order.)
            const r = e.op === '*' ? pointRows(e.b, lo, getMat) : null;
            if (!r || r.shape[0] === r.shape[1]) return null;
            const v = lo(e.a);
            return v.vec ? product(vectorTensor(v.items), r) : null;
          }
          const r = pointRows(e.b, lo, getMat) ?? lowerMat(e.b, lo, getMat);
          const v = r ? null : lo(e.b);
          if (r) return product(l, 'm' in r ? fromMat(r.m) : r);
          return v?.vec ? product(l, vectorTensor(v.items)) : null;
        }
        switch (e.op) {
          case '+':
          case '-':
            return tensorAdd(any(e.a), any(e.b), e.op === '-');
          case '*': {
            const l = any(e.a);
            const r = any(e.b);
            if (!l.shape.length) return tensorScale(r, l.data[0]);
            if (!r.shape.length) return tensorScale(l, r.data[0]);
            return product(l, r);
          }
          case '/': {
            const r = any(e.b);
            if (!a || r.shape.length) throw new Error('Cannot divide by a tensor.');
            return tensorScale(a, { kind: 'bin', op: '/', a: { kind: 'num', value: 1 }, b: r.data[0] });
          }
        }
        // (A power is matrix algebra: e^(th e_x ∧ e_y) is lowerMat's.)
        return null;
      }
      case 'index': {
        // T[k]: the k-th slice along the first index, as M[2] is a row.
        const t = of(e.args[0]);
        if (!t) return null;
        const k = constIndex(e.args[1], 'A tensor index');
        if (k < 1 || k > t.shape[0])
          throw new Error(`That tensor has ${t.shape[0]} rows along its first index; ${k} is not one.`);
        return rows(t)[k - 1];
      }
      case 'call': {
        if (!tensorOp(e)) return null;
        const any = (n: Expr) => anyTensor(n, lo, getMat);
        if (e.name === 'contract') {
          if (e.args.length !== 3) {
            throw new Error('contract takes a tensor and two of its indices: contract(T, 1, 2) sums T_ii… over i.');
          }
          const [t, i, j] = e.args;
          return contract(any(t), constIndex(i, 'An index') - 1, constIndex(j, 'An index') - 1);
        }
        if (e.args.length < 2) throw new Error(`${e.name} takes two or more vectors or tensors: ${e.name}(a, b).`);
        const f = e.name === 'outer' ? outer : wedge;
        return e.args.slice(1).reduce((acc, n) => f(acc, any(n)), any(e.args[0]));
      }
      default:
        return null;
    }
  })();
  tenSeen.set(e, found);
  return found;
}

/** A tuple of points that is no square matrix — written out, or named — as
 *  the rank-2 tensor of its rows; null for anything else. */
function pointRows(n: Expr, lo: (n: Expr) => LV, getMat: GetMat): Tensor | null {
  if (n.kind === 'var') {
    const t = tensorNamed(n.name, true);
    return t?.shape.length === 2 ? t : null;
  }
  if (n.kind !== 'vec' || n.items.length < 2 || lowerMat(n, lo, getMat)) return null;
  const rows = n.items.map(lo);
  if (!rows.every(r => r.vec)) return null;
  return stack(rows.map(r => vectorTensor((r as LV & { vec: true }).items)));
}

/** A tuple literal read as a tensor: its rows, stacked. */
function tupleTensor(e: Expr & { kind: 'vec' }, lo: (n: Expr) => LV, getMat: GetMat): Tensor {
  const rows = e.items.map(it => anyTensor(it, lo, getMat));
  const t = stack(rows);
  if (!t) {
    const shapes = [...new Set(rows.map(r => shapeText(r.shape)))];
    throw new Error(`The rows of a tensor need one shape, not ${shapes.join(' and ')}.`);
  }
  return t;
}

/**
 * Any value read as a tensor, for an operation on tensors: a number is rank
 * 0, a point or a longer tuple rank 1, a matrix rank 2. A name that is a
 * list is refused rather than read as a number, so the row is expanded
 * element by element instead (object-lists.ts) — each point of it then a
 * vector here.
 */
function anyTensor(n: Expr, lo: (n: Expr) => LV, getMat: GetMat): Tensor {
  const t = lowerTensor(n, lo, getMat);
  if (t) return t;
  const m = lowerMat(n, lo, getMat);
  if (m) return fromMat(m.m);
  if (n.kind === 'vec' && n.items.length > 3) return tupleTensor(n, lo, getMat);
  if (n.kind === 'var') {
    // A tuple of points named earlier is a rank-2 tensor to ⊗ and ∧.
    const tuple = tensorNamed(n.name, true);
    if (tuple) return tuple;
  }
  const v = lo(n);
  if (v.vec) return vectorTensor(v.items);
  if (v.e.kind === 'vec') return tupleTensor(v.e, lo, getMat);
  if (listShape(n, getMat, listNamed) === 'list') {
    // (Unnamed, the row is expanded element by element and this never shows.)
    throw new Error('A multiset of tensors cannot be named yet — write it on a row of its own.');
  }
  return scalarTensor(v.e);
}

/**
 * A matrix-valued expression — a named matrix, a tuple of rows
 * `((a, b), (c, d))`, or algebra over them: `s M`, `M / s`, `-M`, `M + N`,
 * `M N`, `M^n`, `e^M` / `exp(M)`, and the rotation generator `cross(n)` — or
 * null for anything else.
 */
function lowerMat(e: Expr, lo: (n: Expr) => LV, getMat: GetMat): MatValue | null {
  if (!matsPossible) return null;
  if (matSeen.has(e)) return matSeen.get(e)!;
  const of = (n: Expr): MatValue | null => lowerMat(n, lo, getMat);
  const scalar = (n: Expr, what: string): Expr => {
    const v = lo(n);
    if (v.vec) throw new Error(`Cannot ${what} a matrix by a point — M v applies it.`);
    return v.e;
  };
  // ⊗, ∧, contract and tensors of other shapes: a matrix when square. Matrix
  // algebra reads its own spine first (e^(th J) needs th kept apart), and a
  // product of tensors it cannot read, (2×3)(3×2), comes back square here.
  const square = (): MatValue | null => {
    const t = lowerTensor(e, lo, getMat);
    const m = t && toMat(t);
    return m && { m };
  };
  const first = tensorOp(e) || e.kind === 'vec' || e.kind === 'var';
  const found = ((): MatValue | null => {
    if (first) {
      const t = lowerTensor(e, lo, getMat);
      if (t) {
        const m = toMat(t);
        return m && { m };
      }
    }
    switch (e.kind) {
      case 'var': {
        const m = getMat(e.name);
        return m && { m };
      }
      case 'neg': {
        const a = of(e.a);
        return a && matNeg(a);
      }
      case 'bin': {
        if (e.op === '^') {
          const power = of(e.b);
          if (power) {
            if (!isE(e.a)) throw new Error('Only e takes a matrix power: e^(a J) is the rotation by a.');
            return { m: expOf(power) };
          }
          const a = of(e.a);
          if (!a) return null;
          const n = e.b.kind === 'neg' && e.b.a.kind === 'num' ? -e.b.a.value : e.b.kind === 'num' ? e.b.value : NaN;
          return { m: matPow(a.m, n) };
        }
        const a = of(e.a);
        const b = of(e.b);
        if (!a && !b) return null;
        switch (e.op) {
          case '+':
          case '-':
            if (!a || !b) {
              const verb = e.op === '+' ? 'add' : 'subtract';
              // A point beside a tuple of points moves each of them: the
              // point is added to every row, wherever T is written, so
              // `T + p` means one thing on a row, in a definition and in a
              // figure (docs/multisets.md §9).
              const p = lo(a ? e.b : e.a);
              if (p.vec) {
                const m = (a ?? b)!.m;
                if (p.items.length !== m[0].length) {
                  throw new Error(
                    `Cannot ${verb} a ${p.items.length}D point and a tuple of ${m[0].length}D points — each row takes a point of its own size.`,
                  );
                }
                const op = e.op === '+' ? add : sub;
                return {
                  m: m.map(row => row.map((entry, c) => (a ? op(entry, p.items[c]) : op(p.items[c], entry)))),
                };
              }
              throw new Error(`Cannot ${verb} a matrix and a number — use a multiple of the identity.`);
            }
            return { m: matAdd(a.m, b.m, e.op === '-') };
          case '*':
            if (a && b) return { m: matMul(a.m, b.m) };
            // M v is a vector, not a matrix: the caller applies it.
            if (a) {
              const v = lo(e.b);
              return v.vec ? null : matScale(a, v.e);
            }
            return matScale(b!, scalar(e.a, 'multiply'));
          case '/':
            if (!a || b)
              throw new Error('Cannot divide by a matrix — multiply by M^-1. (a/2 J reads as a/(2 J): write (a/2) J.)');
            return matScale(a, div({ kind: 'num', value: 1 }, scalar(e.b, 'divide')));
        }
        return null;
      }
      case 'vec': {
        // A tuple of rows — ((a, b), (c, d)), or named points (A, B) — is a
        // matrix when it is square. Anything else is left to lower(), which
        // says what that tuple is instead.
        const rows = e.items.map(lo);
        if (!rows.every(r => r.vec)) return null;
        const m = matrixFromRows(rows.map(r => (r as LV & { vec: true }).items));
        return m && { m };
      }
      case 'call': {
        if (e.name === 'exp' && e.args.length === 1) {
          const a = of(e.args[0]);
          return a && { m: expOf(a) };
        }
        // cross(n, v) with its v left off: the matrix of v ↦ n × v.
        if (e.name === 'cross' && e.args.length === 1) {
          const n = lo(e.args[0]);
          if (!n.vec || n.items.length !== 3)
            throw new Error('cross(n) is the rotation generator about a 3D axis: e^(a cross((0, 0, 1))) v.');
          return { m: hatOf(n.items) };
        }
        return null;
      }
      default:
        return null;
    }
  })();
  const value = found ?? (first ? null : square());
  matSeen.set(e, value);
  return value;
}

function lower(e: Expr, getComps: GetComps, getMat: GetMat, isList: IsList): LV {
  const lo = (n: Expr): LV => lower(n, getComps, getMat, isList);
  const matOf = (n: Expr): MatValue | null => lowerMat(n, lo, getMat);
  if (
    e.kind === 'var' ||
    e.kind === 'vec' ||
    e.kind === 'neg' ||
    e.kind === 'bin' ||
    e.kind === 'call' ||
    e.kind === 'index'
  ) {
    if (!matsPossible) {
      if (
        tensorOp(e) ||
        deepTuple(e) ||
        (e.kind === 'var' && tensorNamed(e.name)) ||
        // T v: a named tuple of points applied as a matrix (see lowerTensor),
        // and v T, a vector contracted with one.
        (e.kind === 'bin' &&
          e.op === '*' &&
          ((e.a.kind === 'var' && tensorNamed(e.a.name, true)?.shape.length === 2) ||
            (e.b.kind === 'var' && tensorNamed(e.b.name, true)?.shape.length === 2 && lo(e.a).vec)))
      )
        throw new MatrixSeen();
    } else {
      // A tensor operation's result is whatever rank it comes to: a number
      // (contract(M, 1, 2)), a vector (T v), or a tensor, which only a
      // consumer of tensors — or a row of its own — can take.
      const t = lowerTensor(e, lo, getMat);
      if (t) {
        if (!t.shape.length) return sc(t.data[0]);
        if (t.shape.length === 1) {
          return t.data.length === 2 || t.data.length === 3 ? vc(...t.data) : sc({ kind: 'vec', items: [...t.data] });
        }
        // (A square one is a matrix, and the matrix paths below say what it may do.)
        if (!toMat(t)) throw new Error(NOT_A_TENSOR_VALUE(t));
      }
    }
  }
  switch (e.kind) {
    case 'index':
    case 'range':
    case 'eqtest':
    case 'figure':
    case 'lazy':
    case 'trail':
    case 'label':
    case 'hist':
    case 'family':
      return sc(
        mapChildren(e, n => {
          const v = lo(n);
          return v.vec ? { kind: 'vec', items: v.items } : v.e;
        }),
      );
    case 'num':
      return sc(e);
    case 'var': {
      if (getMat(e.name)) {
        if (!matsPossible) throw new MatrixSeen();
        throw new Error(
          `${e.name} is a matrix — use ${e.name} v, solve(${e.name}, v), det(${e.name}), or trace(${e.name}).`,
        );
      }
      const comps = getComps(e.name);
      if (!comps) return sc(e);
      return vc(...comps.map((name): Expr => ({ kind: 'var', name })));
    }
    case 'neg': {
      if (matOf(e)) throw new Error(NOT_A_VALUE);
      const a = lo(e.a);
      if (a.vec) return vc(...a.items.map(neg));
      return a.e === e.a ? sc(e) : sc({ kind: 'neg', a: a.e });
    }
    case 'bin': {
      // The matvec M v: a matrix name as the direct left factor of a product.
      if (e.op === '*') {
        const m = matOf(e.a)?.m;
        const v = m && !matOf(e.b) ? lo(e.b) : null;
        if (m && v?.vec) {
          if (v.items.length !== m.length) {
            const name = e.a.kind === 'var' ? e.a.name : 'That matrix';
            throw new Error(
              `${name} is ${m.length}×${m.length}, so it multiplies a ${m.length}-component vector: ${e.a.kind === 'var' ? e.a.name : 'M'} (x, y${m.length === 3 ? ', z' : ''}).`,
            );
          }
          return vc(...matVec(m, v.items));
        }
        if (!m && matOf(e.b) && lo(e.a).vec) {
          throw new Error(`Matrices multiply on the left — write ${e.b.kind === 'var' ? e.b.name : 'M'} v.`);
        }
      }
      if (matOf(e)) throw new Error(NOT_A_VALUE);
      const a = lo(e.a);
      const b = lo(e.b);
      if (!a.vec && !b.vec) {
        // Untouched scalar subtrees pass through unchanged, so existing plots
        // keep their exact GLSL (and shader cache keys).
        if (a.e === e.a && b.e === e.b) return sc(e);
        return sc({ kind: 'bin', op: e.op, a: a.e, b: b.e });
      }
      switch (e.op) {
        case '+':
        case '-':
          if (a.vec && b.vec) {
            sameDims(e.op === '+' ? 'add' : 'subtract', a, b);
            const f = e.op === '+' ? add : sub;
            return vc(...a.items.map((ai, k) => f(ai, (b as LV & { vec: true }).items[k])));
          }
          throw new Error(`Cannot ${e.op === '+' ? 'add' : 'subtract'} a point and a number.`);
        case '*':
          if (a.vec && b.vec) {
            // A · B and A × B, as written; a plain * between points has no one meaning.
            if (e.glyph) return lower({ kind: 'call', name: e.glyph, args: [e.a, e.b] }, getComps, getMat, isList);
            throw new Error('Use A · B or A × B (or dot(A, B), cross(A, B)) to multiply points.');
          }
          if (a.vec && !b.vec) return vc(...a.items.map(ai => mul(ai, (b as LV & { vec: false }).e)));
          if (!a.vec && b.vec) return vc(...b.items.map(bi => mul((a as LV & { vec: false }).e, bi)));
          break;
        case '/':
          if (a.vec && !b.vec) return vc(...a.items.map(ai => div(ai, (b as LV & { vec: false }).e)));
          throw new Error('Cannot divide by a point.');
        case '^':
          throw new Error('Cannot raise a point to a power — |A| is its length.');
      }
      break;
    }
    case 'comp': {
      // f(P): component k of the one argument, once it is known to be a point.
      const { value, index: k, arity: n, functionName: fn } = e;
      let v = compSeen.get(value);
      // A matrix (a name, or algebra over one: 2 S) has no meaning of its own
      // to a function of scalars, so it is what it is wherever a call asks
      // for points — hull(S), distance(S, A): the list of its rows. (A tuple
      // of 2 points IS a 2×2 matrix; f must not refuse it for that.)
      const m = !v && ((value.kind === 'var' ? getMat(value.name) : null) ?? matOf(value)?.m);
      if (m) {
        if (m.length !== n) throw new Error(compDims(fn, n, value, m.length));
        const rows = rowsAsPoints(m, value.kind === 'var' ? value.name : undefined);
        compSeen.set(value, (v = { wait: rows }));
      }
      if (!v) {
        const listy = (): boolean => listShape(value, getMat, isList) !== null;
        try {
          const low = lo(value);
          v = low.vec || !listy() ? low : { wait: low.e };
        } catch (err) {
          // Point-list arithmetic (P + (1, 0), R P) is no point here either:
          // it is the object expansion's, which finds the list inside.
          if (err instanceof MatrixSeen || !listy()) throw err;
          v = { wait: value };
        }
        compSeen.set(value, v);
      }
      if ('wait' in v) return sc({ ...e, value: v.wait });
      if (!v.vec) throw new Error(compArity(fn, n));
      if (v.items.length !== n) throw new Error(compDims(fn, n, value, v.items.length));
      return sc(v.items[k]);
    }
    case 'call': {
      if (GEOM_STATEMENTS.has(e.name)) throw new Error(`${e.name}(…) must be a whole statement.`);
      if (e.name === 'trail') {
        const args = e.args.map(lo);
        const coords =
          args.length === 1 && args[0].vec
            ? args[0].items
            : args.every(a => !a.vec)
              ? args.map(a => (a as LV & { vec: false }).e)
              : [];
        if (coords.length !== 2 && coords.length !== 3) {
          throw new Error('trail takes a 2D or 3D point: trail(A) or trail((cos(t), sin(t))).');
        }
        return sc({ kind: 'trail', coordinates: coords });
      }
      if (e.name === 'label') {
        // The text comes last; the point before it arrives as one vector
        // (label(A, …)) or, from a tuple literal, as its spread coordinates.
        const text = e.args.at(-1);
        // One text only: an extra string would read as a third coordinate.
        if (e.args.slice(0, -1).some(a => a.kind === 'str')) {
          throw new Error('label takes one quoted text, after the point: label((1, 2), "peak").');
        }
        const args = e.args.slice(0, -1).map(lo);
        const coords =
          args.length === 1 && args[0].vec
            ? args[0].items
            : args.every(a => !a.vec)
              ? args.map(a => (a as LV & { vec: false }).e)
              : [];
        if ((coords.length !== 2 && coords.length !== 3) || text?.kind !== 'str') {
          throw new Error('label takes a point and quoted text: label(A, "vertex") or label((1, 2), "peak").');
        }
        return sc({ kind: 'label', coordinates: coords, text: text.value });
      }
      if (!matsPossible && e.name === 'cross' && e.args.length === 1) throw new MatrixSeen();
      if (matOf(e)) throw new Error(NOT_A_VALUE);
      if (e.name === 'rotate') {
        // rotate(P, a[, center]) ≡ C + e^(a J) (P − C); rotate(P, a, axis) ≡
        // e^(a cross(axis/|axis|)) P. Flattened tuples are told apart by count.
        const flat = e.args.map(lo).flatMap(a => (a.vec ? a.items : [a.e]));
        if (flat.length === 7) {
          const axis = flat.slice(4);
          const turn = expOf(matScale({ m: hatOf(axis) }, div(flat[3], lenOfN(axis))));
          return vc(...matVec(turn, flat.slice(0, 3)));
        }
        if (flat.length !== 3 && flat.length !== 5) throw new Error(ROTATE_USAGE);
        const num0: Expr = { kind: 'num', value: 0 };
        const c = flat.length === 5 ? flat.slice(3) : [num0, num0];
        const turn = expOf(
          matScale(
            {
              m: [
                [num0, { kind: 'num', value: -1 }],
                [{ kind: 'num', value: 1 }, num0],
              ],
            },
            flat[2],
          ),
        );
        return vc(...matVec(turn, [sub(flat[0], c[0]), sub(flat[1], c[1])]).map((p, k) => add(c[k], p)));
      }
      if (e.name === 'det' || e.name === 'trace' || e.name === 'solve') {
        const matArg = (raw: Expr | undefined): ReturnType<GetMat> => {
          if (!raw) return null;
          // A matrix — named, a tuple of rows, or algebra over them — is only
          // read with matrix algebra on: switch it on.
          if (!matsPossible) throw new MatrixSeen();
          return matOf(raw)?.m ?? null;
        };
        const m = matArg(e.args[0]);
        if (!m) {
          throw new Error(`${e.name} takes a matrix — define one with M = ((a, b), (c, d)).`);
        }
        if (e.name === 'det' || e.name === 'trace') {
          if (e.args.length !== 1) throw new Error(`${e.name} takes one matrix.`);
          return sc(e.name === 'det' ? detOf(m) : traceOf(m));
        }
        // solve(M, v): the remaining arguments are the right-hand side — one
        // vector, or its components flattened out of a tuple literal.
        const rest = e.args.slice(1).map(lo);
        let v: Expr[];
        if (rest.length === 1 && rest[0].vec) v = rest[0].items;
        else if (rest.length === m.length && rest.every(r => !r.vec)) {
          v = rest.map(r => (r as LV & { vec: false }).e);
        } else {
          throw new Error(`solve takes solve(M, v) with v a ${m.length}-component vector.`);
        }
        if (v.length !== m.length) {
          throw new Error(`${m.length}×${m.length} matrix, ${v.length}-component vector — solve needs them to match.`);
        }
        return vc(...solveVec(m, v));
      }
      if (e.name === 'distance' || e.name === 'angle') {
        // Scalars like dot and cross: they work inside any expression, read out
        // as a bare row, and draw nothing (an arc marker would be its own
        // wrapper, not a side effect of the readout). Lists inside a component
        // broadcast later like any scalar's; a list *as* an argument would be
        // a list of points, which is plan #13's.
        const usage = e.name === 'distance' ? DISTANCE_USAGE : ANGLE_USAGE;
        const form = e.name === 'distance' ? 'distance(A, B)' : 'angle(A, B, C)';
        const listy = `${e.name} takes points, and a list cannot stand for a point yet — ${form}, one point each.`;
        // The argument left without a partner says what went wrong: a list,
        // an element of one (a point on its own row, but not yet a point
        // *value* — P[1] + A fails the same way; plan #13), or a plain number.
        const stray = (index: number): string => {
          const shape = listShape(e.args[index], getMat, isList);
          if (shape === 'list') return listy;
          if (shape === 'element') {
            return `${e.name} takes points, and an element of a list cannot stand for a point yet — name the point (Q = (1, 1)) and write ${form}.`;
          }
          return usage;
        };
        // (A named matrix is a list of rows here, which lowering would reject first.)
        if (e.args.some(a => a.kind === 'var' && getMat(a.name) !== null)) throw new Error(listy);
        const args = e.args.map(lo);
        return sc(e.name === 'distance' ? lowerDistance(args, usage, stray) : lowerAngle(args, usage, stray));
      }
      const args = e.args.map(lo);
      const nPts = Object.hasOwn(POINT_FNS, e.name) ? POINT_FNS[e.name] : undefined;
      if (nPts !== undefined) {
        // Vector args of any dim pass straight through; runs of flattened
        // scalars still pair into 2D points as before.
        const vs = legacyPointArgs(
          args,
          `${e.name} takes points — write ${e.name}(${nPts === 1 ? 'A' : 'A, B'}), with A = (0, 0) defined above.`,
        );
        if (vs.length !== nPts) {
          throw new Error(`${e.name} takes ${nPts} point${nPts === 1 ? '' : 's'}.`);
        }
        const dim = vs[0].length;
        if (vs.some(v => v.length !== dim)) {
          throw new Error(`${e.name} needs vectors with the same number of components.`);
        }
        const twoOnly = () => {
          if (dim !== 2) throw new Error(`${e.name} is only defined for 2D points.`);
        };
        const p = vs[0];
        const q = vs[1];
        switch (e.name) {
          case 'dot': {
            let s = mul(p[0], q[0]);
            for (let k = 1; k < dim; k++) s = add(s, mul(p[k], q[k]));
            return sc(s);
          }
          case 'cross':
            if (dim === 3)
              return vc(
                ...p.map((_, k) => sub(mul(p[(k + 1) % 3], q[(k + 2) % 3]), mul(p[(k + 2) % 3], q[(k + 1) % 3]))),
              );
            twoOnly();
            return sc(sub(mul(p[0], q[1]), mul(p[1], q[0])));
          case 'midpoint':
            return vc(...p.map((pk, k) => div(add(pk, q[k]), num2)));
          case 'perp':
            twoOnly();
            return vc(neg(p[1]), p[0]);
          case 'unit':
            return vc(...p.map(pk => div(pk, lenOfN(p))));
        }
      }
      // |P| is a point's length; |(3, 4)| arrives as abs(3, 4) because the
      // tuple flattens into the argument list, so a scalar pair re-pairs too.
      if (e.name === 'abs' && args.length === 1 && args[0].vec) {
        return sc(lenOfN(args[0].items));
      }
      if (e.name === 'abs' && args.length === 2) {
        const pts = pairPoints('abs', args, 'A');
        if (pts.length === 1) return sc(lenOfN([pts[0][0], pts[0][1]]));
      }
      // sort(P, P.x) orders points by a key; list lowering does the sorting,
      // and a point stays one value there (docs/multisets.md §3).
      // count, total and mean take any multiset, points included (§3): a
      // computed one, 2 [(1, 2), (3, 4)], arrives here as a point of lists.
      if (e.name === 'sort' || (['count', 'total', 'mean'].includes(e.name) && args.length === 1 && args[0].vec))
        return sc({ kind: 'call', name: e.name, args: args.map(toExpr) });
      const flatArgs: Expr[] = [];
      for (const a of args) {
        if (a.vec) throw new Error(`${e.name} is not defined for points.`);
        flatArgs.push(a.e);
      }
      if (flatArgs.every((a, k) => a === e.args[k])) return sc(e);
      return sc({ kind: 'call', name: e.name, args: flatArgs });
    }
    case 'eq': {
      const l = lo(e.l);
      const r = lo(e.r);
      if (l.vec !== r.vec) throw new Error('One side is a point and the other is a number.');
      if (!l.vec && l.e === e.l && (r as LV & { vec: false }).e === e.r) return sc(e);
      return sc({ kind: 'eq', l: toExpr(l), r: toExpr(r) });
    }
    case 'ineq': {
      const l = lo(e.l);
      const r = lo(e.r);
      if (l.vec || r.vec) throw new Error('Points cannot be compared — compare |A - B| instead.');
      if (l.e === e.l && r.e === e.r) return sc(e);
      return sc({ kind: 'ineq', op: e.op, l: l.e, r: r.e });
    }
    case 'vec': {
      const items = e.items.map(lo);
      if (items.some(a => a.vec)) {
        if (items.every(a => a.vec)) {
          // A tuple of points is a matrix: it is read again with matrix
          // algebra on, so a consumer — M v, det(M), a definition — sees it
          // as one. Reaching here with it on, nothing consumed it.
          if (!matsPossible) throw new MatrixSeen();
          const square = matOf(e) !== null;
          const dims = new Set(items.map(a => (a as LV & { vec: true }).items.length));
          // Not square, so not a matrix here: a tuple of points, which list
          // lowering keeps in order for polyline(T), T[k] and friends.
          if (!square && dims.size === 1) return sc({ kind: 'vec', items: items.map(toExpr) });
          // Two points of one dimension may well have meant the segment.
          if (e.items.length === 2 && dims.size === 1) {
            throw new Error(
              'A pair of points is a 2×2 matrix, not a figure — segment(A, B) joins them, and M (x, y) applies the matrix.',
            );
          }
          throw new Error(square ? NOT_A_VALUE : `A matrix is 2×2 or 3×3 — ${SHAPE_HINT}.`);
        }
        throw new Error('A point cannot be a component of a vector.');
      }
      const flat = items.map(a => (a as LV & { vec: false }).e);
      // 2- and 3-vectors become vector values so arithmetic works on both;
      // toExpr rebuilds the same node shape for anything that reaches root.
      if (e.items.length === 2 || e.items.length === 3) return vc(...flat);
      if (flat.every((f, k) => f === e.items[k])) return sc(e);
      return sc({ kind: 'vec', items: flat });
    }
    // Data and text lists hold no geometry: they pass straight through to
    // list lowering, which is the pass that knows what to do with them.
    case 'data':
    case 'str':
    case 'text':
      return sc(e);
    case 'list': {
      // Items lower independently; a named point becomes its (A_x, A_y) vec,
      // so [A, B] scatters named points like [(1, 2), (3, 4)] does literals.
      const items = e.items.map(a => toExpr(lo(a)));
      if (items.every((it, k) => it === e.items[k])) return sc(e);
      return sc(sameList(e, { kind: 'list', items }));
    }
    case 'piecewise': {
      const one = (n: Expr): Expr => {
        const v = lo(n);
        if (v.vec) throw new Error('Points cannot appear in a piecewise expression.');
        return v.e;
      };
      const cases = e.cases.map(c => ({ cond: one(c.cond), value: one(c.value) }));
      const otherwise = e.otherwise && one(e.otherwise);
      if (
        otherwise === e.otherwise &&
        cases.every((c, k) => c.cond === e.cases[k].cond && c.value === e.cases[k].value)
      )
        return sc(e);
      return sc({ kind: 'piecewise', cases, otherwise });
    }
    case 'loop':
      return sc(
        mapChildren(e, n => {
          const v = lo(n);
          if (v.vec) throw new Error('Points cannot pass through a recursive function.');
          return v.e;
        }),
      );
  }
  throw new Error('Unreachable');
}

const num2: Expr = { kind: 'num', value: 2 };
const VECTOR_USAGE = 'vector takes one or two points: vector(A, B) from A to B, or vector(V) from the origin.';
const spaceVar = (name: 'x' | 'y'): Expr => ({ kind: 'var', name });

/** Internal figure calls with flat scalar vertices: '[segment]' and
 *  '[polyline]' are open, '[vector]' is open with an arrowhead at its last
 *  vertex, '[polygon]' and '[square]' close and fill (otherwise the name only
 *  differs so classify can word its errors after the statement the user
 *  wrote). */
export type FigureName = '[polygon]' | '[segment]' | '[polyline]' | '[vector]' | '[square]' | '[hull]';
const polyCall = (name: FigureName, pts: Expr[][]): Expr => ({
  kind: 'figure',
  form: name.slice(1, -1) as FigureForm,
  dimension: pts[0].length as 2 | 3,
  vertices: pts.flat(),
});

/** A matrix consumed as its rows: a tuple of points, in order (docs/multisets.md
 *  §3), so polyline(M) walks them and M[2] is the second. Named rows share
 *  axes across all calls. */
export function rowsAsPoints(matrix: Mat, name?: string): Expr & { kind: 'list' } {
  const rows: Expr & { kind: 'list' } = { kind: 'list', items: matrix.map(items => ({ kind: 'vec', items })) };
  return withAxes(rows, name ? [{ id: `${name}#0`, n: matrix.length, ordered: true }] : [tupleAxis(matrix.length)]);
}

/** A definition whose value is a matrix (`R = e^(a J)`, `N = 2 M`), or null. */
export function lowerMatrix(
  e: Expr,
  getComps: GetComps,
  getMat: GetMat,
  getTensor: GetTensor = () => null,
  isList: IsList = () => false,
): Mat | null {
  // Only the matrix-algebra spine can make a matrix: look along it for one.
  const spine = (n: Expr): boolean => {
    if (tensorOp(n)) return true;
    switch (n.kind) {
      case 'var':
        return getMat(n.name) !== null || getTensor(n.name) !== null;
      // T[2], a slice of a tensor.
      case 'index':
        return n.args[0].kind !== 'var' || getTensor(n.args[0].name) !== null ? spine(n.args[0]) : false;
      // A tuple with a row in it: ((a, b), (c, d)), or named points (A, B).
      case 'vec':
        return (
          (n.items.length === 2 || n.items.length === 3) &&
          n.items.some(it => it.kind === 'vec' || (it.kind === 'var' && getComps(it.name) !== null))
        );
      case 'neg':
        return spine(n.a);
      case 'bin':
        return spine(n.a) || spine(n.b);
      case 'call':
        return (
          (n.name === 'cross' && n.args.length === 1) || (n.name === 'exp' && n.args.length === 1 && spine(n.args[0]))
        );
      default:
        return false;
    }
  };
  if (!spine(e)) return null;
  fresh(getTensor, isList, true);
  return lowerMat(e, n => lower(n, getComps, getMat, isList), getMat)?.m ?? null;
}

/** A definition whose value is a tensor of any shape but a square matrix's
 *  (`T = e_x ⊗ e_y ⊗ e_z`, `R = ((1, 2, 3, 4), (5, 6, 7, 8))`), or null.
 *  (A square one is lowerMatrix's; a tuple of points stays a tuple.) */
export function lowerTensorValue(
  e: Expr,
  getComps: GetComps,
  getMat: GetMat,
  getTensor: GetTensor,
  isList: IsList = () => false,
): Tensor | null {
  if (
    !tensorOp(e) &&
    !deepTuple(e) &&
    !(e.kind === 'var' && getTensor(e.name)) &&
    e.kind !== 'bin' &&
    e.kind !== 'neg' &&
    e.kind !== 'index'
  )
    return null;
  fresh(getTensor, isList, true);
  const t = lowerTensor(e, n => lower(n, getComps, getMat, isList), getMat);
  // (Not square with rows of 2 or 3 is a tuple of points, named as one.)
  const points = t?.shape.length === 2 && (t.shape[1] === 2 || t.shape[1] === 3);
  return t && t.shape.length >= 2 && !toMat(t) && !points ? t : null;
}

/** Lower a whole statement: desugar a root-level geometry form, expand all
 *  point arithmetic, and return an expression classify already understands. */
export function lowerGeom(
  e: Expr,
  getComps: GetComps,
  getMat: GetMat = () => null,
  isList: IsList = () => false,
  getTensor: GetTensor = () => null,
): Expr {
  return withMatrices(getTensor, isList, () => lowerStatement(e, getComps, getMat, isList));
}

function lowerStatement(e: Expr, getComps: GetComps, getMat: GetMat, isList: IsList): Expr {
  // A matrix or tensor with nothing to act on is drawn as its values
  // (docs/multisets.md §5): it has no position, so its row reads it out.
  // A pair of named points keeps saying what it is not: it was most likely
  // meant as the segment, which a readout of the matrix would not suggest.
  const namedPair = e.kind === 'vec' && e.items.length === 2 && e.items.every(it => it.kind === 'var');
  if (matsPossible && !namedPair) {
    const lo = (n: Expr): LV => lower(n, getComps, getMat, isList);
    const t = lowerTensor(e, lo, getMat);
    let m: MatValue | null = null;
    try {
      m = t ? null : lowerMat(e, lo, getMat);
    } catch {
      // Not a matrix after all ((1, 2) M): lowering below says what it is.
    }
    const value = t ?? (m && fromMat(m.m));
    // A 3×2 tensor is a tuple of 2D points however it was made, so it draws
    // as ((1, 1), (2, 2), (3, 3)) written out does: as dots.
    if (value?.shape.length === 2 && !toMat(value) && (value.shape[1] === 2 || value.shape[1] === 3)) {
      return { kind: 'vec', items: rows(value).map((r): Expr => ({ kind: 'vec', items: [...r.data] })) };
    }
    if (value && value.shape.length >= 2) return tensorNode(value);
  }
  if (e.kind === 'call' && GEOM_STATEMENTS.has(e.name)) {
    // A list of points — literal, named, or a named matrix read as its rows —
    // is plan #13's; until then say so rather than "takes points".
    if ((e.name === 'polyline' || e.name === 'vector') && e.args.some(a => isListArg(a, getMat, isList))) {
      throw new Error(
        `${e.name} takes its points one by one for now — ${e.name === 'polyline' ? 'polyline(A, B, C)' : 'vector(A, B)'} — not as a list.`,
      );
    }
    const args = e.args.map(a => lower(a, getComps, getMat, isList));
    if (e.name === 'circle') {
      // circle(C, r): the trailing argument is the scalar radius.
      const r = args[args.length - 1];
      if (args.length < 2 || !r || r.vec) throw new Error('circle takes circle(center, radius).');
      const pts = pairPoints('circle', args.slice(0, -1), 'center, radius');
      if (pts.length !== 1) throw new Error('circle takes circle(center, radius).');
      const [cx, cy] = pts[0];
      return {
        kind: 'eq',
        l: add(sq(sub(spaceVar('x'), cx)), sq(sub(spaceVar('y'), cy))),
        r: sq(r.e),
      };
    }
    // Tuple literals arrive flattened, so (1, 2, 3) cannot be told from
    // (1, 2), 3: an odd run of scalars gets the one message true of both.
    if (e.name === 'vector' && args.every(a => !a.vec) && args.length % 2 === 1) throw new Error(VECTOR_USAGE);
    const pts = legacyPointArgs(args, `${e.name} takes points with matching dimensions.`);
    if (!pts.length || ![2, 3].includes(pts[0].length) || pts.some(p => p.length !== pts[0].length))
      throw new Error(`${e.name} needs points with matching dimensions.`);
    if (pts[0].length === 3 && (e.name === 'line' || e.name === 'square'))
      throw new Error(`${e.name} is only defined for 2D points.`);
    if (e.name === 'line') {
      if (pts.length !== 2) {
        throw new Error('line takes two points: line(A, B), with A = (0, 0) defined above.');
      }
      // The infinite line through A and B: cross(P - A, B - A) = 0, an
      // ordinary implicit equation (so it renders on the GPU like any curve).
      const [[ax, ay], [bx, by]] = pts;
      return {
        kind: 'eq',
        l: sub(mul(sub(spaceVar('x'), ax), sub(by, ay)), mul(sub(spaceVar('y'), ay), sub(bx, ax))),
        r: { kind: 'num', value: 0 },
      };
    }
    if (e.name === 'segment') {
      if (pts.length !== 2) {
        throw new Error('segment takes two points: segment(A, B), with A = (0, 0) defined above.');
      }
      return polyCall('[segment]', pts);
    }
    if (e.name === 'hull') {
      // The convex hull: a filled polygon in the plane, a solid in space.
      // Which vertices are extreme is settled per frame, from their values.
      if (pts.length < 3)
        throw new Error('hull needs at least 3 points: hull(A, B, C, D), or hull(P) for a list of points.');
      return polyCall('[hull]', pts);
    }
    if (e.name === 'polyline') {
      if (pts.length < 2) throw new Error('polyline needs at least 2 points: polyline(A, B, C).');
      return polyCall('[polyline]', pts);
    }
    if (e.name === 'vector') {
      // vector(A, B) is the arrow from A to B; vector(V) starts at the origin.
      if (pts.length !== 1 && pts.length !== 2) throw new Error(VECTOR_USAGE);
      const zero: Expr = { kind: 'num', value: 0 };
      return polyCall('[vector]', pts.length === 1 ? [pts[0].map(() => zero), pts[0]] : pts);
    }
    if (e.name === 'square') {
      if (pts.length !== 2) throw new Error('square takes two points: square(A, B).');
      // The square erected on side A→B, on the left of the direction A→B.
      const [[ax, ay], [bx, by]] = pts;
      const px = neg(sub(by, ay)); // perp(B - A)
      const py = sub(bx, ax);
      return polyCall('[square]', [
        [ax, ay],
        [bx, by],
        [add(bx, px), add(by, py)],
        [add(ax, px), add(ay, py)],
      ]);
    }
    if (pts.length < 3) throw new Error('polygon needs at least 3 vertices.');
    return polyCall('[polygon]', pts);
  }
  return toExpr(lower(e, getComps, getMat, isList));
}

/**
 * The head of an arrow whose shaft runs (x0, y0) → (x1, y1) in screen pixels:
 * the triangle tip/left/right with its tip at (x1, y1), plus shaftEnd, where
 * the stroke should stop instead of at the tip — a little inside the head, so
 * its blunt end never pokes through the point and no seam opens at the base.
 * `size` is the head length in pixels — fixed on screen, so the head does not
 * scale with zoom — shrinking only when the shaft itself is shorter. Null for
 * a zero-length (or non-finite) shaft, which has no direction. Shared by
 * render2d and the og rasterizer so both draw the same arrow.
 */
export interface ArrowHead {
  tip: [number, number];
  left: [number, number];
  right: [number, number];
  shaftEnd: [number, number];
}
export function arrowHead(x0: number, y0: number, x1: number, y1: number, size: number): ArrowHead | null {
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (!(len > 0) || !Number.isFinite(len)) return null;
  const ux = (x1 - x0) / len,
    uy = (y1 - y0) / len;
  const h = Math.min(size, len);
  const w = h * 0.4; // half-width: a 2.5:2 head, slim enough to read as a direction
  const bx = x1 - ux * h,
    by = y1 - uy * h;
  return {
    tip: [x1, y1],
    left: [bx - uy * w, by + ux * w],
    right: [bx + uy * w, by - ux * w],
    shaftEnd: [bx + ux * h * 0.25, by + uy * h * 0.25],
  };
}
