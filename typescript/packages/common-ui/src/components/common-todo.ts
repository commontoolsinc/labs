import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { baseStyles } from "./style.js";

@customElement("common-todo")
export class CommonTodoElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
    :host {
      display: block;
    }

    .todo {
      display: grid;
      grid-template-columns: min-content 1fr;
      align-items: center;
      column-gap: var(--pad);
      min-height: 40px;
    }

    .todo-ctl {
      display: flex;
      gap: var(--gap);
      align-items: center;
    }

    .todo-checkbox {
      height: 24px;
      width: 24px;
    }
    `
  ];

  @property({ type: Boolean }) checked = false;
  @property({ type: String }) placeholder = "";
  @property({ type: String }) value = "";

  override render() {
    const oncheck = (event: Event) => {
      const checked = (event.target as HTMLInputElement).checked;
      this.checked = checked;
    }

    const oninput = (event: Event) => {
      const value = (event.target as HTMLInputElement).value;
      this.value = value;
    }

    return html`
    <div class="todo">
      <div class="todo-ctl">
        <input
          class="todo-checkbox"
          type="checkbox"
          @change="${oncheck}"
          .checked="${this.checked}" />
      </div>
      <common-input
        class="unibox-input"
        @input="${oninput}"
        .placeholder="${this.placeholder}"
        .value="${this.value}">
      </common-input>
    </div>
    `;
  }
}