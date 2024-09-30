import { LitElement, css, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { base } from "../shared/styles.js";

@customElement("os-scene")
export class OsScene extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        /* 480px */
        --sidebar-width: calc(var(--u) * 120);
        --toolbar-height: calc(var(--u) * 24);
        --button-gap: calc(var(--u) * 4);
      }

      .scene {
        display: grid;
        grid-template-columns: 1fr 0;
        grid-template-areas: "main sidebar";
        gap: var(--u-gap);
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

      .toolbar {
        height: var(--toolbar-height);
        display: grid;
        grid-template-columns: auto 1fr auto;
        grid-template-areas: "start center end";
        align-items: center;
        gap: var(--u-gap-sm);
        padding-left: var(--u-pad);
        padding-right: var(--u-pad);
      }

      .toolbar-start {
        grid-area: start;
        display: flex;
        gap: var(--button-gap);
        align-items: center;
        justify-content: flex-start;
      }

      .toolbar-end {
        grid-area: end;
        display: flex;
        gap: var(--button-gap);
        align-items: center;
        justify-content: flex-end;
      }

      .toolbar-center {
        grid-area: center;
        display: flex;
        gap: var(--button-gap);
        align-items: center;
        justify-content: center;
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
          <nav class="scene-main-toolbar toolbar">
            <div class="toolbar-start"></div>
            <div class="toolbar-center">
              <os-location display="Location"></os-location>
            </div>
            <div class="toolbar-end">
              <os-icon-button
                @click=${onSidebarButton}
                slot="end"
                icon="menu"
                class=${classMap({
                  fade: true,
                  "fade-out": this.sidebar,
                })}
                ?activated=${this.sidebar}
              ></os-icon-button>
            </div>
          </nav>
          <div class="scene-main-main">
            <slot name="main"></slot>
          </div>
        </section>
        <aside class="scene-sidebar">
          <div class="scene-sidebar-inner">
            <nav class="scene-sidebar-toolbar toolbar">
              <div class="toolbar-end gap-sm hstack">
                <slot name="sidebar-toolbar"></slot>
                <os-icon-button
                  @click="${onSidebarButton}"
                  icon="close"
                ></os-icon-button>
              </div>
            </nav>
            <div class="scene-sidebar-main"><slot name="sidebar"></slot></div>
          </div>
        </aside>
      </div>
    `;
  }
}
