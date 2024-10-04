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
        --button-size: var(--min-touch-size);
        display: inline-block;
        width: var(--button-size);
        height: var(--button-size);
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
        border-radius: var(--radius);
        width: var(--button-size);
        height: var(--button-size);
        overflow: hidden;
        position: relative;

        &::before {
          content: "";
          background-color: rgb(0, 0, 0 / 0);
          top: 0;
          left: 0;
          bottom: 0;
          right: 0;
          opacity: 1;
          position: absolute;
          pointer-events: none;
          transition: background var(--dur-lg) var(--ease-out-expo);
        }

        &:hover::before,
        &:active::before,
        :host([activated]) &::before {
          background-color: var(--bg-scrim);
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
