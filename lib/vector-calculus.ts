/**
 * Resolve-time expansion of grad, div, curl, laplacian, jacobian and hessian,
 * including the ∇, ∇·, ∇× and ∇² spellings. Each call becomes an ordinary
 * expression, differentiated the same way as d/dx.
 */
import { add, sub } from './diff.ts';
import { type Expr, type ProductGlyph, freeVars } from './expr.ts';
import { lowerGeom } from './geom.ts';
import { applyDiff, isIntHeader, isSumHeader, throughFields, type Ctx } from './defs.ts';

/** Axis names. A copy of the set in lib/defs.ts, so this module can build its
 *  tables without reading defs while that file is still starting. */
const SPACE: ReadonlySet<string> = new Set(['x', 'y', 'z']);

/** The vector-calculus operators, each also written with ∇ (see splitNablaChain). */
export const VECTOR_OPS: ReadonlySet<string> = new Set(['grad', 'div', 'curl', 'laplacian', 'jacobian', 'hessian']);
const VECTOR_OP_EXAMPLE: Record<string, string> = {
  grad: 'grad(x^2 + y^2)',
  div: 'div((x y, y^2))',
  curl: 'curl((-y, x))',
  laplacian: 'laplacian(x^2 - y^2)',
  jacobian: 'jacobian((x^2 - y^2, 2 x y))',
  hessian: 'hessian(x^2 - y^2)',
};

/**
 * `∇` as a prefix operator. It tokenizes as a bare `grad` factor, and like
 * d/dx binds the rest of its product chain: `∇f`, `∇ x^2 y`, `∇f(x, y)`.
 * A written `·` or `×` right after it makes `∇·F` (div) and `∇×F` (curl);
 * `∇^2 f` (also `∇²f`) is laplacian(f). The operand stops at the next
 * written `·` or `×`, so `∇f · v` is (∇f)·v. `∇(…)` parses as a call and
 * never gets here. Returns the rewritten chain, or null when it has no ∇.
 */
export function splitNablaChain(e: Expr, ctx: Ctx): Expr | null {
  type Factor = { e: Expr; op: '*' | '/'; glyph?: ProductGlyph };
  const factors: Factor[] = [];
  let node: Expr = e;
  while (node.kind === 'bin' && (node.op === '*' || node.op === '/')) {
    factors.unshift({ e: node.b, op: node.op, glyph: node.glyph });
    node = node.a;
  }
  factors.unshift({ e: node, op: '*' });
  const header = (f: Expr): { laplacian: boolean; negate: boolean } | null => {
    if (f.kind === 'neg') {
      const h = header(f.a);
      return h && { ...h, negate: !h.negate };
    }
    const bare = (n: Expr) =>
      n.kind === 'var' &&
      n.name === 'grad' &&
      // A graph that defines its own `grad` keeps it (it is shadowable).
      !ctx.getFn('grad') &&
      !ctx.opts.definition?.('grad');
    if (bare(f)) return { laplacian: false, negate: false };
    if (f.kind === 'bin' && f.op === '^' && bare(f.a) && f.b.kind === 'num' && f.b.value === 2)
      return { laplacian: true, negate: false };
    return null;
  };
  const at = factors.findIndex(f => header(f.e));
  // A Σ/∫ further left binds the ∇ into its own body, which resolves on its own.
  if (at < 0 || factors.slice(0, at).some(f => isSumHeader(f.e) || isIntHeader(f.e))) return null;
  const h = header(factors[at].e)!;
  const first = factors[at + 1];
  if (!first) return null; // a bare ∇: classify says to write it with parentheses
  if (first.op === '/') throw new Error('∇ needs something to act on: ∇f, ∇·F, ∇×F or ∇²f.');
  if (h.laplacian && first.glyph) throw new Error('∇² takes a scalar field: write ∇²f.');
  if (first.glyph === 'outer' || first.glyph === 'wedge' || first.glyph === 'geometric')
    throw new Error('∇ makes ∇f, ∇·F, ∇×F or ∇²f — not ⊗, ∧ or ⟑.');
  let end = at + 2;
  while (end < factors.length && !factors[end].glyph) end++;
  let operand = first.e;
  for (const f of factors.slice(at + 2, end)) operand = { kind: 'bin', op: f.op, a: operand, b: f.e };
  const name = h.laplacian ? 'laplacian' : first.glyph === 'dot' ? 'div' : first.glyph === 'cross' ? 'curl' : 'grad';
  let out: Expr = { kind: 'call', name, args: [operand] };
  if (h.negate) out = { kind: 'neg', a: out };
  if (at > 0) {
    let coeff = factors[0].e;
    for (const f of factors.slice(1, at))
      coeff = { kind: 'bin', op: f.op, a: coeff, b: f.e, ...(f.glyph && { glyph: f.glyph }) };
    out = { kind: 'bin', op: factors[at].op, a: coeff, b: out, ...(factors[at].glyph && { glyph: factors[at].glyph }) };
  }
  for (const f of factors.slice(end))
    out = { kind: 'bin', op: f.op, a: out, b: f.e, ...(f.glyph && { glyph: f.glyph }) };
  return out;
}

/**
 * What a vector operator differentiates. A bare function name stands for the
 * function at its own parameters (`grad(f)` with f(x, y) = …), a named
 * vector for its components, and named fields are written out (throughFields)
 * — otherwise each would differentiate as a constant and quietly give 0.
 */
function vectorOperand(name: string, arg: Expr, ctx: Ctx): Expr {
  if (arg.kind === 'var') {
    const fn = ctx.getFn(arg.name);
    if (fn) {
      const bad = fn.params.find(p => !SPACE.has(p) && p !== 't');
      if (bad !== undefined || fn.recursive) {
        throw new Error(
          `${name}(${arg.name}) needs ${arg.name} to be a function of x, y, z or t; write ${name}(${arg.name}(x, y)) to choose.`,
        );
      }
      return fn.body;
    }
    // Differentiated as it stands, an unknown name is a constant: say so
    // rather than draw grad(f) as the point (0, 0).
    if (
      !SPACE.has(arg.name) &&
      arg.name !== 't' &&
      ctx.opts.definition &&
      !ctx.opts.definition(arg.name) &&
      !ctx.opts.comps?.(arg.name) &&
      !ctx.opts.isList?.(arg.name)
    ) {
      throw new Error(
        `${name}(${arg.name}): ${arg.name} is not defined. Define a function ${arg.name}(x, y) = … or a field ${arg.name} = … first.`,
      );
    }
  }
  const lowered = ctx.opts.comps ? lowerGeom(arg, ctx.opts.comps, () => null, ctx.opts.isList) : arg;
  return throughFields(lowered, ctx.opts);
}

/** grad, div, curl and laplacian — and the matrices jacobian and hessian —
 *  expanded symbolically as d/dx is. */
export function vectorCalculus(name: string, args: readonly Expr[], ctx: Ctx): Expr {
  const example = VECTOR_OP_EXAMPLE[name];
  if (args.length !== 1) throw new Error(`${name} takes one expression: ${example}.`);
  const f = vectorOperand(name, args[0], ctx);
  if (f.kind === 'list' || f.kind === 'eq' || f.kind === 'ineq') {
    throw new Error(
      `${name} needs ${name === 'div' || name === 'curl' ? 'a vector field' : 'a scalar expression'}, like ${example}.`,
    );
  }
  const d = (g: Expr, v: string, order = 1) => applyDiff(g, v, order, ctx.opts, ctx.getFn);
  const AXES = ['x', 'y', 'z'];
  const matrix = (rows: Expr[][]): Expr => ({ kind: 'vec', items: rows.map(items => ({ kind: 'vec', items })) });
  if (name === 'hessian') {
    if (f.kind === 'vec')
      throw new Error('hessian takes a scalar field, like hessian(x^2 - y^2); for a map, jacobian.');
    // The matrix of second derivatives: in the plane unless f uses z.
    const axes = AXES.slice(0, freeVars(f).has('z') ? 3 : 2);
    const firsts = axes.map(v => d(f, v));
    return matrix(firsts.map(fi => axes.map(v => d(fi, v))));
  }
  if (name === 'jacobian') {
    if (f.kind !== 'vec' || (f.items.length !== 2 && f.items.length !== 3)) {
      throw new Error(`jacobian takes a map of 2 or 3 components, like ${example}; for a scalar f, hessian(f).`);
    }
    // Row i is the gradient of component i, over as many axes as components.
    const axes = AXES.slice(0, f.items.length);
    return matrix(f.items.map(c => axes.map(v => d(c, v))));
  }
  if (name === 'grad' || name === 'laplacian') {
    if (f.kind === 'vec') {
      throw new Error(
        name === 'grad'
          ? 'grad takes a scalar field; for a vector field F, div(F) is its divergence and curl(F) its curl.'
          : 'laplacian takes a scalar field, like laplacian(x^2 - y^2); the Laplacian of a vector field is not supported.',
      );
    }
    // z joins only when f uses it, so a plane field stays in the plane.
    const axes = AXES.slice(0, freeVars(f).has('z') ? 3 : 2);
    if (name === 'grad') return { kind: 'vec', items: axes.map(v => d(f, v)) };
    return axes.map(v => d(f, v, 2)).reduce((s, term) => add(s, term));
  }
  if (f.kind !== 'vec' || (f.items.length !== 2 && f.items.length !== 3)) {
    throw new Error(
      `${name} takes a vector field of 2 or 3 components, like ${example}; for a scalar f, grad(f) is its gradient.`,
    );
  }
  const [P, Q, R] = f.items;
  if (name === 'div') return f.items.map((c, k) => d(c, AXES[k])).reduce((s, term) => add(s, term));
  // In the plane, the scalar ∂Q/∂x − ∂P/∂y (the z-component of the 3D curl).
  if (!R) return sub(d(Q, 'x'), d(P, 'y'));
  return { kind: 'vec', items: [sub(d(R, 'y'), d(Q, 'z')), sub(d(P, 'z'), d(R, 'x')), sub(d(Q, 'x'), d(P, 'y'))] };
}
