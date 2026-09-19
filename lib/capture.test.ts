import { describe, expect, it } from 'vitest';
import { captureSize, extensionForMime, pickRecorderMime } from './capture.ts';

describe('capture helpers', () => {
  it('prefers webm, then mp4', () => {
    expect(pickRecorderMime(() => false)).toBeNull();
    expect(pickRecorderMime(t => t === 'video/mp4')).toBe('video/mp4');
    expect(pickRecorderMime(t => t.startsWith('video/webm'))).toBe('video/webm;codecs=vp9');
  });

  it('picks a file extension from the mime', () => {
    expect(extensionForMime('video/webm;codecs=vp9')).toBe('webm');
    expect(extensionForMime('video/mp4;codecs=avc1.42E01E')).toBe('mp4');
  });

  it('caps the long edge and keeps aspect', () => {
    expect(captureSize(800, 600, 1440)).toEqual({ w: 800, h: 600 });
    expect(captureSize(2880, 1800, 1440)).toEqual({ w: 1440, h: 900 });
    expect(captureSize(0, 0, 1440)).toEqual({ w: 1, h: 1 });
  });
});
