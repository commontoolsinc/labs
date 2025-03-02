import { css, html, LitElement } from "lit";
import { customElement } from "lit/decorators.ts";
import { base } from "../shared/styles.ts";

@customElement("os-navpanel")
export class OsNavpanel extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        --panel-bg: var(--bg-2);
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
      }

      .navpanel-content {
        width: 100%;
        height: 100%;
        overflow-y: scroll;
      }

      /** Add padding to bottom to make room for absolutely positioned fab */
      :host([safearea]) .navpanel-content {
        padding-bottom: calc(var(--u) * 24);
      }
    `,
  ];

  override render() {
    return html`
      <div class="navpanel">
        <nav class="navpanel-toolbar toolbar">
          <div class="toolbar-start gap-sm hstack">
            <slot name="toolbar-start"></slot>
          </div>
          <div class="toolbar-end gap-sm hstack">
            <slot name="toolbar-end"></slot>
          </div>
        </nav>
        <div class="navpanel-content vstack gap">
          <slot></slot>
        </div>
      </div>
    `;
  }
}
