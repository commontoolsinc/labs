import { css, html, LitElement } from "lit";

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

  static override properties = {
    src: { type: String },
    alt: { type: String },
    _isLoaded: { state: true },
  };

  declare src: string;
  declare alt: string;
  declare _isLoaded: boolean;

  constructor() {
    super();
    this.src = "";
    this.alt = "";
    this._isLoaded = false;
  }

  override render() {
    const onload = () => (this._isLoaded = true);

    return html`
      <img @load=${onload} class="${
      this._isLoaded ? "img loaded" : "img"
    }" src="${this.src}" />
    `;
  }
}
globalThis.customElements.define("common-img", CommonImgElement);
