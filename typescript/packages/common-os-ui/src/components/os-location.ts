import { LitElement, css, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { base } from "../shared/styles.js";

/**
 * A custom element representing a location display.
 *
 * This element creates a rounded button-like display for showing a location.
 *
 * @element os-location
 * @property {string} locationtitle - The text to display as the location.
 */
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

        &::before {
          content: "";
          background-color: var(--bg-scrim);
          top: 0;
          left: 0;
          bottom: 0;
          right: 0;
          opacity: 0;
          position: absolute;
          pointer-events: none;
          transition: opacity var(--dur-lg) var(--ease-out-expo);
        }

        &:hover::before,
        &:active::before,
        :host([activated]) &::before {
          opacity: 1;
        }
      }

      .location-inner {
        font-size: var(--sm-size);
        line-height: var(--sm-size);
        text-wrap: nowrap;
        text-overflow: ellipsis;
        text-align: center;
        overflow: hidden;
      }
    `,
  ];

  @property({ type: String })
  locationtitle = "";

  override render() {
    return html`
      <div class="location">
        <div class="location-inner">${this.locationtitle}</div>
      </div>
    `;
  }
}
