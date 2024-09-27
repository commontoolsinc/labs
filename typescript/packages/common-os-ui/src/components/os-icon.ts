import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { base } from "../shared/styles.js";

@customElement("os-icon")
export class OsIcon extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        display: block;
        width: 24px;
        height: 24px;
      }

      .icon {
        display: block;
        width: 24px;
        height: 24px;
        overflow: hidden;
      }
    `,
  ];

  @property({ type: String }) icon = "";

  override render() {
    return html`
      <div class="icon material-symbols-rounded">${this.icon}</div>
    `;
  }
}
