import { css, html, LitElement } from "lit";
import { baseStyles } from "./style.ts";

export class CommonSystemLayoutElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        height: 100%;
        width: 100%;
      }

      .app {
        display: grid;
        height: 100%;
        width: 100%;
        grid-template-columns: 1fr;
        grid-template-rows: 1fr min-content min-content;
        grid-template-areas:
          "primary"
          "secondary"
          "search";
      }

      .app-primary {
        grid-area: primary;
        overflow-x: hidden;
        overflow-y: auto;
        container-type: size;
      }

      .app-primary-inner {
        padding: var(--pad);
      }

      .app-secondary {
        grid-area: secondary;
      }

      .app-search {
        grid-area: search;
        background-color: var(--secondary-background);
        display: block;
        padding: var(--gap);
      }
    `,
  ];

  override render() {
    return html`
      <div class="app">
        <main class="app-primary">
          <div class="app-primary-inner">
            <slot></slot>
          </div>
        </main>
        <nav class="app-secondary">
          <slot name="secondary"></slot>
        </nav>
        <nav class="app-search">
          <slot name="search"></slot>
        </nav>
      </div>
    `;
  }
}
globalThis.customElements.define(
  "common-system-layout",
  CommonSystemLayoutElement,
);
