import { childrenOf, freeVars, isRecur, loopLeaves, structuralDiagnostic, substVars } from './expr.ts';
/**
 * Complex-typed GLSL compilation.
 *
 * `i` is the imaginary unit and `w` is shorthand for x + iy, so a complex
 * potential like ln(w-1) - ln(w+1) compiles to a GLSL vec2 (re, im). Purely
 * real subtrees delegate to the scalar compiler in glsl.ts, so real plots are
 * unaffected; re()/im()/arg()/abs() take a complex value back to a real one,
 * which lets equations like im(ln(w)) = 1 flow through the implicit-curve path.
 */
import { type Expr, plainFnName } from './expr.ts';
import { FN_GLSL, HELPER_SELF, condGLSL, declareHelper, piecewiseGLSL, toGLSL } from './glsl.ts';

export type Typed = { type: 'real'; code: string } | { type: 'complex'; code: string };

/**
 * Special forms handled by classify() as whole-expression plot modes; they
 * never compile inline (iter needs a shader loop, the others pick a renderer).
 */
export const SPECIAL_FORMS = new Set(['domain', 'conformal', 'iter', 'rgb', 'hsl', 'oklch']);

/** Every call that is a whole row rather than a value, by the name the user
 *  writes (the geometry statements, lib/geom.ts GEOM_STATEMENTS, are the rest). */
export const WHOLE_EXPR_NAMES: ReadonlySet<string> = new Set([...SPECIAL_FORMS, 'tube', 'revolve', 'trail']);

/** Does this expression involve complex values anywhere?
 *  extra: additional variable names known to be complex-valued (e.g. an
 *  iteration variable bound by an enclosing special form). */
export function usesComplex(e: Expr, extra?: ReadonlySet<string>): boolean {
  switch (e.kind) {
    case 'index': case 'range': case 'eqtest': case 'comp': case 'figure': case 'trail': case 'hist': case 'family': return childrenOf(e).some(c => usesComplex(c, extra));
    case 'num': return false;
    case 'var': return e.name === 'i' || e.name === 'w' || !!extra?.has(e.name);
    case 'neg': return usesComplex(e.a, extra);
    case 'bin': return usesComplex(e.a, extra) || usesComplex(e.b, extra);
    case 'call': return e.args.some(a => usesComplex(a, extra));
    case 'eq': return usesComplex(e.l, extra) || usesComplex(e.r, extra);
    case 'ineq': return usesComplex(e.l, extra) || usesComplex(e.r, extra);
    case 'vec': return e.items.some(a => usesComplex(a, extra));
    case 'list': return e.items.some(a => usesComplex(a, extra));
    case 'data':
    case 'str':
    case 'text': return false;
    case 'piecewise':
      return e.cases.some(c => usesComplex(c.cond, extra) || usesComplex(c.value, extra))
        || (e.otherwise ? usesComplex(e.otherwise, extra) : false);
    // A param is complex only through its seed, and a seed that is complex
    // already answers; the body then only matters for i and w of its own.
    case 'loop': return childrenOf(e).some(c => usesComplex(c, extra));
  }
}

const C_FNS: Record<string, string> = {
  sin: 'c_sin', cos: 'c_cos', tan: 'c_tan',
  exp: 'c_exp', ln: 'c_ln', log: 'c_log10', sqrt: 'c_sqrt',
  sinh: 'c_sinh', cosh: 'c_cosh', tanh: 'c_tanh',
};

/** Complex-argument functions returning a real value. */
const C_TO_REAL: Record<string, (z: string) => string> = {
  abs: z => `length(${z})`,
  re: z => `(${z}).x`,
  im: z => `(${z}).y`,
  arg: z => `atan((${z}).y, (${z}).x)`,
};

/** Shared builtin return/arity rules for inference and shader compilation. */
function inferCallType(name: string, args: ScalarType[]): ScalarType {
  if (SPECIAL_FORMS.has(name)) throw new Error(`${name}(…) must be the whole expression.`);
  const complex = args.includes('complex');
  if (name === 'conj') {
    if (args.length !== 1) throw new Error('conj takes one argument.');
    return 'complex';
  }
  if (name in C_TO_REAL && (complex || ['re', 'im', 'arg'].includes(name))) {
    if (args.length !== 1) throw new Error(`${name} takes one argument.`);
    return 'real';
  }
  if (!complex) return 'real';
  if (!(name in C_FNS)) throw new Error(`${plainFnName(name)} is not supported for complex values.`);
  if (args.length !== 1) throw new Error(`${name} takes one argument.`);
  return 'complex';
}

function promote(v: Typed): string {
  return v.type === 'complex' ? v.code : `vec2(${v.code}, 0.0)`;
}

/**
 * Compile an expression, inferring real vs complex type.
 * env binds variable names to pre-typed values (e.g. iter's iterate z ↦ a
 * complex GLSL local), overriding the default treatment of that name.
 */
export function compileTyped(e: Expr, env: Record<string, Typed> = {}, complexNames?: ReadonlySet<string>): Typed {
  // A caller compiling many nodes against one growing env passes the complex
  // names it already knows so each call does not rescan the whole env.
  const envComplex = complexNames ?? new Set(Object.keys(env).filter(k => env[k].type === 'complex'));
  if (!usesComplex(e, envComplex)) {
    // re/im/arg/conj of a real value still need complex handling below.
    const touchesComplexFns = (function scan(n: Expr): boolean {
      switch (n.kind) {
        case 'call': return n.name in C_TO_REAL || n.name === 'conj' || SPECIAL_FORMS.has(n.name) || n.args.some(scan);
        case 'bin': return scan(n.a) || scan(n.b);
        case 'neg': return scan(n.a);
        case 'eq': return scan(n.l) || scan(n.r);
        case 'ineq': return scan(n.l) || scan(n.r);
        case 'vec': return n.items.some(scan);
        case 'list': return n.items.some(scan);
        case 'piecewise':
          return n.cases.some(c => scan(c.cond) || scan(c.value))
            || (n.otherwise ? scan(n.otherwise) : false);
        case 'loop': return true; // emitted here, whatever its types
        default: return false;
      }
    })(e);
    if (!touchesComplexFns) return { type: 'real', code: toGLSL(e) };
  }

  switch (e.kind) {
    case 'index': case 'range': case 'eqtest': case 'comp': case 'figure': case 'trail': case 'hist': case 'family': throw new Error(structuralDiagnostic(e));
    case 'num': return { type: 'real', code: toGLSL(e) };
    case 'var':
      if (e.name in env) return env[e.name];
      if (e.name === 'i') return { type: 'complex', code: 'vec2(0.0, 1.0)' };
      if (e.name === 'w') return { type: 'complex', code: 'vec2(x, y)' };
      return { type: 'real', code: e.name };
    case 'neg': {
      const a = compileTyped(e.a, env, envComplex);
      return { type: a.type, code: `(-${a.code})` };
    }
    case 'bin': {
      const a = compileTyped(e.a, env, envComplex);
      const b = compileTyped(e.b, env, envComplex);
      if (a.type === 'real' && b.type === 'real') {
        if (e.op === '^') return { type: 'real', code: `eq_pow(${a.code}, ${b.code})` };
        return { type: 'real', code: `(${a.code} ${e.op} ${b.code})` };
      }
      const ca = promote(a);
      const cb = promote(b);
      switch (e.op) {
        case '+': return { type: 'complex', code: `(${ca} + ${cb})` };
        case '-': return { type: 'complex', code: `(${ca} - ${cb})` };
        case '*': return { type: 'complex', code: `c_mul(${ca}, ${cb})` };
        case '/': return { type: 'complex', code: `c_div(${ca}, ${cb})` };
        case '^': {
          // Small integer powers as repeated c_mul: exact at 0 (c_pow goes
          // through ln), and much cheaper inside fractal iteration loops.
          if (e.b.kind === 'num' && Number.isInteger(e.b.value) && e.b.value >= 1 && e.b.value <= 8) {
            let code = ca;
            for (let k = 1; k < e.b.value; k++) code = `c_mul(${code}, ${ca})`;
            return { type: 'complex', code };
          }
          return { type: 'complex', code: `c_pow(${ca}, ${cb})` };
        }
      }
      break;
    }
    case 'call': {
      if (SPECIAL_FORMS.has(e.name)) {
        throw new Error(`${e.name}(…) must be the whole expression.`);
      }
      const args = e.args.map(a => compileTyped(a, env, envComplex));
      inferCallType(e.name, args.map(a => a.type));
      const anyComplex = args.some(a => a.type === 'complex');
      if (e.name === 'conj') {
        const z = promote(args[0]);
        return { type: 'complex', code: `(${z} * vec2(1.0, -1.0))` };
      }
      if (e.name in C_TO_REAL && (anyComplex || e.name === 're' || e.name === 'im' || e.name === 'arg')) {
        return { type: 'real', code: C_TO_REAL[e.name](promote(args[0])) };
      }
      if (!anyComplex) {
        const name = FN_GLSL[e.name] ?? e.name;
        return { type: 'real', code: `${name}(${args.map(a => a.code).join(', ')})` };
      }
      const fn = C_FNS[e.name];
      return { type: 'complex', code: `${fn}(${promote(args[0])})` };
    }
    case 'eq': {
      const l = compileTyped(e.l, env, envComplex);
      const r = compileTyped(e.r, env, envComplex);
      if (l.type === 'complex' || r.type === 'complex') {
        throw new Error('Complex equation: compare re(…) or im(…) instead.');
      }
      return { type: 'real', code: `(${l.code} - (${r.code}))` };
    }
    case 'ineq':
      // classify compiles each comparison's l - r separately; a nested
      // inequality here means something like a = (x < 2) or a < (b < c).
      throw new Error('Unexpected inequality.');
    case 'vec':
      throw new Error('Vector in scalar context.');
    case 'list':
      throw new Error('A list can only be plotted as its own row.');
    case 'piecewise': {
      const type = inferScalarType(e, typesOf(env));
      const emitCond = (x: Expr): string => compileTyped(x, env, envComplex).code;
      const emitValue = (x: Expr): string => cast(compileTyped(x, env, envComplex), type);
      return { type, code: piecewiseGLSL(e, emitCond, emitValue, nanOf(type)) };
    }
    case 'loop': return compileLoop(e, env);
  }
  throw new Error('Unreachable');
}

const typesOf = (env: Record<string, Typed>): Record<string, ScalarType> =>
  Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.type]));
const cast = (v: Typed, type: ScalarType): string => (type === 'complex' ? promote(v) : v.code);
const glType = (type: ScalarType): string => (type === 'complex' ? 'vec2' : 'float');
const nanOf = (type: ScalarType): string => (type === 'complex' ? 'vec2(EQ_NAN)' : 'EQ_NAN');

/**
 * A loop is a GLSL function: expressions cannot hold statements. It takes
 * the params, then every free variable of the body (x and y are locals of
 * the caller; passing the uniforms too keeps one rule), so it depends on
 * nothing declared around it, and it is declared once by content (see
 * declareHelper). Each pass tests the params for finiteness — a state that
 * blew up will not terminate and reads as undefined — then walks the body's
 * cases as if/else: an exit leaf returns, a self-call assigns and continues.
 */
function compileLoop(e: Expr & { kind: 'loop' }, env: Record<string, Typed>): Typed {
  const { params: ptypes, result } = loopTypes(e, typesOf(env));
  const free = new Set<string>();
  for (const v of freeVars(e.body)) {
    if (e.params.includes(v) || v === 'i') continue;
    if (v === 'w' && !(v in env)) { free.add('x'); free.add('y'); } else free.add(v);
  }
  // The params become the locals p<d>_0, p<d>_1, … by substitution, not only
  // by binding: a real subtree compiles through toGLSL, which spells
  // variables by name. (No user name can clash: sliders arrive as u_…
  // uniforms.) d is the nesting depth: a loop in an outer loop's exit leaf
  // sees the outer locals as free variables and must not redeclare them.
  let depth = 0;
  while (Object.keys(env).some(v => v.startsWith(`p${depth}_`))) depth++;
  const local = (k: number): string => `p${depth}_${k}`;
  const locals = Object.fromEntries(e.params.map((p, k): [string, Expr] => [p, { kind: 'var', name: local(k) }]));
  const body = substVars(e.body, locals);
  const inner: Record<string, Typed> = { ...env };
  const args: string[] = [];
  const decls: string[] = [];
  e.params.forEach((_, k) => {
    inner[local(k)] = { type: ptypes[k], code: local(k) };
    decls.push(`${glType(ptypes[k])} ${local(k)}`);
    args.push(cast(compileTyped(e.seeds[k], env), ptypes[k]));
  });
  for (const v of free) {
    const type = env[v]?.type ?? 'real';
    inner[v] = { type, code: v };
    decls.push(`${glType(type)} ${v}`);
    args.push(env[v]?.code ?? v);
  }
  const emitCond = (x: Expr): string => compileTyped(x, inner).code;
  const emitLeaf = (leaf: Expr): string => {
    if (!isRecur(leaf)) return `return ${cast(compileTyped(leaf, inner), result)};`;
    const next = leaf.args.map((a, k) => `${glType(ptypes[k])} n${k} = ${cast(compileTyped(a, inner), ptypes[k])};`);
    return `${next.join(' ')} ${e.params.map((_, k) => `${local(k)} = n${k};`).join(' ')} continue;`;
  };
  const emitBody = (body: Expr): string => {
    if (body.kind !== 'piecewise') return emitLeaf(body);
    const cases = body.cases.map(c => `if (${condGLSL(c.cond, emitCond)}) { ${emitBody(c.value)} }`);
    return `${cases.join(' else ')} else { ${body.otherwise ? emitBody(body.otherwise) : `return ${nanOf(result)};`} }`;
  };
  const finite = e.params.map((_, k) => (ptypes[k] === 'complex'
    ? `any(isnan(${local(k)})) || any(isinf(${local(k)}))` : `isnan(${local(k)}) || isinf(${local(k)})`)).join(' || ');
  const name = declareHelper(`${glType(result)} ${HELPER_SELF}(${decls.join(', ')}) {
  for (int k = 0; k < ${e.limit}; k++) {
    if (${finite}) return ${nanOf(result)};
    ${emitBody(body)}
  }
  return ${nanOf(result)};
}`);
  return { type: result, code: `${name}(${args.join(', ')})` };
}

/**
 * The types a loop's params settle to, and its result's. A param starts as
 * its seed's type and becomes complex once any self-call passes it a
 * complex value (which may depend on the other params: iterate to a fixed
 * point; complex is absorbing, so it needs at most one round per param).
 * The result is complex if any exit leaf is.
 */
export function loopTypes(e: Expr & { kind: 'loop' }, env: Record<string, ScalarType>): { params: ScalarType[]; result: ScalarType } {
  const params = e.seeds.map(s => inferScalarType(s, env));
  const leaves = loopLeaves(e.body);
  const bound = (): Record<string, ScalarType> => ({ ...env, ...Object.fromEntries(e.params.map((p, k) => [p, params[k]])) });
  for (let changed = true; changed;) {
    changed = false;
    const inner = bound();
    for (const leaf of leaves) {
      if (!isRecur(leaf)) continue;
      leaf.args.forEach((a, k) => {
        if (params[k] === 'real' && inferScalarType(a, inner) === 'complex') { params[k] = 'complex'; changed = true; }
      });
    }
  }
  const inner = bound();
  checkConditions(e.body, inner);
  const result = leaves.some(leaf => !isRecur(leaf) && inferScalarType(leaf, inner) === 'complex') ? 'complex' : 'real';
  return { params, result };
}

/** Every comparison in a loop body's cases compares real values. */
function checkConditions(body: Expr, env: Record<string, ScalarType>): void {
  if (body.kind !== 'piecewise') return;
  for (const c of body.cases) { realCondition(c.cond, env); checkConditions(c.value, env); }
  if (body.otherwise) checkConditions(body.otherwise, env);
}
function realCondition(cond: Expr, env: Record<string, ScalarType>): void {
  if (cond.kind === 'ineq') { realCondition(cond.l, env); realCondition(cond.r, env); return; }
  if (inferScalarType(cond, env) === 'complex') throw new Error('Complex condition: compare re(…), im(…), or abs(…).');
}

export type ScalarType = 'real' | 'complex';
/** Result typing, independent of code generation and structural complex involvement. */
export function inferScalarType(e: Expr, env: Record<string, ScalarType> = {}): ScalarType {
  const infer = (value: Expr) => inferScalarType(value, env);
  switch (e.kind) {
    case 'num': return 'real';
    case 'var': return env[e.name] ?? (e.name === 'i' || e.name === 'w' ? 'complex' : 'real');
    case 'neg': return infer(e.a);
    case 'bin': { const a = infer(e.a); const b = infer(e.b); return a === 'complex' || b === 'complex' ? 'complex' : 'real'; }
    case 'call': return inferCallType(e.name, e.args.map(infer));
    case 'eq':
      if (infer(e.l) === 'complex' || infer(e.r) === 'complex') throw new Error('Complex equation: compare re(…) or im(…) instead.');
      return 'real';
    case 'ineq': throw new Error('Unexpected inequality.');
    case 'vec': throw new Error('Vector in scalar context.');
    case 'list': throw new Error('A list can only be plotted as its own row.');
    case 'piecewise': {
      const values = e.cases.map(c => { realCondition(c.cond, env); return infer(c.value); });
      if (e.otherwise) values.push(infer(e.otherwise));
      return values.includes('complex') ? 'complex' : 'real';
    }
    case 'loop': return loopTypes(e, env).result;
    case 'index': case 'range': case 'eqtest': case 'comp': case 'figure': case 'trail': case 'hist': case 'family':
      throw new Error('This object must be lowered before scalar type inference.');
    case 'data': case 'str': case 'text': throw new Error('Expected a scalar expression.');
  }
}
