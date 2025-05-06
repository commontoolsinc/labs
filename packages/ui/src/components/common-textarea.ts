import { css, html, LitElement } from "lit";
import { baseStyles } from "./style.ts";

export type CommonTextarea = {
  id: string;
  value: string;
};

export class CommonTextareaEvent extends Event {
  detail: CommonTextarea;

  constructor(detail: CommonTextarea) {
    super("textarea-input", { bubbles: true, composed: true });
    this.detail = detail;
  }
}

export type CommonTextareaKeydown = {
  id: string;
  key: string;
  value: string;
};

export class CommonTextareaKeydownEvent extends Event {
  detail: CommonTextareaKeydown;

  constructor(detail: CommonTextareaKeydown) {
    super("textarea-keydown", { bubbles: true, composed: true });
    this.detail = detail;
  }
}

export type CommonTextareaBlur = {
  id: string;
  value: string;
};

export class CommonTextareaBlurEvent extends Event {
  detail: CommonTextareaBlur;

  constructor(detail: CommonTextareaBlur) {
    super("textarea-blur", { bubbles: true, composed: true });
    this.detail = detail;
  }
}

export class CommonTextareaElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
      }

      .textarea-wrapper {
        display: flex;
        flex-direction: column;
      }

      .textarea {
        border: 0;
        outline: 0;
        box-sizing: border-box;
        font-size: var(--body-size);
        font-family: var(--body-font, sans-serif);
        line-height: var(--body-line, 1.5);
        width: 100%;
        min-height: calc(var(--body-line, 1.5) * 1em);
        resize: vertical;
        overflow: auto;
      }

      :host([appearance="rounded"]) .textarea {
        background-color: var(--input-background);
        border: 1px solid var(--border-color);
        border-radius: var(--radius, 8px);
        padding: 12px 16px;
      }
    `,
  ];

  static override properties = {
    value: { type: String },
    placeholder: { type: String },
    appearance: { type: String },
    rows: { type: Number },
  };

  declare value: string;
  declare placeholder: string;
  declare appearance: string;
  declare rows: number;

  constructor() {
    super();
    this.value = "";
    this.placeholder = "";
    this.appearance = "default";
    this.rows = 3;
  }

  override render() {
    const oninput = (event: Event) => {
      const value = (event.target as HTMLTextAreaElement).value;
      this.value = value;

      this.dispatchEvent(new CommonTextareaEvent({ id: this.id, value }));
    };

    const onkeydown = (event: KeyboardEvent) => {
      this.dispatchEvent(
        new CommonTextareaKeydownEvent({
          id: this.id,
          key: event.key,
          value: this.value,
        }),
      );
    };

    const onblur = () => {
      this.dispatchEvent(
        new CommonTextareaBlurEvent({ id: this.id, value: this.value }),
      );
    };

    return html`
      <div class="textarea-wrapper">
        <textarea
          class="textarea"
          @input="${oninput}"
          @keydown="${onkeydown}"
          @blur="${onblur}"
          .value="${this.value}"
          .placeholder="${this.placeholder}"
          rows="${this.rows}"
        ></textarea>
      </div>
    `;
  }
}
globalThis.customElements.define("common-textarea", CommonTextareaElement);
