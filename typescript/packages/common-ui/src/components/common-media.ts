import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { baseStyles } from "./style.js";

@customElement("common-media")
export class CommonMediaElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
    .media {
      display: grid;
      grid-template-columns: 80px 1fr;
      grid-template-areas: "image content";
      gap: var(--gap);
    }

    .media > .media-img {
      grid-area: image;
      overflow: hidden;
    }

    .media-img > common-img {
      background-color: var(--secondary-background);
      display: block;
      height: 80px;
      width: 80px;
      border-radius: 4px;
      overflow: hidden;
      object-fit: cover;
    }

    .media > .media-content {
      align-self: center;
      grid-area: content;
      display: flex;
      flex-direction: column;
      gap: var(--gap-sm);
    }
    `
  ];

  @property({ type: String }) src = "";

  override render() {
    return html`
    <article class="media">
      <div class="media-img">
        <common-img src="${this.src}" /></common-img>
      </div>
      <div class="media-content">
        <slot></slot>
      </div>
    </article>`;
  }
}