import { css, html, LitElement } from "lit";
import { baseStyles } from "./style.ts";

export type Todo = {
  id: string;
  checked: boolean;
  value: string;
};

export class CommonTodoCheckedEvent extends Event {
  detail: Todo;

  constructor(detail: Todo) {
    super("todo-checked", { bubbles: true, composed: true });
    this.detail = detail;
  }
}

export class CommonTodoInputEvent extends Event {
  detail: Todo;

  constructor(detail: Todo) {
    super("todo-input", { bubbles: true, composed: true });
    this.detail = detail;
  }
}

export class CommonTodoElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
      :host {
        --todo-height: 40px;
        display: block;
      }

      .todo {
        display: grid;
        grid-template-columns: min-content 1fr;
        column-gap: var(--pad);
      }

      .todo-ctl {
        display: flex;
        gap: var(--pad);
        align-items: center;
        height: var(--todo-height);
      }

      .todo-main {
        display: flex;
        flex-direction: column;
        gap: var(--pad-sm);
        min-height: var(--todo-height);
      }

      .todo-value {
        display: flex;
        flex-direction: column;
        justify-content: center;
        height: var(--todo-height);
      }

      .todo-input {
        --height: var(--todo-height);
        height: var(--todo-height);
      }

      .todo-checkbox {
        height: 24px;
        width: 24px;
      }
    `,
  ];

  static override properties = {
    checked: { type: Boolean },
    placeholder: { type: String },
    value: { type: String },
  };

  declare checked: boolean;
  declare placeholder: string;
  declare value: string;

  constructor() {
    super();
    this.checked = false;
    this.placeholder = "";
    this.value = "";
  }

  override render() {
    const oncheck = (event: Event) => {
      const checked = (event.target as HTMLInputElement).checked;
      this.checked = checked;

      this.dispatchEvent(
        new CommonTodoCheckedEvent({
          id: this.id,
          value: this.value,
          checked,
        }),
      );
    };

    const oninput = (event: Event) => {
      const value = (event.target as HTMLInputElement).value;
      this.value = value;

      this.dispatchEvent(
        new CommonTodoInputEvent({
          id: this.id,
          value: this.value,
          checked: this.checked,
        }),
      );
    };

    return html`
      <div class="todo">
        <div class="todo-ctl">
          <input
            class="todo-checkbox"
            type="checkbox"
            @change="${oncheck}"
            .checked="${this.checked}"
          />
        </div>
        <div class="todo-main">
          <div class="todo-value">
            <common-input
              class="todo-input"
              @input="${oninput}"
              .placeholder="${this.placeholder}"
              .value="${this.value}"
            >
            </common-input>
          </div>
          <slot></slot>
        </div>
      </div>
    `;
  }
}
globalThis.customElements.define("common-todo", CommonTodoElement);
