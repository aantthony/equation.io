import type { Analysis } from './analysis.ts';
import { freeVars, parseExpr } from './expr.ts';
import { sliderForm } from './slider.ts';

/** Numeric sliders whose values are consumed only at runtime. Be conservative:
 * definitions, fitting, state seeds and data can bake values into their output,
 * and diagnostics must be rechecked when an invalid document changes. */
export function runtimeSliderNames(analysis: Analysis): Set<string> {
  const { document, rows, defs } = analysis;
  if (
    rows.some(row => row.error || row.dataLocal) ||
    defs.states.size ||
    defs.rvs.size ||
    defs.tables.size ||
    defs.sequences.size ||
    document.raw.some(d => d.kind === 'regression')
  )
    return new Set();
  const blocked = new Set(document.structuralConsts);
  for (const definition of document.raw) {
    if (!('rhs' in definition)) return new Set();
    try {
      // A dependent definition may fold a scalar into a list, matrix, function
      // or constant. Let the normal compiler settle all such dependencies.
      const expr = parseExpr(definition.rhs, document.fnNames, document.listNames, document.valueNames);
      for (const name of freeVars(expr)) blocked.add(name);
    } catch {
      return new Set();
    }
  }
  return new Set(
    rows.flatMap(row => {
      const d = row.def;
      return d?.kind === 'const' &&
        sliderForm(d.rhs, document.fnNames) &&
        !blocked.has(d.name) &&
        defs.consts.has(d.name)
        ? [d.name]
        : [];
    }),
  );
}
