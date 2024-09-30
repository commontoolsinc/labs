import { LitElement, css, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { base } from "../shared/styles.js";

/**
 * Custom element representing the chrome (outer structure) of the application.
 *
 * This element provides a layout with a main content area and a toggleable sidebar.
 * It includes a toolbar in both the main area and the sidebar, with customizable
 * slots for content.
 *
 * @element os-chrome
 * @property {string} locationtitle - The title to be displayed in the location bar.
 * @property {boolean} sidebar - Whether the sidebar is currently visible.
 *
 * @slot main - The main content of the application.
 * @slot sidebar - The content of the sidebar.
 * @slot sidebar-toolbar - Additional elements to be placed in the sidebar toolbar.
 */
@customElement("os-chrome")
export class OsChrome extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        /* 480px */
        --sidebar-width: calc(var(--u) * 120);
        --toolbar-height: calc(var(--u) * 24);
        --button-gap: calc(var(--u) * 4);
      }

      .chrome {
        display: grid;
        grid-template-columns: 1fr 0;
        grid-template-areas: "main sidebar";
        overflow: hidden;
        justify-items: stretch;
        height: 100vh;
        transition: grid var(--dur-md) var(--ease-out-cubic);
      }

      .chrome-main {
        grid-area: main;
        display: grid;
        grid-template-rows: auto 1fr;
        height: 100vh;

        .chrome-main-content {
          display: flex;
          flex-direction: column;
          overflow-x: hidden;
          overflow-y: auto;
        }
      }

      .chrome-sidebar {
        background-color: var(--bg-2);
        grid-area: sidebar;
        height: 100vh;

        .chrome-sidebar-inner {
          display: grid;
          grid-template-rows: auto 1fr;
          /* Set fixed width on inner element to prevent text reflow on
          sidebar animation. */
          width: var(--sidebar-width);
          /* Needed to correctly trigger scrolling in sidebar main */
          height: 100vh;
        }

        .chrome-sidebar-content {
          overflow-x: hidden;
          overflow-y: auto;
        }
      }

      /* Sidebar animation */
      :host([sidebar]) {
        .chrome {
          grid-template-columns: 1fr var(--sidebar-width);
        }
      }

      /* Half-and-half editor mode animation */
      :host([state="split"]) {
        .chrome {
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
        gap: var(--gap-sm);
        padding-left: var(--pad);
        padding-right: var(--pad);

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
      }
    `,
  ];

  @property({ type: String }) locationtitle = "";
  @property({ type: Boolean, reflect: true }) sidebar = true;

  override render() {
    const onSidebarButton = () => {
      this.sidebar = !this.sidebar;
    };

    return html`
      <div class="chrome">
        <section class="chrome-main">
          <nav class="chrome-main-toolbar toolbar">
            <div class="toolbar-start"></div>
            <div class="toolbar-center">
              <os-location locationtitle="${this.locationtitle}"></os-location>
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
          <div class="chrome-main-content">
            <slot name="main"></slot>
          </div>
        </section>
        <aside class="chrome-sidebar">
          <div class="chrome-sidebar-inner">
            <nav class="chrome-sidebar-toolbar toolbar">
              <div class="toolbar-end gap-sm hstack">
                <slot name="sidebar-toolbar"></slot>
                <os-icon-button
                  @click="${onSidebarButton}"
                  icon="close"
                ></os-icon-button>
              </div>
            </nav>
            <div class="chrome-sidebar-content">
              <slot name="sidebar"></slot>
            </div>
          </div>
        </aside>
      </div>
    `;
  }
}
