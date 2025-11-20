import { css, html, svg } from "lit";
import { property } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTAudioVisualizer - Real-time audio waveform visualization
 *
 * @element ct-audio-visualizer
 *
 * @attr {number} bars - Number of frequency bars to display (default: 8)
 * @attr {string} color - Bar color (default: 'white')
 * @attr {number} height - Visualizer height in pixels (default: 40)
 *
 * @example
 * <ct-audio-visualizer bars={12} color="#5865F2" height={48}></ct-audio-visualizer>
 */
export class CTAudioVisualizer extends BaseElement {
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

      .visualizer {
        width: 100%;
        height: 100%;
      }

      svg {
        display: block;
        width: 100%;
        height: 100%;
      }
    `,
  ];

  @property({ type: Number })
  bars = 8;

  @property({ type: String })
  color = "white";

  @property({ type: Number })
  height = 40;

  @property({ type: Array })
  private waveformData: number[] = [];

  private audioContext?: AudioContext;
  private analyser?: AnalyserNode;
  private animationFrameId?: number;
  private _stream?: MediaStream;
  private sourceNode?: MediaStreamAudioSourceNode;

  /**
   * Start visualization with an audio stream
   */
  async startVisualization(stream: MediaStream) {
    this.stopVisualization();

    this._stream = stream;

    // Reuse AudioContext if it exists and is not closed
    if (!this.audioContext || this.audioContext.state === "closed") {
      this.audioContext = new AudioContext();
    }

    this.analyser = this.audioContext.createAnalyser();
    this.sourceNode = this.audioContext.createMediaStreamSource(stream);
    this.sourceNode.connect(this.analyser);

    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.8;

    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);

    const update = () => {
      if (!this._stream || !this.analyser) return;

      this.analyser.getByteFrequencyData(dataArray);

      // Sample data at regular intervals to match bar count
      // Skip the first few bins (low frequencies that contain ambient noise)
      const barCount = this.bars;
      const skipBins = 2; // Skip first 2 frequency bins
      const usableLength = dataArray.length - skipBins;
      const step = Math.floor(usableLength / barCount);

      this.waveformData = Array.from({ length: barCount }, (_, i) => {
        const index = Math.min(skipBins + (i * step), dataArray.length - 1);
        return dataArray[index] / 255; // Normalize to 0-1
      });

      this.requestUpdate();
      this.animationFrameId = requestAnimationFrame(update);
    };

    update();
  }

  /**
   * Stop visualization and clean up resources
   */
  stopVisualization() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = undefined;
    }

    // Disconnect source node but keep AudioContext for reuse
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = undefined;
    }

    this.analyser = undefined;
    this._stream = undefined;
    this.waveformData = [];
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.stopVisualization();

    // Close AudioContext when element is removed from DOM
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = undefined;
    }
  }

  override render() {
    const barCount = this.waveformData.length || this.bars;
    const barWidth = 100 / barCount; // Percentage
    const heightPx = this.height;

    // Default to minimal bars if no data
    const data = this.waveformData.length > 0
      ? this.waveformData
      : Array(barCount).fill(0.1);

    return html`
      <div class="visualizer">
        <svg
          width="100%"
          height="${heightPx}px"
          preserveAspectRatio="none"
          viewBox="0 0 100 ${heightPx}"
        >
          ${data.map((value, i) => {
            const x = i * barWidth;
            const barHeight = Math.max(value * heightPx, 2); // Min height of 2px
            const y = heightPx - barHeight;

            return svg`
              <rect
                x="${x}%"
                y="${y}"
                width="${barWidth * 0.7}%"
                height="${barHeight}"
                fill="${this.color}"
                rx="1"
              />
            `;
          })}
        </svg>
      </div>
    `;
  }
}

customElements.define("ct-audio-visualizer", CTAudioVisualizer);
