/**
 * ct-modal - Accessible modal dialog with mobile sheet transformation
 *
 * Supports both Cell and plain boolean for the $open property:
 * - Cell binding: Modal writes `false` on dismiss (reactive pattern)
 * - Plain boolean: Parent controls via `onct-modal-close` event (controlled pattern)
 *
 * @element ct-modal
 *
 * @attr {boolean} open - Whether the modal is visible (reflected)
 * @attr {boolean} dismissable - Allow dismiss via backdrop/Escape/X button
 * @attr {"sm"|"md"|"lg"|"full"} size - Modal width preset
 * @attr {boolean} prevent-scroll - Prevent body scroll when open
 * @attr {string} label - Accessible aria-label
 *
 * @prop {Cell<boolean>|boolean} open - Visibility state (supports both Cell and plain value)
 *
 * @fires ct-modal-open - Modal is opening
 * @fires ct-modal-close - Modal requests close (detail: { reason })
 * @fires ct-modal-opened - Open animation completed
 * @fires ct-modal-closed - Close animation completed
 *
 * @slot - Main content
 * @slot header - Header content
 * @slot footer - Footer content (buttons)
 * @slot close-button - Custom close button
 *
 * @csspart backdrop - Backdrop overlay
 * @csspart container - Centering container
 * @csspart dialog - Modal dialog
 * @csspart header - Header wrapper
 * @csspart content - Content wrapper
 * @csspart footer - Footer wrapper
 * @csspart close-button - Dismiss button
 *
 * @example
 * ```html
 * <!-- Cell binding (reactive) -->
 * <ct-modal $open={isModalOpen} dismissable>
 *   <span slot="header">Edit Item</span>
 *   <p>Modal content here</p>
 *   <ct-button slot="footer" onClick={save}>Save</ct-button>
 * </ct-modal>
 *
 * <!-- Plain boolean (controlled) -->
 * <ct-modal $open={true} onct-modal-close={handleClose}>
 *   <span slot="header">Confirm</span>
 *   <p>Are you sure?</p>
 * </ct-modal>
 * ```
 */
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { consume } from "@lit/context";
import { type Cell } from "@commontools/runner";
import { BaseElement } from "../../core/base-element.ts";
import { createBooleanCellController } from "../../core/cell-controller.ts";
import {
  MODAL_BASE_Z_INDEX,
  modalContext,
  type ModalManager,
  type ModalRegistration,
} from "../modal-context.ts";
import { modalStyles } from "./styles.ts";

export class CTModal extends BaseElement {
  static override styles = [BaseElement.baseStyles, modalStyles];

  /** Visibility state - supports both Cell<boolean> and plain boolean */
  @property({ attribute: false })
  declare open: Cell<boolean> | boolean;

  /** Allow dismiss via backdrop click, Escape key, and X button */
  @property({ type: Boolean, reflect: true })
  declare dismissable: boolean;

  /** Modal width preset */
  @property({ type: String, reflect: true })
  declare size: "sm" | "md" | "lg" | "full";

  /** Prevent body scroll when modal is open */
  @property({ type: Boolean, attribute: "prevent-scroll" })
  declare preventScroll: boolean;

  /** Accessible label for the modal */
  @property({ type: String })
  declare label: string | undefined;

  /** Modal manager from context (optional - works standalone too) */
  @consume({ context: modalContext, subscribe: false })
  private _manager?: ModalManager;

  /** Registration with modal manager */
  @state()
  private _registration?: ModalRegistration;

  /** Whether header slot has content */
  @state()
  private _headerHasContent = false;

  /** Whether footer slot has content */
  @state()
  private _footerHasContent = false;

  /** Previous body overflow value for restoration */
  private _previousBodyOverflow = "";

  /** Previously focused element for restoration */
  private _previousActiveElement: HTMLElement | null = null;

  /** Boolean cell controller for open state */
  private _openCellController = createBooleanCellController(this, {
    timing: { strategy: "immediate" },
  });

  /** Track if modal was open in previous render */
  private _wasOpen = false;

  constructor() {
    super();
    this.open = false;
    this.dismissable = true;
    this.size = "md";
    this.preventScroll = true;
  }

  /**
   * Get the current open state (unwrap Cell if needed)
   */
  private _getOpenValue(): boolean {
    return this._openCellController.getValue();
  }

  /**
   * Set the open state (write to Cell if bound)
   */
  private _setOpenValue(value: boolean): void {
    if (this._openCellController.isCell()) {
      this._openCellController.setValue(value);
    }
    // For plain boolean, we just emit the event - parent handles state
  }

  override connectedCallback() {
    super.connectedCallback();
    // Bind initial open value to the controller
    this._openCellController.bind(this.open);
  }

  override disconnectedCallback() {
    this._cleanup();
    super.disconnectedCallback();
  }

  override willUpdate(changedProperties: PropertyValues) {
    // Handle open property changes (including Cell rebinding)
    if (changedProperties.has("open")) {
      this._openCellController.bind(this.open);
    }
  }

  override updated(_changedProperties: PropertyValues) {
    const isOpen = this._getOpenValue();

    // Update open attribute for CSS styling
    if (isOpen) {
      this.setAttribute("open", "");
    } else {
      this.removeAttribute("open");
    }

    // Handle open state transitions
    if (isOpen !== this._wasOpen) {
      if (isOpen) {
        this._onOpen();
      } else {
        this._onClose();
      }
      this._wasOpen = isOpen;
    }
  }

  /**
   * Handle modal opening
   */
  private _onOpen() {
    // Store currently focused element for restoration
    this._previousActiveElement = document.activeElement as HTMLElement;

    // Register with modal manager if available
    if (this._manager) {
      this._registration = this._manager.register(this, this.dismissable);
      this._applyZIndex(this._registration.zIndex);
    } else {
      // Fallback z-index when no manager
      this._applyZIndex(MODAL_BASE_Z_INDEX);
    }

    // Prevent body scroll
    if (this.preventScroll) {
      this._previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }

    this.emit("ct-modal-open");

    // Focus first focusable element after animation
    requestAnimationFrame(() => {
      const focusables = this._getFocusableElements();
      if (focusables.length > 0) {
        focusables[0].focus();
      }

      // Fire opened event after transition
      const dialog = this.shadowRoot?.querySelector(".dialog") as HTMLElement;
      if (dialog) {
        const handler = () => {
          this.emit("ct-modal-opened");
          dialog.removeEventListener("transitionend", handler);
        };
        dialog.addEventListener("transitionend", handler);
      }
    });
  }

  /**
   * Handle modal closing
   */
  private _onClose() {
    // Unregister from modal manager
    if (this._registration && this._manager) {
      this._manager.unregister(this._registration.id);
      this._registration = undefined;
    }

    // Restore body scroll
    if (this.preventScroll) {
      document.body.style.overflow = this._previousBodyOverflow;
    }

    // Restore focus to previously focused element
    this._previousActiveElement?.focus();

    // Fire closed event after transition
    const dialog = this.shadowRoot?.querySelector(".dialog") as HTMLElement;
    if (dialog) {
      const handler = () => {
        this.emit("ct-modal-closed");
        dialog.removeEventListener("transitionend", handler);
      };
      dialog.addEventListener("transitionend", handler);
    }
  }

  /**
   * Clean up on disconnect or close
   */
  private _cleanup() {
    if (this._registration && this._manager) {
      this._manager.unregister(this._registration.id);
      this._registration = undefined;
    }
    if (this.preventScroll && document.body.style.overflow === "hidden") {
      document.body.style.overflow = this._previousBodyOverflow;
    }
  }

  /**
   * Apply z-index to backdrop and container
   */
  private _applyZIndex(zIndex: number) {
    const backdrop = this.shadowRoot?.querySelector(".backdrop") as HTMLElement;
    const container = this.shadowRoot?.querySelector(
      ".container",
    ) as HTMLElement;
    if (backdrop) backdrop.style.zIndex = String(zIndex);
    if (container) container.style.zIndex = String(zIndex + 1);
  }

  /**
   * Handle container click - dismiss if click is on container itself (not dialog)
   */
  private _handleContainerClick = (e: MouseEvent) => {
    // Only dismiss if clicking directly on container (the backdrop area), not the dialog
    if (e.target === e.currentTarget && this.dismissable) {
      this._requestClose("backdrop");
    }
  };

  /**
   * Handle close button click
   */
  private _handleCloseClick = () => {
    this._requestClose("button");
  };

  /**
   * Request modal close with reason
   */
  private _requestClose(reason: "backdrop" | "escape" | "button" | "api") {
    // Write false to Cell if bound (controller handles the check internally)
    this._setOpenValue(false);

    // Always emit event so parent can run cleanup logic
    this.emit("ct-modal-close", { reason });
  }

  /**
   * Handle keyboard events (Tab for focus trap, Escape for close)
   */
  private _handleKeydown = (e: KeyboardEvent) => {
    if (!this._getOpenValue()) return;

    // Handle focus trap with Tab
    if (e.key === "Tab") {
      this._handleTabKey(e);
    }

    // Handle Escape (only if we're the top modal or no manager)
    // Note: When using ct-modal-provider, Escape is handled globally there
    // This is fallback for standalone usage
    if (e.key === "Escape" && this.dismissable && !this._manager) {
      e.preventDefault();
      this._requestClose("escape");
    }
  };

  /**
   * Handle Tab key for focus trapping
   */
  private _handleTabKey(e: KeyboardEvent) {
    const focusables = this._getFocusableElements();
    if (focusables.length === 0) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if (e.shiftKey) {
      // Shift+Tab: wrap from first to last
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      // Tab: wrap from last to first
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  /**
   * Get all focusable elements within the dialog
   */
  private _getFocusableElements(): HTMLElement[] {
    const dialog = this.shadowRoot?.querySelector(".dialog");
    if (!dialog) return [];

    const selector =
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const shadowFocusables = Array.from(
      dialog.querySelectorAll(selector),
    ) as HTMLElement[];

    // Also get focusables from slotted content
    const slots = dialog.querySelectorAll("slot");
    const slottedFocusables: HTMLElement[] = [];
    slots.forEach((slot) => {
      const assigned = (slot as HTMLSlotElement).assignedElements({
        flatten: true,
      });
      assigned.forEach((el) => {
        if ((el as HTMLElement).matches?.(selector)) {
          slottedFocusables.push(el as HTMLElement);
        }
        slottedFocusables.push(
          ...(Array.from(el.querySelectorAll(selector)) as HTMLElement[]),
        );
      });
    });

    return [...shadowFocusables, ...slottedFocusables].filter(
      (el) => !el.hasAttribute("disabled") && el.offsetParent !== null,
    );
  }

  /**
   * Handle header slot change to detect content
   */
  private _handleHeaderSlotChange = (e: Event) => {
    const slot = e.target as HTMLSlotElement;
    this._headerHasContent = slot.assignedNodes().length > 0;
  };

  /**
   * Handle footer slot change to detect content
   */
  private _handleFooterSlotChange = (e: Event) => {
    const slot = e.target as HTMLSlotElement;
    this._footerHasContent = slot.assignedNodes().length > 0;
  };

  /**
   * Programmatically close the modal
   */
  close() {
    this._requestClose("api");
  }

  override render() {
    return html`
      <div
        class="backdrop"
        part="backdrop"
      >
      </div>

      <div
        class="container"
        part="container"
        @click="${this._handleContainerClick}"
        @keydown="${this._handleKeydown}"
      >
        <div
          class="dialog"
          part="dialog"
          role="dialog"
          aria-modal="true"
          aria-label="${this.label || nothing}"
        >
          <div
            class="header ${this._headerHasContent ? "" : "empty"}"
            part="header"
          >
            <div class="header-content">
              <slot
                name="header"
                @slotchange="${this._handleHeaderSlotChange}"
              ></slot>
            </div>
            <slot name="close-button">
              <button
                class="close-button"
                part="close-button"
                @click="${this._handleCloseClick}"
                aria-label="Close"
                type="button"
              >
                &#x2715;
              </button>
            </slot>
          </div>

          <div class="content" part="content">
            <slot></slot>
          </div>

          <div
            class="footer ${this._footerHasContent ? "" : "empty"}"
            part="footer"
          >
            <slot
              name="footer"
              @slotchange="${this._handleFooterSlotChange}"
            ></slot>
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define("ct-modal", CTModal);
