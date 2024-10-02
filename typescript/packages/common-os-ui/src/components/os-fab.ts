import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { base } from "../shared/styles.js";

@customElement("os-fabgroup")
export class OsFabgroup extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        display: block;
        width: fit-content;
        height: fit-content;
      }

      .fabgroup {
        display: flex;
        flex-direction: column;
        cursor: pointer;
        gap: var(--gap-xsm);
        align-items: end;
        overflow: hidden;
      }

      .bubbles {
        display: flex;
        flex-direction: column;
        gap: var(--gap-xsm);
        align-items: end;
      }
    `,
  ];

  override render() {
    return html`
      <div class="fabgroup material-symbols-rounded">
        <div class="bubbles">
          <slot></slot>
        </div>
        <os-fab></os-fab>
      </div>
    `;
  }
}

@customElement("os-fab")
export class OsFab extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        --fab-size: calc(var(--u) * 14);
        display: block;
        width: fit-content;
        height: fit-content;
      }

      .fab {
        background-color: var(--bg-3);
        cursor: pointer;
        display: block;
        width: var(--fab-size);
        height: var(--fab-size);
        overflow: hidden;
        border-radius: calc(var(--fab-size) / 2);
      }
    `,
  ];

  override render() {
    return html` <div class="fab material-symbols-rounded"></div> `;
  }
}

@customElement("os-bubble")
export class OsBubble extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        --height: calc(var(--u) * 11);
        display: block;
        width: fit-content;
        height: fit-content;
      }

      .bubble {
        background-color: var(--bg-3);
        width: fit-content;
        height: var(--height);
        border-radius: calc(var(--height) / 2);
        padding: 0 calc(var(--u) * 4);
      }

      .bubble-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: calc(var(--u) * 90);
      }
    `,
  ];

  @property({ type: String })
  icon = "";

  @property({ type: String })
  text = "";

  override render() {
    return html`
      <div class="bubble hstack gap-xsm material-symbols-rounded">
        <os-icon class="bubble-icon" icon="${this.icon}"></os-icon>
        <div class="bubble-text">${this.text}</div>
      </div>
    `;
  }
}
