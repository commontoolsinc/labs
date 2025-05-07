import { css, html, LitElement } from "lit";
import { baseStyles } from "./style.ts";

export class CommonHgroupElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
      }

      .hgroup {
        display: flex;
        flex-direction: column;
      }

      .hgroup-heading {
        font-weight: bold;
        font-size: var(--title-size);
        line-height: var(--title-line);
        margin: 0;
      }

      .hgroup-subheading {
        font-size: var(--body-size);
        line-height: var(--body-line);
        color: var(--secondary-color);
        margin: 0;
      }
    `,
  ];

  override render() {
    return html`
      <hgroup class="hgroup">
        <div class="hgroup-heading" part="heading"><slot></slot></div>
        <div class="hgroup-subheading" part="subheading"><slot name="subheading"></slot></div>
      </hgroup>
    `;
  }
}
globalThis.customElements.define("common-hgroup", CommonHgroupElement);
