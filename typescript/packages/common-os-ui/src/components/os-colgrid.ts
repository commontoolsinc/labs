import { LitElement, css, html } from "lit-element";
import { customElement } from "lit/decorators.js";
import { base } from "../shared/styles.js";

@customElement("os-colgrid")
export class OsColgrid extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        display: block;
      }

      .colgrid {
        display: grid;
        gap: var(--gap);
        grid-template-columns: 1fr 1fr 1fr 1fr;
        align-items: center;
        justify-items: center;
      }
    `,
  ];

  override render() {
    return html`
      <div class="colgrid">
        <slot></slot>
      </div>
    `;
  }
}
