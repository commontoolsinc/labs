import { LitElement, css, html } from "lit-element";
import { customElement } from "lit/decorators.js";
import { base } from "../shared/styles.js";

@customElement("os-container")
export class OsContainer extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        /* 800px */
        --u-container-width: calc(var(--u) * 200);
        display: block;
      }

      .container {
        max-width: var(--u-container-width);
        margin: 0 auto;
        padding: var(--u-pad);
      }
    `,
  ];

  override render() {
    return html`
      <div class="container">
        <slot></slot>
      </div>
    `;
  }
}
