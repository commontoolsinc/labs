import { css, html, LitElement } from "lit";
import { baseStyles } from "./style.ts";

export type CommonAudioRecording = {
  id: string;
  blob: Blob;
  transcription?: string;
};

export class CommonAudioRecordingEvent extends Event {
  detail: CommonAudioRecording;

  constructor(detail: CommonAudioRecording) {
    super("common-audio-recording", { bubbles: true, composed: true });
    this.detail = detail;
  }
}

export class CommonAudioRecorderElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
      }

      .hidden {
        display: none;
      }

      .transcription {
        margin-top: 1rem;
        padding: 1rem;
        border: 1px solid #ddd;
        border-radius: var(--radius);
      }
    `,
  ];

  declare transcribe: boolean;
  declare url: string;

  static override properties = {
    url: { type: String },
    transcribe: { type: Boolean },
  };

  constructor() {
    super();
    this.transcribe = false;
    this.url = "/api/ai/voice/transcribe";
  }

  private mediaRecorder?: MediaRecorder;
  private audioChunks: Blob[] = [];
  private isRecording = false;

  private async runTranscription(audioBlob: Blob) {
    if (!this.transcribe || !this.url) return;

    try {
      const response = await fetch(this.url, {
        method: "POST",
        body: audioBlob,
      });
      const data = await response.json();

      this.dispatchEvent(
        new CommonAudioRecordingEvent({
          id: this.id,
          blob: audioBlob,
          transcription: data.transcription,
        }),
      );
    } catch (error) {
      console.error("Transcription error:", error);
      this.dispatchEvent(
        new CustomEvent("common-error", {
          detail: { id: this.id, error, blob: audioBlob },
        }),
      );
    }
  }

  private async startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      this.mediaRecorder = new MediaRecorder(stream);

      this.mediaRecorder.ondataavailable = (event) => {
        this.audioChunks.push(event.data);
      };

      this.mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(this.audioChunks, {
          type: "audio/wav",
        });
        this.dispatchEvent(
          new CommonAudioRecordingEvent({
            id: this.id,
            blob: audioBlob,
          }),
        );
        await this.runTranscription(audioBlob);
      };

      this.audioChunks = [];
      this.mediaRecorder.start();
      this.isRecording = true;
      this.requestUpdate();
    } catch (error) {
      console.error("Error accessing microphone:", error);
      this.dispatchEvent(new CustomEvent("common-error", { detail: error }));
    }
  }

  private stopRecording() {
    if (this.mediaRecorder) {
      this.mediaRecorder.stop();
      this.mediaRecorder.stream.getTracks().forEach((track) => track.stop());
      this.isRecording = false;
      this.requestUpdate();
    }
  }

  override render() {
    return html`
      <div @click=${this.startRecording} class=${
      this.isRecording ? "hidden" : ""
    }>
        <slot name="start">
          <button>Start Recording</button>
        </slot>
      </div>
      <div @click=${this.stopRecording} class=${
      !this.isRecording ? "hidden" : ""
    }>
        <slot name="stop">
          <button>Finish Recording</button>
        </slot>
      </div>
    `;
  }
}

globalThis.customElements.define(
  "common-audio-recorder",
  CommonAudioRecorderElement,
);
