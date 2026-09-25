/**
 * Microphone tap for voice mode (voice.ts). Runs on the audio thread and
 * posts ~40 ms chunks of mono Float32 samples at the context's rate; the
 * main thread converts them to base64 PCM16 for the realtime socket.
 * Chunking keeps the socket at ~25 messages/s instead of one per 128-frame
 * render quantum (~190/s at 24 kHz).
 */

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;
declare const sampleRate: number;

class MicTap extends AudioWorkletProcessor {
  private buf = new Float32Array(Math.round(sampleRate * 0.04));
  private len = 0;

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let i = 0;
    while (i < channel.length) {
      const n = Math.min(channel.length - i, this.buf.length - this.len);
      this.buf.set(channel.subarray(i, i + n), this.len);
      this.len += n;
      i += n;
      if (this.len === this.buf.length) {
        this.port.postMessage(this.buf.slice());
        this.len = 0;
      }
    }
    return true;
  }
}

registerProcessor('mic-tap', MicTap);
