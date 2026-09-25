/**
 * Composite the WebGL graph and the 2D overlay into a PNG or a short video.
 *
 * The WebGL buffer is not preserved across frames, so every capture path
 * draws a fresh frame first, then blits both canvases in the same turn.
 */
import { CAPTURE_SECONDS, VIDEO_MAX_EDGE, captureSize, extensionForMime, pickRecorderMime } from '../lib/capture.ts';

export { CAPTURE_SECONDS };

export interface CaptureHost {
  gl: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  /** Draw one graph frame (must present the WebGL buffer). */
  render: () => void;
  /** Keep the render loop running while recording a still scene. */
  requestRender: () => void;
  notice: (text: string) => void;
  onRecording?: (on: boolean) => void;
}

function downloadBlob(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function blit(
  dst: HTMLCanvasElement,
  gl: HTMLCanvasElement,
  overlay: HTMLCanvasElement,
  w: number,
  h: number,
): CanvasRenderingContext2D {
  if (dst.width !== w || dst.height !== h) {
    dst.width = w;
    dst.height = h;
  }
  const ctx = dst.getContext('2d')!;
  ctx.drawImage(gl, 0, 0, w, h);
  ctx.drawImage(overlay, 0, 0, w, h);
  return ctx;
}

function snapshotCanvas(host: CaptureHost): HTMLCanvasElement {
  host.render();
  const out = document.createElement('canvas');
  blit(out, host.gl, host.overlay, host.gl.width, host.gl.height);
  return out;
}

export function attachCapture(host: CaptureHost): {
  snapshot: (copy: boolean) => Promise<void>;
  still: (maxEdge: number) => HTMLCanvasElement;
  startRecording: () => void;
  stopRecording: () => void;
  isRecording: () => boolean;
  afterFrame: () => void;
  mime: string | null;
} {
  const mime = typeof MediaRecorder === 'undefined' ? null : pickRecorderMime(t => MediaRecorder.isTypeSupported(t));

  const composite = document.createElement('canvas');
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let chunks: Blob[] = [];
  let until = 0;
  let recW = 1;
  let recH = 1;
  let track: (MediaStreamTrack & { requestFrame?: () => void }) | undefined;

  const isRecording = () => recorder !== null && recorder.state !== 'inactive';

  const releaseStream = () => {
    for (const t of stream?.getTracks() ?? []) t.stop();
    stream = null;
    track = undefined;
  };

  const afterFrame = () => {
    if (!isRecording()) return;
    blit(composite, host.gl, host.overlay, recW, recH);
    track?.requestFrame?.();
    if (performance.now() >= until) stopRecording();
    else host.requestRender();
  };

  function stopRecording() {
    if (!recorder || recorder.state === 'inactive') {
      releaseStream();
      return;
    }
    try {
      recorder.stop();
    } catch {
      releaseStream();
    }
  }

  function startRecording() {
    if (!mime || isRecording()) return;
    host.render();
    const size = captureSize(host.gl.width, host.gl.height, VIDEO_MAX_EDGE);
    recW = size.w;
    recH = size.h;
    blit(composite, host.gl, host.overlay, recW, recH);
    stream = composite.captureStream(30);
    track = stream.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
    chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
    rec.ondataavailable = e => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.onerror = () => {
      recorder = null;
      releaseStream();
      host.onRecording?.(false);
      host.notice('Recording failed in this browser.');
    };
    rec.onstop = () => {
      recorder = null;
      releaseStream();
      host.onRecording?.(false);
      const blob = new Blob(chunks, { type: mime });
      chunks = [];
      if (!blob.size) {
        host.notice('Nothing was recorded.');
        return;
      }
      downloadBlob(blob, `equation.${extensionForMime(mime)}`);
    };
    recorder = rec;
    until = performance.now() + CAPTURE_SECONDS * 1000;
    rec.start(200);
    host.onRecording?.(true);
    host.requestRender();
  }

  async function snapshot(copy: boolean): Promise<void> {
    const canvas = snapshotCanvas(host);
    const blobPromise = new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('empty png'))), 'image/png');
    });
    if (copy && navigator.clipboard && typeof ClipboardItem === 'function') {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
        host.notice('Copied graph image.');
        return;
      } catch {
        /* fall through to download */
      }
    }
    downloadBlob(await blobPromise, 'equation.png');
    if (copy) host.notice('Saved equation.png (clipboard unavailable).');
  }

  /** The graph as a fresh canvas, longest edge at most maxEdge pixels — for a
   *  vision model (voice mode), where full-resolution PNGs only add upload
   *  time and image tokens. A canvas rather than an encoded image, so the page
   *  can also show it (the CSP allows no data: images). */
  function still(maxEdge: number): HTMLCanvasElement {
    host.render();
    const scale = Math.min(1, maxEdge / Math.max(host.gl.width, host.gl.height));
    const out = document.createElement('canvas');
    blit(out, host.gl, host.overlay, Math.round(host.gl.width * scale), Math.round(host.gl.height * scale));
    return out;
  }

  return { snapshot, still, startRecording, stopRecording, isRecording, afterFrame, mime };
}
