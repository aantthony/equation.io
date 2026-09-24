import { describe, expect, it } from 'vitest';
import { FEATURED, FEATURED_KEY, nextFeatured, sameRows } from './featured.ts';

function memStore(init: Record<string, string> = {}): Storage {
  const data = { ...init };
  return {
    get length() {
      return Object.keys(data).length;
    },
    clear() {
      for (const k of Object.keys(data)) delete data[k];
    },
    getItem(k: string) {
      return k in data ? data[k] : null;
    },
    setItem(k: string, v: string) {
      data[k] = v;
    },
    removeItem(k: string) {
      delete data[k];
    },
    key(i: number) {
      return Object.keys(data)[i] ?? null;
    },
  };
}

describe('featured graphs', () => {
  it('has a handful of distinct graphs, none of them the old sine default', () => {
    expect(FEATURED.length).toBeGreaterThanOrEqual(8);
    const keys = FEATURED.map(g => g.eqs.join('\n'));
    expect(new Set(keys).size).toBe(FEATURED.length);
    for (const g of FEATURED) {
      expect(g.title.length).toBeGreaterThan(0);
      expect(g.eqs.length).toBeGreaterThan(0);
      expect(sameRows(g.eqs, ['y = sin(x)'])).toBe(false);
    }
  });

  it('rotates through the list and persists the cursor', () => {
    const store = memStore();
    const seen: string[] = [];
    for (let i = 0; i < FEATURED.length; i++) {
      seen.push(nextFeatured(store).title);
    }
    expect(seen).toEqual(FEATURED.map(g => g.title));
    expect(store.getItem(FEATURED_KEY)).toBe(String(FEATURED.length));
    expect(nextFeatured(store).title).toBe(FEATURED[0].title);
  });

  it('skips the graph already on screen', () => {
    const store = memStore({ [FEATURED_KEY]: '0' });
    const next = nextFeatured(store, FEATURED[0].eqs);
    expect(next.title).toBe(FEATURED[1].title);
  });

  it('survives a missing store', () => {
    expect(nextFeatured(null).title).toBe(FEATURED[0].title);
  });
});
