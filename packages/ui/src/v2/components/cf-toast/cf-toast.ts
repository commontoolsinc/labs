import { css, html, nothing } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CFToast - Floating ephemeral notification component
 *
 * @element cf-toast
 *
 * @attr {string} variant - Visual style variant: "default" | "success" | "error" | "warning"
 * @attr {number} duration - Auto-dismiss timeout in ms. 0 = persistent.
 * @attr {boolean} dismissable - Show the dismiss (X) button
 * @attr {boolean} open - Controls visibility
 *
 * @slot - Default slot for notification message content
 * @slot icon - Optional leading icon (hidden when empty)
 * @slot action - Optional action button area (hidden when empty)
 *
 * @fires cf-toast-dismiss - Fired when toast is closed. Detail: { reason: "timeout" | "user" }
 * @fires cf-toast-action - Fired when the action slot area is activated. Detail: {}
 *
 * @csspart toast - Root container div (the visible pill surface)
 * @csspart icon - Icon wrapper div
 * @csspart message - Message wrapper div
 * @csspart action - Action wrapper div
 * @csspart dismiss - Dismiss button (only present when dismissable)
 */
export class CFToast extends BaseElement {
  static override styles = css`
    :host {
      display: block;
    }

    :host(:not([open])) {
      display: none;
    }

    .toast {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 0.5rem;
      padding: var(--cf-toast-padding, 0.625rem 0.875rem);
      border-radius: var(
        --cf-toast-border-radius,
        var(--cf-theme-border-radius, 0.5rem)
      );
      max-width: var(--cf-toast-max-width, 420px);
      min-width: var(--cf-toast-min-width, 240px);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
      backdrop-filter: blur(var(--cf-toast-backdrop-blur, 8px));
      font-size: 0.875rem;
      font-family: inherit;
      border: 1px solid transparent;
    }

    /* Default variant */
    :host([variant="default"]) .toast,
    :host(:not([variant])) .toast {
      background: var(
        --cf-toast-background,
        color-mix(
          in srgb,
          var(--cf-theme-color-surface, #f8fafc) 85%,
          transparent
        )
      );
      color: var(--cf-toast-color, var(--cf-theme-color-text, #0f172a));
      border-color: var(
        --cf-toast-border-color,
        var(--cf-theme-color-border, #e2e8f0)
      );
    }

    /* Success variant */
    :host([variant="success"]) .toast {
      background: var(
        --cf-toast-background,
        var(--cf-theme-color-success, #10b981)
      );
      color: var(
        --cf-toast-color,
        var(--cf-theme-color-success-foreground, #f0fdf4)
      );
      border-color: var(
        --cf-toast-border-color,
        var(--cf-theme-color-success, #10b981)
      );
    }

    /* Error variant */
    :host([variant="error"]) .toast {
      background: var(
        --cf-toast-background,
        var(--cf-theme-color-error, #dc2626)
      );
      color: var(
        --cf-toast-color,
        var(--cf-theme-color-error-foreground, #fef2f2)
      );
      border-color: var(
        --cf-toast-border-color,
        var(--cf-theme-color-error, #dc2626)
      );
    }

    /* Warning variant */
    :host([variant="warning"]) .toast {
      background: var(
        --cf-toast-background,
        var(--cf-theme-color-warning, #f59e0b)
      );
      color: var(
        --cf-toast-color,
        var(--cf-theme-color-warning-foreground, #fffbeb)
      );
      border-color: var(
        --cf-toast-border-color,
        var(--cf-theme-color-warning, #f59e0b)
      );
    }

    .icon.empty,
    .action.empty {
      display: none;
    }

    .message {
      flex: 1;
      min-width: 0;
    }

    .dismiss {
      all: unset;
      box-sizing: border-box;
      cursor: pointer;
      padding: 2px 4px;
      color: inherit;
      opacity: 0.7;
      flex-shrink: 0;
    }

    .dismiss:hover {
      opacity: 1;
    }

    @keyframes toast-in {
      from {
        transform: translateY(100%);
        opacity: 0;
      }
      to {
        transform: translateY(0);
        opacity: 1;
      }
    }

    :host([open]) .toast {
      animation: toast-in 200ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
    }

    @media (prefers-reduced-motion: reduce) {
      :host([open]) .toast {
        animation: none;
        transition: none;
      }
    }
  `;

  static override properties = {
    variant: { type: String, reflect: true },
    duration: { type: Number },
    dismissable: { type: Boolean, reflect: true },
    open: { type: Boolean, reflect: true },
    _hasIcon: { type: Boolean, state: true },
    _hasAction: { type: Boolean, state: true },
  };

  declare variant: "default" | "success" | "error" | "warning";
  declare duration: number;
  declare dismissable: boolean;
  declare open: boolean;

  declare private _hasIcon: boolean;
  declare private _hasAction: boolean;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _prevOpen = false;

  constructor() {
    super();
    this.variant = "default";
    this.duration = 5000;
    this.dismissable = false;
    this.open = false;
    this._hasIcon = false;
    this._hasAction = false;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this._updateAria();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._clearTimer();
  }

  override updated(changedProperties: Map<string, unknown>): void {
    super.updated(changedProperties);

    if (changedProperties.has("variant")) {
      this._updateAria();
    }

    if (changedProperties.has("open")) {
      if (this.open && !this._prevOpen) {
        this._startTimer();
      } else if (!this.open && this._prevOpen) {
        this._clearTimer();
      }
      this._prevOpen = this.open;
    }

    if (changedProperties.has("duration") && this.open) {
      this._startTimer();
    }
  }

  private _updateAria(): void {
    if (this.variant === "error") {
      this.setAttribute("role", "alert");
      this.setAttribute("aria-live", "assertive");
    } else {
      this.setAttribute("role", "status");
      this.setAttribute("aria-live", "polite");
    }
    this.setAttribute("aria-atomic", "true");
  }

  private _startTimer(): void {
    this._clearTimer();
    if (this.duration > 0) {
      this._timer = setTimeout(() => {
        this._timer = null;
        this.open = false;
        this.emit("cf-toast-dismiss", { reason: "timeout" });
      }, this.duration);
    }
  }

  private _clearTimer(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  private _handleDismiss = (): void => {
    this.open = false;
    this._clearTimer();
    this.emit("cf-toast-dismiss", { reason: "user" });
  };

  private _handleActionClick = (): void => {
    this.emit("cf-toast-action", {});
  };

  private _handleIconSlotChange = (e: Event): void => {
    const slot = e.target as HTMLSlotElement;
    this._hasIcon = slot.assignedNodes({ flatten: true }).length > 0;
  };

  private _handleActionSlotChange = (e: Event): void => {
    const slot = e.target as HTMLSlotElement;
    this._hasAction = slot.assignedNodes({ flatten: true }).length > 0;
  };

  override render() {
    return html`
      <div class="toast" part="toast">
        <div class="${this._hasIcon ? "icon" : "icon empty"}" part="icon">
          <slot
            name="icon"
            @slotchange="${this._handleIconSlotChange}"
          ></slot>
        </div>
        <div class="message" part="message">
          <slot></slot>
        </div>
        <div
          class="${this._hasAction ? "action" : "action empty"}"
          part="action"
          @click="${this._handleActionClick}"
        >
          <slot
            name="action"
            @slotchange="${this._handleActionSlotChange}"
          ></slot>
        </div>
        ${this.dismissable
          ? html`
            <button
              class="dismiss"
              part="dismiss"
              @click="${this._handleDismiss}"
              aria-label="Dismiss"
              type="button"
            >
              &#x2715;
            </button>
          `
          : nothing}
      </div>
    `;
  }
}

globalThis.customElements.define("cf-toast", CFToast);
