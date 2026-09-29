/**
 * Web voice mode's transport: talk to an OpenAI Realtime model and it edits
 * the graph. The orb (agent-orb.ts), the mic button (voice.ts) and the graph
 * tools (packages/agent) are shared with the desktop app; this file is only
 * the Realtime session.
 *
 * Audio goes over WebRTC between the browser and OpenAI. The page never holds
 * an OpenAI credential: it opens a control WebSocket to the Worker and sends
 * its offer with a credit key, and the Worker creates the call, meters it, and
 * hangs up when the key's credit runs out or the socket closes
 * (worker/voice-call.ts). Events and tool calls travel over the call's data
 * channel; screenshots over the control socket.
 *
 * The model works the graph through the agent's tools (packages/agent/src/host.ts).
 *
 * The feature needs a credit key (scripts/voice-key.ts). A browser is unlocked
 * by visiting any page with `#voice=<key>` once (or `?voice=<key>`, which the
 * server may log): the key is kept in localStorage and sent with each call,
 * and the mic button stays hidden everywhere else.
 */
import { runTool, type GraphHost } from '../packages/agent/src/host.ts';
import type { Orb } from './agent-orb.ts';
import { readSyntax } from './agent-syntax.ts';
import type { VoiceBackend, VoiceProvider, VoiceUi } from './platform.ts';
import { forgetKey, readKey } from './voice-key.ts';

/** The Worker answers within a few seconds; past this it has failed. */
const CONNECT_TIMEOUT_MS = 20_000;
/** Keeps the control socket from looking idle to proxies while the student is quiet. */
const HEARTBEAT_MS = 30_000;

/** A balance in micro-dollars, for people: "$4.21". */
export const dollars = (micros: number) => `$${(Math.max(0, micros) / 1e6).toFixed(2)}`;

/** The voice route doesn't exist on this server (worker/voice.ts: not configured). */
class Unavailable extends Error {}

/** One live conversation: mic in, speaker out, tool calls against the graph. */
class Session implements VoiceProvider {
  private pc?: RTCPeerConnection;
  private dc?: RTCDataChannel;
  private ctx?: AudioContext;
  private mic?: MediaStream;
  private speaker = new Audio();
  /** The Worker's control socket: the call lives exactly as long as it does (worker/voice-call.ts). */
  private control?: WebSocket;
  /** Why the Worker ended the call, once it says. */
  private endReason?: string;
  /** Screenshots on their way into the conversation, by id. */
  private images = new Map<string, (error?: string) => void>();
  /** Tool calls of the current response, still running. */
  private pendingTools: Promise<void>[] = [];
  private orb: Orb;
  private onState: VoiceUi['setState'];
  private heartbeat?: ReturnType<typeof setInterval>;
  /** Counts the student's turns: a tool follow-up is for the turn that asked for it. */
  private turn = 0;
  /** The student cut this turn's reply off: its tool results go in, but no follow-up reply. */
  private interrupted = false;
  /** Tool calls still running, across responses: the orb thinks until they finish. */
  private running = 0;
  /** The model's audio is playing: set by the server's output_audio_buffer events. */
  private speaking = false;
  /** A response is being generated (response.created until response.done). */
  private responding = false;
  /** Asked for a response while one was running: send it at the next response.done. */
  private wantResponse = false;
  /** The speech being heard began while the model was talking, so it may be anyone. */
  private overheard = false;
  closed = false;

  constructor(
    private host: GraphHost,
    private key: string,
    ui: VoiceUi,
  ) {
    this.orb = ui.orb;
    this.onState = ui.setState;
    this.speaker.autoplay = true;
  }

  /** Esc interrupts too: the orb is a pointer target, invisible to keyboards and screen readers. */
  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.speaking) void this.interrupt();
  };

  async start() {
    this.onState('connecting');
    try {
      // Both need the click's user activation, so ask before any await on the network.
      this.ctx = new AudioContext();
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      // Stopped while the permission prompt was up: stop() ran before there was a mic to release.
      if (this.closed) return this.release();

      const pc = new RTCPeerConnection();
      this.pc = pc;
      const micLevel = this.ctx.createAnalyser();
      this.ctx.createMediaStreamSource(this.mic).connect(micLevel);
      const out = this.ctx.createAnalyser();
      pc.ontrack = e => {
        // The <audio> element plays it; the analyser only lets the orb pulse with it.
        this.speaker.srcObject = e.streams[0];
        this.ctx?.createMediaStreamSource(e.streams[0]).connect(out);
      };
      pc.addTrack(this.mic.getTracks()[0], this.mic);
      const dc = pc.createDataChannel('oai-events');
      this.dc = dc;
      dc.onmessage = e => this.onEvent(JSON.parse(e.data as string));
      dc.onopen = () => {
        this.onState('live');
        this.orb.show(micLevel, out);
        addEventListener('keydown', this.onKey);
      };
      dc.onclose = () => this.end(this.reasonText());
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.end(this.reasonText());
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const answer = await this.connect(offer.sdp!);
      if (this.closed) return this.release();
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    } catch (e) {
      if (e instanceof Unavailable) {
        this.release();
        this.closed = true;
        return this.onState('unavailable', 'Voice mode is not available on this site right now.');
      }
      const denied = e instanceof DOMException && e.name === 'NotAllowedError';
      this.end(denied ? 'Microphone access is needed for voice mode.' : e instanceof Error ? e.message : String(e));
    }
  }

  /** Opens the control socket and trades the offer (and key) for the call's answer. */
  private connect(sdp: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const control = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/api/voice/connect`);
      this.control = control;
      let answered = false;
      let refused = false;
      // The Worker always answers or refuses; this covers one that can't.
      const timeout = setTimeout(() => {
        if (answered) return;
        control.onclose = null;
        control.close();
        reject(new Error('Could not start a voice session.'));
      }, CONNECT_TIMEOUT_MS);
      control.onopen = () => control.send(JSON.stringify({ type: 'start', key: this.key, sdp }));
      control.onmessage = e => {
        const message = JSON.parse(e.data as string) as { type: string; [k: string]: any };
        if (message.type === 'answer') {
          answered = true;
          clearTimeout(timeout);
          this.heartbeat = setInterval(() => control.send(JSON.stringify({ type: 'ping' })), HEARTBEAT_MS);
          resolve(message.sdp);
        } else if (message.type === 'refused') {
          refused = true;
          reject(new Error(this.refusal(message.error, message.balance_micros)));
        } else if (message.type === 'image.done') {
          this.images.get(message.id)?.(message.error);
        } else if (message.type === 'ended') {
          this.endReason = message.reason;
        }
      };
      control.onclose = () => {
        clearTimeout(timeout);
        if (answered) this.end(this.reasonText());
        else if (refused) return;
        // A browser doesn't say why a WebSocket handshake failed: ask plainly.
        // The route is 404 only when the server has no voice mode configured.
        else
          void fetch('/api/voice/connect')
            .then(res => res.status === 404)
            .catch(() => false)
            .then(missing => reject(missing ? new Unavailable() : new Error('Could not start a voice session.')));
      };
    });
  }

  /** Why the Worker would not start a call, in words. */
  private refusal(error: string, balance?: number): string {
    if (error === 'forbidden') {
      forgetKey();
      return 'Voice key not recognised.';
    }
    if (error === 'no_credit') {
      return `Voice credit used up${balance === undefined ? '' : ` (${dollars(balance)} left)`}.`;
    }
    if (error === 'too_many_calls') return 'Voice mode is already running elsewhere with this key.';
    return 'Could not start a voice session.';
  }

  /** Why the call ended, when it wasn't the student's doing. */
  private reasonText(): string | undefined {
    if (this.endReason === 'out of credit') return 'Voice credit used up.';
    if (this.endReason === 'time limit') return 'Voice calls end after 30 minutes.';
    return undefined;
  }

  private send(event: object) {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(event));
  }

  /** Asks for the model's reply, once any response still running has finished. */
  private respond() {
    if (this.responding) this.wantResponse = true;
    else this.send({ type: 'response.create' });
  }

  private onEvent(event: { type: string; [k: string]: any }) {
    switch (event.type) {
      case 'output_audio_buffer.started':
        this.speaking = true;
        this.orb.setState('speaking');
        break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        this.speaking = false;
        this.orb.setState(this.running ? 'thinking' : 'listening');
        break;
      case 'input_audio_buffer.speech_started':
        // Speech doesn't interrupt a reply (packages/agent/src/realtime.ts): while the
        // model talks, it may be anyone in the room.
        this.overheard = this.speaking;
        if (this.overheard) break;
        // A new question means the old pointing is stale.
        this.orb.home();
        this.orb.setState('listening');
        break;
      case 'input_audio_buffer.speech_stopped':
        if (!this.overheard) this.orb.setState('thinking');
        break;
      case 'input_audio_buffer.committed':
        // Turns don't answer themselves (packages/agent/src/realtime.ts): reply to the
        // student, and drop what was overheard so no later reply answers it.
        if (this.overheard) this.send({ type: 'conversation.item.delete', item_id: event.item_id });
        else {
          this.turn++;
          this.interrupted = false;
          this.respond();
        }
        this.overheard = false;
        break;
      case 'response.created':
        this.responding = true;
        break;
      case 'response.output_audio_transcript.done':
        // Once per reply: a live region re-announced on every delta reads the reply over and over.
        if (event.transcript) this.host.notice(event.transcript);
        break;
      case 'response.function_call_arguments.done': {
        const { call_id, name } = event;
        // Still speaking ("Let me look"): the orb stays tappable until the audio ends.
        if (!this.speaking) this.orb.setState('thinking');
        this.running++;
        const run = runTool(this.host, name, event.arguments ?? '{}', {
          attach: (image, legend) => this.attach(image, legend),
          readSyntax,
          captured: (canvas, rect) => this.orb.absorb(canvas, rect),
          pointAt: (x, y, z, seconds) => this.orb.pointAt(x, y, z, seconds),
        }).then(output => {
          this.running--;
          if (this.closed) return;
          this.send({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id, output: JSON.stringify(output) },
          });
        });
        this.pendingTools.push(run);
        break;
      }
      case 'response.done': {
        this.responding = false;
        if (this.wantResponse) {
          this.wantResponse = false;
          this.send({ type: 'response.create' });
        }
        // A response can make several calls, and one can outlive the
        // response that asked for it: ask for the follow-up once, after all
        // of this response's outputs are in.
        const pending = this.pendingTools.splice(0);
        // A turn that ended without speech is back to listening.
        if (!pending.length && !this.running && !this.speaking) this.orb.setState('listening');
        if (pending.length) {
          const turn = this.turn;
          void Promise.all(pending).then(() => {
            // Not after a tap, nor once the student has moved on: their new turn gets its own reply.
            if (!this.closed && !this.interrupted && this.turn === turn) this.respond();
          });
        }
        break;
      }
      case 'error':
        console.warn('[voice]', event.error ?? event);
        break;
    }
  }

  /** The student tapped the orb: stop talking, and drop what was still to be said. */
  async interrupt() {
    if (!this.speaking) return;
    this.interrupted = true;
    this.wantResponse = false;
    this.send({ type: 'response.cancel' });
    this.send({ type: 'output_audio_buffer.clear' });
    this.orb.home();
  }

  /** Screenshots go through the Worker's sideband: too large for a data channel message in every browser. */
  private attach(image: string, legend: string): Promise<void> {
    const control = this.control;
    if (control?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('the call has ended'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.images.set(id, error => {
        this.images.delete(id);
        if (error) reject(new Error(error));
        else resolve();
      });
      control.send(JSON.stringify({ type: 'image', id, image, legend }));
    });
  }

  async stop() {
    this.end();
  }

  private end(reason?: string) {
    this.release();
    if (this.closed) return;
    this.closed = true;
    this.onState('idle', reason);
  }

  /** Frees whatever has been acquired so far; safe to call repeatedly. */
  private release() {
    this.orb.hide();
    removeEventListener('keydown', this.onKey);
    clearInterval(this.heartbeat);
    if (this.dc) this.dc.onopen = this.dc.onclose = this.dc.onmessage = null;
    if (this.pc) {
      this.pc.ontrack = this.pc.onconnectionstatechange = null;
      this.pc.close();
    }
    if (this.control) {
      this.control.onopen = this.control.onmessage = this.control.onclose = null;
      // The Worker hangs the call up and settles its charges when this closes.
      this.control.close();
    }
    for (const settle of this.images.values()) settle('the call has ended');
    this.speaker.srcObject = null;
    this.mic?.getTracks().forEach(t => t.stop());
    if (this.ctx && this.ctx.state !== 'closed') void this.ctx.close();
  }
}

/** Realtime voice, for browsers unlocked with a credit key (web/voice-key.ts). */
export const realtimeVoice: VoiceBackend = {
  available: () => !!readKey() && !!navigator.mediaDevices?.getUserMedia && typeof RTCPeerConnection !== 'undefined',
  create: (host, ui) => new Session(host, readKey() ?? '', ui),
};
