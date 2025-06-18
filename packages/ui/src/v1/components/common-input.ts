import { css, html, LitElement } from "lit";
import { baseStyles } from "./style.ts";

export type CommonInput = {
  id: string;
  value: string;
};

export class CommonInputEvent extends Event {
  detail: CommonInput;

  constructor(detail: CommonInput) {
    super("common-input", { bubbles: true, composed: true });
    this.detail = detail;
  }
}

export type CommonKeydown = {
  id: string;
  key: string;
  value: string;
};

export class CommonKeydownEvent extends Event {
  detail: CommonKeydown;

  constructor(detail: CommonKeydown) {
    super("common-keydown", { bubbles: true, composed: true });
    this.detail = detail;
  }
}

export type CommonBlur = {
  id: string;
  value: string;
};

export class CommonBlurEvent extends Event {
  detail: CommonBlur;

  constructor(detail: CommonBlur) {
    super("common-blur", { bubbles: true, composed: true });
    this.detail = detail;
  }
}

export class CommonInputElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        --height: 24px;
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
        border: 1px solid var(--border-color);
        border-radius: calc(var(--height) / 2);
        padding: 8px 16px;
        height: var(--height);
      }
    `,
  ];

  static override properties = {
    value: { type: String },
    placeholder: { type: String },
    appearance: { type: String },
    customStyle: { type: String },
  };

  declare value: string;
  declare placeholder: string;
  declare appearance: string;
  declare customStyle: string;

  constructor() {
    super();
    this.value = "";
    this.placeholder = "";
    this.appearance = "default";
    this.customStyle = "";
  }

  override render() {
    const oninput = (event: Event) => {
      const value = (event.target as HTMLInputElement).value;
      this.value = value;

      this.dispatchEvent(new CommonInputEvent({ id: this.id, value }));
    };

    const onkeydown = (event: KeyboardEvent) => {
      this.dispatchEvent(
        new CommonKeydownEvent({
          id: this.id,
          key: event.key,
          value: this.value,
        }),
      );
    };

    const onblur = () => {
      this.dispatchEvent(
        new CommonBlurEvent({ id: this.id, value: this.value }),
      );
    };

    return html`
      <div class="input-wrapper">
        <input
          class="input"
          @input="${oninput}"
          @keydown="${onkeydown}"
          @blur="${onblur}"
          .value="${this.value}"
          .placeholder="${this.placeholder}"
          style="${this.customStyle}"
          type="text"
        />
      </div>
    `;
  }
}
globalThis.customElements.define("common-input", CommonInputElement);
