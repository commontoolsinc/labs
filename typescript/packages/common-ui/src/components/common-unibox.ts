import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { baseStyles } from "./style.js";
import { view } from "../hyperscript/render.js";
import { eventProps } from "../hyperscript/schema-helpers.js";

export const unibox = view("common-unibox", {
  ...eventProps(),
  id: { type: "string" },
  value: { type: "string" },
  placeholder: { type: "string" },
  label: { type: "string" },
});

@customElement("common-unibox")
export class CommonUniboxElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
      }

      .unibox {
        display: grid;
        grid-template-columns: 1fr min-content;
        column-gap: var(--gap);
      }
    `,
  ];

  @property({ type: String }) value = "";
  @property({ type: String }) placeholder = "";
  @property({ type: String }) label = "Search";

  override render() {
    return html`
      <div class="unibox">
        <common-input
          appearance="rounded"
          class="unibox-input"
          .placeholder="${this.placeholder}"
          .value="${this.value}"
        >
        </common-input>
        <common-button class="unibox-button">${this.label}</common-button>
      </div>
    `;
  }
}
