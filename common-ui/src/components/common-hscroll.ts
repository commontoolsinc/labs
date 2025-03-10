import { css, html, LitElement } from "lit";
import { baseStyles } from "./style.ts";

export class CommonHscrollElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        width: 100%;
      }

      .scroll {
        overflow-x: auto;
        overflow-y: hidden;
        width: 100%;
      }

      .scroll {
        scrollbar-width: none; /* Firefox */
        -ms-overflow-style: none; /* Internet Explorer 10+ */
      }

      .scroll::-webkit-scrollbar {
        width: 0;
        height: 0;
      }

      .scroll-body {
        display: flex;
        flex-direction: row;
        flex-wrap: nowrap;
        gap: var(--pad-sm);
      }

      :host([gap="none"]) .scroll-body {
        gap: 0;
      }

      :host([gap="sm"]) .scroll-body {
        gap: var(--pad-sm);
      }

      :host([gap="md"]) .scroll-body {
        gap: var(--pad);
      }

      :host([pad="md"]) .scroll-body {
        padding: var(--pad);
      }
    `,
  ];

  override render() {
    return html`
      <div class="scroll">
        <div class="scroll-body">
          <slot></slot>
        </div>
      </div>
    `;
  }
}
globalThis.customElements.define("common-hscroll", CommonHscrollElement);
