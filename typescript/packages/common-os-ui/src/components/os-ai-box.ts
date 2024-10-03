import { LitElement, html, css } from "lit";
import { customElement } from "lit/decorators.js";
import { property } from "lit/decorators.js";
import { base } from "../shared/styles.js";

@customElement("os-ai-box")
export class OsAiBox extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        --height: calc(var(--u) * 14);
        --width: calc(var(--u) * 100);
        display: block;
        height: var(--height);
      }

      .plain-input {
        background: transparent;
        box-sizing: border-box;
        -webkit-appearance: none;
        appearance: none;
        width: 100%;
        height: var(--height);
        border: 0;
        display: block;
      }

      .plain-input:focus {
        outline: 0;
        border: 0;
      }

      .ai-box {
        background: var(--bg-3);
        border-radius: calc(var(--height) / 2);
        height: var(--height);
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: calc(var(--u) * 3);
        padding: calc(var(--u) * 4) calc(var(--u) * 5);
      }
    `,
  ];

  @property({ type: String })
  value = "";

  @property({ type: String })
  placeholder = "";

  #onInput = (event: InputEvent) => {
    if (event.target != null) {
      const target = event.target as HTMLInputElement;
      this.value = target.value;
    }
  };

  override render() {
    return html`
      <div class="ai-box">
        <os-ai-icon iconsize="lg"></os-ai-icon>
        <input
          class="plain-input"
          type="text"
          value="${this.value}"
          placeholder=${this.placeholder}
          @input=${this.#onInput}
        />
        <os-icon iconsize="lg" icon="apps"></os-icon>
      </div>
    `;
  }
}
