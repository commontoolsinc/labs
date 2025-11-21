# ct-voice-input Component Design

## Overview

A trusted UI component that enables voice recording and real-time transcription
in CommonTools patterns. Similar to `ct-image-input`, this component handles
browser APIs that patterns cannot access directly (MediaRecorder, getUserMedia)
and provides transcribed text via reactive cells.

**Reference Implementation:** Based on the previous `common-audio-recorder`
component
([source](https://github.com/commontoolsinc/labs/blob/56b4ef4351fec8616b3d8cce8c6d3ceda73ab7c8/packages/ui/src/v1/components/common-audio-recorder.ts))

## Component Architecture

This design proposes splitting concerns into two components:

1. **`ct-voice-input`** (Main Component)
   - Manages microphone permissions and MediaRecorder
   - Handles recording lifecycle and state
   - Integrates with transcription API
   - Manages cell binding and event emission
   - Provides audio stream to visualizer

2. **`ct-audio-visualizer`** (Sub-Component)
   - Receives audio stream handle from parent
   - Renders real-time waveform visualization
   - Lightweight, focused responsibility
   - Reusable for other audio contexts

This separation allows for:

- Cleaner code organization
- Reusable visualization component
- Easier testing of each concern
- Flexibility in waveform rendering approaches

## Visual Design

**Design Reference:** Discord-style voice message interaction with sophisticated
expansion animations.

**Note:** The detailed Discord-style design below represents the **long-term
vision** for this component. The initial v1 implementation will focus on core
functionality (recording, transcription, basic waveform). Visual polish and
advanced animations can be added iteratively in future versions.

### Idle State

```
┌──────────┐
│    🎤    │  Small circular button
└──────────┘  Light gray (#EBEDEF)
```

**Security Note:** Button always displays microphone icon - no custom text
allowed to prevent misleading users about recording.

### Recording State - Expanded Bar (Animated)

When user presses and holds the microphone button:

```
┌─────────────────────────────────────────────────┐
│ 🗑️           Release to Send              🔒↑ │  Organic wave shape at top
│                                                 │  Vibrant indigo (#5865F2)
│  🔴 0:03    ▂▃▅▇▅▃▂▅▃▂                         │  Live waveform (white bars)
└─────────────────────────────────────────────────┘
```

**Animation Details:**

- **Expansion**: Small button → Full-width bar (elastic morph)
- **Color Transition**: Light gray → Vibrant indigo (#5865F2)
- **Shape**: Top edge curves organically (wave-like, not flat rectangle)
- **Controls**:
  - Left: 🗑️ Trash icon (slide left to delete)
  - Center: "Release to Send" text
  - Right: 🔒↑ Lock icon + chevron (slide up to lock recording)
- **Recording Indicator**: Red pulsing dot + timer (0:00, 0:01, ...)
- **Waveform**: White vertical bars that fluctuate with audio input
- **Duration**: Timer increments in real-time

### Send Transition

On release:

- Bar collapses back to standard input size
- All recording controls disappear
- Microphone button returns to original state

### Message Bubble States (Chat Interfaces)

After sending, message bubble transitions through states:

**1. Uploading/Processing**

```
┌─────────────────────┐
│ ✖  ▂▃▅▇▅▃▂  0:03   │  Gray waveform, X icon (cancellable)
└─────────────────────┘
```

**2. Upload Complete (Brief)**

```
┌─────────────────────┐
│ ✓  ▂▃▅▇▅▃▂  0:03   │  Gray waveform, checkmark icon
└─────────────────────┘
```

**3. Ready to Play**

```
┌─────────────────────┐
│ ▶  ▂▃▅▇▅▃▂  0:03   │  Black waveform, play triangle
└─────────────────────┘
```

**4. Playing**

```
┌─────────────────────┐
│ ⏸  ▅▅▅▅▃▂▂  0:03   │  Filling indigo → black, pause icon
└─────────────────────┘
```

**Playback Animation:**

- Play icon (▶) switches to Pause icon (⏸)
- Waveform bars fill from left to right: Black → Indigo
- Progress represents playback position
- On completion: Returns to play icon, waveform resets

### Processing State (Transcription)

```
┌─────────────────────┐
│  ⏳ Transcribing...  │
│  ▂▃▅▇▅▃▂           │
└─────────────────────┘
```

### Completed State

```
┌─────────────────────┐
│  ✓ Transcribed       │
│  Hold to re-record   │
└─────────────────────┘
```

## Component API

### Element Definition

```typescript
<ct-voice-input
  $transcription={transcription}
  recordingMode="hold"
  autoTranscribe={true}
  maxDuration={60}
  showWaveform={true}
/>;
```

### Properties

| Property         | Type                                           | Default  | Description                                   |
| ---------------- | ---------------------------------------------- | -------- | --------------------------------------------- |
| `transcription`  | `Cell<TranscriptionData \| TranscriptionData>` | -        | Cell for bidirectional transcription binding  |
| `recordingMode`  | `"hold" \| "toggle"`                           | `"hold"` | Hold button to record, or click to start/stop |
| `autoTranscribe` | `boolean`                                      | `true`   | Automatically transcribe when recording stops |
| `maxDuration`    | `number`                                       | `60`     | Max recording duration in seconds             |
| `showWaveform`   | `boolean`                                      | `true`   | Show audio waveform visualization             |
| `disabled`       | `boolean`                                      | `false`  | Disable recording                             |

### Data Structures

```typescript
interface TranscriptionChunk {
  timestamp: [number, number]; // [start_seconds, end_seconds]
  text: string;
}

interface TranscriptionData {
  id: string; // Unique ID for this recording
  text: string; // Full transcription text
  chunks?: TranscriptionChunk[]; // Timestamped segments
  audioData?: string; // Base64 audio data (optional)
  duration: number; // Recording duration in seconds
  timestamp: number; // Unix timestamp when recorded
}
```

### Events

| Event                       | Detail                                  | Description                |
| --------------------------- | --------------------------------------- | -------------------------- |
| `ct-recording-start`        | `{ timestamp: number }`                 | Recording started          |
| `ct-recording-stop`         | `{ duration: number, audioData: Blob }` | Recording stopped          |
| `ct-transcription-start`    | `{ id: string }`                        | Transcription request sent |
| `ct-transcription-complete` | `{ transcription: TranscriptionData }`  | Transcription received     |
| `ct-transcription-error`    | `{ error: Error, message: string }`     | Transcription failed       |

## Technical Implementation

### 1. Recording Flow

```typescript
class CTVoiceInput extends BaseElement {
  // Cell controller for bidirectional binding
  private _cellController = createCellController<TranscriptionData>(this, {
    timing: { strategy: "immediate" },
    onChange: (newValue) => {
      this.emit("ct-change", { transcription: newValue });
    },
  });

  private mediaRecorder?: MediaRecorder;
  private audioChunks: Blob[] = [];
  private startTime?: number;

  async startRecording() {
    // Request microphone permission
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    // Create MediaRecorder with appropriate codec
    this.mediaRecorder = new MediaRecorder(stream, {
      mimeType: "audio/webm;codecs=opus",
    });

    this.audioChunks = [];
    this.startTime = Date.now();

    // Collect audio chunks
    this.mediaRecorder.ondataavailable = (event) => {
      this.audioChunks.push(event.data);
    };

    // Handle recording completion
    this.mediaRecorder.onstop = () => {
      this.processRecording();
    };

    this.mediaRecorder.start();
    this.emit("ct-recording-start", { timestamp: this.startTime });
  }

  async processRecording() {
    const audioBlob = new Blob(this.audioChunks, { type: "audio/webm" });
    const duration = (Date.now() - this.startTime!) / 1000;

    this.emit("ct-recording-stop", { duration, audioData: audioBlob });

    if (this.autoTranscribe) {
      await this.transcribeAudio(audioBlob, duration);
    }
  }
}
```

### 2. Transcription Flow

```typescript
async transcribeAudio(audioBlob: Blob, duration: number) {
  const id = this._generateId();
  this.emit("ct-transcription-start", { id });

  try {
    // Convert to WAV if needed (webm might not be supported)
    const wavBlob = await this.convertToWav(audioBlob);

    // Send to transcription API
    const response = await fetch('/api/ai/voice/transcribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/wav',
      },
      body: wavBlob,
    });

    if (!response.ok) {
      throw new Error(`Transcription failed: ${response.statusText}`);
    }

    const result = await response.json();

    // Create transcription data
    const transcriptionData: TranscriptionData = {
      id,
      text: result.transcription,
      chunks: result.chunks,
      duration,
      timestamp: Date.now(),
      // Optionally include audio data
      audioData: await this.blobToBase64(audioBlob),
    };

    // Update cell via controller
    this._cellController.setValue(transcriptionData);

    this.emit("ct-transcription-complete", { transcription: transcriptionData });

  } catch (error) {
    this.emit("ct-transcription-error", {
      error,
      message: error.message
    });
  }
}
```

### 3. Waveform Visualization

**Sub-component: `ct-audio-visualizer`**

This component receives an audio stream from the parent and handles
visualization independently.

```typescript
interface AudioVisualizerProps {
  stream: MediaStream; // Audio stream from parent
  bars?: number; // Number of bars to display (default: 8)
  color?: string; // Bar color (default: 'white')
  height?: number; // Visualizer height (default: 40)
  renderMode?: "canvas" | "svg"; // Rendering approach
}
```

**Implementation Option A: Canvas with Polyline**

Simple, performant approach using Canvas 2D:

```typescript
class CTAudioVisualizer extends BaseElement {
  private audioContext?: AudioContext;
  private analyser?: AnalyserNode;
  private canvas?: HTMLCanvasElement;
  private ctx?: CanvasRenderingContext2D;
  private animationFrame?: number;

  async startVisualization(stream: MediaStream) {
    this.audioContext = new AudioContext();
    this.analyser = this.audioContext.createAnalyser();
    const microphone = this.audioContext.createMediaStreamSource(stream);

    microphone.connect(this.analyser);
    this.analyser.fftSize = 256;

    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);

    const draw = () => {
      if (!this.stream) return;

      this.analyser!.getByteFrequencyData(dataArray);

      // Clear canvas
      this.ctx!.clearRect(0, 0, this.canvas!.width, this.canvas!.height);

      // Draw polyline
      const barCount = this.bars || 8;
      const barWidth = this.canvas!.width / barCount;

      this.ctx!.strokeStyle = this.color || "white";
      this.ctx!.lineWidth = 2;
      this.ctx!.beginPath();

      for (let i = 0; i < barCount; i++) {
        const value = dataArray[i];
        const barHeight = (value / 255) * this.canvas!.height;
        const x = i * barWidth + barWidth / 2;
        const y = this.canvas!.height - barHeight;

        if (i === 0) {
          this.ctx!.moveTo(x, y);
        } else {
          this.ctx!.lineTo(x, y);
        }
      }

      this.ctx!.stroke();
      this.animationFrame = requestAnimationFrame(draw);
    };

    draw();
  }

  stopVisualization() {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
    }
    if (this.audioContext) {
      this.audioContext.close();
    }
  }
}
```

**Implementation Option B: SVG with Parameterized Shapes**

More flexible for styling, animations, and responsive design:

```typescript
class CTAudioVisualizer extends BaseElement {
  private audioContext?: AudioContext;
  private analyser?: AnalyserNode;
  private waveformData: number[] = [];

  async startVisualization(stream: MediaStream) {
    this.audioContext = new AudioContext();
    this.analyser = this.audioContext.createAnalyser();
    const microphone = this.audioContext.createMediaStreamSource(stream);

    microphone.connect(this.analyser);
    this.analyser.fftSize = 256;

    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);

    const update = () => {
      if (!this.stream) return;

      this.analyser!.getByteFrequencyData(dataArray);

      // Update reactive data
      const barCount = this.bars || 8;
      this.waveformData = Array.from(dataArray)
        .slice(0, barCount)
        .map((value) => value / 255); // Normalize to 0-1

      this.requestUpdate();
      requestAnimationFrame(update);
    };

    update();
  }

  render() {
    const barCount = this.waveformData.length || 8;
    const barWidth = 100 / barCount; // Percentage
    const height = this.height || 40;

    return html`
      <svg width="100%" height="${height}px" preserveAspectRatio="none">
        ${this.waveformData.map((value, i) => {
          const x = i * barWidth;
          const barHeight = value * height;
          const y = height - barHeight;

          return svg`
            <rect
              x="${x}%"
              y="${y}"
              width="${barWidth * 0.8}%"
              height="${barHeight}"
              fill="${this.color || "white"}"
              rx="1"
            />
          `;
        })}
      </svg>
    `;
  }
}
```

**Comparison:**

| Aspect         | Canvas (Polyline)           | SVG (Rectangles)     |
| -------------- | --------------------------- | -------------------- |
| Performance    | Faster for frequent updates | Slightly slower      |
| Styling        | Limited (stroke/fill)       | Full CSS control     |
| Accessibility  | Requires ARIA labels        | Native SVG semantics |
| Responsiveness | Manual resize handling      | Automatic scaling    |
| Complexity     | Simpler imperative code     | More declarative     |

**Recommendation:** Start with SVG for flexibility, optimize to Canvas if
performance becomes an issue.

### 4. Parent-Child Communication

The parent `ct-voice-input` provides the audio stream to `ct-audio-visualizer`:

```typescript
class CTVoiceInput extends BaseElement {
  private stream?: MediaStream;
  private visualizer?: CTAudioVisualizer;

  async startRecording() {
    // Get audio stream
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    // Pass stream to visualizer
    const visualizer = this.shadowRoot?.querySelector("ct-audio-visualizer");
    if (visualizer && this.showWaveform) {
      visualizer.startVisualization(this.stream);
    }

    // Setup MediaRecorder
    this.mediaRecorder = new MediaRecorder(this.stream, {
      mimeType: "audio/webm;codecs=opus",
    });

    // ... rest of recording setup
  }

  stopRecording() {
    // Stop visualizer
    const visualizer = this.shadowRoot?.querySelector("ct-audio-visualizer");
    if (visualizer) {
      visualizer.stopVisualization();
    }

    // Stop recording
    if (this.mediaRecorder) {
      this.mediaRecorder.stop();
    }

    // Stop stream
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
    }
  }
}
```

## Usage in Patterns

### Basic Usage: Simple Transcription

```typescript
/// <cts-enable />
import { Cell, Default, NAME, pattern, UI } from "commontools";

interface Input {
  transcription: Cell<Default<TranscriptionData, null>>;
}

export default pattern<Input>(({ transcription }) => {
  return {
    [NAME]: "Voice Note",
    [UI]: (
      <div>
        <ct-voice-input
          $transcription={transcription}
          recordingMode="hold"
        />

        {transcription && (
          <div style={{ marginTop: "1rem" }}>
            <strong>Transcription:</strong>
            <p>{transcription.text}</p>
            <small>Duration: {transcription.duration}s</small>
          </div>
        )}
      </div>
    ),
    transcription,
  };
});
```

### Advanced Usage: Multiple Recordings

```typescript
interface VoiceNote {
  id: string;
  text: string;
  timestamp: number;
  duration: number;
}

interface Input {
  notes: Cell<Default<VoiceNote[], []>>;
}

export default pattern<Input>(({ notes }) => {
  const currentRecording = Cell.of<TranscriptionData | null>(null);

  // Handler to save recording to notes list
  const saveRecording = handler<
    { detail: { transcription: TranscriptionData } },
    {
      notes: Cell<VoiceNote[]>;
      currentRecording: Cell<TranscriptionData | null>;
    }
  >(
    (event, { notes, currentRecording }) => {
      const transcription = event.detail.transcription;

      notes.push({
        id: transcription.id,
        text: transcription.text,
        timestamp: transcription.timestamp,
        duration: transcription.duration,
      });

      // Clear current recording
      currentRecording.set(null);
    },
  );

  return {
    [NAME]: "Voice Notes",
    [UI]: (
      <div>
        <ct-voice-input
          $transcription={currentRecording}
          onct-transcription-complete={saveRecording({
            notes,
            currentRecording,
          })}
        />

        <div style={{ marginTop: "2rem" }}>
          <h3>Saved Notes ({notes.length})</h3>
          {notes.map((note) => (
            <div
              style={{
                padding: "1rem",
                marginBottom: "0.5rem",
                border: "1px solid #ddd",
                borderRadius: "4px",
              }}
            >
              <p>{note.text}</p>
              <small>
                {new Date(note.timestamp).toLocaleString()}
                · {note.duration}s
              </small>
            </div>
          ))}
        </div>
      </div>
    ),
    notes,
  };
});
```

### Integration with LLM

```typescript
/// <cts-enable />
import { Cell, Default, generateText, NAME, pattern, UI } from "commontools";

interface Input {
  transcription: Cell<Default<TranscriptionData, null>>;
}

export default pattern<Input>(({ transcription }) => {
  // Generate AI response based on transcription
  const aiResponse = transcription?.text
    ? generateText({
      prompt: transcription.text,
      system:
        "You are a helpful assistant. Respond to the user's voice message.",
    })
    : null;

  return {
    [NAME]: "Voice AI Assistant",
    [UI]: (
      <div>
        <ct-voice-input
          $transcription={transcription}
        />

        {transcription && (
          <div style={{ marginTop: "1rem" }}>
            <div
              style={{
                padding: "1rem",
                backgroundColor: "#f0f9ff",
                borderRadius: "8px",
              }}
            >
              <strong>You said:</strong>
              <p>{transcription.text}</p>
            </div>

            {aiResponse && (
              <div
                style={{
                  padding: "1rem",
                  marginTop: "1rem",
                  backgroundColor: "#f0fdf4",
                  borderRadius: "8px",
                }}
              >
                <strong>AI Response:</strong>
                {aiResponse.pending
                  ? <p>Thinking...</p>
                  : aiResponse.error
                  ? <p>Error: {aiResponse.error}</p>
                  : <p>{aiResponse.result}</p>}
              </div>
            )}
          </div>
        )}
      </div>
    ),
    transcription,
  };
});
```

## Browser Compatibility

### Required APIs

- **MediaDevices.getUserMedia()** - For microphone access
- **MediaRecorder** - For audio recording
- **AudioContext** - For waveform visualization (optional)
- **Fetch API** - For transcription requests

### Supported Formats

- **Preferred**: WAV (PCM) - Best compatibility with transcription API
- **Fallback**: WebM (Opus) - Convert to WAV before sending

### Error Handling

```typescript
try {
  await navigator.mediaDevices.getUserMedia({ audio: true });
} catch (error) {
  if (error.name === "NotAllowedError") {
    // User denied permission
    this.emit("ct-error", {
      error,
      message: "Microphone permission denied",
    });
  } else if (error.name === "NotFoundError") {
    // No microphone found
    this.emit("ct-error", {
      error,
      message: "No microphone found",
    });
  } else {
    // Other error
    this.emit("ct-error", {
      error,
      message: `Failed to access microphone: ${error.message}`,
    });
  }
}
```

## Implementation Roadmap

### v1: Core Functionality (MVP)

**Goal:** Get a working voice input component with transcription

- [ ] Microphone permission handling
- [ ] Start/stop recording with MediaRecorder
- [ ] Basic button UI (hold to record)
- [ ] Audio blob collection
- [ ] Duration tracking
- [ ] API integration with `/api/ai/voice/transcribe`
- [ ] Audio format conversion (WebM → WAV)
- [ ] Cell binding with CellController
- [ ] Event emission (ct-transcription-complete, etc.)
- [ ] Basic error handling
- [ ] Simple waveform visualization (canvas OR SVG, pick one)
- [ ] Recording state indicator (recording/processing/complete)

**What can wait for v2+:**

- Sophisticated expansion animations
- Organic wave shapes
- Color morphing (gray → indigo)
- Slide gestures (trash, lock)
- Message bubble states
- Playback functionality

### v2: Visual Polish & UX Refinement

**Goal:** Make it feel delightful to use

- [ ] Discord-style expansion animation
- [ ] Organic wave shape morphing
- [ ] Color transitions (gray → indigo)
- [ ] Slide-to-delete gesture
- [ ] Slide-to-lock gesture
- [ ] "Release to Send" visual feedback
- [ ] Improved waveform visualization (if needed)
- [ ] Recording state animations
- [ ] Polished timer display
- [ ] Better pending/processing states

### v3: Advanced Features

**Goal:** Support chat and messaging use cases

- [ ] Message bubble states (X → Check → Play)
- [ ] Playback of recorded audio
- [ ] Playback progress visualization (waveform fill)
- [ ] Play/pause toggle
- [ ] Toggle recording mode (vs hold-to-record)
- [ ] Volume indicator
- [ ] Keyboard shortcuts (spacebar to record)
- [ ] Save audio data option
- [ ] Streaming transcription (if API supports it)

### v4: Component Ecosystem

**Goal:** Reusable, composable audio components

- [ ] Split out `ct-audio-visualizer` as standalone component
- [ ] `ct-audio-player` component for playback
- [ ] `ct-audio-message` component for chat bubbles
- [ ] Shared audio utilities library
- [ ] Comprehensive API for audio manipulation

## Open Questions

1. **Audio Format**: Should we always convert to WAV, or try WebM first and
   fallback?
   - **Recommendation**: Always convert to WAV (16kHz, mono) for best
     compatibility

2. **Max Duration**: What's reasonable default? (Current: 60 seconds)
   - **Consideration**: API costs, storage, UX for long recordings

3. **Waveform Style**: Should match CommonTools design system
   - **Options**: Bar chart, line graph, circular meter

4. **Cell Binding**: Single transcription vs. array of recordings?
   - **Recommendation**: Support both - `$transcription` for single,
     `$transcriptions` for array

5. **Audio Storage**: Should we include raw audio data in the cell?
   - **Pro**: Allows playback, re-transcription
   - **Con**: Large data size, storage concerns
   - **Recommendation**: Make it optional via `includeAudio` property

6. **Streaming Transcription**: Should we support progressive transcription?
   - **Not in v1**: API doesn't support streaming, adds complexity
   - **Future**: Could add if API supports WebSocket streaming

## Security Considerations

- Component runs in trusted context (not sandboxed)
- Microphone permission prompt handled by browser
- Audio data sent to CommonTools backend (not third-party)
- No PII should be logged during transcription
- Transcription cached by audio hash (privacy consideration)

## Testing Strategy

### Unit Tests

- MediaRecorder mock
- Audio format conversion
- Cell binding
- Event emission

### Integration Tests

- Real microphone recording (requires user interaction)
- Transcription API integration
- Error scenarios (no mic, denied permission, API failure)

### Manual Testing

- Test on Chrome, Firefox, Safari
- Mobile browser testing (iOS Safari, Chrome Mobile)
- Different microphone types
- Background noise handling
