/**
 * Light/dark theming. Colors used by the WebGL passes are plain numbers baked
 * into shader source at build time; since programs are cached by source string
 * (see ProgramCache), switching theme just recompiles a differently-colored
 * variant — no uniforms to thread through. The overlay canvas and the CSS
 * panel read their colors from here too, so one switch moves everything.
 *
 * `theme` is a live singleton: `applyTheme` mutates it in place, so modules
 * that captured the import keep seeing the current palette.
 */

type RGB = [number, number, number];

export interface Theme {
  dark: boolean;
  /** Canvas background (WebGL clear color, 2D grid backdrop). */
  bg: RGB;
  /** 2D minor / major grid line colors and the axis line color. */
  gridMinor: RGB;
  gridMajor: RGB;
  axis: RGB;
  /** 3D reference-plane grid line color, and how strongly its grid lines
   *  (not its axes) are drawn: dark lines on white need half the weight of
   *  light lines on dark to sit as far back. */
  plane: RGB;
  planeGrid: number;
  /** Overlay canvas: axis numerals / labels. */
  label: string;
  /** Overlay canvas: stroke around plotted points. */
  pointOutline: string;
  /** Equation colors, cycled by clicking a line's color dot. */
  palette: RGB[];
}

const LIGHT: Theme = {
  dark: false,
  bg: [1, 1, 1],
  gridMinor: [0.91, 0.91, 0.91],
  gridMajor: [0.8, 0.8, 0.8],
  axis: [0.25, 0.25, 0.25],
  plane: [0.25, 0.25, 0.25],
  planeGrid: 0.5,
  label: '#555',
  pointOutline: '#fff',
  palette: [
    [0.176, 0.439, 0.702], // blue
    [0.78, 0.267, 0.251], // red
    [0.22, 0.549, 0.275], // green
    [0.376, 0.259, 0.651], // purple
    [0.98, 0.494, 0.098], // orange
    [0.0, 0.0, 0.0], // black
  ],
};

const DARK: Theme = {
  dark: true,
  bg: [0.09, 0.1, 0.12],
  gridMinor: [0.19, 0.2, 0.23],
  gridMajor: [0.3, 0.31, 0.35],
  axis: [0.55, 0.56, 0.6],
  plane: [0.55, 0.56, 0.6],
  planeGrid: 1,
  label: '#8b909a',
  pointOutline: '#16181d',
  palette: [
    [0.4, 0.62, 0.92], // blue
    [0.92, 0.45, 0.42], // red
    [0.42, 0.78, 0.48], // green
    [0.65, 0.52, 0.95], // purple
    [0.98, 0.62, 0.28], // orange
    [0.9, 0.91, 0.93], // light (stands in for black)
  ],
};

/** The live theme; mutated in place so imported references stay current. */
export const theme: Theme = { ...LIGHT };

/** A `vec3(r, g, b)` GLSL literal, for baking a color into shader source. */
export function glslVec3([r, g, b]: RGB): string {
  const f = (n: number) => n.toFixed(4);
  return `vec3(${f(r)}, ${f(g)}, ${f(b)})`;
}

const STORAGE_KEY = 'eq-theme';
const listeners = new Set<() => void>();

/** Register a callback fired after every theme change (re-render, re-decorate). */
export function onThemeChange(cb: () => void): void {
  listeners.add(cb);
}

function set(mode: 'light' | 'dark'): void {
  Object.assign(theme, mode === 'dark' ? DARK : LIGHT);
  document.documentElement.dataset.theme = mode;
  // Installed/standalone, the OS tints its chrome with theme-color; derive it
  // from the canvas clear color so the two can never drift apart. The manual
  // toggle means a media-scoped <meta> wouldn't be enough — it has to move here.
  const meta = document.getElementById('theme-color');
  if (meta) {
    const hex = theme.bg.map(c =>
      Math.round(c * 255)
        .toString(16)
        .padStart(2, '0'),
    );
    meta.setAttribute('content', `#${hex.join('')}`);
  }
  for (const cb of listeners) cb();
}

/** Follow the chat host without persisting its preference to the website. */
export function setHostTheme(mode: 'light' | 'dark'): void {
  if (theme.dark !== (mode === 'dark')) set(mode);
}

/** Switch theme in response to a user click, and remember the choice. */
export function toggleTheme(): void {
  const next = theme.dark ? 'light' : 'dark';
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {} // private mode / disabled storage: still switch for the session
  set(next);
}

/**
 * Resolve the initial theme: an explicit past choice wins, otherwise follow the
 * OS setting and keep following it until the user picks a side themselves.
 */
export function initTheme(): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {}
  const mql = window.matchMedia?.('(prefers-color-scheme: dark)');
  set(stored === 'dark' || stored === 'light' ? stored : mql?.matches ? 'dark' : 'light');
  mql?.addEventListener?.('change', e => {
    let s: string | null = null;
    try {
      s = localStorage.getItem(STORAGE_KEY);
    } catch {}
    if (s !== 'dark' && s !== 'light') set(e.matches ? 'dark' : 'light');
  });
}
