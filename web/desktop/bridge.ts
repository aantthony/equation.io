/**
 * The page's side of the desktop shell (apps/desktop/src-tauri/src/lib.rs).
 * Every call that needs the ChatGPT credential happens in Rust; the page
 * gets back an account label, the model catalogue and streamed events,
 * never a token.
 */
import { Channel, invoke } from '@tauri-apps/api/core';
import type { ResponsesRequest, ResponsesTransport, StreamEvent } from '../../packages/agent/src/responses.ts';
import type { AgentAccount } from '../platform.ts';

/** Command failures arrive as strings (Rust's Err(String)). */
const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    throw asError(e);
  }
}

export const account = () => call<AgentAccount | null>('auth_status');
export const signIn = () => call<AgentAccount>('auth_sign_in');
export const signOut = () => call<void>('auth_sign_out');
export const listModels = () => call<unknown>('models_list');
export const openExternal = (url: string) => call<void>('open_external', { url });

/** The Rust side's last message on a completed stream. */
const STREAM_END = '[END]';
let nextStream = 1;

/** Responses API requests, streamed by the Rust side with the account's credential. */
export const streamResponses: ResponsesTransport = async function* (request: ResponsesRequest, signal?: AbortSignal) {
  const streamId = nextStream++;
  const queue: StreamEvent[] = [];
  let finished = false;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  const poke = () => {
    wake?.();
    wake = null;
  };

  const onEvent = new Channel<string>();
  onEvent.onmessage = data => {
    if (data === STREAM_END) finished = true;
    else {
      try {
        queue.push(JSON.parse(data) as StreamEvent);
      } catch {
        // Not JSON: nothing the agent could read.
      }
    }
    poke();
  };
  const cancel = () => void invoke('responses_cancel', { streamId }).catch(() => {});
  signal?.addEventListener('abort', cancel);
  invoke('responses_stream', { request, streamId, onEvent }).then(
    () => {
      // Cancelled streams end without the marker.
      if (signal?.aborted) finished = true;
      poke();
    },
    (e: unknown) => {
      failure = asError(e);
      poke();
    },
  );
  try {
    for (;;) {
      if (queue.length) {
        yield queue.shift()!;
        continue;
      }
      if (failure) throw failure;
      if (finished) return;
      await new Promise<void>(resolve => (wake = resolve));
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (!finished && !failure) cancel();
  }
};

export type SpeechEvent = { type: 'partial' | 'final'; text: string } | { type: 'error'; message: string };

export const speechSupported = () => call<boolean>('speech_supported');
export const speechAuthorize = () => call<boolean>('speech_authorize');

/** Starts native recognition; transcripts go to `onEvent` until speechStop. */
export function speechListen(onEvent: (event: SpeechEvent) => void): Promise<void> {
  const channel = new Channel<SpeechEvent>();
  channel.onmessage = onEvent;
  return call<void>('speech_listen', { onEvent: channel });
}

export const speechStop = () => call<void>('speech_stop');
