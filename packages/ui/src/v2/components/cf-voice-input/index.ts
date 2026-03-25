import { CFVoiceInput } from "./cf-voice-input.ts";

if (!customElements.get("cf-voice-input")) {
  customElements.define("cf-voice-input", CFVoiceInput);
}

export { CFVoiceInput };
export type {
  TranscriptionChunk,
  TranscriptionData,
} from "./cf-voice-input.ts";
