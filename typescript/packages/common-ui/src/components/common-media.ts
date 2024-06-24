import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { baseStyles } from "./style.js";

@customElement("common-media")
export class CommonMediaElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
    .media {
      --img-width: 80px;
      --img-height: 80px;
      display: grid;
      grid-template-columns: var(--img-width) 1fr;
      grid-template-areas: "image content";
      gap: var(--gap);
    }

    .media-has-sm {
      --img-width: 40px;
      --img-height: 40px;
    }

    .media-has-lg {
      --img-width: 180px;
      --img-height: 120px;
    }

    .media > .media-img {
      grid-area: image;
      overflow: hidden;
    }

    .media-img > common-img {
      background-color: var(--secondary-background);
      display: block;
      height: var(--img-height);
      width: var(--img-width);
      border-radius: var(--radius);
      overflow: hidden;
      object-fit: cover;
    }

    .media > .media-content {
      align-self: center;
      grid-area: content;
      display: flex;
      flex-direction: column;
      gap: var(--pad-sm);
    }
    `
  ];

  @property({ type: String }) src = "";
  @property({ type: String }) thumbsize = "md";

  #renderClassNames() {
    const classNames = ['media'];
    if (this.thumbsize === 'md' || this.thumbsize === '') {
      classNames.push('media-has-md')
    } else if (this.thumbsize === 'lg') {
      classNames.push('media-has-lg')
    } else if (this.thumbsize === 'sm') {
      classNames.push('media-has-sm')
    }
    return classNames.join(' ');
  }

  override render() {
    return html`
    <article class="${this.#renderClassNames()}">
      <div class="media-img">
        <common-img src="${this.src}" /></common-img>
      </div>
      <div class="media-content">
        <slot></slot>
      </div>
    </article>`;
  }
}