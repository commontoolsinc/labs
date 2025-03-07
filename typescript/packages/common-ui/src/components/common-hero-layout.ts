import { css, html, LitElement } from "lit";
import { baseStyles } from "./style.ts";

export class CommonHeroLayoutElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        height: 100%;
      }

      .layout {
        display: grid;
        grid-template-columns: 1fr;
        grid-template-rows: 3fr 1fr;
        grid-template-areas:
          "primary"
          "secondary";
        row-gap: var(--gap);
        height: 100%;
      }

      .layout-primary {
        grid-area: primary;
        overflow-y: auto;
      }

      .layout-secondary {
        grid-area: secondary;
        overflow-y: auto;
      }
    `,
  ];

  override render() {
    return html`
      <div class="layout">
        <div class="layout-primary">
          <slot></slot>
        </div>
        <div class="layout-secondary">
          <slot name="secondary"></slot>
        </div>
      </div>
    `;
  }
}
globalThis.customElements.define("common-hero-layout", CommonHeroLayoutElement);
