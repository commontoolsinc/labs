import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { baseStyles } from "./style.js";

@customElement("common-media")
export class CommonMediaElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
    .media-has-sm {
      --img-width: 40px;
      --img-height: 40px;
      display: grid;
      grid-template-columns: var(--img-width) 1fr;
      grid-template-areas: "image content";
      gap: var(--gap);

      & .media-img {
        width: var(--img-width);
        height: var(--img-height);
      }

      & .media-content {
        align-self: center;
      }
    }

    .media-has-md {
      --img-width: 80px;
      --img-height: 80px;
      display: grid;
      grid-template-columns: var(--img-width) 1fr;
      grid-template-areas: "image content";
      gap: var(--gap);

      & .media-img {
        width: var(--img-width);
        height: var(--img-height);
      }

      & .media-content {
        align-self: center;
      }
    }

    .media-has-lg {
      --img-width: 180px;
      --img-height: 120px;
      display: grid;
      grid-template-columns: var(--img-width) 1fr;
      grid-template-areas: "image content";
      gap: var(--gap);

      & .media-img {
        width: var(--img-width);
        height: var(--img-height);
      }

      & .media-content {
        align-self: center;
      }
    }

    .media-has-hero {
      display: grid;
      grid-template-columns: 1fr;
      grid-template-rows: auto auto;
      grid-template-areas:
        "image"
        "content";
      gap: var(--gap);

      & .media-img {
        width: auto;
        aspect-ratio: 16/9;
      }
    }

    .media > .media-media {
      grid-area: image;
      overflow: hidden;
    }

    .media > .media-content {
      grid-area: content;
      display: flex;
      flex-direction: column;
      gap: var(--pad-sm);
    }

    .media-img {
      background-color: var(--secondary-background);
      display: block;
      height: var(--img-height);
      width: var(--img-width);
    }
    `
  ];

  @property({ type: String }) src = "";
  @property({ type: String }) thumbsize = "md";

  #renderClassNames() {
    const classNames = ['media'];
    switch (this.thumbsize) {
      case 'sm':
        classNames.push('media-has-sm');
        break;
      case 'lg':
        classNames.push('media-has-lg');
        break;
      case 'hero':
        classNames.push('media-has-hero');
        break;
      default:
        classNames.push('media-has-md');
    }
    return classNames.join(' ');
  }

  override render() {
    return html`
    <article class="${this.#renderClassNames()}">
      <div class="media-media">
        <common-img class="media-img" src="${this.src}" /></common-img>
      </div>
      <div class="media-content">
        <slot></slot>
      </div>
    </article>`;
  }
}