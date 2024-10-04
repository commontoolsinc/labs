import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { base } from "../shared/styles.js";

@customElement("os-icon")
export class OsIcon extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        --icon-size: calc(var(--u) * 6);
        --font-size: 24px;
        display: block;
        width: var(--icon-size);
        height: var(--icon-size);
        color: var(--c-text);
      }

      :host([iconsize="lg"]) {
        --icon-size: calc(var(--u) * 8);
        --font-size: 32px;
      }

      .icon {
        display: block;
        font-size: var(--font-size);
        width: var(--icon-size);
        height: var(--icon-size);
        overflow: hidden;
        user-select: none;
        text-align: center;
        line-height: var(--icon-size);

        :host([theme*="secondary"]) & {
          color: var(--c-text-2);
        }
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
