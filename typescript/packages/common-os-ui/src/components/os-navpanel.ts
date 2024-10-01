import { LitElement, html, css } from "lit";
import { customElement } from "lit/decorators.js";
import { base } from "../shared/styles.js";

@customElement("os-navpanel")
export class OsNavpanel extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        --panel-bg: var(--bg-2);
        --toolbar-height: calc(var(--u) * 24);
        display: block;
        width: 100%;
        height: 100%;
      }

      .navpanel {
        background-color: var(--panel-bg);
        display: grid;
        grid-template-rows: auto 1fr;
        width: 100%;
        height: 100%;
        overflow: hidden;
      }

      .navpanel-content {
        width: 100%;
        height: 100%;
        overflow-x: hidden;
        overflow-y: scroll;
      }
    `,
  ];

  override render() {
    return html`
      <div class="navpanel">
        <nav class="navpanel-toolbar toolbar pad-h">
          <div class="toolbar-start gap-sm hstack">
            <slot name="toolbar-start"></slot>
          </div>
          <div class="toolbar-end gap-sm hstack">
            <slot name="toolbar-end"></slot>
          </div>
        </nav>
        <div class="navpanel-content vstack gap pad-h">
          <slot></slot>
        </div>
      </div>
    `;
  }
}
