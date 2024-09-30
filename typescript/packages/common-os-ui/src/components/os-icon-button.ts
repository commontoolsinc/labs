import { LitElement, css, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { base } from "../shared/styles.js";

/**
 * A button with an icon inside, using the `os-icon` component.
 *
 * @element os-icon-button
 *
 * @prop {string} icon - The name of the icon to display in the button.
 * @prop {boolean} activated - toggle the button's activated state.
 */
@customElement("os-icon-button")
export class OsIconButton extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        --u-button-size: var(--u-min-touch-size);
        display: inline-block;
        width: var(--u-button-size);
        height: var(--u-button-size);
      }

      .icon-button {
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        border: 0;
        -webkit-appearance: none;
        appearance: none;
        background-color: var(--bg-3);
        border-radius: var(--u-radius);
        width: var(--u-button-size);
        height: var(--u-button-size);
        overflow: hidden;
        position: relative;

        &::before {
          content: "";
          background-color: var(--bg-scrim);
          width: var(--u-button-size);
          height: var(--u-button-size);
          top: 0;
          left: 0;
          opacity: 0;
          position: absolute;
          pointer-events: none;
        }

        &:active::before {
          opacity: 1;
        }

        :host([activated]) &::before {
          opacity: 1;
        }
      }
    `,
  ];

  @property({ type: String }) icon = "";

  override render() {
    return html`
      <button class="icon-button">
        <os-icon icon="${this.icon}"></os-icon>
      </button>
    `;
  }
}
