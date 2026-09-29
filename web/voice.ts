/**
 * Voice mode's controls: the mic button and the idle orb. Which conversation
 * they start is the platform's (platform.ts VoiceBackend): Realtime
 * speech-to-speech on the web (voice-realtime.ts), native speech around the
 * ChatGPT agent on the desktop (desktop/voice.ts).
 */
import type { GraphHost } from '../packages/agent/src/host.ts';
import { Orb, idleOrb } from './agent-orb.ts';
import type { VoiceBackend, VoiceProvider, VoiceState } from './platform.ts';

/**
 * Voice mode's ways in, wherever the backend offers it: the panel's mic
 * button, and an idle orb at the bottom centre ("Talk to your graph") where
 * the live orb appears once the conversation connects.
 */
export function initVoice(button: HTMLButtonElement, host: GraphHost, backend: VoiceBackend) {
  if (!backend.available()) return;
  button.hidden = false;
  const start = idleOrb();
  let session: VoiceProvider | null = null;

  let unavailable = false;

  const setState = (state: VoiceState, reason?: string) => {
    const idle = state === 'idle' || state === 'unavailable';
    button.classList.toggle('connecting', state === 'connecting');
    button.classList.toggle('live', state === 'live');
    button.setAttribute('aria-pressed', idle ? 'false' : 'true');
    button.title = idle
      ? 'Voice mode: describe a graph out loud'
      : 'Stop voice mode (Esc interrupts a reply while it is speaking)';
    // The live orb takes the idle one's place once connected.
    start.classList.toggle('connecting', state === 'connecting');
    start.lastElementChild!.textContent = state === 'connecting' ? 'Connecting…' : 'Talk to your graph';
    if (idle) session = null;
    // Unavailable holds for this page load: the server may have voice mode again on a later visit.
    if (state === 'unavailable') unavailable = true;
    if (reason) host.notice(reason);
    // The backend can withdraw (a forgotten credit key, a signed-out account).
    const offered = backend.available() && !unavailable;
    button.hidden = !offered;
    start.hidden = !offered || state === 'live';
  };

  const toggle = () => {
    if (session) return void session.stop();
    if (!backend.available()) return;
    const orb = new Orb(host, () => void session?.interrupt());
    session = backend.create(host, { orb, setState });
    void session.start();
  };
  button.addEventListener('click', toggle);
  start.addEventListener('click', toggle);
  addEventListener('pagehide', () => void session?.stop());
}
