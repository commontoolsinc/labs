import { LitElement, html, css } from "lit-element";
import { customElement, property } from "lit-element/decorators.js";
import { view } from "../hyperscript/render.js";
import { eventProps } from "../hyperscript/schema-helpers.js";

export const sendInput = view("common-send-input", {
  ...eventProps(),
  name: { type: "string" },
  placeholder: { type: "string" },
});

@customElement("common-send-input")
export class DatatableElement extends LitElement {
  static override styles = css`
    :host {
      display: block;
      --cell-padding: 8px;
    }

    .table {
      border-collapse: collapse;
      border: 1px solid #ddd;
      table-layout: fixed;
      min-width: 100%;
    }

    .cell {
      padding: var(--cell-padding);
      border: 1px solid #ddd;
      min-width: 12em;
      max-width: 24em;
      vertical-align: top;
    }
  `;

  @property({ type: String })
  name: string;

  @property({ type: String })
  placeholder: string;

  send(event: Event) {
    event.preventDefault();

    const inputEl = this.shadowRoot.getElementById("input") as HTMLInputElement;
    const value = inputEl.value;
    inputEl.value = "";

    console.log("send", value);
    this.dispatchEvent(
      new CustomEvent("messageSend", {
        detail: { message: value },
        bubbles: true,
        composed: true,
      })
    );
  }

  keyDown(event: KeyboardEvent) {
    if (event.key === "Enter") this.send(event);
  }

  override render() {
    return html`
      <div>
        <input
          type="text"
          id="input"
          placeholder=${this.placeholder}
          @keydown=${this.keyDown}
        />
        <button @click=${this.send}>${this.name}</button>
      </div>
    `;
  }
}
