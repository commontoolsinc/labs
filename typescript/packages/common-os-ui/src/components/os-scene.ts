import { LitElement, css, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
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
        grid-template-columns: 1fr 0;
        grid-template-areas: "main sidebar";
        gap: var(--gap);
        overflow: hidden;
        justify-items: stretch;
        height: 100vh;
        transition: grid var(--dur-md) var(--ease-out-cubic);
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
        height: 100vh;
      }

      .scene-sidebar-inner {
        display: grid;
        grid-template-rows: auto 1fr;
        /* Set fixed width on inner element to prevent text reflow on
        sidebar animation. */
        width: var(--sidebar-width);
        /* Needed to correctly trigger scrolling in sidebar main */
        height: 100vh;
      }

      .scene-sidebar-main {
        overflow-x: hidden;
        overflow-y: auto;
      }

      /* Sidebar animation */
      :host([sidebar]) {
        .scene {
          grid-template-columns: 1fr var(--sidebar-width);
        }
      }

      /* Half-and-half editor mode animation */
      :host([state="split"]) {
        .scene {
          /* FIXME fr is not animatable? */
          grid-template-columns: 1fr 1fr;
        }
      }
    `,
  ];

  @property({ type: Boolean, reflect: true }) sidebar = true;

  override render() {
    const onSidebarButton = () => {
      this.sidebar = !this.sidebar;
    };

    return html`
      <div class="scene">
        <section class="scene-main">
          <os-toolbar class="scene-main-toolbar">
            <os-location slot="center" display="Location"></os-location>
            <os-icon-button
              @click="${onSidebarButton}"
              slot="end"
              icon="menu"
            ></os-icon-button>
          </os-toolbar>
          <div class="scene-main-main">
            <slot name="main"></slot>
          </div>
        </section>
        <aside class="scene-sidebar">
          <div class="scene-sidebar-inner">
            <div class="scene-sidebar-toolbar">
              <slot name="sidebar-toolbar"></slot>
            </div>
            <div class="scene-sidebar-main"><slot name="sidebar"></slot></div>
          </div>
        </aside>
      </div>
    `;
  }
}
