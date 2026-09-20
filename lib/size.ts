/**
 * Structural size of an expression tree: what a tree-walking evaluator, a
 * compiler, or a symbolic pass pays for it. One generic walk over the node
 * objects, so a new Expr kind cannot be under-counted.
 */

/**
 * Nodes in `e`, a shared subtree counted once per use. With `memo`, each
 * distinct node object is walked once — so a tree built with heavy sharing
 * (a complex split, an inlined composition) is sized in time linear in the
 * objects that exist, however astronomically large the tree they spell.
 * Only pass a memo while the nodes are not being mutated.
 */
export function countNodes(e: unknown, memo?: WeakMap<object, number>): number {
  if (e === null || typeof e !== 'object') return 0;
  // A data column is one node, not one per element.
  if (ArrayBuffer.isView(e)) return 1;
  const known = memo?.get(e);
  if (known !== undefined) return known;
  let n = 1;
  for (const v of Object.values(e)) {
    if (Array.isArray(v)) for (const item of v) n += countNodes(item, memo);
    else if (typeof v === 'object') n += countNodes(v, memo);
  }
  memo?.set(e, n);
  return n;
}

/** Whether `e` has more than `limit` nodes, walking no further than it takes
 *  to know — so a huge unshared tree is refused in time bounded by the limit.
 *  `leaf` names nodes that count as one whatever they hold. */
export function exceedsNodes(e: unknown, limit: number, leaf?: (x: object) => boolean): boolean {
  let n = 0;
  const walk = (x: unknown): boolean => {
    if (x === null || typeof x !== 'object') return false;
    if (++n > limit) return true;
    if (ArrayBuffer.isView(x) || leaf?.(x)) return false;
    for (const v of Object.values(x)) {
      if (Array.isArray(v) ? v.some(walk) : walk(v)) return true;
    }
    return false;
  };
  return walk(e);
}
