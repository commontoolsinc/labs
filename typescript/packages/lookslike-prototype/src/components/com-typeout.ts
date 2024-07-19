import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";

@customElement("com-typeout")
export class ComTypeout extends LitElement {
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
  typingSpeed = 5;

  @property({ type: Number })
  lineBreakPause = 25;

  @state()
  private currentChar = 0;

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
    this.currentChar = 0;
    this.lastTimestamp = 0;
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
    }
    this.animationFrame = requestAnimationFrame(this.#animate.bind(this));
  }

  #animate(timestamp: number) {
    if (!this.text) return;

    if (this.currentChar < this.text.length) {
      if (timestamp - this.lastTimestamp > this.typingSpeed) {
        this.currentChar++;
        this.lastTimestamp = timestamp;
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
    const displayText = this.text?.slice(0, this.currentChar);
    return html`${displayText}`;
  }
}
