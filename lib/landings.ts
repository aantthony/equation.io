/**
 * Intent landing pages: one search query, one live graph, a handful of
 * related examples. The worker injects title/og tags from this file so
 * crawlers see them without running JS; the page module hydrates the rest.
 *
 * Hero and related slugs name items in web/about/showcase.ts — a test
 * checks they exist and that heroEqs stay in sync with the gallery.
 */
import { encodePayload } from './link.ts';

export interface LandingFaq {
  q: string;
  a: string;
}

export interface Landing {
  slug: string;
  /** Canonical path, with trailing slash. */
  path: string;
  /** <title> and og:title, without the site suffix. */
  title: string;
  h1: string;
  lead: string;
  contrast: string;
  syntax: string[];
  prompts: string[];
  faq: LandingFaq[];
  /** SHOWCASE slug for the live hero. */
  hero: string;
  /** Equation rows of that hero; must match the gallery item. */
  heroEqs: string[];
  /** SHOWCASE slugs for the related cards. */
  related: string[];
  /** /about/ gallery group this page is the intent for. */
  group: string;
  /** Short label linked from that about-group heading. */
  nav: string;
  /**
   * og:image. `preview` is /api/og/ of heroEqs (the CPU renderer must
   * actually draw them). `shot` is the stable PNG at public/shots/<slug>.png
   * for graphs that preview cannot draw (complex potentials, domain coloring).
   */
  og: 'preview' | 'shot';
}

export const LANDINGS: readonly Landing[] = [
  {
    slug: 'implicit',
    path: '/implicit/',
    title: 'Implicit equation grapher',
    h1: 'Graph an equation without solving for y',
    lead: 'Type x² + y² = 4, or a tangle like (x²+y²)² = 8(x²−y²), and the locus is the graph — compiled to your GPU as you type.',
    contrast: 'You do not solve for y. Write the equation as it appears on paper.',
    syntax: [
      'x^2 + y^2 = 4 — a circle, as an implicit curve',
      '(x^2+y^2)^2 = 8(x^2-y^2) — a lemniscate; no solving for y',
      'y < x/2 + 1 — inequalities shade their region',
      '4 <= x^2 + y^2 <= 9 — a chained comparison is an annulus',
      'y = {0 < x < 2: x^2} — a domain restriction',
    ],
    prompts: [
      'Graph (x^2+y^2)^2 = 8(x^2-y^2) as an implicit curve on equation.io',
      'Shade the annulus 4 ≤ x² + y² ≤ 9',
      'Plot y = tan(x) and the circle x² + y² = 4 together',
    ],
    faq: [
      {
        q: 'Do I need to solve for y first?',
        a: 'No. An equation in x and y is the curve; an inequality is the region. Equation.io plots the locus you wrote.',
      },
      {
        q: 'Can I share the graph?',
        a: 'Yes. The address is the document — copy the /g/ link. No account.',
      },
    ],
    hero: 'lemniscate',
    heroEqs: ['(x^2+y^2)^2 = 8(x^2-y^2)'],
    related: ['moire', 'annulus', 'wave-band', 'piecewise'],
    group: 'Curves & regions',
    nav: 'Implicit grapher',
    og: 'preview',
  },
  {
    slug: 'slope-field',
    path: '/slope-field/',
    title: 'Slope field calculator',
    h1: 'Type y′ = f(x, y) and the field appears',
    lead: 'A slope field, a vector field, or a phase portrait — click the canvas to trace a solution.',
    contrast: 'No mode switch and no slope-field widget. The notation is the plot.',
    syntax: [
      "y' = x - y — a slope field; click to trace a solution",
      'dy/dx = y(1 - y/4) — logistic growth',
      "(x', y') = (y, -sin(x)) — a phase portrait",
      '(-y, x) — a vector field, drawn as animated streamlines',
      "a = -1; b = -1/4; A = ((0, 1), (a, b)); (x', y') = A (x, y) — a linear system as its matrix",
    ],
    prompts: [
      "Show a slope field for y' = x - y on equation.io so I can click to trace solutions",
      "Phase portrait of the pendulum (x', y') = (y, -sin(x))",
      'Vector field (-y, x) as streamlines',
    ],
    faq: [
      {
        q: 'How do I draw a solution curve?',
        a: 'Click the canvas. Each click drops an RK4 integral curve through that point; double-click clears them.',
      },
      {
        q: 'Is a phase portrait a different tool?',
        a: "No. Write (x', y') = (P, Q) and it is a phase portrait. A tuple in x and y without primes is a vector field.",
      },
    ],
    hero: 'slope-field',
    heroEqs: ["y' = x - y"],
    related: ['pendulum-phase', 'vector-swirl', 'double-pendulum'],
    group: 'Vector fields & ODEs',
    nav: 'Slope fields',
    og: 'preview',
  },
  {
    slug: 'complex',
    path: '/complex/',
    title: 'Complex function plotter',
    h1: 'Write f(w) and see the map',
    lead: 'w is the plane as a complex number. A complex expression draws field lines and equipotentials; wrap it in domain(…) or conformal(…) for the other views.',
    contrast: 'Not a separate complex mode. i and w make a value complex; the renderer follows.',
    syntax: [
      'ln(w-2) - ln(w+2) — a dipole; streamlines and equipotentials',
      'w + 4/w — flow past a cylinder',
      'domain((w^3 - 1)/w) — hue is arg, brightness is |f|',
      'conformal(w^2/4) — the image of the grid under f',
      'exp(i 2 pi u) — a path in the Argand plane',
    ],
    prompts: [
      'Plot the complex potential ln(w-2)-ln(w+2) on equation.io',
      'Domain coloring of (w^3-1)/w',
      'Show the Joukowski map conformal(w + 1/w)',
    ],
    faq: [
      {
        q: 'What is w?',
        a: 'The complex plane point x + iy. Write an expression in w and the field lines (Im f) and equipotentials (Re f) appear.',
      },
      {
        q: 'How do I get domain coloring or a conformal grid?',
        a: 'Wrap the same function: domain(f) or conformal(f). Nothing else changes.',
      },
    ],
    hero: 'flow-cylinder',
    heroEqs: ['w + 4/w'],
    related: ['quadrupole', 'domain-coloring', 'conformal-square', 'joukowski'],
    group: 'Fields & complex maps',
    nav: 'Complex maps',
    og: 'shot',
  },
];

export function landingFromPath(pathname: string): Landing | undefined {
  const slug = pathname.replace(/\/+$/, '').slice(1);
  return LANDINGS.find(l => l.slug === slug);
}

export function landingForGroup(group: string): Landing | undefined {
  return LANDINGS.find(l => l.group === group);
}

/** Paths the Worker must handle (with and without the trailing slash). */
export function landingWorkerPaths(): string[] {
  return LANDINGS.flatMap(l => [l.path.slice(0, -1), l.path]);
}

export function graphUrl(eqs: string[]): string {
  return '/g/' + encodePayload(eqs);
}

export function landingJsonLd(page: Landing, origin: string): object {
  const url = origin + page.path;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        name: page.title,
        url,
        description: page.lead,
        isPartOf: {
          '@type': 'WebApplication',
          name: 'Equation.io',
          url: origin + '/',
          applicationCategory: 'EducationalApplication',
          offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        },
      },
      {
        '@type': 'FAQPage',
        mainEntity: page.faq.map(f => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
      {
        '@type': 'HowTo',
        name: page.h1,
        description: page.lead,
        step: page.syntax.map((text, i) => ({
          '@type': 'HowToStep',
          position: i + 1,
          text,
        })),
      },
    ],
  };
}
