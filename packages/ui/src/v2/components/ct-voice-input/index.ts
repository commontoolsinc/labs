import { CTVoiceInput } from "./ct-voice-input.ts";

if (!customElements.get("ct-voice-input")) {
  customElements.define("ct-voice-input", CTVoiceInput);
}

export { CTVoiceInput };
export type {
  TranscriptionChunk,
  TranscriptionData,
} from "./ct-voice-input.ts";
