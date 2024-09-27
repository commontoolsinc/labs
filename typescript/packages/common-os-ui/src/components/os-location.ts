import { LitElement, css, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { base } from "../shared/styles.js";

@customElement("os-location")
export class OsLocation extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        /* 480px */
        display: block;
        --location-width: calc(var(--u) * 40);
        --location-height: calc(var(--u) * 8);
      }

      .location {
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--bg-3);
        border: 0;
        border-radius: calc(var(--location-height) / 2);
        width: var(--location-width);
        height: var(--location-height);
        overflow: hidden;
        padding: 0 calc(var(--u) * 4);
        position: relative;
        cursor: pointer;
      }

      .location::before {
        background-color: var(--bg-scrim);
        content: "";
        display: block;
        width: 100%;
        height: 100%;
        opacity: 0;
        position: absolute;
        pointer-events: none;
        transition: opacity 250ms ease-out;
      }

      .location:hover::before {
        opacity: 1;
      }

      .location-inner {
        font-size: var(--u-sm-size);
        line-height: var(--u-sm-size);
        text-wrap: nowrap;
        text-overflow: ellipsis;
        text-align: center;
        overflow: hidden;
      }
    `,
  ];

  @property({ type: String })
  display = "";

  override render() {
    return html`
      <div class="location">
        <div class="location-inner">${this.display}</div>
      </div>
    `;
  }
}
