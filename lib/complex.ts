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
import { FN_GLSL, piecewiseGLSL, toGLSL } from './glsl.ts';

export type Typed = { type: 'real'; code: string } | { type: 'complex'; code: string };

/**
 * Special forms handled by classify() as whole-expression plot modes; they
 * never compile inline (iter needs a shader loop, the others pick a renderer).
 */
export const SPECIAL_FORMS = new Set(['domain', 'conformal', 'iter']);

/** Does this expression involve complex values anywhere?
 *  extra: additional variable names known to be complex-valued (e.g. an
 *  iteration variable bound by an enclosing special form). */
export function usesComplex(e: Expr, extra?: ReadonlySet<string>): boolean {
  switch (e.kind) {
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

function promote(v: Typed): string {
  return v.type === 'complex' ? v.code : `vec2(${v.code}, 0.0)`;
}

/**
 * Compile an expression, inferring real vs complex type.
 * env binds variable names to pre-typed values (e.g. iter's iterate z ↦ a
 * complex GLSL local), overriding the default treatment of that name.
 */
export function compileTyped(e: Expr, env: Record<string, Typed> = {}): Typed {
  const envComplex = new Set(Object.keys(env).filter(k => env[k].type === 'complex'));
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
        default: return false;
      }
    })(e);
    if (!touchesComplexFns) return { type: 'real', code: toGLSL(e) };
  }

  switch (e.kind) {
    case 'num': return { type: 'real', code: toGLSL(e) };
    case 'var':
      if (e.name in env) return env[e.name];
      if (e.name === 'i') return { type: 'complex', code: 'vec2(0.0, 1.0)' };
      if (e.name === 'w') return { type: 'complex', code: 'vec2(x, y)' };
      return { type: 'real', code: e.name };
    case 'neg': {
      const a = compileTyped(e.a, env);
      return { type: a.type, code: `(-${a.code})` };
    }
    case 'bin': {
      const a = compileTyped(e.a, env);
      const b = compileTyped(e.b, env);
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
      const args = e.args.map(a => compileTyped(a, env));
      const anyComplex = args.some(a => a.type === 'complex');
      if (e.name === 'conj') {
        if (args.length !== 1) throw new Error('conj takes one argument.');
        const z = promote(args[0]);
        return { type: 'complex', code: `(${z} * vec2(1.0, -1.0))` };
      }
      if (e.name in C_TO_REAL && (anyComplex || e.name === 're' || e.name === 'im' || e.name === 'arg')) {
        if (args.length !== 1) throw new Error(`${e.name} takes one argument.`);
        return { type: 'real', code: C_TO_REAL[e.name](promote(args[0])) };
      }
      if (!anyComplex) {
        const name = FN_GLSL[e.name] ?? e.name;
        return { type: 'real', code: `${name}(${args.map(a => a.code).join(', ')})` };
      }
      const fn = C_FNS[e.name];
      if (!fn) throw new Error(`${plainFnName(e.name)} is not supported for complex values.`);
      if (args.length !== 1) throw new Error(`${e.name} takes one argument.`);
      return { type: 'complex', code: `${fn}(${promote(args[0])})` };
    }
    case 'eq': {
      const l = compileTyped(e.l, env);
      const r = compileTyped(e.r, env);
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
      const emit = (x: Expr): string => {
        const c = compileTyped(x);
        if (c.type === 'complex') throw new Error('Complex piecewise: wrap values in re(…) or im(…).');
        return c.code;
      };
      return { type: 'real', code: piecewiseGLSL(e, emit) };
    }
  }
  throw new Error('Unreachable');
}
