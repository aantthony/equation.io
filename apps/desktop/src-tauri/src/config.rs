//! Where Sign in with ChatGPT and inference go. Defaults are OpenAI's public
//! endpoints; each can be set when building (so a release carries its OAuth
//! client) and overridden at run time for development.

use std::env;

/// A setting: the run-time environment wins over the value baked in at build time.
fn setting(name: &str, built: Option<&'static str>, default: &str) -> String {
    env::var(name)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| built.filter(|v| !v.trim().is_empty()).map(str::to_owned))
        .unwrap_or_else(|| default.to_owned())
}

#[derive(Clone, Debug)]
pub struct Config {
    /// The OAuth / OpenID Connect issuer; endpoints come from its discovery document.
    pub issuer: String,
    /// A pre-registered public client id. Without one the app registers itself
    /// (RFC 7591) when the issuer offers registration, and keeps the identity it is issued.
    pub client_id: Option<String>,
    pub scopes: String,
    /// The OpenAI API the user's credential is sent to: /models and /responses.
    pub api_base: String,
    /// The loopback port OpenAI redirects to (http://127.0.0.1:<port>/callback).
    pub redirect_port: u16,
}

impl Config {
    pub fn load() -> Config {
        let client_id = setting(
            "EQUATION_OPENAI_CLIENT_ID",
            option_env!("EQUATION_OPENAI_CLIENT_ID"),
            "",
        );
        Config {
            issuer: setting(
                "EQUATION_OPENAI_ISSUER",
                option_env!("EQUATION_OPENAI_ISSUER"),
                "https://auth.openai.com",
            )
            .trim_end_matches('/')
            .to_owned(),
            client_id: Some(client_id).filter(|id| !id.is_empty()),
            scopes: setting(
                "EQUATION_OPENAI_SCOPES",
                option_env!("EQUATION_OPENAI_SCOPES"),
                "openid profile email offline_access",
            ),
            api_base: setting(
                "EQUATION_OPENAI_API_BASE",
                option_env!("EQUATION_OPENAI_API_BASE"),
                "https://api.openai.com/v1",
            )
            .trim_end_matches('/')
            .to_owned(),
            redirect_port: setting("EQUATION_OAUTH_PORT", option_env!("EQUATION_OAUTH_PORT"), "14565")
                .parse()
                .unwrap_or(14565),
        }
    }

    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}/callback", self.redirect_port)
    }
}
