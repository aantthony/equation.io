/**
 * Voice mode's credit key in this browser (web/voice.ts): small and loaded
 * with the app, so the page knows whether to fetch voice mode at all.
 */
const STORE_KEY = 'voiceKey';

/** A fragment that is only an unlock (`#voice=<key>`, or `#voice=` to forget), not a graph. */
const KEY_FRAGMENT = /^#voice=(eqv_[\w-]*)?$/;

/**
 * The key this browser was unlocked with, taking a new one from the URL.
 * Runs before boot reads the URL (web/main.ts), so a `#voice=` fragment is
 * gone before it could be read as a graph. The fragment form never reaches
 * the server; `?voice=` does, and may be logged.
 */
export function readKey(): string | null {
  try {
    const params = new URLSearchParams(location.search);
    const fragment = KEY_FRAGMENT.exec(location.hash);
    const given = fragment ? (fragment[1] ?? '') : params.get('voice');
    if (given !== null) {
      if (given) localStorage.setItem(STORE_KEY, given);
      else localStorage.removeItem(STORE_KEY);
      params.delete('voice');
      const search = params.toString();
      const hash = fragment ? '' : location.hash;
      history.replaceState(history.state, '', location.pathname + (search ? '?' + search : '') + hash);
    }
    return localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}

export function forgetKey() {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    // Storage blocked: nothing was remembered.
  }
}
