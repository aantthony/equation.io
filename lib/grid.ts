/**
 * Grid families from coordinate fields.
 *
 * A coordinate field c(x, y) contributes grid lines along its level sets
 * c = k·spacing, rendered per pixel with the same distance-estimate
 * antialiasing as curves. The default Cartesian grid is just the identity
 * pair (x, y) going through the same path; polar is (sqrt(x²+y²), atan2(y,x)).
 */
import { diff } from './diff.ts';
import { type Expr, evaluate, freeVars, substVars } from './expr.ts';
import { toGLSL } from './glsl.ts';

export interface GridField {
  name: string;
  /** Resolved expression: free vars in {x, y, t} ∪ constants. */
  expr: Expr;
  /** GLSL for c(x, y); user constants appear as u_<name>. */
  glsl: string;
  /** GLSL for ∇c in math units; absent → the shader uses screen derivatives. */
  gradGlsl?: [string, string];
  /** ∇c as CPU-evaluable exprs (original constant names), for spacing. */
  grad?: [Expr, Expr];
  /** User constants the field references. */
  params: string[];
  /** Angle-valued (contains atan2): spacing snaps to divisors of 2π. */
  angular: boolean;
}

export function hasAtan2(e: Expr): boolean {
  switch (e.kind) {
    case 'num':
    case 'var':
      return false;
    case 'neg': return hasAtan2(e.a);
    case 'bin': return hasAtan2(e.a) || hasAtan2(e.b);
    case 'call':
      return e.name === 'atan2' || (e.name === 'atan' && e.args.length === 2) || e.args.some(hasAtan2);
    case 'eq': return hasAtan2(e.l) || hasAtan2(e.r);
    case 'ineq': return hasAtan2(e.l) || hasAtan2(e.r);
    case 'vec': return e.items.some(hasAtan2);
    case 'list': return e.items.some(hasAtan2);
    case 'data':
    case 'str':
    case 'text': return false;
    case 'piecewise':
      return e.cases.some(c => hasAtan2(c.cond) || hasAtan2(c.value))
        || (e.otherwise ? hasAtan2(e.otherwise) : false);
  }
}

export function buildGridField(name: string, expr: Expr, constNames: ReadonlySet<string>): GridField {
  const params = [...freeVars(expr)].filter(v => constNames.has(v)).sort();
  const uMap = Object.fromEntries(params.map(p => [p, { kind: 'var', name: 'u_' + p } as Expr]));
  const sub = (e: Expr) => (params.length ? substVars(e, uMap) : e);
  let grad: [Expr, Expr] | undefined;
  let gradGlsl: [string, string] | undefined;
  try {
    const gx = diff(expr, 'x');
    const gy = diff(expr, 'y');
    gradGlsl = [toGLSL(sub(gx)), toGLSL(sub(gy))];
    grad = [gx, gy];
  } catch {
    // Non-smooth (floor, mod, …): the shader falls back to dFdx/dFdy. The
    // analytic gradient matters most for atan2, whose screen derivatives
    // explode across the branch cut, and those always differentiate.
  }
  return { name, expr, glsl: toGLSL(sub(expr)), gradGlsl, grad, params, angular: hasAtan2(expr) };
}

/**
 * Spacings for angle-valued coordinates: divisors of 2π, so grid lines land
 * exactly on the atan2 branch cut instead of straddling it.
 */
const ANGULAR_MAJORS = [
  Math.PI / 96, Math.PI / 48, Math.PI / 24, Math.PI / 12, Math.PI / 6,
  Math.PI / 4, Math.PI / 2, Math.PI, 2 * Math.PI,
];

/** Angular analogue of niceSpacing: cupp is coordinate units per pixel. */
export function angularSpacing(cupp: number, minPx: number): { major: number; minor: number } {
  const target = cupp * minPx;
  for (const m of ANGULAR_MAJORS) {
    if (m >= target) return { major: m, minor: m / 4 };
  }
  return { major: 2 * Math.PI, minor: Math.PI / 2 };
}

/**
 * Median |∇c| over sample points (skipping singular/undefined ones), used to
 * convert "pixels between grid lines" into coordinate-unit spacing. h is the
 * finite-difference step for fields with no symbolic gradient.
 */
export function sampleGradMag(
  f: GridField,
  pts: ReadonlyArray<readonly [number, number]>,
  env: Record<string, number>,
  h: number,
  ratio = 1,
): number {
  const mags: number[] = [];
  for (const [x, y] of pts) {
    let gx: number;
    let gy: number;
    try {
      if (f.grad) {
        gx = evaluate(f.grad[0], { ...env, x, y });
        gy = evaluate(f.grad[1], { ...env, x, y });
      } else {
        const ev = (px: number, py: number) => evaluate(f.expr, { ...env, x: px, y: py });
        gx = (ev(x + h, y) - ev(x - h, y)) / (2 * h);
        gy = (ev(x, y + h) - ev(x, y - h)) / (2 * h);
      }
    } catch {
      continue;
    }
    const m = Math.hypot(gx, gy / ratio);
    if (isFinite(m) && m > 0) mags.push(m);
  }
  if (!mags.length) return 1;
  mags.sort((a, b) => a - b);
  return mags[mags.length >> 1];
}
