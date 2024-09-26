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
        border: 0;
        width: var(--location-width);
        height: var(--location-height);
        background: var(--bg-3);
        border-radius: calc(var(--location-height) / 2);
        padding: 0 calc(var(--u) * 4);
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
