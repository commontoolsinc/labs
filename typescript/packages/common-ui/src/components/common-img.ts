import { css, html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";

@customElement("common-img")
export class CommonImgElement extends LitElement {
  static override styles = css`
  :host {
    border-radius: var(--radius);
    display: block;
    width: 180px;
    height: 120px;
    overflow: hidden;
  }

  .img {
    display: block;
    opacity: 0;
    transition: opacity 1s ease-out;
    object-fit: cover;
    width: 100%;
    height: 100%;
  }
  
  .loaded {
    opacity: 1;
  }
  `;

  accessor src: string = "";
  accessor alt: string = "";
  private isLoaded = false;

  override render() {
    const onload = () => this.isLoaded = true;

    return html`
    <img
      @load=${onload}
      class="${this.isLoaded ? "img loaded" : "img"}"
      src="${this.src}" />
    `;
  }
}
