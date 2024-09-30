import { LitElement, css, html } from "lit-element";
import { customElement } from "lit/decorators.js";
import { base } from "../shared/styles.js";

@customElement("os-toolbar")
export class OsToolbar extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        --toolbar-height: calc(var(--u) * 24);
        --button-gap: calc(var(--u) * 4);
        display: block;
      }

      .toolbar {
        height: var(--toolbar-height);
        display: grid;
        grid-template-columns: auto 1fr auto;
        grid-template-areas: "start center end";
        align-items: center;
        gap: var(--gap);
        padding-left: var(--pad);
        padding-right: var(--pad);
      }

      .toolbar-start {
        grid-area: start;
        display: flex;
        gap: var(--button-gap);
        align-items: center;
        justify-content: flex-start;
      }

      .toolbar-end {
        grid-area: end;
        display: flex;
        gap: var(--button-gap);
        align-items: center;
        justify-content: flex-end;
      }

      .toolbar-center {
        grid-area: center;
        display: flex;
        gap: var(--button-gap);
        align-items: center;
        justify-content: center;
      }
    `,
  ];

  override render() {
    return html`
      <header class="toolbar">
        <div class="toolbar-start">
          <slot name="start"></slot>
        </div>
        <div class="toolbar-center">
          <slot name="center"></slot>
        </div>
        <div class="toolbar-end">
          <slot name="end"></slot>
        </div>
      </header>
    `;
  }
}
