/**
 * Desktop voice mode: native speech around the ChatGPT-plan agent.
 *
 *   microphone → speech recognition (macOS Speech, via the Rust side)
 *              → the same agent session as the typed panel, with the spoken
 *                prompt (VOICE_INSTRUCTIONS) → graph tools
 *              → the reply, spoken sentence by sentence as it streams
 *                (speechSynthesis) → listening again
 *
 * OpenAI's Realtime API does not accept ChatGPT-plan credentials, so this is
 * the voice mode the user's own plan can pay for. It is one VoiceBackend
 * (platform.ts): a speech-to-speech transport can replace it without touching
 * the orb, the mic button or the tools.
 */
import type { GraphHost } from '../../packages/agent/src/host.ts';
import { VOICE_INSTRUCTIONS } from '../../packages/agent/src/prompt.ts';
import type { VoiceBackend, VoiceProvider, VoiceUi } from '../platform.ts';
import { type SpeechEvent, speechAuthorize, speechListen, speechStop, speechSupported } from './bridge.ts';
import type { AgentSession } from './session.ts';

/** A pause this long after speech ends the utterance: the recognizer itself waits for more. */
const SILENCE_MS = 1300;

/** Turns speech into text. */
export interface Recognizer {
  /** Asks for permission; false when refused. */
  authorize(): Promise<boolean>;
  start(onEvent: (event: SpeechEvent) => void): Promise<void>;
  stop(): Promise<void>;
}

/** macOS: Apple's Speech framework, in the Rust side (speech.rs). */
const nativeRecognizer: Recognizer = {
  authorize: speechAuthorize,
  start: speechListen,
  stop: speechStop,
};

type WebRecognition = {
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
};

/** Elsewhere: the webview's own recognizer, where it has one. */
function webRecognizer(): Recognizer | null {
  const Ctor = (window as unknown as { webkitSpeechRecognition?: new () => WebRecognition }).webkitSpeechRecognition;
  if (!Ctor) return null;
  let current: WebRecognition | null = null;
  return {
    authorize: () => Promise.resolve(true),
    start(onEvent) {
      const r = new Ctor();
      r.continuous = true;
      r.interimResults = true;
      r.onresult = e => {
        const text = Array.from(e.results, result => result[0].transcript).join('');
        const final = Array.from(e.results).every(result => result.isFinal);
        onEvent({ type: final ? 'final' : 'partial', text });
      };
      r.onerror = e => onEvent({ type: 'error', message: e.error });
      current = r;
      r.start();
      return Promise.resolve();
    },
    stop() {
      current?.abort();
      current = null;
      return Promise.resolve();
    },
  };
}

export async function pickRecognizer(): Promise<Recognizer | null> {
  try {
    if (await speechSupported()) return nativeRecognizer;
  } catch {
    // An older shell without the command: try the webview's.
  }
  return webRecognizer();
}

/** Markdown the model may still write is read out as punctuation: drop it. */
const speakable = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Speaks a reply as it streams: each finished sentence is queued at once, so
 * the first is heard while the model is still writing the rest.
 */
class Speaker {
  private buffer = '';
  private pending = 0;
  private flushed = false;
  private settle!: () => void;
  readonly done = new Promise<void>(resolve => (this.settle = resolve));

  constructor(private onSpeaking: (speaking: boolean) => void) {}

  push(delta: string) {
    this.buffer += delta;
    // Up to the last sentence end with a space after it (not the point in 3.14).
    let end = -1;
    for (const m of this.buffer.matchAll(/[.!?…](?=\s)/g)) end = m.index;
    if (end < 0) return;
    this.say(this.buffer.slice(0, end + 1));
    this.buffer = this.buffer.slice(end + 1);
  }

  flush() {
    this.say(this.buffer);
    this.buffer = '';
    this.flushed = true;
    if (!this.pending) this.settle();
  }

  cancel() {
    this.buffer = '';
    this.flushed = true;
    this.pending = 0;
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    this.onSpeaking(false);
    this.settle();
  }

  private say(text: string) {
    const words = speakable(text);
    if (!words || typeof speechSynthesis === 'undefined') return;
    const u = new SpeechSynthesisUtterance(words);
    this.pending++;
    u.onstart = () => this.onSpeaking(true);
    u.onend = u.onerror = () => {
      if (this.pending === 0) return; // cancelled
      this.pending--;
      if (!this.pending) {
        this.onSpeaking(false);
        if (this.flushed) this.settle();
      }
    };
    speechSynthesis.speak(u);
  }
}

class SpeechVoice implements VoiceProvider {
  private heard = '';
  private silence?: ReturnType<typeof setTimeout>;
  private listening = false;
  private speaker: Speaker | null = null;
  private speaking = false;
  private closed = false;

  constructor(
    private session: AgentSession,
    private recognizer: Recognizer,
    private ui: VoiceUi,
    private host: GraphHost,
    private needsSignIn: () => boolean,
  ) {}

  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.speaking) void this.interrupt();
  };

  async start() {
    this.ui.setState('connecting');
    if (this.needsSignIn()) return this.end('Sign in with ChatGPT in the agent panel to use voice mode.');
    let allowed = false;
    try {
      allowed = await this.recognizer.authorize();
    } catch (e) {
      return this.end(e instanceof Error ? e.message : String(e));
    }
    if (this.closed) return;
    if (!allowed) {
      return this.end('Voice mode needs speech recognition: allow it in System Settings › Privacy & Security.');
    }
    this.session.useVoiceOrb(this.ui.orb);
    this.ui.orb.show();
    this.ui.setState('live');
    addEventListener('keydown', this.onKey);
    await this.listen();
  }

  private async listen() {
    if (this.closed) return;
    this.heard = '';
    this.ui.orb.setState('listening');
    this.listening = true;
    try {
      await this.recognizer.start(event => this.onSpeech(event));
    } catch (e) {
      this.end(e instanceof Error ? e.message : String(e));
    }
  }

  private onSpeech(event: SpeechEvent) {
    if (!this.listening) return;
    clearTimeout(this.silence);
    if (event.type === 'error') {
      // The recognizer gives up after a long silence: keep listening, unless it has heard something.
      if (this.heard.trim()) void this.utterance();
      else void this.recognizer.stop().then(() => this.listen());
      return;
    }
    // A new question makes the last pointing stale.
    if (!this.heard) this.ui.orb.home();
    this.heard = event.text;
    if (event.type === 'final') void this.utterance();
    else this.silence = setTimeout(() => void this.utterance(), SILENCE_MS);
  }

  /** The student stopped talking: answer, then listen again. Not listening meanwhile, so it never hears itself. */
  private async utterance() {
    clearTimeout(this.silence);
    if (!this.listening) return;
    this.listening = false;
    const text = this.heard.trim();
    this.heard = '';
    await this.recognizer.stop();
    if (this.closed) return;
    if (!text) return this.listen();

    const speaker = new Speaker(speaking => {
      this.speaking = speaking;
      if (!this.closed) this.ui.orb.setState(speaking ? 'speaking' : this.session.busy ? 'thinking' : 'listening');
    });
    this.speaker = speaker;
    const reply = await this.session.send(text, {
      spoken: true,
      instructions: VOICE_INSTRUCTIONS,
      onTextDelta: delta => speaker.push(delta),
    });
    if (!reply) speaker.cancel();
    else {
      this.host.notice(reply);
      speaker.flush();
    }
    await speaker.done;
    if (this.speaker === speaker) this.speaker = null;
    await this.listen();
  }

  /** Stop talking and drop the rest of the reply; back to listening. */
  async interrupt() {
    this.session.interrupt();
    this.speaker?.cancel();
    this.ui.orb.home();
  }

  async stop() {
    this.end();
  }

  private end(reason?: string) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.silence);
    this.listening = false;
    removeEventListener('keydown', this.onKey);
    void this.recognizer.stop().catch(() => {});
    this.speaker?.cancel();
    this.session.interrupt();
    this.session.useVoiceOrb(null);
    this.ui.orb.hide();
    this.ui.setState('idle', reason);
  }
}

/** Voice mode on the desktop: offered wherever speech can be recognized. */
export function speechVoice(
  session: AgentSession,
  recognizer: Recognizer | null,
  needsSignIn: () => boolean,
): VoiceBackend {
  return {
    available: () => recognizer !== null,
    create: (host, ui) => new SpeechVoice(session, recognizer!, ui, host, needsSignIn),
  };
}
