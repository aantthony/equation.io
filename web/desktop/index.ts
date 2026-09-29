/**
 * The desktop platform: loaded by web/main.ts only inside the Tauri shell
 * (apps/desktop), so the website never downloads it. The calculator is
 * untouched; this adds Sign in with ChatGPT, the graph agent panel and voice
 * mode on the user's own plan, and sends web links to the system browser.
 */
import './desktop.css';
import type { GraphHost } from '../../packages/agent/src/host.ts';
import { chatModels } from '../../packages/agent/src/models.ts';
import type { AgentProvider, Platform } from '../platform.ts';
import { initVoice } from '../voice.ts';
import { account, listModels, openExternal, signIn, signOut, streamResponses } from './bridge.ts';
import { AgentPanel } from './panel.ts';
import { AgentSession } from './session.ts';
import { pickRecognizer, speechVoice } from './voice.ts';

const chatgpt: AgentProvider = {
  account,
  signIn,
  signOut,
  models: async () => chatModels(await listModels()),
  transport: streamResponses,
};

/** Links to other sites open in the browser, not in place of the app (lib.rs also refuses to navigate away). */
function externalLinks(platform: Platform) {
  document.addEventListener('click', e => {
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!(a instanceof HTMLAnchorElement) || a.origin === location.origin || !/^(https?|mailto):/.test(a.href)) return;
    e.preventDefault();
    void platform.openExternal(a.href);
  });
}

function agentButton(panel: AgentPanel): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'agent-toggle';
  button.textContent = 'agent';
  button.title = 'Ask the graph agent (⌘J)';
  const sync = () => button.setAttribute('aria-pressed', String(panel.isOpen));
  button.addEventListener('click', () => {
    panel.toggle();
    sync();
  });
  addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
      e.preventDefault();
      panel.toggle();
      sync();
    }
  });
  sync();
  // First in the footer's links: the desktop's reason to exist.
  document.getElementById('panel-links')?.prepend(button);
  return button;
}

export async function initDesktop(host: GraphHost, voiceButton: HTMLButtonElement): Promise<Platform> {
  document.documentElement.dataset.platform = 'desktop';
  const session = new AgentSession(host, chatgpt);
  const panel = new AgentPanel(session);
  agentButton(panel);

  const recognizer = await pickRecognizer();
  const voice = speechVoice(session, recognizer, () => {
    if (panel.currentAccount) return false;
    // Voice needs the agent's account: show where to sign in.
    panel.toggle(true);
    return true;
  });
  const platform: Platform = {
    kind: 'desktop',
    openExternal,
    ai: chatgpt,
    voice,
  };
  externalLinks(platform);
  initVoice(voiceButton, host, voice);
  return platform;
}
