# Equation.io desktop

The desktop app is the Equation.io web app, bundled locally in a Tauri 2
window, plus a graph agent that runs on the user's own ChatGPT plan. This
document covers how it fits together, how sign-in works, and how releases
are built.

## Layout

| Path | What it is |
| --- | --- |
| `web/` | The grapher, shared with the website. Built once by `pnpm web:build`; Tauri bundles `dist-web/client`. |
| `web/platform.ts` | The `Platform` interface: `openExternal`, `ai` (an `AgentProvider`), `voice` (a `VoiceBackend`). |
| `web/desktop/` | Desktop-only page code: the Tauri bridge, the agent panel, the shared agent session and native voice. `web/main.ts` imports it only when `window.__TAURI_INTERNALS__` exists, so the website never downloads it. |
| `packages/agent/` | Prompt, tools, `runTool` against the live app, and the Responses API loop (`Agent`). Web voice and the desktop share it. |
| `apps/desktop/src-tauri/` | The Rust side: OAuth, Keychain, OpenAI calls, macOS speech recognition, window and navigation rules. |

The calculator is not forked: the desktop window loads the same `index.html`
and `main.ts` as equation.io. `initDesktop` (web/desktop/index.ts) adds the
agent panel (⌘J or the footer's "agent" link), wires voice mode to the
native backend, and sends links to other sites to the system browser.

## Security model

- **Tokens never reach the webview.** The Rust side runs the whole OAuth flow
  and keeps the tokens in the OS credential store (macOS: the login Keychain,
  service `io.equation.desktop`). The page can ask for the account's label,
  the model list, or a streamed Responses request; it never receives a
  credential, and nothing is written to `localStorage` except the chosen
  model id.
- **No Equation.io servers in the loop.** Inference goes from the Mac to
  OpenAI directly. The Cloudflare Worker is not involved and never sees a
  ChatGPT credential.
- **Stateless requests.** Every Responses request is forced to
  `store: false, stream: true` in Rust (`openai::stateless`), whatever the
  page sends. The conversation lives in the page and is resent each step;
  reasoning is carried forward as `reasoning.encrypted_content`.
- **Navigation is pinned.** The window may only show the bundled app (or the
  dev server in development); any other navigation is cancelled and, for
  http(s)/mailto, opened in the system browser. `open_external` refuses other
  schemes.
- **CSP.** `tauri.conf.json` carries the same policy as the website
  (`lib/csp.ts`), plus Tauri's IPC origin.

## Sign in with ChatGPT

`oauth.rs` implements OAuth 2.0 authorization code + PKCE for native apps
(RFC 8252, RFC 7636):

1. Fetch the issuer's discovery document
   (`/.well-known/openid-configuration`, falling back to
   `/.well-known/oauth-authorization-server`).
2. Pick the client identity: the one configured at build time, else the one
   this install was issued earlier (kept in the Keychain), else register
   (RFC 7591 dynamic client registration) when the issuer offers it, and keep
   what OpenAI issues.
3. Generate a PKCE verifier/S256 challenge, `state` and `nonce`; listen on
   `127.0.0.1:<port>`; open the authorization URL in the system browser.
4. Accept only a `GET /callback` carrying our `state` (compared in constant
   time); exchange the code with the verifier; store the tokens.
5. `GET /v1/models` with the access token. The picker shows that catalogue
   (minus embedding, speech, image and moderation families), newest first;
   no model names are hard-coded.

Access tokens are refreshed a minute before expiry, and once more on a 401.
Refreshes are serialized so a refresh token is never spent twice. Sign-out
deletes the tokens and revokes the refresh token when the issuer has a
revocation endpoint; the client identity is kept.

### Configuration

Each setting is read from the environment at run time, then from the value
baked in at build time (`option_env!`), then the default:

| Variable | Default | |
| --- | --- | --- |
| `EQUATION_OPENAI_CLIENT_ID` | none | The OAuth client id OpenAI issued to Equation.io. Without it, the app registers itself if the issuer supports registration. |
| `EQUATION_OPENAI_ISSUER` | `https://auth.openai.com` | Endpoints come from its discovery document. |
| `EQUATION_OPENAI_SCOPES` | `openid profile email offline_access` | Add any scope OpenAI requires for plan inference. |
| `EQUATION_OPENAI_API_BASE` | `https://api.openai.com/v1` | Where `/models` and `/responses` go. |
| `EQUATION_OAUTH_PORT` | `14565` | Loopback redirect: `http://127.0.0.1:<port>/callback`. Register this exact URI with OpenAI. |

Release builds set `EQUATION_OPENAI_CLIENT_ID` from the repository's
Actions configuration (below), so a downloaded app signs in without any
setup. A build from source without it relies on dynamic registration.

To try the whole flow without OpenAI, point `EQUATION_OPENAI_ISSUER` and
`EQUATION_OPENAI_API_BASE` at a local OIDC/OpenAI stand-in.

## The agent

`packages/agent/src/responses.ts` (`Agent`) runs one user turn:

```
user request → model → tool calls → Equation.io graph changes
             → tool results (and screenshots) → model continues → reply
```

Tool calls go through `runTool` (packages/agent/src/host.ts) against the
`GraphHost` that `web/main.ts` implements, the same host web voice uses, so
`get_graph`, `set_graph`, `move_view`, `look_at_graph`, `read_syntax`,
`point_at` and `animate_slider` behave identically everywhere. Screenshots
from `look_at_graph` follow the tool outputs of the step that took them;
only the newest two stay in the history. A turn stops after 16 model calls.

Typed and spoken turns share one conversation (web/desktop/session.ts):
spoken turns use the spoken prompt (`VOICE_INSTRUCTIONS`), typed ones the
written prompt (`TEXT_INSTRUCTIONS`); both share `GRAPH_GUIDE`.

## Voice

OpenAI documents ChatGPT-plan inference through the Responses API; the
Realtime API (used by the website's voice mode, `gpt-realtime-2.1`) does
not accept ChatGPT-plan credentials. So desktop voice is:

- **listening**: Apple's Speech framework via `AVAudioEngine`
  (`speech.rs`, macOS only; the webview's recognizer elsewhere if it has
  one). The page ends an utterance after 1.3 s without new words.
- **thinking**: the same ChatGPT-plan agent as the panel.
- **speaking**: `speechSynthesis`, sentence by sentence as the reply streams.

Listening stops while the agent answers, so it never hears itself. Tap the
orb or press Esc to interrupt.

Voice is one `VoiceBackend` (web/platform.ts). The mic button, orb and tools
don't know which transport is behind it: when ChatGPT-plan credentials work
with a speech-to-speech API, a backend for it replaces `speechVoice` in
`web/desktop/index.ts` and nothing else changes. The website's Realtime
backend is `web/voice-realtime.ts`.

## Development

```sh
pnpm install
pnpm desktop                       # tauri dev: the window loads `pnpm web`'s dev server
pnpm test:desktop                  # page side in Chromium with the Rust side mocked
cd apps/desktop/src-tauri
cargo test                         # PKCE, callback parsing, SSE, navigation rules
cargo clippy --all-targets
```

Linux development builds need the WebKitGTK packages listed in
`.github/workflows/ci.yml`; tokens there go to the kernel keyring, which
lasts until logout. macOS is the supported platform.

## Releases

`.github/workflows/desktop-release.yml` builds a universal macOS app (Apple
silicon and Intel), signs it with a Developer ID certificate, notarizes it,
and publishes the `.dmg` and `.app.tar.gz` to a GitHub Release. It runs on a
`desktop-v*` tag, or by hand from the Actions tab (which makes a draft
release).

Repository secrets (Settings → Secrets and variables → Actions):

| Secret | |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64 of the Developer ID Application `.p12`. |
| `APPLE_CERTIFICATE_PASSWORD` | Its export password. |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Name (TEAMID)`. |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Notarization: the Apple ID, an app-specific password, and the team. |

And one repository variable: `EQUATION_OPENAI_CLIENT_ID`, the client id
OpenAI issued for Sign in with ChatGPT (public, so a variable rather than a
secret).

Without the Apple secrets the workflow still builds, unsigned; macOS
Gatekeeper will then refuse to open the download without a right-click →
Open. Mac App Store packaging (sandbox entitlements, provisioning profile)
is left for when the direct-download build is stable.
