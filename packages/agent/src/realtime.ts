/**
 * The OpenAI Realtime voice session: the web app's speech-to-speech mode,
 * whose calls the Worker creates and meters (worker/voice-call.ts). The
 * Responses API agent (responses.ts) is the alternative transport for the
 * same prompt and tools.
 */
import { VOICE_INSTRUCTIONS } from './prompt.ts';
import { TOOLS } from './tools.ts';

export const VOICE_MODEL = 'gpt-realtime-2.1';
export const VOICE_NAME = 'marin';

/** The session every call is created with. */
export const SESSION_CONFIG = {
  type: 'realtime',
  model: VOICE_MODEL,
  instructions: VOICE_INSTRUCTIONS,
  audio: {
    input: {
      // Laptop and room microphones: cleaned before turn detection hears it.
      noise_reduction: { type: 'far_field' },
      // Speech doesn't cut the model off: in a noisy room any voice would.
      // The student interrupts by tapping the orb instead. Nor does a turn
      // answer itself: the page asks for the reply, and drops turns heard
      // while the model was talking (web/voice-realtime.ts), which may be anyone.
      turn_detection: { type: 'semantic_vad', create_response: false, interrupt_response: false },
    },
    output: { voice: VOICE_NAME },
  },
  tools: TOOLS,
  tool_choice: 'auto',
} as const;
