import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { consume } from "@lit/context";
import { repeat } from "lit/directives/repeat.js";
import { BaseElement } from "../../core/base-element.ts";
import {
  applyThemeToElement,
  type CTTheme,
  defaultTheme,
  themeContext,
} from "../theme-context.ts";
import { type Cell, isCell } from "@commontools/runner";
import type { ToastNotification } from "../ct-toast/ct-toast.ts";
import "../ct-toast/ct-toast.ts";

/**
 * Executes a mutation on a Cell within a transaction
 */
function mutateCell<T>(cell: Cell<T>, mutator: (cell: Cell<T>) => void): void {
  const tx = cell.runtime.edit();
  mutator(cell.withTx(tx));
  tx.commit();
}

/**
 * CTToastStack - Toast notification container with configurable positioning
 * Supports Cell<ToastNotification[]> for reactive data binding
 *
 * @element ct-toast-stack
 *
 * @attr {ToastNotification[]|Cell<ToastNotification[]>} notifications - Array of toast notifications (supports both plain array and Cell)
 * @attr {string} position - Stack position: "top-right" | "top-left" | "bottom-right" | "bottom-left" | "top-center" | "bottom-center"
 * @attr {number} auto-dismiss - Auto-dismiss duration in milliseconds (0 to disable)
 * @attr {number} max-toasts - Maximum number of toasts to display at once
 *
 * @fires ct-toast-dismiss - Fired when a toast is dismissed (bubbles up from ct-toast)
 * @fires ct-toast-action - Fired when a toast action is clicked (bubbles up from ct-toast)
 *
 * @example
 * <ct-toast-stack
 *   .notifications="${notificationsCell}"
 *   position="top-right"
 *   auto-dismiss={5000}
 *   max-toasts={5}
 * ></ct-toast-stack>
 */

export type ToastPosition =
  | "top-right"
  | "top-left"
  | "bottom-right"
  | "bottom-left"
  | "top-center"
  | "bottom-center";

export class CTToastStack extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        box-sizing: border-box;
        position: fixed;
        z-index: 9999;
        pointer-events: none;
      }

      *,
      *::before,
      *::after {
        box-sizing: inherit;
      }

      .toast-stack {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        padding: 1rem;
        pointer-events: none;
      }

      .toast-stack > * {
        pointer-events: auto;
      }

      /* Position variants */
      :host([position="top-right"]) {
        top: 0;
        right: 0;
      }

      :host([position="top-left"]) {
        top: 0;
        left: 0;
      }

      :host([position="bottom-right"]) {
        bottom: 0;
        right: 0;
      }

      :host([position="bottom-left"]) {
        bottom: 0;
        left: 0;
      }

      :host([position="top-center"]) {
        top: 0;
        left: 50%;
        transform: translateX(-50%);
      }

      :host([position="bottom-center"]) {
        bottom: 0;
        left: 50%;
        transform: translateX(-50%);
      }

      /* Reverse stack order for bottom positions */
      :host([position="bottom-right"]) .toast-stack,
      :host([position="bottom-left"]) .toast-stack,
      :host([position="bottom-center"]) .toast-stack {
        flex-direction: column-reverse;
      }
    `,
  ];

  static override properties = {
    notifications: { type: Object, attribute: false },
    position: { type: String, reflect: true },
    autoDismiss: { type: Number, attribute: "auto-dismiss" },
    maxToasts: { type: Number, attribute: "max-toasts" },
    theme: { type: Object, attribute: false },
  };

  @consume({ context: themeContext, subscribe: true })
  @property({ attribute: false })
  declare theme?: CTTheme;

  @property({ attribute: false })
  declare notifications: Cell<ToastNotification[]> | null;

  @property({ type: String, reflect: true })
  declare position: ToastPosition;

  @property({ type: Number, attribute: "auto-dismiss" })
  declare autoDismiss: number;

  @property({ type: Number, attribute: "max-toasts" })
  declare maxToasts: number;

  private _dismissTimers = new Map<number, number>();
  private _unsubscribe: (() => void) | null = null;

  constructor() {
    super();
    this.notifications = null;
    this.position = "top-right";
    this.autoDismiss = 5000; // 5 seconds default
    this.maxToasts = 5;
  }

  override firstUpdated(changed: Map<string | number | symbol, unknown>) {
    super.firstUpdated(changed);
    this._updateThemeProperties();
  }

  override updated(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.updated(changedProperties);

    if (changedProperties.has("notifications")) {
      // Clean up previous subscription
      if (this._unsubscribe) {
        this._unsubscribe();
        this._unsubscribe = null;
      }

      // Subscribe to new Cell
      if (this.notifications && isCell(this.notifications)) {
        this._unsubscribe = this.notifications.sink(() => {
          this.requestUpdate();
          this._updateAutoDismissTimers();
        });
      }

      this._updateAutoDismissTimers();
    }
    if (changedProperties.has("theme")) {
      this._updateThemeProperties();
    }
  }

  private _updateThemeProperties() {
    const currentTheme = this.theme || defaultTheme;
    applyThemeToElement(this, currentTheme);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    this._clearAllTimers();
  }

  override render() {
    if (!this.notifications) {
      return html`

      `;
    }

    const notificationsArray = this.notifications.get();

    const visibleNotifications = notificationsArray.slice(0, this.maxToasts);

    return html`
      <div class="toast-stack" part="stack">
        ${repeat(
          visibleNotifications,
          (notification) => notification.timestamp,
          (notification) =>
            html`
              <ct-toast
                variant="${notification.variant || "default"}"
                text="${notification.text}"
                timestamp="${notification.timestamp}"
                action-label="${notification.actionLabel || ""}"
                dismissible
                @ct-dismiss="${(e: CustomEvent) =>
                  this._handleToastDismiss(
                    notification.timestamp,
                    e,
                  )}"
                @ct-action="${(e: CustomEvent) =>
                  this._handleToastAction(
                    notification.timestamp,
                    e,
                  )}"
              ></ct-toast>
            `,
        )}
      </div>
    `;
  }

  /**
   * Remove a toast notification by ID
   */
  public removeToast(timestamp: number): void {
    if (!this.notifications) return;

    mutateCell(this.notifications, (cell) => {
      const current = cell.get();
      cell.set(current.filter((n) => n.timestamp !== timestamp));
    });

    this._clearTimer(timestamp);
  }

  /**
   * Clear all toast notifications
   */
  public clearAll(): void {
    if (!this.notifications) return;

    mutateCell(this.notifications, (cell) => {
      cell.set([]);
    });

    this._clearAllTimers();
  }

  private _updateAutoDismissTimers(): void {
    if (this.autoDismiss <= 0 || !this.notifications) return;

    const notificationsArray = isCell(this.notifications)
      ? this.notifications.get()
      : this.notifications;

    // Clear timers for removed notifications
    for (const [timestamp] of this._dismissTimers) {
      if (!notificationsArray.some((n) => n.timestamp === timestamp)) {
        this._clearTimer(timestamp);
      }
    }

    // Set timers for new notifications (only if they have IDs)
    for (const notification of notificationsArray) {
      if (
        notification.timestamp &&
        !this._dismissTimers.has(notification.timestamp)
      ) {
        const timer = setTimeout(() => {
          this.removeToast(notification.timestamp);
        }, this.autoDismiss);
        this._dismissTimers.set(notification.timestamp, timer);
      }
    }
  }

  private _clearTimer(timestamp: number): void {
    const timer = this._dismissTimers.get(timestamp);
    if (timer) {
      clearTimeout(timer);
      this._dismissTimers.delete(timestamp);
    }
  }

  private _clearAllTimers(): void {
    for (const timer of this._dismissTimers.values()) {
      clearTimeout(timer);
    }
    this._dismissTimers.clear();
  }

  private _handleToastDismiss(timestamp: number, event: CustomEvent): void {
    event.stopPropagation();
    this.removeToast(timestamp);
    this.emit("ct-toast-dismiss", { id: timestamp, ...event.detail });
  }

  private _handleToastAction(timestamp: number, event: CustomEvent): void {
    event.stopPropagation();
    this.emit("ct-toast-action", { id: timestamp, ...event.detail });
  }
}

globalThis.customElements.define("ct-toast-stack", CTToastStack);
