/**
 * The desktop agent panel: Sign in with ChatGPT, the model picker (the
 * account's own catalogue), and a typed conversation with the graph agent.
 *
 *   Not connected:  [ Continue with ChatGPT ]
 *   Connected:      ChatGPT — <account>   Model: <select>   [ Sign out ]
 */
import { type ModelInfo, pickModel } from '../../packages/agent/src/models.ts';
import type { AgentAccount } from '../platform.ts';
import type { AgentSession, Entry } from './session.ts';

const MODEL_KEY = 'agentModel';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function savedModel(): string | null {
  try {
    return localStorage.getItem(MODEL_KEY);
  } catch {
    return null;
  }
}

function saveModel(id: string) {
  try {
    localStorage.setItem(MODEL_KEY, id);
  } catch {
    // Storage blocked: the newest model is picked next time.
  }
}

/** Short names for tool calls in the log. */
const TOOL_WORDS: Record<string, string> = {
  get_graph: 'read the graph',
  set_graph: 'changed the graph',
  look_at_graph: 'looked at the graph',
  read_syntax: 'checked the syntax reference',
  point_at: 'pointed',
  animate_slider: 'animated a slider',
  move_view: 'moved the view',
};

export class AgentPanel {
  readonly root = el('aside', { id: 'agent', hidden: true });
  private account = el('div', { className: 'agent-account' });
  private logEl = el('div', { className: 'agent-log', role: 'log' });
  private input = el('textarea', {
    className: 'agent-input',
    rows: 2,
    placeholder: 'Ask about the graph, or describe one to draw…',
    spellcheck: true,
  });
  private send = el('button', { type: 'button', className: 'agent-send', textContent: 'Send' });
  /** The reply streaming in, if one is. */
  private live: HTMLElement | null = null;
  private signedIn: AgentAccount | null = null;
  /** Listeners told when sign-in state changes (voice mode shows or hides with it). */
  onAccount?: (account: AgentAccount | null) => void;

  constructor(private session: AgentSession) {
    const close = el('button', { type: 'button', className: 'agent-close', title: 'Close', textContent: '×' });
    close.setAttribute('aria-label', 'Close the agent');
    close.addEventListener('click', () => this.toggle(false));
    const clear = el('button', { type: 'button', className: 'agent-clear', textContent: 'New chat' });
    clear.addEventListener('click', () => session.clear());
    this.root.setAttribute('aria-label', 'Graph agent');
    const form = el('form', { className: 'agent-compose' }, this.input, this.send);
    form.addEventListener('submit', e => {
      e.preventDefault();
      this.submit();
    });
    this.send.addEventListener('click', () => (session.busy ? session.interrupt() : this.submit()));
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submit();
      }
      // The app's own shortcuts must not fire while typing here.
      e.stopPropagation();
    });
    this.root.append(
      el('header', {}, el('h2', { textContent: 'Graph agent' }), clear, close),
      this.account,
      this.logEl,
      form,
    );
    document.body.append(this.root);
    session.subscribe(entry => this.render(entry));
    void this.refresh();
  }

  toggle(open = !this.isOpen) {
    this.root.hidden = !open;
    document.documentElement.classList.toggle('agent-open', open);
    if (open) this.input.focus();
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  get currentAccount(): AgentAccount | null {
    return this.signedIn;
  }

  private submit() {
    const text = this.input.value.trim();
    if (!text || this.session.busy || !this.signedIn) return;
    this.input.value = '';
    void this.session.send(text, { onTextDelta: delta => this.stream(delta) });
  }

  /** Reads the account and, when signed in, its models. */
  async refresh() {
    let account: AgentAccount | null = null;
    try {
      account = await this.session.provider.account();
    } catch (e) {
      return this.showSignedOut(e instanceof Error ? e.message : String(e));
    }
    if (!account) return this.showSignedOut();
    await this.showSignedIn(account);
  }

  private setAccount(account: AgentAccount | null) {
    this.signedIn = account;
    this.input.disabled = this.send.disabled = !account;
    this.onAccount?.(account);
  }

  private showSignedOut(error?: string) {
    this.setAccount(null);
    const button = el('button', { type: 'button', className: 'agent-connect', textContent: 'Continue with ChatGPT' });
    const note = el('p', {
      className: 'agent-note',
      textContent:
        'The agent runs on your own ChatGPT plan. You sign in with OpenAI in your browser; Equation.io never sees your password, and your sign-in stays in this Mac’s Keychain.',
    });
    const status = el('p', { className: 'agent-error', textContent: error ?? '' });
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Waiting for your browser…';
      status.textContent = '';
      try {
        await this.showSignedIn(await this.session.provider.signIn());
      } catch (e) {
        this.showSignedOut(e instanceof Error ? e.message : String(e));
      }
    });
    this.account.replaceChildren(button, note, status);
  }

  private async showSignedIn(account: AgentAccount) {
    this.setAccount(account);
    const who = el('p', { className: 'agent-who' }, el('strong', { textContent: 'ChatGPT' }), ` — ${account.label}`);
    if (account.plan) who.append(el('span', { className: 'agent-plan', textContent: account.plan }));
    const select = el('select', { className: 'agent-model', disabled: true });
    select.append(el('option', { textContent: 'Loading models…' }));
    const label = el('label', { className: 'agent-model-label' }, 'Model ', select);
    const out = el('button', { type: 'button', className: 'agent-signout', textContent: 'Sign out' });
    const status = el('p', { className: 'agent-error' });
    out.addEventListener('click', async () => {
      this.session.clear();
      try {
        await this.session.provider.signOut();
      } finally {
        this.showSignedOut();
      }
    });
    this.account.replaceChildren(who, el('div', { className: 'agent-row' }, label, out), status);

    let models: ModelInfo[] = [];
    try {
      models = await this.session.provider.models();
    } catch (e) {
      status.textContent = `Could not load your models: ${e instanceof Error ? e.message : String(e)}`;
    }
    const chosen = pickModel(models, savedModel());
    select.replaceChildren(
      ...models.map(m => el('option', { value: m.id, textContent: m.id, selected: m.id === chosen })),
    );
    if (!models.length) select.append(el('option', { textContent: 'No models available' }));
    select.disabled = !models.length;
    this.session.agent.model = chosen ?? '';
    select.addEventListener('change', () => {
      this.session.agent.model = select.value;
      saveModel(select.value);
    });
  }

  /** A reply's text as it streams. */
  private stream(delta: string) {
    if (!this.live) {
      this.live = el('p', { className: 'agent-msg agent-assistant' });
      this.logEl.append(this.live);
    }
    this.live.textContent += delta;
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private render(entry: Entry | null) {
    this.send.textContent = this.session.busy ? 'Stop' : 'Send';
    if (!entry) {
      if (!this.session.log.length) this.logEl.replaceChildren();
      return;
    }
    if (entry.role === 'assistant') {
      // The streamed paragraph becomes the reply; a reply that didn't stream is added whole.
      if (this.live) this.live.textContent = entry.text;
      else if (entry.text)
        this.logEl.append(el('p', { className: 'agent-msg agent-assistant', textContent: entry.text }));
      this.live = null;
    } else if (entry.role === 'user') {
      this.live = null;
      const p = el('p', { className: 'agent-msg agent-user', textContent: entry.text });
      if (entry.spoken) p.classList.add('agent-spoken');
      this.logEl.append(p);
    } else if (entry.role === 'tool') {
      // Text before a tool call is its own paragraph: the reply after it starts fresh.
      this.live = null;
      this.logEl.append(el('p', { className: 'agent-tool', textContent: TOOL_WORDS[entry.name] ?? entry.name }));
    } else {
      this.live = null;
      this.logEl.append(el('p', { className: 'agent-msg agent-error', textContent: entry.text }));
    }
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }
}
