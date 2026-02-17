/// <cts-enable />
import {
  action,
  computed,
  type Default,
  handler,
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
  title?: Writable<Default<string, "Voice Note">>;
};

type Output = {
  transcription: Default<TranscriptionData | null, null>;
  notes: Default<TranscriptionData[], []>;
};

const handleDeleteNote = handler<
  undefined,
  { noteId: string; notes: Writable<TranscriptionData[]> }
>((_, { noteId, notes }) => {
  const currentNotes = notes.get();
  const filtered = currentNotes.filter((note) => note.id !== noteId);
  notes.set(filtered);
});

const VoiceNote = pattern<Input, Output>(({ title }) => {
  const transcription = Writable.of<TranscriptionData | null>(null);
  const notes = Writable.of<TranscriptionData[]>([]);

  const handleTranscriptionComplete = action(
    ({ detail }: { detail: { transcription: TranscriptionData } }) => {
      notes.push(detail.transcription);
    },
  );

  // Computed values for type-safe JSX access
  const hasTranscription = computed(() => transcription.get() !== null);
  const transcriptionText = computed(() => transcription.get()?.text || "");
  const transcriptionDuration = computed(
    () => transcription.get()?.duration || 0,
  );
  const notesCount = computed(() => notes.get().length);
  const hasNotes = computed(() => notes.get().length > 0);

  return {
    [NAME]: title,
    [UI]: (
      <ct-screen>
        <div slot="header">
          <ct-input
            $value={title}
            placeholder="Voice Note"
            readonly
          />
        </div>

        <ct-vstack gap="3">
          <ct-card>
            <div style={{ padding: "1rem" }}>
              <h3 style={{ marginTop: 0 }}>Record a Voice Note</h3>
              <p style={{ color: "var(--ct-color-gray-600)" }}>
                Hold the microphone button to record. Release to transcribe.
              </p>

              <ct-voice-input
                $transcription={transcription}
                recordingMode="hold"
                autoTranscribe
                maxDuration={120}
                showWaveform
                onct-transcription-complete={handleTranscriptionComplete}
              />

              {hasTranscription && (
                <div
                  style={{
                    marginTop: "1rem",
                    padding: "1rem",
                    backgroundColor: "var(--ct-color-blue-50)",
                    borderRadius: "0.375rem",
                  }}
                >
                  <strong>Latest Transcription:</strong>
                  <p>{transcriptionText}</p>
                  <small style={{ color: "var(--ct-color-gray-600)" }}>
                    Duration: {transcriptionDuration.toFixed(1)}s
                  </small>
                </div>
              )}
            </div>
          </ct-card>

          <ct-card>
            <div style={{ padding: "1rem" }}>
              <h3 style={{ marginTop: 0 }}>
                Saved Notes ({notesCount})
              </h3>

              {!hasNotes
                ? (
                  <p style={{ color: "var(--ct-color-gray-500)" }}>
                    No voice notes yet. Record one above!
                  </p>
                )
                : (
                  <ct-vstack gap="2">
                    {notes.map((note) => (
                      <div
                        style={{
                          padding: "0.75rem",
                          border: "1px solid var(--ct-color-gray-200)",
                          borderRadius: "0.375rem",
                          position: "relative",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "flex-start",
                            gap: "0.5rem",
                          }}
                        >
                          <div style={{ flex: 1 }}>
                            <p style={{ margin: "0 0 0.5rem 0" }}>
                              {note.text}
                            </p>
                            <small
                              style={{
                                color: "var(--ct-color-gray-600)",
                                display: "block",
                              }}
                            >
                              {new Date(note.timestamp).toLocaleString()} ·{" "}
                              {note.duration.toFixed(1)}s
                            </small>
                          </div>
                          <ct-button
                            variant="ghost"
                            size="sm"
                            onClick={handleDeleteNote({
                              noteId: note.id,
                              notes,
                            })}
                          >
                            ×
                          </ct-button>
                        </div>
                      </div>
                    ))}
                  </ct-vstack>
                )}
            </div>
          </ct-card>
        </ct-vstack>
      </ct-screen>
    ),
    transcription,
    notes,
  };
});

export default VoiceNote;
