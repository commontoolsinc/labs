import { css, html, LitElement } from "lit";

export class XOmniLayout extends LitElement {
  static override styles = css`
    :host {
      display: grid;
      grid-template-columns: 1fr auto;
      grid-template-rows: 1fr;
      height: 100%;
      width: 100%;
    }

    .main {
      grid-column: 1;
      grid-row: 1;
      position: relative;
      overflow: auto;
    }

    .sidebar {
      grid-column: 2;
      grid-row: 1;
      position: relative;
      overflow: auto;
    }

    .fab {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 1000;
    }
  `;

  override render() {
    return html`
      <div class="main">
        <slot name="main"></slot>
      </div>
      <div class="sidebar">
        <slot name="sidebar"></slot>
      </div>
      <div class="fab">
        <slot name="fab"></slot>
      </div>
    `;
  }
}

globalThis.customElements.define("x-omni-layout", XOmniLayout);
