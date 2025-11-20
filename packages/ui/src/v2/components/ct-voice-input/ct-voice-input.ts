import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";
import { type Cell } from "@commontools/runner";
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

/**
 * Timestamped segment of transcription
 */
export interface TranscriptionChunk {
  timestamp: [number, number]; // [start_seconds, end_seconds]
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
  transcription: Cell<TranscriptionData | null> | TranscriptionData | null =
    null;

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

  @property({ type: Boolean })
  private isRecording = false;

  @property({ type: Boolean })
  private isProcessing = false;

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

  private _generateId(): string {
    return `voice-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  override firstUpdated(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.firstUpdated(changedProperties);
    this._updateThemeProperties();
    this._cellController.bind(this.transcription);
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
      this._cellController.bind(this.transcription);
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
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = undefined;
    }
    if (this.maxDurationTimeout) {
      clearTimeout(this.maxDurationTimeout);
      this.maxDurationTimeout = undefined;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = undefined;
    }
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.stop();
    }
  }

  private _handleButtonMouseDown() {
    if (this.recordingMode === "hold" && !this.disabled && !this.isRecording) {
      this._startRecording();
    }
  }

  private _handleButtonMouseUp() {
    if (this.recordingMode === "hold" && this.isRecording) {
      this._stopRecording();
    }
  }

  private _handleButtonClick() {
    if (this.recordingMode === "toggle" && !this.disabled) {
      if (this.isRecording) {
        this._stopRecording();
      } else {
        this._startRecording();
      }
    }
  }

  private async _startRecording() {
    try {
      this.errorMessage = "";

      // Request microphone permission
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      // Create MediaRecorder
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      this.mediaRecorder = new MediaRecorder(this.stream, { mimeType });
      this.audioChunks = [];
      this.startTime = Date.now();
      this.recordingDuration = 0;

      // Collect audio chunks
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      // Handle recording completion
      this.mediaRecorder.onstop = () => {
        this._processRecording();
      };

      // Start recording
      this.mediaRecorder.start(100); // Collect data every 100ms
      this.isRecording = true;

      // Start visualizer
      if (this.showWaveform) {
        const visualizer = this.shadowRoot?.querySelector(
          "ct-audio-visualizer",
        ) as CTAudioVisualizer;
        if (visualizer) {
          visualizer.startVisualization(this.stream);
        }
      }

      // Start timer
      this.timerInterval = window.setInterval(() => {
        if (this.startTime) {
          this.recordingDuration = (Date.now() - this.startTime) / 1000;
        }
      }, 100);

      // Set max duration timeout
      this.maxDurationTimeout = window.setTimeout(() => {
        if (this.isRecording) {
          this._stopRecording();
        }
      }, this.maxDuration * 1000);

      this.emit("ct-recording-start", { timestamp: this.startTime });
    } catch (error) {
      const errorObj = error as Error;
      this._handleError(errorObj);
    }
  }

  private _stopRecording() {
    // Stop visualizer first
    const visualizer = this.shadowRoot?.querySelector(
      "ct-audio-visualizer",
    ) as CTAudioVisualizer;
    if (visualizer) {
      visualizer.stopVisualization();
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.stop();
    }

    this.isRecording = false;

    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = undefined;
    }

    if (this.maxDurationTimeout) {
      clearTimeout(this.maxDurationTimeout);
      this.maxDurationTimeout = undefined;
    }

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = undefined;
    }
  }

  private async _processRecording() {
    const audioBlob = new Blob(this.audioChunks, {
      type: this.mediaRecorder?.mimeType || "audio/webm",
    });
    const duration = this.startTime
      ? (Date.now() - this.startTime) / 1000
      : this.recordingDuration;

    this.emit("ct-recording-stop", { duration, audioData: audioBlob });

    if (this.autoTranscribe) {
      await this._transcribeAudio(audioBlob, duration);
    }
  }

  private async _transcribeAudio(audioBlob: Blob, duration: number) {
    const id = this._generateId();
    this.isProcessing = true;
    this.emit("ct-transcription-start", { id });

    try {
      // Convert to WAV if needed
      const wavBlob = await this._convertToWav(audioBlob);

      // Send to transcription API
      const response = await fetch("/api/ai/voice/transcribe", {
        method: "POST",
        headers: {
          "Content-Type": "audio/wav",
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
        text: result.transcription || result.text || "",
        chunks: result.chunks,
        duration,
        timestamp: Date.now(),
        // Optionally include audio data
        audioData: await this._blobToBase64(audioBlob),
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
    } finally {
      this.isProcessing = false;
    }
  }

  private async _convertToWav(blob: Blob): Promise<Blob> {
    try {
      // Convert to WAV format at 16kHz (optimal for transcription)
      return await convertToWav(blob, 16000);
    } catch (error) {
      console.warn(
        "Failed to convert audio to WAV, using original format:",
        error,
      );
      // Fallback to original blob if conversion fails
      return blob;
    }
  }

  private async _blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
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
          @mousedown="${this._handleButtonMouseDown}"
          @mouseup="${this._handleButtonMouseUp}"
          @mouseleave="${this._handleButtonMouseUp}"
          @touchstart="${this._handleButtonMouseDown}"
          @touchend="${this._handleButtonMouseUp}"
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
