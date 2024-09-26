import { LitElement, css, html } from "lit-element";
import { customElement } from "lit/decorators.js";
import { base } from "../shared/styles.js";

@customElement("os-scene")
export class OsScene extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        /* 480px */
        --sidebar-width: calc(var(--u) * 120);
      }

      .scene {
        display: grid;
        grid-template-columns: 1fr var(--sidebar-width);
        grid-template-areas: "main sidebar";
        gap: var(--gap);
        overflow: hidden;
        justify-items: stretch;
        height: 100vh;
      }

      .scene-main {
        grid-area: main;
        display: flex;
        flex-direction: column;
        justify-items: stretch;
        height: 100vh;
      }

      .scene-sidebar {
        background-color: var(--bg-2);
        grid-area: sidebar;
        display: flex;
        flex-direction: column;
        justify-items: stretch;
        height: 100vh;
      }

      .scene-sidebar ::slotted(*) {
        height: 100%;
      }
    `,
  ];

  override render() {
    return html`
      <div class="scene">
        <div class="scene-main">
          <slot name="main"></slot>
        </div>
        <div class="scene-sidebar">
          <slot name="sidebar"></slot>
        </div>
      </div>
    `;
  }
}
