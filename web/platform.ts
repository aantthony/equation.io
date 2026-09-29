/**
 * What the app needs from wherever it runs. The calculator itself (graph,
 * panels, URL state, rendering, capture) is the same everywhere; only these
 * capabilities differ between the website and the desktop app.
 *
 * The web platform is built in. The desktop one (web/desktop/) is loaded only
 * inside the Tauri shell, so the website never downloads it.
 */
import type { GraphHost } from '../packages/agent/src/host.ts';
import type { ModelInfo } from '../packages/agent/src/models.ts';
import type { ResponsesTransport } from '../packages/agent/src/responses.ts';
import type { Orb } from './agent-orb.ts';

/** A voice conversation's lifecycle, as the mic button shows it. */
export type VoiceState = 'connecting' | 'live' | 'idle' | 'unavailable';

/** What a voice conversation drives on screen: the orb, and the mic button's state. */
export interface VoiceUi {
  orb: Orb;
  /** Idle and unavailable end the conversation; a reason is shown as a notice. */
  setState(state: VoiceState, reason?: string): void;
}

/** One voice conversation. Transports differ (Realtime speech-to-speech, native speech around a text model); the graph tools do not. */
export interface VoiceProvider {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Stop talking and drop the rest of the reply. */
  interrupt(): Promise<void>;
}

/** A way to hold voice conversations on this platform. */
export interface VoiceBackend {
  /** Whether to offer voice mode at all on this page load. */
  available(): boolean;
  create(host: GraphHost, ui: VoiceUi): VoiceProvider;
}

/** The signed-in model account (desktop: Sign in with ChatGPT). */
export interface AgentAccount {
  /** How to name the account to its owner: an email, or a name. */
  label: string;
  plan?: string;
}

/** Model inference on the user's own account. */
export interface AgentProvider {
  account(): Promise<AgentAccount | null>;
  signIn(): Promise<AgentAccount>;
  signOut(): Promise<void>;
  /** The account's own model catalogue. */
  models(): Promise<ModelInfo[]>;
  /** Streams Responses API requests with the account's credential. */
  transport: ResponsesTransport;
}

export interface Platform {
  kind: 'web' | 'desktop';
  openExternal(url: string): Promise<void>;
  ai?: AgentProvider;
  voice?: VoiceBackend;
}

/** Inside the Tauri shell: Tauri 2 injects its IPC bridge before any page script runs. */
export const isDesktop = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const webPlatform: Platform = {
  kind: 'web',
  openExternal(url) {
    window.open(url, '_blank', 'noopener');
    return Promise.resolve();
  },
};
