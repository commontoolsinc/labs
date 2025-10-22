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

  private _dismissTimers = new Map<string, number>();
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

    // // Ensure all notifications have IDs - if any are missing, update the Cell
    // const needsIds = notificationsArray.some((n) => !n.id);
    // if (needsIds && isCell(this.notifications)) {
    //   mutateCell(this.notifications, (cell) => {
    //     const current = cell.get();
    //     const withIds = current.map((n) =>
    //       n.id ? n : { ...n, id: this._generateId() }
    //     );
    //     cell.set(withIds);
    //   });
    //   // Will re-render with IDs
    //   return html`

    //   `;
    // }

    const visibleNotifications = notificationsArray.slice(0, this.maxToasts);

    return html`
      <div class="toast-stack" part="stack">
        ${repeat(
          visibleNotifications,
          (notification) => notification.id || this._generateId(),
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
                    notification.id || "",
                    e,
                  )}"
                @ct-action="${(e: CustomEvent) =>
                  this._handleToastAction(
                    notification.id || "",
                    e,
                  )}"
              ></ct-toast>
            `,
        )}
      </div>
    `;
  }

  /**
   * Add a new toast notification
   */
  public addToast(
    text: string,
    options?: Partial<Omit<ToastNotification, "id" | "text" | "timestamp">>,
  ): string {
    if (!this.notifications) return "";

    const id = this._generateId();
    const notification: ToastNotification = {
      id,
      text,
      timestamp: Date.now(),
      variant: options?.variant || "default",
      actionLabel: options?.actionLabel,
    };

    mutateCell(this.notifications, (cell) => {
      const current = cell.get();
      cell.set([...current, notification]);
    });

    return id;
  }

  /**
   * Remove a toast notification by ID
   */
  public removeToast(id: string): void {
    if (!this.notifications) return;

    mutateCell(this.notifications, (cell) => {
      const current = cell.get();
      cell.set(current.filter((n) => n.id !== id));
    });

    this._clearTimer(id);
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
    for (const [id] of this._dismissTimers) {
      if (!notificationsArray.some((n) => n.id === id)) {
        this._clearTimer(id);
      }
    }

    // Set timers for new notifications (only if they have IDs)
    for (const notification of notificationsArray) {
      if (notification.id && !this._dismissTimers.has(notification.id)) {
        const timer = setTimeout(() => {
          this.removeToast(notification.id);
        }, this.autoDismiss);
        this._dismissTimers.set(notification.id, timer);
      }
    }
  }

  private _clearTimer(id: string): void {
    const timer = this._dismissTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this._dismissTimers.delete(id);
    }
  }

  private _clearAllTimers(): void {
    for (const timer of this._dismissTimers.values()) {
      clearTimeout(timer);
    }
    this._dismissTimers.clear();
  }

  private _handleToastDismiss(id: string, event: CustomEvent): void {
    event.stopPropagation();
    this.removeToast(id);
    this.emit("ct-toast-dismiss", { id, ...event.detail });
  }

  private _handleToastAction(id: string, event: CustomEvent): void {
    event.stopPropagation();
    this.emit("ct-toast-action", { id, ...event.detail });
  }

  private _generateId(): string {
    return `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

globalThis.customElements.define("ct-toast-stack", CTToastStack);
