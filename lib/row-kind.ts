/**
 * A row's kind as the MCP tools report it (worker/mcp.ts).
 */
import type { CpuPlan } from './compiler.ts';
import type { Definition } from './defs.ts';
import { type Classified, publicKind } from './plot.ts';
import type { ViewSpec } from './view.ts';
import type { Expr } from './expr.ts';
import { flatName, flatOfNode } from './pga.ts';

export interface KindSource {
  comment?: boolean;
  def?: Definition;
  view?: ViewSpec;
  dist?: 'density' | 'pmf' | 'probability' | 'expectation';
  /** Why the row can't be read here: it reads a data file on the author's device. */
  dataLocal?: string;
  cls?: Classified;
  cpu?: CpuPlan;
}

/** Probability rows classify as plain curves and regions; these say what they are. */
const DIST_KINDS = {
  density: 'random variable (density curve)',
  pmf: 'discrete random variable (pmf stems)',
  expectation: 'expectation (mean readout)',
} as const;

/** Names the document binds to something other than a number, so a `const`
 *  definition of one is not reported as though it were a slider. */
export interface KindNames {
  tables: { has(name: string): boolean };
  intervals?: { has(name: string): boolean };
  mats?: { has(name: string): boolean };
  tensors?: { has(name: string): boolean };
  multivectors?: { has(name: string): boolean; get?(name: string): Expr | undefined };
  lists?: { has(name: string): boolean };
  points?: { has(name: string): boolean };
}

export function rowKind(row: KindSource, names: KindNames): string | undefined {
  if (row.comment) return 'comment (group heading)';
  if (row.def) return `definition (${row.def.kind === 'const' ? constKind(row.def.name, names) : row.def.kind})`;
  if (row.view?.kind === 'split') return 'panel divider (the rows below it draw in a panel of their own)';
  if (row.view?.kind === 'grid') return "grid (what draws behind its panel's plots)";
  if (row.view) return `viewport (${row.view.kind})`;
  if (row.dist === 'probability') {
    // An event with no single-variable shape (P(X < Y)) is estimated, not drawn.
    return row.cpu?.type === 'prob' && !row.cpu.shade ? 'probability (readout only)' : 'probability (shaded area)';
  }
  if (row.dist) return DIST_KINDS[row.dist];
  if (row.dataLocal) return "data (reads a file on the author's device)";
  return row.cls ? publicKind(row.cls.object) : undefined;
}

function constKind(name: string, names: KindNames): string {
  // `adults = person[…]` scans as a constant, but what it defines is another data file.
  if (names.tables.has(name)) return 'filtered data';
  if (names.intervals?.has(name)) return 'interval';
  if (names.mats?.has(name)) return 'matrix';
  if (names.tensors?.has(name)) return 'tensor';
  if (names.multivectors?.has(name)) {
    // A line or plane is written in as a multivector is, but is not one.
    const flat = flatOfNode(names.multivectors.get?.(name) ?? { kind: 'num', value: 0 });
    return (flat && flatName(flat.dim, flat.grade)) ?? 'multivector';
  }
  if (names.points?.has(name)) return 'point';
  if (names.lists?.has(name)) return 'list';
  return 'const';
}
