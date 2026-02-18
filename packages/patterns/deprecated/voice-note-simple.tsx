/// <cts-enable />
import {
  computed,
  type Default,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";

// Type definition for transcription data (from ct-voice-input component)
interface TranscriptionChunk {
  timestamp: [number, number];
  text: string;
}

interface TranscriptionData {
  id: string;
  text: string;
  chunks?: TranscriptionChunk[];
  audioData?: string;
  duration: number;
  timestamp: number;
}

type Input = {
  title?: Writable<Default<string, "Voice Note Test">>;
};

type Output = {
  transcription: Default<TranscriptionData | null, null>;
};

const VoiceNoteSimple = pattern<Input, Output>(
  ({ title }) => {
    const transcription = Writable.of<TranscriptionData | null>(null);
    const hasTranscription = computed(() => transcription.get() !== null);
    const transcriptionText = computed(() => transcription.get()?.text || "");
    const transcriptionDuration = computed(
      () => transcription.get()?.duration || 0,
    );
    const transcriptionTimestamp = computed(
      () => transcription.get()?.timestamp || Date.now(),
    );

    return {
      [NAME]: title,
      [UI]: (
        <ct-screen>
          <div slot="header">
            <ct-input
              $value={title}
              placeholder="Voice Note Test"
            />
          </div>

          <ct-vstack gap="3" style="padding: 1rem; max-width: 600px;">
            <ct-card>
              <div style={{ padding: "1rem" }}>
                <h3 style={{ marginTop: 0 }}>Voice Input Component Test</h3>
                <p style={{ color: "var(--ct-color-gray-600)" }}>
                  Hold the microphone button to record. Release to transcribe.
                </p>

                <ct-voice-input
                  $transcription={transcription}
                  recordingMode="hold"
                  autoTranscribe
                  maxDuration={60}
                  showWaveform
                />
              </div>
            </ct-card>

            {hasTranscription && (
              <ct-card>
                <div style={{ padding: "1rem" }}>
                  <h3 style={{ marginTop: 0 }}>Latest Transcription</h3>
                  <p style={{ margin: "1rem 0" }}>{transcriptionText}</p>
                  <div
                    style={{
                      display: "flex",
                      gap: "1rem",
                      fontSize: "0.875rem",
                      color: "var(--ct-color-gray-600)",
                    }}
                  >
                    <span>
                      Duration: {transcriptionDuration.toFixed(1)}s
                    </span>
                    <span>
                      Recorded:{" "}
                      {new Date(transcriptionTimestamp).toLocaleTimeString()}
                    </span>
                  </div>
                </div>
              </ct-card>
            )}
          </ct-vstack>
        </ct-screen>
      ),
      transcription,
    };
  },
);

export default VoiceNoteSimple;
