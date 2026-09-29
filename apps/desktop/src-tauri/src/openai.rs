//! Inference on the user's own ChatGPT account, called directly from this
//! machine: nothing goes through Equation.io's servers. The page sends a
//! Responses API request body; this side attaches the OAuth credential,
//! forces `store: false, stream: true`, and streams the server-sent events
//! back one `data:` payload at a time.

use futures_util::StreamExt;
use tokio_util::sync::CancellationToken;

/// Splits a server-sent event stream into its `data` payloads.
#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    data: Vec<String>,
}

impl SseParser {
    /// Feeds bytes as they arrive; returns the payloads of the events they complete.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some(end) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line[..line.len() - 1]);
            let line = line.strip_suffix('\r').unwrap_or(&line);
            if line.is_empty() {
                if !self.data.is_empty() {
                    events.push(self.data.join("\n"));
                    self.data.clear();
                }
            } else if let Some(value) = line.strip_prefix("data:") {
                self.data.push(value.strip_prefix(' ').unwrap_or(value).to_owned());
            }
            // event:, id:, retry: and comments carry nothing the page needs: each payload names its own type.
        }
        events
    }
}

/// An API error, in words: OpenAI's own message when it gives one.
pub async fn api_error(response: reqwest::Response) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let message = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.pointer("/error/message").and_then(|m| m.as_str()).map(str::to_owned))
        .unwrap_or_else(|| body.chars().take(300).collect());
    format!(
        "OpenAI returned {status}{}",
        if message.is_empty() {
            String::new()
        } else {
            format!(": {message}")
        }
    )
}

/// The request as sent: whatever the page asked, OpenAI keeps nothing and the reply streams.
pub fn stateless(mut request: serde_json::Value) -> Result<serde_json::Value, String> {
    let body = request.as_object_mut().ok_or("the request must be a JSON object")?;
    body.insert("store".into(), false.into());
    body.insert("stream".into(), true.into());
    Ok(request)
}

/// Streams one Responses API request, calling `emit` with each event's data. Ends at `[DONE]`, the end of the stream, or cancellation.
pub async fn stream_response(
    response: reqwest::Response,
    cancel: CancellationToken,
    mut emit: impl FnMut(String) -> Result<(), String>,
) -> Result<(), String> {
    let mut parser = SseParser::default();
    let mut body = response.bytes_stream();
    loop {
        let chunk = tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            chunk = body.next() => chunk,
        };
        let Some(chunk) = chunk else { return Ok(()) };
        let chunk = chunk.map_err(|e| format!("the reply was cut off: {e}"))?;
        for data in parser.push(&chunk) {
            if data == "[DONE]" {
                return Ok(());
            }
            emit(data)?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_events_split_across_chunks() {
        let mut p = SseParser::default();
        assert!(p.push(b"event: response.created\ndata: {\"type\":").is_empty());
        assert_eq!(
            p.push(b"\"a\"}\n\n: comment\ndata: x\r\n\r\n"),
            vec!["{\"type\":\"a\"}", "x"]
        );
        assert_eq!(p.push(b"data: line1\ndata: line2\n\n"), vec!["line1\nline2"]);
    }

    #[test]
    fn keeps_multibyte_characters_split_between_chunks() {
        let mut p = SseParser::default();
        let bytes = "data: π\n\n".as_bytes();
        assert!(p.push(&bytes[..7]).is_empty());
        assert_eq!(p.push(&bytes[7..]), vec!["π"]);
    }

    #[test]
    fn forces_stateless_streaming() {
        let r = stateless(serde_json::json!({ "model": "m", "store": true, "stream": false })).unwrap();
        assert_eq!(r["store"], false);
        assert_eq!(r["stream"], true);
        assert_eq!(r["model"], "m");
        assert!(stateless(serde_json::json!([1])).is_err());
    }
}
