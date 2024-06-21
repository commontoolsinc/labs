import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { baseStyles } from "./style.js";

export type CommonInput = {
  id: string;
  value: string;
}

export class CommonInputEvent extends Event {
  detail: CommonInput;

  constructor(detail: CommonInput) {
    super("common-input", { bubbles: true, composed: true });
    this.detail = detail;
  }
}

@customElement("common-input")
export class CommonInputElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
    :host {
      display: block;
      --height: 24px;
    }
    
    .input-wrapper {
      display: flex;
      flex-direction: column;
      justify-content: center;
    }

    .input {
      appearance: none;
      border: 0;
      outline: 0;
      box-sizing: border-box;
      font-size: var(--body-size);
      width: 100%;
      height: var(--height);
    }

    :host([appearance="rounded"]) .input {
      --height: 40px;
      background-color: var(--input-background);
      border-radius: calc(var(--height) / 2);
      padding: 8px 16px;
      height: var(--height);
    }
    `
  ];

  @property({ type: String }) value = "";
  @property({ type: String }) placeholder = "";
  @property({ type: String }) appearance = "default";

  override render() {
    const oninput = (event: Event) => {
      const value = (event.target as HTMLInputElement).value;
      this.value = value;

      this.dispatchEvent(
        new CommonInputEvent({ id: this.id, value })
      );
    }

    return html`
    <div class="input-wrapper">
      <input
        class="input"
        @input="${oninput}"
        .value="${this.value}"
        .placeholder="${this.placeholder}"
        type="text" />
    </div>
    `;
  }
}