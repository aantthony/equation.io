import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHOWCASE } from '../web/about/showcase.ts';
import { LANDINGS, graphUrl, landingForGroup, landingFromPath, landingJsonLd, landingWorkerPaths } from './landings.ts';

describe('intent landings', () => {
  it('have unique slugs, paths, and groups', () => {
    const slugs = LANDINGS.map(l => l.slug);
    const paths = LANDINGS.map(l => l.path);
    const groups = LANDINGS.map(l => l.group);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(paths).size).toBe(paths.length);
    expect(new Set(groups).size).toBe(groups.length);
  });

  it('use trailing-slash canonical paths that round-trip fromPath', () => {
    for (const page of LANDINGS) {
      expect(page.path).toBe(`/${page.slug}/`);
      expect(landingFromPath(page.path)).toBe(page);
      expect(landingFromPath(page.path.slice(0, -1))).toBe(page);
      expect(landingForGroup(page.group)).toBe(page);
    }
    expect(landingFromPath('/about/')).toBeUndefined();
    expect(landingFromPath('/landing/')).toBeUndefined();
  });

  it('point at real showcase items, and heroEqs match the gallery', () => {
    for (const page of LANDINGS) {
      const hero = SHOWCASE.find(i => i.slug === page.hero);
      expect(hero, page.hero).toBeTruthy();
      expect(hero!.eqs).toEqual(page.heroEqs);
      expect(hero!.group).toBe(page.group);
      for (const slug of page.related) {
        const item = SHOWCASE.find(i => i.slug === slug);
        expect(item, slug).toBeTruthy();
      }
    }
  });

  it('keep copy short', () => {
    for (const page of LANDINGS) {
      expect(page.lead.length).toBeLessThan(280);
      expect(page.syntax.length).toBeGreaterThanOrEqual(3);
      expect(page.syntax.length).toBeLessThanOrEqual(6);
      expect(page.faq).toHaveLength(2);
      expect(page.prompts.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('emits shareable graph URLs', () => {
    const eqs = ['y = x^2'];
    expect(graphUrl(eqs)).toMatch(/^\/g\//);
  });

  it('builds FAQ JSON-LD', () => {
    const json = landingJsonLd(LANDINGS[0]!, 'https://equation.io') as {
      '@graph': Array<{ '@type': string; mainEntity?: unknown[] }>;
    };
    const types = json['@graph'].map(n => n['@type']);
    expect(types).toEqual(['WebPage', 'FAQPage', 'HowTo']);
    expect(json['@graph'][1]!.mainEntity).toHaveLength(2);
  });

  it('keeps a public PNG for shot-og landings', () => {
    for (const page of LANDINGS) {
      if (page.og !== 'shot') continue;
      const file = new URL(`../web/public/shots/${page.slug}.png`, import.meta.url);
      expect(existsSync(file), `${page.slug}.png`).toBe(true);
    }
  });

  it('lists every landing in the sitemap', () => {
    const sitemap = readFileSync(new URL('../web/public/sitemap.xml', import.meta.url), 'utf8');
    for (const page of LANDINGS) {
      expect(sitemap).toContain(`<loc>https://equation.io${page.path}</loc>`);
    }
  });

  it('covers every landing path in run_worker_first via landingWorkerPaths', () => {
    expect(landingWorkerPaths()).toEqual([
      '/implicit',
      '/implicit/',
      '/slope-field',
      '/slope-field/',
      '/complex',
      '/complex/',
    ]);
  });
});
