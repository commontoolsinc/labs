import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";

@customElement("com-typing-preview")
export class ComTypingPreview extends LitElement {
  static styles = css`
    :host {
      display: block;
      font-family: monospace;
      white-space: pre-wrap;
      overflow: hidden;
    }
  `;

  @property({ type: String })
  text: string | undefined = "";

  @property({ type: Number })
  windowSize = 40;

  @property({ type: Number })
  typingSpeed = 20;

  @property({ type: Number })
  lineBreakPause = 50;

  @state()
  private currentText = "";

  @state()
  private currentLine = 0;

  private animationFrame: number | null = null;
  private lastTimestamp = 0;

  override updated(changedProperties: Map<string, any>) {
    super.updated(changedProperties);

    if (changedProperties.has("text")) {
      this.resetAnimation();
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
    }
  }

  private resetAnimation() {
    this.currentText = "";
    this.currentLine = 0;
    this.lastTimestamp = 0;
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
    }
    this.animationFrame = requestAnimationFrame(this.#animate.bind(this));
  }

  #animate(timestamp: number) {
    if (!this.text) return;
    const lines = this.text.split("\n");
    if (this.currentLine < lines.length) {
      if (timestamp - this.lastTimestamp > this.typingSpeed) {
        const currentLineText = lines[this.currentLine];
        if (this.currentText.length < currentLineText.length) {
          this.currentText += currentLineText[this.currentText.length];
          this.lastTimestamp = timestamp;
        } else {
          // Line is complete, wait for lineBreakPause
          if (timestamp - this.lastTimestamp > this.lineBreakPause) {
            this.currentLine++;
            this.currentText = "";
            this.lastTimestamp = timestamp;
          }
        }
        this.requestUpdate();
      }
    } else {
      // All lines have been typed, stop the animation
      cancelAnimationFrame(this.animationFrame!);
      this.animationFrame = null;
      return;
    }

    this.animationFrame = requestAnimationFrame(this.#animate.bind(this));
  }

  override render() {
    const displayText = this.currentText.slice(-this.windowSize);
    return html`${displayText}`;
  }
}
