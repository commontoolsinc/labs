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
          padding-top: calc((var(--height) - 1.2em) / 2);
          padding-bottom: calc((var(--height) - 1.2em) / 2);
          resize: none;
          line-height: 1.2em;
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
      const target = event.target as HTMLTextAreaElement;
      this.value = target.value;
    }
  };

  #onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      console.log("Enter key pressed");
      this.dispatchEvent(
        new CustomEvent("submit", {
          detail: {
            value: this.value,
            shiftKey: event.shiftKey,
          },
          bubbles: true,
        }),
      );
    }
  };

  override render() {
    return html`
      <div class="ai-box">
        <os-ai-icon iconsize="lg"></os-ai-icon>
        <textarea
          class="plain-input"
          .value="${this.value}"
          placeholder=${this.placeholder}
          @input=${this.#onInput}
          @keydown=${this.#onKeyDown}
        ></textarea>
        <os-icon iconsize="lg" icon="apps"></os-icon>
      </div>
    `;
  }
}
