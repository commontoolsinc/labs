import { LitElement, html, css } from "lit";
import { customElement } from "lit/decorators.js";
import { baseStyles } from "../style.js";

@customElement("common-vstack")
export class VstackElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
    :host {
      display: block;
    }

    .stack {
      display: flex;
      flex-direction: column;
      gap: var(--gap);
    }
    `
  ];

  override render() {
    return html`
    <div class="stack">
      <slot></slot>
    </div>`;
  }
}