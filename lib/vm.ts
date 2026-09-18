/**
 * Compile an Expr to a flat stack program for fast repeated evaluation.
 *
 * The OG-image renderer samples fields at every pixel; walking the AST per
 * sample is too slow and Workers forbid dynamic codegen (`new Function`), so
 * expressions compile once to opcode arrays run by a small stack machine.
 */
import { ANGLE_FN, ANGLE_RATE_FN, BETA_PDF_FN, type Expr, GAMMA_PDF_FN, T_PDF_FN, WEIBULL_PDF_FN, angleFn, angleRateFn, cothFn, erf, factorialFn, gammaFn, ineqComparisons, normalcdf, normalpdf, plainFnName, realPow, sincFn } from './expr.ts';
import { betaPdf, gammaPdf, studentTPdf, weibullPdf } from './specfn.ts';

const enum Op { Const, Var, Add, Sub, Mul, Div, Pow, Neg, Fn1, Fn2, Fn3, Lt, Le, Gt, Ge, Sel, Fn4 }

const FN1: Record<string, (x: number) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sech: x => 1 / Math.cosh(x),
  asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
  sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, ln: Math.log, log: Math.log10,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
  fract: x => x - Math.floor(x),
  re: x => x, im: () => 0, arg: x => (x < 0 ? Math.PI : 0), conj: x => x,
  erf,
  gamma: gammaFn, factorial: factorialFn, sinc: sincFn, coth: cothFn,
};

const FN2: Record<string, (a: number, b: number) => number> = {
  atan2: Math.atan2, min: Math.min, max: Math.max,
  mod: (a, b) => a - Math.floor(a / b) * b,
  [T_PDF_FN]: studentTPdf,
};

// The probability builtins (lib/dist.ts rows compile to these).
const FN3: Record<string, (a: number, b: number, c: number) => number> = {
  normalpdf, normalcdf,
  [GAMMA_PDF_FN]: gammaPdf, [BETA_PDF_FN]: betaPdf, [WEIBULL_PDF_FN]: weibullPdf,
};

// The angle measurement and its derivative (lib/geom.ts lowers angle(…) to these).
const FN4: Record<string, (a: number, b: number, c: number, d: number) => number> = {
  [ANGLE_FN]: angleFn, [ANGLE_RATE_FN]: angleRateFn,
};

const FN1_NAMES = Object.keys(FN1);
const FN2_NAMES = Object.keys(FN2);
const FN3_NAMES = Object.keys(FN3);
const FN4_NAMES = Object.keys(FN4);

export interface Prog {
  code: number[];
  consts: number[];
  /** Stack slots needed at runtime. */
  depth: number;
}

/**
 * Compile `e` against a fixed variable layout: slots[name] is an index into
 * the `vars` array passed to run(). Throws on names or calls it can't handle
 * (e.g. complex-only forms) — callers treat that as "no preview for this row".
 */
export function compileProg(e: Expr, slots: ReadonlyMap<string, number>): Prog {
  const code: number[] = [];
  const consts: number[] = [];
  let depth = 0;
  let maxDepth = 0;
  const push = (n: number) => { depth += n; if (depth > maxDepth) maxDepth = depth; };
  const emit = (node: Expr): void => {
    switch (node.kind) {
      case 'num':
        code.push(Op.Const, consts.length);
        consts.push(node.value);
        push(1);
        return;
      case 'var': {
        const slot = slots.get(node.name);
        if (slot === undefined) throw new Error(`Unbound variable: ${node.name}`);
        code.push(Op.Var, slot);
        push(1);
        return;
      }
      case 'neg':
        emit(node.a);
        code.push(Op.Neg, 0);
        return;
      case 'bin': {
        emit(node.a);
        emit(node.b);
        const op = { '+': Op.Add, '-': Op.Sub, '*': Op.Mul, '/': Op.Div, '^': Op.Pow }[node.op];
        code.push(op, 0);
        push(-1);
        return;
      }
      case 'call': {
        for (const a of node.args) emit(a);
        if (node.args.length === 1 && node.name in FN1) {
          code.push(Op.Fn1, FN1_NAMES.indexOf(node.name));
        } else if (node.args.length === 2 && node.name in FN2) {
          code.push(Op.Fn2, FN2_NAMES.indexOf(node.name));
          push(-1);
        } else if (node.args.length === 3 && node.name in FN3) {
          code.push(Op.Fn3, FN3_NAMES.indexOf(node.name));
          push(-2);
        } else if (node.args.length === 4 && Object.hasOwn(FN4, node.name)) {
          code.push(Op.Fn4, FN4_NAMES.indexOf(node.name));
          push(-3);
        } else {
          throw new Error(`Cannot evaluate ${plainFnName(node.name)}() here.`);
        }
        return;
      }
      case 'piecewise': {
        // No jumps: every case value evaluates eagerly and Sel keeps the first
        // whose condition holds. A NaN in a discarded branch costs nothing.
        const emitCond = (cond: Expr): void => {
          if (cond.kind !== 'ineq') throw new Error('Piecewise conditions must be inequalities.');
          ineqComparisons(cond).forEach(({ op, l, r }, k) => {
            emit(l);
            emit(r);
            code.push(op === '<' ? Op.Lt : op === '<=' ? Op.Le : op === '>' ? Op.Gt : Op.Ge, 0);
            push(-1);
            if (k > 0) {
              code.push(Op.Mul, 0); // AND of 0/1 masks
              push(-1);
            }
          });
        };
        const emitCases = (k: number): void => {
          if (k === node.cases.length) {
            if (node.otherwise) emit(node.otherwise);
            else {
              code.push(Op.Const, consts.length);
              consts.push(NaN);
              push(1);
            }
            return;
          }
          emitCond(node.cases[k].cond);
          emit(node.cases[k].value);
          emitCases(k + 1);
          code.push(Op.Sel, 0);
          push(-2);
        };
        emitCases(0);
        return;
      }
      default:
        throw new Error(`Cannot evaluate a ${node.kind} node numerically.`);
    }
  };
  emit(e);
  return { code, consts, depth: maxDepth };
}

const FN1_TABLE = FN1_NAMES.map(n => FN1[n]);
const FN2_TABLE = FN2_NAMES.map(n => FN2[n]);
const FN3_TABLE = FN3_NAMES.map(n => FN3[n]);
const FN4_TABLE = FN4_NAMES.map(n => FN4[n]);

export function run(p: Prog, vars: ArrayLike<number>, stack: Float64Array): number {
  const { code, consts } = p;
  let sp = 0;
  for (let i = 0; i < code.length; i += 2) {
    const arg = code[i + 1];
    switch (code[i]) {
      case Op.Const: stack[sp++] = consts[arg]; break;
      case Op.Var: stack[sp++] = vars[arg]; break;
      case Op.Add: sp--; stack[sp - 1] += stack[sp]; break;
      case Op.Sub: sp--; stack[sp - 1] -= stack[sp]; break;
      case Op.Mul: sp--; stack[sp - 1] *= stack[sp]; break;
      case Op.Div: sp--; stack[sp - 1] /= stack[sp]; break;
      case Op.Pow: sp--; stack[sp - 1] = realPow(stack[sp - 1], stack[sp]); break;
      case Op.Neg: stack[sp - 1] = -stack[sp - 1]; break;
      case Op.Fn1: stack[sp - 1] = FN1_TABLE[arg](stack[sp - 1]); break;
      case Op.Fn2: sp--; stack[sp - 1] = FN2_TABLE[arg](stack[sp - 1], stack[sp]); break;
      case Op.Fn3: sp -= 2; stack[sp - 1] = FN3_TABLE[arg](stack[sp - 1], stack[sp], stack[sp + 1]); break;
      case Op.Fn4: sp -= 3; stack[sp - 1] = FN4_TABLE[arg](stack[sp - 1], stack[sp], stack[sp + 1], stack[sp + 2]); break;
      // Comparisons yield 1/0 masks (0 for NaN operands, like a false branch).
      case Op.Lt: sp--; stack[sp - 1] = stack[sp - 1] < stack[sp] ? 1 : 0; break;
      case Op.Le: sp--; stack[sp - 1] = stack[sp - 1] <= stack[sp] ? 1 : 0; break;
      case Op.Gt: sp--; stack[sp - 1] = stack[sp - 1] > stack[sp] ? 1 : 0; break;
      case Op.Ge: sp--; stack[sp - 1] = stack[sp - 1] >= stack[sp] ? 1 : 0; break;
      // [cond, then, else] → the first matching case wins.
      case Op.Sel: sp -= 2; stack[sp - 1] = stack[sp - 1] === 1 ? stack[sp] : stack[sp + 1]; break;
    }
  }
  return stack[sp - 1];
}

/**
 * A one-variable sampler over a compiled program, for CPU paths that evaluate
 * one expression hundreds of times a frame (a definite integral's shaded
 * area): bind the frame's values once, then call per x. `names` are the other
 * variables the expression reads; one without a value reads NaN, as an
 * unbound name makes the tree-walking evaluator's result undefined. Null when
 * the expression has a form the VM does not run — callers fall back to
 * evaluate().
 */
export function compileSampler(
  e: Expr, v: string, names: readonly string[],
): ((env: Record<string, number>) => (x: number) => number) | null {
  const others = names.filter(n => n !== v);
  const slots = new Map<string, number>([[v, 0], ...others.map((n, k): [string, number] => [n, k + 1])]);
  let prog: Prog;
  try { prog = compileProg(e, slots); } catch { return null; }
  const vars = new Float64Array(others.length + 1);
  const stack = new Float64Array(Math.max(prog.depth, 1));
  return env => {
    others.forEach((n, k) => { vars[k + 1] = Object.hasOwn(env, n) ? env[n] : NaN; });
    return x => { vars[0] = x; return run(prog, vars, stack); };
  };
}
