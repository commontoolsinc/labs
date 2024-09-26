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
        grid-template-areas: "content sidebar";
        gap: var(--gap);
        min-height: 100vh;
      }

      .scene-content {
        grid-area: content;
        display: flex;
        flex-direction: column;
        justify-items: stretch;
      }

      .scene-sidebar {
        background-color: var(--bg-2);
        grid-area: sidebar;
        display: flex;
        flex-direction: column;
        justify-items: stretch;
        overflow-x: hidden;
        overflow-y: auto;
      }
    `,
  ];

  override render() {
    return html`
      <div class="scene">
        <div class="scene-content">
          <slot name="content"></slot>
        </div>
        <div class="scene-sidebar">
          <slot name="sidebar"></slot>
        </div>
      </div>
    `;
  }
}
