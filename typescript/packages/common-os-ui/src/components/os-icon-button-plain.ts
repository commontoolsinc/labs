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
@customElement("os-icon-button-plain")
export class OsIconButtonPlain extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        --touch-size: var(--min-touch-size);
        --disc-size: calc(var(--u) * 9);
        display: inline-block;
        width: var(--disc-size);
        height: var(--touch-size);
      }

      .icon-button {
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        border: 0;
        -webkit-appearance: none;
        appearance: none;
        width: var(--disc-size);
        height: var(--touch-size);
        overflow: hidden;
        background: transparent;

        .icon-button-inner {
          display: flex;
          align-items: center;
          justify-content: center;
          width: var(--disc-size);
          height: var(--disc-size);
          overflow: hidden;
          border-radius: calc(var(--disc-size) / 2);
          position: relative;
        }

        .icon-button-inner::before {
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

        .icon-button-inner:hover::before {
          background-color: var(--bg-scrim);
        }
      }
    `,
  ];

  @property({ type: String }) icon = "";

  override render() {
    return html`
      <button class="icon-button">
        <div class="icon-button-inner">
          <os-icon icon="${this.icon}"></os-icon>
        </div>
      </button>
    `;
  }
}
