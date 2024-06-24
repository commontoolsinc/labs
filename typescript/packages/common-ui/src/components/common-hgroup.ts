import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { baseStyles } from "./style.js";

@customElement("common-hgroup")
export class CommonHgroup extends LitElement {
  static override styles = [
    baseStyles,
    css`
    :host {
      display: block;
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

  @property({ type: String }) heading: string = '';
  @property({ type: String }) subheading: string = '';
  
  #renderSubheading() {
    if (this.subheading === '') {
      return '';
    } else {
      return html`<p class="hgroup-subheading">${this.subheading}</p>`
    }
  }

  override render() {
    return html`
    <hgroup class="hgroup">
      <h1 class="hgroup-heading">${this.heading}</h1>
      ${this.#renderSubheading()}
    </hgroup>
    `;
  }
}