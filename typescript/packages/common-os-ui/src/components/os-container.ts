import { css, html, LitElement } from "lit";
import { customElement } from "lit/decorators.ts";
import { base } from "../shared/styles.ts";

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
        padding: 0 var(--pad);
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
