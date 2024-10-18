import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { base } from "../shared/styles.js";

@customElement("os-avatar")
export class OsAvatar extends LitElement {
  @property({ type: String }) name = "";

  static override styles = [
    base,
    css`
      :host {
        --avatar-size: calc(var(--u) * 11);
        display: block;
        width: var(--avatar-size);
        height: var(--avatar-size);
      }

      :host([size="lg"]) {
        --avatar-size: calc(var(--u) * 14);
      }

      .avatar {
        display: flex;
        align-items: center;
        justify-content: center;
        width: var(--avatar-size);
        height: var(--avatar-size);
        border-radius: 50%;
        background-color: var(--bg-3);
        color: var(--c-text-2);
        font-size: calc(var(--avatar-size) * 0.5);
        user-select: none;
      }
    `,
  ];

  override render() {
    const firstLetter = this.name.charAt(0).toUpperCase();

    return html` <div class="avatar">${firstLetter}</div> `;
  }
}
