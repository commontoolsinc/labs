import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { createRef, type Ref, ref } from "lit/directives/ref.js";
import { BaseElement } from "../../core/base-element.ts";
import { type CellHandle, type JSONSchema } from "@commontools/runtime-client";
import type { Schema } from "@commontools/api/schema";
import { createCellController } from "../../core/cell-controller.ts";
import { consume } from "@lit/context";
import {
  applyThemeToElement,
  type CTTheme,
  defaultTheme,
  themeContext,
} from "../theme-context.ts";
import { classMap } from "lit/directives/class-map.js";
import "../ct-audio-visualizer/ct-audio-visualizer.ts";
import type { CTAudioVisualizer } from "../ct-audio-visualizer/ct-audio-visualizer.ts";
import { convertToWav } from "../../utils/audio-conversion.ts";

// Schema for TranscriptionData
const TranscriptionDataSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    text: { type: "string" },
    chunks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          timestamp: {
            type: "array",
            items: { type: "number" },
            minItems: 2,
            maxItems: 2,
          },
          text: { type: "string" },
        },
        required: ["timestamp", "text"],
      },
    },
    audioData: { type: "string" },
    duration: { type: "number" },
    timestamp: { type: "number" },
  },
  required: ["id", "text", "duration", "timestamp"],
} as const satisfies JSONSchema;

/**
 * Recording state machine to prevent race conditions
 */
type RecordingState =
  | "idle"
  | "requesting"
  | "recording"
  | "stopping"
  | "processing";

/**
 * Timestamped segment of transcription
 */
export interface TranscriptionChunk {
  timestamp: number[]; // [start_seconds, end_seconds]
  text: string;
}

/**
 * Complete transcription data structure
 */
export interface TranscriptionData {
  id: string; // Unique ID for this recording
  text: string; // Full transcription text
  chunks?: TranscriptionChunk[]; // Timestamped segments
  audioData?: string; // Base64 audio data (optional)
  duration: number; // Recording duration in seconds
  timestamp: number; // Unix timestamp when recorded
}

// Type validation: ensure schema matches interface
type _ValidateTranscriptionData = Schema<
  typeof TranscriptionDataSchema
> extends TranscriptionData ? true : never;
const _validateTranscriptionData: _ValidateTranscriptionData = true;

/**
 * CTVoiceInput - Voice recording and transcription component
 *
 * @element ct-voice-input
 *
 * @attr {string} recordingMode - Recording mode: "hold" | "toggle" (default: "hold")
 * @attr {boolean} autoTranscribe - Automatically transcribe when recording stops (default: true)
 * @attr {number} maxDuration - Max recording duration in seconds (default: 60)
 * @attr {boolean} showWaveform - Show audio waveform visualization (default: true)
 * @attr {boolean} disabled - Disable recording (default: false)
 *
 * @fires ct-recording-start - Recording started. detail: { timestamp: number }
 * @fires ct-recording-stop - Recording stopped. detail: { duration: number, audioData: Blob }
 * @fires ct-transcription-start - Transcription request sent. detail: { id: string }
 * @fires ct-transcription-complete - Transcription received. detail: { transcription: TranscriptionData }
 * @fires ct-transcription-error - Transcription failed. detail: { error: Error, message: string }
 * @fires ct-error - General error occurred. detail: { error: Error, message: string }
 * @fires ct-change - Transcription data changed. detail: { transcription: TranscriptionData }
 *
 * @example
 * <ct-voice-input $transcription={transcription}></ct-voice-input>
 */
export class CTVoiceInput extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        box-sizing: border-box;
      }

      *,
      *::before,
      *::after {
        box-sizing: inherit;
      }

      .container {
        display: flex;
        flex-direction: column;
        gap: var(--ct-theme-spacing-normal, 0.75rem);
      }

      .recording-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 3rem;
        height: 3rem;
        border-radius: 50%;
        background-color: var(
          --ct-theme-color-surface,
          var(--ct-color-gray-100, #f3f4f6)
        );
        border: 2px solid
          var(--ct-theme-color-border, var(--ct-color-gray-300, #d1d5db));
        cursor: pointer;
        transition: all 0.2s ease;
        font-size: 1.5rem;
        user-select: none;
        /* Prevent default touch behaviors for hold-to-record */
        touch-action: none;
      }

      .recording-button:hover:not(:disabled) {
        background-color: var(
          --ct-theme-color-surface-hover,
          var(--ct-color-gray-200, #e5e7eb)
        );
        transform: scale(1.05);
      }

      .recording-button:active:not(:disabled) {
        transform: scale(0.95);
      }

      .recording-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .recording-button.recording {
        background-color: var(
          --ct-theme-color-error,
          var(--ct-color-red-500, #ef4444)
        );
        border-color: var(
          --ct-theme-color-error,
          var(--ct-color-red-600, #dc2626)
        );
        animation: pulse 1.5s ease-in-out infinite;
      }

      @keyframes pulse {
        0%,
        100% {
          opacity: 1;
        }
        50% {
          opacity: 0.7;
        }
      }

      .recording-status {
        display: flex;
        align-items: center;
        gap: var(--ct-theme-spacing-tight, 0.5rem);
        padding: var(--ct-theme-spacing-normal, 0.75rem);
        background-color: var(
          --ct-theme-color-surface,
          var(--ct-color-gray-50, #f9fafb)
        );
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius-md, 0.375rem)
        );
        font-size: 0.875rem;
        color: var(--ct-theme-color-text, var(--ct-color-gray-900, #111827));
      }

      .recording-indicator {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background-color: var(
          --ct-theme-color-error,
          var(--ct-color-red-500, #ef4444)
        );
        animation: pulse 1.5s ease-in-out infinite;
      }

      .timer {
        font-variant-numeric: tabular-nums;
        font-weight: 500;
      }

      .processing {
        display: flex;
        align-items: center;
        gap: var(--ct-theme-spacing-tight, 0.5rem);
        padding: var(--ct-theme-spacing-normal, 0.75rem);
        background-color: var(
          --ct-theme-color-surface,
          var(--ct-color-blue-50, #eff6ff)
        );
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius-md, 0.375rem)
        );
        font-size: 0.875rem;
        color: var(--ct-theme-color-text, var(--ct-color-gray-900, #111827));
      }

      .error {
        padding: var(--ct-theme-spacing-normal, 0.75rem);
        background-color: var(
          --ct-theme-color-error-surface,
          var(--ct-color-red-50, #fef2f2)
        );
        color: var(
          --ct-theme-color-error,
          var(--ct-color-red-700, #b91c1c)
        );
        border-radius: var(
          --ct-theme-border-radius,
          var(--ct-border-radius-md, 0.375rem)
        );
        font-size: 0.875rem;
      }

      .waveform-container {
        height: 40px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
    `,
  ];

  @property({ attribute: false })
  transcription:
    | CellHandle<TranscriptionData | null>
    | TranscriptionData
    | null = null;

  @property({ type: String })
  recordingMode: "hold" | "toggle" = "hold";

  @property({ type: Boolean })
  autoTranscribe = true;

  @property({ type: Number })
  maxDuration = 60;

  @property({ type: Boolean })
  showWaveform = true;

  @property({ type: Boolean })
  disabled = false;

  /**
   * Internal recording state machine - prevents race conditions
   */
  @property({ type: String })
  private _recordingState: RecordingState = "idle";

  /** Derived property for template compatibility */
  private get isRecording(): boolean {
    return this._recordingState === "recording";
  }

  /** Derived property for template compatibility */
  private get isProcessing(): boolean {
    return this._recordingState === "processing";
  }

  @property({ type: Number })
  private recordingDuration = 0;

  @property({ type: String })
  private errorMessage = "";

  @consume({ context: themeContext, subscribe: true })
  @property({ attribute: false })
  declare theme?: CTTheme;

  private _cellController = createCellController<TranscriptionData | null>(
    this,
    {
      timing: { strategy: "immediate" },
      onChange: (newValue) => {
        this.emit("ct-change", { transcription: newValue });
      },
    },
  );

  private mediaRecorder?: MediaRecorder;
  private audioChunks: Blob[] = [];
  private startTime?: number;
  private stream?: MediaStream;
  private timerInterval?: number;
  private maxDurationTimeout?: number;
  private visualizerRef: Ref<CTAudioVisualizer> = createRef();

  private _generateId(): string {
    return `voice-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  override firstUpdated(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.firstUpdated(changedProperties);
    this._updateThemeProperties();
    this._cellController.bind(this.transcription, TranscriptionDataSchema);
  }

  override updated(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.updated(changedProperties);
    if (changedProperties.has("theme")) {
      this._updateThemeProperties();
    }
  }

  override willUpdate(changedProperties: Map<string, any>) {
    super.willUpdate(changedProperties);

    if (changedProperties.has("transcription")) {
      this._cellController.bind(this.transcription, TranscriptionDataSchema);
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._cleanup();
  }

  private _updateThemeProperties() {
    const currentTheme = this.theme || defaultTheme;
    applyThemeToElement(this, currentTheme);
  }

  private _cleanup() {
    // Clear timers
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = undefined;
    }
    if (this.maxDurationTimeout) {
      clearTimeout(this.maxDurationTimeout);
      this.maxDurationTimeout = undefined;
    }

    // Stop visualizer
    const visualizer = this.visualizerRef.value;
    if (visualizer) {
      visualizer.stopVisualization();
    }

    // Stop media recorder (without triggering onstop processing)
    if (this.mediaRecorder) {
      this.mediaRecorder.onstop = null; // Prevent processing
      if (this.mediaRecorder.state !== "inactive") {
        this.mediaRecorder.stop();
      }
      this.mediaRecorder = undefined;
    }

    // Stop and release the stream
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = undefined;
    }

    // Reset state
    this.audioChunks = [];
    this._recordingState = "idle";
  }

  /** Track active pointer to prevent multi-touch issues */
  private _activePointerId: number | null = null;

  private _handlePointerDown(e: PointerEvent) {
    // Only track one pointer at a time
    if (this._activePointerId !== null) return;

    // Capture pointer to receive events even if pointer leaves element
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    this._activePointerId = e.pointerId;

    if (this.recordingMode === "hold" && !this.disabled && !this.isRecording) {
      this._startRecording();
    }
  }

  private _handlePointerUp(e: PointerEvent) {
    // Only respond to the pointer we're tracking
    if (this._activePointerId !== e.pointerId) return;

    this._activePointerId = null;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);

    if (this.recordingMode === "hold" && this.isRecording) {
      this._stopRecording();
    }
  }

  private _handlePointerCancel(e: PointerEvent) {
    // Handle cancelled pointer (e.g., system gesture)
    if (this._activePointerId !== e.pointerId) return;

    this._activePointerId = null;

    if (this.recordingMode === "hold" && this.isRecording) {
      this._stopRecording();
    }
  }

  private _handleButtonClick() {
    // Only handle click for toggle mode - hold mode uses pointer events
    if (this.recordingMode === "toggle" && !this.disabled) {
      if (this.isRecording) {
        this._stopRecording();
      } else {
        this._startRecording();
      }
    }
  }

  /**
   * Get the best supported audio MIME type for this browser
   */
  private _getSupportedMimeType(): string {
    // Prefer WebM with Opus (Chrome, Firefox, Edge)
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
      return "audio/webm;codecs=opus";
    }
    // Fallback to plain WebM
    if (MediaRecorder.isTypeSupported("audio/webm")) {
      return "audio/webm";
    }
    // Safari support: MP4 with AAC
    if (MediaRecorder.isTypeSupported("audio/mp4")) {
      return "audio/mp4";
    }
    // Last resort fallback
    return "";
  }

  private async _startRecording() {
    // Guard: only allow starting from idle state
    if (this._recordingState !== "idle") {
      console.warn(
        `Cannot start recording: current state is ${this._recordingState}`,
      );
      return;
    }

    this._recordingState = "requesting";
    this.errorMessage = "";

    try {
      // Request microphone permission
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          // Note: sampleRate constraint is often ignored by browsers
          // Actual resampling happens during WAV conversion
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      // Create MediaRecorder with cross-platform mime type
      const mimeType = this._getSupportedMimeType();
      const options: MediaRecorderOptions = mimeType ? { mimeType } : {};

      this.mediaRecorder = new MediaRecorder(this.stream, options);
      this.audioChunks = [];
      this.startTime = Date.now();
      this.recordingDuration = 0;

      // Collect audio chunks
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      // Handle recording completion - capture state for async processing
      this.mediaRecorder.onstop = () => {
        // Capture chunks and mimeType before they could be cleared
        const chunks = [...this.audioChunks];
        const recordedMimeType = this.mediaRecorder?.mimeType || mimeType ||
          "audio/webm";
        const duration = this.startTime
          ? (Date.now() - this.startTime) / 1000
          : this.recordingDuration;

        this._processRecording(chunks, recordedMimeType, duration);
      };

      // Start recording with larger timeslice to reduce blob count
      this.mediaRecorder.start(250);
      this._recordingState = "recording";

      // Wait for Lit to render the visualizer element
      await this.updateComplete;

      // Start visualizer - guard against stream being cleared
      if (this.showWaveform && this.stream) {
        const visualizer = this.visualizerRef.value;
        if (visualizer) {
          visualizer.startVisualization(this.stream);
        }
      }

      // Start timer with slightly lower frequency (250ms is enough for UI)
      this.timerInterval = setInterval(() => {
        if (this.startTime && this._recordingState === "recording") {
          this.recordingDuration = (Date.now() - this.startTime) / 1000;
        }
      }, 250);

      // Set max duration timeout
      this.maxDurationTimeout = setTimeout(() => {
        if (this._recordingState === "recording") {
          this._stopRecording();
        }
      }, this.maxDuration * 1000);

      this.emit("ct-recording-start", { timestamp: this.startTime });
    } catch (error) {
      this._recordingState = "idle";
      const errorObj = error as Error;
      this._handleError(errorObj);
    }
  }

  private _stopRecording() {
    // Guard: only allow stopping from recording state
    if (this._recordingState !== "recording") {
      return;
    }

    this._recordingState = "stopping";

    // Stop visualizer first
    const visualizer = this.visualizerRef.value;
    if (visualizer) {
      visualizer.stopVisualization();
    }

    // Clear timers before stopping recorder
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = undefined;
    }

    if (this.maxDurationTimeout) {
      clearTimeout(this.maxDurationTimeout);
      this.maxDurationTimeout = undefined;
    }

    // Stop the media recorder - this triggers onstop which calls _processRecording
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.stop();
    }

    // Stop and release the stream
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = undefined;
    }
  }

  private async _processRecording(
    chunks: Blob[],
    mimeType: string,
    duration: number,
  ) {
    // Guard: should be in stopping state (set by _stopRecording or transitioning)
    if (
      this._recordingState !== "stopping" &&
      this._recordingState !== "recording"
    ) {
      console.warn(
        `Unexpected state in _processRecording: ${this._recordingState}`,
      );
      return;
    }

    this._recordingState = "processing";

    const audioBlob = new Blob(chunks, { type: mimeType });

    this.emit("ct-recording-stop", { duration, audioData: audioBlob });

    if (this.autoTranscribe) {
      await this._transcribeAudio(audioBlob, mimeType, duration);
    }

    // Return to idle state after processing
    this._recordingState = "idle";
  }

  private async _transcribeAudio(
    audioBlob: Blob,
    originalMimeType: string,
    duration: number,
  ) {
    const id = this._generateId();
    this.emit("ct-transcription-start", { id });

    try {
      // Try to convert to WAV for best compatibility with transcription APIs
      const { blob: processedBlob, mimeType: finalMimeType } = await this
        ._convertToWav(audioBlob, originalMimeType);

      // Send to transcription API
      const response = await fetch("/api/ai/voice/transcribe", {
        method: "POST",
        headers: {
          "Content-Type": finalMimeType,
        },
        body: processedBlob,
      });

      if (!response.ok) {
        throw new Error(`Transcription failed: ${response.statusText}`);
      }

      const result = await response.json();

      // Create transcription data (without base64 audio by default to save memory)
      const transcriptionData: TranscriptionData = {
        id,
        text: result.transcription || result.text || "",
        chunks: result.chunks,
        duration,
        timestamp: Date.now(),
      };

      // Update cell via controller
      this._cellController.setValue(transcriptionData);

      this.emit("ct-transcription-complete", {
        transcription: transcriptionData,
      });
    } catch (error) {
      const errorObj = error as Error;
      this.emit("ct-transcription-error", {
        error: errorObj,
        message: errorObj.message,
      });
      this.errorMessage = `Transcription failed: ${errorObj.message}`;
    }
  }

  private async _convertToWav(
    blob: Blob,
    originalMimeType: string,
  ): Promise<{ blob: Blob; mimeType: string }> {
    try {
      // Convert to WAV format at 16kHz (optimal for transcription)
      const wavBlob = await convertToWav(blob, 16000);
      return { blob: wavBlob, mimeType: "audio/wav" };
    } catch (error) {
      console.warn(
        "Failed to convert audio to WAV, using original format:",
        error,
      );
      // Fallback to original blob with correct mimeType
      return { blob, mimeType: originalMimeType };
    }
  }

  private _handleError(error: Error) {
    let message = error.message;

    if (error.name === "NotAllowedError") {
      message = "Microphone permission denied";
    } else if (error.name === "NotFoundError") {
      message = "No microphone found";
    } else {
      message = `Failed to access microphone: ${error.message}`;
    }

    this.errorMessage = message;
    this.emit("ct-error", { error, message });
  }

  private _formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }

  override render() {
    const buttonClasses = {
      "recording-button": true,
      "recording": this.isRecording,
    };

    return html`
      <div class="container">
        <button
          class="${classMap(buttonClasses)}"
          ?disabled="${this.disabled || this.isProcessing}"
          @pointerdown="${this._handlePointerDown}"
          @pointerup="${this._handlePointerUp}"
          @pointercancel="${this._handlePointerCancel}"
          @click="${this._handleButtonClick}"
          aria-label="${this.isRecording
            ? "Stop recording"
            : "Start recording"}"
          title="${this.recordingMode === "hold"
            ? "Hold to record"
            : "Click to toggle recording"}"
        >
          ${this.isRecording ? "⏹️" : "🎤"}
        </button>

        ${this.isRecording
          ? html`
            <div class="recording-status">
              <div class="recording-indicator"></div>
              <span>Recording</span>
              <span class="timer">${this._formatDuration(
                this.recordingDuration,
              )}</span>
            </div>
            ${this.showWaveform
              ? html`
                <div class="waveform-container">
                  <ct-audio-visualizer
                    ${ref(this.visualizerRef)}
                    bars="12"
                    color="var(--ct-theme-color-primary, #3b82f6)"
                    height="40"
                  ></ct-audio-visualizer>
                </div>
              `
              : ""}
          `
          : ""} ${this.isProcessing
          ? html`
            <div class="processing">⏳ Transcribing...</div>
          `
          : ""} ${this.errorMessage
          ? html`
            <div class="error">${this.errorMessage}</div>
          `
          : ""}
      </div>
    `;
  }
}

customElements.define("ct-voice-input", CTVoiceInput);
