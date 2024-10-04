import { LitElement, css, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { base } from "../shared/styles.js";

/**
 * Icon for a charm
 */
@customElement("os-charm-icon")
export class OsCharmIcon extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        --button-size: var(--min-touch-size);
        display: inline-block;
        width: var(--button-size);
        height: var(--button-size);
      }

      .charm-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        border: 0;
        -webkit-appearance: none;
        appearance: none;
        background-color: var(--bg-3);
        border-radius: var(--radius);
        width: var(--button-size);
        height: var(--button-size);
        overflow: hidden;
        position: relative;
      }
    `,
  ];

  @property({ type: String }) icon = "";

  override render() {
    return html`
      <button class="charm-icon">
        <os-icon icon="${this.icon}"></os-icon>
      </button>
    `;
  }
}
