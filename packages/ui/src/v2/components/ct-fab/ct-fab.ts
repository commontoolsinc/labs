import { css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";
import type { CellHandle } from "@commontools/runtime-client";
import { isCellHandle } from "@commontools/runtime-client";
import { fabAnimations } from "./styles.ts";
import { stringSchema } from "@commontools/runner/schemas";
// Side-effect import to ensure ct-message-beads is registered
import "../ct-message-beads/ct-message-beads.ts";

/**
 * A morphing floating action button that expands into a panel.
 *
 * @element ct-fab
 *
 * @attr {boolean} expanded - Whether the FAB is expanded (controlled state)
 * @attr {string} variant - Visual variant: "default" | "primary"
 * @attr {string} position - Screen position: "bottom-right" | "bottom-left" | "top-right" | "top-left" | "bottom-center"
 *
 * @fires ct-fab-backdrop-click - Fired when user clicks backdrop
 * @fires ct-fab-escape - Fired when user presses Escape
 *
 * @slot - Content for the expanded panel
 *
 * @csspart fab - The morphing container element
 * @csspart backdrop - The backdrop overlay
 * @csspart collapsed - The collapsed pill content container
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

      /* Give host dimensions when collapsed so slotted children
        (which lay out in the host context, not the shadow DOM)
        have a proper layout context */
      :host(:not([expanded])) {
        width: 300px;
        height: 40px;
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
      }

      .backdrop.active {
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        pointer-events: auto;
      }

      /* Position-specific backdrop masks */
      :host([position="bottom-right"]) .backdrop {
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

      :host([position="bottom-left"]) .backdrop {
        mask-image: radial-gradient(
          circle at bottom left,
          rgba(0, 0, 0, 1) 0%,
          rgba(0, 0, 0, 0.5) 40%,
          rgba(0, 0, 0, 0) 70%
        );
        -webkit-mask-image: radial-gradient(
          circle at bottom left,
          rgba(0, 0, 0, 1) 0%,
          rgba(0, 0, 0, 0.5) 40%,
          rgba(0, 0, 0, 0) 70%
        );
      }

      :host([position="top-right"]) .backdrop {
        mask-image: radial-gradient(
          circle at top right,
          rgba(0, 0, 0, 1) 0%,
          rgba(0, 0, 0, 0.5) 40%,
          rgba(0, 0, 0, 0) 70%
        );
        -webkit-mask-image: radial-gradient(
          circle at top right,
          rgba(0, 0, 0, 1) 0%,
          rgba(0, 0, 0, 0.5) 40%,
          rgba(0, 0, 0, 0) 70%
        );
      }

      :host([position="top-left"]) .backdrop {
        mask-image: radial-gradient(
          circle at top left,
          rgba(0, 0, 0, 1) 0%,
          rgba(0, 0, 0, 0.5) 40%,
          rgba(0, 0, 0, 0) 70%
        );
        -webkit-mask-image: radial-gradient(
          circle at top left,
          rgba(0, 0, 0, 1) 0%,
          rgba(0, 0, 0, 0.5) 40%,
          rgba(0, 0, 0, 0) 70%
        );
      }

      :host([position="bottom-center"]) .backdrop {
        mask-image: radial-gradient(
          circle at bottom center,
          rgba(0, 0, 0, 1) 0%,
          rgba(0, 0, 0, 0.5) 40%,
          rgba(0, 0, 0, 0) 70%
        );
        -webkit-mask-image: radial-gradient(
          circle at bottom center,
          rgba(0, 0, 0, 1) 0%,
          rgba(0, 0, 0, 0.5) 40%,
          rgba(0, 0, 0, 0) 70%
        );
      }

      /* FAB container - positioned by host */
      .fab-container {
        position: fixed;
        z-index: 999;
      }

      /* Position variants */
      :host([position="bottom-right"]) .fab-container {
        bottom: 12px;
        right: 24px;
      }

      :host([position="bottom-left"]) .fab-container {
        bottom: 12px;
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

      :host([position="bottom-center"]) .fab-container {
        bottom: 12px;
        left: 50%;
        transform: translateX(-50%);
      }

      /* Main morphing element */
      .fab {
        position: relative;
        width: 300px;
        height: 40px;
        background: var(--ct-theme-color-surface, #000);
        border-radius: 20px;
        /*box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1),
          0 4px 16px rgba(0, 0, 0, 0.08);*/
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

        /* Collapsed state */
        :host(:not([expanded])) .fab {
          border: none;
          cursor: pointer;
        }

        /* Variant: primary */
        :host([variant="primary"]) .fab {
          background: var(--ct-theme-color-primary, #3b82f6);
        }

        /* Expanded state */
        :host([expanded]) .fab {
          width: min(560px, calc(100vw - 48px));
          min-height: 80px;
          max-height: 90vh;
          height: auto;
          border-radius: 12px;
          cursor: default;
          background: var(--ct-theme-color-background, #fafafa);
          overflow: visible;
          border: 1px solid var(--ct-theme-color-border, #e5e5e5);
          box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
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

          :host([position="bottom-center"]) .fab-container {
            bottom: 12px;
            left: 50%;
            transform: translateX(-50%);
          }
        }

        /* Collapsing state - triggers content fade-out */
        :host([collapsing]) .fab {
          cursor: default;
        }

        /* FAB collapsed pill content */
        .fab-collapsed {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 0 16px;
          width: 100%;
          height: 40px;
          pointer-events: none;
          opacity: 1;
          transform: scale(1);
          transition:
            opacity calc(var(--ct-theme-animation-duration, 300ms) * 0.5) ease,
            transform var(--ct-theme-animation-duration, 300ms)
            cubic-bezier(0.34, 1.56, 0.64, 1);
          }

          .fab-placeholder {
            color: rgba(255, 255, 255, 0.5);
            font-size: 12px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }

          ct-message-beads {
            flex: 1;
            min-width: 0;
          }

          .pin-dots {
            display: inline-flex;
            gap: 3px;
            align-items: center;
            flex-shrink: 0;
          }

          .pin-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.7);
          }

          :host([expanded]) .fab-collapsed {
            display: none;
          }

          :host([collapsing]) .fab-collapsed {
            opacity: 0;
            transform: scale(0.95);
          }

          /* Preview notification */
          .preview-notification {
            position: fixed;
            bottom: 80px;
            left: 50%;
            transform: translateX(-50%);
            max-width: 400px;
            background: none;
            padding: 0;
            z-index: 998;
            animation: slideIn 300ms ease;
          }

          @keyframes slideIn {
            from {
              opacity: 0;
              transform: translateY(20px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }

          /* Panel content */
          .fab-panel {
            width: 100%;
            display: none;
            opacity: 0;
            transform: scale(0.95);
            pointer-events: none;
            transition:
              opacity calc(var(--ct-theme-animation-duration, 300ms) * 0.5) ease,
              transform calc(var(--ct-theme-animation-duration, 300ms) * 0.5)
              cubic-bezier(0.34, 1.56, 0.64, 1);
            }

            :host([expanded]) .fab-panel {
              display: block;
              opacity: 1;
              transform: scale(1);
              pointer-events: auto;
              transition-delay: calc(var(--ct-theme-animation-duration, 300ms) * 0.3);
            }

            :host([collapsing]) .fab-panel {
              display: block;
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
          previewMessage: { type: Object, attribute: false },
          pending: { type: Boolean, reflect: true },
          messages: { type: Object, attribute: false },
          placeholderText: { type: String, attribute: "placeholder" },
          pinCount: { type: Number, attribute: false },
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
          | "top-left"
          | "bottom-center";

        /**
         * Latest message to show as preview notification
         */
        @property({ type: Object, attribute: false })
        declare previewMessage: CellHandle<string> | string | undefined;

        // The resolved value from `previewMessage`
        @state()
        _resolvedPreviewMessage: string | undefined;

        /**
         * Whether the FAB is in pending/loading state
         */
        @property({ type: Boolean, reflect: true })
        declare pending: boolean;

        /**
         * Messages cell handle for beads display in collapsed state
         */
        @property({ type: Object, attribute: false })
        declare messages: CellHandle | undefined;

        /**
         * Placeholder text shown in collapsed state when no messages
         */
        @property({ type: String, attribute: "placeholder" })
        declare placeholderText: string;

        /**
         * Number of pinned items to show as dots in collapsed state
         */
        @property({ type: Number, attribute: false })
        declare pinCount: number;

        /**
         * Internal collapsing state for animation timing
         */
        @state()
        private collapsing = false;

        @state()
        private showPreview = false;

        private collapseTimeout: number | null = null;
        private _previewUnsubscribe: (() => void) | null = null;
        private _previewTimeout: number | null = null;

        constructor() {
          super();
          this.expanded = false;
          this.variant = "default";
          this.position = "bottom-right";
          this.pending = false;
          this.placeholderText = "Ask about anything...";
          this.pinCount = 0;
        }

        override connectedCallback() {
          super.connectedCallback();
          document.addEventListener("keydown", this._handleKeydown);
          globalThis.addEventListener("click", this._handleWindowClick, true);
        }

        override disconnectedCallback() {
          super.disconnectedCallback();
          document.removeEventListener("keydown", this._handleKeydown);
          globalThis.removeEventListener(
            "click",
            this._handleWindowClick,
            true,
          );
          if (this.collapseTimeout !== null) {
            clearTimeout(this.collapseTimeout);
          }
          if (this._previewUnsubscribe) {
            this._previewUnsubscribe();
            this._previewUnsubscribe = null;
          }
          if (this._previewTimeout !== null) {
            clearTimeout(this._previewTimeout);
          }
        }

        override updated(changedProperties: Map<string, unknown>) {
          super.updated(changedProperties);

          // Handle preview message Cell subscription
          if (changedProperties.has("previewMessage")) {
            this._resolvedPreviewMessage = undefined;
            if (this._previewUnsubscribe) {
              this._previewUnsubscribe();
              this._previewUnsubscribe = null;
            }

            if (
              this.previewMessage && isCellHandle<string>(this.previewMessage)
            ) {
              this._previewUnsubscribe = this.previewMessage
                .asSchema<string>(stringSchema)
                .subscribe(
                  (value) => {
                    this._resolvedPreviewMessage = value;
                    if (this._resolvedPreviewMessage && !this.expanded) {
                      this._showPreviewNotification();
                    }
                  },
                );
            } else if (
              this.previewMessage && typeof this.previewMessage === "string"
            ) {
              this._resolvedPreviewMessage = this.previewMessage;
              if (this.previewMessage && !this.expanded) {
                this._showPreviewNotification();
              }
            }
          }

          if (changedProperties.has("expanded")) {
            if (
              !this.expanded && changedProperties.get("expanded") === true
            ) {
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

        private _handleWindowClick = (e: MouseEvent) => {
          if (!this.expanded) return;

          // Check if click was inside the fab panel
          const fabEl = this.shadowRoot?.querySelector(".fab");
          if (!fabEl) return;

          const rect = fabEl.getBoundingClientRect();
          const inside = e.clientX >= rect.left &&
            e.clientX <= rect.right &&
            e.clientY >= rect.top &&
            e.clientY <= rect.bottom;

          if (!inside) {
            this.emit("ct-fab-backdrop-click");
          }
        };

        private _handleKeydown = (e: KeyboardEvent) => {
          if (e.key === "Escape" && this.expanded) {
            this.emit("ct-fab-escape");
          }
        };

        private _showPreviewNotification() {
          this.showPreview = true;

          // Clear any existing timeout
          if (this._previewTimeout !== null) {
            clearTimeout(this._previewTimeout);
          }

          // Hide after 5 seconds
          this._previewTimeout = setTimeout(() => {
            this.showPreview = false;
            this._previewTimeout = null;
          }, 5000) as unknown as number;
        }

        override render() {
          const previewMsg = this._resolvedPreviewMessage;
          return html`
            <!-- Backdrop visual (blur effect with mask) -->
            <div
              class="backdrop ${this.expanded ? "active" : ""}"
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
                <!-- Collapsed pill content -->
                <div class="fab-collapsed" part="collapsed">
                  <ct-logo
                    width="28"
                    height="28"
                    background-color="transparent"
                    ?loading="${this.pending}"
                  ></ct-logo>
                  ${this.pinCount > 0
                    ? html`
                      <span class="pin-dots">${Array.from(
                        { length: this.pinCount },
                        () =>
                          html`
                            <span class="pin-dot"></span>
                          `,
                      )}</span>
                    `
                    : nothing} ${this.messages
                    ? html`
                      <ct-message-beads
                        .messages="${this.messages}"
                        ?pending="${this.pending}"
                      >${this.placeholderText}</ct-message-beads>
                    `
                    : html`
                      <span class="fab-placeholder">${this
                        .placeholderText}</span>
                    `}
                </div>

                <!-- Panel content (expanded state) -->
                <div class="fab-panel" part="panel">
                  <slot></slot>
                </div>
              </div>
            </div>

            <!-- Message preview notification -->
            ${this.showPreview && !this.expanded && previewMsg
              ? html`
                <div class="preview-notification">
                  <ct-chat-message
                    role="assistant"
                    compact
                    .content="${previewMsg}"
                  />
                </div>
              `
              : nothing}
          `;
        }
      }

      if (!globalThis.customElements.get("ct-fab")) {
        globalThis.customElements.define("ct-fab", CTFab);
      }
