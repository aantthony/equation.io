/** Screenshot / animation-capture helpers shared by the app and tests. */

/** Auto-stop so a forgotten recording cannot run unbounded. */
export const CAPTURE_SECONDS = 8;

/** Long-edge cap for video; PNGs keep the canvas's native (retina) size. */
export const VIDEO_MAX_EDGE = 1440;

const RECORDER_MIMES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
];

export function pickRecorderMime(supported: (type: string) => boolean): string | null {
  return RECORDER_MIMES.find(supported) ?? null;
}

export function extensionForMime(mime: string): 'webm' | 'mp4' {
  return /mp4/i.test(mime) ? 'mp4' : 'webm';
}

export function captureSize(srcW: number, srcH: number, maxEdge: number): { w: number; h: number } {
  const w = Math.max(1, srcW | 0);
  const h = Math.max(1, srcH | 0);
  const edge = Math.max(w, h);
  if (edge <= maxEdge) return { w, h };
  const s = maxEdge / edge;
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}
