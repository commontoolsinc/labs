import { LitElement, html, css } from "lit";
import { customElement } from "lit/decorators.js";
import { baseStyles } from "./style.js";

@customElement("common-hgroup")
export class CommonHgroup extends LitElement {
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
    `
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