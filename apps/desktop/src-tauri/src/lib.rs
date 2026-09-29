//! Equation.io desktop: the same web app, bundled locally in a Tauri window,
//! plus what only a native shell can do safely: Sign in with ChatGPT (with
//! the tokens in the Keychain, out of the webview's reach), inference on the
//! user's own ChatGPT plan, native speech recognition, and opening links in
//! the system browser.
//!
//! The page (web/desktop/) calls the commands below. It never receives a
//! token: it gets the account's label, the model catalogue, and streamed
//! Responses API events.

mod config;
mod oauth;
mod openai;
mod speech;
mod store;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::ipc::Channel;
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tokio_util::sync::CancellationToken;

use config::Config;
use oauth::{Account, Tokens};

struct AppState {
    http: reqwest::Client,
    config: Config,
    /// None until first read from the credential store; then the signed-in tokens, if any.
    /// The async lock also serializes refreshes, so two requests never spend one refresh token twice.
    tokens: tokio::sync::Mutex<Option<Option<Tokens>>>,
    /// Streams in flight, by the page's id, so it can cancel them.
    streams: Mutex<HashMap<u32, CancellationToken>>,
    listener: Mutex<Option<speech::Listener>>,
}

impl AppState {
    async fn cached(&self) -> Result<tokio::sync::MutexGuard<'_, Option<Option<Tokens>>>, String> {
        let mut guard = self.tokens.lock().await;
        if guard.is_none() {
            *guard = Some(store::get::<Tokens>(store::TOKENS)?);
        }
        Ok(guard)
    }

    /// A valid access token, refreshed first when due (or when `force`d after a 401).
    async fn access_token(&self, force: bool) -> Result<String, String> {
        let mut guard = self.cached().await?;
        let tokens = guard
            .as_ref()
            .and_then(Option::as_ref)
            .ok_or("not signed in to ChatGPT")?;
        let fresh = oauth::refresh(&self.http, &self.config, tokens, force).await?;
        let token = fresh.access_token.clone();
        *guard = Some(Some(fresh));
        Ok(token)
    }

    /// Sends a request with the user's credential, refreshing and retrying once if it was refused as expired.
    async fn authorized(&self, build: impl Fn(&str) -> reqwest::RequestBuilder) -> Result<reqwest::Response, String> {
        let token = self.access_token(false).await?;
        let response = build(&token)
            .send()
            .await
            .map_err(|e| format!("could not reach OpenAI: {e}"))?;
        if response.status() != reqwest::StatusCode::UNAUTHORIZED {
            return Ok(response);
        }
        let token = self.access_token(true).await?;
        build(&token)
            .send()
            .await
            .map_err(|e| format!("could not reach OpenAI: {e}"))
    }
}

#[tauri::command]
async fn auth_status(state: State<'_, AppState>) -> Result<Option<Account>, String> {
    Ok(state
        .cached()
        .await?
        .as_ref()
        .and_then(Option::as_ref)
        .map(|t| t.account.clone()))
}

#[tauri::command]
async fn auth_sign_in(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Account, String> {
    let tokens = oauth::sign_in(&state.http, &state.config, |url| {
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|e| format!("could not open the browser: {e}"))
    })
    .await?;
    let account = tokens.account.clone();
    *state.tokens.lock().await = Some(Some(tokens));
    Ok(account)
}

#[tauri::command]
async fn auth_sign_out(state: State<'_, AppState>) -> Result<(), String> {
    let previous = {
        let mut guard = state.cached().await?;
        guard.replace(None).flatten()
    };
    oauth::sign_out(&state.http, &state.config, previous).await
}

/// The account's own model catalogue, as OpenAI returns it.
#[tauri::command]
async fn models_list(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let url = format!("{}/models", state.config.api_base);
    let response = state
        .authorized(|token| state.http.get(&url).bearer_auth(token))
        .await?;
    if !response.status().is_success() {
        return Err(openai::api_error(response).await);
    }
    response.json().await.map_err(|e| format!("unreadable model list: {e}"))
}

/// The last message of every completed stream (web/desktop/bridge.ts).
const STREAM_END: &str = "[END]";

/// Streams a Responses API request; each event's JSON goes to `on_event` as it arrives, then STREAM_END.
#[tauri::command]
async fn responses_stream(
    state: State<'_, AppState>,
    request: serde_json::Value,
    stream_id: u32,
    on_event: Channel<String>,
) -> Result<(), String> {
    let body = openai::stateless(request)?;
    let cancel = CancellationToken::new();
    state.streams.lock().unwrap().insert(stream_id, cancel.clone());
    let url = format!("{}/responses", state.config.api_base);
    let result = async {
        let response = state
            .authorized(|token| {
                state
                    .http
                    .post(&url)
                    .bearer_auth(token)
                    .header("Accept", "text/event-stream")
                    .json(&body)
            })
            .await?;
        if !response.status().is_success() {
            return Err(openai::api_error(response).await);
        }
        openai::stream_response(response, cancel, |data| on_event.send(data).map_err(|e| e.to_string())).await?;
        // Channel messages arrive in order, but not necessarily before the command's own reply: this marks the end.
        on_event.send(STREAM_END.to_owned()).map_err(|e| e.to_string())
    }
    .await;
    state.streams.lock().unwrap().remove(&stream_id);
    result
}

#[tauri::command]
fn responses_cancel(state: State<'_, AppState>, stream_id: u32) {
    if let Some(cancel) = state.streams.lock().unwrap().remove(&stream_id) {
        cancel.cancel();
    }
}

fn is_external(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:")
}

#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !is_external(&url) {
        return Err("only web and mail links open externally".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn speech_supported() -> bool {
    speech::SUPPORTED
}

/// Asks macOS for speech recognition permission (microphone permission is asked when listening starts).
#[tauri::command]
async fn speech_authorize() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(speech::authorize)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn speech_listen(state: State<'_, AppState>, on_event: Channel<speech::SpeechEvent>) -> Result<(), String> {
    let mut slot = state.listener.lock().unwrap();
    if let Some(previous) = slot.take() {
        previous.stop();
    }
    let emit = Arc::new(move |event: speech::SpeechEvent| {
        let _ = on_event.send(event);
    });
    *slot = Some(speech::Listener::start(emit)?);
    Ok(())
}

#[tauri::command]
fn speech_stop(state: State<'_, AppState>) {
    if let Some(listener) = state.listener.lock().unwrap().take() {
        listener.stop();
    }
}

/// Pages the window may show: the bundled app, or the dev server in development.
fn is_app_url(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "tauri" | "asset")
        || matches!(
            url.host_str(),
            Some("tauri.localhost" | "localhost" | "127.0.0.1" | "ipc.localhost")
        )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            http: reqwest::Client::builder()
                .user_agent(concat!("Equation.io-Desktop/", env!("CARGO_PKG_VERSION")))
                .build()
                .expect("HTTP client"),
            config: Config::load(),
            tokens: tokio::sync::Mutex::new(None),
            streams: Mutex::new(HashMap::new()),
            listener: Mutex::new(None),
        })
        .setup(|app| {
            let handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Equation.io")
                .inner_size(1280.0, 820.0)
                .min_inner_size(480.0, 360.0)
                // Any link that would leave the app (github, equation.io itself) opens in the browser instead.
                .on_navigation(move |url| {
                    if is_app_url(url) {
                        return true;
                    }
                    if is_external(url.as_str()) {
                        let _ = handle.opener().open_url(url.as_str(), None::<&str>);
                    }
                    false
                })
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth_status,
            auth_sign_in,
            auth_sign_out,
            models_list,
            responses_stream,
            responses_cancel,
            open_external,
            speech_supported,
            speech_authorize,
            speech_listen,
            speech_stop,
        ])
        .on_window_event(|window, event| {
            // Quitting mid-sentence must not leave the microphone on.
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(listener) = window.state::<AppState>().listener.lock().unwrap().take() {
                    listener.stop();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Equation.io");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_app_in_the_window_and_sends_the_web_out() {
        let url = |s: &str| tauri::Url::parse(s).unwrap();
        assert!(is_app_url(&url("tauri://localhost/index.html")));
        assert!(is_app_url(&url("http://tauri.localhost/g/abc")));
        assert!(is_app_url(&url("http://localhost:5173/")));
        assert!(!is_app_url(&url("https://github.com/aantthony/equation.io")));
        assert!(is_external("https://equation.io/"));
        assert!(!is_external("file:///etc/passwd"));
        assert!(!is_external("javascript:alert(1)"));
    }
}
