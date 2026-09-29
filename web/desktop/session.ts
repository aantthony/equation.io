/**
 * The desktop graph agent: one conversation on the user's ChatGPT account,
 * shared by the typed panel (panel.ts) and voice mode (voice.ts), whose tool
 * calls act on the live graph through the same GraphHost as web voice.
 */
import { type GraphHost, type ToolContext, runTool } from '../../packages/agent/src/host.ts';
import { TEXT_INSTRUCTIONS } from '../../packages/agent/src/prompt.ts';
import { Agent, AgentAborted, type TurnHandlers } from '../../packages/agent/src/responses.ts';
import { TOOLS } from '../../packages/agent/src/tools.ts';
import { Orb } from '../agent-orb.ts';
import { readSyntax } from '../agent-syntax.ts';
import type { AgentProvider } from '../platform.ts';

/** What the conversation log shows. */
export type Entry =
  | { role: 'user'; text: string; spoken?: boolean }
  | { role: 'assistant'; text: string }
  | { role: 'tool'; name: string }
  | { role: 'error'; text: string };

/** How long the typed agent's orb lingers after a reply, so a point_at can still be seen. */
const ORB_LINGER_MS = 8000;

export class AgentSession {
  readonly agent: Agent;
  /** The orb tool calls point with: voice mode's while it is live, else the panel's own. */
  private voiceOrb: Orb | null = null;
  private ownOrb: Orb;
  private ownOrbShown = false;
  private hideTimer?: ReturnType<typeof setTimeout>;
  private running: AbortController | null = null;
  private listeners = new Set<(entry: Entry | null) => void>();
  readonly log: Entry[] = [];

  constructor(
    private host: GraphHost,
    readonly provider: AgentProvider,
  ) {
    this.ownOrb = new Orb(host, () => this.interrupt());
    const ctx: ToolContext = {
      attach: (image, legend) => this.agent.attach(image, legend),
      captured: (canvas, rect) => this.orb.absorb(canvas, rect),
      readSyntax,
      pointAt: (x, y, z, seconds) => this.orb.pointAt(x, y, z, seconds),
    };
    this.agent = new Agent({
      transport: provider.transport,
      model: '',
      instructions: TEXT_INSTRUCTIONS,
      tools: TOOLS,
      runTool: (name, args) => runTool(host, name, args, ctx),
    });
  }

  private get orb(): Orb {
    return this.voiceOrb ?? this.ownOrb;
  }

  /** Voice mode lends its orb while live, so the agent points with the one on screen. */
  useVoiceOrb(orb: Orb | null) {
    this.voiceOrb = orb;
    if (orb) this.hideOwnOrb();
  }

  get busy(): boolean {
    return this.running !== null;
  }

  /** Called with each new log entry, and with null when the log is cleared or a turn starts or ends. */
  subscribe(listener: (entry: Entry | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private add(entry: Entry | null) {
    if (entry) this.log.push(entry);
    for (const listener of this.listeners) listener(entry);
  }

  /**
   * One user turn. Resolves to the reply's text ('' when interrupted or failed;
   * the error is in the log). `handlers.onTextDelta` sees the reply as it streams.
   */
  async send(text: string, handlers: TurnHandlers & { spoken?: boolean } = {}): Promise<string> {
    if (!this.agent.model) {
      this.add({ role: 'error', text: 'Choose a model first.' });
      return '';
    }
    this.interrupt();
    const running = new AbortController();
    this.running = running;
    this.add({ role: 'user', text, spoken: handlers.spoken });
    this.showOwnOrb();
    this.orb.setState('thinking');
    try {
      const reply = await this.agent.send(
        text,
        {
          ...handlers,
          onToolCall: (name, args) => {
            this.add({ role: 'tool', name });
            handlers.onToolCall?.(name, args);
          },
        },
        running.signal,
      );
      this.add({ role: 'assistant', text: reply });
      return reply;
    } catch (e) {
      if (!(e instanceof AgentAborted)) this.add({ role: 'error', text: e instanceof Error ? e.message : String(e) });
      return '';
    } finally {
      if (this.running === running) this.running = null;
      this.orb.setState('listening');
      this.lingerOwnOrb();
      this.add(null);
    }
  }

  /** Stops the turn in progress; what already happened stays in the conversation. */
  interrupt() {
    this.running?.abort();
    this.running = null;
  }

  /** A fresh conversation. */
  clear() {
    this.interrupt();
    this.agent.reset();
    this.log.length = 0;
    this.add(null);
  }

  private showOwnOrb() {
    clearTimeout(this.hideTimer);
    if (this.voiceOrb || this.ownOrbShown) return;
    this.ownOrb.show();
    this.ownOrbShown = true;
    document.documentElement.classList.add('agent-orb');
  }

  private lingerOwnOrb() {
    if (this.voiceOrb) return;
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hideOwnOrb(), ORB_LINGER_MS);
  }

  private hideOwnOrb() {
    clearTimeout(this.hideTimer);
    if (!this.ownOrbShown) return;
    this.ownOrb.hide();
    this.ownOrbShown = false;
    document.documentElement.classList.remove('agent-orb');
  }
}
