/**
 * The palette slot a new row takes: the one the fewest existing rows use,
 * earliest on a tie. A fresh document therefore runs through the palette in
 * order (blue, red, green, …), matching the share image (worker/og.ts), and a
 * row added later fills a gap instead of repeating a neighbour's color — or
 * landing on the last slot (black) because of how many rows came and went.
 */
export function freshColorIndex(used: Iterable<number>, size: number): number {
  const counts = new Array<number>(size).fill(0);
  for (const i of used) if (i >= 0 && i < size) counts[i]++;
  return counts.indexOf(Math.min(...counts));
}
