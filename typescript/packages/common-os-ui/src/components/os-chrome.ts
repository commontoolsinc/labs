import { LitElement, PropertyValues, css, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { base } from "../shared/styles.js";
import { breakpointLg, ResponsiveElement } from "./responsive-element.js";

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
export class OsChrome extends ResponsiveElement {
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
        display: block;
        grid-template-columns: 1fr;
        justify-items: stretch;
        height: 100vh;
        position: relative;
        overflow: hidden;
        /*
        NOTE: prevents transition initial state bug. We trigger an update due to
        responsive element ResizeObserver, which sets a breakpoint class to
        work around bugs with container queries and slotted content.
        Because this class is not present during the first microtask, the
        initial property of the padding is 0, causing a transition on first
        load. However, setting display none and then block when we add the
        breakpoint class solves the issue, since the the intial value will
        not be used for animation since the element is display none.
        */
        display: none;

        &.breakpoint {
          display: block;
        }

        .chrome-main {
          transition: padding-right var(--dur-lg) var(--ease-out-expo);
          padding-right: 0;

          :host([sidebar]) .breakpoint-lg & {
            padding-right: var(--sidebar-width);
          }
        }

        .chrome-sidebar {
          background-color: var(--bg-2);
          position: absolute;
          right: 0;
          top: 0;
          height: 100vh;
          transform: translateX(var(--sidebar-width));
          transition: transform var(--dur-lg) var(--ease-out-expo);

          :host([sidebar]) & {
            transform: translateX(0);
          }

          .chrome-sidebar-inner {
            display: block;
            /* Set fixed width on inner element to prevent text reflow on
            sidebar animation. */
            width: var(--sidebar-width);
            height: 100vh;
          }
        }
      }

      /** Container for absolute elements */
      .chrome-overlay {
        position: absolute;
        left: var(--pad);
        right: var(--pad);
        top: var(--pad);
        bottom: var(--pad);
        pointer-events: none;
        z-index: 2;

        & > * {
          pointer-events: all;
        }
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

        .chrome-main-toolbar {
          height: var(--toolbar-height);
        }
      }

      /* Half-and-half editor mode animation */
      :host([state="split"]) {
        .chrome {
          /* FIXME fr is not animatable? */
          grid-template-columns: 1fr 1fr;
        }
      }

      .pin-br {
        position: absolute;
        right: 0;
        bottom: 0;
      }
    `,
  ];

  @property({ type: String }) locationtitle = "";
  @property({ type: Boolean, reflect: true }) sidebar = true;

  override render() {
    const onSidebarClose = () => {
      this.sidebar = false;
    };

    const onSidebarButton = () => {
      this.sidebar = !this.sidebar;
    };

    const classes = classMap({
      chrome: true,
      breakpoint: this.getObservedWidth() > 0,
      "breakpoint-lg": this.getObservedWidth() >= breakpointLg + 480,
    });

    return html`
      <div class="${classes}" @sidebarclose="${onSidebarClose}">
        <div class="chrome-overlay">
          <os-fabgroup class="pin-br">
            <os-bubble icon="add" text="Lorem ipsum dolor sit amet"></os-bubble>
            <os-bubble icon="note" text="Sumer et"></os-bubble>
          </os-fabgroup>
        </div>
        <section class="chrome-main">
          <nav class="chrome-main-toolbar toolbar pad-h">
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
            <slot></slot>
          </div>
        </section>
        <aside class="chrome-sidebar">
          <div class="chrome-sidebar-inner">
            <slot name="sidebar"></slot>
          </div>
        </aside>
      </div>
    `;
  }
}

export class SidebarCloseEvent extends Event {
  constructor() {
    super("sidebarclose", {
      bubbles: true,
      composed: true,
    });
  }
}

@customElement("os-sidebar-close-button")
export class OsCloseButton extends LitElement {
  static override styles = [
    css`
      :host {
        display: block;
        width: fit-content;
        height: fit-content;
      }
    `,
  ];

  override render() {
    const onClick = () => {
      this.dispatchEvent(new SidebarCloseEvent());
    };

    return html`<os-icon-button
      @click="${onClick}"
      icon="close"
    ></os-icon-button>`;
  }
}
