import { css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";
import { fabAnimations } from "./styles.ts";

/**
 * A morphing floating action button that expands into a panel.
 *
 * @element ct-fab
 *
 * @attr {boolean} expanded - Whether the FAB is expanded (controlled state)
 * @attr {string} variant - Visual variant: "default" | "primary"
 * @attr {string} position - Screen position: "bottom-right" | "bottom-left" | "top-right" | "top-left"
 *
 * @fires ct-fab-backdrop-click - Fired when user clicks backdrop
 * @fires ct-fab-escape - Fired when user presses Escape
 *
 * @slot icon - Content for the FAB icon (collapsed state)
 * @slot - Content for the expanded panel
 *
 * @csspart fab - The morphing container element
 * @csspart backdrop - The backdrop overlay
 * @csspart icon - The icon container
 * @csspart panel - The panel container
 */
export class CTFab extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    fabAnimations,
    css`
      :host {
        display: block;
        box-sizing: border-box;
      }

      *,
      *::before,
      *::after {
        box-sizing: inherit;
      }

      /* Backdrop overlay */
      .backdrop {
        position: fixed;
        inset: 0;
        backdrop-filter: blur(0px);
        -webkit-backdrop-filter: blur(0px);
        pointer-events: none;
        transition:
          background var(--ct-theme-animation-duration, 300ms) ease,
          backdrop-filter var(--ct-theme-animation-duration, 300ms) ease,
          -webkit-backdrop-filter var(--ct-theme-animation-duration, 300ms) ease;
        z-index: 998;
        mask-image: radial-gradient(
          circle at bottom right,
          rgba(0, 0, 0, 1) 0%,
          rgba(0, 0, 0, 0.5) 40%,
          rgba(0, 0, 0, 0) 70%
        );
        -webkit-mask-image: radial-gradient(
          circle at bottom right,
          rgba(0, 0, 0, 1) 0%,
          rgba(0, 0, 0, 0.5) 40%,
          rgba(0, 0, 0, 0) 70%
        );
      }

      .backdrop.active {
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        pointer-events: auto;
      }

      /* FAB container - positioned by host */
      .fab-container {
        position: fixed;
        z-index: 999;
      }

      /* Position variants */
      :host([position="bottom-right"]) .fab-container {
        bottom: 24px;
        right: 24px;
      }

      :host([position="bottom-left"]) .fab-container {
        bottom: 24px;
        left: 24px;
      }

      :host([position="top-right"]) .fab-container {
        top: 24px;
        right: 24px;
      }

      :host([position="top-left"]) .fab-container {
        top: 24px;
        left: 24px;
      }

      /* Main morphing element */
      .fab {
        position: relative;
        width: 56px;
        height: 56px;
        background: var(--ct-theme-color-surface, #000);
        border-radius: 50%;
        border: 1px solid var(--ct-theme-color-border, #ccc);
        /*box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1),
          0 4px 16px rgba(0, 0, 0, 0.08);*/
        cursor: pointer;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        transition:
          width var(--ct-theme-animation-duration, 400ms)
          cubic-bezier(0.34, 1.56, 0.64, 1),
          height var(--ct-theme-animation-duration, 400ms)
          cubic-bezier(0.34, 1.56, 0.64, 1),
          border-radius var(--ct-theme-animation-duration, 400ms)
          cubic-bezier(0.34, 1.56, 0.64, 1),
          background var(--ct-theme-animation-duration, 300ms) ease;
        }

        /* Variant: primary */
        :host([variant="primary"]) .fab {
          background: var(--ct-theme-color-primary, #3b82f6);
        }

        /* Expanded state */
        :host([expanded]) .fab {
          width: 400px;
          min-height: 160px;
          max-height: 600px;
          height: auto;
          border-radius: 12px;
          cursor: default;
          background: var(--ct-theme-color-background, #fafafa);
          overflow: visible;
        }

        /* Mobile responsive - don't exceed viewport */
        @media (max-width: 768px) {
          :host([expanded]) .fab {
            width: calc(100vw - 48px);
            max-width: 400px;
            max-height: calc(100vh - 48px);
          }

          :host([position="bottom-right"]) .fab-container,
          :host([position="bottom-left"]) .fab-container {
            bottom: 16px;
          }

          :host([position="bottom-right"]) .fab-container {
            right: 16px;
          }

          :host([position="bottom-left"]) .fab-container {
            left: 16px;
          }
        }

        /* Extra small screens - nearly full screen when expanded */
        @media (max-width: 480px) {
          :host([expanded]) .fab {
            width: calc(100vw - 32px);
            max-height: calc(100vh - 32px);
          }

          :host([position="bottom-right"]) .fab-container,
          :host([position="bottom-left"]) .fab-container,
          :host([position="top-right"]) .fab-container,
          :host([position="top-left"]) .fab-container {
            bottom: 12px;
            right: 12px;
            top: auto;
            left: auto;
          }
        }

        /* Collapsing state - triggers content fade-out */
        :host([collapsing]) .fab {
          cursor: default;
        }

        /* FAB icon */
        .fab-icon {
          position: absolute;
          width: 24px;
          height: 24px;
          color: white;
          display: flex;
          align-items: center;
          justify-content: center;
          pointer-events: none;
          opacity: 1;
          transform: scale(1) rotate(0deg);
          transition:
            opacity calc(var(--ct-theme-animation-duration, 300ms) * 0.5) ease,
            transform var(--ct-theme-animation-duration, 300ms)
            cubic-bezier(0.34, 1.56, 0.64, 1);
          }

          :host([expanded]) .fab-icon,
          :host([collapsing]) .fab-icon {
            opacity: 0;
            transform: scale(0.5) rotate(90deg);
          }

          /* Panel content */
          .fab-panel {
            width: 100%;
            height: 100%;
            opacity: 0;
            transform: scale(0.95);
            pointer-events: none;
            transition:
              opacity calc(var(--ct-theme-animation-duration, 300ms) * 0.5) ease,
              transform calc(var(--ct-theme-animation-duration, 300ms) * 0.5)
              cubic-bezier(0.34, 1.56, 0.64, 1);
            }

            :host([expanded]) .fab-panel {
              opacity: 1;
              transform: scale(1);
              pointer-events: auto;
              transition-delay: calc(var(--ct-theme-animation-duration, 300ms) * 0.3);
            }

            :host([collapsing]) .fab-panel {
              opacity: 0;
              transform: scale(0.95);
              pointer-events: none;
              transition-delay: 0s;
            }

            /* ARIA */
            .fab[aria-expanded="false"] {
              cursor: pointer;
            }
          `,
        ];

        static override properties = {
          expanded: { type: Boolean, reflect: true },
          variant: { type: String, reflect: true },
          position: { type: String, reflect: true },
        };

        /**
         * Whether the FAB is expanded (controlled by parent)
         */
        @property({ type: Boolean, reflect: true })
        declare expanded: boolean;

        /**
         * Visual variant
         */
        @property({ type: String, reflect: true })
        declare variant: "default" | "primary";

        /**
         * Screen position
         */
        @property({ type: String, reflect: true })
        declare position:
          | "bottom-right"
          | "bottom-left"
          | "top-right"
          | "top-left";

        /**
         * Internal collapsing state for animation timing
         */
        @state()
        private collapsing = false;

        private collapseTimeout: number | null = null;

        constructor() {
          super();
          this.expanded = false;
          this.variant = "default";
          this.position = "bottom-right";
        }

        override connectedCallback() {
          super.connectedCallback();
          document.addEventListener("keydown", this._handleKeydown);
        }

        override disconnectedCallback() {
          super.disconnectedCallback();
          document.removeEventListener("keydown", this._handleKeydown);
          if (this.collapseTimeout !== null) {
            clearTimeout(this.collapseTimeout);
          }
        }

        override updated(changedProperties: Map<string, unknown>) {
          super.updated(changedProperties);

          if (changedProperties.has("expanded")) {
            if (!this.expanded && changedProperties.get("expanded") === true) {
              // Started collapsing
              this.collapsing = true;
              this.toggleAttribute("collapsing", true);

              // Clear any existing timeout
              if (this.collapseTimeout !== null) {
                clearTimeout(this.collapseTimeout);
              }

              // Reset collapsing state after animation completes
              this.collapseTimeout = setTimeout(() => {
                this.collapsing = false;
                this.toggleAttribute("collapsing", false);
                this.collapseTimeout = null;
              }, 400) as unknown as number;
            } else if (this.expanded) {
              // Expanding - clear collapsing state immediately
              this.collapsing = false;
              this.toggleAttribute("collapsing", false);
              if (this.collapseTimeout !== null) {
                clearTimeout(this.collapseTimeout);
                this.collapseTimeout = null;
              }
            }
          }
        }

        private _handleFabClick = (e: MouseEvent) => {
          // When collapsed, let the click bubble up to parent's onClick handler
          // When expanded, ignore clicks on the FAB content area
          if (this.expanded) {
            // Don't let clicks on expanded content close the FAB
            e.stopPropagation();
          }
        };

        private _handleBackdropClick = (e: MouseEvent) => {
          if (this.expanded) {
            e.stopPropagation(); // Prevent event from bubbling to host element's onClick
            this.emit("ct-fab-backdrop-click");
          }
        };

        private _handleKeydown = (e: KeyboardEvent) => {
          if (e.key === "Escape" && this.expanded) {
            this.emit("ct-fab-escape");
          }
        };

        override render() {
          return html`
            <!-- Backdrop -->
            <div
              class="backdrop ${this.expanded ? "active" : ""}"
              @click="${this._handleBackdropClick}"
              part="backdrop"
            >
            </div>

            <!-- FAB Container -->
            <div class="fab-container">
              <div
                class="fab"
                @click="${this._handleFabClick}"
                role="button"
                aria-expanded="${this.expanded}"
                aria-label="${this.expanded ? "Close" : "Open"}"
                tabindex="${this.expanded ? "-1" : "0"}"
                part="fab"
              >
                <!-- Icon (collapsed state) -->
                <div class="fab-icon" part="icon">
                  <slot name="icon">
                    <!-- Default message icon -->
                    <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                      <path
                        d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"
                      />
                    </svg>
                  </slot>
                </div>

                <!-- Panel content (expanded state) -->
                <div class="fab-panel" part="panel">
                  <slot></slot>
                </div>
              </div>
            </div>
          `;
        }
      }

      if (!globalThis.customElements.get("ct-fab")) {
        globalThis.customElements.define("ct-fab", CTFab);
      }
