import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { baseStyles } from "./style.js";

@customElement("common-media")
export class CommonMediaElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
    :host {
      display: block;
    }

    .media {
      --img-width: 80px;
      --img-height: 80px;

      display: grid;
      grid-template-columns: min-content 1fr;
      grid-template-areas: "image content";
      gap: var(--pad);

      & .media-img {
        width: var(--img-width);
        height: var(--img-height);
      }

      & .media-content {
        align-self: center;
      }
    }

    :host([thumbsize=sm]) > .media {
      --img-width: 40px;
      --img-height: 40px;
      display: grid;
      grid-template-columns: min-content 1fr;
      grid-template-areas: "image content";
      gap: var(--pad);

      & .media-img {
        width: var(--img-width);
        height: var(--img-height);
      }

      & .media-content {
        align-self: center;
      }
    }

    :host([thumbsize=lg]) > .media {
      --img-width: 180px;
      --img-height: 120px;
      display: grid;
      grid-template-columns: min-content 1fr;
      grid-template-areas: "image content";
      gap: var(--pad);

      & .media-img {
        width: var(--img-width);
        height: var(--img-height);
      }

      & .media-content {
        align-self: center;
      }
    }

    :host([thumbsize=hero]) .media {
      display: grid;
      grid-template-columns: 1fr;
      grid-template-rows: auto auto;
      grid-template-areas:
        "image"
        "content";
      gap: var(--pad-sm);

      & .media-img {
        width: auto;
        height: auto;
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

  override render() {
    return html`
    <article class="media">
      <div class="media-media">
        <common-img class="media-img" src="${this.src}" /></common-img>
      </div>
      <div class="media-content" part="content">
        <slot></slot>
      </div>
    </article>`;
  }
}