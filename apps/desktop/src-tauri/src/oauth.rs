//! Sign in with ChatGPT: OAuth 2.0 authorization code flow with PKCE for a
//! native app (RFC 8252). The system browser signs in; OpenAI redirects to a
//! one-shot listener on 127.0.0.1; the code is exchanged here and the tokens
//! go straight to the credential store (store.rs).
//!
//! Endpoints come from the issuer's discovery document rather than being
//! hard-coded. The client identity is either configured at build time or, when
//! the issuer offers dynamic client registration (RFC 7591), issued to this
//! install on first sign-in and kept.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::config::Config;
use crate::store;

/// How long the browser has to come back before sign-in gives up.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);
/// Refresh this long before the access token expires.
const REFRESH_MARGIN_SECS: u64 = 60;

/// The parts of the issuer's metadata this flow uses.
#[derive(Clone, Debug, Deserialize)]
pub struct Metadata {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    #[serde(default)]
    pub registration_endpoint: Option<String>,
    #[serde(default)]
    pub revocation_endpoint: Option<String>,
    #[serde(default)]
    pub userinfo_endpoint: Option<String>,
}

/// The OAuth client this install signs in as.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Client {
    pub issuer: String,
    pub client_id: String,
    #[serde(default)]
    pub client_secret: Option<String>,
    pub redirect_uri: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Account {
    /// How to name the account to its owner: an email, or a name.
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub id_token: Option<String>,
    /// Unix seconds.
    #[serde(default)]
    pub expires_at: Option<u64>,
    pub account: Account,
}

impl Tokens {
    pub fn needs_refresh(&self, now: u64) -> bool {
        self.expires_at.is_some_and(|at| now + REFRESH_MARGIN_SECS >= at)
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `bytes` of randomness, base64url without padding.
pub fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

/// A PKCE verifier (RFC 7636: 43–128 characters) and its S256 challenge.
pub fn pkce_pair() -> (String, String) {
    let verifier = random_token(64);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

pub fn authorize_url(
    meta: &Metadata,
    client: &Client,
    scopes: &str,
    challenge: &str,
    state: &str,
    nonce: &str,
) -> Result<String, String> {
    let mut url =
        url::Url::parse(&meta.authorization_endpoint).map_err(|e| format!("bad authorization endpoint: {e}"))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &client.client_id)
        .append_pair("redirect_uri", &client.redirect_uri)
        .append_pair("scope", scopes)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        .append_pair("nonce", nonce);
    Ok(url.into())
}

/// What came back to the redirect URI.
#[derive(Debug, PartialEq)]
pub enum Callback {
    Code(String),
    Denied(String),
    /// Not the callback (a favicon request, a stray probe), or a forged one.
    Ignore,
}

/// Reads the request line of a redirect back to 127.0.0.1 (`GET /callback?code=…&state=… HTTP/1.1`).
pub fn parse_callback(request: &str, expected_state: &str) -> Callback {
    let Some(target) = request.lines().next().and_then(|line| {
        let mut parts = line.split_whitespace();
        (parts.next() == Some("GET")).then(|| parts.next()).flatten()
    }) else {
        return Callback::Ignore;
    };
    let Ok(url) = url::Url::parse(&format!("http://127.0.0.1{target}")) else {
        return Callback::Ignore;
    };
    if url.path() != "/callback" {
        return Callback::Ignore;
    }
    let param = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
    // Anything without our state was not started by this sign-in.
    if !param("state").is_some_and(|s| constant_time_eq(s.as_bytes(), expected_state.as_bytes())) {
        return Callback::Ignore;
    }
    if let Some(error) = param("error") {
        return Callback::Denied(param("error_description").unwrap_or(error));
    }
    match param("code") {
        Some(code) if !code.is_empty() => Callback::Code(code),
        _ => Callback::Ignore,
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Who signed in, from the ID token's claims. The token came straight from
/// the token endpoint over TLS, and the claims are only used as a label, so
/// the signature is not checked here.
pub fn account_from_id_token(id_token: &str) -> Option<Account> {
    let payload = id_token.split('.').nth(1)?;
    let claims: serde_json::Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?).ok()?;
    account_from_claims(&claims)
}

fn account_from_claims(claims: &serde_json::Value) -> Option<Account> {
    let label = ["email", "name", "preferred_username", "sub"]
        .iter()
        .find_map(|k| claims.get(k).and_then(|v| v.as_str()).filter(|s| !s.is_empty()))?
        .to_owned();
    let plan = claims
        .get("https://api.openai.com/auth")
        .and_then(|auth| auth.get("chatgpt_plan_type"))
        .and_then(|p| p.as_str())
        .map(str::to_owned);
    Some(Account { label, plan })
}

/// Why an OAuth endpoint said no, in words.
async fn oauth_error(response: reqwest::Response) -> String {
    let status = response.status();
    let body: serde_json::Value = response.json().await.unwrap_or_default();
    let detail = body
        .get("error_description")
        .or_else(|| body.get("error"))
        .or_else(|| body.pointer("/error/message"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    format!(
        "OpenAI sign-in failed ({status}){}",
        if detail.is_empty() {
            String::new()
        } else {
            format!(": {detail}")
        }
    )
}

pub async fn discover(http: &reqwest::Client, issuer: &str) -> Result<Metadata, String> {
    let mut last = String::new();
    for path in [
        "/.well-known/openid-configuration",
        "/.well-known/oauth-authorization-server",
    ] {
        match http.get(format!("{issuer}{path}")).send().await {
            Ok(r) if r.status().is_success() => {
                return r.json().await.map_err(|e| format!("unreadable sign-in metadata: {e}"));
            }
            Ok(r) => last = format!("HTTP {}", r.status()),
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("could not reach OpenAI sign-in ({last})"))
}

/// The client to sign in as: the stored one issued for this issuer, the one
/// configured at build time, or a new registration.
async fn client(http: &reqwest::Client, config: &Config, meta: &Metadata) -> Result<Client, String> {
    let redirect_uri = config.redirect_uri();
    if let Some(id) = &config.client_id {
        return Ok(Client {
            issuer: meta.issuer.clone(),
            client_id: id.clone(),
            client_secret: None,
            redirect_uri,
        });
    }
    if let Some(saved) = store::get::<Client>(store::CLIENT)? {
        if saved.issuer == meta.issuer && saved.redirect_uri == redirect_uri {
            return Ok(saved);
        }
    }
    let Some(endpoint) = &meta.registration_endpoint else {
        return Err(
            "this build has no OpenAI client id (set EQUATION_OPENAI_CLIENT_ID when building), and OpenAI does not offer client registration"
                .into(),
        );
    };
    let response = http
        .post(endpoint)
        .json(&serde_json::json!({
            "client_name": "Equation.io",
            "client_uri": "https://equation.io/",
            "logo_uri": "https://equation.io/icon-512.png",
            "application_type": "native",
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "scope": config.scopes,
        }))
        .send()
        .await
        .map_err(|e| format!("could not register with OpenAI: {e}"))?;
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    #[derive(Deserialize)]
    struct Registered {
        client_id: String,
        #[serde(default)]
        client_secret: Option<String>,
    }
    let registered: Registered = response
        .json()
        .await
        .map_err(|e| format!("unreadable registration: {e}"))?;
    let client = Client {
        issuer: meta.issuer.clone(),
        client_id: registered.client_id,
        client_secret: registered.client_secret,
        redirect_uri,
    };
    // OpenAI issued this identity to this install: keep it for every later sign-in and refresh.
    store::set(store::CLIENT, &client)?;
    Ok(client)
}

fn with_client_auth(request: reqwest::RequestBuilder, client: &Client) -> reqwest::RequestBuilder {
    match &client.client_secret {
        Some(secret) => request.basic_auth(&client.client_id, Some(secret)),
        None => request,
    }
}

async fn token_request(
    http: &reqwest::Client,
    meta: &Metadata,
    client: &Client,
    form: &[(&str, &str)],
    previous: Option<&Tokens>,
) -> Result<Tokens, String> {
    let mut form = form.to_vec();
    form.push(("client_id", &client.client_id));
    let response = with_client_auth(http.post(&meta.token_endpoint), client)
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("could not reach OpenAI sign-in: {e}"))?;
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let t: TokenResponse = response.json().await.map_err(|e| format!("unreadable tokens: {e}"))?;
    let id_token = t.id_token.or_else(|| previous.and_then(|p| p.id_token.clone()));
    let mut account = id_token.as_deref().and_then(account_from_id_token);
    if account.is_none() {
        account = previous.map(|p| p.account.clone());
    }
    if account.is_none() {
        account = userinfo(http, meta, &t.access_token).await;
    }
    Ok(Tokens {
        expires_at: t.expires_in.map(|s| now() + s),
        // A refresh response may omit the refresh token: the old one stays valid.
        refresh_token: t
            .refresh_token
            .or_else(|| previous.and_then(|p| p.refresh_token.clone())),
        id_token,
        account: account.unwrap_or(Account {
            label: "ChatGPT account".into(),
            plan: None,
        }),
        access_token: t.access_token,
    })
}

async fn userinfo(http: &reqwest::Client, meta: &Metadata, access_token: &str) -> Option<Account> {
    let claims: serde_json::Value = http
        .get(meta.userinfo_endpoint.as_ref()?)
        .bearer_auth(access_token)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    account_from_claims(&claims)
}

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Equation.io</title>\
<body style=\"font:16px system-ui;display:grid;place-items:center;height:90vh;margin:0\">\
<p>Signed in to Equation.io. You can close this tab and go back to the app.</p>";
const FAILED_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Equation.io</title>\
<body style=\"font:16px system-ui;display:grid;place-items:center;height:90vh;margin:0\">\
<p>Sign-in did not complete. You can close this tab and try again from Equation.io.</p>";

async fn respond(stream: &mut tokio::net::TcpStream, status: &str, body: &str) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// Waits on the loopback listener for the browser to come back with our state.
async fn await_callback(listener: TcpListener, state: &str) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 8192];
        let mut len = 0;
        // The request line and headers; the body (there is none for a GET) is never needed.
        while len < buf.len() {
            let Ok(Ok(n)) = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf[len..])).await else {
                break;
            };
            if n == 0 {
                break;
            }
            len += n;
            if buf[..len].windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        match parse_callback(&String::from_utf8_lossy(&buf[..len]), state) {
            Callback::Code(code) => {
                respond(&mut stream, "200 OK", DONE_PAGE).await;
                return Ok(code);
            }
            Callback::Denied(reason) => {
                respond(&mut stream, "200 OK", FAILED_PAGE).await;
                return Err(format!("sign-in was not completed: {reason}"));
            }
            Callback::Ignore => respond(&mut stream, "404 Not Found", "").await,
        }
    }
}

/// The whole interactive sign-in. `open` shows the authorization page in the system browser.
pub async fn sign_in(
    http: &reqwest::Client,
    config: &Config,
    open: impl FnOnce(&str) -> Result<(), String>,
) -> Result<Tokens, String> {
    let meta = discover(http, &config.issuer).await?;
    let client = client(http, config, &meta).await?;
    let listener = TcpListener::bind(("127.0.0.1", config.redirect_port))
        .await
        .map_err(|e| {
            format!(
                "could not listen for the sign-in callback on port {}: {e}",
                config.redirect_port
            )
        })?;
    let (verifier, challenge) = pkce_pair();
    let state = random_token(32);
    let nonce = random_token(32);
    open(&authorize_url(
        &meta,
        &client,
        &config.scopes,
        &challenge,
        &state,
        &nonce,
    )?)?;
    let code = tokio::time::timeout(SIGN_IN_TIMEOUT, await_callback(listener, &state))
        .await
        .map_err(|_| "sign-in timed out".to_string())??;
    let tokens = token_request(
        http,
        &meta,
        &client,
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", &client.redirect_uri),
            ("code_verifier", &verifier),
        ],
        None,
    )
    .await?;
    store::set(store::TOKENS, &tokens)?;
    Ok(tokens)
}

/// A fresh access token, refreshing (and storing) it first when it is about to expire or `force` is set.
pub async fn refresh(http: &reqwest::Client, config: &Config, tokens: &Tokens, force: bool) -> Result<Tokens, String> {
    if !force && !tokens.needs_refresh(now()) {
        return Ok(tokens.clone());
    }
    let Some(refresh_token) = tokens.refresh_token.as_deref() else {
        return Err("your ChatGPT sign-in has expired; sign in again".into());
    };
    let meta = discover(http, &config.issuer).await?;
    let client = client(http, config, &meta).await?;
    let fresh = token_request(
        http,
        &meta,
        &client,
        &[("grant_type", "refresh_token"), ("refresh_token", refresh_token)],
        Some(tokens),
    )
    .await
    .map_err(|e| format!("{e}; sign in again"))?;
    store::set(store::TOKENS, &fresh)?;
    Ok(fresh)
}

/// Forgets the tokens here and, best effort, revokes the refresh token at OpenAI.
pub async fn sign_out(http: &reqwest::Client, config: &Config, tokens: Option<Tokens>) -> Result<(), String> {
    store::delete(store::TOKENS)?;
    let Some(tokens) = tokens else { return Ok(()) };
    let Ok(meta) = discover(http, &config.issuer).await else {
        return Ok(());
    };
    let (Some(endpoint), Ok(client)) = (meta.revocation_endpoint.clone(), client(http, config, &meta).await) else {
        return Ok(());
    };
    let (token, hint) = match &tokens.refresh_token {
        Some(t) => (t.as_str(), "refresh_token"),
        None => (tokens.access_token.as_str(), "access_token"),
    };
    let _ = with_client_auth(http.post(endpoint), &client)
        .form(&[
            ("token", token),
            ("token_type_hint", hint),
            ("client_id", &client.client_id),
        ])
        .send()
        .await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATE: &str = "s7ate";

    #[test]
    fn pkce_challenge_is_s256_of_the_verifier() {
        let (verifier, challenge) = pkce_pair();
        assert!((43..=128).contains(&verifier.len()));
        assert!(verifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_eq!(challenge, URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())));
        assert_ne!(pkce_pair().0, verifier);
    }

    #[test]
    fn rfc7636_example_challenge() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn authorize_url_carries_pkce_and_state() {
        let meta = Metadata {
            issuer: "https://auth.example".into(),
            authorization_endpoint: "https://auth.example/oauth/authorize".into(),
            token_endpoint: "https://auth.example/oauth/token".into(),
            registration_endpoint: None,
            revocation_endpoint: None,
            userinfo_endpoint: None,
        };
        let client = Client {
            issuer: meta.issuer.clone(),
            client_id: "app_123".into(),
            client_secret: None,
            redirect_uri: "http://127.0.0.1:14565/callback".into(),
        };
        let url = url::Url::parse(&authorize_url(&meta, &client, "openid email", "chal", STATE, "n").unwrap()).unwrap();
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["client_id"], "app_123");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:14565/callback");
        assert_eq!(q["code_challenge"], "chal");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["state"], STATE);
        assert_eq!(q["scope"], "openid email");
    }

    #[test]
    fn callback_needs_our_state() {
        let ok = format!("GET /callback?code=abc&state={STATE} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        assert_eq!(parse_callback(&ok, STATE), Callback::Code("abc".into()));
        assert_eq!(
            parse_callback("GET /callback?code=abc&state=other HTTP/1.1\r\n", STATE),
            Callback::Ignore
        );
        assert_eq!(
            parse_callback("GET /callback?code=abc HTTP/1.1\r\n", STATE),
            Callback::Ignore
        );
        assert_eq!(parse_callback("GET /favicon.ico HTTP/1.1\r\n", STATE), Callback::Ignore);
        assert_eq!(
            parse_callback("POST /callback?code=abc&state=s7ate HTTP/1.1\r\n", STATE),
            Callback::Ignore
        );
        let denied = format!("GET /callback?error=access_denied&error_description=Nope&state={STATE} HTTP/1.1\r\n");
        assert_eq!(parse_callback(&denied, STATE), Callback::Denied("Nope".into()));
    }

    #[test]
    fn account_from_id_token_claims() {
        let claims = serde_json::json!({
            "email": "ada@example.com",
            "https://api.openai.com/auth": { "chatgpt_plan_type": "plus" }
        });
        let token = format!("h.{}.s", URL_SAFE_NO_PAD.encode(claims.to_string()));
        let account = account_from_id_token(&token).unwrap();
        assert_eq!(account.label, "ada@example.com");
        assert_eq!(account.plan.as_deref(), Some("plus"));
        assert!(account_from_id_token("not-a-jwt").is_none());
    }

    #[test]
    fn refreshes_shortly_before_expiry() {
        let tokens = Tokens {
            access_token: "a".into(),
            refresh_token: None,
            id_token: None,
            expires_at: Some(1000),
            account: Account {
                label: "x".into(),
                plan: None,
            },
        };
        assert!(!tokens.needs_refresh(900));
        assert!(tokens.needs_refresh(950));
        assert!(!Tokens {
            expires_at: None,
            ..tokens
        }
        .needs_refresh(u64::MAX / 2));
    }
}
