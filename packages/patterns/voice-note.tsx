/// <cts-enable />
import {
  Cell,
  cell,
  type Default,
  handler,
  NAME,
  recipe,
  UI,
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
  title?: Cell<Default<string, "Voice Note">>;
};

type Output = {
  transcription: Default<TranscriptionData | null, null>;
  notes: Default<TranscriptionData[], []>;
};

const handleTranscriptionComplete = handler<
  { detail: { transcription: TranscriptionData } },
  { notes: Cell<TranscriptionData[]> }
>(({ detail }, { notes }) => {
  // Add the transcription to our notes list
  notes.push(detail.transcription);
});

const handleDeleteNote = handler<
  { detail: { id: string } },
  { notes: Cell<TranscriptionData[]> }
>(({ detail }, { notes }) => {
  const currentNotes = notes.get();
  const filtered = currentNotes.filter((note) => note.id !== detail.id);
  notes.set(filtered);
});

const VoiceNote = recipe<Input, Output>(
  "Voice Note",
  ({ title }) => {
    const transcription = cell<TranscriptionData | null>(null);
    const notes = cell<TranscriptionData[]>([]);

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
                  autoTranscribe={true}
                  maxDuration={120}
                  showWaveform={true}
                  onct-transcription-complete={handleTranscriptionComplete({
                    notes,
                  })}
                />

                {transcription?.text && (
                  <div
                    style={{
                      marginTop: "1rem",
                      padding: "1rem",
                      backgroundColor: "var(--ct-color-blue-50)",
                      borderRadius: "0.375rem",
                    }}
                  >
                    <strong>Latest Transcription:</strong>
                    <p>{transcription.text}</p>
                    <small style={{ color: "var(--ct-color-gray-600)" }}>
                      Duration: {transcription.duration.toFixed(1)}s
                    </small>
                  </div>
                )}
              </div>
            </ct-card>

            <ct-card>
              <div style={{ padding: "1rem" }}>
                <h3 style={{ marginTop: 0 }}>
                  Saved Notes ({notes.length})
                </h3>

                {notes.length === 0
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
                                {new Date(note.timestamp).toLocaleString()} ·
                                {" "}
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
  },
);

export default VoiceNote;
