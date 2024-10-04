import { LitElement, css, html } from "lit-element";
import { customElement } from "lit/decorators.js";
import { base } from "../shared/styles.js";

@customElement("os-container")
export class OsContainer extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        /* 800px + padding */
        --container-width: calc((var(--u) * 256));
        display: block;
      }

      .container {
        max-width: var(--container-width);
        margin: 0 auto;
        padding: var(--pad);
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
