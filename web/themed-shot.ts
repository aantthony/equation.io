/**
 * Screenshots come in two renders: `<stem>.webp` of the light theme and
 * `<stem>.dark.webp` of the dark one (scripts/screenshots.ts shoots both).
 * An image set up here shows the render matching the page's data-theme, and
 * swaps when theme.js or theme.ts flips it.
 */

interface ShotUrls {
  light: string;
  /** Missing only while a new shot awaits its dark render; light stands in. */
  dark?: string;
}

/** Look a stem up in an `import.meta.glob` of `*.webp` shots. */
export function shotUrls(glob: Record<string, string>, stem: string): ShotUrls | undefined {
  const light = glob[`${stem}.webp`];
  return light ? { light, dark: glob[`${stem}.dark.webp`] } : undefined;
}

// Kept after an image leaves the DOM: the examples menu reuses detached cards.
const images = new Map<HTMLImageElement, ShotUrls>();

function paint(img: HTMLImageElement, urls: ShotUrls): void {
  const dark = document.documentElement.dataset.theme === 'dark';
  const src = (dark && urls.dark) || urls.light;
  if (img.getAttribute('src') !== src) img.src = src;
}

export function themedShot(img: HTMLImageElement, urls: ShotUrls): void {
  images.set(img, urls);
  paint(img, urls);
}

new MutationObserver(() => {
  for (const [img, urls] of images) paint(img, urls);
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
