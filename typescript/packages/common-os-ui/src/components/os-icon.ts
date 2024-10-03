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
        display: block;
        width: var(--icon-size);
        height: var(--icon-size);
        color: var(--c-text);
      }

      .icon {
        display: block;
        width: var(--icon-size);
        height: var(--icon-size);
        overflow: hidden;
        user-select: none;

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
