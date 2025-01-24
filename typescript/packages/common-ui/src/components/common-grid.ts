import { css, html, LitElement } from "lit";
import { customElement } from "lit/decorators.js";
import { baseStyles } from "./style.ts";

@customElement("common-grid")
export class CommonHgroup extends LitElement {
  static override styles = [
    baseStyles,
    css`
    :host {
      display: block;
    }

    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--pad);
    }

    @container (width > 800px) {
      .grid {
        grid-template-columns: 1fr 1fr 1fr;
      }
    }

    @container (width > 1600px) {
      .grid {
        grid-template-columns: 1fr 1fr 1fr 1fr;
      }
    }
    `,
  ];

  override render() {
    return html`
    <hgroup class="grid">
      <slot></slot>
    </hgroup>
    `;
  }
}
