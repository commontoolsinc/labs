import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";

@customElement("common-ascii-loader")
export class CommonAsciiLoader extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: #ccc;
      font-family: monospace;
    }
    .ascii-art {
      white-space: pre;
      font-size: 16px;
      line-height: 1;
      padding: 1rem;
      user-select: none;
      pointer-events: none;
    }
  `;

  @property({ type: Number }) progress = 0;
  @state() private output: string = "";
  private A = 0;
  private B = 0;
  private intervalId?: any;

  override connectedCallback() {
    super.connectedCallback();
    this.intervalId = setInterval(() => {
      this.A += 0.07;
      this.B += 0.03;
      this.renderDonut();
    }, 50);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
  }

  private renderDonut() {
    const width = 80,
      height = 32;
    const b = new Array(width * height).fill(" ");
    const z = new Array(width * height).fill(0);
    const luminanceChars = "@$#*!=;:~-,.";

    const R1 = 1;
    const R2 = 2;
    const K2 = 7;

    const cosA = Math.cos(this.A),
      sinA = Math.sin(this.A);
    const cosB = Math.cos(this.B),
      sinB = Math.sin(this.B);

    for (let j = 0; j < 6.28; j += 0.07) {
      const cosj = Math.cos(j),
        sinj = Math.sin(j);
      for (let i = 0; i < 6.28; i += 0.02) {
        const cosi = Math.cos(i),
          sini = Math.sin(i);

        const cosj_add = cosj + 2;
        const mess = 1 / (sini * cosj_add * sinA + sinj * cosA + K2);
        const t = sini * cosj_add * cosA - sinj * sinA;

        const x = Math.floor(
          width / 2 +
            25 *
              (1 + this.progress) *
              mess *
              (cosi * cosj_add * cosB - t * sinB)
        );
        const y = Math.floor(
          height / 2 +
            10 *
              (1 + this.progress) *
              mess *
              (cosi * cosj_add * sinB + t * cosB)
        );
        const o = x + width * y;

        const luminance =
          cosi * cosj * sinB - cosj * sinA - sinj * cosA - sini * sinj * cosB;
        if (y >= 0 && y < height && x >= 0 && x < width && mess > z[o]) {
          z[o] = mess;
          b[o] =
            luminanceChars[
              Math.max(0, Math.min(11, Math.floor(8 * luminance)))
            ];
        }
      }
    }

    // Add newlines to the output
    this.output = b.reduce((acc, char, index) => {
      if (index > 0 && index % width === 0) {
        return acc + "\n" + char;
      }
      return acc + char;
    }, "");

    this.requestUpdate();
  }

  override render() {
    return html`<div class="ascii-art">${this.output}</div>`;
  }
}
