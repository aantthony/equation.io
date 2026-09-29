//! The OS credential store (macOS: the login Keychain), holding the OAuth
//! tokens and the client identity OpenAI issued. The webview never sees
//! either: the page asks the Rust side to act, and gets back only an account
//! label and API results.

use serde::{de::DeserializeOwned, Serialize};

const SERVICE: &str = "io.equation.desktop";

/// The signed-in account's tokens.
pub const TOKENS: &str = "chatgpt-oauth-tokens";
/// The OAuth client identity (registered or configured), kept across sign-outs.
pub const CLIENT: &str = "chatgpt-oauth-client";

fn entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, key).map_err(|e| format!("credential store unavailable: {e}"))
}

pub fn get<T: DeserializeOwned>(key: &str) -> Result<Option<T>, String> {
    match entry(key)?.get_password() {
        Ok(json) => Ok(serde_json::from_str(&json).ok()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("could not read the credential store: {e}")),
    }
}

pub fn set<T: Serialize>(key: &str, value: &T) -> Result<(), String> {
    let json = serde_json::to_string(value).map_err(|e| e.to_string())?;
    entry(key)?
        .set_password(&json)
        .map_err(|e| format!("could not write the credential store: {e}"))
}

pub fn delete(key: &str) -> Result<(), String> {
    match entry(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("could not clear the credential store: {e}")),
    }
}
