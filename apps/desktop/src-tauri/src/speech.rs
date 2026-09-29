//! Native speech recognition on macOS: the microphone through AVAudioEngine
//! into Apple's Speech framework (SFSpeechRecognizer), on-device where the
//! system supports it. Transcripts stream to the page as events; the page
//! decides when an utterance has ended and what to do with it
//! (web/desktop/voice.ts).
//!
//! Only speech recognition is native: the reply is spoken by the webview's
//! speechSynthesis (AVSpeechSynthesizer underneath), and the model that
//! answers is the ChatGPT-plan Responses agent. Nothing here calls OpenAI.

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
// Only the macOS recognizer produces events.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum SpeechEvent {
    /// The transcript so far of the utterance being heard.
    Partial {
        text: String,
    },
    /// The recognizer finished the utterance.
    Final {
        text: String,
    },
    Error {
        message: String,
    },
}

#[cfg(target_os = "macos")]
mod imp {
    use super::SpeechEvent;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2_avf_audio::{AVAudioEngine, AVAudioPCMBuffer, AVAudioTime};
    use objc2_foundation::NSError;
    use objc2_speech::{
        SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask, SFSpeechRecognizer,
        SFSpeechRecognizerAuthorizationStatus,
    };
    use std::ptr::NonNull;
    use std::sync::mpsc;
    use std::sync::Arc;

    /// Asks for speech recognition permission (the system prompt appears once) and reports whether it was granted.
    pub fn authorize() -> Result<bool, String> {
        let (tx, rx) = mpsc::channel();
        let handler = RcBlock::new(move |status: SFSpeechRecognizerAuthorizationStatus| {
            let _ = tx.send(status == SFSpeechRecognizerAuthorizationStatus::Authorized);
        });
        unsafe { SFSpeechRecognizer::requestAuthorization(&handler) };
        rx.recv()
            .map_err(|_| "speech recognition permission was not answered".to_string())
    }

    /// A running recognition: the audio engine tapping the microphone, and the task transcribing it.
    pub struct Listener {
        engine: Retained<AVAudioEngine>,
        request: Retained<SFSpeechAudioBufferRecognitionRequest>,
        task: Retained<SFSpeechRecognitionTask>,
        _recognizer: Retained<SFSpeechRecognizer>,
    }

    // The objects are only touched through &self methods Apple documents as
    // thread-safe (stop, endAudio, cancel), and one Listener is used at a time
    // behind a Mutex (lib.rs).
    unsafe impl Send for Listener {}

    impl Listener {
        pub fn start(emit: Arc<dyn Fn(SpeechEvent) + Send + Sync>) -> Result<Listener, String> {
            unsafe {
                let recognizer = SFSpeechRecognizer::new();
                if !recognizer.isAvailable() {
                    return Err("speech recognition is not available right now".into());
                }
                let request = SFSpeechAudioBufferRecognitionRequest::new();
                request.setShouldReportPartialResults(true);

                let engine = AVAudioEngine::new();
                let input = engine.inputNode();
                let format = input.outputFormatForBus(0);
                let tap_request = request.clone();
                let tap = RcBlock::new(move |buffer: NonNull<AVAudioPCMBuffer>, _when: NonNull<AVAudioTime>| {
                    tap_request.appendAudioPCMBuffer(buffer.as_ref());
                });
                // The engine copies the block; ours can go when this returns.
                input.installTapOnBus_bufferSize_format_block(0, 1024, Some(&format), RcBlock::as_ptr(&tap));

                let results = emit.clone();
                let handler = RcBlock::new(move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
                    if let Some(result) = result.as_ref() {
                        let text = result.bestTranscription().formattedString().to_string();
                        results(if result.isFinal() {
                            SpeechEvent::Final { text }
                        } else {
                            SpeechEvent::Partial { text }
                        });
                    } else if let Some(error) = error.as_ref() {
                        results(SpeechEvent::Error {
                            message: error.localizedDescription().to_string(),
                        });
                    }
                });
                let task = recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler);

                engine.prepare();
                if let Err(error) = engine.startAndReturnError() {
                    task.cancel();
                    input.removeTapOnBus(0);
                    return Err(format!(
                        "the microphone could not start: {}",
                        error.localizedDescription()
                    ));
                }
                Ok(Listener {
                    engine,
                    request,
                    task,
                    _recognizer: recognizer,
                })
            }
        }

        /// Stops listening. Whatever was heard is dropped: the page already has the partial transcript it needs.
        pub fn stop(self) {
            unsafe {
                self.engine.stop();
                self.engine.inputNode().removeTapOnBus(0);
                self.request.endAudio();
                self.task.cancel();
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::SpeechEvent;
    use std::sync::Arc;

    const UNSUPPORTED: &str = "native speech recognition is only available on macOS";

    pub fn authorize() -> Result<bool, String> {
        Ok(false)
    }

    pub struct Listener;

    impl Listener {
        pub fn start(_emit: Arc<dyn Fn(SpeechEvent) + Send + Sync>) -> Result<Listener, String> {
            Err(UNSUPPORTED.into())
        }

        pub fn stop(self) {}
    }
}

pub use imp::{authorize, Listener};

/// Whether this build can recognize speech natively at all.
pub const SUPPORTED: bool = cfg!(target_os = "macos");
