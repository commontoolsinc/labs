import { LitElement, css, html } from "lit-element";
import { customElement } from "lit/decorators.js";
import { base } from "../shared/styles.js";

@customElement("common-datatable")
export class CommonOsSidebar extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        display: flex;
        flex-direction: column;
        background-color: var(--bg-2);
        padding: var(--u-pad);
      }
    `,
  ];

  override render() {
    return html`
      <header class="toolbar">
        <div class="toolbar-start">
          <slot name="toolbar-start"></slot>
        </div>
        <div class="toolbar-end">
          <slot name="toolbar-end"></slot>
        </div>
      </header>
    `;
  }
}
